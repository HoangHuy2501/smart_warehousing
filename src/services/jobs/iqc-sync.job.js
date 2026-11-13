/**
 * JOB ORCHESTRATION của queue 'iqc-sync' (BullMQ processor).
 *
 * Đúng 1 đường chạy của mọi job IQC Sync:
 *   Queue → Worker (util/worker/create-app-worker) →
 *   processIqcSync (file này) →
 *   services/iqc-sync.service.js (business) → repository (SQL).
 *
 * File này KHÔNG chứa SQL, KHÔNG quyết định mapping IQC — chỉ:
 *   1. đọc/validate job.data (contract: { allocationId })
 *   2. gọi service.syncAllocation(allocationId)
 *   3. đọc result.state:
 *      - WAITING_IQC → BUSINESS RETRY bằng job.moveToDelayed(ts, token) +
 *        throw DelayedError: job CHUYỂN SANG DELAYED TRÊN CHÍNH NÓ (không
 *        add job mới — add cùng dedup id khi job còn active sẽ bị BullMQ
 *        discard). Lịch tiệm tiến dùng businessRetryDelayMs của
 *        worker.config (30s → 1m → 5m → 15m → 30m); hết lịch thì dừng
 *        hẳn — sweep cron đón allocation vẫn WAITING_IQC. Business waiting
 *        KHÔNG ăn technical attempts.
 *      - PARTIAL_AMBIGUOUS / DATA_ERROR → trả result, KHÔNG throw, KHÔNG
 *        retry (cần người vận hành xem log / dữ liệu T8).
 *      - NO_OP / MATCHED / RETURNED → trả result cho BullMQ completed.
 *   4. structured log kết quả job
 *
 * Technical error (SQL timeout/deadlock/mất kết nối) propagate lên BullMQ
 * → technical retry theo defaultJobOptions (attempts 5, exponential 5s).
 * Lỗi dữ liệu vĩnh viễn (DataIntegrityError / AmbiguousMatchError /
 * !isRetryableError) → UnrecoverableError: job failed NGAY, không ăn
 * technical attempts.
 *
 * Job 'sweep' (cron, upsertJobScheduler ở worker entrypoint):
 *   query candidate set-based (chỉ allocation còn mở + WAITING_IQC +
 *   receipt có lot) với CURSOR KEYSET chống starvation, rồi enqueue
 *   (dedup native — 1 job in-flight/allocation).
 */

'use strict';

const { DelayedError, UnrecoverableError } = require('bullmq');
const workerConfig = require('../../config/worker.config');
const iqcSyncService = require('../iqc-sync.service');
const IqcSyncRepository = require('../../repository/sql/iqc-sync.repository');
const { enqueueIqcSync } = require('../../queues/iqc-sync.queue');
const { createWorkerLogger } = require('../../util/worker/logger');
const {
    DataIntegrityError,
    AmbiguousMatchError,
    isRetryableError,
} = require('../../util/worker/errors');

const logger = createWorkerLogger('iqc-sync-job');

/** State cần chờ T8 push thêm dữ liệu → business retry (KHÔNG technical). */
const WAITING_STATES = new Set([iqcSyncService.IQC_SYNC_STATES.WAITING_IQC]);

/**
 * Processor job 'sync' — payload { allocationId }.
 * @param {import('bullmq').Job} job
 * @param {string} token lock token của BullMQ worker (dùng cho moveToDelayed)
 * @returns {Promise<object>} result của service (+ retry info nếu WAITING)
 */
async function processIqcSync(job, token) {
    const { allocationId, businessAttempt = 0 } = job.data || {};
    if (typeof allocationId !== 'string' || allocationId.length === 0) {
        throw new DataIntegrityError(
            `Payload job IQC sync không hợp lệ: ${JSON.stringify(job.data)}`
        );
    }

    const startedAt = Date.now();
    let result;
    try {
        result = await iqcSyncService.syncAllocation(allocationId);
    } catch (error) {
        if (
            error instanceof DataIntegrityError ||
            error instanceof AmbiguousMatchError ||
            !isRetryableError(error)
        ) {
            logger.error('job_unrecoverable', {
                jobId: job.id,
                allocationId,
                errorName: error.name,
                durationMs: Date.now() - startedAt,
            });
            throw new UnrecoverableError(error.message);
        }
        throw error;
    }

    logger.info('iqc_result', {
        jobId: job.id,
        allocationId,
        state: result.state,
        reason: result.reason,
        qtyInStock: result.qtyInStock,
        qtyReturn: result.qtyReturn,
        iqcDecision: result.iqcDecision,
        businessAttempt,
        durationMs: Date.now() - startedAt,
    });

    // Business waiting: DỜI JOB CHÍNH NÓ (moveToDelayed) — không throw để ăn
    // technical attempts, cũng không add job mới (sẽ bị dedup loại).
    if (WAITING_STATES.has(result.state)) {
        const nextAttempt = businessAttempt + 1;
        const delayMs = workerConfig.businessRetryDelayMs(nextAttempt);
        if (delayMs === null) {
            // Hết lịch tiệm tiến: dừng retry, trả result — sweep cron đón sau.
            result.businessAttempt = nextAttempt - 1;
            result.retryExhausted = true;
            return result;
        }
        await job.updateData({ ...job.data, businessAttempt: nextAttempt });
        await job.moveToDelayed(Date.now() + delayMs, token);
        result.businessAttempt = nextAttempt;
        result.retryAfterMs = delayMs;
        // DelayedError = tín hiệu chuẩn BullMQ: job đã tự dời sang delayed,
        // worker KHÔNG đánh dấu failed / KHÔNG ăn technical attempt.
        throw new DelayedError('iqc_sync_business_retry');
    }

    return result;
}

/**
 * Con trỏ keyset của sweep — GIỮ TRONG PROCESS: hết cửa sổ (batch <
 * limit) thì reset về đầu (wrap-around). Restart → quét lại từ đầu, vô
 * hại vì enqueue có dedup.
 */
const sweepState = {
    pendingCursor: null,
};

/**
 * Trích cursor từ dòng cuối batch.
 * @param {Array<{ allocatedAt: Date | string, allocationId: string }>} rows
 * @returns {{ allocatedAt: string, allocationId: string } | null}
 */
function advanceCursor(rows) {
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    return {
        allocatedAt: new Date(last.allocatedAt).toISOString(),
        allocationId: String(last.allocationId),
    };
}

/**
 * Processor job 'sweep' — enqueue allocation WAITING_IQC đã có lot.
 * @param {import('bullmq').Job} job
 * @returns {Promise<object>}
 */
async function processIqcSyncSweep(job) {
    const limit = workerConfig.iqcSyncBatchSize;
    const candidates = await IqcSyncRepository.findIqcPendingAllocations(
        limit,
        sweepState.pendingCursor
    );

    let enqueued = 0;
    for (const candidate of candidates) {
        if (await enqueueIqcSync(candidate.allocationId)) enqueued += 1;
    }

    sweepState.pendingCursor =
        candidates.length < limit ? null : advanceCursor(candidates);

    logger.info('iqc_sweep_result', {
        jobId: job.id,
        pending: candidates.length,
        enqueued,
        cursorActive: sweepState.pendingCursor !== null,
    });
    return { pending: candidates.length, enqueued };
}

module.exports = { processIqcSync, processIqcSyncSweep };
