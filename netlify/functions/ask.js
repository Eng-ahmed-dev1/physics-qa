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
        const stemChunks = scoredChunks.filter(c => c.source === 'stem 3 2022_2nd term .pdf').slice(0, 3);
        const otherChunks = scoredChunks.filter(c => c.source !== 'stem 3 2022_2nd term .pdf').slice(0, 1);
        const topChunks = [...stemChunks, ...otherChunks];
        const contextText = topChunks.map(c => `[Source: ${c.source}, Page: ${c.page}]\n${c.text}`).join('\n\n');

        const systemPrompt = `You are a Physics Question Answering System. Follow these rules strictly:

## SOURCE PRIORITY (always in this order):
1. "stem 3 2022_2nd term.pdf" ← PRIMARY SOURCE (highest priority)
2. Any file inside the "raw-materials" folder ← SECONDARY SOURCES
3. If nothing found anywhere → reply: "Not found in provided materials"

## ANSWERING RULES:

### If the question is DIRECTLY found in the primary book:
- Extract the answer VERBATIM (word for word) from the book
- Do NOT paraphrase or add anything
- Mention the page number

### If the question is NOT directly found in the primary book:
- Search inside the "raw-materials" folder for relevant content
- Derive/infer the answer from those references
- Mention: "Derived from raw-materials references" and list which files were used
- Keep the answer concise but scientifically accurate

## COMPARISON QUESTION RULES:
### If a COMPARISON is directly found in the primary book:
- Extract it VERBATIM as a comparison table or list
- Mention the page number

### If a COMPARISON is NOT found in the primary book:
- Search "raw-materials" folder for a ready-made comparison
- If a ready-made comparison exists → extract it directly

### If NO comparison exists anywhere in any source:
- Collect ALL available information about EACH topic separately from "raw-materials"
- Build the comparison yourself based on that collected information
- Clearly state: "Comparison built from raw-materials references" and list the files used

## MULTI-POINT ANSWER RULES:
### If the answer contains MORE THAN ONE POINT:
- Always present each point as an UNORDERED LIST (bullet points)
- Each bullet should be concise and self-contained
- Do not number them unless it's a sequential process

## CALCULATION QUESTION RULES:
### If the exact problem is found in the primary book:
- Solve it EXACTLY as the book solves it (same steps, same notation)
- Mention the page number

### If the problem is NOT in the primary book:
- Extract all relevant laws and formulas from the book first, then "raw-materials"
- Solve using those extracted laws only
- Present the solution as a NUMBERED ORDERED LIST, one step per item:
  1. State the given values
  2. State the required
  3. Write the relevant law/formula
  4. Substitute values
  5. Calculate and state the final answer with units

## ANSWER LENGTH RULE:
- Keep answers as SHORT as possible without losing scientific accuracy
- No unnecessary repetition or filler phrases
- Definitions: one clean sentence unless more is truly needed

## QUESTION TYPE HANDLING:
- DEFINITION → exact term + concise definition (verbatim from book if found)
- MCQ → correct option + one-line reason
- PROVE/DERIVE → clean step-by-step ordered list
- CALCULATION → follow CALCULATION QUESTION RULES above
- CONCEPT → concise complete explanation
- COMPARISON → follow COMPARISON QUESTION RULES above
- MULTI-POINT → follow MULTI-POINT ANSWER RULES above

## OUTPUT (strict JSON only, no extra text):
{
  "answer": "your answer here (use \\n• for unordered list, \\n1. for ordered list)",
  "source_type": "verbatim | derived | built-from-references | not found",
  "sources": [{ "source": "filename.pdf", "page": 1 }]
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