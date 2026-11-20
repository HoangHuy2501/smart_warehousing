'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');

test('SQL undo reread returns a single allocation object or null', async (t) => {
    t.mock.method(db, 'getMode', () => 'sqlserver');
    const { LotModel } = require('../src/repository/sql/lot.repository');
    const repository = new LotModel();
    const row = { id: 'a', qtyInStock: 10, status: 'IN_STOCK' };
    assert.equal(await repository.findAllocationRow('a', async () => ({ rows: [row] })), row);
    assert.equal(await repository.findAllocationRow('missing', async () => ({ rows: [] })), null);
});
