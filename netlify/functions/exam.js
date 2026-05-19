const fs = require('fs');
const path = require('path');
const apiKeyManager = require('../../utils/apiKeyManager');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        const questionCount = body.count || 50;

        // ── 1. Load ALL knowledge chunks ──────────────────────────
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

        // ── 3. Sample chunks from ALL sources ─────────────────────
        // Take up to 20 chunks from primary book + up to 5 from each other source
        const sampledChunks = [];

        // Primary book - take spread chunks (not just first 20)
        if (sourceMap[stemSource]) {
            const stemChunks = sourceMap[stemSource];
            const step = Math.max(1, Math.floor(stemChunks.length / 20));
            for (let i = 0; i < stemChunks.length; i += step) {
                sampledChunks.push(stemChunks[i]);
                if (sampledChunks.filter(c => c.source === stemSource).length >= 20) break;
            }
        }

        // All other sources - sample from each
        for (const src of sourceNames) {
            if (src === stemSource) continue;
            const chunks = sourceMap[src];
            const step = Math.max(1, Math.floor(chunks.length / 5));
            for (let i = 0; i < chunks.length; i += step) {
                sampledChunks.push(chunks[i]);
                if (sampledChunks.filter(c => c.source === src).length >= 5) break;
            }
        }

        // ── 4. Build context ───────────────────────────────────────
        const contextText = sampledChunks
            .map(c => `[Source: ${c.source}, Page: ${c.page}]\n${c.text}`)
            .join('\n\n');

        // ── 5. Calculate type distribution ────────────────────────
        const dist = {
            definition: Math.floor(questionCount * 0.10),
            concept: Math.floor(questionCount * 0.15),
            compare: Math.floor(questionCount * 0.15),
            calculation: Math.floor(questionCount * 0.25),
            true_false: Math.floor(questionCount * 0.10),
            mcq: Math.floor(questionCount * 0.15),
            prove: Math.floor(questionCount * 0.10),
        };
        // Fill remainder in calculations
        const assigned = Object.values(dist).reduce((a, b) => a + b, 0);
        dist.calculation += questionCount - assigned;

        // ── 6. System + User prompt ────────────────────────────────
        const systemPrompt = `You are a Physics Exam Generator. Output ONLY strict JSON, no extra text.`;

        const userPrompt = `
You have the following physics content from multiple sources:

${contextText}

Generate exactly ${questionCount} exam questions using ALL the content above.

## STRICT DISTRIBUTION (do not deviate):
- definition: ${dist.definition} questions
- concept: ${dist.concept} questions  
- compare: ${dist.compare} questions
- calculation: ${dist.calculation} questions
- true_false: ${dist.true_false} questions
- mcq: ${dist.mcq} questions (include 4 options A/B/C/D)
- prove: ${dist.prove} questions

## RULES:
- Cover EVERY source and EVERY topic found in the content
- NEVER repeat the same question or same topic twice in a row
- NEVER generate more than 2 "What is X?" questions total
- For MCQ: include options array ["A)...", "B)...", "C)...", "D)..."]
- For calculation: use real numbers from the content
- Spread questions across ALL pages and sources evenly

## OUTPUT (strict JSON):
{
  "exam": [
    {
      "number": 1,
      "type": "definition | concept | compare | calculation | true_false | mcq | prove",
      "question": "question text",
      "options": ["A)...", "B)...", "C)...", "D)..."],
      "source": "filename.pdf",
      "page": 1
    }
  ],
  "summary": {
    "total": ${questionCount},
    "by_type": {},
    "sources_covered": []
  }
}
Note: "options" field only for mcq type, omit for others.`;

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
                        temperature: 0.7, // أعلى شوية عشان تنوع
                        response_format: { type: "json_object" },
                        max_tokens: 16000
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
            parsedResult = JSON.parse(aiMessage);
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