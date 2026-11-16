'use strict';

const repo = require('../../repository/sql/outbound.repository');
const service = require('../outbound.service');
const { createWorkerLogger } = require('../../util/worker/logger');

const logger = createWorkerLogger('outbound-job');
const LIMIT = 100;

function createSweep(load, process, getId) {
    let cursor = 0;
    return async () => {
        const rows = await load(cursor, LIMIT);
        let failed = 0;
        for (const row of rows) {
            try {
                await process(row);
            } catch (error) {
                failed += 1;
                logger.error('outbound_line_failed', { id: getId(row), message: error.message });
            }
        }
        cursor = rows.length === LIMIT ? getId(rows.at(-1)) : 0;
        return { scanned: rows.length, failed };
    };
}

function createDiscoverySweep(since) {
    return createSweep((after, limit) => repo.discover(since, after, limit), service.plan, (row) => row.id);
}

const processCompletionSweep = createSweep(repo.ready, service.complete, (id) => id);

module.exports = { createDiscoverySweep, processCompletionSweep };
