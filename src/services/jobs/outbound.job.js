'use strict';

const repo = require('../../repository/sql/outbound.repository');
const service = require('../outbound.service');
const { createWorkerLogger } = require('../../util/worker/logger');
const { publishOutboundRevision } = require('../../util/worker/outbound-revision');

const logger = createWorkerLogger('outbound-job');
const LIMIT = 100;

function createSweep(load, process, getId) {
    let cursor = 0;
    return async (job) => {
        const startedAt = Date.now();
        const rows = await load(cursor, LIMIT);
        let failed = 0;
        let changed = 0;
        for (const row of rows) {
            try {
                if (await process(row)) changed += 1;
            } catch (error) {
                failed += 1;
                logger.error('outbound_line_failed', { id: getId(row), message: error.message });
            }
        }
        cursor = rows.length === LIMIT ? getId(rows.at(-1)) : 0;
        if (changed && !await publishOutboundRevision()) {
            logger.warn('outbound_revision_unavailable', { queue: job?.queueName });
        }
        const result = { scanned: rows.length, changed, failed, durationMs: Date.now() - startedAt };
        logger.info('outbound_sweep_result', { queue: job?.queueName, ...result });
        return result;
    };
}

function createDiscoverySweep(since) {
    return createSweep((after, limit) => repo.discover(since, after, limit), service.plan, (row) => row.id);
}

const processCompletionSweep = createSweep(repo.ready, service.complete, (id) => id);

module.exports = { createDiscoverySweep, processCompletionSweep };
