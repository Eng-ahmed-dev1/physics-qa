const { getAllKeysStatus, initKeys } = require('../../utils/apiKeyManager');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        await initKeys(); // Ensure state is loaded from DB if available
        const keysStatus = getAllKeysStatus();
        
        let activeKeys = 0;
        let disabledKeys = 0;
        
        keysStatus.forEach(k => {
            if (k.status === 'active') activeKeys++;
            else disabledKeys++;
        });
        
        let systemHealth = 'good';
        if (activeKeys === 0) systemHealth = 'critical';
        else if (disabledKeys > 0) systemHealth = 'degraded';

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' // simple CORS
            },
            body: JSON.stringify({
                keys: keysStatus,
                system_health: systemHealth
            })
        };
    } catch (error) {
        console.error('Metrics error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Internal Server Error" })
        };
    }
};
