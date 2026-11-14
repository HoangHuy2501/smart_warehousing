/**
 * SERVICE IQC SYNC — IqcSyncServices (singleton). Business logic của IQC
 * Worker: map kết quả IQC từ T8 (READ ONLY) xuống whs_allocation_receipt
 * rồi tổng hợp lên whs_slot_allocation.
 *
 * ĐÚNG MỘT ĐƯỜNG CHẠY (đọc từ trên xuống):
 *   nhận allocationId (từ queue/sweep)
 *   → load allocation            → thiếu / đã đóng / ngoài trạng thái theo dõi IQC → NO_OP
 *   → load receipt mapping       → chưa có receipt / receipt chưa có lot → WAITING_IQC
 *   → load notice identity (pur_notice2)  → thiếu → DATA_ERROR
 *   → load IQC rows (v_pur_notice_detail) theo ĐỦ 6 khóa identity
 *   → mapIqcDecision + classifyQuantity từng receipt
 *   → transaction: lock allocation → recheck → ghi receipt → tổng hợp allocation
 *
 * QUY TẮC BUSINESS (user chốt — không tự suy diễn):
 * - Mapping T8: adj_result 0 → WAITING, 1 → PASS, 3 → EXEMPT,
 *   2 + pro_result 2 → FAIL_ACCEPT, 2 + pro_result 0 → FAIL_RETURN.
 *   Ngoài rule (adj khác, 2 nhưng pro khác 0/2) → KHÔNG đoán: giữ
 *   WAITING_IQC + has_warning + log. Không dùng AOD/AOD_PENDING.
 * - Match IQC: receipt.notice_detail_id → pur_notice2 identity (sheet_no,
 *   sheet_id, pur_no, pur_id, goods_no, made_lot) → query view theo ĐỦ 6
 *   khóa. 0 dòng → WAITING_IQC; >1 dòng → warning, KHÔNG TOP 1, KHÔNG
 *   fallback goods_no + lot hay pur_no + goods_no.
 * - FAIL_RETURN trả toàn bộ, FAIL_ACCEPT và EXEMPT nhận toàn bộ.
 *   Chỉ PASS phân loại số lượng nhận/trả theo return_qty.
 * - Quantity KHÔNG double-count: một notice có thể chia nhiều allocation.
 *   KHÔNG phụ thuộc GRN in_qty — IQC chạy TRƯỚC GRN, in_qty chỉ phản ánh
 *   đơn nhập kho đã ghi:
 *     full accept (return_qty = 0)
 *       → mỗi receipt: qty_in_stock = received_qty, qty_return = 0
 *     full return (return_qty = sheet_qty)
 *       → mỗi receipt: qty_in_stock = 0, qty_return = received_qty
 *     partial: CHỈ nhận số tuyệt đối khi notice thuộc đúng 1 allocation
 *       và receipt.received_qty = sheet_qty → qty_in_stock =
 *       sheet_qty - return_qty, qty_return = return_qty.
 *       Partial + multi-allocation → KHÔNG chia tỷ lệ/FIFO/LIFO → giữ
 *       trạng thái hiện tại + has_warning (state PARTIAL_AMBIGUOUS).
 * - Receipt chỉ ghi: iqc_decision, qty_in_stock, qty_return, qc_date,
 *   has_warning, updated_at. KHÔNG ghi qty_aod.
 * - Allocation tổng hợp từ receipt: SUM(qty_in_stock) / SUM(qty_return);
 *   còn receipt NULL/WAITING → WAITING_IQC + TEMP_IN; tất cả terminal và
 *   SUM(qty_in_stock) > 0 → WAITING_STOCK + TEMP_IN; SUM = 0 và
 *   SUM(qty_return) > 0 → RETURNED + RETURN. IQC Worker KHÔNG BAO GIỜ set
 *   IN_STOCK (chỉ khi có đơn nhập kho thật được duyệt).
 * - allocation.iqc_decision: mọi receipt cùng decision → mirror; khác
 *   nhau → 'MIXED' (không nối chuỗi). last_iqc_at = MAX(receipt.qc_date).
 * - Transaction/khóa: đọc T8 standalone READ ONLY; mọi ghi WHS trong 1 tx
 *   ngắn, giành ALLOCATION lock TRƯỚC (cùng thứ tự Receipt Sync / Undo —
 *   allocation → receipt) rồi recheck closed_at / status. Undo hoặc trạng
 *   thái đã tiến → NO_OP, KHÔNG rollback trạng thái mới, KHÔNG recreate.
 * - Idempotent: patch giá trị tuyệt đối (không cộng dồn) → chạy lại cùng
 *   dữ liệu không double qty, không tạo dòng mới.
 */

