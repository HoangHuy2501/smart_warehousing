/**
 * Tầng repository — kiến trúc singleton class (tái cấu trúc 2026-10-17):
 * mỗi domain repository là 1 file riêng, tự export instance (SQL mode) hoặc
 * cắt lát từ memory repository (DB_MODE=memory):
 *   sql/account.repository.js   -> AccountModel
 *   sql/slot.repository.js      -> SlotModel
 *   sql/po.repository.js        -> PoModel
 *   sql/lot.repository.js       -> LotModel
 *   sql/activity.repository.js  -> ActivityModel
 *   sql/t8.repository.js        -> T8Model (T8-simulator — ghi t8 ĐANG TẮT)
 *   sql/reset.repository.js     -> ResetModel (resetAll — chỉ gọi từ reset,
 *                                  endpoint reset hiện ĐANG TẮT)
 * Service import trực tiếp từng file — không còn factory ở đây.
 *
 * Repository = tầng truy cập DB: mỗi method gọi hàm SQL tương ứng trong
 * queries/*.queries.js và truyền biến trực tiếp qua lớp mỏng
 * run(queries.xxx(a, b)) của sql/sql-params.js.
 *
 * File này chỉ còn 1 nhiệm vụ khởi động: ensureStartup() — chèn 2 tài khoản
 * test raw (idempotent, yêu cầu 2026-10-16) khi chạy với DB thật
 * (sqlserver / test-postgres). Được server.js gọi sau khi listen.
 */

'use strict';

const { getMode } = require('../config/db');
const { TEST_ACCOUNTS } = require('../config/test-accounts');

let startupPromise = null;

/**
 * Chèn idempotent 2 tài khoản test raw (TEST-MGR / TEST-KPR) vào
 * whs_user_role — chỉ INSERT khi chưa có emp_no, không xóa / sửa bất kỳ
 * dòng nào khác (an toàn trên dữ liệu thật).
 */
async function ensureTestAccounts() {
  const AccountsRepository = require('./sql/account.repository');
  for (const acc of TEST_ACCOUNTS) {
    const existing = await AccountsRepository.byId(acc.emp_no);
    if (!existing) {
      const { emp_name, email, ...roleRow } = acc;
      void emp_name;
      void email;
      await AccountsRepository.insertRaw(roleRow);
    }
  }
}

/**
 * Khởi động repository (gọi 1 lần khi boot server):
 * - memory: không làm gì (memory.repository tự nạp dữ liệu seed riêng).
 * - sqlserver / test-postgres: chèn tài khoản test raw. Chạy nền không chặn
 *   listen; lỗi chỉ log và cho phép thử lại ở lần gọi sau (startupPromise
 *   được reset về null để lần gọi kế tiếp khởi động lại).
 */
function ensureStartup() {
  if (getMode() === 'memory') return Promise.resolve();
  if (!startupPromise) {
    startupPromise = ensureTestAccounts().catch((error) => {
      startupPromise = null; // reset để lần gọi sau có thể thử lại
      throw error;
    });
  }
  return startupPromise;
}

module.exports = { ensureStartup };
