'use strict';

process.env.DB_MODE = 'memory';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const audit = require('../src/util/sql-audit');
const { shared } = require('../src/services/shared');
const activities = require('../src/repository/sql/activity.repository');
const slots = require('../src/repository/sql/slot.repository');
const lots = require('../src/repository/sql/lot.repository');
const receipts = require('../src/repository/sql/receipt.repository');
const lotService = require('../src/services/lot.service');

test('formats typed SQL audit values and protects multi-line context boundaries', () => {
    assert.equal(audit.insert('whs_slots', {
        code: "A'B", active: true, keeper_emp_no: null,
    }), "INSERT INTO whs_slots (code, active, keeper_emp_no) VALUES (N'A''B', 1, NULL);");
    assert.equal(audit.update('whs_slots', { code: 'NEW', ignored: undefined }, { code: 'OLD', keeper_emp_no: null }),
        "UPDATE whs_slots SET code = N'NEW' WHERE code = N'OLD' AND keeper_emp_no IS NULL;");
    assert.equal(audit.literal(new Date('2026-11-20T00:00:00Z')), "N'2026-11-20T00:00:00.000Z'");
    assert.equal(audit.context({ note: 'first\nsecond' }).split('\n').length, 1);
});

test('shelf creation and rename are persisted while existing excluded actions stay excluded', async (t) => {
    const stored = t.mock.method(activities, 'insert', async () => {});
    const query = () => {};
    await shared.logActivity({
        userId: 'TEST-MGR', actionKey: 'actCreateSlot', slotCode: 'GIF3-A1-01-06',
        detail: audit.insert('whs_slots', { code: 'GIF3-A1-01-06' }),
    }, query);
    await shared.logActivity({
        userId: 'TEST-MGR', actionKey: 'actRenameSlot', slotCode: 'GIF3-A1-01-07',
        detail: audit.update('whs_slots', { code: 'GIF3-A1-01-07' }, { code: 'GIF3-A1-01-06' }),
    }, query);
    await shared.logActivity({ userId: 'TEST-MGR', actionKey: 'actPrint' }, query);
    assert.equal(stored.mock.callCount(), 2);
    assert.equal(stored.mock.calls[0].arguments[0].userId, 'TEST-MGR');
    assert.equal(stored.mock.calls[0].arguments[1], query);
    assert.match(stored.mock.calls[0].arguments[0].detail, /^INSERT INTO whs_slots/);
    assert.match(stored.mock.calls[1].arguments[0].detail, /WHERE code = N'GIF3-A1-01-06'/);
});

test('undo preserves its snapshot in SQL detail and repeated undo remains idempotent', async () => {
    await slots.insert({
        code: 'AUDIT-A1-01-01', warehouse: 'GIF3', row: 'A1', floor: '01', position: '01',
        keeperId: 'EMP003', active: true,
    });
    await lots.insertAllocation({
        id: 'audit-undo', po_id: 1, goods_no: 'ITEM-SPCC', slot_code: 'AUDIT-A1-01-01',
        allocated_qty: 10, status: 'WAITING_IQC', warehouse_status: 'PO_ASSIGNED',
        allocated_by_emp_no: 'EMP003', allocated_at: '2026-11-20T00:00:00Z',
        iqc_decision: null, last_iqc_at: null, lot_no: null,
        qty_in_stock: null, qty_return: null, qty_aod: null, closed_at: null,
    });
    await receipts.insertReceipt({
        id: 'audit-receipt', allocation_id: 'audit-undo', notice_detail_id: 1,
        received_qty: 4, lot_no: null, iqc_decision: null,
    });
    const result = await lotService.undoAssign('audit-undo', { actorId: 'EMP003', reason: "Gán nhầm O'Brien" });
    assert.equal(result.state, 'UNDONE');
    const entry = await activities.findByAllocationAndActionKey('audit-undo', 'UNDO_ASSIGN');
    assert.match(entry.detail, /DELETE FROM whs_allocation_receipt/);
    assert.match(entry.detail, /DELETE FROM whs_slot_allocation WHERE id = N'audit-undo'/);
    assert.match(entry.detail, /O''Brien/);
    assert.match(entry.detail, /receipt_1_received_qty = 4/);
    assert.equal((await lotService.undoAssign('audit-undo', { actorId: 'EMP003', reason: 'Thử lại' })).state, 'ALREADY_UNDONE');
});
