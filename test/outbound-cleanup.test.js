'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const repo = require('../src/repository/sql/outbound.repository');
const { removeDeletedWaitingLine } = require('../src/services/outbound.service');

test('checks T8 again under the outbound lock before deleting a waiting line', async (t) => {
    const tx = () => assert.fail('repository methods should receive the transaction');
    const lock = t.mock.method(repo, 'lock', async (transaction) => assert.equal(transaction, tx));
    t.mock.method(db, 'withTransaction', async (callback) => callback(tx));
    const line = { status: 'WAITING_PICK' };
    t.mock.method(repo, 'findLine', async () => {
        assert.ok(lock.mock.callCount() > 0);
        return line;
    });
    let source = { id: 42, rem: 'Rem changed in T8' };
    t.mock.method(repo, 'findSource', async () => source);
    const remove = t.mock.method(repo, 'deleteLineAndPicks', async () => {});

    assert.equal(await removeDeletedWaitingLine(42), false);
    source = null;
    line.status = 'PICKED';
    assert.equal(await removeDeletedWaitingLine(42), false);
    assert.equal(remove.mock.callCount(), 0);

    line.status = 'WAITING_PICK';
    assert.equal(await removeDeletedWaitingLine(42), true);
    assert.deepEqual(remove.mock.calls.map(({ arguments: args }) => args), [[42, tx]]);
});
