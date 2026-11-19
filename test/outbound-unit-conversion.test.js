'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const repo = require('../src/repository/sql/outbound.repository');
const service = require('../src/services/outbound.service');

const cases = [
    { name: 'converts outbound units into stock units', qty: '1746', rate: '2', expected: 873 },
    { name: 'rounds a recurring quotient to three decimals', qty: '1', rate: '3', expected: 0.333 },
    { name: 'rounds a half-thousandth upward', qty: '2.469', rate: '2', expected: 1.235 },
    { name: 'keeps same-unit quantities intact', qty: '1.23456789', rate: '2', unit: 'LB', expected: 1.23456789 },
    { name: 'rejects zero conversion rates before storing proposals', qty: '1', rate: '0', invalid: true },
    { name: 'rejects missing conversion rates before storing proposals', qty: '1', rate: null, invalid: true },
    { name: 'rejects quantities that round to zero', qty: '0.0001', rate: '2', invalid: true },
];

for (const entry of cases) {
    test(entry.name, async (t) => {
        const source = {
            id: 42, sheet_no: 'OUT-42', goods_no: 'M1', made_lot: 'LOT',
            unit_no: entry.unit || 'YD', stock_unit: 'LB',
            requested_qty: entry.qty, pur_unit_rate: entry.rate, rem: '已下达',
        };
        const tx = () => assert.fail('use repository methods');
        t.mock.method(db, 'withTransaction', async (callback) => callback(tx));
        t.mock.method(repo, 'lock', async () => {});
        t.mock.method(repo, 'findSource', async () => source);
        t.mock.method(repo, 'findLine', async () => null);
        t.mock.method(repo, 'available', async () => [{
            receipt_id: 'r', allocation_id: 'a', slot_code: 'A',
            available_qty: '10000', allocation_available_qty: '10000',
        }]);
        t.mock.method(repo, 'picks', async () => []);
        const insertLine = t.mock.method(repo, 'insertLine', async () => {});
        const insertPick = t.mock.method(repo, 'insertPick', async () => {});

        if (entry.invalid) {
            await assert.rejects(service.plan(source), /outbound_invalid_/);
            assert.equal(insertLine.mock.callCount(), 0);
            assert.equal(insertPick.mock.callCount(), 0);
            return;
        }

        assert.equal(await service.plan(source), true);
        assert.equal(Number(insertPick.mock.calls[0].arguments[2]), entry.expected);
        assert.equal(insertLine.mock.calls[0].arguments[0].requested_qty, entry.qty);
        assert.equal(insertLine.mock.calls[0].arguments[0].unit_no, source.unit_no);
    });
}
