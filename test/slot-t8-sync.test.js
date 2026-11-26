'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/config/db');
const { shared } = require('../src/shared/shared');
const slots = require('../src/modules/slots/slot.repository');
const accounts = require('../src/modules/accounts/account.repository');
const t8 = require('../src/modules/slots/t8-slot.repository');
const service = require('../src/modules/slots/slot.service');

const code = 'GIF3-A1-01-06';
const nextCode = 'GIF3-A1-01-07';
const slot = { code, warehouse: 'GIF3', row: 'A1', floor: '01', position: '06', active: true };

function setup(t, id = 'TEST-MGR', role = 'MANAGER') {
    const query = () => assert.fail('repository mocks should handle SQL');
    t.mock.method(db, 'withTransaction', async (callback) => callback(query));
    t.mock.method(shared, 'getActor', async () => ({ id, role, active: true }));
    t.mock.method(shared, 'logActivity', async () => {});
    t.mock.method(t8, 'lock', async () => {});
    return query;
}

for (const [empNo, expected] of [['TEST-MGR', 'ADM'], ['test1234', 'ADM'], ['NV0123', 'NV0123']]) {
    test('maps T8 modify_user for employee ' + empNo, async (t) => {
        const query = setup(t, empNo);
        t.mock.method(slots, 'byCode', async () => null);
        const insertWhs = t.mock.method(slots, 'insert', async (value) => value);
        t.mock.method(t8, 'find', async () => []);
        const insertT8 = t.mock.method(t8, 'insert', async () => {});
        const result = await service.createSlot({ actorId: empNo, warehouse: 'GIF3', row: 'A1', floor: '01', position: '06' });
        assert.equal(result.code, code);
        assert.equal(insertWhs.mock.calls[0].arguments[1], query);
        assert.deepEqual(insertT8.mock.calls[0].arguments.slice(1), ['101', expected, query]);
    });
}

test('uses an existing matching T8 shelf but rejects a different warehouse', async (t) => {
    setup(t);
    t.mock.method(slots, 'byCode', async () => null);
    t.mock.method(slots, 'insert', async (value) => value);
    let stNo = '101';
    t.mock.method(t8, 'find', async () => [{ st_no: stNo }]);
    const rename = t.mock.method(t8, 'rename', async () => {});
    const dto = { actorId: 'TEST-MGR', warehouse: 'GIF3', row: 'A1', floor: '01', position: '06' };
    await service.createSlot(dto);
    assert.deepEqual(rename.mock.calls[0].arguments.slice(0, 4), [code, code, '101', 'ADM']);
    stNo = '102';
    await assert.rejects(service.createSlot(dto), /t8_slot_conflict/);
});

test('lock/full/active updates and keeper assignment do not read or write T8 locations', async (t) => {
    setup(t);
    t.mock.method(slots, 'byCode', async () => slot);
    t.mock.method(slots, 'hasNonReturnedAllocation', async () => false);
    t.mock.method(slots, 'update', async (key, patch) => ({ ...slot, ...patch }));
    t.mock.method(accounts, 'list', async () => []);
    for (const method of ['find', 'insert', 'rename', 'hasReferences']) {
        t.mock.method(t8, method, async () => assert.fail('T8 method called: ' + method));
    }
    await service.updateSlot(code, { actorId: 'TEST-MGR', locked: true, full: true, active: false });
    await service.updateSlot(code, { actorId: 'TEST-MGR', code, full: false });
    await service.assignKeeper({ actorId: 'TEST-MGR', codes: [code], keeperId: 'NV001' });
});

test('renames an unused shelf code and location components in one transaction', async (t) => {
    const query = setup(t);
    t.mock.method(slots, 'byCode', async (key) => key === code ? slot : null);
    t.mock.method(slots, 'hasReferences', async () => false);
    t.mock.method(t8, 'find', async (key) => key === code ? [{ st_no: '101' }] : []);
    t.mock.method(t8, 'hasReferences', async () => false);
    const renameT8 = t.mock.method(t8, 'rename', async () => {});
    const updateWhs = t.mock.method(slots, 'update', async () => {});
    await service.updateSlot(code, { actorId: 'TEST-MGR', code: nextCode });
    assert.deepEqual(renameT8.mock.calls[0].arguments, [code, nextCode, '101', 'ADM', query]);
    assert.equal(updateWhs.mock.calls[0].arguments[0], code);
    assert.equal(updateWhs.mock.calls[0].arguments[1].code, nextCode);
    assert.equal(updateWhs.mock.calls[0].arguments[1].position, '07');
    assert.equal(updateWhs.mock.calls[0].arguments[2], query);
    assert.equal(service.deleteSlot, undefined);
});

test('rejects renaming a shelf referenced in WHS', async (t) => {
    setup(t);
    t.mock.method(slots, 'byCode', async (key) => key === code ? slot : null);
    t.mock.method(slots, 'hasReferences', async () => true);
    const renameT8 = t.mock.method(t8, 'rename', async () => {});
    await assert.rejects(service.updateSlot(code, { actorId: 'TEST-MGR', code: nextCode }), /slot_in_use/);
    assert.equal(renameT8.mock.callCount(), 0);
});

test('keepers cannot rename shelves', async (t) => {
    setup(t, 'NV001', 'KEEPER');
    const update = t.mock.method(slots, 'update', async () => {});
    await assert.rejects(service.updateSlot(code, { actorId: 'NV001', code: nextCode }), /no_permission/);
    assert.equal(update.mock.callCount(), 0);
});
