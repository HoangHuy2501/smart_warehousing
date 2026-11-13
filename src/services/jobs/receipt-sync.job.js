/**
 * JOB ORCHESTRATION của queue 'receipt-sync' (BullMQ processor).
 *
 * Đúng 1 đường chạy của mọi job Receipt Sync:
 *   Queue → Worker (util/worker/create-app-worker) →
 *   processReceiptSync (file này) →
 *   services/receipt-sync.service.js (business) →
 *   repository (SQL) → SQL Server
 *
 * File này KHÔNG chứa SQL, KHÔNG quyết định reconciliation — chỉ:
 *   1. đọc/validate job.data (contract: { allocationId, businessAttempt? })
 *   2. gọi service.syncAllocation(allocationId)
 *   3. đọc result.state:
 *      - WAITING_T8_RECEIPT / WAITING_LOT → BUSINESS RETRY bằng
 *        job.moveToDelayed(ts, token) + throw DelayedError — job CHUYỂN
 *        SANG DELAYED TRÊN CHÍNH NÓ (không add job mới), nên:
 *          * dedup key BullMQ vẫn do job này giữ → không spam duplicate
 *          * retry THẬT SỰ chạy khi hết delay (fix bug cũ: schedule qua
 *            queue.add() cùng dedup id khi job còn active → bị BullMQ
 *            discard, "log scheduled" nhưng không bao giờ chạy — #6)
 *        businessAttempt tăng dần lưu trong job.data (updateData) để lấy
 *        delay theo lịch tiệm tiến (30s → 1m → 5m → 15m → 30m — #8).
 *        Hết lịch → KHÔNG retry nữa (thành thường) — sweep đón số còn
 *        thiếu (#9 low-frequency recovery).
 *      - DATA_ERROR / AMBIGUOUS / NO_OP → trả result, KHÔNG throw
 *      - MATCHED / SHORTAGE / EXCESS → trả result cho BullMQ completed
 *   4. structured log kết quả job
 *
 * Technical error (SQL timeout/deadlock/mất kết nối) từ repository/service
 * tự nhiên propagate lên BullMQ → technical retry theo defaultJobOptions
 * (attempts 5, exponential 5s). Payload sai → DataIntegrityError (job
 * processor để nguyên — đây là lỗi không retry được).
 *
 * Job 'sweep' (cron 5 phút, upsertJobScheduler ở worker entrypoint):
 *   PHASE-1: quét allocation PENDING (chưa nhận đủ) — batch set-based
 *   (4 câu query cố định cho cả lượt) + CURSOR KEYSET chống starvation (#9)
 *   rồi enqueue những allocation ACTIONABLE.
 *   PHASE-2: quét allocation ĐÃ CÓ receipt để REVALIDATE T8 (#29-#32)
 *   — notice biến mất / sheet_qty giảm / made_lot đổi → persist issue
 *   qua collectReconcileIssues (cùng rule với đường sync — không drift).
 */

'use strict';

const { DelayedError, UnrecoverableError } = require('bullmq');
const workerConfig = require('../../config/worker.config');
const receiptSyncService = require('../receipt-sync.service');
const ReceiptSyncRepository = require('../../repository/sql/receipt-sync.repository');
const PoRepository = require('../../repository/sql/po.repository');
const ReceiptRepository = require('../../repository/sql/receipt.repository');
const ReconcileIssueRepository = require('../../repository/sql/reconcile-issue.repository');
const { enqueueReceiptSync } = require('../../queues/receipt-sync.queue');
const { createWorkerLogger } = require('../../util/worker/logger');
const {
    DataIntegrityError,
    AmbiguousMatchError,
    isRetryableError,
} = require('../../util/worker/errors');

const logger = createWorkerLogger('receipt-sync-job');

const WAITING_STATES = new Set(['WAITING_T8_RECEIPT', 'WAITING_LOT']);

/**
 * Processor job 'sync' — payload { allocationId, businessAttempt? }.
 * @param {import('bullmq').Job} job
 * @param {string} token lock token của BullMQ worker (dùng cho moveToDelayed)
 * @returns {Promise<object>} result của service (+ retry info nếu WAITING)
 */
