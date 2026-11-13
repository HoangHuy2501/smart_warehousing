/**
 * Service RECONCILE ISSUE — enrich issue OPEN thành structured DTO cho FE.
 *
 * BỔ SUNG 2026-10-28 (user yêu cầu #1-#22 sửa UI reconcile issue):
 * FE KHÔNG được parse `note` hay hiển thị raw ID/type. Service này đọc
 * `whs_reconcile_issue` (source-of-truth, has_warning chỉ là cache UI)
 * rồi BUILD DTO có sẵn context số lượng + candidates AMBIGUOUS +
 * change T8_CHANGED, sao cho mỗi issue_type render được riêng:
 *
 *   EXCESS      → assignedQty vs t8Qty, difference có dấu
 *   SHORTAGE    → t8Qty vs receivedQty (cấp PO/Notice, allocation NULL)
 *   AMBIGUOUS   → candidates[] đầy đủ sheetNo/noticeDetailId/qty/lotNo
 *   T8_CHANGED  → change.kind PO_LINE_MISSING | NOTICE_MISSING |
 *                 LOT_CHANGED | LOT_REMOVED (+ old/new value)
 *
 * Quy tắc đọc (PO identity fix 2026-10-29: relation [R2] siết thêm
 * pur_id = sheet_id — notice của DÒNG PO khác không match; def23 đã bỏ
 * 2026-10-28; def02 NULL-safe giữ nguyên):
 *   DATA_ERROR  → change.kind NOTICE_PUR_ID_INVALID + candidates[] là
 *                 notice mồ côi khớp pur_no+goods+def02 nhưng pur_id
 *                 NULL/không trỏ về dòng nào của PO (legacy)
 * candidates AMBIGUOUS derive lại từ PO + matching rule → KHÔNG cần
 * ALTER whs_reconcile_issue chỉ để UI (#8).
 *
 * Hiệu năng: batch-first — findAllocationsByIds / findOrder2ByPoIds /
 * findReceiptsByAllocationIds / sumReceivedByNoticeIds đều 1 câu cho
 * nhiều ids; findNoticesForPoLine chỉ chạy 1 lần MỖI poId (cache Map).
 * Toàn bộ giá trị runtime đều đi qua placeholder — không nối chuỗi SQL.
 */

'use strict';

const ReconcileIssueRepository = require('../repository/sql/reconcile-issue.repository');
const ReceiptSyncRepository = require('../repository/sql/receipt-sync.repository');
const ReceiptRepository = require('../repository/sql/receipt.repository');
const PoRepository = require('../repository/sql/po.repository');

const roundQty = (n) => Math.round(Number(n || 0) * 1e6) / 1e6;

