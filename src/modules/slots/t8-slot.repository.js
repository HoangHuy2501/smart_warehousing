'use strict';

const db = require('../../config/db');
const { TABLES: t } = require('../../config/tables');
const operationLog = require('../t8/t8-operation-log.repository');

// Khóa mã vị trí T8 trước khi tạo hoặc sửa.
async function lock(code, query) {
    if (db.getDialect() === 'pg') {
        await query('SELECT pg_advisory_xact_lock(hashtext(?))', ['whs-slot:' + code]);
        return;
    }
    await query(`
        DECLARE @result INT;
        EXEC @result = sys.sp_getapplock @Resource = ?,
            @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
        IF @result < 0 THROW 50001, 'slot_lock_timeout', 1;
    `, ['whs-slot:' + code]);
}

// Tra vị trí kệ theo mã trên T8.
async function find(code, query) {
    const hint = db.getDialect() === 'pg' ? '' : 'WITH (UPDLOCK, HOLDLOCK)';
    const { rows } = await query(`
        SELECT st_no, st_bit_no FROM ${t.stBits} ${hint} WHERE st_bit_no = ?
    `, [code]);
    return rows;
}

// Thêm vị trí kệ mới vào danh mục T8.
async function insert(slot, stNo, modifyUser, query) {
    const now = db.getDialect() === 'pg' ? 'CURRENT_TIMESTAMP' : 'GETDATE()';
    await query(`
        INSERT INTO ${t.stBits}
            (st_no, st_bit_no, st_bit_name, act_sw, modify_date, modify_user, def06)
        VALUES (?, ?, ?, '1', ${now}, ?, 0)
    `, [stNo, slot.code, 'Smart-Warehousing', modifyUser]);
    const value = operationLog.literal;
    await operationLog.insert({
        employeeNo: modifyUser,
        tableName: 'bas_st_bit',
        operation: 'insert',
        description: `INSERT INTO bas_st_bit (st_no, st_bit_no, st_bit_name, act_sw, modify_date, modify_user, def06) VALUES (${value(stNo)}, ${value(slot.code)}, N'Smart-Warehousing', '1', GETDATE(), ${value(modifyUser)}, 0);`,
    }, query);
}

// Cập nhật mã vị trí kệ trên T8.
async function rename(oldCode, newCode, stNo, modifyUser, query) {
    const now = db.getDialect() === 'pg' ? 'CURRENT_TIMESTAMP' : 'GETDATE()';
    await query(`
        UPDATE ${t.stBits}
        SET st_bit_no = ?, st_bit_name = ?, modify_date = ${now}, modify_user = ?
        WHERE st_no = ? AND st_bit_no = ?
    `, [newCode, 'Smart-Warehousing', modifyUser, stNo, oldCode]);
    const value = operationLog.literal;
    await operationLog.insert({
        employeeNo: modifyUser,
        tableName: 'bas_st_bit',
        operation: 'update',
        description: `UPDATE bas_st_bit SET st_bit_no = ${value(newCode)}, st_bit_name = N'Smart-Warehousing', modify_date = GETDATE(), modify_user = ${value(modifyUser)} WHERE st_no = ${value(stNo)} AND st_bit_no = ${value(oldCode)};`,
    }, query);
}

// Kiểm tra có dữ liệu đang tham chiếu đến kệ.
async function hasReferences(stNo, code, query) {
    const { rows } = await query(`
        SELECT 1 AS found WHERE EXISTS (
            SELECT 1 FROM ${t.goods} WHERE st_no = ? AND st_bit_no = ?
        ) OR EXISTS (
            SELECT 1 FROM ${t.in2} WHERE st_no = ? AND st_bit_no = ?
        ) OR EXISTS (
            SELECT 1 FROM ${t.out2} WHERE st_no = ? AND st_bit_no = ?
        )
    `, [stNo, code, stNo, code, stNo, code]);
    return rows.length > 0;
}

module.exports = { lock, find, insert, rename, hasReferences };
