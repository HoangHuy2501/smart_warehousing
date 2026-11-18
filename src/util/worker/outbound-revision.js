'use strict';

const { randomUUID } = require('node:crypto');
const { redis: config } = require('../../config/worker.config');
const { getProducerRedisConnection } = require('./redis');

const KEY = `${config.prefix}:outbound:revision`;
const TIMEOUT_MS = 1000;

async function runRedis(operation) {
    const redis = getProducerRedisConnection();
    if (redis.status !== 'ready') return { ok: false };
    let timer;
    try {
        const value = await Promise.race([
            operation(redis),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('outbound_revision_timeout')), TIMEOUT_MS);
            }),
        ]);
        return { ok: true, value };
    } catch {
        return { ok: false };
    } finally {
        clearTimeout(timer);
    }
}

async function publishOutboundRevision() {
    const result = await runRedis((redis) => redis.set(KEY, randomUUID()));
    return result.ok;
}

let pendingRead;

function readOutboundRevision() {
    if (!pendingRead) {
        pendingRead = runRedis((redis) => redis.get(KEY))
            .then(({ ok, value }) => ({ available: ok, revision: value ?? null }))
            .finally(() => { pendingRead = undefined; });
    }
    return pendingRead;
}

module.exports = { publishOutboundRevision, readOutboundRevision };
