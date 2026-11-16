'use strict';

const db = require('../config/db');
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

function sameSource(source, line) {
    return source && ['sheet_no', 'goods_no', 'made_lot', 'unit_no'].every((key) =>
        source[key] === line[key]) && amount(source.requested_qty) === amount(line.qty);
}

function sameShelf(pick, line) {
    return pick.allocation_status === 'IN_STOCK' && !pick.closed_at &&
        pick.current_slot === pick.slot_code && pick.current_goods === line.goods_no &&
        pick.current_lot === line.made_lot && pick.current_unit === line.unit_no &&
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
        if (!existing) await repo.insertLine(source, tx);
        const picks = await repo.picks(id, tx);
        const reserved = picks.reduce((total, pick) => total + amount(pick.planned), 0n);
        let remaining = amount(source.requested_qty) - reserved;
        if (remaining <= 0n) return;
        const existingReceipts = new Set(picks.map((pick) => pick.allocation_receipt_id));
        const candidates = (await repo.available(source, tx))
            .filter((candidate) => !existingReceipts.has(candidate.receipt_id));
        for (const candidate of prioritizeShelves(candidates)) {
            const available = amount(candidate.available_qty);
            const qty = available < remaining ? available : remaining;
            await repo.insertPick(id, candidate, decimal(qty), tx);
            remaining -= qty;
            if (remaining === 0n) break;
        }
    });
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
        for (const allocationId of [...new Set(pending.map((pick) => pick.allocation_id))].sort()) {
            await acquireAllocationLock(allocationId, tx);
        }
        const now = new Date();
        for (const pick of (await repo.picks(id, tx)).filter((item) =>
            pending.some((old) => old.id === item.id))) {
            if (!sameShelf(pick, line)) err('outbound_shelf_changed', 409);
            if (!shared.canAccessSlot(actor, { keeperId: pick.keeper_emp_no })) err('no_permission', 403);
            await repo.confirmPick(pick.id, actor.id, now, tx);
        }
        const confirmed = (await repo.picks(id, tx)).reduce((sum, pick) => sum + amount(pick.picked), 0n);
        const status = confirmed === amount(line.qty) ? 'PICKED' : 'WAITING_PICK';
        await repo.setStatus(id, status, null, tx);
        return { status };
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

        const picks = await repo.picks(id, tx);
        const allocationIds = [...new Set(picks.map((pick) => pick.allocation_id))].sort();
        for (const allocationId of allocationIds) await acquireAllocationLock(allocationId, tx);
        const current = await repo.picks(id, tx);
        const total = current.reduce((sum, pick) => sum + amount(pick.picked), 0n);
        if (total !== amount(line.qty) || current.some((pick) => !pick.picked_at || !sameShelf(pick, line))) {
            return false;
        }

        const now = new Date();
        await repo.setStatus(id, 'COMPLETED', now, tx);
        for (const pick of current) {
            await shared.logActivity({
                userId: pick.picked_by_emp_no,
                actionKey: 'OUTBOUND_COMPLETE',
                allocationId: pick.allocation_id,
                noticeDetailId: pick.notice_detail_id,
                slotCode: pick.slot_code,
                qty: Number(pick.picked),
                unit: line.unit_no,
                detail: JSON.stringify({ sheetNo: line.sheet_no, goodsNo: line.goods_no,
                    madeLot: line.made_lot, sourceDetailId: id }),
            }, tx);
        }
        for (const allocationId of allocationIds) await repo.closeEmptyAllocation(allocationId, now, tx);
        return true;
    });
}

async function notifications(actor) {
    const rows = await repo.listNotifications(actor);
    const sheets = new Map();
    for (const row of rows) {
        if (!sheets.has(row.sheet_no)) sheets.set(row.sheet_no, new Map());
        const lines = sheets.get(row.sheet_no);
        if (!lines.has(row.scm_out_detail_id)) {
            lines.set(row.scm_out_detail_id, {
                id: row.scm_out_detail_id,
                goodsNo: row.goods_no,
                madeLot: row.made_lot,
                unit: row.unit_no,
                requestedQty: Number(row.requested_qty),
                shortageQty: Math.max(0, Number(row.requested_qty) - Number(row.total_planned_qty)),
                status: row.status,
                createdAt: row.created_at,
                picks: [],
            });
        }
        if (row.pick_id != null) lines.get(row.scm_out_detail_id).picks.push({
            id: String(row.pick_id),
            allocationId: row.allocation_id,
            shelfCode: row.slot_code,
            plannedQty: Number(row.planned_qty),
            pickedQty: row.picked_qty == null ? null : Number(row.picked_qty),
            pickedAt: row.picked_at,
            availableQty: Number(row.available_qty),
        });
    }
    return [...sheets].map(([sheetNo, lines]) => ({ sheetNo, lines: [...lines.values()] }));
}

module.exports = { plan, confirm, complete, notifications };
