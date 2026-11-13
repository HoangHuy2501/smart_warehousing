/**
 * QUEUE 'iqc-sync' — producer side (enqueue + business retry).
 *
 * Mirror clean pattern của receipt-sync.queue.js: queue chỉ quyết định
 * enqueue / delay / dedup, KHÔNG business logic. Job sync chạy ở worker
 * process riêng (`npm run worker:iqc`), API process chỉ gọi
 * enqueueIqcSync (hiện tại chỉ sweep gọi).
 *
 * BUSINESS RETRY (WAITING_IQC) KHÔNG qua add(): processor gọi
 * job.moveToDelayed(ts, token) + throw DelayedError — job chuyển sang
 * delayed TRÊN CHÍNH NÓ nên không bị dedup loại bỏ (xem iqc-sync.job.js).
 *
 * Job contract (payload tối giản — DB là source of truth):
 *   { allocationId: string }
 * Worker luôn đọc FRESH allocation / receipt / T8 theo allocationId —
 * KHÔNG đưa notice hay IQC row vào Redis.
 *
 * DEDUP NATIVE (BullMQ 6): opts.deduplication = { id, keepLastIfActive }
 * theo allocationId (KHÔNG dùng fixed jobId — Receipt Sync cũng không
 * dùng). Một allocation chỉ có 1 job in-flight; key giải phóng ở job
 * finalization nên job xong có thể enqueue lại ngay.
 *
 * Redis chưa kết nối được → trả false (KHÔNG throw): caller chỉ log, sweep
 * định kỳ khôi phục.
 */

'use strict';

const workerConfig = require('../config/worker.config');
const { getProducerQueue } = require('../util/worker/queue');
const { createWorkerLogger } = require('../util/worker/logger');

const logger = createWorkerLogger('iqc-sync-queue');

const QUEUE_NAME = workerConfig.queues.iqcSync;
const JOB_NAME_SYNC = 'sync';

/** API/sweep KHÔNG BAO GIỜ được treo vì Redis down — quá hạn coi như fail. */
const ENQUEUE_TIMEOUT_MS = 1500;

/**
 * add() với timeout: quá ENQUEUE_TIMEOUT_MS thì trả false ngay (ioredis
 * retryStrategy mặc định treo lâu).
 * @param {import('bullmq').Queue} queue
 * @param {string} name
 * @param {object} data
 * @param {object} opts
 * @param {{ reason: string }} reasonOut nhận lý do fail ('timeout' | lỗi thật)
 * @returns {Promise<boolean>} true nếu add thành công trong hạn
 */
async function addWithTimeout(queue, name, data, opts, reasonOut) {
    let timer = null;
    try {
        reasonOut.reason = 'timeout';
        const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), ENQUEUE_TIMEOUT_MS);
        });
        const result = await Promise.race([
            queue.add(name, data, opts).then(() => true),
            timeoutPromise,
        ]);
        return result === true;
    } catch (error) {
        reasonOut.reason = error.message;
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Dedup id theo allocation — dùng cho MỌI job sync của allocation đó (lần
 * đầu + business retry): không bao giờ có 2 job cùng allocation.
 * @param {string} allocationId
 * @returns {string}
 */
function buildSyncDedupId(allocationId) {
    // Giữ quy ước ký tự an toàn [a-zA-Z0-9_-] và KHÔNG chứa ':' cho id BullMQ.
    return `iqc-sync-sync-${allocationId}`;
}

/**
 * Enqueue job sync IQC cho 1 allocation (gọi từ sweep).
 * @param {string} allocationId PK của whs_slot_allocation
 * @param {{ delayMs?: number }} [options] delay trước khi job chạy (ms)
 * @returns {Promise<boolean>} true nếu đã vào queue (hoặc đã có job
 *   in-flight cùng allocation — dedup); false nếu Redis không sẵn sàng
 */
async function enqueueIqcSync(allocationId, options = {}) {
    const queue = getProducerQueue(QUEUE_NAME);
    const failureReason = { reason: '' };
    const added = await addWithTimeout(
        queue,
        JOB_NAME_SYNC,
        { allocationId },
        {
            deduplication: {
                id: buildSyncDedupId(allocationId),
                keepLastIfActive: true,
            },
            delay: options.delayMs || 0,
        },
        failureReason
    );
    if (!added) {
        logger.warn('enqueue_failed', { allocationId, reason: failureReason.reason });
    }
    return added;
}

module.exports = {
    QUEUE_NAME,
    JOB_NAME_SYNC,
    buildSyncDedupId,
    enqueueIqcSync,
};
