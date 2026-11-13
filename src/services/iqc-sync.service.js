/**
 * SERVICE IQC SYNC — IqcSyncServices (singleton). Business logic của IQC
 * Worker: map kết quả IQC từ T8 (READ ONLY) xuống whs_allocation_receipt
 * rồi tổng hợp lên whs_slot_allocation.
 *
 * ĐÚNG MỘT ĐƯỜNG CHẠY (đọc từ trên xuống):
 *   nhận allocationId (từ queue/sweep)
 *   → load allocation            → thiếu / đã đóng / không WAITING_IQC → NO_OP
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
 * - Quantity KHÔNG double-count: một notice có thể chia nhiều allocation.
 *     full accept (in_qty ≈ sheet_qty, return_qty = 0)
 *       → mỗi receipt: qty_in_stock = received_qty, qty_return = 0
 *     full return (in_qty = 0, return_qty ≈ sheet_qty)
 *       → mỗi receipt: qty_in_stock = 0, qty_return = received_qty
 *     partial: CHỈ nhận số tuyệt đối khi notice thuộc đúng 1 allocation
 *       và receipt.received_qty ≈ sheet_qty → in_qty / return_qty.
 *       Partial + multi-allocation → KHÔNG chia tỷ lệ/FIFO/LIFO → giữ
 *       WAITING_IQC + has_warning (state PARTIAL_AMBIGUOUS).
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
    RETURN: 'RETURN',
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
    ACCEPT: '2',
};

/** Hình thái số lượng của 1 notice. */
const QUANTITY_SHAPE = {
    FULL_ACCEPT: 'FULL_ACCEPT',
    FULL_RETURN: 'FULL_RETURN',
    PARTIAL: 'PARTIAL',
};

/** Epsilon so sánh quantity (NUMERIC(18,8)) — quy ước 1e-4 cho cả file. */
const QTY_EPS = 1e-4;

/**
 * So sánh 2 số lượng với epsilon.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function nearlyEqual(a, b) {
    return Math.abs(Number(a || 0) - Number(b || 0)) <= QTY_EPS;
}

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
    if (adj === ADJ_RESULT.FAIL && pro === PRO_RESULT.ACCEPT) {
        return IQC_DECISIONS.FAIL_ACCEPT;
    }
    if (adj === ADJ_RESULT.FAIL && pro === PRO_RESULT.RETURN) {
        return IQC_DECISIONS.FAIL_RETURN;
    }
    return null;
}

/**
 * Phân loại số lượng của notice T8. Partial = không rơi vào full accept
 * hay full return → cần kiểm tra multi-allocation trước khi ghi.
 * @param {{ sheetQty: unknown, inQty: unknown, returnQty: unknown }} iqcRow
 * @returns {string} QUANTITY_SHAPE
 */
function classifyQuantity(iqcRow) {
    const sheetQty = Number(iqcRow.sheetQty || 0);
    const inQty = Number(iqcRow.inQty || 0);
    const returnQty = Number(iqcRow.returnQty || 0);
    if (nearlyEqual(inQty, sheetQty) && nearlyEqual(returnQty, 0)) {
        return QUANTITY_SHAPE.FULL_ACCEPT;
    }
    if (nearlyEqual(inQty, 0) && nearlyEqual(returnQty, sheetQty)) {
        return QUANTITY_SHAPE.FULL_RETURN;
    }
    return QUANTITY_SHAPE.PARTIAL;
}

/**
 * Dựng patch IQC cho 1 receipt. Số lượng lấy từ receipt.received_qty
 * (KHÔNG copy in_qty của notice vào mọi allocation) trừ nhánh partial
 * single-allocation dùng đúng in_qty/return_qty tuyệt đối.
 * @param {{ receivedQty: unknown }} receipt
 * @param {{ sheetQty: unknown, inQty: unknown, returnQty: unknown, qcDate: unknown }} iqcRow
 * @param {{ decision: string, shape: string }} entry
 * @param {Date} updatedAt
 * @returns {Record<string, unknown>}
 */
