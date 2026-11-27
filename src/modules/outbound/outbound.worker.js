'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const workerConfig = require('../../config/worker.config');
const { createAppWorker } = require('../../util/worker/create-app-worker');
const { getWorkerQueue, closeQueues } = require('../../util/worker/queue');
const { closeRedisConnections, getProducerRedisConnection } = require('../../util/worker/redis');
const { registerShutdownHandler } = require('../../util/worker/graceful-shutdown');
const { createWorkerLogger } = require('../../util/worker/logger');
const { createDiscoverySweep, processCompletionSweep } = require('./outbound.job');

const { QUEUE_NAME: pushQueue, processOutboundPush } = require('./outbound-push.job');
const { vapidConfig } = require('./push-device.service');

const logger = createWorkerLogger('outbound-worker');

// Khởi động tiến trình xử lý job xuất kho.
async function startWorker(name, pattern, processor) {
    await getWorkerQueue(name).upsertJobScheduler(name, { pattern }, { name: 'sweep', data: {} });
    createAppWorker({ workerName: name, queueName: name, processor, concurrency: 1 });
}

// Khởi động worker và đăng ký xử lý hàng đợi.
async function main() {
    if (!process.env.OUTBOUND_SYNC_START_DATE) {
        logger.warn('outbound_disabled', { reason: 'OUTBOUND_SYNC_START_DATE is unset' });
        return;
    }
    const date = process.env.OUTBOUND_SYNC_START_DATE;
    const since = new Date(`${date}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+since) ||
        since.toISOString().slice(0, 10) !== date) {
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
    if (vapidConfig()) {
        createAppWorker({ workerName: pushQueue, queueName: pushQueue, processor: processOutboundPush, concurrency: 1 });
    }
}

main().catch((error) => {
    logger.error('worker_boot_failed', { errorName: error.name, message: error.message });
    process.exit(1);
});
