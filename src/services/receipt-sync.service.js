/**
 * SERVICE SYNC RECEIPT — ReceiptSyncServices (singleton), bảng
 * whs_allocation_receipt. Business logic của Receipt Sync Worker.
 *
 * ĐÚNG MỘT ĐƯỜNG CHẠY (#19 — pseudo flow, đọc từ trên xuống):
 *   nhận allocationId
 *   → load allocation + tổng receipt đã ghi   (FIRST CHECK #20/#21)
 *   → allocation thiếu?          → NO_OP (Undo Assign đã hard-delete —
 *                                không retry, không recreate #13 spec Undo)
 *   → đã đóng / đã nhận đủ?      → NO_OP
 *   → load dòng PO pur_order2                  (#22)
 *   → PO thiếu?                  → DATA_ERROR
 *   → tìm pur_notice2 khớp (relation #4)       → không thấy → WAITING_T8_RECEIPT
 *   → notice còn số lượng chưa reconcile?      → hết → WAITING_T8_RECEIPT
 *   >1 candidate?                → AMBIGUOUS    (không đoán, không ghi)
 *   → made_lot NULL?             → WAITING_LOT  (KHÔNG fallback sheet_lot)
 *   → reconcile quantity         → MATCHED / SHORTAGE / EXCESS
 *
 * Quy tắc business KHÔNG THAY ĐỔI (user chốt):
 * - USER CREATE allocation — SYSTEM chỉ sync/update allocation đã tồn
 *   tại; KHÔNG auto-create allocation, KHÔNG auto chọn kệ.
 * - allocated_qty = số USER đã gán kệ — KHÔNG BAO GIỜ bị ghi đè vì số
 *   lượng T8 khác (#2/#31). PO Qty 29 vs T8 42.2 là HỢP LỆ.
 * - Business lot = pur_notice2.made_lot (#3). sheet_lot KHÔNG dùng.
 * - Relation T8 (#4, PO identity fix 2026-10-29 — dữ liệu thật kiểm chứng):
 *     n2.pur_no = o2.sheet_no AND n2.pur_id = o2.sheet_id
 *     AND n2.goods_no = o2.goods_no AND def02 khớp (NULL-NULL)
 *   pur_id trỏ về SHEET_ID dòng PO — notice của dòng khác (cùng PO +
 *   goods + def02) KHÔNG match; made_lot chỉ lấy từ pur_notice2.made_lot.
 *   (SQL nằm sẵn ở po.repository.findNoticesForPoLine — reuse).
 * - ORPHAN NOTICE (#9, PO identity fix): notice khớp key R2 3 trường cũ
 *   (pur_no + goods_no + def02) nhưng pur_id NULL/không trỏ về dòng nào
 *   của PO → KHÔNG auto-map lot (tránh lấy lot của dòng khác), mở issue
 *   DATA_ERROR (issue_type VARCHAR(20) — không cần DDL) thay vì chờ im
 *   lặng WAITING_T8_RECEIPT.
 * - STALE AMBIGUOUS (#14, PO identity fix): issue AMBIGUOUS OPEN sinh ra
 *   thời fan-out notice của nhiều dòng PO; sau fix candidate thật ≤ 1 →
 *   resolveOpenIssuesByTypeForAllocation(AMBIGUOUS) khi sync/revalidate
 *   chạy lại — multi-delivery cùng MỘT dòng pur_id vẫn là AMBIGUOUS hợp lệ.
 * - Idempotency (#38): UQ (allocation_id, notice_detail_id) — cặp đã tồn
 *   tại thì KHÔNG insert lại; job chạy lại sau crash không duplicate.
 * - MOVE-VS-RECEIPT RACE (#23-#26): receipt tx giành ALLOCATION LOCK trước
 *   notice lock (thứ tự thṑng nhất allocation → notice); moveLot của
 *   lot.service lấy CÙNG allocation lock và tính movableQty =
 *   allocated − SUM(received) FRESH dưới khóa → không thể trừ allocated
 *   xuống dưới received.
 * - REVALIDATION (#29-#32): allocation đã nhận đủ KHÔNG NO_OP mù —
 *   revalidateMappedReceipts đối chiếu receipt đã ghi với T8 hiện tại
 *   (notice còn tồn tại? sheet_qty đổi? made_lot đổi?) và lệch thì PERSIST
 *   sang whs_reconcile_issue (bảng ĐỀ XUẤT DDL — xem
 *   db/migrations/2026-10-26-whs-reconcile-issue.sql, user approve后才建).
 *   sweep phase-2 (receipt-sync.job) chạy check TẬP THỂ cho cả batch bằng
 *   collectReconcileIssues (cùng rule — không drift logic).
 * - CONCURRENCY (#41, sửa 2026-10-26): tính remaining của NOTICE phải nằm
 *   BÊN TRONG transaction, sau khi giành NOTICE-LEVEL LOCK:
 *     pg  : SELECT pg_advisory_xact_lock(<app>, noticeId) — tự release ở
 *           commit/rollback (kể cả crash — session chết là khóa rơi).
 *     mssql: EXEC sp_getapplock @LockOwner='Transaction' — tự release khi
 *           tx end; @LockTimeout 15s, không cấp phát → throw retryable.
 *   2 worker reconcile 2 allocation cùng 1 Notice → tuần tự hóa trên
 *     khóa notice → thằng sau ĐỌC FRESH SUM(received_qty) của notice →
 *     không bao giờ vượt sheet_qty (#43). Lock scope = 1 notice, không
 *     lock bảng. KHÔNG dùng NOLOCK cho dữ liệu quyết định quantity.
 * - EXISTING RECEIPT GROW (#6/#42): user tăng allocated_qty 20 → 30 →
 *   re-sync KHÔNG insert dòng mới mà TĂNG received_qty của receipt đang
 *   có (updateReceipt trong cùng tx, trần theo notice remaining).
 * - Transaction (#31): mọi ghi WHS của 1 lần reconcile nằm trong 1 tx
 *   NGẮN: lock notice → recheck WHS → insert/update receipt → lot cache
 *   + TEMP_IN → commit. KHÔNG giữ tx khi đọc T8 (đọc trước BEGIN).
 * - Lot cache (#37): allocation.lot_no chỉ là mirror hiển thị — đúng 1
 *   distinct lot → lot đó; nhiều lot → NULL (không ghi "MULTI-LOT").
 * - warehouse_status: PO_ASSIGNED → TEMP_IN khi đã có receipt; status
 *   IQC (WAITING_IQC...) KHÔNG đụng — việc của task IQC sau.
 * - T8 READ ONLY — chỉ ghi whs_*.
 * - BẤT BIẾN BẮT BUỘC (#46):
 *     I3: SUM(received theo notice) ≤ notice.sheet_qty (notice lock +
 *         recheck trong tx)
 *     I4: SUM(received theo allocation) ≤ allocation.allocated_qty
 *         (allocation lock + moveLot movableQty + guard SQL)
 * - PERSIST LỆCH (#33-#36): mọi kết quả SHORTAGE / EXCESS / AMBIGUOUS /
 *   T8_CHANGED đều upsertOpenIssue — idempotent theo dedup key
 *   (type|allocationId|noticeDetailId), worker chạy lại 10 lần KHÔNG tạo
 *   10 issue OPEN. MATCHED → resolve issue OPEN của allocation + notice.
 *   Nếu bảng whs_reconcile_issue CHƯA TỒN TẠI (DDL chờ user approve) →
 *   repository log warn 'reconcile_issue_table_missing' và trả null —
 *   core receipt path KHÔNG bị chặn, chỉ mất kênh audit cho tới khi
 *   approve DDL (đã ghi rõ trong migration proposal).
 *
 * Result contract (#42): service luôn trả object có `state` — caller
 * (job processor) đọc state để decide business retry; KHÔNG trả
 * true/false mơ hồ.
 */

