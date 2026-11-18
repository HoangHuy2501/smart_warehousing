'use strict';

const db = require('../../config/db');
const { TABLES: t } = require('./tables');

const source = `
    SELECT d.id, d.sheet_no, d.goods_no, d.made_lot, d.unit_no,
           CAST(d.sheet_qty AS VARCHAR(40)) AS requested_qty,
           h.def03, h.sheet_sta, h.rem
    FROM ${t.out2} d JOIN ${t.out1} h ON h.sheet_no = d.sheet_no
`;

async function discover(since, after, limit) {
    const { rows } = await db.query(`
        ${source}
        WHERE LEFT(h.rem, 3) = N'已下达' AND h.create_date >= ?
          AND d.id > ? AND d.made_lot IS NOT NULL AND LTRIM(RTRIM(d.made_lot)) <> ''
          AND d.sheet_qty > 0 AND d.unit_no IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM ${t.outboundLine} l
              WHERE l.scm_out_detail_id = d.id
                AND (l.status <> 'WAITING_PICK' OR l.requested_qty <= COALESCE((
                    SELECT SUM(p.planned_qty) FROM ${t.outboundPick} p
                    WHERE p.scm_out_detail_id = l.scm_out_detail_id
                ), 0))
          )
        ORDER BY d.id OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY
    `, [since, after, limit]);
    return rows;
}

async function ready(after, limit) {
    const { rows } = await db.query(`
        SELECT l.scm_out_detail_id
        FROM ${t.outboundLine} l
        WHERE l.status = 'PICKED' AND l.scm_out_detail_id > ?
        ORDER BY l.scm_out_detail_id OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY
    `, [after, limit]);
    return rows.map((row) => row.scm_out_detail_id);
}

async function lock(tx) {
    if (db.getDialect() === 'pg') {
        await tx('SELECT pg_advisory_xact_lock(9203, 1)');
        return;
    }
    await tx(`
        DECLARE @result INT;
        EXEC @result = sys.sp_getapplock @Resource = 'whs-outbound',
            @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @result < 0 THROW 50001, 'outbound_lock_timeout', 1;
    `);
}

async function findSource(id, tx) {
    const { rows } = await tx(`${source} WHERE d.id = ?`, [id]);
    return rows.length === 1 ? rows[0] : null;
}

async function findLine(id, tx) {
    const { rows } = await tx(`
        SELECT *, CAST(requested_qty AS VARCHAR(40)) AS qty
        FROM ${t.outboundLine} WHERE scm_out_detail_id = ?
    `, [id]);
    return rows[0];
}

async function insertLine(row, tx) {
    await tx(`INSERT INTO ${t.outboundLine}
        (scm_out_detail_id, sheet_no, goods_no, made_lot, unit_no, requested_qty, created_at)
        VALUES (?, ?, ?, ?, ?, CAST(? AS DECIMAL(18,8)), ?)`,
    [row.id, row.sheet_no, row.goods_no, row.made_lot, row.unit_no, row.requested_qty, new Date()]);
}

async function available(line, tx) {
    const { rows } = await tx(`
        WITH candidates AS (
            SELECT r.id AS receipt_id, a.id AS allocation_id, a.slot_code,
                   r.qty_in_stock, a.allocated_at
            FROM ${t.receipt} r
            JOIN ${t.allocation} a ON a.id = r.allocation_id
            JOIN ${t.notice2} n ON n.id = r.notice_detail_id
            JOIN ${t.slots} s ON s.code = a.slot_code
            WHERE a.status = 'IN_STOCK' AND a.closed_at IS NULL AND s.active = ?
              AND a.goods_no = ? AND r.lot_no = ? AND n.unit_no = ?
        ), used AS (
            SELECT p.allocation_receipt_id, SUM(COALESCE(p.picked_qty, p.planned_qty)) AS qty
            FROM ${t.outboundPick} p
            JOIN candidates c ON c.receipt_id = p.allocation_receipt_id
            GROUP BY p.allocation_receipt_id
        )
        SELECT c.receipt_id, c.allocation_id, c.slot_code,
            CAST(c.qty_in_stock - CAST(COALESCE(u.qty, 0) AS DECIMAL(18,8)) AS VARCHAR(40)) AS available_qty
        FROM candidates c
        LEFT JOIN used u ON u.allocation_receipt_id = c.receipt_id
        WHERE c.qty_in_stock > COALESCE(u.qty, 0)
        ORDER BY (c.qty_in_stock - CAST(COALESCE(u.qty, 0) AS DECIMAL(18,8))) DESC,
                 c.allocated_at, c.receipt_id
    `, [true, line.goods_no, line.made_lot, line.unit_no]);
    return rows;
}

async function insertPick(id, candidate, qty, tx) {
    await tx(`INSERT INTO ${t.outboundPick}
        (scm_out_detail_id, allocation_receipt_id, allocation_id, slot_code, planned_qty)
        VALUES (?, ?, ?, ?, CAST(? AS DECIMAL(18,8)))`,
    [id, candidate.receipt_id, candidate.allocation_id, candidate.slot_code, qty]);
}

