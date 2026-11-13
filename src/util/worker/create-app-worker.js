/**
 * BULLMQ WORKER FACTORY DÙNG CHUNG (Receipt + IQC).
 *
 * Mọi worker process tạo Worker BullMQ qua đây — khớp toàn bộ boilerplate:
 *   - connection blocking dùng chung của process (redis.js, #12)
 *   - technical retry lấy từ defaultJobOptions của queue.js (#13)
 *   - log sự kiện completed/failed/stalled có cấu trúc (#15)
 *   - graceful shutdown tự đăng ký: worker.close() chờ active jobs xong
 *     (BullMQ mặc định chờ) rồi mới đến Queue/Redis (#14)
 *
 * IQC Worker sau này chỉ cần:
 *   createAppWorker({
 *     workerName: 'iqc-sync',
 *     queueName: config.queues.iqcSync,
 *     processor: processIqcSync,
 *     concurrency: ...,
 *   })
 */

'use strict';

const { Worker } = require('bullmq');
const workerConfig = require('../../config/worker.config');
const { getWorkerRedisConnection } = require('./redis');
const { registerShutdownHandler } = require('./graceful-shutdown');
const { createWorkerLogger } = require('./logger');

/**
 * Tạo 1 BullMQ Worker có đầy đủ wiring chung.
 * @param {object} params
 * @param {string} params.workerName tên để log (vd 'receipt-sync')
 * @param {string} params.queueName queue sẽ consume
 * @param {(job: import('bullmq').Job) => Promise<unknown>} params.processor
 * @param {number} params.concurrency số job chạy song song
 * @returns {import('bullmq').Worker}
 */
function createAppWorker({ workerName, queueName, processor, concurrency }) {
    const logger = createWorkerLogger(workerName);

    const worker = new Worker(queueName, processor, {
        connection: getWorkerRedisConnection(),
        concurrency,
        // Prefix PHẢI trùng Queue producer — lệch prefix là worker không thấy job.
        prefix: workerConfig.redis.prefix,
    });

    worker.on('completed', (job, result) => {
        logger.info('job_completed', {
            jobId: job.id,
            name: job.name,
            // BullMQ 6: attemptsMade tại thời điểm completed đã tính cả lần
            // chạy vừa xong (lần đầu = 1) — KHÔNG +1 thêm.
            attempt: job.attemptsMade,
            state: result && result.state,
            durationMs: job.processedOn
                ? Math.max(0, (job.finishedOn || Date.now()) - job.processedOn)
                : undefined,
        });
    });

    worker.on('failed', (job, error) => {
        logger.error('job_failed', {
            jobId: job && job.id,
            name: job && job.name,
            attempt: job ? job.attemptsMade : undefined,
            attemptsConfigured: job ? job.opts.attempts : undefined,
            errorName: error.name,
            message: error.message,
        });
    });

    worker.on('stalled', (jobId) => {
        logger.warn('job_stalled', { jobId });
    });

    worker.on('error', (error) => {
        logger.error('worker_runtime_error', {
            errorName: error.name,
            message: error.message,
        });
    });

    // Đăng ký đầu tiên → shutdown chạy handler này TRƯỚC (thứ tự ngược).
    registerShutdownHandler(`close_worker_${workerName}`, () => worker.close());

    return worker;
}

module.exports = { createAppWorker };
