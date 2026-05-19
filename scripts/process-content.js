require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAW_DIR = path.join(__dirname, '../raw-materials');
const OUT_DIR = path.join(__dirname, '../public/data');
const OUT_FILE = path.join(OUT_DIR, 'knowledge.json');

function normalizeText(text) {
    return text
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

function splitIntoChunks(text, chunkSize = 1500) {
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    const chunks = [];
    let current = '';

    for (const sentence of sentences) {
        if ((current + sentence).length > chunkSize && current.length > 0) {
            chunks.push(current.trim());
            current = sentence;
        } else {
            current += ' ' + sentence;
        }
    }
    if (current.trim().length > 20) chunks.push(current.trim());
    return chunks;
}

async function processMaterials() {
    console.log('Starting preprocessing...');

    if (!fs.existsSync(RAW_DIR)) {
        fs.mkdirSync(RAW_DIR, { recursive: true });
        console.log(`Created ${RAW_DIR}. Add files and run again.`);
        return;
    }
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
    }

    // Dynamically require pdf-parse
    let pdfParse;
    try {
        pdfParse = require('pdf-parse/lib/pdf-parse.js');
    } catch (e) {
        try {
            pdfParse = require('pdf-parse');
            if (typeof pdfParse !== 'function') pdfParse = pdfParse.default || Object.values(pdfParse).find(v => typeof v === 'function');
        } catch (e2) {
            console.error('pdf-parse not found. Run: npm install pdf-parse');
            process.exit(1);
        }
    }

    const files = fs.readdirSync(RAW_DIR);
    const knowledge = [];

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        const filePath = path.join(RAW_DIR, file);

        if (ext === '.pdf') {
            console.log(`Processing PDF: ${file}`);
            try {
                const dataBuffer = fs.readFileSync(filePath);

                // Store pages as we render them
                const pageTexts = [];

                const options = {
                    pagerender: function (pageData) {
                        return pageData.getTextContent().then(function (textContent) {
                            let text = '';
                            for (const item of textContent.items) {
                                text += item.str + ' ';
                            }
                            pageTexts.push(text);
                            return text;
                        });
                    }
                };

                await pdfParse(dataBuffer, options);

                // Process each page
                for (let i = 0; i < pageTexts.length; i++) {
                    const pageText = normalizeText(pageTexts[i]);
                    if (pageText.length > 20) {
                        const chunks = splitIntoChunks(pageText);
                        for (const chunkStr of chunks) {
                            knowledge.push({
                                id: crypto.randomUUID(),
                                source: file,
                                page: i + 1,
                                text: chunkStr
                            });
                        }
                    }
                }
                console.log(`  ✓ Done (${pageTexts.length} pages)`);
            } catch (err) {
                console.error(`  ✗ Error: ${err.message}`);
            }

        } else if (ext === '.txt') {
            console.log(`Processing TXT: ${file}`);
            try {
                const text = normalizeText(fs.readFileSync(filePath, 'utf-8'));
                const chunks = splitIntoChunks(text);
                chunks.forEach((chunkStr, i) => {
                    knowledge.push({
                        id: crypto.randomUUID(),
                        source: file,
                        page: i + 1,
                        text: chunkStr
                    });
                });
                console.log(`  ✓ Done (${chunks.length} chunks)`);
            } catch (err) {
                console.error(`  ✗ Error: ${err.message}`);
            }
        }
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify(knowledge, null, 2));
    console.log(`\n✅ Done! Saved ${knowledge.length} chunks to knowledge.json`);
}

processMaterials();