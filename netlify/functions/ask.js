const fs = require('fs');
const path = require('path');
const apiKeyManager = require('../../utils/apiKeyManager');
const cache = require('../../utils/cache');

// ── Exam request detection ─────────────────────────────────
function detectExamRequest(q) {
    const lower = q.toLowerCase();
    const patterns = [
        /\b(exam|quiz|test)\b/,
        /generate\s+\d+\s+questions?/,
        /\d+\s+questions?/,
        /make\s+(an?\s+)?(exam|quiz|test)/,
        /give\s+me\s+\d+/,
        /امتحان/,
        /اسئلة|أسئلة/,
        /اختبار/,
        /اعمل.*امتحان/,
        /هات.*سؤال/,
    ];
    return patterns.some(p => p.test(lower) || p.test(q));
}

function extractCount(q) {
    const match = q.match(/\d+/);
    if (match) return Math.min(Math.max(parseInt(match[0]), 5), 25);
    return 20;
}

// ── API call helper ────────────────────────────────────────
async function callAPI(messages, temperature = 0.2, maxTokens = 4000) {
    const failedKeys = [];
    let backoffDelay = 500;

    for (let attempts = 0; attempts < 4; attempts++) {
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
                    messages,
                    temperature,
                    response_format: { type: "json_object" },
                    max_tokens: maxTokens
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
            apiKeyManager.reportSuccess(keyConfig.keyId);
            return data.choices[0].message.content;

        } catch (err) {
            console.error(`Error:`, err);
            failedKeys.push(keyConfig.keyId);
            apiKeyManager.reportFailure(keyConfig.keyId);
            await new Promise(r => setTimeout(r, backoffDelay));
            backoffDelay *= 2;
        }
    }

    return null;
}

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        const question = body.question || '';
        const isExam = detectExamRequest(question);

        // ── Load knowledge ─────────────────────────────────
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
        const stemSource = 'stem 3 2022_2nd term .pdf';

        // ══════════════════════════════════════════════════
        // EXAM MODE
        // ══════════════════════════════════════════════════
        if (isExam) {
            const questionCount = extractCount(question);

            // Group by source
            const sourceMap = {};
            for (const chunk of knowledge) {
                if (!sourceMap[chunk.source]) sourceMap[chunk.source] = [];
                sourceMap[chunk.source].push(chunk);
            }

            // Sample chunks
            const sampledChunks = [];

            if (sourceMap[stemSource]) {
                const stemChunks = sourceMap[stemSource];
                const step = Math.max(1, Math.floor(stemChunks.length / 10));
                for (let i = 0; i < stemChunks.length; i += step) {
                    sampledChunks.push(stemChunks[i]);
                    if (sampledChunks.filter(c => c.source === stemSource).length >= 10) break;
                }
            }

            for (const src of Object.keys(sourceMap)) {
                if (src === stemSource) continue;
                const chunks = sourceMap[src];
                const step = Math.max(1, Math.floor(chunks.length / 3));
                for (let i = 0; i < chunks.length; i += step) {
                    sampledChunks.push(chunks[i]);
                    if (sampledChunks.filter(c => c.source === src).length >= 3) break;
                }
            }

            const contextText = sampledChunks
                .map(c => `[${c.source}, P${c.page}] ${c.text.slice(0, 300)}`)
                .join('\n');

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

            const examMessages = [
                {
                    role: 'system',
                    content: `You are a Physics Exam Generator. Output ONLY valid JSON, no extra text, no markdown.`
                },
                {
                    role: 'user',
                    content: `Physics content:
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

options field: only for mcq, empty array for others.`
                }
            ];

            const aiMessage = await callAPI(examMessages, 0.7, 6000);

            if (!aiMessage) {
                return {
                    statusCode: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error: "All API keys failed." })
                };
            }

            let parsedResult;
            try {
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
        }

        // ══════════════════════════════════════════════════
        // Q&A MODE
        // ══════════════════════════════════════════════════
        if (!question) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
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

        // Keyword search
        const words = question.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
        const scoredChunks = knowledge.map(chunk => {
            const chunkText = chunk.text.toLowerCase();
            let score = 0;
            words.forEach(word => { if (chunkText.includes(word)) score++; });
            return { ...chunk, score };
        });

        scoredChunks.sort((a, b) => b.score - a.score);
        const stemChunks = scoredChunks.filter(c => c.source === stemSource).slice(0, 6);
        const otherChunks = scoredChunks.filter(c => c.source !== stemSource).slice(0, 4);
        const contextText = [...stemChunks, ...otherChunks]
            .map(c => `[Source: ${c.source}, Page: ${c.page}]\n${c.text}`)
            .join('\n\n');

        const qaMessages = [
            {
                role: 'system',
                content: `You are a Physics Question Answering System. Follow these rules strictly:

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
- If the answer contains MORE THAN ONE POINT → present as UNORDERED LIST (bullet points)
- Each bullet should be concise and self-contained

## CALCULATION QUESTION RULES:
### If the exact problem is found in the primary book:
- Solve it EXACTLY as the book solves it (same steps, same notation)
- Mention the page number
### If the problem is NOT in the primary book:
- Extract all relevant laws and formulas from the book first, then "raw-materials"
- Present the solution as a NUMBERED ORDERED LIST:
  1. State the given values
  2. State the required
  3. Write the relevant law/formula
  4. Substitute values
  5. Calculate and state the final answer with units

## ANSWER LENGTH RULE:
- Keep answers as SHORT as possible without losing scientific accuracy
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
}`
            },
            {
                role: 'user',
                content: `Context:\n${contextText}\n\nQuestion: ${question}`
            }
        ];

        const aiMessage = await callAPI(qaMessages, 0.2, 4000);

        if (!aiMessage) {
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