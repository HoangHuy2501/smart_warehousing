'use strict';

const { createHash } = require('node:crypto');
const { t8WarehouseNumbers } = require('../../config/warehouse.config');
const db = require('../../config/db');
const { err, shared } = require('../../shared/shared');
const allocations = require('../iqc/iqc-sync.repository');
const locks = require('../lots/receipt-sync.repository');
const slots = require('../slots/slot.repository');
const stock = require('./stock-sync.repository');
const t8 = require('./t8-receipt.repository');

const EPSILON = 0.000000005;
const QUANTITY_SCALE = 100000000n;

// Đổi số lượng sang số nguyên theo độ chính xác 8 chữ số thập phân.
function quantityUnits(value) {
    const [whole, fraction = ''] = String(value).split('.');
    return BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(8, '0'));
}

// Định dạng số lượng để trả về API hoặc ghi vào T8.
function formatQuantity(units) {
    return String(units / QUANTITY_SCALE) + '.' + String(units % QUANTITY_SCALE).padStart(8, '0');
}

// Cộng số lượng của các dòng dự kiến ghi vào T8.
function totalUnits(lines) {
    return lines.reduce((sum, line) => sum + quantityUnits(line.values.sheet_qty), 0n);
}

// Kiểm tra phân bổ còn ở kệ yêu cầu và người dùng có quyền thao tác.
async function authorize(allocationId, actor, slotCode, tx) {
    const allocation = await locks.findAllocationForSync(allocationId, tx);
    if (!allocation || allocation.closedAt) err('not_found', 404);
    if (allocation.slotCode !== slotCode) err('lot_slot_changed', 409);
    const slot = await slots.byCode(slotCode, tx);
    if (!slot || !shared.canAccessSlot(actor, slot)) err('no_permission', 403);
    return { ...allocation, warehouse: slot.warehouse };
}

// Lấy người thao tác và kiểm tra chế độ gửi phiếu T8.
async function getActor(actorId, slotCode) {
    if (typeof slotCode !== 'string' || !slotCode.trim() || slotCode.length > 20) err('slot_code_invalid');
    if (db.getMode() !== 'sqlserver') err('t8_receipt_unavailable', 503);
    return shared.getActor(actorId);
}

// Lấy các phân bổ cùng lô và khóa nhóm khi xác nhận.
async function getGroup(allocationId, actor, slotCode, tx, lockGroup) {
    let anchor = await authorize(allocationId, actor, slotCode, tx);
    if (anchor.status !== 'WAITING_STOCK') return { anchor, members: [] };
    const ids = [allocationId, ...await t8.findWaitingPeers(allocationId, tx)].sort();
    if (lockGroup) {
        for (const id of ids) await locks.acquireAllocationLock(id, tx);
        anchor = await authorize(allocationId, actor, slotCode, tx);
        if (anchor.status !== 'WAITING_STOCK') return { anchor, members: [] };
        const current = [allocationId, ...await t8.findWaitingPeers(allocationId, tx)].sort();
        if (JSON.stringify(current) !== JSON.stringify(ids)) err('t8_receipt_preview_stale', 409);
    }
    const members = [];
    for (const id of ids) {
        let allocation = id === allocationId ? anchor : await locks.findAllocationForSync(id, tx);
        if (!allocation || allocation.closedAt || allocation.status !== 'WAITING_STOCK') {
            err('t8_receipt_preview_stale', 409);
        }
        if (id !== allocationId) allocation = await authorize(id, actor, allocation.slotCode, tx);
        const receipts = await allocations.findReceiptsForAllocation(id, tx);
        if (allocation.hasWarning || receipts.some((r) =>
            r.hasWarning || r.qtyInStock == null || !r.lotNo?.trim())) err('lot_stock_unresolved', 409);
        members.push({ id, allocation, receipts: receipts.filter((r) => r.qtyInStock > 0) });
    }
    const lots = new Set(members.find((member) => member.id === allocationId).receipts
        .map((receipt) => receipt.lotNo.trim()));
    if (!lots.size) err('lot_stock_unresolved', 409);
    if (lots.size > 1) err('t8_receipt_multiple_lots', 409);
    for (const member of members) {
        member.included = member.receipts.filter((receipt) => lots.has(receipt.lotNo.trim()));
        member.completeLot = member.included.length === member.receipts.length;
    }
    return { anchor, members, lotNo: [...lots][0] };
}

