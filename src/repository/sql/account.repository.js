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
 * DB_MODE=memory thì module.exports swap sang cắt lát của memory
 * repository (xem cuối file).
 */

const db = require('../../config/db');
const { TABLES } = require('./tables');

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

// Các field kiểu JSON — ghi xuống DB dưới dạng chuỗi JSON.stringify
// (nếu có trong columnMap), đọc lên service tự parse lại.
const JSON_FIELDS = ['iqcHistory'];

/**
 * Dựng câu INSERT động từ domain object camelCase qua columnMap (cột thay
 * đổi theo object runtime nên không thể viết tĩnh). Chỉ nhận cột có trong
 * columnMap (whitelist). Vị trí mệnh đề lấy về dòng vừa ghi khác nhau
 * theo dialect: SQL Server đặt OUTPUT inserted.* TRƯỚC VALUES; PG bắt
 * RETURNING ở CUỐI câu — sai vị trí là PG từ chối cú pháp.
 * @param {string} table tên bảng thật (đã qua TABLES)
 * @param {Record<string, unknown>} obj domain object camelCase
 * @param {Record<string, string>} columnMap map camelCase -> tên cột DB
 * @returns {{ text: string, values: unknown[] } | null} null nếu không có cột hợp lệ
 */
function buildInsert(table, obj, columnMap) {
  const keys = Object.keys(obj).filter((key) => columnMap[key] !== undefined);
  if (keys.length === 0) return null;

  const cols = keys.map((key) => columnMap[key]);
  const values = keys.map((key) => {
    if (JSON_FIELDS.includes(key)) {
      return obj[key] === null || obj[key] === undefined ? null : JSON.stringify(obj[key]);
    }
    return obj[key] === undefined ? null : obj[key];
  });
  const placeholders = keys.map(() => '?').join(', ');

  const text = isPg()
    ? `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`
    : `INSERT INTO ${table} (${cols.join(', ')}) OUTPUT inserted.* VALUES (${placeholders})`;

  return { text, values };
}

/**
 * Dựng câu INSERT trực tiếp từ row có key = TÊN CỘT DB (snake_case) —
 * dùng cho seed (key trùng tên cột).
 * @param {string} table tên bảng thật
 * @param {Record<string, unknown>} row row key = tên cột DB
 * @returns {{ text: string, values: unknown[] } | null} null nếu row rỗng
 */
function buildRawInsert(table, row) {
  const keys = Object.keys(row);
  if (keys.length === 0) return null;

  const cols = keys.join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const text = isPg()
    ? `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`
    : `INSERT INTO ${table} (${cols}) OUTPUT inserted.* VALUES (${placeholders})`;

  return { text, values: keys.map((key) => row[key]) };
}

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
function buildUpdate(table, patch, whereKey, whereValue, columnMap) {
  const keys = Object.keys(patch).filter((key) => columnMap[key] !== undefined);
  if (keys.length === 0) return null;

  const sets = keys.map((key) => `${columnMap[key]} = ?`);
  const values = keys.map((key) => {
    if (JSON_FIELDS.includes(key)) {
      return patch[key] === null || patch[key] === undefined ? null : JSON.stringify(patch[key]);
    }
    return patch[key] === undefined ? null : patch[key];
  });
  values.push(whereValue);

  const text = isPg()
    ? `UPDATE ${table} SET ${sets.join(', ')} WHERE ${columnMap[whereKey]} = ? RETURNING *`
    : `UPDATE ${table} SET ${sets.join(', ')} OUTPUT inserted.* WHERE ${columnMap[whereKey]} = ?`;

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
      e.email AS [email],
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

  /**
   * Phân trang tài khoản (GET /accounts?page=&pageSize=). total = COUNT
   * qua subselect dùng đúng tập hợp — 2 câu chạy song song Promise.all.
   * @param {number} page trang 1-indexed
   * @param {number} pageSize số dòng mỗi trang
   * @returns {Promise<{ rows: Record<string, unknown>[], total: number }>}
   */
  async listPaged(page, pageSize) {
    const offset = (page - 1) * pageSize;

    const listSql = `
    -- DECLARE @offset INT = 0;
    -- DECLARE @pageSize INT = 20;
    SELECT
      r.emp_no AS [id],
      e.emp_name AS [name],
      r.emp_no AS [employeeCode],
      e.email AS [email],
      r.role AS [role],
      r.locked AS [locked],
      r.password AS [password],
      r.active AS [active]
    FROM whs_user_role r
    LEFT JOIN bas_emp e ON e.emp_no = r.emp_no
    ORDER BY r.emp_no
    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
    `;
    const listParams = [offset, pageSize];

    // COUNT qua subselect trên đúng tập dữ liệu của list (kể cả LEFT JOIN)
    // — không tham số.
    const countSql = `
    -- DECLARE khong can tham so.
    SELECT COUNT(*) AS [total]
    FROM (
      SELECT r.emp_no, r.role, r.password, r.locked, r.active,
             e.emp_name, e.email
      FROM whs_user_role r
      LEFT JOIN bas_emp e ON e.emp_no = r.emp_no
    ) sub
    `;
    const countParams = [];

    guardParams(listParams);
    guardParams(countParams);
    const [list, counted] = await Promise.all([
      db.query(toDialect(listSql), listParams),
      db.query(toDialect(countSql), countParams),
    ]);
    return {
      rows: list.rows,
      total: Number(counted.rows[0] ? counted.rows[0].total : 0),
    };
  }

  /** Tìm tài khoản theo emp_no (= account id) — null nếu không có dòng. */
  async byId(empNo) {
    const sql = `
    -- DECLARE @empNo NVARCHAR(40) = 'TEST-KPR';
    SELECT
      r.emp_no AS [id],
      e.emp_name AS [name],
      r.emp_no AS [employeeCode],
      e.email AS [email],
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

  /**
   * Thêm tài khoản (chỉ whs_user_role) từ domain object camelCase
   * (ĐỘNG — buildInsert): employeeCode, role, locked, password, active.
   * Trả thẳng raw row vừa ghi (cột whs_user_role) — service tự đọc lại
   * bằng byId khi cần shape đầy đủ (JOIN t8_bas_emp).
   * @param {Record<string, unknown>} account domain object camelCase
   * @returns {Promise<Record<string, unknown> | null>} raw row vừa ghi hoặc null
   */
  async insert(account) {
    const insert = buildInsert(TABLES.userRole, account, ACCOUNT_COLUMNS);
    if (!insert) return null;
    const { rows } = await db.query(insert.text, insert.values);
    return rows[0] || null;
  }

  /**
   * Thêm tài khoản từ row có key = tên cột DB (snake_case) — dùng cho
   * seed. Tham số `query` tùy chọn: reset truyền txQuery để chạy trong
   * cùng transaction. Trả raw row vừa ghi — caller hiện tại (seed /
   * ensureStartup) không dùng giá trị trả về, chỉ cần ghi thành công.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>} raw row vừa ghi hoặc null
   */
  async insertRaw(row, query = db.query) {
    const insert = buildRawInsert(TABLES.userRole, row);
    const { rows } = await query(insert.text, insert.values);
    return rows[0] || null;
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
  async update(empNo, patch) {
    const update = buildUpdate(
      TABLES.userRole,
      patch,
      'employeeCode',
      empNo,
      ACCOUNT_COLUMNS
    );
    if (!update) return null;
    const { rows } = await db.query(update.text, update.values);
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

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository().accounts;
} else {
  module.exports = new AccountModel();
  module.exports.AccountModel = AccountModel; // for reset.repository tx use
}
