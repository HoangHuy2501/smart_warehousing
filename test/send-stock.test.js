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
const { preview, send } = require('../src/services/send-stock.service');
const { syncAllocation } = require('../src/services/stock-sync.service');

for (const scenario of [
    { name: 'đã duyệt đủ', imported: 100, draft: 0 },
    { name: 'đã có phiếu nháp đủ', imported: 0, draft: 100 },
    { name: 'tạo nháp phần còn thiếu', imported: 30, draft: 20, expected: '50.00000000' },
    { name: 'ghi nối vào phiếu nháp cùng tạm nhập', imported: 0, draft: 40, expected: '60.00000000', reuse: true },
    { name: 'lưu một phần và giữ WAITING_STOCK', imported: 0, draft: 0, input: '40', expected: '40.00000000', partial: true },
    { name: 'lấy số còn thiếu của kệ sau khi gửi một phần', imported: 0, draft: 40, slotQty: 40, expected: '60.00000000', reuse: true },
    { name: 'từ chối số lượng vượt mức', imported: 0, draft: 0, input: '101', invalid: true },
    { name: 'từ chối bản xem trước cũ sau khi lượng T8 đổi', imported: 0, draft: 0, stale: true },
    { name: 'dùng mã vị trí rút gọn trên T8, giữ mã kệ WHS trên form', imported: 0, draft: 0, expected: '100.00000000', shortCode: '03-01' },
    { name: 'từ chối nếu không có vị trí T8 đang hoạt động', imported: 0, draft: 0, missingSlot: true },
    { name: 'bấm lại sau khi gửi', status: 'SEND_STOCK' },
]) {
    test(scenario.name, async (t) => {
        const tx = () => assert.fail('Repository calls are mocked');
        t.mock.method(db, 'getMode', () => 'sqlserver');
        t.mock.method(db, 'withTransaction', async (callback) => callback(tx));
        t.mock.method(shared, 'getActor', async () => ({ id: 'EMP' }));
        t.mock.method(shared, 'canAccessSlot', () => true);
        t.mock.method(slots, 'byCode', async () => ({ code: 'A1-1', warehouse: 'GIF3' }));
        t.mock.method(locks, 'acquireAllocationLock', async () => {});
        t.mock.method(locks, 'acquireNoticeLock', async () => {});
        t.mock.method(locks, 'findAllocationForSync', async () => ({
            slotCode: 'A1-1', poId: 8, goodsNo: 'GOODS', status: scenario.status || 'WAITING_STOCK',
        }));
        t.mock.method(allocations, 'findReceiptsForAllocation', async () => [{
            noticeDetailId: 1, qtyInStock: 100, lotNo: 'LOT', iqcDecision: 'PASS',
        }]);
        t.mock.method(stock, 'findNoticeCoverage', async () => [{
            notice_id: 1, lot_no: 'LOT', imported_qty: scenario.imported,
            required_qty: 100, unresolved_count: 0,
        }]);
        let changed = false;
        t.mock.method(t8, 'findWaitingPeers', async () => []);
        t.mock.method(t8, 'findSource', async (id, poId, goodsNo, slotCode) => {
            assert.deepEqual([id, poId, goodsNo, slotCode], [1, 8, 'GOODS', 'A1-1']);
            return {
                notice_no: 'PN', notice_id: 2, pur_no: 'PO', pur_id: 3, goods_no: 'GOODS',
                made_lot: 'LOT', sheet_qty: 100, return_qty: 0, match_count: 1, adj_result: '1',
                draft_qty: scenario.draft + (changed ? 1 : 0), slot_qty: scenario.slotQty, su_no: 'SU', st_no: '999',
                sheet_pri: 500, unit_rate: 1, pri_dis: 1,
            };
        });
        t.mock.method(t8, 'findOpenDraft', async () => scenario.reuse ? ['PIGI0001'] : []);
        t.mock.method(t8, 'nextLineId', async () => 7);
        const findSlot = t.mock.method(t8, 'findActiveSlotCode', async (warehouse) => {
            assert.equal(warehouse, '101');
            return scenario.missingSlot ? undefined : scenario.shortCode ?? 'A1-1';
        });
        t.mock.method(t8, 'findCreator', async () => ({ user_no: 'EMP', emp_no: null }));
        t.mock.method(t8, 'reserveSheetNumber', async () => 'PSMGI261123001');
        const header = t.mock.method(t8, 'insertHeader', async () => {});
        const line = t.mock.method(t8, 'insertLine', async () => {});
        const update = t.mock.method(allocations, 'updateAllocationIqcSummary', async () => true);

        const dto = { actorId: 'EMP', slotCode: 'A1-1' };
        const form = scenario.status ? { revision: 'previous', lines: [] } : await preview('LOT-ID', dto);
        assert.equal(findSlot.mock.callCount(), 0);
        assert.equal(header.mock.callCount(), 0);
        assert.equal(line.mock.callCount(), 0);
        if (!scenario.status) {
            assert.equal(form.mode, form.lines.length ? 'CREATE' : 'CONFIRM_EXISTING');
        }
        if (scenario.stale) changed = true;
        const submit = send('LOT-ID', {
            ...dto, revision: form.revision,
            totalQuantity: scenario.input ?? form.totalQuantity ?? '0',
        });
        if (scenario.invalid || scenario.stale || scenario.missingSlot) {
            await assert.rejects(submit, scenario.stale ? /t8_receipt_preview_stale/ :
                scenario.missingSlot ? /t8_receipt_slot_invalid/ : /t8_receipt_quantity_invalid/);
            assert.equal(header.mock.callCount(), 0);
            assert.equal(line.mock.callCount(), 0);
            assert.equal(update.mock.callCount(), 0);
            return;
        }
        const result = await submit;
        assert.equal(result.status, scenario.partial ? 'WAITING_STOCK' : 'SEND_STOCK');
        assert.deepEqual(result.sheetNos, scenario.reuse ? ['PIGI0001'] : scenario.expected ? ['PSMGI261123001'] : []);
        assert.equal(update.mock.callCount(), scenario.status || scenario.partial ? 0 : 1);
        assert.equal(header.mock.callCount(), scenario.expected && !scenario.reuse ? 1 : 0);
        assert.equal(line.mock.callCount(), scenario.expected ? 1 : 0);
        if (scenario.expected && !scenario.reuse) {
            assert.equal(header.mock.calls[0].arguments[0].sheet_sta, '0');
            assert.equal(header.mock.calls[0].arguments[0].rem, 'Smart-Warehousing');
        }
        if (scenario.expected) {
            assert.equal(line.mock.calls[0].arguments[0].sheet_id, scenario.reuse ? 7 : 1);
            assert.equal(line.mock.calls[0].arguments[0].sheet_qty, scenario.expected);
            assert.equal(form.lines[0].slotCode, 'A1-1');
            assert.equal(line.mock.calls[0].arguments[0].st_bit_no, scenario.shortCode ?? 'A1-1');
            assert.equal(line.mock.calls[0].arguments[0].st_no, '101');
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


test('ghép hai kệ cùng lot và giữ mã vị trí T8 riêng trên từng dòng', async (t) => {
    const rows = {
        A: { slotCode: 'A1', poId: 8, goodsNo: 'GOODS', status: 'WAITING_STOCK' },
        B: { slotCode: 'B1', poId: 8, goodsNo: 'GOODS', status: 'WAITING_STOCK' },
    };
    const tx = () => assert.fail('Repository calls are mocked');
    t.mock.method(db, 'getMode', () => 'sqlserver');
    t.mock.method(db, 'withTransaction', async (callback) => callback(tx));
    t.mock.method(shared, 'getActor', async () => ({ id: 'EMP' }));
    t.mock.method(shared, 'canAccessSlot', () => true);
    t.mock.method(slots, 'byCode', async (code) => ({ code, warehouse: 'GIF3' }));
    const lock = t.mock.method(locks, 'acquireAllocationLock', async () => {});
    t.mock.method(locks, 'acquireNoticeLock', async () => {});
    t.mock.method(locks, 'findAllocationForSync', async (id) => rows[id]);
    t.mock.method(t8, 'findWaitingPeers', async () => ['B']);
    t.mock.method(allocations, 'findReceiptsForAllocation', async (id) => [{
        noticeDetailId: 1, qtyInStock: id === 'A' ? 40 : 60, lotNo: 'LOT', iqcDecision: 'PASS',
    }]);
    t.mock.method(stock, 'findNoticeCoverage', async () => [{
        notice_id: 1, lot_no: 'LOT', imported_qty: 0, required_qty: 100, unresolved_count: 0,
    }]);
    t.mock.method(t8, 'findSource', async () => ({
        notice_no: 'PN', su_no: 'SU', st_no: '101', sheet_qty: 100, return_qty: 0,
        match_count: 1, adj_result: '1', draft_qty: 0, slot_qty: 0,
        sheet_pri: 500, unit_rate: 1, pri_dis: 1,
    }));
    t.mock.method(t8, 'findActiveSlotCode', async (_, code) => code);
    t.mock.method(t8, 'findOpenDraft', async () => []);
    t.mock.method(t8, 'findCreator', async () => ({ user_no: 'EMP' }));
    t.mock.method(t8, 'reserveSheetNumber', async () => 'PSMGI261123001');
    const header = t.mock.method(t8, 'insertHeader', async () => {});
    const line = t.mock.method(t8, 'insertLine', async () => {});
    const update = t.mock.method(allocations, 'updateAllocationIqcSummary', async () => true);

    const dto = { actorId: 'EMP', slotCode: 'A1' };
    const form = await preview('A', dto);
    assert.deepEqual(form.lines.map((r) => [r.allocationId, r.slotCode, r.quantity]),
        [['A', 'A1', '40.00000000'], ['B', 'B1', '60.00000000']]);
    assert.deepEqual(form.slotCodes, ['A1', 'B1']);
    assert.equal(form.totalQuantity, '100.00000000');
    assert.equal(form.lotNo, 'LOT');
    const result = await send('A', { ...dto, revision: form.revision, totalQuantity: form.totalQuantity });
    assert.equal(header.mock.callCount(), 1);
    assert.deepEqual(lock.mock.calls.map((call) => call.arguments[0]), ['A', 'B']);
    assert.deepEqual(line.mock.calls.map(({ arguments: [r] }) => [r.st_bit_no, r.sheet_qty]),
        [['A1', '40.00000000'], ['B1', '60.00000000']]);
    assert.deepEqual(update.mock.calls.map((call) => call.arguments[0]), ['A', 'B']);
    assert.deepEqual(result.allocations, [
        { allocationId: 'A', status: 'SEND_STOCK' }, { allocationId: 'B', status: 'SEND_STOCK' },
    ]);
});

test('tra vị trí T8 theo kho đích, ưu tiên mã đầy đủ rồi đến mã bỏ tiền tố', async () => {
    const resolved = await t8.findActiveSlotCode('101', 'GIF3-A1-03-01', 'GIF3', async (sql, params) => {
        assert.match(sql, /act_sw = '1'/);
        assert.match(sql, /ORDER BY CASE WHEN st_bit_no/);
        assert.deepEqual(params, ['101', 'GIF3-A1-03-01', 'A1-03-01', 'GIF3-A1-03-01']);
        return { rows: [{ st_bit_no: 'A1-03-01' }] };
    });
    assert.equal(resolved, 'A1-03-01');
});