async function processReceiptSync(job, token) {
    const { allocationId, businessAttempt = 0 } = job.data || {};
    if (typeof allocationId !== 'string' || allocationId.length === 0) {
        throw new DataIntegrityError(
            `Payload job sync không hợp lệ: ${JSON.stringify(job.data)}`
        );
    }

    const startedAt = Date.now();
    // hintNoticeIds (#37): sweep đã có sẵn candidate notice IDs — service chỉ
    // re-read đúng các ID đó (relation [R2] vẫn ép trong SQL), KHÔNG re-run
    // full PO/date search. Hint chỉ là phạm vi truy vấn — con số ghi receipt
    // luôn được tính FRESH trong tx.
    const hintNoticeIds = Array.isArray(job.data.hintNoticeIds)
        ? job.data.hintNoticeIds.map((nid) => Number(nid)).filter(Number.isFinite)
        : [];
    let result;
    try {
        result = await receiptSyncService.syncAllocation(allocationId, {
            hintNoticeIds: hintNoticeIds.length > 0 ? hintNoticeIds : undefined,
        });
    } catch (error) {
        // LỖI NON-RETRYABLE (#21-#23): DataIntegrity/AmbiguousMatch là lỗi dữ
        // liệu vĩnh viễn — retry 5 lần chỉ spam log + giữ queue bận. Chuyển
        // sang UnrecoverableError của BullMQ 6 → job failed NGAY tại attempt
        // hiện tại, không ăn technical attempts. Lỗi hạ tầng (timeout/deadlock/
        // mất kết nối) giữ nguyên propagate → technical retry như cũ.
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
    const durationMs = Date.now() - startedAt;

    logger.info('sync_result', {
        jobId: job.id,
        allocationId,
        poId: result.poId,
        noticeDetailId: result.noticeDetailId,
        goodsNo: result.goodsNo,
        state: result.state,
        differenceQty: result.differenceQty,
        businessAttempt,
        durationMs,
    });

    // Business waiting: DỜI JOB CHÍNH NÓ (moveToDelayed) — không throw để
    // ăn technical attempts, cũng không add job mới (sẽ bị dedup loại).
    if (WAITING_STATES.has(result.state)) {
        const nextAttempt = businessAttempt + 1;
        const delayMs = workerConfig.businessRetryDelayMs(nextAttempt);
        if (delayMs === null) {
            // Hết lịch tiệm tiến (#8): dừng retry, trả result bình thường —
            // sweep cron 5 phút đón allocation vẫn pending (recovery #9).
            result.businessAttempt = nextAttempt - 1;
            result.retryExhausted = true;
            return result;
        }
        // Tăng businessAttempt TRONG job.data để lần chạy kế đọc đúng lịch.
        await job.updateData({ ...job.data, businessAttempt: nextAttempt });
        await job.moveToDelayed(Date.now() + delayMs, token);
        result.businessAttempt = nextAttempt;
        result.retryAfterMs = delayMs;
        // DelayedError = tín hiệu chuẩn BullMQ: "job đã tự dời sang delayed",
        // worker KHÔNG đánh dấu failed / KHÔNG ăn technical attempt.
        throw new DelayedError('receipt_sync_business_retry');
    }

    return result;
}

/**
 * Con trỏ keyset của sweep — GIỮ TRONG PROCESS (module-level): mỗi lượt
 * sweep bắt đầu từ chỗ dừng của lượt trước, hết cửa sổ thì quay lại đầu
 * (wrap-around khi batch < limit). Restart process → quét lại từ đầu —
 * vô hại (enqueue có dedup).
 *
 * TẠI SAO KHÔNG OFFSET (#9): sweep cũ luôn lấy TOP 200 allocation pending
 * ĐẦU TIÊN — nếu 200 dòng đầu chưa có T8 notice mà 201-250 đã có, MỌI lượt
 * sweep đều chỉ xem 1-200, 201-250 BỊ BỎ ĐÓI MÃI. Keyset (allocated_at, id)
 * trượt cửa sổ qua các lượt → cuối cùng mọi pending đều được thăm.
 */
const sweepState = {
    pendingCursor: null,
    revalidationCursor: null,
};

/**
 * Trích cursor từ dòng cuối batch; batch < limit nghĩa là đã quét tới cuối
 * cửa sổ → reset null để lượt sau quét lại từ đầu.
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

function shouldWrapAround(rows, limit) {
    return rows.length < limit;
}

/**
 * PHASE-1 sweep — enqueue allocation pending có T8 dữ liệu.
 * BATCH SET-BASED (#10/#46) — CỐ ĐỊNH 4 câu query cho CẢ LƯỢT, không N+1
 * theo allocation:
 *   (1) findPendingAllocations  — 1 câu WHS (candidate-first, không scan
 *       toàn lịch sử #12; có cursor keyset #9)
 *   (2) findOrder2ByPoIds      — 1 câu T8 theo candidate po_id keys
 *   (3) findNoticesForPoDetails— 1 câu T8 theo relation [R2]
 *   (4) sumReceivedByNoticeIds — 1 câu WHS GROUP BY notice
 * rồi phân loại TRONG MEMORY: chỉ enqueue allocation ACTIONABLE (dòng
 * PO tồn tại + có notice còn số lượng chưa reconcile). Allocation chưa
 * có T8 receipt KHÔNG bị spam job — cursor trượt tiếp, lượt sweep sau
 * quay lại bắt ngay khi T8 có dữ liệu (#29 low-frequency recovery).
 *
 * Backpressure (#28): mỗi lượt cap theo RECEIPT_SYNC_BATCH_SIZE + dedup
 * native BullMQ (1 job in-flight/allocation) → Redis không phình kể cả
 * khi sweep chạy liên tục. Idempotent: chạy lại sweep không tạo duplicate.
 *
 * LƯU Ý: con số remaining khi phân loại là SNAPSHOT (không giữ khóa) —
 * chỉ dùng để quyết định ENQUEUE HAY KHÔNG; tính toán ghi receipt thật
 * luôn do syncAllocation làm lại trong tx sau allocation+notice lock.
 * @param {Array<object>} candidates
 * @returns {Promise<{pending: number, enqueued: number,
 *   skippedNoPo: number, skippedNoNotice: number}>}
 */
async function sweepPending(job, candidates) {
    const result = {
        pending: candidates.length,
        enqueued: 0,
        skippedNoPo: 0,
        skippedNoNotice: 0,
    };
    if (candidates.length === 0) return result;

    // Candidate PO keys — distinct po_id của cả batch.
    const distinctPoIds = [...new Set(candidates.map((c) => Number(c.poId)))];

    const poRows = await PoRepository.findOrder2ByPoIds(distinctPoIds);
    const poMap = new Map(poRows.map((row) => [Number(row.id), row]));
    const foundPoIds = poRows.map((row) => Number(row.id));

    const noticeRows = await PoRepository.findNoticesForPoDetails(foundPoIds);
    const receivedMap = await ReceiptRepository.sumReceivedByNoticeIds(
        noticeRows.map((n) => Number(n.id))
    );

    // Group notice theo PO 1 lần — không query lại từng allocation.
    const noticesByPo = new Map();
    for (const notice of noticeRows) {
        const key = Number(notice.poId);
        noticesByPo.set(key, [...(noticesByPo.get(key) || []), notice]);
    }

    for (const candidate of candidates) {
        if (!poMap.has(Number(candidate.poId))) {
            // PO đã bị xóa/đổi ở T8 giữa chừng — để nguyên, không đoán.
            result.skippedNoPo += 1;
            continue;
        }
        const notices = noticesByPo.get(Number(candidate.poId)) || [];
        const hasRemainingNotice = notices.some(
            (n) =>
                Number(n.sheetQty || 0) - Number(receivedMap.get(Number(n.id)) || 0) > 0
        );
        if (!hasRemainingNotice) {
            // T8 chưa push receipt cho PO này (hoặc đã reconcile hết) — cursor
            // trượt tiếp; chờ lượt sweep sau, KHÔNG spam job WAITING.
            result.skippedNoNotice += 1;
            continue;
        }
        // Dedup native: allocation đã có job in-flight thì add trả về job cũ.
        // HINT (#37): kèm candidate notice IDs của PO này — job tránh re-run
        // full PO/date search, chỉ re-read đúng các ID (kèm keepLastIfActive
        // để update giữa chừng không mất).
        const hintNoticeIds = (noticesByPo.get(Number(candidate.poId)) || []).map(
            (n) => Number(n.id)
        );
        if (
            await enqueueReceiptSync(candidate.allocationId, {
                hintNoticeIds: hintNoticeIds.length > 0 ? hintNoticeIds : undefined,
            })
        ) {
            result.enqueued += 1;
        }
    }
    return result;
}

/**
 * PHASE-2 sweep — REVALIDATE allocation đã sync chống T8 THAY ĐỔI SAU KHI
 * SYNC (#29-#32): notice bị xóa / sheet_qty giảm xuống dưới tổng đã
 * reconcile / made_lot đổi. Batch set-based (3 câu cho cả lượt):
 *   (1) findRevalidationCandidates     — WHS: còn mở + đã có receipt
 *   (2) findNoticesForPoDetails        — T8: notice theo relation của PO
 *   (3) findReceiptsByAllocationIds     — WHS: receipt của cả batch
 *   (4) sumReceivedByNoticeIds          — WHS: tổng received theo notice
 * Rồi gọi collectReconcileIssues (CÙNG pure function với đường sync) —
 * rule revalidation không drift giữa sweep và sync. Lệch → upsert issue
 * (idempotent #36); sạch → dọn issue OPEN cũ của allocation.
 *
 * KHÔNG tự sửa allocated_qty/receipt cũ — chỉ surface issue (#31/#32).
 * @param {Array<object>} candidates dòng findRevalidationCandidates
 * @returns {Promise<{revalidated: number, issues: number}>}
 */
async function sweepRevalidate(candidates) {
    const result = { revalidated: 0, issues: 0 };
    if (candidates.length === 0) return result;

    const distinctPoIds = [...new Set(candidates.map((c) => Number(c.poId)))];
    const noticeRows = await PoRepository.findNoticesForPoDetails(distinctPoIds);
    const noticesById = new Map(noticeRows.map((n) => [Number(n.id), n]));

    const allocationIds = candidates.map((c) => c.allocationId);
    const receiptRows = await ReceiptRepository.findReceiptsByAllocationIds(
        allocationIds
    );
    const receiptsByAllocation = new Map();
    for (const row of receiptRows) {
        const key = String(row.allocationId);
        receiptsByAllocation.set(key, [...(receiptsByAllocation.get(key) || []), row]);
    }

    const noticeIds = [
        ...new Set(receiptRows.map((r) => Number(r.noticeDetailId))),
    ];
    const noticeSums = await ReceiptRepository.sumReceivedByNoticeIds(noticeIds);

    // Allocation sạch gom lại — resolve CẢ BATCH trong 1 UPDATE sau vòng
    // lặp (không gọi resolveOpenIssuesForAllocation từng dòng → N+1 #46).
    const cleanAllocationIds = [];
    for (const candidate of candidates) {
        const receipts = receiptsByAllocation.get(candidate.allocationId) || [];
        if (receipts.length === 0) continue; // không có receipt — bỏ qua (an toàn)
        const issues = receiptSyncService.collectReconcileIssues({
            allocationId: candidate.allocationId,
            poId: Number(candidate.poId),
            goodsNo: candidate.goodsNo,
            slotCode: candidate.slotCode,
            allocatedQty: Number(candidate.allocatedQty || 0),
            receivedTotal: Number(candidate.receivedTotal || 0),
            receipts: receipts.map((r) => ({
                noticeDetailId: Number(r.noticeDetailId),
                lotNo: r.lotNo,
                receivedQty: Number(r.receivedQty || 0),
            })),
            noticesById,
            noticeReceivedSums: noticeSums,
        });
        result.revalidated += 1;
        if (issues.length === 0) {
            // Sạch: gom vào batch — dọn issue OPEN cũ sau vòng lặp (nó sẽ được
            // upsert lại nếu lệch quay lại).
            cleanAllocationIds.push(candidate.allocationId);
            continue;
        }
        for (const issue of issues) {
            await ReconcileIssueRepository.upsertOpenIssue(issue);
            result.issues += 1;
        }
    }
    await ReconcileIssueRepository.resolveOpenIssuesForAllocationIds(
        cleanAllocationIds
    );
    // has_warning mirror (#30) cho batch sạch — 1 câu UPDATE cho N allocation,
    // KHÔNG N+1; IQC FAIL_PENDING được OR giữ nguyên trong SQL.
    await ReceiptSyncRepository.refreshHasWarningMirrorForAllocationIds(
        cleanAllocationIds
    );
    return result;
}

/**
 * Processor job 'sweep' — chạy 2 phase:
 *   PHASE-1 pending: enqueue actionable allocations (cursor keyset #9)
 *   PHASE-2 revalidation: đối chiếu T8 của allocation đã sync (#29-#32)
 * Cursor từng phase độc lập, lưu trong process, wrap-around khi hết
 * cửa sổ → MỌI allocation cuối cùng đều được thăm (test #9: 250 records,
 * batch 200, đủ số lượt → 250/250 visited).
 * @param {import('bullmq').Job} job
 * @returns {Promise<object>}
 */
async function processReceiptSyncSweep(job) {
    const limit = workerConfig.receiptSyncBatchSize;

    const pending = await ReceiptSyncRepository.findPendingAllocations(
        limit,
        sweepState.pendingCursor
    );
    const phase1 = await sweepPending(job, pending);
    sweepState.pendingCursor = shouldWrapAround(pending, limit)
        ? null
        : advanceCursor(pending);

    const revalCandidates = await ReceiptSyncRepository.findRevalidationCandidates(
        limit,
        sweepState.revalidationCursor
    );
    const phase2 = await sweepRevalidate(revalCandidates);
    sweepState.revalidationCursor = shouldWrapAround(revalCandidates, limit)
        ? null
        : advanceCursor(revalCandidates);

    logger.info('sweep_result', {
        jobId: job.id,
        pending: phase1.pending,
        enqueued: phase1.enqueued,
        skippedNoPo: phase1.skippedNoPo,
        skippedNoNotice: phase1.skippedNoNotice,
        pendingCursorActive: sweepState.pendingCursor !== null,
        revalidated: phase2.revalidated,
        revalIssues: phase2.issues,
        revalCursorActive: sweepState.revalidationCursor !== null,
    });
    return {
        pending: phase1.pending,
        enqueued: phase1.enqueued,
        skippedNoPo: phase1.skippedNoPo,
        skippedNoNotice: phase1.skippedNoNotice,
        revalidated: phase2.revalidated,
        revalIssues: phase2.issues,
    };
}

module.exports = { processReceiptSync, processReceiptSyncSweep };
