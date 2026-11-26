'use strict';

const { err, parsePaging, shared } = require('../../shared/shared');
const activities = require('../activity/activity.repository');
const { getProducerQueue } = require('../../util/worker/queue');
const { getProducerRedisConnection } = require('../../util/worker/redis');
const { heartbeatKey, SIGNAL_MAX_AGE_MS } = require('../../util/worker/heartbeat');
const { queues } = require('../../config/worker.config');

const WORKER_QUEUES = [
    queues.receiptSync, queues.iqcSync, 'stock-sync', 'outbound-discovery', 'outbound-completion',
];
const { ACCOUNT_AUDIT_ACTIONS } = require('../../config/account-audit');
const QUEUE_TIMEOUT_MS = 2000;

async function requireIt(actorId) {
    const actor = await shared.getActor(actorId);
    if (actor.role !== 'IT' || !actor.active) err('no_permission', 403);
}

function toJobSummary(job, failed = false) {
    if (!job) return null;
    const summary = { id: job.id, name: job.name, finishedAt: job.finishedOn ?? null, attempts: job.attemptsMade };
    if (Number.isInteger(job.returnvalue?.failed)) summary.failedItems = job.returnvalue.failed;
    if (failed) {
        const message = String(job.failedReason || '');
        summary.errorCategory = /deadlock/i.test(message) ? 'DEADLOCK'
            : /timeout|timed out/i.test(message) ? 'TIMEOUT'
                : /connection|ECONN/i.test(message) ? 'CONNECTION' : 'JOB_FAILED';
    }
    return summary;
}

async function readWorker(queueName, redis) {
    const queue = getProducerQueue(queueName);
    const [heartbeat, counts, completed, failed] = await Promise.all([
        redis.get(heartbeatKey(queueName)),
        queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
        queue.getJobs(['completed'], 0, 0),
        queue.getJobs(['failed'], 0, 0),
    ]);
    const lastHeartbeatAt = heartbeat == null ? null : Number(heartbeat);
    return {
        queueName,
        state: lastHeartbeatAt !== null && Date.now() - lastHeartbeatAt <= SIGNAL_MAX_AGE_MS
            ? 'ONLINE' : 'NO_SIGNAL',
        lastHeartbeatAt,
        counts,
        lastCompleted: toJobSummary(completed[0]),
        lastFailed: toJobSummary(failed[0], true),
    };
}

let pendingRead;

function readWorkers() {
    if (pendingRead) return pendingRead;
    const redis = getProducerRedisConnection();
    if (redis.status !== 'ready') return Promise.resolve(null);
    const work = Promise.all(WORKER_QUEUES.map((name) => readWorker(name, redis)));
    let timer;
    pendingRead = Promise.race([
        work.catch(() => null),
        new Promise((resolve) => { timer = setTimeout(resolve, QUEUE_TIMEOUT_MS, null); }),
    ]);
    const response = pendingRead;
    // Avoid piling up Redis reads if a batch of commands is still outstanding.
    const clear = () => {
        clearTimeout(timer);
        pendingRead = undefined;
    };
    void work.then(clear, clear);
    return response;
}

async function workers(actorId) {
    await requireIt(actorId);
    const items = await readWorkers();
    return {
        redisAvailable: items !== null,
        items: items ?? WORKER_QUEUES.map((queueName) => ({ queueName, state: 'UNAVAILABLE' })),
    };
}

async function audit(query, actorId) {
    await requireIt(actorId);
    const paging = parsePaging(query) ?? { page: 1, pageSize: 20 };
    const result = await activities.searchActivitiesPage({
        ...paging, actionKeys: ACCOUNT_AUDIT_ACTIONS, keyword: String(query.keyword ?? '').slice(0, 90),
    });
    return { ...paging, total: result.total, items: result.rows };
}

module.exports = { workers, audit };
