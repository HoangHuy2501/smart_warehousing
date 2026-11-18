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
    let eligible = false;
    t.mock.method(repo, 'isMissingWaitingLine', async (id, transaction) => {
        assert.equal(id, 42);
        assert.equal(transaction, tx);
        assert.ok(lock.mock.callCount() > 0);
        return eligible;
    });
    const remove = t.mock.method(repo, 'deleteLine', async () => {});

    assert.equal(await removeDeletedWaitingLine(42), false);
    assert.equal(remove.mock.callCount(), 0);

    eligible = true;
    assert.equal(await removeDeletedWaitingLine(42), true);
    assert.deepEqual(remove.mock.calls.map(({ arguments: args }) => args), [[42, tx]]);
});
