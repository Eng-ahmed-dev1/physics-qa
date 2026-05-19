const askBtn = document.getElementById('askBtn');
const questionInput = document.getElementById('questionInput');
const loadingIndicator = document.getElementById('loadingIndicator');
const loadingText = document.getElementById('loadingText');
const resultsContainer = document.getElementById('resultsContainer');
const examContainer = document.getElementById('examContainer');
const answerText = document.getElementById('answerText');
const sourcesContainer = document.getElementById('sourcesContainer');
const badgesContainer = document.getElementById('badgesContainer');
const errorMsg = document.getElementById('errorMsg');

// ── Exam detection ─────────────────────────────────────────
// Patterns: "exam of 50", "generate 30 questions", "امتحان من 20", etc.
function detectExamRequest(q) {
    const lower = q.toLowerCase();

    // English patterns
    const enPatterns = [
        /\b(exam|quiz|test)\b/,
        /generate\s+\d+\s+questions?/,
        /\d+\s+questions?/,
        /make\s+(an?\s+)?(exam|quiz|test)/,
        /give\s+me\s+\d+/,
    ];

    // Arabic patterns
    const arPatterns = [
        /امتحان/,
        /اسئلة|أسئلة/,
        /اختبار/,
        /اعمل.*امتحان/,
        /هات.*سؤال/,
    ];

    return [...enPatterns, ...arPatterns].some(p => p.test(lower) || p.test(q));
}

// Extract question count from the string
function extractCount(q) {
    const match = q.match(/\d+/);
    if (match) {
        const n = parseInt(match[0]);
        // Sanity clamp: 5 – 100
        return Math.min(Math.max(n, 5), 100);
    }
    return 20; // default
}

// ── Typing effect ──────────────────────────────────────────
async function typeWriter(element, text, speed = 8) {
    element.textContent = '';
    for (let i = 0; i < text.length; i++) {
        element.textContent += text.charAt(i);
        await new Promise(r => setTimeout(r, speed + Math.random() * 5));
    }
}

// ── Reset UI ───────────────────────────────────────────────
function resetUI() {
    errorMsg.style.display = 'none';
    resultsContainer.style.display = 'none';
    examContainer.style.display = 'none';
    sourcesContainer.style.display = 'none';
    answerText.textContent = '';
    loadingIndicator.style.display = 'flex';
    askBtn.disabled = true;
}

// ── Render exam ────────────────────────────────────────────
function renderExam(data) {
    const wrap = document.getElementById('examContent');
    wrap.innerHTML = '';

    const questions = data.exam || [];
    const summary = data.summary || {};
    const byType = summary.by_type || {};

    // Header
    const header = document.createElement('div');
    header.className = 'exam-header';
    header.innerHTML = `
                <h2>⚡ Generated Exam — ${questions.length} Questions</h2>
                <div class="exam-summary">
                    ${Object.entries(byType).map(([t, n]) =>
        `<span class="exam-tag">${t}: ${n}</span>`
    ).join('')}
                </div>`;
    wrap.appendChild(header);

    // Progress hint
    const prog = document.createElement('div');
    prog.className = 'exam-progress';
    prog.textContent = `Click any question to see its source`;
    wrap.appendChild(prog);

    // Question cards
    questions.forEach((q, idx) => {
        const card = document.createElement('div');
        card.className = 'question-card';

        const typeClass = `type-${q.type || 'concept'}`;
        const typeLabel = (q.type || 'concept').replace('_', '/');

        let optionsHTML = '';
        if (q.type === 'mcq' && Array.isArray(q.options)) {
            optionsHTML = `<div class="mcq-options">
                        ${q.options.map(o => `<div class="mcq-option">${o}</div>`).join('')}
                    </div>`;
        }

        card.innerHTML = `
                    <div class="question-top">
                        <span class="q-number">Q${q.number || idx + 1}</span>
                        <span class="q-type-badge ${typeClass}">${typeLabel}</span>
                        <span class="q-text">${q.question}</span>
                        <svg class="q-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </div>
                    <div class="question-meta">
                        ${optionsHTML}
                        <div class="q-source">📄 ${q.source || '—'}${q.page ? ' · Pg. ' + q.page : ''}</div>
                    </div>`;

        // Toggle open/close
        card.querySelector('.question-top').addEventListener('click', () => {
            card.classList.toggle('open');
        });

        wrap.appendChild(card);
    });

    // Actions
    const actions = document.createElement('div');
    actions.className = 'exam-actions';
    actions.innerHTML = `
                <button class="exam-btn" id="expandAllBtn">Expand All</button>
                <button class="exam-btn" id="collapseAllBtn">Collapse All</button>`;
    wrap.appendChild(actions);

    document.getElementById('expandAllBtn').addEventListener('click', () => {
        wrap.querySelectorAll('.question-card').forEach(c => c.classList.add('open'));
    });
    document.getElementById('collapseAllBtn').addEventListener('click', () => {
        wrap.querySelectorAll('.question-card').forEach(c => c.classList.remove('open'));
    });
}

// ── Main handler ───────────────────────────────────────────
async function askQuestion() {
    const question = questionInput.value.trim();
    if (!question) return;

    resetUI();

    const isExam = detectExamRequest(question);
    const endpoint = isExam ? '/.netlify/functions/exam' : '/.netlify/functions/ask';
    const payload = isExam
        ? { count: extractCount(question) }
        : { question };

    loadingText.textContent = isExam
        ? `Generating exam questions from all sources...`
        : `Synthesizing Data...`;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) throw new Error(data.error || 'Request failed.');

        loadingIndicator.style.display = 'none';

        if (isExam) {
            // ── Exam mode ──
            examContainer.style.display = 'flex';
            examContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            renderExam(data);
        } else {
            // ── Q&A mode ──
            resultsContainer.style.display = 'flex';
            resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });

            await typeWriter(answerText, data.answer, 12);

            if (data.sources && data.sources.length > 0) {
                badgesContainer.innerHTML = '';
                data.sources.forEach(src => {
                    const badge = document.createElement('div');
                    badge.className = 'badge';
                    badge.innerHTML = `
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                    <polyline points="14 2 14 8 20 8"></polyline>
                                    <line x1="16" y1="13" x2="8" y2="13"></line>
                                    <line x1="16" y1="17" x2="8" y2="17"></line>
                                    <polyline points="10 9 9 9 8 9"></polyline>
                                </svg>
                                ${src.source} <span class="pg">Pg. ${src.page}</span>`;
                    badgesContainer.appendChild(badge);
                });
                sourcesContainer.style.display = 'block';
                sourcesContainer.style.animation = 'fadeIn 0.5s ease-out';
            }
        }

    } catch (error) {
        loadingIndicator.style.display = 'none';
        errorMsg.textContent = error.message;
        errorMsg.style.display = 'block';
    } finally {
        askBtn.disabled = false;
    }
}

askBtn.addEventListener('click', askQuestion);
questionInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') askQuestion();
});