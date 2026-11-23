'use strict';

const { TABLES: t } = require('./tables');
const audit = require('../../util/sql-audit');
const operationLog = require('./t8-operation-log.repository');

async function findSource(noticeId, query) {
    const { rows } = await query(`
        SELECT n.sheet_no AS notice_no, n.sheet_id AS notice_id,
               n.pur_no, n.pur_id, n.goods_no, n.unit_no, n.unit_rate, n.st_no,
               n.made_lot, n.sheet_pri, n.pri_dis, n.tax_sw, n.cur_no, n.inv_type,
               n.rem, n.def02 AS def14, n.def12 AS def15, h.su_no,
               iqc.match_count, iqc.adj_result, iqc.sheet_qty, iqc.return_qty,
               COALESCE(drafts.qty, 0) AS draft_qty
        FROM ${t.notice2} n
        JOIN ${t.notice1} h ON h.sheet_no = n.sheet_no
        CROSS APPLY (
            SELECT COUNT(*) AS match_count, MAX(i.adj_result) AS adj_result,
                   MAX(i.sheet_qty) AS sheet_qty, COALESCE(MAX(i.return_qty), 0) AS return_qty
            FROM ${t.noticeDetailView} i
            WHERE i.sheet_no = n.sheet_no AND i.sheet_id = n.sheet_id
              AND i.pur_no = n.pur_no AND i.pur_id = n.pur_id
              AND i.goods_no = n.goods_no AND i.made_lot = n.made_lot
        ) iqc
        CROSS APPLY (
            SELECT SUM(d.sheet_qty) AS qty
            FROM ${t.in2} d
            WHERE d.notice_no = n.sheet_no AND d.notice_id = n.sheet_id
              AND d.pur_no = n.pur_no AND d.pur_id = n.pur_id
              AND d.goods_no = n.goods_no AND d.made_lot = n.made_lot
              AND d.unit_no = n.unit_no
              AND EXISTS (
                  SELECT 1 FROM ${t.in1} p
                  JOIN ${t.userPass} u ON u.user_no = p.create_user AND u.user_name <> 'ADM'
                  WHERE p.sheet_no = d.sheet_no AND p.sheet_sta = '0'
              )
        ) drafts
        WHERE n.id = ?
    `, [noticeId]);
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

async function hasSlot(warehouse, slotCode, query) {
    const { rows } = await query(`
        SELECT 1 AS found FROM ${t.stBits}
        WHERE st_no = ? AND st_bit_no = ? AND act_sw = '1'
    `, [warehouse, slotCode]);
    return rows.length > 0;
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

async function insertRow(table, logicalName, values, employeeNo, query) {
    const fields = Object.keys(values);
    await query(`
        INSERT INTO ${table} (${fields.join(', ')})
        VALUES (${fields.map(() => '?').join(', ')})
    `, Object.values(values));
    await operationLog.insert({
        employeeNo, tableName: logicalName, operation: 'insert',
        description: audit.insert(logicalName, values),
    }, query);
}

module.exports = {
    findSource, findCreator, hasSlot, reserveSheetNumber,
    insertHeader: (values, empNo, query) => insertRow(t.in1, 'pur_in1', values, empNo, query),
    insertLine: (values, empNo, query) => insertRow(t.in2, 'pur_in2', values, empNo, query),
};
