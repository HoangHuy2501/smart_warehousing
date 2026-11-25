'use strict';

const { createHash } = require('node:crypto');
const db = require('../config/db');
const { err, shared } = require('./shared');
const allocations = require('../repository/sql/iqc-sync.repository');
const locks = require('../repository/sql/receipt-sync.repository');
const slots = require('../repository/sql/slot.repository');
const stock = require('../repository/sql/stock-sync.repository');
const t8 = require('../repository/sql/t8-receipt.repository');

const EPSILON = 0.000000005;

async function authorize(allocationId, actor, slotCode, tx) {
    const allocation = await locks.findAllocationForSync(allocationId, tx);
    if (!allocation || allocation.closedAt) err('not_found', 404);
    if (allocation.slotCode !== slotCode) err('lot_slot_changed', 409);
    const slot = await slots.byCode(slotCode, tx);
    if (!slot || !shared.canAccessSlot(actor, slot)) err('no_permission', 403);
    return allocation;
}

async function getActor(actorId, slotCode) {
    if (typeof slotCode !== 'string' || !slotCode.trim() || slotCode.length > 20) err('slot_code_invalid');
    if (db.getMode() !== 'sqlserver') err('t8_receipt_unavailable', 503);
    return shared.getActor(actorId);
}

async function planLines(allocationId, allocation, slotCode, tx, lockNotices) {
    const receipts = await allocations.findReceiptsForAllocation(allocationId, tx);
    if (allocation.hasWarning || receipts.some((r) =>
        r.hasWarning || r.qtyInStock == null || !r.lotNo?.trim())) err('lot_stock_unresolved', 409);

    const accepted = receipts.filter((r) => r.qtyInStock > 0);
    if (!accepted.length) err('lot_stock_unresolved', 409);

    const noticeIds = [...new Set(accepted.map((r) => Number(r.noticeDetailId)))].sort((a, b) => a - b);
    if (lockNotices) {
        for (const id of noticeIds) await locks.acquireNoticeLock(id, tx);
    }

    const coverage = new Map();
    for (let offset = 0; offset < noticeIds.length; offset += 500) {
        const rows = await stock.findNoticeCoverage(noticeIds.slice(offset, offset + 500), tx);
        for (const row of rows) coverage.set(Number(row.notice_id), row);
    }

    const planned = [];
    for (const id of noticeIds) {
        const local = accepted.filter((r) => Number(r.noticeDetailId) === id);
        const row = coverage.get(id);
        if (!row || Number(row.unresolved_count) !== 0 ||
            local.some((r) => r.lotNo.trim() !== row.lot_no?.trim())) err('lot_stock_unresolved', 409);

        const required = Number(row.required_qty);
        const imported = Number(row.imported_qty);
        const source = await t8.findSource(id, allocation.poId, allocation.goodsNo, slotCode, tx);
        if (!source) err('t8_receipt_source_invalid', 409);
        if (imported >= required) continue;
        const existing = imported + Number(source.draft_qty);
        if (existing + EPSILON >= required) continue;

        const localQty = local.reduce((sum, r) => sum + Number(r.qtyInStock), 0);
        const slotQty = Number(source.slot_qty ?? 0);
        const quantity = Math.min(required - existing, localQty - slotQty);
        if (quantity <= EPSILON) continue;

        const acceptedByIqc = Number(source.sheet_qty) - Number(source.return_qty);
        if (Number(source.match_count) !== 1 || String(source.adj_result).trim() !== '1' ||
            Number(source.return_qty) < 0 || acceptedByIqc + EPSILON < required ||
            local.some((r) => r.iqcDecision !== 'PASS')) err('t8_receipt_iqc_not_pass', 409);

        if (!source.su_no || !(source.sheet_pri > 0 && source.unit_rate > 0 && source.pri_dis > 0)) {
            err('t8_receipt_source_invalid', 409);
        }
        if (!await t8.hasSlot(source.st_no, slotCode, tx)) err('t8_receipt_slot_invalid', 409);

        const values = {
            notice_no: source.notice_no, notice_id: source.notice_id,
            pur_no: source.pur_no, pur_id: source.pur_id, goods_no: source.goods_no,
            unit_no: source.unit_no, unit_rate: source.unit_rate, st_no: source.st_no,
            st_bit_no: slotCode, made_lot: source.made_lot, sheet_qty: quantity.toFixed(8),
            sheet_pri: source.sheet_pri, pri_dis: source.pri_dis, tax_sw: source.tax_sw,
            cur_no: source.cur_no, inv_type: source.inv_type, rem: source.rem,
            def06: source.sheet_qty, def14: source.def14, def15: source.def15, sheet_sta: '0',
        };
        planned.push({ id, supplier: source.su_no, values, existing, slotQty });
    }
    return planned;
}

function revision(allocationId, slotCode, lines) {
    return createHash('sha256').update(JSON.stringify([allocationId, slotCode, lines])).digest('hex');
}

