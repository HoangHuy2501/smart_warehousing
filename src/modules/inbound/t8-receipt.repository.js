'use strict';

const { TABLES: t } = require('../../config/tables');
const audit = require('../../util/sql-audit');
const operationLog = require('../t8/t8-operation-log.repository');

async function findWaitingPeers(anchorId, query) {
    const { rows } = await query(`
        SELECT DISTINCT a.id
        FROM ${t.allocation} a
        JOIN ${t.allocation} anchor ON anchor.id = ?
        JOIN ${t.receipt} r ON r.allocation_id = a.id
        JOIN ${t.receipt} seed ON seed.allocation_id = anchor.id
            AND seed.lot_no = r.lot_no AND seed.qty_in_stock > 0
        WHERE a.status = 'WAITING_STOCK' AND a.closed_at IS NULL
          AND a.goods_no = anchor.goods_no AND r.qty_in_stock > 0
          AND a.id <> anchor.id
        ORDER BY a.id
    `, [anchorId]);
    return rows.map((row) => row.id);
}

function withoutWarehousePrefix(slotCode, warehouseCode) {
    const prefix = warehouseCode + '-';
    return slotCode.startsWith(prefix) ? slotCode.slice(prefix.length) : slotCode;
}

async function findSource(noticeId, poId, goodsNo, slotCode, warehouseCode, warehouse, query) {
    const { rows } = await query(`
        SELECT n.sheet_no AS notice_no, n.sheet_id AS notice_id,
               n.pur_no, n.pur_id, n.goods_no, n.unit_no, n.unit_rate,
               n.made_lot, n.sheet_pri, n.pri_dis, n.tax_sw, n.cur_no, n.inv_type,
               n.rem, n.def02 AS def14, n.def12 AS def15, h.su_no,
               iqc.match_count, iqc.adj_result, iqc.sheet_qty, iqc.return_qty,
               COALESCE(existing.draft_qty, 0) AS draft_qty,
               COALESCE(existing.slot_qty, 0) AS slot_qty
        FROM ${t.notice2} n
        JOIN ${t.notice1} h ON h.sheet_no = n.sheet_no
        JOIN ${t.order2} po ON po.id = ? AND po.sheet_no = n.pur_no
                           AND po.sheet_id = n.pur_id AND po.goods_no = n.goods_no
        CROSS APPLY (
            SELECT COUNT(*) AS match_count, MAX(i.adj_result) AS adj_result,
                   MAX(i.sheet_qty) AS sheet_qty, COALESCE(MAX(i.return_qty), 0) AS return_qty
            FROM ${t.noticeDetailView} i
            WHERE i.sheet_no = n.sheet_no AND i.sheet_id = n.sheet_id
              AND i.pur_no = n.pur_no AND i.pur_id = n.pur_id
              AND i.goods_no = n.goods_no AND i.made_lot = n.made_lot
        ) iqc
        CROSS APPLY (
            SELECT SUM(CASE WHEN p.sheet_sta = '0' THEN d.sheet_qty ELSE 0 END) AS draft_qty,
                   SUM(CASE WHEN d.st_bit_no IN (?, ?) AND d.st_no = ? THEN d.sheet_qty ELSE 0 END) AS slot_qty
            FROM ${t.in2} d
            JOIN ${t.in1} p ON p.sheet_no = d.sheet_no
            WHERE d.notice_no = n.sheet_no AND d.notice_id = n.sheet_id
              AND d.pur_no = n.pur_no AND d.pur_id = n.pur_id
              AND d.goods_no = n.goods_no AND d.made_lot = n.made_lot
              AND d.unit_no = n.unit_no
              AND EXISTS (
                  SELECT 1 FROM ${t.userPass} u
                  WHERE u.user_no = p.create_user AND u.user_name <> 'ADM'
              )
        ) existing
        WHERE n.id = ? AND n.goods_no = ?
    `, [poId, slotCode, withoutWarehousePrefix(slotCode, warehouseCode), warehouse, noticeId, goodsNo]);
    return rows[0];
}

async function findCreator(empNo, query) {
    const { rows } = await query(`
        SELECT u.user_no, e.emp_no
        FROM ${t.userPass} u
        LEFT JOIN ${t.emps} e ON e.emp_no = u.user_no
        WHERE u.user_no = ? AND u.user_name <> 'ADM'
    `, [empNo]);
    return rows[0];
}

