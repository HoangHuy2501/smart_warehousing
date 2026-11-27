'use strict';

const config = require('../../config/worker.config');
const { getWorkerRedisConnection } = require('./redis');

const HEARTBEAT_INTERVAL_MS = 15000;
const SIGNAL_MAX_AGE_MS = 45000;

// Tạo khóa Redis lưu heartbeat của worker.
function heartbeatKey(queueName) {
    return `${config.redis.prefix}:worker-heartbeat:${queueName}`;
}

// Ghi heartbeat định kỳ để theo dõi tiến trình worker.
function startHeartbeat(queueName) {
    const redis = getWorkerRedisConnection();
    let pending = false;

    // Ghi thời điểm hoạt động gần nhất lên Redis.
    async function publish() {
        if (pending || redis.status !== 'ready') return;
        pending = true;
        try {
            await redis.set(heartbeatKey(queueName), String(Date.now()), 'EX', 86400);
        } catch {
            // Redis connection lifecycle is already logged by the shared client.
        } finally {
            pending = false;
        }
    }

    void publish();
    const timer = setInterval(publish, HEARTBEAT_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}

module.exports = { heartbeatKey, startHeartbeat, SIGNAL_MAX_AGE_MS };
