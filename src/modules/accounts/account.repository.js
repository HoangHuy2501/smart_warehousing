'use strict';

/**
 * Repository bảng whs_user_role (tài khoản demo) JOIN t8_bas_emp
 * (hồ sơ nhân viên — tên, email).
 *
 * Kiến trúc (refactor 2026-10-26 lần 2 theo yêu cầu user — SQL thực thi
 * trực tiếp trong method, không còn tầng hàm sqlXxx/exec): AccountModel
 * là class singleton (module.exports = new); MỖI public method tự khai
 * báo câu SQL ngay trong method (const sql = `...`) và tự gọi
 * db.query(toDialect(sql), params) — toDialect() chỉ là chuyển đổi
 * dialect, không phải tầng builder. Tham số bind QUA PLACEHOLDER `?` —
 * db.js tự đổi thành @p1.. (SQL Server) hoặc $1.. (PostgreSQL), tuyệt
 * đối KHÔNG nối giá trị trực tiếp vào chuỗi SQL. Alias [camelCase] giữ
 * đúng shape service/FE cần — SQL tự alias đủ nên KHÔNG cần row-mapper.
 *
 * Test SSMS: copy câu SQL (kèm comment -- DECLARE) sang SSMS, uncomment
 * dòng DECLARE, thay ? bằng biến tương ứng là chạy được ngay.
 *
 * DUAL DIALECT (SQL Server production + PostgreSQL sandbox test):
 * SQL viết theo cú pháp SQL Server; toDialect() chỉ chuyển 3 chỗ PG
 * không chấp nhận nguyên văn (bracket alias / NVARCHAR / LIKE->ILIKE).
 *
 * account id = emp_no (t8_bas_emp.emp_no). whs_user_role chỉ lưu
 * role/password/locked/active; hồ sơ (name/email) nằm trên t8_bas_emp.
 *
 * Phần INSERT/UPDATE động theo patch runtime (insert/insertRaw/update)
 * dùng builder private buildInsert/buildRawInsert/buildUpdate — cột lấy
 * từ ACCOUNT_COLUMNS (whitelist). Refactor 2026-10-26 lần 3 (mẫu Kanban):
 * repository CHỈ làm data access — các method ghi trả thẳng raw row từ
 * OUTPUT inserted.* (SQL Server) / RETURNING * (PostgreSQL), KHÔNG
 * tự refetch để dựng domain object; fallback hồ sơ test và mapping
 * nghiệp vụ nằm ở service (services/shared.js withTestProfile).
 *
 * repository (xem cuối file).
 */

const db = require('../../config/db');
const pagination = require('../../util/pagination');
const { TABLES } = require('../../config/tables');

// ==================== PRIVATE: HỖ TRỢ DIALECT + GUARD ====================

/** Dialect hiện tại có phải PostgreSQL (chỉ dùng cho sandbox test)? */
function isPg() {
  return db.getDialect() === 'pg';
}

/**
 * Chuyển câu SQL (viết cú pháp SQL Server) sang PostgreSQL khi chạy
 * sandbox — 3 thay đổi PG không hỗ trợ nguyên văn:
 *   1. Alias [camelCase] -> "camelCase" (PG không hiểu bracket alias)
 *   2. NVARCHAR(n) -> VARCHAR(n) (PG không có kiểu NVARCHAR)
 *   3. LIKE -> ILIKE (PG LIKE phân biệt hoa thường — ILIKE giữ hành vi
 *      tìm kiếm case-insensitive như collation mặc định của SQL Server)
 * SQL Server trả về nguyên văn từng ký tự.
 * @param {string} text câu SQL gốc (cú pháp SQL Server, placeholder ?)
 * @returns {string} câu SQL theo dialect hiện tại
 */
