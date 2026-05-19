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

        const fullCached = cache.getCachedResponse(normalizedQuestion);
        if (fullCached) {
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

        // Keyword search
        const words = question.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
        const scoredChunks = knowledge.map(chunk => {
            const chunkText = chunk.text.toLowerCase();
            let score = 0;
            words.forEach(word => {
                if (chunkText.includes(word)) score++;
            });
            return { ...chunk, score };
        });

        scoredChunks.sort((a, b) => b.score - a.score);
        const topChunks = scoredChunks.slice(0, 4);
        const contextText = topChunks.map(c => `[Source: ${c.source}, Page: ${c.page}]\n${c.text}`).join('\n\n');

        const systemPrompt = `You are a Physics Question Answering System.

Rules:
- Use ONLY provided context
- Never use external knowledge
- Give a COMPLETE and DETAILED answer, not just a phrase
- Explain the concept fully using all relevant information from the context
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
            const keyConfig = await apiKeyManager.getBestKey(failedKeys); // ✅ await fixed

            if (!keyConfig) break;

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
                        temperature: 0.2,
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
                    continue;
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
                continue;
            }
        }

        if (!success) {
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "All API keys failed. Please try again later." })
            };
        }

        let parsedResult;
        try {
            parsedResult = JSON.parse(aiMessage);
        } catch (e) {
            parsedResult = { answer: aiMessage, sources: [] };
        }

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