'use strict';

const db = require('../config/db');
const { genId } = require('./shared');
/** @type {import('../repository/sql/lot.repository').LotModel} */
const LotRepository = require('../repository/sql/lot.repository');
/** @type {import('../repository/sql/po.repository').PoModel} */
const PoRepository = require('../repository/sql/po.repository');
/** @type {import('../repository/sql/receipt.repository').ReceiptModel} */
const ReceiptRepository = require('../repository/sql/receipt.repository');
/** @type {import('../repository/sql/receipt-sync.repository').ReceiptSyncRepository} */
const ReceiptSyncRepository = require('../repository/sql/receipt-sync.repository');
const ReconcileIssueRepository = require('../repository/sql/reconcile-issue.repository');
const {
    DataIntegrityError,
    RetryableInfrastructureError,
    isUniqueViolation,
} = require('../util/worker/errors');

/** Trạng thái kết quả sync — centralized, không rải string literal (#43). */
const RECEIPT_SYNC_STATES = {
    WAITING_T8_RECEIPT: 'WAITING_T8_RECEIPT',
    WAITING_LOT: 'WAITING_LOT',
    MATCHED: 'MATCHED',
    SHORTAGE: 'SHORTAGE',
    EXCESS: 'EXCESS',
    AMBIGUOUS: 'AMBIGUOUS',
    DATA_ERROR: 'DATA_ERROR',
    NO_OP: 'NO_OP',
};

/** State đã ghi mapping receipt (lot.service dùng cho activity log). */
const RECEIPT_MAPPED_STATES = new Set([
    RECEIPT_SYNC_STATES.MATCHED,
    RECEIPT_SYNC_STATES.SHORTAGE,
    RECEIPT_SYNC_STATES.EXCESS,
]);

/**
 * Làm tròn theo độ chính xác NUMERIC(18,8) của DB — tránh noise dấu
 * chấm động khi so/report differenceQty (#41).
 * @param {number} qty
 * @returns {number}
 */
function roundQty(qty) {
    return Math.round(qty * 1e8) / 1e8;
}

/** Epsilon so sánh số lượng NUMERIC(18,8) — 1e-9 dưới độ chính xác DB. */
const QTY_EPS = 1e-9;

/**
 * Type issue revalidation khi T8 đổi SAU khi sync (spec #34) — khác state
 * sync: T8_CHANGED là issue type, không phải receipt sync result state.
 */
const ISSUE_T8_CHANGED = 'T8_CHANGED';

