/**
 * QUEUE 'receipt-sync' — producer side (enqueue + business retry).
 *
 * Queue chỉ chịu trách nhiệm: enqueue, job options, delay, dedup —
 * KHÔNG business logic. Job sync chạy ở worker process riêng
 * (npm run worker:receipt), API process chỉ gọi enqueueReceiptSync.
 *
 * BUSINESS RETRY (WAITING_T8_RECEIPT / WAITING_LOT) KHÔNG qua add() nữa:
 * processor gọi job.moveToDelayed(ts, token) + throw DelayedError — job
 * chuyển sang delayed TRÊN CHÍNH NÓ (không tạo job mới) nên không bị
 * dedup loại bỏ (bug cũ: add() cùng dedup id khi job đang active bị
 * BullMQ discard → retry không bao giờ chạy). Xem receipt-sync.job.js.
 *
 * Job contract (payload nhỏ — chỉ reference, #17):
 *   { allocationId: string, businessAttempt?: number }
 * Worker luôn đọc fresh data từ DB theo allocationId — KHÔNG đưa full
 * allocation/PO/notice vào Redis.
 *
 * DEDUP NATIVE (BullMQ 6.4, #38/#39): opts.deduplication =
 *   { id, keepLastIfActive: true } theo allocationId (KHÔNG jobId cố định):
 *   - add trùng khi job cùng allocation đang waiting/delayed →
 *     BullMQ TRẢ job cũ, không tạo bản thứ 2 (1 job in-flight/allocation)
 *   - add khi job đang ACTIVE + keepLastIfActive → BullMQ GHI ĐÈ
 *     events của job active bằng lần add mới; khi job active hoàn tất,
 *     BullMQ TỰ ĐỒNG TẠO follow-up job với payload mới nhất (#17 semantic:
 *     update allocation khi worker đang chạy KHÔNG BỊ MẤT — job đọc fresh
 *     DB theo allocationId nên follow-up reconcile đúng state mới)
 *   - key tự giải phóng ở job finalization (completed/failed) → job xong
 *     thì add lại cho CÙNG allocation chạy NGAY (sửa fixed-jobId cũ:
 *     removeOnComplete giữ job 1h + jobId cố định → re-enqueue sau khi
 *     completed BỊ CHẶN 1h)
 *   - 100 add trùng → tối đa 1 active + 1 follow-up, không 100 jobs
 *   - worker crash giữa chừng: job stalled → failed → key giải phóng →
 *     enqueue/sweep khôi phục được ngay (không cần original enqueue)
 * (Id dedup KHÔNG chứa ':' — giữ quy ước jobId BullMQ 6.)
 *
 * HINT PAYLOAD (#37): sweep đã có sẵn candidate notice IDs theo PO —
 * truyền qua payload `hintNoticeIds` để job KHÔNG re-run full
 * PO/date search, chỉ re-read đúng các ID đó (relation [R2] vẫn ép
 * trong SQL; job luôn đọc FRESH số liệu trước khi ghi — hint chỉ là
 * phạm vi truy vấn, không phải dữ liệu quyết định).
 *
 * Redis chưa kết nối được → trả false (KHÔNG throw, #8): API KHÔNG chạy
 * sync inline thay thế — chỉ log; sweep định kỳ của worker khôi phục.
 */

'use strict';

const workerConfig = require('../config/worker.config');
const { getProducerQueue } = require('../util/worker/queue');
const { createWorkerLogger } = require('../util/worker/logger');

const logger = createWorkerLogger('receipt-sync-queue');

const QUEUE_NAME = workerConfig.queues.receiptSync;
const JOB_NAME_SYNC = 'sync';

/** API KHÔNG BAO GIỜ được treo vì Redis down — quá hạn là coi như fail. */
const ENQUEUE_TIMEOUT_MS = 1500;

/**
 * add() với timeout: quá ENQUEUE_TIMEOUT_MS thì trả false ngay (ioredis
 * retryStrategy mặc định treo lâu — caller cần fallback inline nhanh).
 * Nếu add thành công trễ (sau timeout) thì jobId dedupe tự xử lý.
 * @param {import('bullmq').Queue} queue
 * @param {string} name
 * @param {object} data
 * @param {object} opts
 * @param {string} reasonOut nhận lý do fail ('timeout' | lỗi thật) —
 *   caller đưa vào log để truy được nguyên nhân enqueue_failed.
 * @returns {Promise<boolean>} true nếu add thành công trong hạn
 */
async function addWithTimeout(queue, name, data, opts, reasonOut) {
    let timer = null;
    try {
        reasonOut.reason = 'timeout';
        const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), ENQUEUE_TIMEOUT_MS);
        });
        const result = await Promise.race([queue.add(name, data, opts).then(() => true), timeoutPromise]);
        return result === true;
    } catch (error) {
        reasonOut.reason = error.message;
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Dedup id theo allocation — dùng cho MỌI job sync của allocation đó
 * (lần đầu + business retry dùng chung 1 id: không bao giờ có 2 job
 * cùng allocation trong queue cùng lúc).
 * @param {string} allocationId
 * @returns {string}
 */
function buildSyncDedupId(allocationId) {
    // Giữ quy ước ký tự an toàn [a-zA-Z0-9_-] cho id BullMQ.
    return `receipt-sync-sync-${allocationId}`;
}

/**
 * Enqueue job sync receipt cho 1 allocation (gọi sau khi user Assign
 * Shelf, hoặc từ sweep). Job sẽ chạy ở worker process.
 * @param {string} allocationId PK của whs_slot_allocation
 * @param {{ delayMs?: number }} [options] delay trước khi job chạy (ms)
 * @returns {Promise<boolean>} true nếu đã vào queue (hoặc đã có job
 *   in-flight cùng allocation — dedup, coi như đã vào); false nếu Redis
 *   không sẵn sàng (caller CHỈ log — KHÔNG chạy sync inline thay thế)
 */
async function enqueueReceiptSync(allocationId, options = {}) {
    const businessAttempt = 0;
    const queue = getProducerQueue(QUEUE_NAME);
    const failureReason = { reason: '' };
    const payload = {
        allocationId,
        businessAttempt,
    };
    const hintIds = Array.isArray(options.hintNoticeIds)
        ? options.hintNoticeIds.map((nid) => Number(nid)).filter(Number.isFinite)
        : [];
    if (hintIds.length > 0) {
        // Payload vẫn nhỏ (#17): tối đa vài chục ID notice (sweep batch tối đa
        // vài trăm allocation × vài notice dòng).
        payload.hintNoticeIds = hintIds;
    }
    const added = await addWithTimeout(queue, JOB_NAME_SYNC, payload, {
        deduplication: {
            id: buildSyncDedupId(allocationId),
            keepLastIfActive: true,
        },
        delay: options.delayMs || 0,
    }, failureReason);
    if (!added) {
        logger.warn('enqueue_failed', { allocationId, reason: failureReason.reason });
    }
    return added;
}

module.exports = {
    QUEUE_NAME,
    JOB_NAME_SYNC,
    buildSyncDedupId,
    enqueueReceiptSync,
};
