const fs = require('fs');
const path = require('path');
const apiKeyManager = require('../../utils/apiKeyManager');
const cache = require('../../utils/cache');

function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        const question = body.question;

        if (!question) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Missing 'question' in request body." })
            };
        }

        const clientIp = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
        if (cache.isRateLimited(clientIp)) {
            return {
                statusCode: 429,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "Rate limit exceeded. Please try again later." })
            };
        }

        const normalizedQuestion = question.trim().toLowerCase();

        // 1. Full Pipeline Cache Check
        const fullCached = cache.getCachedResponse(normalizedQuestion);
        if (fullCached) {
            console.log('[Cache Hit] Returning full pipeline cached response.');
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fullCached)
            };
        }

        let knowledgePath = path.resolve(__dirname, '../../public/data/knowledge.json');
        if (!fs.existsSync(knowledgePath)) {
            knowledgePath = path.join(process.cwd(), 'public/data/knowledge.json');
        }

        if (!fs.existsSync(knowledgePath)) {
            return {
                statusCode: 404,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "Knowledge base not found. Please run preprocessing script." })
            };
        }

        const knowledgeData = fs.readFileSync(knowledgePath, 'utf-8');
        const knowledge = JSON.parse(knowledgeData);

        // Fetch embedding for the question if possible
        let questionEmbedding = cache.getCachedEmbedding(normalizedQuestion);
        
        if (!questionEmbedding) {
            const openAiKeyEntry = Object.entries(process.env).find(([k,v]) => typeof v === 'string' && (k.startsWith('OPENAI') || v.startsWith('sk-')));
            if (openAiKeyEntry && knowledge.length > 0 && knowledge[0].embedding) {
                try {
                    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openAiKeyEntry[1]}` },
                        body: JSON.stringify({ input: normalizedQuestion, model: 'text-embedding-3-small' })
                    });
                    if (embRes.ok) {
                        const embData = await embRes.json();
                        questionEmbedding = embData.data[0].embedding;
                        cache.setCachedEmbedding(normalizedQuestion, questionEmbedding);
                    }
                } catch (e) {
                    console.error('Failed to get question embedding, falling back to keyword search', e);
                }
            }
        }

        let scoredChunks;
        if (questionEmbedding) {
            // Semantic search via cosine similarity
            scoredChunks = knowledge.map(chunk => ({
                ...chunk,
                score: chunk.embedding ? cosineSimilarity(questionEmbedding, chunk.embedding) : 0
            }));
        } else {
            // Simple retrieval: score by keyword matching fallback
            const words = question.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
            scoredChunks = knowledge.map(chunk => {
                const chunkText = chunk.text.toLowerCase();
                let score = 0;
                words.forEach(word => {
                    if (chunkText.includes(word)) {
                        score++;
                    }
                });
                return { ...chunk, score };
            });
        }

        // Sort descending
        scoredChunks.sort((a, b) => b.score - a.score);
        
        // Take top 4 chunks
        const topChunks = scoredChunks.slice(0, 4);

        if (topChunks.length === 0 || topChunks[0].score === 0) {
            // If no keywords matched at all, we could just return early or still ask AI
            // We'll proceed to ask AI with empty context to get the "Not found" response as requested
        }

        const contextText = topChunks.map(c => `[Source: ${c.source}, Page: ${c.page}]\n${c.text}`).join('\n\n');

        const systemPrompt = `You are a Physics Question Answering System.

Rules:
- Use ONLY provided context
- Never use external knowledge
- If answer not found say: 'Not found in provided materials'
- Always include source file and page number
- Output must be strict JSON:
{
  "answer": "...",
  "sources": [{ "source": "file", "page": number }]
}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Context:\n${contextText}\n\nQuestion: ${question}` }
        ];

        let aiMessage = null;
        const failedKeys = [];
        let success = false;
        
        let backoffDelay = 500;
        const maxAttempts = 4;
        let attempts = 0;

        while (!success && attempts < maxAttempts) {
            attempts++;
            const keyConfig = apiKeyManager.getBestKey(failedKeys);

            if (!keyConfig) {
                // Exhausted all keys or no valid keys found
                break;
            }

            try {
                const response = await fetch(keyConfig.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${keyConfig.key}`
                    },
                    body: JSON.stringify({
                        model: keyConfig.model,
                        messages: messages,
                        temperature: 0.2, // low temperature for more factual extraction
                        response_format: { type: "json_object" }
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`API Error with key ${keyConfig.keyId}:`, errorText);
                    failedKeys.push(keyConfig.keyId);
                    apiKeyManager.reportFailure(keyConfig.keyId);
                    
                    if (attempts < maxAttempts) {
                        await new Promise(r => setTimeout(r, backoffDelay));
                        backoffDelay *= 2;
                    }
                    continue; // Try next key
                }

                const data = await response.json();
                aiMessage = data.choices[0].message.content;
                apiKeyManager.reportSuccess(keyConfig.keyId);
                success = true;
                
            } catch (err) {
                console.error(`Network or parse error with key ${keyConfig.keyId}:`, err);
                failedKeys.push(keyConfig.keyId);
                apiKeyManager.reportFailure(keyConfig.keyId);
                
                if (attempts < maxAttempts) {
                    await new Promise(r => setTimeout(r, backoffDelay));
                    backoffDelay *= 2;
                }
                continue; // Try next key
            }
        }

        if (!success) {
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "All API keys failed. Please try again later." })
            };
        }

        // Ensure it's valid JSON (the model was instructed to output JSON, but just in case)
        let parsedResult;
        try {
            parsedResult = JSON.parse(aiMessage);
        } catch (e) {
            parsedResult = {
                answer: aiMessage, // fallback
                sources: []
            };
        }

        // Token Cost Tracking
        const approxTokens = (normalizedQuestion.length + contextText.length + (aiMessage ? aiMessage.length : 0)) / 4;
        console.log(`[Cost Tracker] Estimated tokens: ${Math.round(approxTokens)}`);
        if (approxTokens > 2000) {
            console.warn(`[Cost Warning] High token usage detected: ${Math.round(approxTokens)} tokens`);
        }

        // Store full pipeline in cache
        cache.setCachedResponse(normalizedQuestion, parsedResult);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsedResult)
        };

    } catch (error) {
        console.error('Unhandled error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Internal server error." })
        };
    }
};
