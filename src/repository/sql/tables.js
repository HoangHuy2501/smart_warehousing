/**
 * Danh sách tên bảng dùng trong mọi câu SQL của repository (mapping tên
 * logic -> tên thật, gắn tiền tố nếu cần).
 * - T8 mock (business layer chỉ ĐỌC; riêng T8-simulator được ghi):
 *     t8_bas_emp, t8_bas_goods, t8_pur_order1/2, t8_pur_notice1/2,
 *     t8_pur_in1/2 + view t8_v_pur_notice_detail.
 * - Smart Warehouse: whs_user_role, whs_slots, whs_slot_allocation,
 *   whs_allocation_receipt (mapping allocation <-> notice2),
 *   whs_slot_movement, whs_activity, whs_keeper_material_assignment.
 * - Chế độ TEST PostgreSQL (sandbox MiaoDa): các bảng whs_* / t8_* đã nằm
 *   sẵn trong schema workspace (xem test/db.test.config.js) nên dùng
 *   TÊN BẢNG TRẦN — không còn tiền tố whs3_.
 * - Có thể ghi đè bằng biến môi trường DB_TABLE_PREFIX nếu cần (ví dụ môi
 *   trường sandbox riêng biệt đòi tiền tố whs3_).
 */

'use strict';

const { resolveDbConfig } = require('../../config/db.config');

/**
 * Quyết định tiền tố bảng (chạy 1 lần khi load module — DB_MODE không đổi
 * trong suốt runtime của process).
 * @returns {string} tiền tố gắn trước mọi tên bảng trong TABLES
 */
function resolveTablePrefix() {
  if (process.env.DB_TABLE_PREFIX !== undefined) {
    return process.env.DB_TABLE_PREFIX;
  }
  // test-postgres: bảng đã tạo sẵn trong schema workspace, dùng tên trần.
  if (resolveDbConfig().mode === 'test-postgres') {
    return '';
  }
  return '';
}

const prefix = resolveTablePrefix();

const TABLES = {
  // ---- T8 mock (mock Germton T8 ERP) ----
  emps: `${prefix}bas_emp`,
  goods: `${prefix}bas_goods`,
  order1: `${prefix}pur_order1`,
  order2: `${prefix}pur_order2`,
  notice1: `${prefix}pur_notice1`,
  notice2: `${prefix}pur_notice2`,
  noticeDetailView: `${prefix}v_pur_notice_detail`, // view (read-only)
  in1: `${prefix}pur_in1`,
  in2: `${prefix}pur_in2`,
  // ---- Smart Warehouse ----
  userRole: `${prefix}whs_user_role`,
  slots: `${prefix}whs_slots`,
  allocation: `${prefix}whs_slot_allocation`,
  receipt: `${prefix}whs_allocation_receipt`,
  movement: `${prefix}whs_slot_movement`,
  activity: `${prefix}whs_activity`,
  keeperMaterialAssignment: `${prefix}whs_keeper_material_assignment`,
  reconcileIssue: `${prefix}whs_reconcile_issue`,
};

module.exports = { TABLES };
