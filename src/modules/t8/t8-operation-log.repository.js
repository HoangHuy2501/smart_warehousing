'use strict';

const db = require('../../config/db');
const { TABLES: t } = require('../../config/tables');

const OPER_TYPES = { insert: '新增行', update: '修改', delete: '删除行' };
const LOG_COLUMNS = ['user_no', 'log_desc', 'modify_date', 'oper_type', 'win_desc', 'win_name'];

const { literal } = require('../../util/sql-audit');

// Ghi thao tác thay đổi dữ liệu vào nhật ký T8.
async function insert({ employeeNo, tableName, operation, description }, query) {
    const operType = OPER_TYPES[operation];
    if (!operType) throw new Error('t8_oper_log_invalid_operation');
    const pg = db.getDialect() === 'pg';
    const metadataSql = pg ? `
        SELECT attname AS name
        FROM pg_attribute
        WHERE attrelid = to_regclass(?) AND attnum > 0 AND NOT attisdropped
          AND attidentity = '' AND attgenerated = ''
        ORDER BY attnum
    ` : `
        SELECT name FROM sys.columns
        WHERE object_id = OBJECT_ID(?) AND is_identity = 0 AND is_computed = 0
          AND system_type_id <> 189
        ORDER BY column_id
    `;
    const { rows } = await query(metadataSql, [t.operLog]);
    const names = new Set(rows.map((row) => row.name.toLowerCase()));
    if (LOG_COLUMNS.some((column) => !names.has(column))) {
        throw new Error('t8_oper_log_schema_unavailable');
    }
    const extraColumns = rows.map((row) => row.name)
        .filter((name) => !LOG_COLUMNS.includes(name.toLowerCase()));
    const quote = pg
        ? (name) => '"' + name.replace(/"/g, '""') + '"'
        : (name) => '[' + name.replace(/]/g, ']]') + ']';
    const columns = [...LOG_COLUMNS, ...extraColumns].map(quote).join(', ');
    const now = pg ? 'CURRENT_TIMESTAMP' : 'GETDATE()';
    const nulls = extraColumns.map(() => ', NULL').join('');
    const empNo = String(employeeNo).trim();
    const userNo = empNo.slice(0, 4).toUpperCase() === 'TEST' ? 'ADM' : empNo;
    await query(`
        INSERT INTO ${t.operLog} (${columns})
        VALUES (?, ?, ${now}, ?, ?, ?${nulls})
    `, [userNo, description, operType, 'smart-warehousing', 'w_' + tableName]);
}

module.exports = { insert, literal };
