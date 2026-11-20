'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const log = require('../src/repository/sql/t8-operation-log.repository');

const names = ['user_no', 'log_desc', 'modify_date', 'oper_type', 'win_desc', 'win_name', 'extra_field'];

for (const [operation, operType] of [['insert', '新增行'], ['update', '修改'], ['delete', '删除行']]) {
    test('records ' + operation + ' with SQL Server time and NULL for remaining writable fields', async (t) => {
        t.mock.method(db, 'getDialect', () => 'mssql');
        const calls = [];
        const query = async (sql, params) => {
            calls.push({ sql, params });
            return { rows: calls.length === 1 ? names.map((name) => ({ name })) : [] };
        };
        const description = "UPDATE bas_st_bit SET st_bit_name=N'Smart-Warehousing';";
        await log.insert({ employeeNo: 'TEST-IT', tableName: 'bas_st_bit', operation, description }, query);
        assert.equal(calls.length, 2);
        assert.match(calls[0].sql, /is_identity = 0 AND is_computed = 0/);
        assert.match(calls[1].sql, /GETDATE\(\)/);
        assert.match(calls[1].sql, /\[extra_field\]/);
        assert.match(calls[1].sql, /, NULL\)/);
        assert.deepEqual(calls[1].params, ['ADM', description, operType, 'smart-warehousing', 'w_bas_st_bit']);
        assert.equal(calls[1].sql.includes(description), false);
    });
}

test('preserves ordinary employee codes and lower-case TEST codes follow the ADM rule', async (t) => {
    t.mock.method(db, 'getDialect', () => 'mssql');
    for (const [employeeNo, expected] of [['NV0123', 'NV0123'], ['test001', 'ADM']]) {
        let recorded;
        const query = async (sql, params) => {
            if (sql.includes('INSERT INTO')) recorded = params;
            return { rows: names.map((name) => ({ name })) };
        };
        await log.insert({ employeeNo, tableName: 'bas_st_bit', operation: 'insert', description: 'INSERT ...' }, query);
        assert.equal(recorded[0], expected);
    }
});

test('escapes values in human-readable SQL audit descriptions', () => {
    assert.equal(log.literal("A'B"), "N'A''B'");
    assert.equal(log.literal(null), 'NULL');
    assert.equal(log.literal('Smart-Warehousing'), "N'Smart-Warehousing'");
});

test('rejects incompatible log schemas before writing an incomplete audit row', async () => {
    let writes = 0;
    const query = async (sql) => {
        if (sql.includes('INSERT INTO')) writes += 1;
        return { rows: [{ name: 'user_no' }] };
    };
    await assert.rejects(log.insert({
        employeeNo: 'NV0123', tableName: 'bas_st_bit', operation: 'insert', description: 'INSERT ...',
    }, query), /t8_oper_log_schema_unavailable/);
    assert.equal(writes, 0);
});
