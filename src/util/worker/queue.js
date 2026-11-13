/**
 * QUEUE FACTORY CHUNG CHO BULLMQ (Receipt + IQC dùng chung).
 *
 * Mọi Queue instance trong process đều tạo qua đây:
 *   - defaultJobOptions (technical retry #13) đặt MỘT chỗ — IQC không copy.
 *   - retention tập trung ở worker.config.js (jobRetention) — KHÔNG rải
 *     số magic ở đây. removeOn* chỉ phục vụ audit/debug; dedup key được
 *     giải phóng ở job finalization, KHÔNG phụ thuộc removeOn*.
 *   - connection: worker process dùng blocking connection, API process
 *     dùng producer connection (xem redis.js).
 *   - prefix (REDIS_PREFIX): namespace key Redis — prod/dev dùng chung
 *     Redis bắt buộc khác prefix, không trôi job giữa môi trường.
 *
 * Deduplication (BullMQ 6 native): caller truyền opts.deduplication =
 * { id: <business-key> } — add trùng key đang waiting/active/delayed sẽ
 * return job cũ (KHÔNG tạo bản thứ 2); key giải phóng khi job
 * completed/failed → completed allocation có thể enqueue lại NGAY.
 * Thay thế hoàn toàn cho fixed-jobId dedupe (jobId cố định +
 * removeOnComplete 1h từng chặn re-enqueue sau khi job xong).
 */

'use strict';

const { Queue } = require('bullmq');
const workerConfig = require('../../config/worker.config');
const {
    getWorkerRedisConnection,
    getProducerRedisConnection,
} = require('./redis');

/** Cache instance theo `${queueName}:${role}` — tránh tạo nhiều Queue. */
const cache = new Map();

/**
 * Default job options dùng chung mọi worker queue.
 * Technical retry: attempts 5 + exponential backoff 5s (config #13).
 */
const defaultJobOptions = {
    attempts: workerConfig.technicalRetry.attempts,
    backoff: workerConfig.technicalRetry.backoff,
    removeOnComplete: { age: workerConfig.jobRetention.removeOnCompleteAgeSec },
    removeOnFail: { age: workerConfig.jobRetention.removeOnFailAgeSec },
};

/** Options Queue chung (prefix namespace Redis cho mọi instance). */
const queueOptions = {
    prefix: workerConfig.redis.prefix,
    defaultJobOptions,
};

/**
 * Lấy (hoặc tạo) Queue producer — dùng trong API process để enqueue.
 * @param {string} queueName
 * @returns {Queue}
 */
function getProducerQueue(queueName) {
    const cacheKey = `${queueName}:producer`;
    if (!cache.has(cacheKey)) {
        cache.set(
            cacheKey,
            new Queue(queueName, {
                connection: getProducerRedisConnection(),
                ...queueOptions,
            })
        );
    }
    return cache.get(cacheKey);
}

/**
 * Lấy (hoặc tạo) Queue trong worker process — connection blocking, dùng
 * cho upsertJobScheduler (cron sweep) và các lệnh quản trị queue.
 * @param {string} queueName
 * @returns {Queue}
 */
function getWorkerQueue(queueName) {
    const cacheKey = `${queueName}:worker`;
    if (!cache.has(cacheKey)) {
        cache.set(
            cacheKey,
            new Queue(queueName, {
                connection: getWorkerRedisConnection(),
                ...queueOptions,
            })
        );
    }
    return cache.get(cacheKey);
}

/**
 * Đóng toàn bộ Queue instance của process (graceful shutdown).
 * @returns {Promise<void>}
 */
async function closeQueues() {
    const closing = [];
    for (const queue of cache.values()) {
        closing.push(queue.close().catch(() => { }));
    }
    await Promise.all(closing);
    cache.clear();
}

module.exports = {
    defaultJobOptions,
    getProducerQueue,
    getWorkerQueue,
    closeQueues,
};
