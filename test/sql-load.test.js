'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { limitSqlReads } = require('../src/middleware/sql-load.middleware');

function submit(route, id, label) {
  const res = new EventEmitter();
  res.set = () => {};
  return {
    res,
    done: new Promise((resolve) => {
      res.done = resolve;
      route({ actor: { id }, label }, res, (error) => resolve(error.httpStatus));
    }),
  };
}

test('rejects the fourth account request and holds SQL capacity after disconnect', async () => {
  const starts = [];
  const complete = [];
  const route = limitSqlReads((req, res) => new Promise((resolve) => {
    starts.push(req.label);
    complete.push(() => { res.done(200); resolve(); });
  }));
  const first = submit(route, 'A', 1);
  const second = submit(route, 'A', 2);
  const third = submit(route, 'A', 3);
  assert.equal(await submit(route, 'A', 4).done, 429);
  first.res.emit('close');
  await delay(0);
  assert.deepEqual(starts, [1, 2]);
  complete[0]();
  await delay(0);
  assert.deepEqual(starts, [1, 2, 3]);
  complete[1]();
  complete[2]();
  assert.deepEqual(await Promise.all([first.done, second.done, third.done]), [200, 200, 200]);
});

test('queues the sixth start until the five-request window has room', async () => {
  const starts = [];
  const route = limitSqlReads((req, res) => {
    starts.push(req.label);
    res.done(200);
  }, { windowMs: 100 });
  const requests = Array.from({ length: 6 }, (_, id) => submit(route, id, id));
  assert.deepEqual(await Promise.all(requests.slice(0, 5).map((item) => item.done)), [200, 200, 200, 200, 200]);
  assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  assert.equal(await requests[5].done, 200);
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5]);
});

test('times out a queued request and skips disconnected queued clients', async () => {
  const calls = [];
  const finish = [];
  const route = limitSqlReads((req, res) => new Promise((resolve) => {
    calls.push(req.label);
    finish.push(() => { res.done(200); resolve(); });
  }), { waitMs: 30 });

  const a = submit(route, 'A', 1);
  const b = submit(route, 'B', 2);
  const dropped = submit(route, 'C', 3);
  dropped.res.destroyed = true;
  dropped.res.emit('close');
  assert.equal(await submit(route, 'D', 4).done, 503);
  assert.deepEqual(calls, [1, 2]);
  finish.forEach((complete) => complete());
  await Promise.all([a.done, b.done]);
});
