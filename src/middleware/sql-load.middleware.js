'use strict';

const { performance } = require('node:perf_hooks');
const { ApiError } = require('../util/api-error');

/**
 * One gate per route in the API process. Keep the slot until the controller
 * settles so disconnecting a client cannot release a still-running SQL query.
 */
function limitSqlReads(handler, { windowMs = 5000, waitMs = 10000 } = {}) {
  const starts = [];
  const byAccount = new Map();
  const queue = [];
  let active = 0;
  let timer;
  let nextCleanup = 0;

  function prune(timestamps, now) {
    while (timestamps.length && timestamps[0] <= now - windowMs) timestamps.shift();
  }

  function reject(entry, status, retryMs = windowMs) {
    entry.res.set('Retry-After', String(Math.max(1, Math.ceil(retryMs / 1000))));
    const code = status === 429 ? 'rate_limited' : 'sql_queue_busy';
    entry.next(new ApiError(code, status, code));
  }

  function drain() {
    clearTimeout(timer);
    const now = performance.now();
    prune(starts, now);
    while (queue.length) {
      const entry = queue[0];
      if (entry.deadline <= now) {
        queue.shift();
        entry.res.off('close', entry.disconnect);
        reject(entry, 503);
        continue;
      }
      if (active >= 2 || starts.length >= 5) {
        const nextStart = active < 2 ? starts[0] + windowMs : Infinity;
        timer = setTimeout(drain, Math.max(1, Math.ceil(Math.min(entry.deadline, nextStart) - now)));
        return;
      }
      queue.shift();
      entry.res.off('close', entry.disconnect);
      if (entry.res.destroyed) continue;
      starts.push(performance.now());
      active += 1;
      Promise.resolve()
        .then(() => handler(entry.req, entry.res, entry.next))
        .catch(entry.next)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return (req, res, next) => {
    const now = performance.now();
    if (now >= nextCleanup) {
      for (const [id, timestamps] of byAccount) {
        prune(timestamps, now);
        if (!timestamps.length) byAccount.delete(id);
      }
      nextCleanup = now + windowMs;
    }

    const id = req.actor.id;
    const timestamps = byAccount.get(id) || [];
    prune(timestamps, now);
    const entry = { req, res, next, deadline: now + waitMs };
    if (timestamps.length >= 3) return reject(entry, 429, timestamps[0] + windowMs - now);
    drain();
    if (queue.length >= 10) return reject(entry, 503);

    timestamps.push(now);
    byAccount.set(id, timestamps);
    entry.disconnect = () => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      drain();
    };
    res.once('close', entry.disconnect);
    queue.push(entry);
    drain();
  };
}

module.exports = { limitSqlReads };