/**
 * Pure check đối chiếu receipt ĐÃ GHI với T8 HIỆN TẠI — dùng ở 2 nơi:
 *   1. revalidateMappedReceipts (sync allocation đã nhận đủ, #29)
 *   2. sweep phase-2 (batch set-based, receipt-sync.job)
 * để rule không drift giữa 2 đường chạy. KHÔNG sửa gì chỉ phát hiện + trả
 * issue list; persistence do caller (idempotent upsert).
 *
 * Checks (#29-#32):
 *   I4   : SUM(received allocation) > allocated → EXCESS (bug move/…)
 *   miss : notice mapped không còn khớp T8 (xóa hoặc relation đổi) → T8_CHANGED
 *   lot  : made_lot đổi / bị xóa → T8_CHANGED (KHÔNG overwrite lot cũ)
 *   I3   : SUM(received notice trên TOÀN allocation) > sheet_qty mới → EXCESS
 *   growth: T8 TĂNG số lượng sau khi allocation đã nhận đủ → SHORTAGE
 *          notice-level (allocationId NULL) — phần dư chưa gán kệ (#12);
 *          receipt cũ KHÔNG bị ghi đè, không NO_OP mù.
 *
 * @param {{
 *   allocationId: string, poId: number, goodsNo: string,
 *   slotCode: string, allocatedQty: number, receivedTotal: number,
 *   receipts: Array<{ noticeDetailId: number, lotNo: string | null, receivedQty: number }>,
 *   noticesById: Map<number, { id: number, madeLot: string | null, sheetQty: number }>,
 *   noticeReceivedSums: Map<number, number>
 * }} input receipts là receipt CỦA allocation này; noticeReceivedSums là
 *   tổng received của notice trên MỌI allocation (truyền đủ — I3 toàn cục)
 * @returns {Array<{
 *   type: string, allocationId: string | null, poId: number, goodsNo: string,
 *   slotCode: string | null, noticeDetailId: number | null,
 *   differenceQty: number, note: string
 * }>}
 */
function collectReconcileIssues(input) {
    const issues = [];
    const {
        allocationId,
        poId,
        goodsNo,
        slotCode,
        allocatedQty,
        receivedTotal,
        receipts,
        noticesById,
        noticeReceivedSums,
    } = input;

    if (Number(receivedTotal) > Number(allocatedQty) + QTY_EPS) {
        issues.push({
            type: RECEIPT_SYNC_STATES.EXCESS,
            allocationId,
            poId,
            goodsNo,
            slotCode,
            noticeDetailId: null,
            differenceQty: roundQty(Number(receivedTotal) - Number(allocatedQty)),
            note: 'Bất biến I4 bị vi phạm: tổng received_qty vượt allocated_qty — kiểm tra move/giảm allocation',
        });
    }

    for (const receipt of receipts) {
        const notice = noticesById.get(Number(receipt.noticeDetailId));
        if (!notice) {
            issues.push({
                type: ISSUE_T8_CHANGED,
                allocationId,
                poId,
                goodsNo,
                slotCode,
                noticeDetailId: Number(receipt.noticeDetailId),
                differenceQty: Number(receipt.receivedQty),
                note: 'Notice T8 đã biến mất/đổi relation sau khi sync — đối chiếu lại thủ công',
            });
            continue;
        }
        if (receipt.lotNo && notice.madeLot && receipt.lotNo !== notice.madeLot) {
            issues.push({
                type: ISSUE_T8_CHANGED,
                allocationId,
                poId,
                goodsNo,
                slotCode,
                noticeDetailId: Number(receipt.noticeDetailId),
                differenceQty: 0,
                note: `made_lot đổi sau sync: receipt ghi ${receipt.lotNo}, T8 hiện ${notice.madeLot}`,
            });
        } else if (receipt.lotNo && !notice.madeLot) {
            issues.push({
                type: ISSUE_T8_CHANGED,
                allocationId,
                poId,
                goodsNo,
                slotCode,
                noticeDetailId: Number(receipt.noticeDetailId),
                differenceQty: 0,
                note: 'T8 đã xóa made_lot sau khi sync — đối chiếu lại thủ công',
            });
        }
        const noticeReceived = Number(
            noticeReceivedSums.get(Number(receipt.noticeDetailId)) || 0
        );
        if (noticeReceived > Number(notice.sheetQty || 0) + QTY_EPS) {
            issues.push({
                type: RECEIPT_SYNC_STATES.EXCESS,
                allocationId,
                poId,
                goodsNo,
                slotCode,
                noticeDetailId: Number(receipt.noticeDetailId),
                differenceQty: roundQty(
                    noticeReceived - Number(notice.sheetQty || 0)
                ),
                note: 'Bất biến I3 bị vi phạm: T8 giảm sheet_qty xuống dưới tổng đã reconcile — đối chiếu lại',
            });
        }
        // T8 TĂNG số lượng sau khi sync (#12/#50): notice còn dư mà allocation
        // đã nhận đủ (không thể tự absorb) → SHORTAGE notice-level để user
        // gán kệ thêm. Điều kiện receivedTotal >= allocatedQty tránh ồn:
        // allocation còn thiếu thì chính nó là ứng viên consume phần dư này
        // (sweep phase-1 sẽ MATCH) — không cần issue tạm thời.
        const noticeRemainingForGrowth = roundQty(
            Number(notice.sheetQty || 0) - noticeReceived
        );
        if (
            noticeRemainingForGrowth > QTY_EPS &&
            Number(receivedTotal) >= Number(allocatedQty) - QTY_EPS
        ) {
            issues.push({
                type: RECEIPT_SYNC_STATES.SHORTAGE,
                allocationId: null,
                poId,
                goodsNo,
                slotCode: null,
                noticeDetailId: Number(receipt.noticeDetailId),
                differenceQty: noticeRemainingForGrowth,
                note: 'T8 tăng số lượng sau khi sync — phần dư chưa gán kệ (SHORTAGE)',
            });
        }
    }
    return issues;
}

