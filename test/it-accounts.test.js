'use strict';

process.env.DB_MODE = 'memory';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const accounts = require('../src/services/account.service');
const dashboard = require('../src/services/it-dashboard.service');
const employees = require('../src/repository/sql/t8.repository');
const roles = require('../src/repository/sql/account.repository');

test('IT can create and reset all roles with a password-free audit trail', async () => {
  await roles.insert({ employeeCode: 'IT-TEST', role: 'IT', active: true });
  const createdIds = [];
  for (const [index, role] of ['KEEPER', 'MANAGER', 'IT'].entries()) {
    const employeeCode = `NEW-${index}`;
    await employees.createEmployee({ id: 950 + index, emp_no: employeeCode, emp_name: employeeCode });
    const created = await accounts.createAccount({ actorId: 'IT-TEST', employeeCode, role, password: 'test-pass' });
    assert.equal(created.role, role);
    assert.equal(created.password, undefined);
    await accounts.resetAccountPassword(employeeCode, { actorId: 'IT-TEST', newPassword: 'changed-pass' });
    assert.equal((await roles.byId(employeeCode)).password, 'changed-pass');
    createdIds.push(employeeCode);
  }

  await assert.rejects(accounts.resetAccountPassword(createdIds[2], {
    actorId: 'EMP003', newPassword: 'manager-pass',
  }), { httpStatus: 404 });
  await assert.rejects(dashboard.audit({}, 'EMP003'), { httpStatus: 403 });

  const audit = await dashboard.audit({ page: 1, pageSize: 3 }, 'IT-TEST');
  assert.equal(audit.total, 6);
  assert.equal(audit.items.length, 3);
  const all = await dashboard.audit({}, 'IT-TEST');
  assert.equal(all.items.filter(({ actionKey }) => actionKey === 'ACCOUNT_CREATED').length, 3);
  assert.equal(all.items.filter(({ actionKey }) => actionKey === 'ACCOUNT_PASSWORD_RESET').length, 3);
  assert.doesNotMatch(JSON.stringify(all), /test-pass|changed-pass|manager-pass/);
});
