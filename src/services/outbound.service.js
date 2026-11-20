'use strict';

const db = require('../config/db');
const audit = require('../util/sql-audit');
const repo = require('../repository/sql/outbound.repository');
const { acquireAllocationLock } = require('../repository/sql/receipt-sync.repository');
const { err, shared } = require('./shared');

const SCALE = 100000000n;

function amount(value) {
    const [whole, fraction = ''] = String(value ?? 0).split('.');
    return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, '0'));
}

function decimal(value) {
    return `${value / SCALE}.${String(value % SCALE).padStart(8, '0')}`;
}

function stockQuantity(line) {
    const quantity = amount(line.requested_qty ?? line.qty);
    if (!line.stock_unit || line.stock_unit.trim() === line.unit_no?.trim()) return quantity;
    const rate = amount(line.pur_unit_rate);
    if (rate <= 0n) err('outbound_invalid_pur_unit_rate', 409);
    const rounded = (quantity * 1000n + rate / 2n) / rate;
    if (rounded <= 0n) err('outbound_invalid_converted_qty', 409);
    return rounded * (SCALE / 1000n);
}

function outboundShortage(line) {
    const remaining = stockQuantity(line) - amount(line.total_planned_qty);
    if (remaining <= 0n) return 0;
    const rate = line.stock_unit && line.stock_unit.trim() !== line.unit_no?.trim()
        ? amount(line.pur_unit_rate) : SCALE;
    return Number((remaining * rate / SCALE + 50000n) / 100000n) / 1000;
}

function sameSource(source, line) {
    return source && ['sheet_no', 'goods_no', 'made_lot', 'unit_no'].every((key) =>
        source[key] === line[key]) && amount(source.requested_qty) === amount(line.qty);
}

function sameShelf(pick, line) {
    return pick.allocation_status === 'IN_STOCK' && !pick.closed_at &&
        pick.current_slot === pick.slot_code && pick.current_goods === line.goods_no &&
        pick.current_lot === line.made_lot && pick.current_unit?.trim() === (line.stock_unit || line.unit_no)?.trim() &&
        amount(pick.stock_qty) >= amount(pick.committed_qty);
}

function prioritizeShelves(candidates) {
    const shelves = new Map();
    for (const candidate of candidates) {
        if (!shelves.has(candidate.slot_code)) shelves.set(candidate.slot_code, { total: 0n, receipts: [] });
        const shelf = shelves.get(candidate.slot_code);
        shelf.total += amount(candidate.available_qty);
        shelf.receipts.push(candidate);
    }
    return [...shelves.values()]
        .sort((a, b) => a.total === b.total ? 0 : a.total > b.total ? -1 : 1)
        .flatMap((shelf) => shelf.receipts);
}

async function plan(source) {
    return db.withTransaction(async (tx) => {
        await repo.lock(tx);
        const id = source.id;
        const latest = await repo.findSource(id, tx);
        if (!latest?.rem?.startsWith('已下达') ||
            !sameSource(latest, { ...source, qty: source.requested_qty })) return;
        const existing = await repo.findLine(id, tx);
        if (existing && (existing.status !== 'WAITING_PICK' || !sameSource(source, existing))) return;
        if (!latest.stock_unit) return false;
        const required = stockQuantity(latest);
        const candidates = await repo.available(latest, tx);
        if (!existing && !candidates.length) return false;
        if (!existing) await repo.insertLine(source, tx);
        const picks = await repo.picks(id, tx);
        const reserved = picks.reduce((total, pick) => total + amount(pick.planned), 0n);
        let remaining = required - reserved;
        if (remaining <= 0n) return !existing;
        const existingReceipts = new Set(picks.map((pick) => pick.allocation_receipt_id));
        const unreservedCandidates = candidates.filter((candidate) => !existingReceipts.has(candidate.receipt_id));
        const initialRemaining = remaining;
        const allocationRemaining = new Map();
        for (const candidate of prioritizeShelves(unreservedCandidates)) {
            if (!allocationRemaining.has(candidate.allocation_id)) {
                allocationRemaining.set(candidate.allocation_id, amount(candidate.allocation_available_qty));
            }
            const stock = allocationRemaining.get(candidate.allocation_id);
            const receiptAvailable = amount(candidate.available_qty);
            const available = receiptAvailable < stock ? receiptAvailable : stock;
            if (available <= 0n) continue;
            const qty = available < remaining ? available : remaining;
            await repo.insertPick(id, candidate, decimal(qty), tx);
            remaining -= qty;
            allocationRemaining.set(candidate.allocation_id, stock - qty);
            if (remaining === 0n) break;
        }
        return !existing || remaining < initialRemaining;
    });
}