class ReceiptSyncServices {
    /**
     * Sync receipt cho 1 allocation — flow #19, mỗi bước trả result-state.
     * @param {string} allocationId PK whs_slot_allocation
     * @param {{ hintNoticeIds?: number[] }} [options] sweep có sẵn candidate
     *   notice IDs của PO này → job chỉ re-read ĐÚNG các ID đó (relation
     *   validation vẫn chạy đầy đủ trong SQL); hint rỗng/stale → fallback
     *   full PO-line query. Con số quyết định ghi receipt vẫn luôn FRESH
     *   trong tx sau notice lock — hint KHÔNG được dùng làm con số write.
     * @returns {Promise<{
     *   state: string, allocationId: string,
     *   poId?: number, goodsNo?: string, slotCode?: string,
     *   noticeDetailId?: number, lotNo?: string,
     *   allocatedQty?: number, receivedQty?: number, noticeQty?: number,
     *   differenceQty?: number, reason?: string,
     *   candidateNoticeIds?: number[]
     * }>}
     */
    async syncAllocation(allocationId, options = {}) {
        // ---- FIRST CHECK: allocation + tổng received đã ghi (#20/#21) ----
        const allocation = await ReceiptSyncRepository.findAllocationForSync(
            allocationId
        );
        if (!allocation) {
            // UNDO ASSIGN (2026-11-07 #13): allocation có thể đã bị Undo
            // hard-delete. NO_OP — KHÔNG retry, KHÔNG recreate allocation;
            // job vẫn hoàn tất bình thường để không kẹt queue.
            return {
                state: RECEIPT_SYNC_STATES.NO_OP,
                allocationId,
                reason: 'allocation_not_found',
            };
        }
        if (allocation.closedAt) {
            return {
                state: RECEIPT_SYNC_STATES.NO_OP,
                allocationId,
                reason: 'allocation_closed',
            };
        }
        if (allocation.receivedTotal >= allocation.allocatedQty) {
            // Đã nhận đủ — KHÔNG NO_OP mù (#29): T8 có thể đã đổi/sửa/xóa
            // notice SAU khi sync. Revalidate mapped receipts; lệch thì persist
            // issue — KHÔNG tự sửa allocated_qty của user.
            return await this.revalidateMappedReceipts(allocation);
        }

        // ---- Load dòng PO detail pur_order2 theo allocation.po_id (#22) ----
        const poLine = await PoRepository.findOrder2ByPoId(allocation.poId);
        if (!poLine) {
            // PO detail biến mất ở T8 giữa chừng — persist issue để user thấy
            // (bảng reconcile issue còn thiếu thì log warn, không chặn sync).
            await ReconcileIssueRepository.upsertOpenIssue({
                type: ISSUE_T8_CHANGED,
                allocationId,
                poId: allocation.poId,
                goodsNo: allocation.goodsNo,
                slotCode: allocation.slotCode,
                noticeDetailId: null,
                differenceQty: 0,
                note: 'Dòng PO pur_order2 không còn ở T8 (đã xóa/đổi) — đối chiếu lại',
            });
            // has_warning mirror (#30): issue OPEN vừa upsert → allocation phải
            // mang warning để UI nhìn thấy (giữ IQC FAIL nếu có).
            await ReceiptSyncRepository.refreshHasWarningMirror(allocationId, true);
            return {
                state: RECEIPT_SYNC_STATES.DATA_ERROR,
                allocationId,
                poId: allocation.poId,
                goodsNo: allocation.goodsNo,
                reason: 'po_line_not_found',
            };
        }

        // ---- Tìm Temporary Receipt khớp (relation #4 — SQL có sẵn po.repo) ----
        // HINT (#37): nếu sweep đã có candidate notice IDs (payload job), chỉ
        // re-read đúng các ID đó — tránh re-run full PO/date search mỗi job;
        // hint không còn dòng nào khớp relation → fallback full query. Hint
        // KHÔNG quyết định ghi — con số FRESH tính trong tx sau notice lock.
        const hintNoticeIds = Array.isArray(options.hintNoticeIds)
            ? options.hintNoticeIds
            : null;
        let notices = [];
        if (hintNoticeIds && hintNoticeIds.length > 0) {
            notices = await PoRepository.findNoticesForPoLine(
                allocation.poId,
                hintNoticeIds
            );
        }
        if (notices.length === 0) {
            notices = await PoRepository.findNoticesForPoLine(allocation.poId);
        }
        if (notices.length === 0) {
            // PO identity fix #9: có thể tồn tại notice khớp key R2 3 trường cũ
            // (pur_no + goods_no + def02) nhưng pur_id NULL/không trỏ về dòng
            // PO nào — dữ liệu legacy. KHÔNG auto-map lot của dòng khác; mở issue
            // DATA_ERROR để user sửa pur_id ở T8 thay vì chờ im lặng.
            const orphans = await PoRepository.findOrphanNoticesForPoLine(
                allocation.poId
            );
            // Không còn candidate nào → issue AMBIGUOUS OPEN cũ cũng hết hiệu lực
            // (stale do fan-out thời cũ) — dọn trước khi return.
            await this.resolveStaleAmbiguous(allocationId);
            if (orphans.length > 0) {
                const orphanIds = orphans.map((n) => Number(n.id)).join(', ');
                await ReconcileIssueRepository.upsertOpenIssue({
                    type: RECEIPT_SYNC_STATES.DATA_ERROR,
                    allocationId,
                    poId: allocation.poId,
                    goodsNo: allocation.goodsNo,
                    slotCode: allocation.slotCode,
                    noticeDetailId: null,
                    differenceQty: 0,
                    note: `Tạm nhập khớp PO nhưng pur_id không hợp lệ (notice: ${orphanIds}) — không tự gán lot để tránh wrong-lot mapping, cần sửa pur_id về sheet_id của đúng dòng PO`,
                });
                await ReceiptSyncRepository.refreshHasWarningMirror(allocationId, true);
                return {
                    state: RECEIPT_SYNC_STATES.DATA_ERROR,
                    allocationId,
                    poId: allocation.poId,
                    goodsNo: allocation.goodsNo,
                    reason: 'notice_pur_id_invalid',
                    candidateNoticeIds: orphans.map((n) => Number(n.id)),
                };
            }
            return {
                state: RECEIPT_SYNC_STATES.WAITING_T8_RECEIPT,
                allocationId,
                poId: allocation.poId,
                goodsNo: allocation.goodsNo,
            };
        }

        // Candidate = notice còn số lượng chưa reconcile (đã trừ phần các
        // allocation khác đã nhận). SUM chạy trên bảng WHS receipt (nhỏ) —
        // BATCH 1 câu cho mọi notice của PO line (#10, không N+1).
        // LƯU Ý: con số này CHỈ dùng chọn candidate/made_lot/ambiguous;
        // con số QUYẾT ĐỊNH ghi receipt được tính LẠI trong tx sau khi
        // giành notice lock (#41) — không tin stale value.
        const noticeReceivedMap = await ReceiptRepository.sumReceivedByNoticeIds(
            notices.map((n) => Number(n.id))
        );
        const candidates = [];
        for (const notice of notices) {
            const remainingNoticeQty = roundQty(
                Number(notice.sheetQty || 0) -
                Number(noticeReceivedMap.get(Number(notice.id)) || 0)
            );
            if (remainingNoticeQty > 0) {
                candidates.push({ notice, remainingNoticeQty });
            }
        }

        if (candidates.length === 0) {
            // T8 có notice nhưng toàn bộ số lượng đã được reconcile — allocation
            // này chờ lô hàng mới (multi-delivery #36) hoặc dữ liệu lệch.
            // Không còn candidate → issue AMBIGUOUS OPEN cũ là stale (#14).
            await this.resolveStaleAmbiguous(allocationId);
            return {
                state: RECEIPT_SYNC_STATES.WAITING_T8_RECEIPT,
                allocationId,
                poId: allocation.poId,
                goodsNo: allocation.goodsNo,
            };
        }

        if (candidates.length > 1) {
            // Nhiều candidate mà chưa có rule chọn chính xác — KHÔNG đoán:
            // không notices[0], không FIFO, không chia đều (#30). Sau PO identity
            // fix, >1 candidate chỉ còn xảy ra khi multi-delivery THẬT (nhiều đợt
            // tạm nhập cùng MỘT dòng PO pur_id) — vẫn là warning hợp lệ. Persist
            // issue AMBIGUOUS để user quyết — không technical retry spam.
            const candidateNoticeIds = candidates.map((c) => c.notice.id);
            await ReconcileIssueRepository.upsertOpenIssue({
                type: RECEIPT_SYNC_STATES.AMBIGUOUS,
                allocationId,
                poId: allocation.poId,
                goodsNo: allocation.goodsNo,
                slotCode: allocation.slotCode,
                noticeDetailId: null,
                differenceQty: 0,
                note: `Nhiều đợt tạm nhập cùng dòng PO (candidates: ${candidateNoticeIds.join(', ')}) — chưa có key xác định đợt nào thuộc kệ, không tự gán lot`,
            });
            // has_warning mirror (#30) — AMBIGUOUS OPEN phải hiện warning.
            await ReceiptSyncRepository.refreshHasWarningMirror(allocationId, true);
            return {
                state: RECEIPT_SYNC_STATES.AMBIGUOUS,
                allocationId,
                poId: allocation.poId,
                goodsNo: allocation.goodsNo,
                candidateNoticeIds,
            };
        }

        const { notice, remainingNoticeQty } = candidates[0];
        // Chỉ còn 1 candidate → issue AMBIGUOUS OPEN cũ (fan-out PO line thời
        // cũ) là stale — resolve ngay (#14), kể cả khi lần reconcile này chỉ
        // nhận một phần (full-receipt resolve trong tx dưới vẫn giữ nguyên).
        await this.resolveStaleAmbiguous(allocationId);
        if (!notice.madeLot) {
            // Notice đã có nhưng T8 chưa điền made_lot — chờ, KHÔNG fallback
            // sang sheet_lot (#29/#3).
            return {
                state: RECEIPT_SYNC_STATES.WAITING_LOT,
                allocationId,
                poId: allocation.poId,
                goodsNo: allocation.goodsNo,
                noticeDetailId: notice.id,
            };
        }

        // ---- Reconcile trong 1 transaction NGẮN (#31-#39) ----
        const nowIso = new Date().toISOString();
        const txResult = await db.withTransaction(async (txQuery) => {
            // (0) ALLOCATION LOCK TRƯỚC TIÊN (#24 — Move-vs-Receipt race):
            // thứ tự khóa thṑng nhất allocation → notice; moveLot lấy cùng khóa
            // allocation này nên move-vs-receipt tuần tự hóa, không chờ vòng.
            await ReceiptSyncRepository.acquireAllocationLock(allocationId, txQuery);

            // (1) NOTICE LOCK — mọi worker chạm cùng notice xếp hàng ở đây (#41)
            // trước khi đọc bất kỳ con số nào của WHS receipt.
            await ReceiptSyncRepository.acquireNoticeLock(notice.id, txQuery);

            // (2) Recheck trạng thái allocation bên trong tx (race với
            // move/close/IQC) — đọc FRESH, không dùng giá trị trước BEGIN.
            const fresh = await ReceiptSyncRepository.findAllocationForSync(
                allocationId,
                txQuery
            );
            if (!fresh) {
                throw new DataIntegrityError(
                    `Allocation ${allocationId} biến mất giữa chừng sync`
                );
            }
            if (fresh.closedAt) {
                return {
                    state: RECEIPT_SYNC_STATES.NO_OP,
                    reason: 'allocation_closed_during_sync',
                };
            }
            if (fresh.receivedTotal >= fresh.allocatedQty) {
                return {
                    state: RECEIPT_SYNC_STATES.NO_OP,
                    reason: 'already_received_during_sync',
                };
            }

            // (3) TÍNH LẠI remaining của notice SAU khi giữ khóa — đây là con số
            // quyết định trần ghi receipt; giá trị ngoài tx chỉ để chọn candidate.
            const noticeReceivedNow = await ReceiptRepository.sumReceivedByNotice(
                notice.id,
                txQuery
            );
            const noticeRemainingNow = roundQty(
                Number(notice.sheetQty || 0) - noticeReceivedNow
            );
            if (noticeRemainingNow <= 0) {
                // Vừa có worker khác lấy hết phần dư của notice này giữa lúc mình
                // chờ khóa → allocation này chờ lô/notice kế tiếp (multi-delivery).
                return {
                    state: RECEIPT_SYNC_STATES.WAITING_T8_RECEIPT,
                    reason: 'notice_exhausted_during_sync',
                };
            }

            // (4) Idempotency (#38): cặp (allocation, notice) đã có → không insert
            // dòng mới mà GROW received_qty của receipt đang có (#6/#42).
            const existing = await ReceiptRepository.findByAllocationAndNotice(
                allocationId,
                notice.id,
                txQuery
            );

            // Số lượng reconcile = phần allocation còn thiếu, trần theo phần
            // notice còn dư (FRESH) — KHÔNG đụng allocated_qty (#31).
            const remainingToReceive = roundQty(
                fresh.allocatedQty - fresh.receivedTotal
            );
            const qtyToReceive = roundQty(
                Math.min(remainingToReceive, noticeRemainingNow)
            );

            if (!existing) {
                try {
                    await ReceiptRepository.insertReceipt(
                        {
                            id: genId('rcp'),
                            allocation_id: allocationId,
                            notice_detail_id: notice.id,
                            received_qty: qtyToReceive,
                            lot_no: notice.madeLot,
                            confirmed_at: nowIso,
                            updated_at: nowIso,
                        },
                        txQuery
                    );
                } catch (error) {
                    // Với notice lock đang giữ, UQ chỉ còn xảy ra khi 2 job CÙNG
                    // allocation lọt qua dedup (hiếm) — rollback + technical retry,
                    // lần sau.findByAllocationAndNotice sẽ thấy receipt có sẵn và
                    // đi nhánh grow đúng.
                    if (!isUniqueViolation(error)) throw error;
                    throw new RetryableInfrastructureError(
                        'Receipt bản song song vừa insert — retry sẽ grow đúng'
                    );
                }
            } else {
                // EXISTING RECEIPT GROW: 20 → 30 sau khi user tăng allocated_qty —
                // cùng 1 dòng receipt, KHÔNG dòng thứ hai (#6/#42).
                const grownQty = roundQty(
                    Number(existing.receivedQty || 0) + qtyToReceive
                );
                if (grownQty > Number(notice.sheetQty || 0) + 1e-9) {
                    // Bất biến cuối cùng — không bao giờ được chạm tới với lock giữ.
                    throw new DataIntegrityError(
                        `Grow receipt ${existing.id} sẽ vượt sheet_qty của notice ${notice.id}`
                    );
                }
                await ReceiptRepository.updateReceipt(
                    existing.id,
                    { received_qty: grownQty, updated_at: nowIso },
                    txQuery
                );
            }
            const receivedQtyAfter = roundQty(fresh.receivedTotal + qtyToReceive);

            // Allocation đã có receipt nhận hàng → TEMP_IN (status IQC giữ
            // nguyên — WAITING_IQC cho đến task IQC, #40). LIGHT UPDATE (#4/#27):
            // trong tx CHỈ WHS write, không refetch display JOIN T8.
            await LotRepository.updateAllocationLight(
                allocationId,
                { warehouse_status: 'TEMP_IN' },
                txQuery
            );
            // Mirror lot_no: 1 distinct lot → lot; nhiều lot → NULL (#37).
            await this.refreshLotMirror(allocationId, txQuery);

            // Trạng thái chênh lệch: so PHẦN CHƯA RECONCILE hai bên sau lần
            // chạy này. allocationRemaining = kệ đã gán nhưng T8 chưa cover;
            // noticeRemaining = T8 có nhưng chưa gán kệ nào (#33/#34).
            const allocationRemaining = roundQty(
                fresh.allocatedQty - receivedQtyAfter
            );
            const noticeRemaining = roundQty(noticeRemainingNow - qtyToReceive);

            let state = RECEIPT_SYNC_STATES.MATCHED;
            let differenceQty = 0;
            if (noticeRemaining > 0) {
                state = RECEIPT_SYNC_STATES.SHORTAGE;
                differenceQty = noticeRemaining;
            } else if (allocationRemaining > 0) {
                state = RECEIPT_SYNC_STATES.EXCESS;
                differenceQty = allocationRemaining;
            }

            // ---- PERSIST LỆCH RECONCILE (#33-#36) — cùng tx, idempotent theo
            // dedup key; worker chạy lại 10 lần không nhân 10 issue OPEN.
            // SHORTAGE = T8 có dư chưa gán kệ (notice-level, allocation NULL);
            // EXCESS = kệ gán vượt T8 nhận (allocation-level). MATCHED dọn OPEN.
            if (noticeRemaining > 0) {
                await ReconcileIssueRepository.upsertOpenIssue({
                    type: RECEIPT_SYNC_STATES.SHORTAGE,
                    allocationId: null,
                    poId: allocation.poId,
                    goodsNo: allocation.goodsNo,
                    slotCode: null,
                    noticeDetailId: notice.id,
                    differenceQty: noticeRemaining,
                    note: 'T8 còn số lượng chưa gán kệ — user gán thêm (SHORTAGE)',
                }, txQuery);
            }
            if (allocationRemaining > 0) {
                await ReconcileIssueRepository.upsertOpenIssue({
                    type: RECEIPT_SYNC_STATES.EXCESS,
                    allocationId,
                    poId: allocation.poId,
                    goodsNo: allocation.goodsNo,
                    slotCode: allocation.slotCode,
                    noticeDetailId: notice.id,
                    differenceQty: allocationRemaining,
                    note: 'Kệ đã gán vượt T8 nhận — chờ T8 push thêm hoặc user giảm/move (EXCESS)',
                }, txQuery);
            }
            if (allocationRemaining <= QTY_EPS) {
                // Allocation đã nhận đủ → EXCESS (mọi notice của allocation) và
                // AMBIGUOUS hết hiệu lực. Resolve THEO (allocation, type) — KHÔNG
                // blanket-resolve (#29): T8_CHANGED của notice khác phải giữ OPEN
                // để user đối chiếu, SHORTAGE notice-level không thuộc allocation.
                await ReconcileIssueRepository.resolveOpenIssuesByTypeForAllocation(
                    RECEIPT_SYNC_STATES.EXCESS,
                    allocationId,
                    txQuery
                );
                await ReconcileIssueRepository.resolveOpenIssuesByTypeForAllocation(
                    RECEIPT_SYNC_STATES.AMBIGUOUS,
                    allocationId,
                    txQuery
                );
            }
            if (noticeRemaining <= QTY_EPS) {
                // Notice đã được reconcile hết → issue SHORTAGE notice-level OPEN
                // của notice này cũng đã xử lý xong.
                await ReconcileIssueRepository.resolveOpenIssuesForNotice(
                    notice.id,
                    txQuery
                );
            }

            // ---- has_warning MIRROR (#30): recompute từ issue OPEN của
            // allocation sau mọi upsert/resolve trong tx — KHÔNG blanket clear
            // khi còn issue OPEN khác (T8_CHANGED). Giữ nguyên warning IQC FAIL
            // (SQL bên trong OR thêm iqc_decision='FAIL_PENDING').
            const hasOpenIssue =
                await ReconcileIssueRepository.hasOpenIssueForAllocation(
                    allocationId,
                    txQuery
                );
            await ReceiptSyncRepository.refreshHasWarningMirror(
                allocationId,
                hasOpenIssue,
                txQuery
            );

            return {
                state,
                differenceQty,
                allocatedQty: fresh.allocatedQty,
                receivedQty: receivedQtyAfter,
            };
        });

        if (txResult.state === RECEIPT_SYNC_STATES.WAITING_T8_RECEIPT) {
            return {
                state: RECEIPT_SYNC_STATES.WAITING_T8_RECEIPT,
                allocationId,
                poId: allocation.poId,
                goodsNo: allocation.goodsNo,
                reason: txResult.reason,
            };
        }

        if (txResult.state === RECEIPT_SYNC_STATES.NO_OP) {
            return {
                state: RECEIPT_SYNC_STATES.NO_OP,
                allocationId,
                reason: txResult.reason,
            };
        }

        return {
            state: txResult.state,
            allocationId,
            poId: allocation.poId,
            goodsNo: allocation.goodsNo,
            slotCode: allocation.slotCode,
            noticeDetailId: notice.id,
            lotNo: notice.madeLot,
            allocatedQty: txResult.allocatedQty,
            receivedQty: txResult.receivedQty,
            noticeQty: Number(notice.sheetQty || 0),
            differenceQty: txResult.differenceQty,
        };
    }

