'use strict';

const db = require('../../config/db');
const { TABLES: t } = require('./tables');

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

async function find(code, query) {
    const hint = db.getDialect() === 'pg' ? '' : 'WITH (UPDLOCK, HOLDLOCK)';
    const { rows } = await query(`
        SELECT st_no, st_bit_no FROM ${t.stBits} ${hint} WHERE st_bit_no = ?
    `, [code]);
    return rows;
}

async function insert(slot, stNo, actorId, query) {
    await query(`
        INSERT INTO ${t.stBits}
            (st_no, st_bit_no, st_bit_name, act_sw, modify_date, modify_user, def06)
        VALUES (?, ?, ?, ?, ?, ?, 0)
    `, [stNo, slot.code, slot.code, slot.active ? '1' : '0', new Date(), actorId]);
}

async function update(slot, stNo, actorId, query) {
    await query(`
        UPDATE ${t.stBits}
        SET act_sw = ?, modify_date = ?, modify_user = ?
        WHERE st_no = ? AND st_bit_no = ?
    `, [slot.active ? '1' : '0', new Date(), actorId, stNo, slot.code]);
}

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

async function remove(stNo, code, query) {
    await query(`DELETE FROM ${t.stBits} WHERE st_no = ? AND st_bit_no = ?`, [stNo, code]);
}

module.exports = { lock, find, insert, update, hasReferences, remove };
