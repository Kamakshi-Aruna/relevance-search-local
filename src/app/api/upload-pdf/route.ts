import { NextRequest, NextResponse } from "next/server";
import { getVectorStore } from "@/lib/vectorStore";

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get('pdf') as File;

        if (!file) {
            return NextResponse.json(
                { error: "No PDF file provided" },
                { status: 400 }
            );
        }

        if (file.type !== 'application/pdf') {
            return NextResponse.json(
                { error: "File must be a PDF" },
                { status: 400 }
            );
        }

        // Convert file to buffer
        const bytes = await file.arrayBuffer();
        const buffer = Buffer.from(bytes);

        let textContent = '';

        try {
            // Try to use pdf-parse in a safer way
            const pdfParse = eval('require')('pdf-parse');
            const data = await pdfParse(buffer);
            textContent = data.text;
        } catch (pdfError) {
            console.log("PDF parsing failed, trying alternative method:", pdfError);

            // Fallback: treat as text or return an error
            return NextResponse.json(
                { error: "Could not extract text from PDF. Please ensure it's a text-based PDF." },
                { status: 400 }
            );
        }

        if (!textContent || textContent.trim().length === 0) {
            return NextResponse.json(
                { error: "PDF appears to be empty or unreadable" },
                { status: 400 }
            );
        }

        // Split text into chunks (roughly 500 characters each)
        const chunks = splitIntoChunks(textContent, 500);

        // Generate embeddings and store in Qdrant
        const { client, collectionName } = await getVectorStore();

        // Ensure collection exists, create if it doesn't
        try {
            await client.getCollection(collectionName);
        } catch (error) {
            // Collection doesn't exist, create it
            console.log(`Creating collection: ${collectionName}`);
            await client.createCollection(collectionName, {
                vectors: {
                    size: 4096, // Ollama embedding dimension
                    distance: "Cosine",
                },
            });
            console.log(`✅ Created collection: ${collectionName}`);
        }

        // Get current collection info to determine next ID
        let startId = 1000 + Math.floor(Math.random() * 10000); // Random ID to avoid conflicts

        const points: any[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            // Generate embedding for this chunk
            const embeddingResponse = await fetch("http://localhost:11434/api/embeddings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: process.env.OLLAMA_MODEL || "llama3",
                    prompt: chunk,
                }),
            });

            if (!embeddingResponse.ok) {
                throw new Error(`Failed to generate embedding for chunk ${i}`);
            }

            const embeddingData = await embeddingResponse.json();
            const embedding = embeddingData.embedding;

            if (embedding && embedding.length > 0) {
                const point = {
                    id: startId + i,
                    vector: embedding,
                    payload: {
                        text: chunk,
                        source: file.name,
                        type: "pdf",
                        chunk_index: i,
                        total_chunks: chunks.length,
                    }
                };

                // Debug logging
                console.log(`Creating PDF point ${startId + i} for file: ${file.name}`);
                points.push(point);
            }
        }

        // Upload all points to Qdrant
        if (points.length > 0) {
            await client.upsert(collectionName, {
                wait: true,
                points: points,
            });
        }

        return NextResponse.json({
            success: true,
            message: `Successfully processed ${file.name}`,
            chunks_created: points.length,
            filename: file.name,
        });

    } catch (error: any) {
        console.error("PDF upload error:", error);
        return NextResponse.json(
            {
                error: "Failed to process PDF",
                details: error.message
            },
            { status: 500 }
        );
    }
}

// Helper function to split text into chunks
function splitIntoChunks(text: string, maxChunkSize: number): string[] {
    const chunks: string[] = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);

    let currentChunk = '';

    for (const sentence of sentences) {
        const trimmedSentence = sentence.trim();
        if (trimmedSentence.length === 0) continue;

        // If adding this sentence would exceed the chunk size, save current chunk
        if (currentChunk.length + trimmedSentence.length > maxChunkSize && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = trimmedSentence;
        } else {
            currentChunk += (currentChunk.length > 0 ? '. ' : '') + trimmedSentence;
        }
    }

    // Add the last chunk if it has content
    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}