'use strict';

const { previousMonthCutoff } = require('../util/month-cutoff');
const db = require('../config/db');
/** @type {import('../repository/sql/iqc-sync.repository').IqcSyncRepository} */
const IqcSyncRepository = require('../repository/sql/iqc-sync.repository');
/** @type {import('../repository/sql/receipt.repository').ReceiptModel} */
const ReceiptRepository = require('../repository/sql/receipt.repository');
/** @type {import('../repository/sql/receipt-sync.repository').ReceiptSyncRepository} */
const ReceiptSyncRepository = require('../repository/sql/receipt-sync.repository');
const { createWorkerLogger } = require('../util/worker/logger');

const logger = createWorkerLogger('iqc-sync-service');

/** State kết quả của 1 lần sync — job processor đọc để quyết định retry. */
const IQC_SYNC_STATES = {
    NO_OP: 'NO_OP',
    WAITING_IQC: 'WAITING_IQC',
    MATCHED: 'MATCHED',
    RETURNED: 'RETURNED',
    PARTIAL_AMBIGUOUS: 'PARTIAL_AMBIGUOUS',
    DATA_ERROR: 'DATA_ERROR',
};

const IQC_DECISIONS = {
    WAITING: 'WAITING',
    PASS: 'PASS',
    EXEMPT: 'EXEMPT',
    FAIL_ACCEPT: 'FAIL_ACCEPT',
    FAIL_RETURN: 'FAIL_RETURN',
};

const ALLOCATION_STATUS = {
    WAITING_IQC: 'WAITING_IQC',
    WAITING_STOCK: 'WAITING_STOCK',
    RETURNED: 'RETURNED',
};

const WAREHOUSE_STATUS = {
    TEMP_IN: 'TEMP_IN',
    IN_STOCK: 'IN_STOCK',
    RETURNED: 'RETURNED',
};

/** Mã T8 (CHAR(1) trong DB thật, có thể numeric trong fixture test). */
const ADJ_RESULT = {
    WAITING: '0',
    PASS: '1',
    FAIL: '2',
    EXEMPT: '3',
};
const PRO_RESULT = {
    RETURN: '0',
    SPECIALLY_PROCURED: '2',
};

/** Hình thái số lượng của 1 notice. */
const QUANTITY_SHAPE = {
    FULL_ACCEPT: 'FULL_ACCEPT',
    FULL_RETURN: 'FULL_RETURN',
    PARTIAL: 'PARTIAL',
};

/** Chuẩn hóa mã T8 về string trim (DB thật trả CHAR, fixture có thể number). */
function normalizeCode(value) {
    return value === null || value === undefined ? '' : String(value).trim();
}

/** Receipt đã có lot thật để match IQC chưa? */
function hasLot(lotNo) {
    return typeof lotNo === 'string' && lotNo.trim() !== '';
}

/**
 * Khóa identity của 1 notice / 1 IQC row — dùng chung cho cả 2 phía để
 * group trong service (SQL đã match theo cùng 6 khóa).
 * @param {{ sheetNo: unknown, sheetId: unknown, purNo: unknown,
 *   purId: unknown, goodsNo: unknown, madeLot: unknown }} row
 * @returns {string}
 */
function buildIdentityKey(row) {
    const text = (value) => String(value === null || value === undefined ? '' : value).trim().toUpperCase();
    return [
        text(row.sheetNo),
        text(row.sheetId),
        text(row.purNo),
        text(row.purId),
        text(row.goodsNo),
        text(row.madeLot),
    ].join('|');
}

/**
 * Identity của notice có ĐỦ 6 khóa để query IQC không? Thiếu made_lot
 * (hoặc khóa khác) thì không có cách match an toàn → chờ.
 */
function hasCompleteIdentity(notice) {
    return (
        String(notice.sheetNo || '').trim() !== '' &&
        notice.sheetId !== null &&
        notice.sheetId !== undefined &&
        String(notice.purNo || '').trim() !== '' &&
        notice.purId !== null &&
        notice.purId !== undefined &&
        String(notice.goodsNo || '').trim() !== '' &&
        hasLot(notice.madeLot)
    );
}

