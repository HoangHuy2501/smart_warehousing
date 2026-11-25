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
        if (!allocation || allocation.closedAt || allocation.status !== 'SEND_STOCK' ||
            (allocation.statusRecordedAt && new Date(allocation.statusRecordedAt) < previousMonthCutoff())) {
            return 'NO_OP';
        }

        const receipts = await allocations.findReceiptsForAllocation(id, tx);
        if (allocation.hasWarning || receipts.some((receipt) =>
            receipt.hasWarning || receipt.qtyInStock == null || !receipt.lotNo?.trim())) {
            return 'SEND_STOCK';
        }
        const accepted = receipts.filter((receipt) => receipt.qtyInStock > 0)
            .sort((a, b) => a.noticeDetailId - b.noticeDetailId);
        if (!accepted.length) return 'SEND_STOCK';

        for (const receipt of accepted) {
            await locks.acquireNoticeLock(receipt.noticeDetailId, tx);
        }
        const noticeIds = accepted.map((receipt) => receipt.noticeDetailId);
        const coverageByNotice = new Map();
        for (let offset = 0; offset < noticeIds.length; offset += 500) {
            const rows = await stock.findNoticeCoverage(noticeIds.slice(offset, offset + 500), tx);
            for (const row of rows) coverageByNotice.set(row.notice_id, row);
        }
        for (const receipt of accepted) {
            const coverage = coverageByNotice.get(receipt.noticeDetailId);
            if (!coverage || coverage.lot_no?.trim() !== receipt.lotNo.trim() ||
                Number(coverage.unresolved_count) !== 0 ||
                Number(coverage.imported_qty) < Number(coverage.required_qty)) {
                return 'SEND_STOCK';
            }
        }

        await allocations.updateAllocationIqcSummary(id, {
            status: 'IN_STOCK',
            warehouse_status: 'IN_STOCK',
            status_recorded_at: new Date(),
        }, tx);
        return 'IN_STOCK';
    });
}

module.exports = { syncAllocation };
