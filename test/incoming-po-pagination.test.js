'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');

test('incoming PO counts separately and paginates the result', async (t) => {
    t.mock.method(db, 'getMode', () => 'sqlserver');
    t.mock.method(db, 'getDialect', () => 'mssql');
    const { PoModel } = require('../src/modules/po/po.repository');
    const repo = new PoModel();
    const item = { id: '41', poNumber: 'PO' };
    const query = t.mock.method(db, 'query', async (sql) => ({
        rows: /SELECT COUNT_BIG\(\*\)/.test(sql) ? [{ total: 42 }] : [item],
    }));

    assert.deepEqual(await repo.listPaged(3, 20), { rows: [item], total: 42 });
    const [count, page] = query.mock.calls;
    assert.equal(query.mock.callCount(), 2);
    assert.doesNotMatch(count.arguments[0], /pur_notice|pur_in2|bas_goods|whs_slot_allocation/);
    assert.doesNotMatch(page.arguments[0], /COUNT_BIG\(\*\) OVER|pur_notice/);
    assert.match(page.arguments[0], /OFFSET \? ROWS FETCH NEXT \? ROWS ONLY/);
    assert.deepEqual(page.arguments[1], [40, 20]);
    const filter = count.arguments[0].split(' FROM pur_order2')[1].trim().replace(/;$/, '');
    assert.ok(page.arguments[0].includes(filter));

    assert.deepEqual(await repo.listPaged(4, 20), { rows: [], total: 42 });
    assert.equal(query.mock.callCount(), 3);
    assert.deepEqual(await repo.list(), [item]);
    assert.doesNotMatch(query.mock.calls[3].arguments[0], /pur_notice|OFFSET/);
});
