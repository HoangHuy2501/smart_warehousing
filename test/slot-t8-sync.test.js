'use strict';

process.env.DB_MODE = 'memory';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const { shared } = require('../src/services/shared');
const slots = require('../src/repository/sql/slot.repository');
const t8 = require('../src/repository/sql/t8-slot.repository');
const service = require('../src/services/slot.service');

function setup(t, role = 'MANAGER') {
    const query = () => assert.fail('repository mocks should handle SQL');
    t.mock.method(db, 'getMode', () => 'sqlserver');
    t.mock.method(db, 'withTransaction', async (callback) => callback(query));
    t.mock.method(shared, 'getActor', async () => ({ id: 'ITEST', role, active: true }));
    t.mock.method(shared, 'logActivity', async () => {});
    t.mock.method(t8, 'lock', async () => {});
    return query;
}

test('creates WHS and T8 slots in the same transaction with GIF3 mapped to 101', async (t) => {
    const query = setup(t);
    t.mock.method(slots, 'byCode', async () => null);
    const insertWhs = t.mock.method(slots, 'insert', async (slot) => slot);
    t.mock.method(t8, 'find', async () => []);
    const insertT8 = t.mock.method(t8, 'insert', async () => {});
    const result = await service.createSlot({ actorId: 'ITEST', warehouse: 'gif3', row: 'a1', floor: '01', position: '06' });
    assert.equal(result.code, 'GIF3-A1-01-06');
    assert.equal(insertWhs.mock.calls[0].arguments[1], query);
    assert.deepEqual(insertT8.mock.calls[0].arguments.slice(1), ['101', 'ITEST', query]);
});

test('adopts a matching precreated T8 slot and rejects a different warehouse', async (t) => {
    setup(t);
    t.mock.method(slots, 'byCode', async () => null);
    t.mock.method(slots, 'insert', async (slot) => slot);
    let stNo = '101';
    t.mock.method(t8, 'find', async () => [{ st_no: stNo }]);
    const update = t.mock.method(t8, 'update', async () => {});
    const dto = { actorId: 'ITEST', warehouse: 'GIF3', row: 'A1', floor: '01', position: '06' };
    await service.createSlot(dto);
    assert.equal(update.mock.callCount(), 1);
    stNo = '102';
    await assert.rejects(service.createSlot(dto), /t8_slot_conflict/);
});

test('rejects mixed unauthorized updates before writing any slot fields', async (t) => {
    setup(t, 'KEEPER');
    const update = t.mock.method(slots, 'update', async () => {});
    await assert.rejects(service.updateSlot('GIF3-A1-01-06', {
        actorId: 'ITEST', full: true, active: false,
    }), /no_permission/);
    assert.equal(update.mock.callCount(), 0);
});

test('updates act_sw through T8 synchronization using the changed WHS active flag', async (t) => {
    const query = setup(t);
    const slot = { code: 'GIF3-A1-01-06', warehouse: 'GIF3', active: true };
    t.mock.method(slots, 'byCode', async () => slot);
    t.mock.method(slots, 'hasNonReturnedAllocation', async () => false);
    t.mock.method(slots, 'update', async (code, patch) => ({ ...slot, ...patch }));
    t.mock.method(t8, 'find', async () => [{ st_no: '101' }]);
    const update = t.mock.method(t8, 'update', async () => {});
    await service.updateSlot(slot.code, { actorId: 'ITEST', active: false });
    assert.equal(update.mock.calls[0].arguments[0].active, false);
    assert.equal(update.mock.calls[0].arguments[3], query);
});

test('deletes both records only when WHS and T8 have no references', async (t) => {
    const query = setup(t);
    const slot = { code: 'GIF3-A1-01-06', warehouse: 'GIF3' };
    t.mock.method(slots, 'byCode', async () => slot);
    let referenced = true;
    t.mock.method(slots, 'hasReferences', async () => referenced);
    t.mock.method(t8, 'find', async () => [{ st_no: '101' }]);
    t.mock.method(t8, 'hasReferences', async () => false);
    const removeT8 = t.mock.method(t8, 'remove', async () => {});
    const removeWhs = t.mock.method(slots, 'deleteByCode', async () => {});
    await assert.rejects(service.deleteSlot(slot.code, 'ITEST'), /slot_in_use/);
    assert.equal(removeT8.mock.callCount(), 0);
    referenced = false;
    await service.deleteSlot(slot.code, 'ITEST');
    assert.deepEqual(removeT8.mock.calls[0].arguments, ['101', slot.code, query]);
    assert.deepEqual(removeWhs.mock.calls[0].arguments, [slot.code, query]);
});