/**
 * Map mã T8 sang IQC decision. Trả null = mã ngoài rule (caller giữ
 * WAITING_IQC + warning, KHÔNG đoán).
 * @param {{ adjResult: unknown, proResult: unknown }} iqcRow
 * @returns {string | null}
 */
function mapIqcDecision(iqcRow) {
    const adj = normalizeCode(iqcRow.adjResult);
    const pro = normalizeCode(iqcRow.proResult);
    if (adj === ADJ_RESULT.WAITING) return IQC_DECISIONS.WAITING;
    if (adj === ADJ_RESULT.PASS) return IQC_DECISIONS.PASS;
    if (adj === ADJ_RESULT.EXEMPT) return IQC_DECISIONS.EXEMPT;
    if (adj === ADJ_RESULT.FAIL && pro === PRO_RESULT.SPECIALLY_PROCURED) {
        return IQC_DECISIONS.FAIL_ACCEPT;
    }
    if (adj === ADJ_RESULT.FAIL && pro === PRO_RESULT.RETURN) {
        return IQC_DECISIONS.FAIL_RETURN;
    }
    return null;
}

/**
 * Phân loại số lượng PASS trước GRN. NULL return_qty được xem là chưa có
 * số lượng trả. Dữ liệu ngoài giới hạn trả null để caller bật cảnh báo.
 */
function classifyQuantity(iqcRow) {
    const sheetQty = Number(iqcRow.sheetQty);
    const returnQty = Number(iqcRow.returnQty ?? 0);
    if (!Number.isFinite(sheetQty) || sheetQty <= 0 ||
        !Number.isFinite(returnQty) || returnQty < 0 || returnQty > sheetQty) {
        return null;
    }
    if (returnQty === 0) return QUANTITY_SHAPE.FULL_ACCEPT;
    if (returnQty === sheetQty) return QUANTITY_SHAPE.FULL_RETURN;
    return QUANTITY_SHAPE.PARTIAL;
}

/**
 * Dựng patch IQC cho 1 receipt. Số lượng lấy từ receipt.received_qty
 * (KHÔNG copy in_qty của notice vào mọi allocation); nhánh partial
 * single-allocation ghi số tuyệt đối theo notice: qty_in_stock =
 * sheet_qty - return_qty, qty_return = return_qty (KHÔNG dùng in_qty —
 * giá trị đó phụ thuộc GRN, IQC chạy trước GRN).
 * @param {{ receivedQty: unknown }} receipt
 * @param {{ sheetQty: unknown, returnQty: unknown, qcDate: unknown }} iqcRow
 * @param {{ decision: string, shape: string }} entry
 * @param {Date} updatedAt
 * @returns {Record<string, unknown>}
 */
function buildReceiptIqcPatch(receipt, iqcRow, entry, updatedAt) {
    if (entry.decision === IQC_DECISIONS.WAITING) {
        return {
            iqc_decision: entry.decision,
            qty_in_stock: null,
            qty_return: null,
            qc_date: null,
            has_warning: false,
            updated_at: updatedAt,
        };
    }
    if (entry.shape === QUANTITY_SHAPE.PARTIAL) {
        const sheetQty = Number(iqcRow.sheetQty || 0);
        const returnQty = Number(iqcRow.returnQty || 0);
        return {
            iqc_decision: entry.decision,
            qty_in_stock: sheetQty - returnQty,
            qty_return: returnQty,
            qc_date: iqcRow.qcDate ?? null,
            has_warning: false,
            updated_at: updatedAt,
        };
    }
    const isReturn = entry.shape === QUANTITY_SHAPE.FULL_RETURN;
    return {
        iqc_decision: entry.decision,
        qty_in_stock: isReturn ? 0 : Number(receipt.receivedQty || 0),
        qty_return: isReturn ? Number(receipt.receivedQty || 0) : 0,
        qc_date: iqcRow.qcDate ?? null,
        has_warning: false,
        updated_at: updatedAt,
    };
}

function dateValue(value) {
    return value == null ? null : new Date(value).getTime();
}

/**
 * Tổng hợp kết quả IQC của toàn bộ receipt thuộc 1 allocation.
 * @param {Array<{ iqcDecision: string, qtyInStock: unknown,
 *   qtyReturn: unknown, qcDate: unknown }>} receipts
 * @returns {{ qtyInStock: number, qtyReturn: number, allTerminal: boolean,
 *   iqcDecision: string | null, lastIqcAt: Date | null }}
 */
