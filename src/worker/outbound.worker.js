'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const db = require('../config/db');
const workerConfig = require('../config/worker.config');
const { createAppWorker } = require('../util/worker/create-app-worker');
const { getWorkerQueue, closeQueues } = require('../util/worker/queue');
const { closeRedisConnections, getProducerRedisConnection } = require('../util/worker/redis');
const { registerShutdownHandler } = require('../util/worker/graceful-shutdown');
const { createWorkerLogger } = require('../util/worker/logger');
const { createDiscoverySweep, processCompletionSweep } = require('../services/jobs/outbound.job');

const logger = createWorkerLogger('outbound-worker');

async function startWorker(name, pattern, processor) {
    await getWorkerQueue(name).upsertJobScheduler(name, { pattern }, { name: 'sweep', data: {} });
    createAppWorker({ workerName: name, queueName: name, processor, concurrency: 1 });
}

async function main() {
    if (!process.env.OUTBOUND_SYNC_START_DATE) {
        logger.warn('outbound_disabled', { reason: 'OUTBOUND_SYNC_START_DATE is unset' });
        return;
    }
    const date = process.env.OUTBOUND_SYNC_START_DATE;
    const since = new Date(`${date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+since) ||
        since.toISOString().slice(0, 10) !== date || db.getMode() === 'memory') {
        throw new Error('Outbound sync requires a SQL database and a valid YYYY-MM-DD start date');
    }
    const production = process.env.NODE_ENV === 'production';
    const problems = workerConfig.validateWorkerConfig(production);
    for (const problem of problems) logger.warn('worker_config_invalid', { problem });
    if (production && problems.length) throw new Error('Worker config validation failed');
    getProducerRedisConnection();
    registerShutdownHandler('close_redis', closeRedisConnections);
    registerShutdownHandler('close_queue', closeQueues);
    await startWorker('outbound-discovery', '1-59/5 * * * *', createDiscoverySweep(date));
    await startWorker('outbound-completion', '3-59/5 * * * *', processCompletionSweep);
}

main().catch((error) => {
    logger.error('worker_boot_failed', { errorName: error.name, message: error.message });
    process.exit(1);
});