async function findActiveSlotCode(warehouse, slotCode, warehouseCode, query) {
    const shortCode = withoutWarehousePrefix(slotCode, warehouseCode);
    const { rows } = await query(`
        SELECT TOP (1) st_bit_no
        FROM ${t.stBits}
        WHERE st_no = CONVERT(varchar(20), ?) AND act_sw = '1'
          AND st_bit_no IN (CONVERT(varchar(20), ?), CONVERT(varchar(20), ?))
        ORDER BY CASE WHEN st_bit_no = CONVERT(varchar(20), ?) THEN 0 ELSE 1 END
    `, [warehouse, slotCode, shortCode, slotCode]);
    return rows[0]?.st_bit_no?.trim();
}

async function findOpenDraft(noticeNo, supplier, query) {
    const { rows } = await query(`
        SELECT TOP (2) h.sheet_no
        FROM ${t.in1} h WITH (UPDLOCK, HOLDLOCK)
        WHERE h.sheet_sta = '0' AND h.sheet_type = 'PIGI' AND h.su_no = ?
          AND EXISTS (
              SELECT 1 FROM ${t.userPass} u
              WHERE u.user_no = h.create_user AND u.user_name <> 'ADM'
          )
          AND EXISTS (
              SELECT 1 FROM ${t.in2} d
              WHERE d.sheet_no = h.sheet_no AND d.notice_no = ?
          )
        ORDER BY h.sheet_no
    `, [supplier, noticeNo]);
    return rows.map((row) => row.sheet_no);
}

async function nextLineId(sheetNo, query) {
    const { rows } = await query(`
        SELECT COALESCE(MAX(sheet_id), 0) + 1 AS next_id
        FROM ${t.in2} WITH (UPDLOCK, HOLDLOCK)
        WHERE sheet_no = CONVERT(varchar(20), ?)
    `, [sheetNo]);
    return rows[0].next_id;
}

async function reserveSheetNumber(query) {
    const { rows } = await query(`
        DECLARE @prefix varchar(11) = 'PSMGI' + CONVERT(char(6), GETDATE(), 12);
        DECLARE @last varchar(20);
        SELECT TOP (1) @last = sheet_no
        FROM ${t.in1} WITH (UPDLOCK, HOLDLOCK)
        WHERE sheet_no BETWEEN @prefix + '001' AND @prefix + '999'
          AND sheet_no LIKE @prefix + '[0-9][0-9][0-9]'
        ORDER BY sheet_no DESC;
        DECLARE @next int = COALESCE(CONVERT(int, RIGHT(@last, 3)), 0) + 1;
        SELECT CASE WHEN @next <= 999
                    THEN @prefix + RIGHT('000' + CONVERT(varchar(3), @next), 3)
               END AS sheet_no;
    `);
    return rows[0]?.sheet_no;
}

// Ghi audit T8 cùng transaction với phiếu nhập.
function logInsert(tableName, values, employeeNo, query) {
    return operationLog.insert({
        employeeNo, tableName, operation: 'insert',
        description: audit.insert(tableName, values),
    }, query);
}

// POST /lots/:id/t8-receipt — tạo đầu phiếu nháp.
async function insertHeader(values, employeeNo, query) {
    await query(`
        INSERT INTO ${t.in1} (
            sheet_type, sheet_no, sheet_date, su_no, emp_no,
            create_user, rem, sheet_sta, check_sta
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        values.sheet_type, values.sheet_no, values.sheet_date, values.su_no, values.emp_no,
        values.create_user, values.rem, values.sheet_sta, values.check_sta,
    ]);
    await logInsert('pur_in1', values, employeeNo, query);
}

// POST /lots/:id/t8-receipt — thêm dòng vào phiếu nháp.
async function insertLine(values, employeeNo, query) {
    await query(`
        INSERT INTO ${t.in2} (
            sheet_no, sheet_id, notice_no, notice_id, pur_no, pur_id, goods_no,
            unit_no, unit_rate, st_no, st_bit_no, made_lot, sheet_qty, sheet_pri,
            pri_dis, tax_sw, cur_no, inv_type, rem, def06, def14, def15, sheet_sta
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        values.sheet_no, values.sheet_id, values.notice_no, values.notice_id,
        values.pur_no, values.pur_id, values.goods_no, values.unit_no, values.unit_rate,
        values.st_no, values.st_bit_no, values.made_lot, values.sheet_qty, values.sheet_pri,
        values.pri_dis, values.tax_sw, values.cur_no, values.inv_type, values.rem,
        values.def06, values.def14, values.def15, values.sheet_sta,
    ]);
    await logInsert('pur_in2', values, employeeNo, query);
}

module.exports = {
    findWaitingPeers, findSource, findCreator, findActiveSlotCode, reserveSheetNumber,
    findOpenDraft, nextLineId, insertHeader, insertLine,
};