function aggregateAllocationIqc(receipts) {
    let qtyInStock = 0;
    let qtyReturn = 0;
    let lastIqcAt = null;
    const decisions = new Set();
    for (const receipt of receipts) {
        qtyInStock += Number(receipt.qtyInStock || 0);
        qtyReturn += Number(receipt.qtyReturn || 0);
        decisions.add(receipt.iqcDecision);
        if (receipt.qcDate) {
            const qcDate = new Date(receipt.qcDate);
            if (!Number.isNaN(qcDate.getTime()) && (!lastIqcAt || qcDate > lastIqcAt)) {
                lastIqcAt = qcDate;
            }
        }
    }
    const allTerminal =
        decisions.size > 0 &&
        [...decisions].every(
            (decision) => decision && decision !== IQC_DECISIONS.WAITING
        );
    return {
        qtyInStock,
        qtyReturn,
        allTerminal,
        iqcDecision: decisions.size === 1 ? [...decisions][0] : 'MIXED',
        lastIqcAt,
    };
}

/**
 * Derive trạng thái allocation từ tổng hợp receipt (spec §12).
 * KHÔNG BAO GIỜ trả IN_STOCK — đó là việc của đơn nhập kho thật.
 * @param {{ allTerminal: boolean, qtyInStock: number, qtyReturn: number }} summary
 * @returns {{ status: string, warehouseStatus: string }}
 */
function deriveAllocationStatus(summary) {
    if (summary.allTerminal) {
        if (summary.qtyInStock > 0) {
            return {
                status: ALLOCATION_STATUS.WAITING_STOCK,
                warehouseStatus: WAREHOUSE_STATUS.TEMP_IN,
            };
        }
        if (summary.qtyReturn > 0) {
            return {
                status: ALLOCATION_STATUS.RETURNED,
                warehouseStatus: WAREHOUSE_STATUS.RETURNED,
            };
        }
    }
    return {
        status: ALLOCATION_STATUS.WAITING_IQC,
        warehouseStatus: WAREHOUSE_STATUS.TEMP_IN,
    };
}

/**
 * Lý do 1 allocation không còn đủ điều kiện chạy IQC (Undo hoặc trạng
 * thái đã tiến) — null nghĩa là được phép chạy.
 * @param {{ status: string, closedAt: unknown } | null} allocation
 * @returns {string | null}
 */
function blockedReason(allocation) {
    if (!allocation) return 'allocation_missing';
    if (allocation.closedAt) return 'allocation_closed';
    // T8 ghi pro_result=0 trước; lô trả hàng còn mở có thể được sửa sau đó.
    // MIXED có thể gồm nhiều kết quả khác nhau trên cùng một lượt gán kệ.
    const provisionalReturn = allocation.status === ALLOCATION_STATUS.RETURNED &&
        [IQC_DECISIONS.FAIL_RETURN, 'MIXED'].includes(allocation.iqcDecision);
    if (provisionalReturn && allocation.iqcDecision === IQC_DECISIONS.FAIL_RETURN &&
        allocation.lastIqcAt != null && new Date(allocation.lastIqcAt) < previousMonthCutoff()) {
        return 'fail_return_recheck_expired';
    }
    if ([WAREHOUSE_STATUS.IN_STOCK, 'IN'].includes(allocation.warehouseStatus) ||
        (allocation.status !== ALLOCATION_STATUS.WAITING_IQC &&
            allocation.status !== ALLOCATION_STATUS.WAITING_STOCK &&
            !provisionalReturn)) {
        return 'status_advanced';
    }
    return null;
}

/**
 * Map noticeDetailId -> số allocation đang mở cùng tham chiếu notice.
 * @param {Array<{ noticeDetailId: unknown, activeAllocations: unknown }>} rows
 * @returns {Map<number, number>}
 */
function buildActiveAllocationCounts(rows) {
    const counts = new Map();
    for (const row of rows) {
        counts.set(Number(row.noticeDetailId), Number(row.activeAllocations || 0));
    }
    return counts;
}