    /**
     * PO identity fix 2026-10-29 (#14): resolve issue AMBIGUOUS OPEN của
     * allocation khi candidate thật hiện tại ≤ 1 (issue cũ sinh ra do
     * fan-out notice của nhiều dòng PO thời matching 3 trường). Idempotent —
     * resolve khi không còn dòng OPEN nào là no-op; candidate > 1 thì caller
     * KHÔNG gọi method này. Sau resolve, recompute has_warning (giữ IQC FAIL
     * và các issue OPEN khác của allocation).
     * @param {string} allocationId
     */
    async resolveStaleAmbiguous(allocationId) {
        await ReconcileIssueRepository.resolveOpenIssuesByTypeForAllocation(
            RECEIPT_SYNC_STATES.AMBIGUOUS,
            allocationId
        );
        const hasOpenIssue =
            await ReconcileIssueRepository.hasOpenIssueForAllocation(allocationId);
        await ReceiptSyncRepository.refreshHasWarningMirror(
            allocationId,
            hasOpenIssue
        );
    }

    /**
     * Revalidate allocation ĐÃ NHẬN ĐỦ (#29-#32): đối chiếu receipt đã ghi
     * với T8 hiện tại — notice biến mất / sheet_qty giảm / made_lot đổi →
     * persist issue T8_CHANGED/EXCESS (idempotent). Không lệch → dọn issue
     * OPEN cũ của allocation. KHÔNG tự sửa allocated_qty hay receipt cũ —
     * chỉ surface. Gọi khi FIRST CHECK cho ra already_received (đường sync)
     * và tương đương logic sweep phase-2 (batch).
     * @param {{
     *   allocationId: string, poId: number, goodsNo: string,
     *   slotCode: string, allocatedQty: number, receivedTotal: number
     * }} allocation kết quả findAllocationForSync
     * @returns {Promise<object>} result NO_OP kèm `issues` (rỗng nếu sạch)
     */
    async revalidateMappedReceipts(allocation) {
        const receipts = await ReceiptRepository.findByAllocationId(
            allocation.allocationId
        );
        if (receipts.length === 0) {
            return {
                state: RECEIPT_SYNC_STATES.NO_OP,
                allocationId: allocation.allocationId,
                reason: 'already_received',
                issues: [],
            };
        }
        const notices = await PoRepository.findNoticesForPoLine(allocation.poId);
        const noticesById = new Map(notices.map((n) => [Number(n.id), n]));
        const noticeIds = [
            ...new Set(receipts.map((r) => Number(r.noticeDetailId))),
        ];
        const noticeSums = await ReceiptRepository.sumReceivedByNoticeIds(noticeIds);

        const issues = collectReconcileIssues({
            allocationId: allocation.allocationId,
            poId: allocation.poId,
            goodsNo: allocation.goodsNo,
            slotCode: allocation.slotCode,
            allocatedQty: allocation.allocatedQty,
            receivedTotal: allocation.receivedTotal,
            receipts: receipts.map((r) => ({
                noticeDetailId: Number(r.noticeDetailId),
                lotNo: r.lotNo,
                receivedQty: Number(r.receivedQty),
            })),
            noticesById,
            noticeReceivedSums: noticeSums,
        });

        // PO identity fix #14: AMBIGUOUS OPEN của allocation có thể là stale
        // (fan-out thời cũ). Candidate hiện tại ≤ 1 → resolve theo type; còn
        // >1 (multi-delivery thật) thì giữ nguyên cho user quyết.
        const candidateCount = notices.filter((n) => {
            const remaining = roundQty(
                Number(n.sheetQty || 0) -
                Number(noticeSums.get(Number(n.id)) || 0)
            );
            return remaining > 0;
        }).length;
        if (candidateCount <= 1) {
            await ReconcileIssueRepository.resolveOpenIssuesByTypeForAllocation(
                RECEIPT_SYNC_STATES.AMBIGUOUS,
                allocation.allocationId
            );
        }

        if (issues.length === 0) {
            // DỌN SẠCH + RECOMPUTE has_warning (#30): T8 và receipt khớp hoàn toàn
            // → mọi issue OPEN của allocation (kể cả T8_CHANGED cũ) là lịch sử;
            // has_warning recompute về 0 (giữ IQC FAIL nếu có).
            await ReconcileIssueRepository.resolveOpenIssuesForAllocation(
                allocation.allocationId
            );
            await ReceiptSyncRepository.refreshHasWarningMirror(
                allocation.allocationId,
                false
            );
            return {
                state: RECEIPT_SYNC_STATES.NO_OP,
                allocationId: allocation.allocationId,
                reason: 'already_received',
                issues: [],
            };
        }
        for (const issue of issues) {
            await ReconcileIssueRepository.upsertOpenIssue(issue);
        }
        // Recompute has_warning sau khi upsert — vẫn giữ OPEN issues cũ của
        // allocation chưa được resolve (T8_CHANGED/AMBIGUOUS) và IQC FAIL.
        const revalidatedHasOpenIssue =
            await ReconcileIssueRepository.hasOpenIssueForAllocation(
                allocation.allocationId
            );
        if (revalidatedHasOpenIssue) {
            await ReceiptSyncRepository.refreshHasWarningMirror(
                allocation.allocationId,
                true
            );
        }
        return {
            state: RECEIPT_SYNC_STATES.NO_OP,
            allocationId: allocation.allocationId,
            reason: 'already_received',
            issues: issues.map((i) => ({
                type: i.type,
                noticeDetailId: i.noticeDetailId,
                differenceQty: i.differenceQty,
                note: i.note,
            })),
        };
    }

