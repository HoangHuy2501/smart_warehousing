/**
 * 2 tai khoan test raw trong code (yeu cau 2026-10-16):
 * du lieu that chua co t8_bas_emp / whs_user_role nen can tai khoan
 * co san de test FE truoc khi tich hop du lieu that.
 *
 * - duoc chen vao whs_user_role khi khoi dong server (idempotent:
 *   chi INSERT khi chua co, KHONG xoa / sua du lieu hien co).
 * - ho so ten/email la du lieu raw o day: khi account chua co ho so
 *   trong t8_bas_emp thi mapper lay ten/email tu day (khong ghi t8_*).
 * - khi tich hop du lieu that, xoa file nay + hai diem dung no
 *   (repository/index.js ensureTestAccounts, account.repository.js
 *   mapAccountRow) la het; khong anh huong logic khac.
 */

'use strict';

const TEST_ACCOUNTS = [
  {
    emp_no: 'TEST-MGR',
    role: 'MANAGER', // CHỦ QUẢN
    // username: 'test.manager',
    password: '123456',
    locked: false,
    active: true,
    emp_name: 'Chủ quản Test',
    email: 'test.manager@germton.com',
  },
  {
    emp_no: 'TEST-KPR',
    role: 'KEEPER', // THỦ KHO
    // username: 'test.keeper',
    password: '123456',
    locked: false,
    active: true,
    emp_name: 'Thủ kho Test',
    email: 'test.keeper@germton.com',
  },
];

/** Tim ho so raw theo emp_no (tra {emp_name, email} hoac null). */
function findTestProfile(empNo) {
  const found = TEST_ACCOUNTS.find((acc) => acc.emp_no === empNo);
  return found ? { emp_name: found.emp_name, email: found.email, password: found.password } : null;
}

module.exports = { TEST_ACCOUNTS, findTestProfile };