/**
 * Lập kế hoạch IQC cho toàn bộ receipt của allocation từ dữ liệu T8.
 * Trả { state, reason } khi chưa kết luận được; trả { plan } khi mọi
 * receipt đã terminal (plan chỉ chứa decision + IQC row, số lượng được
 * tính lại FRESH trong transaction).
 * @param {Array<Record<string, unknown>>} receipts
 * @returns {Promise<{ state?: string, reason?: string,
 *   hasWarning?: boolean, plan?: Map<string, object> }>}
 */
async function buildReceiptPlan(receipts, isRecheck) {
    const noticeIds = [...new Set(receipts.map((r) => Number(r.noticeDetailId)))];
    const notices = await IqcSyncRepository.findNoticeIdentitiesByIds(noticeIds);
    const noticeById = new Map(notices.map((n) => [Number(n.noticeDetailId), n]));

    if (receipts.some((receipt) => !noticeById.has(Number(receipt.noticeDetailId)))) {
        // Notice biến mất ở T8 — không đoán, surface cho người vận hành.
        return { state: IQC_SYNC_STATES.DATA_ERROR, reason: 'notice_identity_missing' };
    }
    const identities = notices.filter(hasCompleteIdentity);
    if (identities.length !== notices.length) {
        return { state: IQC_SYNC_STATES.WAITING_IQC, reason: 'notice_identity_incomplete' };
    }

    const iqcRows = await IqcSyncRepository.findIqcDetailsByIdentity(identities);
    const rowsByKey = new Map();
    for (const row of iqcRows) {
        const key = buildIdentityKey(row);
        rowsByKey.set(key, [...(rowsByKey.get(key) || []), row]);
    }
    const plan = new Map();
    for (const receipt of receipts) {
        const notice = noticeById.get(Number(receipt.noticeDetailId));
        const rows = rowsByKey.get(buildIdentityKey(notice)) || [];
        if (rows.length === 0) {
            return { state: IQC_SYNC_STATES.WAITING_IQC, reason: 'iqc_not_found' };
        }
        if (rows.length > 1) {
            logger.warn('iqc_ambiguous_rows', {
                allocationId: receipt.allocationId,
                noticeDetailId: Number(receipt.noticeDetailId),
                matchedRows: rows.length,
            });
            return { state: IQC_SYNC_STATES.PARTIAL_AMBIGUOUS, reason: 'iqc_ambiguous' };
        }

        const iqcRow = rows[0];
        const decision = mapIqcDecision(iqcRow);
        if (decision === null) {
            logger.warn('iqc_unknown_code', {
                allocationId: receipt.allocationId,
                noticeDetailId: Number(receipt.noticeDetailId),
                adjResult: iqcRow.adjResult,
                proResult: iqcRow.proResult,
            });
            return { state: IQC_SYNC_STATES.PARTIAL_AMBIGUOUS, reason: 'iqc_unknown_code' };
        }
        if (decision === IQC_DECISIONS.WAITING && !isRecheck) {
            return { state: IQC_SYNC_STATES.WAITING_IQC, reason: 'iqc_waiting' };
        }

        let shape = null;
        switch (decision) {
            case IQC_DECISIONS.FAIL_RETURN:
                shape = QUANTITY_SHAPE.FULL_RETURN;
                break;
            case IQC_DECISIONS.FAIL_ACCEPT:
            case IQC_DECISIONS.EXEMPT:
                shape = QUANTITY_SHAPE.FULL_ACCEPT;
                break;
            case IQC_DECISIONS.PASS:
                shape = classifyQuantity(iqcRow);
                break;
        }
        if (decision === IQC_DECISIONS.PASS && !shape) {
            const reason = 'iqc_invalid_quantity';
            logger.warn(reason, {
                allocationId: receipt.allocationId,
                noticeDetailId: Number(receipt.noticeDetailId),
                decision,
                sheetQty: iqcRow.sheetQty,
                returnQty: iqcRow.returnQty,
            });
            return { state: IQC_SYNC_STATES.DATA_ERROR, reason, hasWarning: true };
        }

        plan.set(String(receipt.id), {
            iqcRow,
            decision,
            shape,
            noticeDetailId: Number(receipt.noticeDetailId),
            lotNo: receipt.lotNo,
        });
    }
    return { plan };
}

