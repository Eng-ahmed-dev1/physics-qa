require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const crypto = require('crypto');

async function getEmbedding(text) {
    const apiKey = process.env.OPENAI_API_KEY || Object.values(process.env).find(v => typeof v === 'string' && v.startsWith('sk-'));
    if (!apiKey) return null;
    
    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                input: text,
                model: 'text-embedding-3-small'
            })
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.data[0].embedding;
    } catch (e) {
        return null;
    }
}

function normalizeText(text) {
    return text
        .replace(/[\u2018\u2019]/g, "'") // smart quotes to straight
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2013\u2014]/g, '-') // dashes
        .replace(/\s+/g, ' ') // collapse whitespace
        .trim();
}

function slidingWindowSplit(text) {
    // Split by punctuation ending a sentence
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;
    
    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i].trim();
        if (!sentence) continue;
        
        currentChunk.push(sentence);
        currentLength += sentence.length;
        
        // Approx 2000 chars per chunk
        if (currentLength > 2000) {
            chunks.push(currentChunk.join(' '));
            // Keep last 2 sentences for overlap
            currentChunk = currentChunk.slice(-2);
            currentLength = currentChunk.join(' ').length;
        }
    }
    if (currentChunk.length > 0 && currentLength > 20) {
        chunks.push(currentChunk.join(' '));
    }
    return chunks;
}

const RAW_DIR = path.join(__dirname, '../raw-materials');
const OUT_DIR = path.join(__dirname, '../public/data');
const OUT_FILE = path.join(OUT_DIR, 'knowledge.json');

async function processMaterials() {
    console.log('Starting preprocessing...');
    if (!fs.existsSync(RAW_DIR)) {
        fs.mkdirSync(RAW_DIR, { recursive: true });
        console.log(`Created ${RAW_DIR}. Add files and run again.`);
    }
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
    }

    const files = fs.existsSync(RAW_DIR) ? fs.readdirSync(RAW_DIR) : [];
    const knowledge = [];

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const filePath = path.join(RAW_DIR, file);

        if (ext === '.pdf') {
            console.log(`Processing PDF: ${file}`);
            const dataBuffer = fs.readFileSync(filePath);
            
            function render_page(pageData) {
                let render_options = {
                    normalizeWhitespace: false,
                    disableCombineTextItems: false
                }
                return pageData.getTextContent(render_options).then(function(textContent) {
                    let text = '';
                    for (let item of textContent.items) {
                        text += item.str + ' ';
                    }
                    return text + '___PAGE_BREAK___';
                });
            }

            try {
                const options = {
                    pagerender: render_page
                };
                const pdfData = await pdf(dataBuffer, options);
                
                for (let i = 0; i < pages.length; i++) {
                    const pageText = normalizeText(pages[i]);
                    if (pageText.length > 20) {
                        const subChunks = slidingWindowSplit(pageText);
                        for (const chunkStr of subChunks) {
                            const chunkId = crypto.randomUUID();
                            const embedding = await getEmbedding(chunkStr);
                            knowledge.push({
                                id: chunkId,
                                source: file,
                                page: i + 1,
                                text: chunkStr,
                                embedding: embedding
                            });
                        }
                    }
                }
            } catch (err) {
                console.error(`Error parsing ${file}:`, err);
            }
        } else if (ext === '.txt') {
            console.log(`Processing TXT: ${file}`);
            const text = normalizeText(fs.readFileSync(filePath, 'utf-8'));
            const chunks = slidingWindowSplit(text);
            let chunkIndex = 1;
            
            for (const chunkStr of chunks) {
                const chunkId = crypto.randomUUID();
                const embedding = await getEmbedding(chunkStr);
                knowledge.push({
                    id: chunkId,
                    source: file,
                    page: chunkIndex++,
                    text: chunkStr,
                    embedding: embedding
                });
            }
        }
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify(knowledge, null, 2));
    console.log(`Done. Saved ${knowledge.length} chunks to ${OUT_FILE}`);
}

processMaterials();
