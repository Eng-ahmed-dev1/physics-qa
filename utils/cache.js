const crypto = require('crypto');

// In-memory cache stores
// In serverless, these persist only for the lifetime of the Lambda container.
const cacheStore = new Map();
const embeddingCacheStore = new Map();
const rateLimitStore = new Map(); // IP -> { count, windowStart }

function generateHash(data) {
    return crypto.createHash('sha256').update(data.toLowerCase().trim()).digest('hex');
}

// 1. Full Pipeline Cache
function getCachedResponse(question) {
    const key = generateHash(question);
    return cacheStore.get(key) || null;
}

function setCachedResponse(question, response) {
    const key = generateHash(question);
    if (cacheStore.size > 1000) {
        const firstKey = cacheStore.keys().next().value;
        cacheStore.delete(firstKey);
    }
    cacheStore.set(key, response);
}

// 2. Embedding Cache
function getCachedEmbedding(question) {
    const key = generateHash(question);
    return embeddingCacheStore.get(key) || null;
}

function setCachedEmbedding(question, embedding) {
    const key = generateHash(question);
    if (embeddingCacheStore.size > 1000) {
        const firstKey = embeddingCacheStore.keys().next().value;
        embeddingCacheStore.delete(firstKey);
    }
    embeddingCacheStore.set(key, embedding);
}

// 3. Rate Limiting
function isRateLimited(ip) {
    if (!ip) return false;
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    const maxRequests = 20;

    let record = rateLimitStore.get(ip);
    if (!record || now - record.windowStart > windowMs) {
        record = { count: 1, windowStart: now };
        rateLimitStore.set(ip, record);
        return false;
    }
    
    if (record.count >= maxRequests) {
        return true;
    }
    
    record.count++;
    return false;
}

// Cleanup interval to avoid memory leaks in rate limit store
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimitStore.entries()) {
        if (now - record.windowStart > 60000) {
            rateLimitStore.delete(ip);
        }
    }
}, 60000).unref();

module.exports = {
    getCachedResponse,
    setCachedResponse,
    getCachedEmbedding,
    setCachedEmbedding,
    isRateLimited,
    generateHash
};