class IqcSyncServices {
    /**
     * Sync IQC cho 1 allocation — mỗi bước trả result-state rõ ràng.
     * @param {string} allocationId PK whs_slot_allocation
     * @returns {Promise<{ state: string, allocationId: string,
     *   reason?: string, qtyInStock?: number, qtyReturn?: number,
     *   iqcDecision?: string | null }>}
     */
    async syncAllocation(allocationId) {
        const allocation = await IqcSyncRepository.findAllocationForIqc(allocationId);
        const blocked = blockedReason(allocation);
        if (blocked) {
            return { state: IQC_SYNC_STATES.NO_OP, allocationId, reason: blocked };
        }

        const receipts = await IqcSyncRepository.findReceiptsForAllocation(
            allocationId
        );
        if (receipts.length === 0) {
            // Receipt Sync chưa ghi mapping (hoặc Undo vừa release) — sweep đón sau.
            return { state: IQC_SYNC_STATES.NO_OP, allocationId, reason: 'no_receipt' };
        }
        if (receipts.some((receipt) => !hasLot(receipt.lotNo))) {
            return {
                state: IQC_SYNC_STATES.WAITING_IQC,
                allocationId,
                reason: 'waiting_lot',
            };
        }

        const planResult = await buildReceiptPlan(
            receipts,
            allocation.iqcDecision != null || allocation.status !== ALLOCATION_STATUS.WAITING_IQC
        );
        if (!planResult.plan) {
            if (planResult.hasWarning || planResult.state === IQC_SYNC_STATES.PARTIAL_AMBIGUOUS) {
                // Chỉ bật cờ cảnh báo — KHÔNG ghi quantity, KHÔNG đổi status.
                await this.markAllocationWarning(allocationId);
            }
            return {
                state: planResult.state,
                allocationId,
                reason: planResult.reason,
            };
        }
        return this.applyPlan(allocationId, planResult.plan);
    }