    /**
     * Tính lại allocation.lot_no (mirror hiển thị) từ receipt: đúng 1
     * distinct lot → lot đó; 0 hoặc nhiều lot → NULL. KHÔNG concatenate,
     * KHÔNG chọn ngẫu nhiên (#37).
     * @param {string} allocationId
     * @param {Function} [query] bộ query — mặc định db.query; truyền txQuery
     *   để chạy trong cùng transaction
     * @returns {Promise<string | null>} lot sau khi mirror
     */
    async refreshLotMirror(allocationId, query = db.query) {
        const receipts = await ReceiptRepository.findByAllocationId(
            allocationId,
            query
        );
        const distinctLots = [
            ...new Set(receipts.map((r) => r.lotNo).filter((l) => Boolean(l))),
        ];
        const lotNo = distinctLots.length === 1 ? distinctLots[0] : null;
        // LIGHT UPDATE (#4/#27): WHS-only, không refetch display JOIN T8 —
        // refreshLotMirror chạy trong receipt tx nên phải nhẹ.
        await LotRepository.updateAllocationLight(
            allocationId,
            { lot_no: lotNo },
            query
        );
        return lotNo;
    }
}

module.exports = new ReceiptSyncServices();
module.exports.RECEIPT_SYNC_STATES = RECEIPT_SYNC_STATES;
module.exports.RECEIPT_MAPPED_STATES = RECEIPT_MAPPED_STATES;
module.exports.collectReconcileIssues = collectReconcileIssues;
module.exports.QTY_EPS = QTY_EPS;
