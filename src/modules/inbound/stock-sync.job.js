'use strict';

const stock = require('./stock-sync.repository');
const { syncAllocation } = require('./stock-sync.service');
const { previousMonthCutoff } = require('../../util/month-cutoff');
const { createWorkerLogger } = require('../../util/worker/logger');

const logger = createWorkerLogger('stock-sync-job');
const BATCH_SIZE = 100;
let cursor = '';

// Quét các phân bổ đã gửi để kiểm tra nhập kho.
async function processStockSweep() {
    const startedAt = Date.now();
    const candidates = await stock.findCandidates(previousMonthCutoff(), cursor, BATCH_SIZE);
    let confirmed = 0;
    let failed = 0;
    for (const id of candidates) {
        try {
            if (await syncAllocation(id) === 'IN_STOCK') confirmed += 1;
        } catch (error) {
            failed += 1;
            logger.error('stock_sync_failed', { allocationId: id, errorName: error.name, message: error.message });
        }
    }
    cursor = candidates.length === BATCH_SIZE ? candidates.at(-1) : '';
    const result = { scanned: candidates.length, confirmed, failed, durationMs: Date.now() - startedAt };
    logger.info('stock_sweep_result', result);
    return result;
}

module.exports = { processStockSweep };
