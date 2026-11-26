'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');

test('PO ETA totals use the same filters as the list without page limits', async (t) => {
    t.mock.method(db, 'getMode', () => 'sqlserver');
    t.mock.method(db, 'getDialect', () => 'mssql');
    const { PoModel } = require('../src/modules/po/po.repository');
    const repo = new PoModel();
    const calls = [];
    t.mock.method(db, 'query', async (sql, params = []) => {
        assert.equal((sql.match(/\?/g) ?? []).length, params.length);
        calls.push({ sql, params });
        if (sql.includes('AS [totalDistinct]')) return { rows: [{ totalItems: 17, totalDistinct: 9 }] };
        if (sql.includes('OFFSET')) return { rows: [{ id: '14' }] };
        if (sql.includes('FROM bucketed')) return { rows: [{ bucket: 'overdue', n: 9 }] };
        return { rows: [] };
    });
    const filters = {
        bucket: 'overdue', keyword: 'PO', page: 2, pageSize: 10,
        today: '2026-11-25', twoMonthsAgoStart: '2026-09-01', prevMonthStart: '2026-10-01',
        next3End: '2026-11-29', next7End: '2026-12-03',
    };
    assert.deepEqual(await repo.searchPurchases(filters), { rows: [{ id: '14' }], total: 17, poTotal: 9 });
    const count = calls.find(({ sql }) => sql.includes('AS [totalDistinct]'));
    const list = calls.find(({ sql }) => sql.includes('OFFSET'));
    assert.equal(calls.length, 2);
    assert.doesNotMatch(count.sql, /OFFSET|CREATE TABLE|INTO #/);
    assert.match(count.sql, /'overdue' AND \(o.del_date IS NULL OR o.del_date < \?\)/);
    assert.match(list.sql, /END AS \[status_po\]/);
    assert.match(list.sql, /JOIN pur_in1 i1 ON i1.sheet_no = i.sheet_no/);
    assert.match(list.sql, /n\.pur_id = o\.sheet_id/);
    for (const statement of [count.sql, list.sql]) {
        assert.doesNotMatch(statement, /DATEADD\(HOUR|latest_create|FROM candidate_receipt pi\s+WHERE pi\.pur_no = x\.pur_no/);
    }
    assert.deepEqual(list.params, [...count.params, 10, 10]);
    assert.deepEqual(await repo.countPurchaseBuckets(filters), [{ bucket: 'overdue', n: 9 }]);
    assert.match(calls.find(({ sql }) => sql.includes('FROM bucketed')).sql, /SELECT 'overdue', COUNT\(DISTINCT po_number\)/);
});