function buildReceiptIqcPatch(receipt, iqcRow, entry, updatedAt) {
    if (entry.shape === QUANTITY_SHAPE.PARTIAL) {
        return {
            iqc_decision: entry.decision,
            qty_in_stock: Number(iqcRow.inQty || 0),
            qty_return: Number(iqcRow.returnQty || 0),
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
        if (summary.qtyInStock > QTY_EPS) {
            return {
                status: ALLOCATION_STATUS.WAITING_STOCK,
                warehouseStatus: WAREHOUSE_STATUS.TEMP_IN,
            };
        }
        if (summary.qtyReturn > QTY_EPS) {
            return {
                status: ALLOCATION_STATUS.RETURNED,
                warehouseStatus: WAREHOUSE_STATUS.RETURN,
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
    if (allocation.status !== ALLOCATION_STATUS.WAITING_IQC) {
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
 *   plan?: Map<string, { iqcRow: object, decision: string, shape: string }> }>}
 */
async function buildReceiptPlan(receipts) {
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
    const activeCounts = buildActiveAllocationCounts(
        await IqcSyncRepository.countActiveAllocationsByNoticeIds(noticeIds)
    );

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
        if (decision === IQC_DECISIONS.WAITING) {
            return { state: IQC_SYNC_STATES.WAITING_IQC, reason: 'iqc_waiting' };
        }

        const shape = classifyQuantity(iqcRow);
        if (shape === QUANTITY_SHAPE.PARTIAL) {
            const activeAllocations =
                activeCounts.get(Number(receipt.noticeDetailId)) || 1;
            const attributable =
                activeAllocations <= 1 && nearlyEqual(receipt.receivedQty, iqcRow.sheetQty);
            if (!attributable) {
                logger.warn('iqc_partial_ambiguous', {
                    allocationId: receipt.allocationId,
                    noticeDetailId: Number(receipt.noticeDetailId),
                    activeAllocations,
                    receivedQty: receipt.receivedQty,
                    sheetQty: iqcRow.sheetQty,
                    inQty: iqcRow.inQty,
                    returnQty: iqcRow.returnQty,
                });
                return {
                    state: IQC_SYNC_STATES.PARTIAL_AMBIGUOUS,
                    reason: 'iqc_partial_ambiguous',
                };
            }
        }

        plan.set(String(receipt.id), { iqcRow, decision, shape });
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

        const planResult = await buildReceiptPlan(receipts);
        if (!planResult.plan) {
            if (planResult.state === IQC_SYNC_STATES.PARTIAL_AMBIGUOUS) {
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
                tx
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
                fresh.every((receipt) => plan.has(String(receipt.id)));
            if (!unchanged) {
                return {
                    state: IQC_SYNC_STATES.NO_OP,
                    allocationId,
                    reason: 'receipt_changed',
                };
            }

            const updatedAt = new Date();
            const patched = [];
            for (const receipt of fresh) {
                const entry = plan.get(String(receipt.id));
                const patch = buildReceiptIqcPatch(receipt, entry.iqcRow, entry, updatedAt);
                await ReceiptRepository.updateReceipt(receipt.id, patch, tx);
                patched.push({
                    iqcDecision: entry.decision,
                    qtyInStock: patch.qty_in_stock,
                    qtyReturn: patch.qty_return,
                    qcDate: patch.qc_date,
                });
            }

            const summary = aggregateAllocationIqc(patched);
            const status = deriveAllocationStatus(summary);
            await IqcSyncRepository.updateAllocationIqcSummary(
                allocationId,
                {
                    status: status.status,
                    warehouse_status: status.warehouseStatus,
                    iqc_decision: summary.iqcDecision,
                    qty_in_stock: summary.qtyInStock,
                    qty_return: summary.qtyReturn,
                    last_iqc_at: summary.lastIqcAt,
                },
                tx
            );

            return {
                state:
                    status.status === ALLOCATION_STATUS.RETURNED
                        ? IQC_SYNC_STATES.RETURNED
                        : IQC_SYNC_STATES.MATCHED,
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
                tx
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
module.exports.QTY_EPS = QTY_EPS;
