const fs = require('fs');
const path = require('path');
const apiKeyManager = require('../../utils/apiKeyManager');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);

        // ── Clamp to max 25 (Groq token limit safe zone) ──────────
        const questionCount = Math.min(Math.max(body.count || 20, 5), 25);

        // ── 1. Load knowledge ──────────────────────────────────────
        let knowledgePath = path.resolve(__dirname, '../../public/data/knowledge.json');
        if (!fs.existsSync(knowledgePath)) {
            knowledgePath = path.join(process.cwd(), 'public/data/knowledge.json');
        }
        if (!fs.existsSync(knowledgePath)) {
            return {
                statusCode: 404,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "Knowledge base not found." })
            };
        }

        const knowledge = JSON.parse(fs.readFileSync(knowledgePath, 'utf-8'));

        // ── 2. Group chunks by source ──────────────────────────────
        const sourceMap = {};
        for (const chunk of knowledge) {
            if (!sourceMap[chunk.source]) sourceMap[chunk.source] = [];
            sourceMap[chunk.source].push(chunk);
        }

        const sourceNames = Object.keys(sourceMap);
        const stemSource = 'stem 3 2022_2nd term .pdf';

        // ── 3. Sample chunks — fewer to reduce input tokens ────────
        const sampledChunks = [];

        // Primary book: max 10 spread chunks
        if (sourceMap[stemSource]) {
            const stemChunks = sourceMap[stemSource];
            const step = Math.max(1, Math.floor(stemChunks.length / 10));
            for (let i = 0; i < stemChunks.length; i += step) {
                sampledChunks.push(stemChunks[i]);
                if (sampledChunks.filter(c => c.source === stemSource).length >= 10) break;
            }
        }

        // Other sources: max 3 chunks each
        for (const src of sourceNames) {
            if (src === stemSource) continue;
            const chunks = sourceMap[src];
            const step = Math.max(1, Math.floor(chunks.length / 3));
            for (let i = 0; i < chunks.length; i += step) {
                sampledChunks.push(chunks[i]);
                if (sampledChunks.filter(c => c.source === src).length >= 3) break;
            }
        }

        // ── 4. Build context — trim each chunk to 300 chars ────────
        const contextText = sampledChunks
            .map(c => `[${c.source}, P${c.page}] ${c.text.slice(0, 300)}`)
            .join('\n');

        // ── 5. Type distribution ───────────────────────────────────
        const dist = {
            definition: Math.floor(questionCount * 0.10),
            concept: Math.floor(questionCount * 0.15),
            compare: Math.floor(questionCount * 0.15),
            calculation: Math.floor(questionCount * 0.25),
            true_false: Math.floor(questionCount * 0.10),
            mcq: Math.floor(questionCount * 0.15),
            prove: Math.floor(questionCount * 0.10),
        };
        const assigned = Object.values(dist).reduce((a, b) => a + b, 0);
        dist.calculation += questionCount - assigned;

        // ── 6. Prompts ─────────────────────────────────────────────
        const systemPrompt = `You are a Physics Exam Generator. Output ONLY valid JSON, no extra text, no markdown.`;

        const userPrompt = `Physics content:
${contextText}

Generate exactly ${questionCount} questions. Distribution:
- definition: ${dist.definition}
- concept: ${dist.concept}
- compare: ${dist.compare}
- calculation: ${dist.calculation}
- true_false: ${dist.true_false}
- mcq: ${dist.mcq} (with 4 options)
- prove: ${dist.prove}

Rules:
- No repeated questions
- Max 2 "What is X?" style questions
- MCQ must have options array with 4 items
- Use real numbers from content for calculations

JSON output:
{"exam":[{"number":1,"type":"...","question":"...","options":[],"source":"...","page":1}],"summary":{"total":${questionCount},"by_type":{},"sources_covered":[]}}

options field: only for mcq, empty array for others.`;

        // ── 7. API Call ────────────────────────────────────────────
        let aiMessage = null;
        const failedKeys = [];
        let success = false;
        let backoffDelay = 500;
        const maxAttempts = 4;
        let attempts = 0;

        while (!success && attempts < maxAttempts) {
            attempts++;
            const keyConfig = await apiKeyManager.getBestKey(failedKeys);
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
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt }
                        ],
                        temperature: 0.7,
                        response_format: { type: "json_object" },
                        max_tokens: 6000  // safe for Groq + llama-3.3-70b
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`API Error:`, errorText);
                    failedKeys.push(keyConfig.keyId);
                    apiKeyManager.reportFailure(keyConfig.keyId);
                    await new Promise(r => setTimeout(r, backoffDelay));
                    backoffDelay *= 2;
                    continue;
                }

                const data = await response.json();
                aiMessage = data.choices[0].message.content;
                apiKeyManager.reportSuccess(keyConfig.keyId);
                success = true;

            } catch (err) {
                console.error(`Error:`, err);
                failedKeys.push(keyConfig.keyId);
                apiKeyManager.reportFailure(keyConfig.keyId);
                await new Promise(r => setTimeout(r, backoffDelay));
                backoffDelay *= 2;
            }
        }

        if (!success) {
            return {
                statusCode: 500,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: "All API keys failed." })
            };
        }

        let parsedResult;
        try {
            // Strip markdown fences if model added them
            const clean = aiMessage.replace(/```json|```/g, '').trim();
            parsedResult = JSON.parse(clean);
        } catch (e) {
            parsedResult = { error: "Failed to parse exam", raw: aiMessage };
        }

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