function toDialect(text) {
  if (!isPg()) return text;
  return text
    .replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"')
    .replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(')
    .replace(/\bLIKE\b/g, 'ILIKE');
}

/**
 * Chặn sớm tham số undefined trước khi xuống driver — giữ hành vi guard
 * cũ (trước đây nằm trong exec/sql-params, đã loại bỏ theo yêu cầu user).
 * @param {unknown[]} params tham số theo thứ tự placeholder
 */
function guardParams(params) {
  if (params.includes(undefined)) {
    throw new Error(
      '[account.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

// ==================== PRIVATE: BUILDER INSERT/UPDATE ĐỘNG ====================

/** map camelCase (domain) -> tên cột DB của whs_user_role. */
const ACCOUNT_COLUMNS = {
  employeeCode: 'emp_no',
  // username: 'username', // đã bỏ khỏi contract 2026-10-17
  role: 'role',
  locked: 'locked',
  password: 'password',
  active: 'active',
};

/**
 * Dựng câu UPDATE động từ patch camelCase (chỉ những field có trong patch
 * + columnMap — không đè field không truyền).
 * @param {string} table tên bảng thật
 * @param {Record<string, unknown>} patch domain object camelCase sẽ SET
 * @param {string} whereKey khóa chính ở dạng camelCase ('employeeCode')
 * @param {unknown} whereValue giá trị khóa (truyền riêng vì patch không chứa khóa)
 * @param {Record<string, string>} columnMap map camelCase -> tên cột DB
 * @returns {{ text: string, values: unknown[] } | null} null nếu patch rỗng
 */
function buildUpdate(table, patch, whereKey, whereValue, columnMap, allowedRoles) {
  const keys = Object.keys(patch).filter((key) => columnMap[key] !== undefined);
  if (keys.length === 0) return null;

  const sets = keys.map((key) => `${columnMap[key]} = ?`);
  const values = keys.map((key) => patch[key] ?? null);
  values.push(whereValue, ...(allowedRoles || []));
  const roleFilter = allowedRoles ? ` AND role IN (${allowedRoles.map(() => '?').join(', ')})` : '';

  const text = isPg()
    ? `UPDATE ${table} SET ${sets.join(', ')} WHERE ${columnMap[whereKey]} = ?${roleFilter} RETURNING *`
    : `UPDATE ${table} SET ${sets.join(', ')} OUTPUT inserted.* WHERE ${columnMap[whereKey]} = ?${roleFilter}`;

  return { text, values };
}

// ==================== CLASS REPOSITORY ====================

class AccountModel {
  /** Danh sách tài khoản (sắp theo emp_no). Không tham số. */
  async list() {
    const sql = `
    -- DECLARE khong can tham so.
    SELECT
      r.emp_no AS [id],
      e.emp_name AS [name],
      r.emp_no AS [employeeCode],
      CAST(NULL AS NVARCHAR(255)) AS [email],
      r.role AS [role],
      r.locked AS [locked],
      r.password AS [password],
      r.active AS [active]
    FROM whs_user_role r
    LEFT JOIN bas_emp e ON e.emp_no = r.emp_no
    ORDER BY r.emp_no
    `;
    const params = [];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  // Danh sách và tổng số dòng dùng cùng bộ lọc.
  async listPaged(page, pageSize) {

    const listSql = `
    SELECT
      r.emp_no AS [id],
      e.emp_name AS [name],
      r.emp_no AS [employeeCode],
      CAST(NULL AS NVARCHAR(255)) AS [email],
      r.role AS [role],
      r.locked AS [locked],
      r.password AS [password],
      r.active AS [active]
    FROM whs_user_role r
    LEFT JOIN bas_emp e ON e.emp_no = r.emp_no
    `;
    const result = await pagination({
      query: toDialect(listSql),
      orderBy: toDialect('[id]'),
      page,
      pageSize,
    });
    return { rows: result.data, total: result.pagination.totalItems };
  }

  /** Tìm tài khoản theo emp_no (= account id) — null nếu không có dòng. */
  async byId(empNo) {
    const sql = `
    -- DECLARE @empNo NVARCHAR(40) = 'TEST-KPR';
    SELECT
      r.emp_no AS [id],
      e.emp_name AS [name],
      r.emp_no AS [employeeCode],
      CAST(NULL AS NVARCHAR(255)) AS [email],
      r.role AS [role],
      r.locked AS [locked],
      r.password AS [password],
      r.active AS [active]
    FROM whs_user_role r
    LEFT JOIN bas_emp e ON e.emp_no = r.emp_no
    WHERE r.emp_no = ?
    `;
    const params = [empNo];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null;
  }

  // POST /accounts — tạo tài khoản kho.
  async insert(account, query = db.query) {
    const sql = `
      INSERT INTO ${TABLES.userRole} (emp_no, role, locked, password, active)
      ${isPg() ? '' : 'OUTPUT inserted.*'}
      VALUES (?, ?, ?, ?, ?)
      ${isPg() ? 'RETURNING *' : ''}
    `;
    const params = [account.employeeCode, account.role, account.locked ?? false,
      account.password, account.active ?? true];
    try {
      const { rows } = await query(sql, params);
      return rows[0] || null;
    } catch (error) {
      if ([2601, 2627].includes(error.number) || error.code === '23505') return null;
      throw error;
    }
  }

  /**
   * UPDATE tài khoản theo emp_no — chỉ cập nhật field có trong patch
   * (ĐỘNG). OUTPUT inserted.* / RETURNING * chỉ trả dòng khi WHERE khớp —
   * caller dựa vào non-null để biết có dòng nào được cập nhật hay không.
   * Trả raw row vừa ghi, KHÔNG refetch — service đọc lại bằng byId khi
   * cần shape đầy đủ.
   * @param {string} empNo mã nhân viên (khóa tìm)
   * @param {Record<string, unknown>} patch các field camelCase cần cập nhật
   * @returns {Promise<Record<string, unknown> | null>} raw row vừa ghi hoặc null nếu không khớp dòng nào
   */
  async update(empNo, patch, query = db.query, allowedRoles) {
    const update = buildUpdate(
      TABLES.userRole,
      patch,
      'employeeCode',
      empNo,
      ACCOUNT_COLUMNS,
      allowedRoles
    );
    if (!update) return null;
    const { rows } = await query(update.text, update.values);
    return rows[0] || null;
  }

  /**
   * Đổi mã nhân sự: cập nhật mọi tham chiếu whs_user_role / whs_slots
   * (thủ kho quản lý kệ) / whs_slot_allocation (người gán kệ) — t8_bas_emp
   * do T8-simulator đổi riêng. 3 câu UPDATE chạy liền tiếp theo đúng thứ
   * tự, mỗi câu SQL khai báo inline ngay trong method.
   * @param {string} oldEmpNo mã nhân viên cũ
   * @param {string} newEmpNo mã nhân viên mới
   * @returns {Promise<void>}
   */
  async renameEmpNo(oldEmpNo, newEmpNo) {
    const userRoleSql = `
    -- DECLARE @oldEmpNo NVARCHAR(40) = 'EMP-001';
    -- DECLARE @newEmpNo NVARCHAR(40) = 'EMP-002';
    UPDATE whs_user_role
    SET emp_no = ?
    WHERE emp_no = ?
    `;
    const userRoleParams = [newEmpNo, oldEmpNo];
    guardParams(userRoleParams);
    await db.query(toDialect(userRoleSql), userRoleParams);

    const slotsSql = `
    -- DECLARE @oldEmpNo NVARCHAR(40) = 'EMP-001';
    -- DECLARE @newEmpNo NVARCHAR(40) = 'EMP-002';
    UPDATE whs_slots
    SET keeper_emp_no = ?
    WHERE keeper_emp_no = ?
    `;
    const slotsParams = [newEmpNo, oldEmpNo];
    guardParams(slotsParams);
    await db.query(toDialect(slotsSql), slotsParams);

    const allocationSql = `
    -- DECLARE @oldEmpNo NVARCHAR(40) = 'EMP-001';
    -- DECLARE @newEmpNo NVARCHAR(40) = 'EMP-002';
    UPDATE whs_slot_allocation
    SET allocated_by_emp_no = ?
    WHERE allocated_by_emp_no = ?
    `;
    const allocationParams = [newEmpNo, oldEmpNo];
    guardParams(allocationParams);
    await db.query(toDialect(allocationSql), allocationParams);
  }

  /** Xóa toàn bộ tài khoản (chỉ dùng trong reset seed). Không tham số. */
  async deleteAll(query = db.query) {
    const sql = `
    -- DECLARE khong can tham so.
    DELETE FROM whs_user_role
    `;
    const params = [];
    guardParams(params);
    await query(toDialect(sql), params);
  }
}

module.exports = new AccountModel();
module.exports.AccountModel = AccountModel;
