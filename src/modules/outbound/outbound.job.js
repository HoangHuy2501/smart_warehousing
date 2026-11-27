'use strict';

const repo = require('./outbound.repository');
const service = require('./outbound.service');
const { createWorkerLogger } = require('../../util/worker/logger');
const { publishOutboundRevision } = require('../../util/worker/outbound-revision');
const { enqueueOutboundPush } = require('./outbound-push.job');

const logger = createWorkerLogger('outbound-job');
const LIMIT = 100;

// Tạo tác vụ rà soát các dòng xuất kho đang xử lý.
function createSweep(load, process, getId, discovery = false, event = 'outbound_sweep_result') {
    let cursor = 0;
    return async (job) => {
        const startedAt = Date.now();
        const rows = await load(cursor, LIMIT);
        let failed = 0;
        let changed = 0;
        const changedSheets = new Set();
        for (const row of rows) {
            try {
                if (await process(row)) {
                    changed += 1;
                    if (discovery) changedSheets.add(row.sheet_no);
                }
            } catch (error) {
                failed += 1;
                logger.error('outbound_line_failed', { id: getId(row), message: error.message });
            }
        }
        cursor = rows.length === LIMIT ? getId(rows.at(-1)) : 0;
        if (changed && !await publishOutboundRevision()) {
            logger.warn('outbound_revision_unavailable', { queue: job?.queueName });
        }
        let pushEnqueueFailed = 0;
        for (const sheetNo of changedSheets) {
            try {
                await enqueueOutboundPush(sheetNo);
            } catch {
                pushEnqueueFailed += 1;
                logger.error('outbound_push_enqueue_failed', { sheetNo });
            }
        }
        const result = { scanned: rows.length, changed, failed, pushEnqueueFailed, durationMs: Date.now() - startedAt };
        logger.info(event, { queue: job?.queueName, ...result });
        return result;
    };
}

// Tạo tác vụ quét dòng xuất kho mới trên T8.
function createDiscoverySweep(since) {
    const discover = createSweep((after, limit) => repo.discover(since, after, limit), service.plan, (row) => row.id, true);
    const removeDeleted = createSweep(repo.findMissingWaitingLines, service.removeDeletedWaitingLine,
        (id) => id, false, 'outbound_deleted_waiting_sweep_result');
    return async (job) => {
        await removeDeleted(job);
        return discover(job);
    };
}

const processCompletionSweep = createSweep(repo.ready, service.complete, (id) => id);

module.exports = { createDiscoverySweep, processCompletionSweep };