    /**
     * Áp kế hoạch IQC trong 1 transaction ngắn: lock allocation (cùng thứ
     * tự Receipt Sync / Undo) → recheck trạng thái + receipt → ghi receipt
     * → tổng hợp allocation. Undo / trạng thái đã tiến giữa chừng → NO_OP.
     * @param {string} allocationId
     * @param {Map<string, { iqcRow: object, decision: string, shape: string }>} plan
     * @returns {Promise<{ state: string, allocationId: string,
     *   reason?: string, qtyInStock?: number, qtyReturn?: number,
     *   iqcDecision?: string | null }>}
     */
    async applyPlan(allocationId, plan) {
        return db.withTransaction(async (tx) => {
            await ReceiptSyncRepository.acquireAllocationLock(allocationId, tx);
            const current = await IqcSyncRepository.findAllocationForIqc(
                allocationId,
                tx,
                true
            );
            const blocked = blockedReason(current);
            if (blocked) {
                return { state: IQC_SYNC_STATES.NO_OP, allocationId, reason: blocked };
            }

            const fresh = await IqcSyncRepository.findReceiptsForAllocation(
                allocationId,
                tx
            );
            const unchanged =
                fresh.length === plan.size &&
                fresh.every((receipt) => {
                    const entry = plan.get(String(receipt.id));
                    return entry &&
                        entry.noticeDetailId === Number(receipt.noticeDetailId) &&
                        entry.lotNo === receipt.lotNo;
                });
            if (!unchanged) {
                return {
                    state: IQC_SYNC_STATES.NO_OP,
                    allocationId,
                    reason: 'receipt_changed',
                };
            }

            const partialReceipts = fresh.filter(
                (receipt) => plan.get(String(receipt.id)).shape === QUANTITY_SHAPE.PARTIAL
            );
            // Cùng thứ tự khóa allocation → notice với Receipt Sync và Stock Sync.
            const noticeIds = [...new Set(fresh.map((receipt) => Number(receipt.noticeDetailId)))]
                .sort((a, b) => a - b);
            for (const noticeId of noticeIds) {
                await ReceiptSyncRepository.acquireNoticeLock(noticeId, tx);
            }
            if (partialReceipts.length > 0) {
                const partialNoticeIds = partialReceipts.map((receipt) => Number(receipt.noticeDetailId));
                const activeCounts = buildActiveAllocationCounts(
                    await IqcSyncRepository.countActiveAllocationsByNoticeIds(partialNoticeIds, tx)
                );
                const ambiguous = partialReceipts.find((receipt) => {
                    const { iqcRow } = plan.get(String(receipt.id));
                    return activeCounts.get(Number(receipt.noticeDetailId)) !== 1 ||
                        Number(receipt.receivedQty) !== Number(iqcRow.sheetQty);
                });
                if (ambiguous) {
                    const reason = 'iqc_partial_ambiguous';
                    logger.warn(reason, { allocationId, noticeDetailId: ambiguous.noticeDetailId });
                    await IqcSyncRepository.updateAllocationIqcSummary(
                        allocationId, { has_warning: true }, tx
                    );
                    return { state: IQC_SYNC_STATES.PARTIAL_AMBIGUOUS, allocationId, reason };
                }
            }

            const updatedAt = new Date();
            const patched = [];
            let receiptsChanged = false;
            for (const receipt of fresh) {
                const entry = plan.get(String(receipt.id));
                const patch = buildReceiptIqcPatch(receipt, entry.iqcRow, entry, updatedAt);
                if (receipt.iqcDecision !== patch.iqc_decision ||
                    receipt.qtyInStock !== patch.qty_in_stock ||
                    receipt.qtyReturn !== patch.qty_return ||
                    dateValue(receipt.qcDate) !== dateValue(patch.qc_date) ||
                    Boolean(receipt.hasWarning)) {
                    await ReceiptRepository.updateReceipt(receipt.id, patch, tx);
                    receiptsChanged = true;
                }
                patched.push({
                    iqcDecision: entry.decision,
                    qtyInStock: patch.qty_in_stock,
                    qtyReturn: patch.qty_return,
                    qcDate: patch.qc_date,
                });
            }

            const summary = aggregateAllocationIqc(patched);
            const status = deriveAllocationStatus(summary);
            if (!receiptsChanged &&
                current.status === status.status &&
                current.warehouseStatus === status.warehouseStatus &&
                current.iqcDecision === summary.iqcDecision &&
                current.qtyInStock === summary.qtyInStock &&
                current.qtyReturn === summary.qtyReturn &&
                dateValue(current.lastIqcAt) === dateValue(summary.lastIqcAt) &&
                !current.hasWarning) {
                return { state: IQC_SYNC_STATES.NO_OP, allocationId, reason: 'iqc_unchanged' };
            }

            await IqcSyncRepository.updateAllocationIqcSummary(
                allocationId,
                {
                    status: status.status,
                    ...(current.status !== status.status ? { status_recorded_at: updatedAt } : {}),
                    warehouse_status: status.warehouseStatus,
                    iqc_decision: summary.iqcDecision,
                    qty_in_stock: summary.qtyInStock,
                    qty_return: summary.qtyReturn,
                    last_iqc_at: summary.lastIqcAt,
                    has_warning: false,
                },
                tx
            );

            return {
                state: {
                    [ALLOCATION_STATUS.WAITING_IQC]: IQC_SYNC_STATES.WAITING_IQC,
                    [ALLOCATION_STATUS.WAITING_STOCK]: IQC_SYNC_STATES.MATCHED,
                    [ALLOCATION_STATUS.RETURNED]: IQC_SYNC_STATES.RETURNED,
                }[status.status],
                allocationId,
                qtyInStock: summary.qtyInStock,
                qtyReturn: summary.qtyReturn,
                iqcDecision: summary.iqcDecision,
            };
        });
    }

    /**
     * Bật has_warning cho allocation khi IQC chưa kết luận an toàn được
     * (unknown code / ambiguous rows / partial multi-allocation). Không
     * đổi status, không ghi quantity, không retry nghiệp vụ.
     * @param {string} allocationId
     * @returns {Promise<void>}
     */
    async markAllocationWarning(allocationId) {
        await db.withTransaction(async (tx) => {
            await ReceiptSyncRepository.acquireAllocationLock(allocationId, tx);
            const current = await IqcSyncRepository.findAllocationForIqc(
                allocationId,
                tx,
                true
            );
            if (blockedReason(current)) return;
            await IqcSyncRepository.updateAllocationIqcSummary(
                allocationId,
                { has_warning: true },
                tx
            );
        });
    }
}

const iqcSyncService = new IqcSyncServices();

module.exports = iqcSyncService;
module.exports.IQC_SYNC_STATES = IQC_SYNC_STATES;
module.exports.IQC_DECISIONS = IQC_DECISIONS;
module.exports.ALLOCATION_STATUS = ALLOCATION_STATUS;
module.exports.mapIqcDecision = mapIqcDecision;
module.exports.classifyQuantity = classifyQuantity;
module.exports.deriveAllocationStatus = deriveAllocationStatus;