// Lập các dòng cần ghi, bỏ qua dòng đã có phiếu nhập khớp trên T8.
async function planLines(members, tx, lockNotices) {
    const noticeIds = [...new Set(members.flatMap((member) =>
        member.included.map((r) => Number(r.noticeDetailId))))].sort((a, b) => a - b);
    if (lockNotices) {
        for (const id of noticeIds) await locks.acquireNoticeLock(id, tx);
    }

    const coverage = new Map();
    for (let offset = 0; offset < noticeIds.length; offset += 500) {
        const rows = await stock.findNoticeCoverage(noticeIds.slice(offset, offset + 500), tx);
        for (const row of rows) coverage.set(Number(row.notice_id), row);
    }

    const planned = [];
    const plannedByNotice = new Map();
    for (const { id: allocationId, allocation, included } of members) {
        const slotCode = allocation.slotCode;
        const warehouse = t8WarehouseNumbers[allocation.warehouse] ?? null;
        const memberNoticeIds = [...new Set(included.map((r) => Number(r.noticeDetailId)))].sort((a, b) => a - b);
        for (const id of memberNoticeIds) {
            const local = included.filter((r) => Number(r.noticeDetailId) === id);
            const row = coverage.get(id);
            if (!row || Number(row.unresolved_count) !== 0 ||
                local.some((r) => r.lotNo.trim() !== row.lot_no?.trim())) err('lot_stock_unresolved', 409);

            const required = Number(row.required_qty);
            const source = await t8.findSource(id, allocation.poId, allocation.goodsNo, tx);
            if (!source) err('t8_receipt_source_invalid', 409);
            if (Number(source.receipt_count) > 0) continue;

            const localQty = local.reduce((sum, r) => sum + Number(r.qtyInStock), 0);
            const quantity = Math.min(required - (plannedByNotice.get(id) || 0), localQty);
            if (quantity <= EPSILON) continue;

            const acceptedByIqc = Number(source.sheet_qty) - Number(source.return_qty);
            if (Number(source.match_count) !== 1 || String(source.adj_result).trim() !== '1' ||
                Number(source.return_qty) < 0 || acceptedByIqc + EPSILON < required ||
                local.some((r) => r.iqcDecision !== 'PASS')) err('t8_receipt_iqc_not_pass', 409);

            if (!source.su_no || !(source.sheet_pri > 0 && source.unit_rate > 0 && source.pri_dis > 0)) {
                err('t8_receipt_source_invalid', 409);
            }

            const values = {
                notice_no: source.notice_no, notice_id: source.notice_id,
                pur_no: source.pur_no, pur_id: source.pur_id, goods_no: source.goods_no,
                unit_no: source.unit_no, unit_rate: source.unit_rate, st_no: warehouse,
                made_lot: source.made_lot, sheet_qty: quantity.toFixed(8),
                sheet_pri: source.sheet_pri, pri_dis: source.pri_dis, tax_sw: source.tax_sw,
                cur_no: source.cur_no, inv_type: source.inv_type, rem: source.rem,
                def06: source.sheet_qty, def14: source.def14, def15: source.def15, sheet_sta: '0',
            };
            planned.push({ allocationId, id, slotCode, warehouseCode: allocation.warehouse, supplier: source.su_no, values });
            plannedByNotice.set(id, (plannedByNotice.get(id) || 0) + quantity);
        }
    }
    if (new Set(planned.map((line) => line.values.unit_no)).size > 1) {
        err('t8_receipt_mixed_units', 409);
    }
    return planned;
}

// Tạo mã đối chiếu giữa bản xem trước và lúc xác nhận.
function revision(allocationId, slotCode, members, lines) {
    return createHash('sha256').update(JSON.stringify([allocationId, slotCode, members, lines])).digest('hex');
}