function logOutboundPick(line, pick, actionKey, userId, qty, actedAt, detail, tx) {
    const statements = actionKey === 'OUTBOUND_PICK_CONFIRMED' ? [
        audit.update('whs_slot_allocation', { qty_in_stock: detail.stockAfter }, { id: pick.allocation_id }),
        audit.update('whs_outbound_pick', {
            picked_qty: qty, picked_at: actedAt, picked_by_emp_no: userId,
        }, { id: String(pick.id), picked_at: null }),
    ] : [
        audit.update('whs_outbound_line', {
            status: 'COMPLETED', completed_at: detail.completedAt,
        }, { scm_out_detail_id: line.scm_out_detail_id }),
    ];
    return shared.logActivity({
        userId,
        actedAt,
        actionKey,
        allocationId: pick.allocation_id,
        noticeDetailId: pick.notice_detail_id,
        slotCode: pick.slot_code,
        qty: Number(qty),
        unit: line.stock_unit || line.unit_no,
        detail: [...statements, audit.context({
            sheetNo: line.sheet_no,
            sourceDetailId: line.scm_out_detail_id,
            pickId: String(pick.id),
            allocationReceiptId: pick.allocation_receipt_id,
            goodsNo: line.goods_no,
            madeLot: line.made_lot,
            unit: line.unit_no,
            requestedQty: line.qty,
            stockUnit: line.stock_unit || line.unit_no,
            purUnitRate: line.pur_unit_rate,
            stockRequestedQty: decimal(stockQuantity(line)),
            plannedQty: pick.planned,
            pickedQty: qty,
            ...detail,
        })].join('\n'),
    }, tx);
}

async function confirm(id, actor) {
    return db.withTransaction(async (tx) => {
        await repo.lock(tx);
        const line = await repo.findLine(id, tx);
        if (!line) err('outbound_not_found', 404);
        const picks = await repo.picks(id, tx);
        const scoped = picks.filter((pick) => shared.canAccessSlot(actor, { keeperId: pick.keeper_emp_no }));
        if (!scoped.length) err('no_permission', 403);
        if (line.status !== 'WAITING_PICK') return { status: line.status };
        const pending = scoped.filter((pick) => pick.picked_at == null);
        if (!pending.length) return { status: line.status };
        if (!sameSource(await repo.findSource(id, tx), line)) err('outbound_shelf_changed', 409);
        const allocationIds = [...new Set(pending.map((pick) => pick.allocation_id))].sort();
        for (const allocationId of allocationIds) {
            await acquireAllocationLock(allocationId, tx);
        }
        const now = new Date();
        for (const pick of (await repo.picks(id, tx)).filter((item) =>
            pending.some((old) => old.id === item.id))) {
            if (!sameShelf(pick, line)) err('outbound_shelf_changed', 409);
            if (!shared.canAccessSlot(actor, { keeperId: pick.keeper_emp_no })) err('no_permission', 403);
            const stockAfter = await repo.debitAllocationStock(pick.allocation_id, pick.planned, tx);
            if (stockAfter == null) err('outbound_shelf_changed', 409);
            await repo.confirmPick(pick.id, actor.id, now, tx);
            await logOutboundPick(line, pick, 'OUTBOUND_PICK_CONFIRMED', actor.id, pick.planned, now, {
                pickedAt: now,
                stockBefore: decimal(amount(stockAfter) + amount(pick.planned)),
                stockAfter,
            }, tx);
        }
        for (const allocationId of allocationIds) await repo.closeEmptyAllocation(allocationId, now, tx);
        const confirmed = (await repo.picks(id, tx)).reduce((sum, pick) => sum + amount(pick.picked), 0n);
        const status = confirmed === stockQuantity(line) ? 'PICKED' : 'WAITING_PICK';
        await repo.setStatus(id, status, null, tx);
        return { status, changed: true };
    });
}

