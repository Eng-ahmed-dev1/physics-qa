/**
 * Production-Grade API Key Manager
 * Handles stateful key tracking, smart load balancing, auto-disable, and auto-recovery.
 * Syncs metrics with Supabase if configured.
 */

const supabase = require('./supabaseClient');

const keysState = {};
let dbSynced = false;

// Batching state
const dirtyKeys = new Set();
let flushInterval = null;

// Initialize state
async function initKeys() {
    if (Object.keys(keysState).length > 0) return;

    const addKey = (keyId, key, apiUrl, model) => {
        if (!keysState[keyId]) {
            keysState[keyId] = {
                keyId, key, apiUrl, model,
                successCount: 0,
                failureCount: 0,
                lastUsed: 0,
                disabledUntil: 0
            };
        }
    };

    // Collect all OPENAI_API_KEY_X
    for (const [keyName, keyValue] of Object.entries(process.env)) {
        if (keyName.startsWith('OPENAI_API_KEY') && keyValue) {
            addKey(keyName, keyValue, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini');
        }
    }

    // Collect all GROK_API_KEY_X or XAI_API_KEY_X
    for (const [keyName, keyValue] of Object.entries(process.env)) {
        if ((keyName.startsWith('GROK_API_KEY') || keyName.startsWith('XAI_API_KEY')) && keyValue) {
            addKey(keyName, keyValue, 'https://api.x.ai/v1/chat/completions', 'grok-3');
        }
    }

    if (process.env.OPENAI_API_KEY && !keysState['OPENAI_API_KEY']) {
        addKey('OPENAI_API_KEY', process.env.OPENAI_API_KEY, 'https://api.openai.com/v1/chat/completions', 'gpt-4o-mini');
    }
    if (process.env.XAI_API_KEY && !keysState['XAI_API_KEY']) {
        addKey('XAI_API_KEY', process.env.XAI_API_KEY, 'https://api.x.ai/v1/chat/completions', 'grok-beta');
    }

    // Try to sync with Supabase if available
    if (supabase && !dbSynced) {
        try {
            const { data, error } = await supabase.from('api_key_metrics').select('*');
            if (!error && data) {
                data.forEach(dbKey => {
                    if (keysState[dbKey.key_id]) {
                        keysState[dbKey.key_id].successCount = dbKey.success_count;
                        keysState[dbKey.key_id].failureCount = dbKey.failure_count;
                        keysState[dbKey.key_id].lastUsed = new Date(dbKey.last_used).getTime() || 0;
                        keysState[dbKey.key_id].disabledUntil = new Date(dbKey.disabled_until).getTime() || 0;
                    }
                });
            }
            dbSynced = true;

            if (!flushInterval) {
                flushInterval = setInterval(flushToDb, 15000);
                if (flushInterval.unref) flushInterval.unref(); // Don't block Node exit
            }
        } catch (err) {
            console.error('Failed to sync API keys from Supabase:', err);
        }
    }
}

async function flushToDb() {
    if (!supabase || dirtyKeys.size === 0) return;

    const keysToFlush = Array.from(dirtyKeys);
    dirtyKeys.clear();

    const upsertData = keysToFlush.map(keyId => {
        const state = keysState[keyId];
        return {
            key_id: state.keyId,
            success_count: state.successCount,
            failure_count: state.failureCount,
            last_used: new Date(state.lastUsed).toISOString(),
            disabled_until: state.disabledUntil > 0 ? new Date(state.disabledUntil).toISOString() : null
        };
    });

    try {
        await supabase.from('api_key_metrics').upsert(upsertData);
    } catch (err) {
        console.error('Failed to bulk sync metrics to DB:', err);
        // Put back in dirty queue
        keysToFlush.forEach(k => dirtyKeys.add(k));
    }
}

async function getBestKey(failedInCurrentReq = []) {
    await initKeys();

    const now = Date.now();
    let bestKey = null;
    let highestScore = -Infinity;

    for (const state of Object.values(keysState)) {
        if (failedInCurrentReq.includes(state.keyId)) continue;
        if (state.disabledUntil > now) continue;

        const recencyPenalty = (now - state.lastUsed) < 60000 ? 1 : 0;
        const score = state.successCount - (state.failureCount * 2) - recencyPenalty;

        if (score > highestScore) {
            highestScore = score;
            bestKey = state;
        }
    }

    return bestKey;
}

function reportSuccess(keyId) {
    if (keysState[keyId]) {
        keysState[keyId].successCount++;
        keysState[keyId].lastUsed = Date.now();
        dirtyKeys.add(keyId);
    }
}

function reportFailure(keyId) {
    if (keysState[keyId]) {
        keysState[keyId].failureCount++;
        keysState[keyId].lastUsed = Date.now();

        if (keysState[keyId].failureCount >= 3) {
            keysState[keyId].disabledUntil = Date.now() + 5 * 60 * 1000;
            keysState[keyId].failureCount = 0;
        }

        dirtyKeys.add(keyId);
    }
}

function getAllKeysStatus() {
    return Object.values(keysState).map(state => {
        const total = state.successCount + state.failureCount;
        return {
            key_id: state.keyId,
            success_rate: total > 0 ? state.successCount / total : 1,
            failure_rate: total > 0 ? state.failureCount / total : 0,
            status: state.disabledUntil > Date.now() ? 'disabled' : 'active'
        };
    });
}

module.exports = {
    getBestKey,
    reportSuccess,
    reportFailure,
    getAllKeysStatus,
    initKeys
};