function toIso(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

class ReconcileIssueServices {
    /**
     * Danh sách issue OPEN kèm structured context (mặc định limit 200).
     * @returns {Promise<import('../../shared/types').IReconcileIssueDto[]>}
     */
    async listOpenIssueDtos({ limit = 200 } = {}) {
        const rows = await ReconcileIssueRepository.listOpenIssues(limit);
        if (!Array.isArray(rows) || rows.length === 0) return [];

        // ---- 1. BATCH collect keys (chống N+1) -----------------------------
        const allocationIds = [];
        const seenAllocationIds = new Set();
        const poIds = [];
        const seenPoIds = new Set();
        for (const row of rows) {
            if (row.allocationId && !seenAllocationIds.has(row.allocationId)) {
                seenAllocationIds.add(row.allocationId);
                allocationIds.push(row.allocationId);
            }
            if (row.poId && !seenPoIds.has(row.poId)) {
                seenPoIds.add(row.poId);
                poIds.push(row.poId);
            }
        }

        const [allocations, poLines, receipts] = await Promise.all([
            ReceiptSyncRepository.findAllocationsByIds(allocationIds),
            poIds.length > 0 ? PoRepository.findOrder2ByPoIds(poIds) : [],
            ReceiptRepository.findReceiptsByAllocationIds(allocationIds),
        ]);

        const allocById = new Map(
            allocations.map((a) => [a.allocationId, a])
        );
        const poById = new Map(poLines.map((p) => [Number(p.id), p]));
        /** @type {Map<string, Array<object>>} allocationId -> receipts */
        const receiptsByAllocation = new Map();
        for (const r of receipts) {
            const list = receiptsByAllocation.get(r.allocationId) || [];
            list.push(r);
            receiptsByAllocation.set(r.allocationId, list);
        }

        // ---- 2. Notice totals + candidates per PO line --------------------
        const noticeIds = new Set();
        for (const row of rows) {
            if (row.noticeDetailId != null) noticeIds.add(Number(row.noticeDetailId));
            for (const r of receiptsByAllocation.get(row.allocationId) || []) {
                if (r.noticeDetailId != null) noticeIds.add(Number(r.noticeDetailId));
            }
        }
        const noticeReceived = noticeIds.size
            ? await ReceiptRepository.sumReceivedByNoticeIds([...noticeIds])
            : new Map();

        /** @type {Map<number, Array<object>>} poId -> notices khớp [R2] */
        const noticesByPo = new Map();
        const noticesFor = async (poId) => {
            if (!poId) return [];
            let list = noticesByPo.get(Number(poId));
            if (list === undefined) {
                try {
                    list = await PoRepository.findNoticesForPoLine(Number(poId));
                } catch {
                    list = [];
                }
                noticesByPo.set(Number(poId), list);
            }
            return list;
        };

        /** @type {Map<number, Array<object>>} poId -> orphan notices (DATA_ERROR) */
        const orphansByPo = new Map();
        const orphansFor = async (poId) => {
            if (!poId) return [];
            let list = orphansByPo.get(Number(poId));
            if (list === undefined) {
                try {
                    list = await PoRepository.findOrphanNoticesForPoLine(Number(poId));
                } catch {
                    list = [];
                }
                orphansByPo.set(Number(poId), list);
            }
            return list;
        };

        // ---- 3. Build DTO per issue ---------------------------------------
        const dtos = [];
        for (const row of rows) {
            const dto = await this.buildDto(row, {
                allocById,
                poById,
                receiptsByAllocation,
                noticeReceived,
                noticesFor,
                orphansFor,
            });
            dtos.push(dto);
        }
        return dtos;
    }

    /**
     * @private Build 1 DTO theo issue_type (xem BỔ SUNG #2-#9, #17: zero
     * difference không được làm warning biến mất).
     */
    async buildDto(row, ctx) {
        const alloc = ctx.allocById.get(row.allocationId) || null;
        const poLine = ctx.poById.get(Number(row.poId)) || null;
        const allReceipts = ctx.receiptsByAllocation.get(row.allocationId) || [];
        const issueReceipts = allReceipts.filter(
            (r) =>
                row.noticeDetailId == null ||
                String(r.noticeDetailId) === String(row.noticeDetailId)
        );
        const notices = row.poId
            ? await ctx.noticesFor(row.poId)
            : [];
        const notice =
            row.noticeDetailId != null
                ? notices.find((n) => String(n.id) === String(row.noticeDetailId)) ||
                null
                : null;
        const receivedOfNotice =
            row.noticeDetailId != null
                ? roundQty(ctx.noticeReceived.get(Number(row.noticeDetailId)) || 0)
                : null;
        const unit = poLine?.unitNo ?? notice?.unitNo ?? null;

        const base = {
            id: row.id,
            issueType: row.type,
            status: row.status,
            allocationId: row.allocationId ?? null,
            noticeDetailId: row.noticeDetailId ?? null,
            poId: row.poId ?? null,
            poNumber: poLine?.poNumber ?? null,
            goodsNo: row.goodsNo ?? alloc?.goodsNo ?? null,
            slotCode: row.slotCode ?? alloc?.slotCode ?? null,
            unit,
            createdAt: toIso(row.createdAt),
            updatedAt: toIso(row.updatedAt),
            note: row.note ?? null,
            // giá trị mặc định — từng type ghi đè ở dưới
            lotNo: alloc?.lotNo ?? null,
            assignedQty: alloc ? roundQty(alloc.allocatedQty) : null,
            t8Qty: null,
            receivedQty: null,
            differenceQty: roundQty(row.differenceQty),
            candidates: [],
            change: null,
        };

        if (row.type === 'EXCESS') {
            if (row.noticeDetailId == null) {
                // I4 — chênh lệch tại kệ: assigned vs tổng T8 đã nhận
                const receivedTotal = roundQty(
                    allReceipts.reduce((s, r) => s + Number(r.receivedQty || 0), 0)
                );
                base.t8Qty = receivedTotal;
                base.receivedQty = receivedTotal;
                base.differenceQty = roundQty(
                    (base.assignedQty || 0) - receivedTotal
                );
            } else {
                // I3 — received theo notice vượt sheet_qty T8 của phiếu đó
                base.t8Qty = notice ? roundQty(notice.sheetQty) : null;
                base.receivedQty = receivedOfNotice;
                base.differenceQty =
                    base.t8Qty != null
                        ? roundQty((receivedOfNotice || 0) - base.t8Qty)
                        : roundQty(row.differenceQty);
                base.lotNo = issueReceipts[0]?.lotNo ?? alloc?.lotNo ?? null;
            }
            return base;
        }

        if (row.type === 'SHORTAGE') {
            // Cấp PO/Notice (allocation_id thường NULL) — #4
            base.t8Qty = notice ? roundQty(notice.sheetQty) : null;
            base.receivedQty = receivedOfNotice ?? 0;
            base.differenceQty =
                base.t8Qty != null
                    ? roundQty(base.t8Qty - (base.receivedQty || 0))
                    : roundQty(row.differenceQty);
            base.assignedQty =
                alloc && row.allocationId != null ? base.assignedQty : null;
            return base;
        }

        if (row.type === 'AMBIGUOUS') {
            // #5, #6: candidates đủ noticeDetailId/sheetNo/qty/lotNo — KHÔNG
            // chỉ hiện ID; difference 0 vẫn phải thấy warning (#17).
            let remainingTotal = 0;
            base.candidates = notices.map((n) => {
                const qty = roundQty(n.sheetQty);
                const received = roundQty(
                    ctx.noticeReceived.get(Number(n.id)) || 0
                );
                const remaining = roundQty(qty - received);
                remainingTotal = roundQty(remainingTotal + remaining);
                return {
                    noticeDetailId: n.id,
                    noticeNo: n.sheetNo ?? null,
                    sheetNo: n.sheetNo ?? null,
                    purNo: n.purNo ?? poLine?.poNumber ?? null,
                    purId: n.purId ?? null,
                    poDetailId: poLine ? Number(poLine.id) : (row.poId ?? null),
                    poSheetId: poLine?.sheetId ?? null,
                    goodsNo: n.goodsNo ?? poLine?.goodsNo ?? null,
                    qty,
                    receivedQty: received,
                    remainingQty: remaining,
                    lotNo: n.madeLot ?? null,
                    unit: n.unitNo ?? poLine?.unitNo ?? null,
                    createdAt: n.createdAt ?? null,
                };
            });
            base.t8Qty = roundQty(
                base.candidates.reduce((s, c) => s + Number(c.qty || 0), 0)
            );
            base.receivedQty = roundQty(
                base.t8Qty - remainingTotal
            );
            base.differenceQty = roundQty((base.assignedQty || 0) - remainingTotal);
            base.lotNo = null;
            return base;
        }

        if (row.type === 'DATA_ERROR') {
            // PO identity fix 2026-10-29 (#9): tạm nhập khớp PO (pur_no + goods_no
            // + def02) nhưng pur_id NULL/không trỏ về dòng nào của PO — worker
            // KHÔNG auto-map lot. Candidates dưới đây là notice mồ côi cần user
            // sửa pur_id ở T8; đây là lỗi DỮ LIỆU, không phải waiting.
            base.change = { kind: 'NOTICE_PUR_ID_INVALID' };
            const orphans = await ctx.orphansFor(row.poId);
            base.candidates = orphans.map((n) => ({
                noticeDetailId: n.id,
                noticeNo: n.sheetNo ?? null,
                purNo: n.purNo ?? poLine?.poNumber ?? null,
                purId: n.purId ?? null,
                goodsNo: n.goodsNo ?? poLine?.goodsNo ?? null,
                qty: roundQty(n.sheetQty),
                lotNo: n.madeLot ?? null,
                createdAt: n.createdAt ?? null,
            }));
            base.differenceQty = 0;
            base.lotNo = null;
            return base;
        }

        if (row.type === 'T8_CHANGED') {
            // #9: nói rõ CÁI GÌ đổi — 4 variant suy từ dữ liệu hiện tại
            base.lotNo = issueReceipts[0]?.lotNo ?? null;
            if (!poLine) {
                base.change = { kind: 'PO_LINE_MISSING' };
            } else if (!notice) {
                base.change = { kind: 'NOTICE_MISSING' };
            } else {
                const syncedLot = issueReceipts[0]?.lotNo ?? null;
                const t8Lot = notice.madeLot ?? null;
                if (syncedLot && t8Lot && syncedLot !== t8Lot) {
                    base.change = {
                        kind: 'LOT_CHANGED',
                        oldLotNo: syncedLot,
                        newLotNo: t8Lot,
                    };
                } else if (syncedLot && !t8Lot) {
                    base.change = { kind: 'LOT_REMOVED', oldLotNo: syncedLot, newLotNo: null };
                } else if (t8Lot && !syncedLot) {
                    // phiếu mới có lot sau khi receipt cũ không lot — hiển thị như
                    // lot mới xuất hiện
                    base.change = { kind: 'LOT_CHANGED', oldLotNo: null, newLotNo: t8Lot };
                } else {
                    // mặc định an toàn: receipt cũ đã sync không còn thấy trong T8
                    base.change = {
                        kind: 'NOTICE_MISSING',
                        oldLotNo: syncedLot,
                        newLotNo: null,
                    };
                }
            }
            base.t8Qty = notice ? roundQty(notice.sheetQty) : null;
            base.receivedQty =
                issueReceipts.length > 0
                    ? roundQty(
                        issueReceipts.reduce(
                            (s, r) => s + Number(r.receivedQty || 0),
                            0
                        )
                    )
                    : receivedOfNotice;
            base.noticeSheetNo = notice?.sheetNo ?? null;
            return base;
        }

        return base;
    }
}

module.exports = new ReconcileIssueServices();
