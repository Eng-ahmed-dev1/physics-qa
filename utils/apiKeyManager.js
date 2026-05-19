/**
 * API Key Manager - Groq Load Balancer
 */

const keyStats = {};

function getKeys() {
    const keys = [];
    for (const [keyName, keyValue] of Object.entries(process.env)) {
        if ((keyName.startsWith('GROQ_API_KEY') || keyName.startsWith('GROK_API_KEY')) && keyValue) {
            if (!keyStats[keyName]) {
                keyStats[keyName] = { successCount: 0, failureCount: 0, disabledUntil: 0 };
            }
            keys.push({
                keyId: keyName,
                key: keyValue,
                apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
                model: 'llama-3.3-70b-versatile',
                ...keyStats[keyName]
            });
        }
    }
    return keys;
}

async function getBestKey(failedInCurrentReq = []) {
    const keys = getKeys();
    const now = Date.now();

    const available = keys.filter(k =>
        !failedInCurrentReq.includes(k.keyId) &&
        k.disabledUntil < now
    );

    if (available.length === 0) return null;

    // Pick key with least failures
    available.sort((a, b) => a.failureCount - b.failureCount);
    return available[0];
}

function reportSuccess(keyId) {
    if (!keyStats[keyId]) keyStats[keyId] = { successCount: 0, failureCount: 0, disabledUntil: 0 };
    keyStats[keyId].successCount++;
}

function reportFailure(keyId) {
    if (!keyStats[keyId]) keyStats[keyId] = { successCount: 0, failureCount: 0, disabledUntil: 0 };
    keyStats[keyId].failureCount++;

    // Disable key for 5 minutes after 3 failures
    if (keyStats[keyId].failureCount >= 3) {
        keyStats[keyId].disabledUntil = Date.now() + 5 * 60 * 1000;
        keyStats[keyId].failureCount = 0;
    }
}

function getAllKeysStatus() {
    return getKeys().map(k => ({
        key_id: k.keyId,
        status: k.disabledUntil > Date.now() ? 'disabled' : 'active',
        successCount: k.successCount,
        failureCount: k.failureCount
    }));
}

async function initKeys() { }

module.exports = { getBestKey, reportSuccess, reportFailure, getAllKeysStatus, initKeys };