async function picks(id, tx) {
    const { rows } = await tx(`
        SELECT p.*, CAST(p.planned_qty AS VARCHAR(40)) AS planned,
               CAST(p.picked_qty AS VARCHAR(40)) AS picked, s.keeper_emp_no,
               a.status AS allocation_status, a.closed_at, a.slot_code AS current_slot,
               a.goods_no AS current_goods, r.lot_no AS current_lot, n.unit_no AS current_unit,
               r.notice_detail_id, CAST(r.qty_in_stock AS VARCHAR(40)) AS stock_qty,
               CAST((
                   SELECT SUM(COALESCE(other.picked_qty, other.planned_qty))
                   FROM ${t.outboundPick} other
                   WHERE other.allocation_receipt_id = r.id
               ) AS VARCHAR(40)) AS committed_qty
        FROM ${t.outboundPick} p
        LEFT JOIN ${t.allocation} a ON a.id = p.allocation_id
        LEFT JOIN ${t.receipt} r ON r.id = p.allocation_receipt_id AND r.allocation_id = a.id
        LEFT JOIN ${t.notice2} n ON n.id = r.notice_detail_id
        LEFT JOIN ${t.slots} s ON s.code = a.slot_code
        WHERE p.scm_out_detail_id = ? ORDER BY p.id
    `, [id]);
    return rows;
}

async function confirmPick(id, employee, now, tx) {
    await tx(`UPDATE ${t.outboundPick} SET picked_qty = planned_qty, picked_at = ?, picked_by_emp_no = ?
        WHERE id = CAST(? AS BIGINT) AND picked_at IS NULL`, [now, employee, String(id)]);
}

async function setStatus(id, status, completedAt, tx) {
    await tx(`UPDATE ${t.outboundLine} SET status = ?, completed_at = ?
        WHERE scm_out_detail_id = ?`, [status, completedAt, id]);
}

async function debitAllocationStock(id, qty, tx) {
    const output = db.getDialect() === 'pg' ? '' : 'OUTPUT inserted.id';
    const returning = db.getDialect() === 'pg' ? 'RETURNING id' : '';
    const { rows } = await tx(`
        UPDATE ${t.allocation}
        SET qty_in_stock = qty_in_stock - CAST(? AS DECIMAL(18,8))
        ${output}
        WHERE id = ? AND status = 'IN_STOCK' AND closed_at IS NULL
          AND qty_in_stock >= CAST(? AS DECIMAL(18,8))
        ${returning}
    `, [qty, id, qty]);
    return rows.length === 1;
}

async function closeEmptyAllocation(id, now, tx) {
    await tx(`UPDATE ${t.allocation} SET closed_at = ?
        WHERE id = ? AND status = 'IN_STOCK' AND closed_at IS NULL
          AND qty_in_stock = 0 AND COALESCE(qty_return, 0) = 0`, [now, id]);
}

async function listNotifications(actor) {
    const scope = actor.role === 'MANAGER' ? '' : 'AND p.id IS NOT NULL AND (s.keeper_emp_no = ? OR s.keeper_emp_no IS NULL)';
    const { rows } = await db.query(`
        SELECT l.scm_out_detail_id, l.sheet_no, l.goods_no, l.made_lot,
               l.unit_no, l.requested_qty, l.status, l.created_at,
               p.id AS pick_id, p.slot_code, p.allocation_id, p.planned_qty, p.picked_qty, p.picked_at,
               COALESCE(totals.planned_qty, 0) AS total_planned_qty,
               COALESCE(r.qty_in_stock - CAST(used.used_qty AS DECIMAL(18,8)), 0) AS available_qty
        FROM ${t.outboundLine} l
        LEFT JOIN ${t.outboundPick} p ON p.scm_out_detail_id = l.scm_out_detail_id
        LEFT JOIN ${t.slots} s ON s.code = p.slot_code
        LEFT JOIN ${t.receipt} r ON r.id = p.allocation_receipt_id
        LEFT JOIN (
            SELECT scm_out_detail_id, SUM(planned_qty) AS planned_qty
            FROM ${t.outboundPick} GROUP BY scm_out_detail_id
        ) totals ON totals.scm_out_detail_id = l.scm_out_detail_id
        LEFT JOIN (
            SELECT allocation_receipt_id, SUM(COALESCE(picked_qty, planned_qty)) AS used_qty
            FROM ${t.outboundPick} GROUP BY allocation_receipt_id
        ) used ON used.allocation_receipt_id = r.id
        WHERE l.completed_at IS NULL ${scope}
        ORDER BY l.created_at DESC, l.scm_out_detail_id, p.id
    `, actor.role === 'MANAGER' ? [] : [actor.id]);
    return rows;
}

async function quantitiesByAllocation(ids) {
    const result = new Map();
    for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        const { rows } = await db.query(`
            SELECT p.allocation_id,
                SUM(p.planned_qty) AS reserved_qty
            FROM ${t.outboundPick} p
            JOIN ${t.outboundLine} l ON l.scm_out_detail_id = p.scm_out_detail_id
            WHERE l.completed_at IS NULL AND p.picked_at IS NULL
              AND p.allocation_id IN (${chunk.map(() => '?').join(', ')})
            GROUP BY p.allocation_id
        `, chunk);
        for (const row of rows) result.set(row.allocation_id, row);
    }
    return result;
}

module.exports = {
    discover, ready, lock, findSource, findLine, insertLine, available, insertPick,
    picks, confirmPick, setStatus, debitAllocationStock, closeEmptyAllocation, listNotifications, quantitiesByAllocation,
};
