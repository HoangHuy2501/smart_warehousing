'use strict';

const db = require('../config/db');
const allocations = require('../repository/sql/iqc-sync.repository');
const locks = require('../repository/sql/receipt-sync.repository');
const stock = require('../repository/sql/stock-sync.repository');
const { previousMonthCutoff } = require('../util/month-cutoff');

async function syncAllocation(id) {
    return db.withTransaction(async (tx) => {
        await locks.acquireAllocationLock(id, tx);
        const allocation = await allocations.findAllocationForIqc(id, tx, true);
        if (!allocation || allocation.closedAt || allocation.status !== 'WAITING_STOCK' ||
            (allocation.statusRecordedAt && new Date(allocation.statusRecordedAt) < previousMonthCutoff())) {
            return 'NO_OP';
        }

        const receipts = await allocations.findReceiptsForAllocation(id, tx);
        if (allocation.hasWarning || receipts.some((receipt) =>
            receipt.hasWarning || receipt.qtyInStock == null || !receipt.lotNo?.trim())) {
            return 'WAITING_STOCK';
        }
        const accepted = receipts.filter((receipt) => receipt.qtyInStock > 0)
            .sort((a, b) => a.noticeDetailId - b.noticeDetailId);
        if (!accepted.length) return 'WAITING_STOCK';

        for (const receipt of accepted) {
            await locks.acquireNoticeLock(receipt.noticeDetailId, tx);
        }
        for (const receipt of accepted) {
            const coverage = await stock.findNoticeCoverage(receipt.noticeDetailId, tx);
            if (!coverage || coverage.lot_no?.trim() !== receipt.lotNo.trim() ||
                Number(coverage.unresolved_count) !== 0 ||
                Number(coverage.imported_qty) < Number(coverage.required_qty)) {
                return 'WAITING_STOCK';
            }
        }

        await allocations.updateAllocationIqcSummary(id, {
            status: 'IN_STOCK',
            warehouse_status: 'IN',
            status_recorded_at: new Date(),
        }, tx);
        return 'IN_STOCK';
    });
}

module.exports = { syncAllocation };
