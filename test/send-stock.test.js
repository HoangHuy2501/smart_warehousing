'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const { shared } = require('../src/services/shared');
const allocations = require('../src/repository/sql/iqc-sync.repository');
const locks = require('../src/repository/sql/receipt-sync.repository');
const slots = require('../src/repository/sql/slot.repository');
const stock = require('../src/repository/sql/stock-sync.repository');
const t8 = require('../src/repository/sql/t8-receipt.repository');
const { send } = require('../src/services/send-stock.service');
const { syncAllocation } = require('../src/services/stock-sync.service');

for (const scenario of [
    { name: 'đã duyệt đủ', imported: 100, draft: 0 },
    { name: 'đã có phiếu nháp đủ', imported: 0, draft: 100 },
    { name: 'tạo nháp phần còn thiếu', imported: 30, draft: 20, expected: '50.00000000' },
    { name: 'bấm lại sau khi gửi', status: 'SEND_STOCK' },
]) {
    test(scenario.name, async (t) => {
        const tx = () => assert.fail('Repository calls are mocked');
        t.mock.method(db, 'getMode', () => 'sqlserver');
        t.mock.method(db, 'withTransaction', async (callback) => callback(tx));
        t.mock.method(shared, 'getActor', async () => ({ id: 'EMP' }));
        t.mock.method(shared, 'canAccessSlot', () => true);
        t.mock.method(slots, 'byCode', async () => ({ code: 'A1-1' }));
        t.mock.method(locks, 'acquireAllocationLock', async () => {});
        t.mock.method(locks, 'acquireNoticeLock', async () => {});
        t.mock.method(locks, 'findAllocationForSync', async () => ({
            slotCode: 'A1-1', status: scenario.status || 'WAITING_STOCK',
        }));
        t.mock.method(allocations, 'findReceiptsForAllocation', async () => [{
            noticeDetailId: 1, qtyInStock: 100, lotNo: 'LOT', iqcDecision: 'PASS',
        }]);
        t.mock.method(stock, 'findNoticeCoverage', async () => [{
            notice_id: 1, lot_no: 'LOT', imported_qty: scenario.imported,
            required_qty: 100, unresolved_count: 0,
        }]);
        t.mock.method(t8, 'findSource', async () => ({
            notice_no: 'PN', notice_id: 2, pur_no: 'PO', pur_id: 3, goods_no: 'GOODS',
            made_lot: 'LOT', sheet_qty: 100, return_qty: 0, match_count: 1, adj_result: '1',
            draft_qty: scenario.draft, su_no: 'SU', st_no: '101',
            sheet_pri: 500, unit_rate: 1, pri_dis: 1,
        }));
        t.mock.method(t8, 'hasSlot', async () => true);
        t.mock.method(t8, 'findCreator', async () => ({ user_no: 'EMP', emp_no: null }));
        t.mock.method(t8, 'reserveSheetNumber', async () => 'PSMGI261123001');
        const header = t.mock.method(t8, 'insertHeader', async () => {});
        const line = t.mock.method(t8, 'insertLine', async () => {});
        const update = t.mock.method(allocations, 'updateAllocationIqcSummary', async () => true);

        const result = await send('LOT-ID', { actorId: 'EMP', slotCode: 'A1-1' });
        assert.equal(result.status, 'SEND_STOCK');
        assert.deepEqual(result.sheetNos, scenario.expected ? ['PSMGI261123001'] : []);
        assert.equal(update.mock.callCount(), scenario.status ? 0 : 1);
        assert.equal(header.mock.callCount(), scenario.expected ? 1 : 0);
        assert.equal(line.mock.callCount(), scenario.expected ? 1 : 0);
        if (scenario.expected) {
            assert.equal(header.mock.calls[0].arguments[0].sheet_sta, '0');
            assert.equal(header.mock.calls[0].arguments[0].rem, 'Smart-Warehousing');
            assert.equal(line.mock.calls[0].arguments[0].sheet_qty, scenario.expected);
            assert.equal(line.mock.calls[0].arguments[0].st_bit_no, 'A1-1');
        }
    });
}

test('worker chỉ kiểm tra SEND_STOCK và cần đủ lượng đã duyệt', async (t) => {
    const tx = () => assert.fail('Repository calls are mocked');
    const allocation = { status: 'WAITING_STOCK' };
    const coverage = { notice_id: 1, lot_no: 'LOT', imported_qty: 0, required_qty: 100, unresolved_count: 0 };
    t.mock.method(db, 'withTransaction', async (callback) => callback(tx));
    t.mock.method(locks, 'acquireAllocationLock', async () => {});
    t.mock.method(locks, 'acquireNoticeLock', async () => {});
    t.mock.method(allocations, 'findAllocationForIqc', async () => allocation);
    t.mock.method(allocations, 'findReceiptsForAllocation', async () => [{
        noticeDetailId: 1, qtyInStock: 100, lotNo: 'LOT',
    }]);
    t.mock.method(stock, 'findNoticeCoverage', async () => [coverage]);
    const update = t.mock.method(allocations, 'updateAllocationIqcSummary', async () => true);

    assert.equal(await syncAllocation('LOT-ID'), 'NO_OP');
    allocation.status = 'SEND_STOCK';
    assert.equal(await syncAllocation('LOT-ID'), 'SEND_STOCK');
    assert.equal(update.mock.callCount(), 0);
    coverage.imported_qty = 100;
    assert.equal(await syncAllocation('LOT-ID'), 'IN_STOCK');
    assert.equal(update.mock.calls[0].arguments[1].warehouse_status, 'IN_STOCK');
});