async function preview(allocationId, { actorId, slotCode }) {
    const actor = await getActor(actorId, slotCode);
    const allocation = await authorize(allocationId, actor, slotCode, db.query);
    if (allocation.status !== 'WAITING_STOCK') err('lot_not_waiting_stock', 409);
    const planned = await planLines(allocationId, allocation, slotCode, db.query, false);
    return {
        allocationId, slotCode, status: allocation.status,
        mode: planned.length ? 'ENTER_QUANTITY' : 'CONFIRM_EXISTING',
        revision: revision(allocationId, slotCode, planned),
        lines: planned.map(({ id, supplier, values }) => ({
            noticeDetailId: id, supplierNo: supplier, noticeNo: values.notice_no,
            noticeLineId: values.notice_id, poNo: values.pur_no, poLineId: values.pur_id,
            goodsNo: values.goods_no, lotNo: values.made_lot, unitNo: values.unit_no,
            warehouseCode: values.st_no, slotCode, unitRate: values.unit_rate,
            unitPrice: values.sheet_pri, discount: values.pri_dis, taxFlag: values.tax_sw,
            currency: values.cur_no, invoiceType: values.inv_type, remark: values.rem,
            maxQuantity: values.sheet_qty, quantity: values.sheet_qty,
        })),
    };
}

async function send(allocationId, { actorId, slotCode, revision: expectedRevision, lines }) {
    const actor = await getActor(actorId, slotCode);
    if (typeof expectedRevision !== 'string' || !Array.isArray(lines)) err('t8_receipt_preview_required');

    return db.withTransaction(async (tx) => {
        await locks.acquireAllocationLock(allocationId, tx);
        const allocation = await authorize(allocationId, actor, slotCode, tx);
        if (['SEND_STOCK', 'IN_STOCK'].includes(allocation.status)) {
            return { allocationId, status: allocation.status, sheetNos: [] };
        }
        if (allocation.status !== 'WAITING_STOCK') err('lot_not_waiting_stock', 409);
        const planned = await planLines(allocationId, allocation, slotCode, tx, true);
        if (expectedRevision !== revision(allocationId, slotCode, planned)) err('t8_receipt_preview_stale', 409);

        const requested = new Map();
        for (const line of lines) {
            if (!Number.isSafeInteger(line?.noticeDetailId) || requested.has(line.noticeDetailId) ||
                !['number', 'string'].includes(typeof line.quantity) ||
                !/^\d+(\.\d{1,8})?$/.test(String(line.quantity))) err('t8_receipt_quantity_invalid');
            requested.set(line.noticeDetailId, Number(line.quantity));
        }
        if (requested.size !== planned.length) err('t8_receipt_quantity_invalid');

        const byNotice = new Map();
        let partial = false;
        for (const { id, supplier, values } of planned) {
            const quantity = requested.get(id);
            if (!Number.isFinite(quantity) || quantity <= 0 || quantity > Number(values.sheet_qty)) {
                err('t8_receipt_quantity_invalid');
            }
            if (quantity < Number(values.sheet_qty)) partial = true;
            const group = byNotice.get(values.notice_no) || { supplier, lines: [] };
            group.lines.push({ ...values, sheet_qty: quantity.toFixed(8) });
            byNotice.set(values.notice_no, group);
        }

        const sheetNos = [];
        let creator;
        for (const [noticeNo, { supplier, lines }] of byNotice) {
            const drafts = await t8.findOpenDraft(noticeNo, supplier, tx);
            if (drafts.length > 1) err('t8_receipt_multiple_drafts', 409);

            let [sheetNo] = drafts;
            let lineId = 1;
            if (sheetNo) {
                lineId = await t8.nextLineId(sheetNo, tx);
            } else {
                creator ??= await t8.findCreator(actor.id, tx);
                if (!creator) err('t8_receipt_creator_invalid', 409);
                sheetNo = await t8.reserveSheetNumber(tx);
                if (!sheetNo) err('t8_receipt_daily_limit', 409);
                await t8.insertHeader({
                    sheet_type: 'PIGI', sheet_no: sheetNo, sheet_date: new Date(), su_no: supplier,
                    emp_no: creator.emp_no, create_user: creator.user_no,
                    rem: 'Smart-Warehousing', sheet_sta: '0', check_sta: '0',
                }, actor.id, tx);
            }
            for (const line of lines) {
                await t8.insertLine({ sheet_no: sheetNo, sheet_id: lineId++, ...line }, actor.id, tx);
            }
            sheetNos.push(sheetNo);
        }

        if (partial) return { allocationId, status: 'WAITING_STOCK', sheetNos };
        const updated = await allocations.updateAllocationIqcSummary(allocationId, {
            status: 'SEND_STOCK',
            status_recorded_at: new Date(),
        }, tx);
        if (!updated) err('t8_receipt_allocation_update_failed', 409);
        return { allocationId, status: 'SEND_STOCK', sheetNos };
    });
}

module.exports = { preview, send };
