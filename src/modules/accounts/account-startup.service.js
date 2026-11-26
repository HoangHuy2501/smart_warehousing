'use strict';

const { TEST_ACCOUNTS } = require('../../config/test-accounts');

let startupPromise = null;

/**
 * Chèn idempotent 2 tài khoản test raw (TEST-MGR / TEST-KPR) vào
 * whs_user_role — chỉ INSERT khi chưa có emp_no, không xóa / sửa bất kỳ
 * dòng nào khác (an toàn trên dữ liệu thật).
 */
async function ensureTestAccounts() {
  const AccountsRepository = require('./account.repository');
  for (const acc of TEST_ACCOUNTS) {
    const existing = await AccountsRepository.byId(acc.emp_no);
    if (!existing) {
      await AccountsRepository.insert({
        employeeCode: acc.emp_no,
        role: acc.role,
        locked: acc.locked,
        password: acc.password,
        active: acc.active,
      });
    }
  }
}

/**
 * Khởi động repository (gọi 1 lần khi boot server):
 * - sqlserver / test-postgres: chèn tài khoản test raw. Chạy nền không chặn
 *   listen; lỗi chỉ log và cho phép thử lại ở lần gọi sau (startupPromise
 *   được reset về null để lần gọi kế tiếp khởi động lại).
 */
function ensureStartup() {
  if (!startupPromise) {
    startupPromise = ensureTestAccounts().catch((error) => {
      startupPromise = null; // reset để lần gọi sau có thể thử lại
      throw error;
    });
  }
  return startupPromise;
}

module.exports = { ensureStartup };