async function removeDeletedWaitingLine(id) {
    return db.withTransaction(async (tx) => {
        await repo.lock(tx);
        if (!await repo.isMissingWaitingLine(id, tx)) return false;

        await repo.deleteLine(id, tx);
        return true;
    });
}

async function complete(id) {
    return db.withTransaction(async (tx) => {
        await repo.lock(tx);
        const line = await repo.findLine(id, tx);
        if (line?.status !== 'PICKED') return false;
        const source = await repo.findSource(id, tx);
        if (!sameSource(source, line) || source.def03?.trim() !== '已打印' || String(source.sheet_sta) !== '1') {
            return false;
        }

        const current = await repo.picks(id, tx);
        const total = current.reduce((sum, pick) => sum + amount(pick.picked), 0n);
        if (total !== stockQuantity(line) || current.some((pick) => !pick.picked_at || !pick.picked_by_emp_no)) {
            return false;
        }

        const now = new Date();
        await repo.setStatus(id, 'COMPLETED', now, tx);
        for (const pick of current) {
            await logOutboundPick(line, pick, 'OUTBOUND_COMPLETE', pick.picked_by_emp_no, pick.picked, now, {
                pickedAt: pick.picked_at,
                completedAt: now,
                printStatus: source.def03.trim(),
                approvalStatus: String(source.sheet_sta),
                completedBy: 'outbound-completion',
            }, tx);
        }
        return true;
    });
}

async function notifications(actor, sheetNo) {
    const rows = await repo.listNotifications(actor, sheetNo);
    const sheets = new Map();
    for (const row of rows) {
        if (!sheets.has(row.sheet_no)) sheets.set(row.sheet_no, new Map());
        const lines = sheets.get(row.sheet_no);
        if (!lines.has(row.scm_out_detail_id)) {
            lines.set(row.scm_out_detail_id, {
                id: row.scm_out_detail_id,
                goodsNo: row.goods_no,
                materialName: row.material_name?.trim() || null,
                poNumbers: [],
                madeLot: row.made_lot,
                unit: row.unit_no,
                requestedQty: Number(row.requested_qty),
                shortageQty: outboundShortage(row),
                stockUnit: row.stock_unit || row.unit_no,
                stockRequestedQty: Number(decimal(stockQuantity(row))),
                status: row.status,
                createdAt: row.created_at,
                canConfirm: false,
                picks: [],
            });
        }
        const line = lines.get(row.scm_out_detail_id);
        const poNumber = row.po_number?.trim() || null;
        if (poNumber && !line.poNumbers.includes(poNumber)) line.poNumbers.push(poNumber);
        if (row.pick_id != null) {
            const canConfirm = row.status === 'WAITING_PICK' && row.picked_at == null &&
                row.existing_slot_code != null && shared.canAccessSlot(actor, { keeperId: row.keeper_emp_no });
            line.canConfirm ||= canConfirm;
            line.picks.push({
                id: String(row.pick_id),
                allocationId: row.allocation_id,
                shelfCode: row.slot_code,
                poNumber,
                unit: row.stock_unit || row.unit_no,
                plannedQty: Number(row.planned_qty),
                pickedQty: row.picked_qty == null ? null : Number(row.picked_qty),
                pickedAt: row.picked_at,
                availableQty: Number(row.available_qty),
                canConfirm,
            });
        }
    }
    return [...sheets].map(([sheetNo, lines]) => ({ sheetNo, lines: [...lines.values()] }));
}

module.exports = { plan, confirm, complete, notifications, removeDeletedWaitingLine };
