'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { executeBatch, withApiSqlDeadline } = require('../src/util/api-sql-deadline');

function inApi(fn) {
  return new Promise((resolve) => withApiSqlDeadline(null, null, () => resolve(fn())));
}

test('cancels a timed-out API batch and waits for cancellation acknowledgement', async () => {
  let rejectBatch;
  let signalCancel;
  const cancelled = new Promise((resolve) => { signalCancel = resolve; });
  const request = {
    batch: () => new Promise((resolve, reject) => { rejectBatch = reject; }),
    cancel: () => signalCancel(),
  };
  let settled = false;
  const pending = inApi(() => executeBatch(request, 'query', 10))
    .finally(() => { settled = true; });
  await cancelled;
  assert.equal(settled, false);
  rejectBatch(Object.assign(new Error('Canceled'), { code: 'EREQUEST', originalError: { code: 'ECANCEL' } }));
  await assert.rejects(pending, { code: 'ETIMEOUT' });
});

test('successful API batches clear the timer and worker batches use the driver directly', async () => {
  const request = {
    batch: async (text) => text,
    cancel: () => assert.fail('unexpected cancellation'),
  };
  assert.equal(await inApi(() => executeBatch(request, 'api', 10)), 'api');
  assert.equal(await executeBatch(request, 'worker', 10), 'worker');
});

test('normalizes an earlier timeout reported by the driver', async () => {
  const request = {
    batch: async () => {
      throw Object.assign(new Error('Driver timeout'), {
        code: 'EREQUEST', originalError: { code: 'ETIMEOUT' },
      });
    },
    cancel: () => assert.fail('unexpected cancellation'),
  };
  await assert.rejects(inApi(() => executeBatch(request, 'api')), { code: 'ETIMEOUT' });
});
