'use strict';

/**
 * ENTRYPOINT WORKER PROCESS — IQC Sync (chạy riêng, song song API).
 *
 *   npm run worker:iqc   (smart-whs-iqc-worker)
 *
 * Process này KHÔNG phục vụ HTTP. Nó:
 *   1. upsert Job Scheduler 'sweep' (cron, BullMQ 6 API — KHÔNG dùng
 *      queue.add({repeat}) đã bị bỏ)
 *   2. tạo BullMQ Worker consume queue 'iqc-sync', routing theo job.name:
 *      'sync' → processIqcSync, 'sweep' → processIqcSyncSweep
 *   3. đăng ký graceful shutdown: close worker (chờ active jobs xong)
 *      → close queue → close Redis (thứ tự ngược đăng ký, xem
 *      graceful-shutdown.js). SQL pool không cần close tay.
 *
 * Cần Redis (REDIS_HOST/PORT/PASSWORD/DB — xem config/worker.config.js)
 * và cùng .env với API (DB_MODE, connection SQL Server).
 */

require('dotenv').config({
    path: require('path').join(__dirname, '..', '..', '.env'),
});

const workerConfig = require('../config/worker.config');
const { createAppWorker } = require('../util/worker/create-app-worker');
const { getWorkerQueue, closeQueues } = require('../util/worker/queue');
const { closeRedisConnections } = require('../util/worker/redis');
const { registerShutdownHandler } = require('../util/worker/graceful-shutdown');
const { createWorkerLogger } = require('../util/worker/logger');
const { QUEUE_NAME, JOB_NAME_SYNC } = require('../queues/iqc-sync.queue');
const {
    processIqcSync,
    processIqcSyncSweep,
} = require('../services/jobs/iqc-sync.job');

const logger = createWorkerLogger('iqc-sync-worker');

/**
 * Khởi động worker process.
 * Shutdown order (đăng ký NGƯỢC: redis + queue TRƯỚC worker — handler
 * chạy theo thứ tự ngược đăng ký → worker.close chạy đầu tiên).
 */
async function main() {
    const isProduction = process.env.NODE_ENV === 'production';
    const configProblems = workerConfig.validateWorkerConfig(isProduction);
    if (configProblems.length > 0) {
        for (const problem of configProblems) {
            logger.error('worker_config_invalid', { problem });
        }
        if (isProduction) {
            throw new Error('Worker config validation failed — see logs above');
        }
        logger.warn('worker_config_non_blocking', {
            note: 'Non-production: tiếp tục chạy dù config chưa chuẩn',
        });
    }

    registerShutdownHandler('close_redis', () => closeRedisConnections());
    registerShutdownHandler('close_queue', () => closeQueues());

    // Cron sweep: Job Scheduler id cố định → upsert idempotent, restart
    // không nhân bản lịch (BullMQ 6).
    const queue = getWorkerQueue(QUEUE_NAME);
    await queue.upsertJobScheduler(
        workerConfig.iqcSweepSchedulerId,
        { pattern: workerConfig.iqcSweepCron },
        { name: 'sweep', data: {} }
    );

    const worker = createAppWorker({
        workerName: 'iqc-sync',
        queueName: QUEUE_NAME,
        concurrency: workerConfig.iqcSyncConcurrency,
        processor: async (job, token) => {
            // Một queue, hai loại job — routing theo tên. `token` truyền xuống
            // để processor gọi job.moveToDelayed (business retry).
            if (job.name === 'sweep') return processIqcSyncSweep(job);
            return processIqcSync(job, token);
        },
    });

    logger.info('worker_started', {
        queue: QUEUE_NAME,
        jobNames: [JOB_NAME_SYNC, 'sweep'],
        concurrency: workerConfig.iqcSyncConcurrency,
        sweepCron: workerConfig.iqcSweepCron,
    });

    return { queue, worker };
}

main().catch((error) => {
    logger.error('worker_boot_failed', {
        errorName: error.name,
        message: error.message,
    });
    process.exit(1);
});
