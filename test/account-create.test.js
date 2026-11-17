'use strict';

process.env.DB_MODE = 'memory';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const accounts = require('../src/services/account.service');
const employees = require('../src/repository/sql/t8.repository');

test('manager looks up and creates one keeper account by employee code', async () => {
  await employees.createEmployee({ id: 999, emp_no: '00042', emp_name: 'Nhân viên mẫu' });

  const managerId = 'EMP003';
  const employee = { employeeCode: '00042', name: 'Nhân viên mẫu', email: null };
  assert.deepEqual(await accounts.lookupEmployee(' 00042 ', managerId),
    { ...employee, accountExists: false });

  await assert.rejects(accounts.lookupEmployee('00042', 'EMP001'), { httpStatus: 403 });
  await assert.rejects(accounts.lookupEmployee('MISSING', managerId), { httpStatus: 404 });
  for (const invalid of [undefined, 42, '', 'A B', 'x'.repeat(21)]) {
    await assert.rejects(accounts.createAccount({ actorId: managerId, employeeCode: invalid }),
      { message: 'invalid_employee_code' });
  }

  const dto = { actorId: managerId, employeeCode: '00042', role: 'MANAGER', name: 'Fake' };
  const attempts = await Promise.allSettled([accounts.createAccount(dto), accounts.createAccount(dto)]);
  const created = attempts.filter(({ status }) => status === 'fulfilled');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].value, { ...employee, id: '00042', role: 'KEEPER', locked: false });
  assert.equal(attempts.find(({ status }) => status === 'rejected').reason.message, 'code_exists');
  assert.equal((await accounts.lookupEmployee('00042', managerId)).accountExists, true);
});
