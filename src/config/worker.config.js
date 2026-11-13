/**
 * CẤU HÌNH WORKER CHUNG (Receipt Sync + IQC Worker sau này).
 *
 * Một chỗ DUY NHẤT đọc mọi env của worker infrastructure — IQC Worker
 * sau này require file này chứ KHÔNG tự khai báo lại env riêng.
 *
 * Nhóm cấu hình:
 *   1. Redis         : REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB /
 *                      REDIS_PREFIX / REDIS_TLS
 *   2. Queue          : tên queue (bullmq key space) + retention tập trung
 *   3. Technical retry: BullMQ attempts + backoff lũy thừa (lỗi hạ tầng:
 *                       SQL timeout, deadlock, mất kết nối — throw là
 *                       BullMQ tự retry)
 *   4. Business retry : lịch retry tiệm tiến cho trạng thái chờ T8
 *                       (WAITING_* — KHÔNG ăn vào technical attempts)
 *   5. Sweep          : cron quét allocation pending để enqueue lại
 *   6. Batch/Concurrency
 *
 * Lưu ý BullMQ: connection của Worker/Queue bắt buộc
 * `maxRetriesPerRequest: null` (xem util/worker/redis.js).
 */

'use strict';

/**
 * Cấu hình Redis dùng chung (mỗi process 1 connection lazy — xem redis.js).
 * prefix: namespace key BullMQ — prod/dev dùng chung Redis bắt buộc phải
 *   khác prefix (không trôi job giữa môi trường). KHÔNG chứa password.
 * tls: REDIS_TLS=true → bật TLS (Redis managed/HA bắt buộc TLS).
 */
const redis = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
    prefix: process.env.REDIS_PREFIX || 'smart-whs',
    tls: String(process.env.REDIS_TLS || '').toLowerCase() === 'true',
};

/** Tên queue — mỗi worker process tiêu thụ đúng 1 queue. */
const queues = {
    receiptSync: 'receipt-sync',
    iqcSync: 'iqc-sync',
};

/**
 * Technical retry (BullMQ job options mặc định cho mọi worker queue).
 * attempts = 5, backoff lũy thừa cơ số 5000ms: 5s → 10s → 20s → 40s.
 * Chỉ áp cho lỗi kỹ thuật (throw từ processor); business waiting KHÔNG
 * dùng cơ chế này.
 */
const technicalRetry = {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
};

/**
 * Business retry schedule cho Receipt Sync — khoảng chờ T8 push dữ liệu:
 * 30 giây → 1 phút → 5 phút → 15 phút. Hết lịch thì DỪNG (không vòng lặp
 * vô hạn); các lượt sweep định kỳ sẽ enqueue lại allocation pending.
 * IQC Worker sau này có thể tự khai schedule riêng nếu cần.
 * OVERRIDE (test/staging): RECEIPT_BUSINESS_RETRY_DELAYS_MS="2000,2000"
 * — danh sách ms phân tách bằng dấu phẩy; rỗng/sai format thì dùng mặc định.
 */
const envRetryDelays = String(
    process.env.RECEIPT_BUSINESS_RETRY_DELAYS_MS || ''
)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
const receiptBusinessRetryScheduleMs =
    envRetryDelays.length > 0
        ? envRetryDelays
        : [
            30_000,
            60_000,
            300_000,
            900_000,
            1_800_000,
        ];

/**
 * Lấy độ trễ cho lần business retry thứ `attempt` (1-based).
 * @param {number} attempt lần retry kế tiếp (bắt đầu từ 1)
 * @returns {number | null} ms; null = hết lịch, không retry nữa
 */
function businessRetryDelayMs(attempt) {
    const idx = Math.max(0, attempt - 1);
    if (idx >= receiptBusinessRetryScheduleMs.length) return null;
    return receiptBusinessRetryScheduleMs[idx];
}

/** Cron quét pending allocations: mỗi 5 phút. */
const receiptSweepCron = process.env.RECEIPT_SWEEP_CRON || '*/5 * * * *';

/** Job scheduler id cố định — upsert idempotent, restart không nhân bản lịch. */
const receiptSweepSchedulerId = 'receipt-sync-sweep';

/** Số allocation pending tối đa mỗi lượt sweep (candidate-first, #24/#25). */
const receiptSyncBatchSize = Number(process.env.RECEIPT_SYNC_BATCH_SIZE || 200);

/** Concurrency worker mặc định (không làm cạn SQL pool, #26). */
const receiptSyncConcurrency = Number(
    process.env.WORKER_RECEIPT_CONCURRENCY || 5
);

/** Cron quét allocation WAITING_IQC đã có lot: mỗi 5 phút (mirror
 *  receipt-sync — IQC T8 push sau khi Receipt Sync xong). */
const iqcSweepCron = process.env.IQC_SWEEP_CRON || '*/5 * * * *';

/** Job scheduler id cố định — upsert idempotent, restart không nhân bản lịch. */
const iqcSweepSchedulerId = 'iqc-sync-sweep';

/** Số allocation tối đa mỗi lượt sweep IQC. */
const iqcSyncBatchSize = Number(process.env.IQC_SYNC_BATCH_SIZE || 200);

/** Concurrency worker IQC mặc định. */
const iqcSyncConcurrency = Number(
    process.env.WORKER_IQC_CONCURRENCY || 5
);

/**
 * Retention job BullMQ tập trung MỘT chỗ (queue.js đọc — không rải số
 * magic trong defaultJobOptions):
 *   - completed: giữ 1h phục vụ audit/debug (job đã xong không liên quan
 *     dedup — dedup key giải phóng ở finalize, không phụ thuộc removeOn*)
 *   - failed  : giữ 24h để điều tra lỗi trước khi BullMQ tự dọn.
 */
const jobRetention = {
    removeOnCompleteAgeSec: Number(process.env.WORKER_KEEP_COMPLETED_SEC || 3600),
    removeOnFailAgeSec: Number(process.env.WORKER_KEEP_FAILED_SEC || 24 * 3600),
};

/**
 * Kiểm tra cấu hình worker khi boot (production hardening): thiếu cấu
 * hình chí mạng thì FAIL FAST với thông báo KHÔNG chứa giá trị secret.
 * @param {boolean} isProduction NODE_ENV=production?
 * @returns {string[]} danh sách lỗi cấu hình (rỗng = hợp lệ)
 */
function validateWorkerConfig(isProduction) {
    const problems = [];
    if (!Number.isFinite(redis.port) || redis.port <= 0) {
        problems.push('REDIS_PORT không hợp lệ');
    }
    if (isProduction) {
        if (!process.env.REDIS_HOST) {
            problems.push('Production phải set REDIS_HOST (không dùng default localhost)');
        }
        if (!process.env.REDIS_PASSWORD) {
            problems.push('Production phải set REDIS_PASSWORD');
        }
        if (!process.env.JWT_SECRET) {
            problems.push('Production phải set JWT_SECRET');
        }
        if (process.env.DB_MODE === 'memory') {
            problems.push('Production cấm DB_MODE=memory');
        }
    }
    return problems;
}

module.exports = {
    redis,
    queues,
    technicalRetry,
    receiptBusinessRetryScheduleMs,
    businessRetryDelayMs,
    receiptSweepCron,
    receiptSweepSchedulerId,
    receiptSyncBatchSize,
    receiptSyncConcurrency,
    iqcSweepCron,
    iqcSweepSchedulerId,
    iqcSyncBatchSize,
    iqcSyncConcurrency,
    jobRetention,
    validateWorkerConfig,
};
