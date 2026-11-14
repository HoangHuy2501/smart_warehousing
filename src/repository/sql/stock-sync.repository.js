'use strict';

const db = require('../../config/db');
const { TABLES } = require('./tables');

async function findCandidates(cutoff, afterId, limit) {
    const { rows } = await db.query(`
        SELECT id FROM ${TABLES.allocation}
        WHERE status = 'WAITING_STOCK' AND closed_at IS NULL
          AND (status_recorded_at IS NULL OR status_recorded_at >= ?)
          AND id > ?
        ORDER BY id
        OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY
    `, [cutoff, afterId, limit]);
    return rows.map((row) => row.id);
}

async function findNoticeCoverage(noticeDetailId, tx) {
    const { rows } = await tx(`
        SELECT
            n.made_lot AS lot_no,
            COALESCE((
                SELECT SUM(i.sheet_qty)
                FROM ${TABLES.in2} i
                WHERE i.notice_no = n.sheet_no AND i.notice_id = n.sheet_id
                  AND i.pur_no = n.pur_no AND i.pur_id = n.pur_id
                  AND i.goods_no = n.goods_no AND i.made_lot = n.made_lot
                  AND i.unit_no = n.unit_no
                  AND EXISTS (
                      SELECT 1 FROM ${TABLES.in1} h
                      WHERE h.sheet_no = i.sheet_no
                        AND h.sheet_sta <> '0' AND h.create_user <> 'ADM'
                  )
            ), 0) AS imported_qty,
            (
                SELECT SUM(r.qty_in_stock)
                FROM ${TABLES.receipt} r
                JOIN ${TABLES.allocation} a ON a.id = r.allocation_id
                WHERE r.notice_detail_id = n.id
                  AND (a.closed_at IS NULL OR a.status = 'IN_STOCK')
            ) AS required_qty,
            (
                SELECT COUNT(*)
                FROM ${TABLES.receipt} r
                JOIN ${TABLES.allocation} a ON a.id = r.allocation_id
                WHERE r.notice_detail_id = n.id AND a.closed_at IS NULL
                  AND (r.qty_in_stock IS NULL OR a.status = 'WAITING_IQC' OR r.has_warning = ?
                    OR a.has_warning = ?)
            ) AS unresolved_count
        FROM ${TABLES.notice2} n
        WHERE n.id = ?
    `, [true, true, noticeDetailId]);
    return rows[0] || null;
}

module.exports = { findCandidates, findNoticeCoverage };
