'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const audit = require('../src/util/sql-audit');
const { shared } = require('../src/shared/shared');
const activities = require('../src/modules/activity/activity.repository');

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
