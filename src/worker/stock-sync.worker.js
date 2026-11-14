'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const db = require('../config/db');
const workerConfig = require('../config/worker.config');
const { createAppWorker } = require('../util/worker/create-app-worker');
const { getWorkerQueue, closeQueues } = require('../util/worker/queue');
const { closeRedisConnections } = require('../util/worker/redis');
const { registerShutdownHandler } = require('../util/worker/graceful-shutdown');
const { createWorkerLogger } = require('../util/worker/logger');
const { processStockSweep } = require('../services/jobs/stock-sync.job');

const queueName = 'stock-sync';
const logger = createWorkerLogger('stock-sync-worker');

async function main() {
    if (db.getMode() === 'memory') throw new Error('Stock sync requires a SQL database');
    const problems = workerConfig.validateWorkerConfig(process.env.NODE_ENV === 'production');
    for (const problem of problems) logger.warn('worker_config_invalid', { problem });
    if (problems.length && process.env.NODE_ENV === 'production') {
        throw new Error('Worker config validation failed');
    }
    registerShutdownHandler('close_redis', closeRedisConnections);
    registerShutdownHandler('close_queue', closeQueues);
    await getWorkerQueue(queueName).upsertJobScheduler(
        'stock-sync-sweep', { pattern: '2-59/5 * * * *' }, { name: 'sweep', data: {} }
    );
    createAppWorker({ workerName: queueName, queueName, concurrency: 1, processor: processStockSweep });
}

main().catch((error) => {
    logger.error('worker_boot_failed', { errorName: error.name, message: error.message });
    process.exit(1);
});