// Trả thông tin xem trước cho form Gửi đơn T8.
async function preview(allocationId, { actorId, slotCode }) {
    const actor = await getActor(actorId, slotCode);
    const { anchor: allocation, members, lotNo } = await getGroup(allocationId, actor, slotCode, db.query, false);
    if (allocation.status !== 'WAITING_STOCK') err('lot_not_waiting_stock', 409);
    const planned = await planLines(members, db.query, false);
    const maxTotalQuantity = formatQuantity(totalUnits(planned));
    return {
        allocationId, slotCode, lotNo, status: allocation.status,
        slotCodes: [...new Set(members.map((member) => member.allocation.slotCode))].sort(),
        totalQuantity: maxTotalQuantity, maxTotalQuantity,
        mode: planned.length ? 'CREATE' : 'CONFIRM_EXISTING',
        revision: revision(allocationId, slotCode, members, planned),
        allocationIds: members.map((member) => member.id),
        lines: planned.map(({ allocationId: lineAllocationId, id, slotCode: lineSlotCode, supplier, values }) => ({
            allocationId: lineAllocationId,
            noticeDetailId: id, supplierNo: supplier, noticeNo: values.notice_no,
            noticeLineId: values.notice_id, poNo: values.pur_no, poLineId: values.pur_id,
            goodsNo: values.goods_no, lotNo: values.made_lot, unitNo: values.unit_no,
            warehouseCode: values.st_no, slotCode: lineSlotCode, unitRate: values.unit_rate,
            unitPrice: values.sheet_pri, discount: values.pri_dis, taxFlag: values.tax_sw,
            currency: values.cur_no, invoiceType: values.inv_type, remark: values.rem,
            maxQuantity: values.sheet_qty, quantity: values.sheet_qty,
        })),
    };
}

// Kiểm tra lại trước khi ghi phiếu và cập nhật trạng thái phân bổ.
async function send(allocationId, { actorId, slotCode, revision: expectedRevision, totalQuantity }) {
    const actor = await getActor(actorId, slotCode);
    if (typeof expectedRevision !== 'string') err('t8_receipt_preview_required');

    return db.withTransaction(async (tx) => {
        const { anchor: allocation, members } = await getGroup(allocationId, actor, slotCode, tx, true);
        if (['SEND_STOCK', 'IN_STOCK'].includes(allocation.status)) {
            return { allocationId, status: allocation.status, sheetNos: [] };
        }
        if (allocation.status !== 'WAITING_STOCK') err('lot_not_waiting_stock', 409);
        const planned = await planLines(members, tx, true);
        if (expectedRevision !== revision(allocationId, slotCode, members, planned)) err('t8_receipt_preview_stale', 409);

        if (!['number', 'string'].includes(typeof totalQuantity) ||
            !/^\d{1,20}(\.\d{1,8})?$/.test(String(totalQuantity))) err('t8_receipt_quantity_invalid');
        const maximum = totalUnits(planned);
        let remaining = quantityUnits(totalQuantity);
        if (remaining > maximum || (maximum > 0n && remaining === 0n)) err('t8_receipt_quantity_invalid');

        const byNotice = new Map();
        const resolvedSlots = new Map();
        const partial = remaining < maximum;
        // Allocate in the same stable order as the preview, keeping each T8 location.
        for (const { supplier, slotCode: lineSlotCode, warehouseCode, values } of planned) {
            if (remaining === 0n) break;
            const cap = quantityUnits(values.sheet_qty);
            const quantity = remaining < cap ? remaining : cap;
            if (!values.st_no) err('t8_warehouse_unmapped', 409);
            const slotKey = JSON.stringify([values.st_no, lineSlotCode]);
            if (!resolvedSlots.has(slotKey)) {
                const position = await t8.findActiveSlotCode(values.st_no, lineSlotCode, warehouseCode, tx);
                if (!position) err('t8_receipt_slot_invalid', 409);
                resolvedSlots.set(slotKey, position);
            }
            const group = byNotice.get(values.notice_no) || { supplier, lines: [] };
            group.lines.push({ ...values, st_bit_no: resolvedSlots.get(slotKey), sheet_qty: formatQuantity(quantity) });
            byNotice.set(values.notice_no, group);
            remaining -= quantity;
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

        const results = [];
        for (const member of members) {
            const stillWaiting = partial || !member.completeLot;
            const status = stillWaiting ? 'WAITING_STOCK' : 'SEND_STOCK';
            if (!stillWaiting) {
                const updated = await allocations.updateAllocationIqcSummary(member.id, {
                    status,
                    status_recorded_at: new Date(),
                }, tx);
                if (!updated) err('t8_receipt_allocation_update_failed', 409);
            }
            results.push({ allocationId: member.id, status });
        }
        return { allocationId, status: results.find((row) => row.allocationId === allocationId).status,
            allocations: results, sheetNos };
    });
}

module.exports = { preview, send };
