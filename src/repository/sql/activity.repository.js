'use strict';

/**
 * Repository bảng whs_activity (nhật ký hoạt động).
 *
 * Kiến trúc (refactor 2026-10-26 lần 2 theo yêu cầu user — SQL thực thi
 * trực tiếp trong method, không còn tầng hàm sqlXxx/exec): ActivityModel
 * là class singleton (module.exports = new); MỖI public method tự khai
 * báo câu SQL ngay trong method và tự gọi
 * db.query(toDialect(sql), params). Tham số bind QUA PLACEHOLDER `?` —
 * db.js tự đổi thành @p1.. (SQL Server) hoặc $1.. (PostgreSQL), tuyệt đối
 * KHÔNG nối giá trị trực tiếp vào chuỗi SQL. Alias [camelCase] giữ đúng
 * shape service/FE cần — SQL tự alias đủ nên KHÔNG cần row-mapper.
 *
 * Test SSMS: copy câu SQL (kèm comment -- DECLARE) sang SSMS, uncomment
 * dòng DECLARE, thay ? bằng biến tương ứng là chạy được ngay.
 *
 * DUAL DIALECT (SQL Server production + PostgreSQL sandbox test):
 * SQL viết theo cú pháp SQL Server; toDialect() chỉ chuyển 3 chỗ PG
 * không chấp nhận nguyên văn (xem JSDoc của toDialect). Phân trang dùng
 * cú pháp chuẩn OFFSET ... FETCH NEXT ... cả hai bên đều hỗ trợ.
 *
 * INSERT động theo object runtime (insert/insertRaw) dùng builder private
 * buildInsert/buildRawInsert — tên cột lấy từ ACTIVITY_COLUMNS (whitelist,
 * không nhận tên cột tùy ý từ input). Sau khi ghi, REFETCH bằng câu SELECT
 * theo id khai báo inline ngay trong method để trả shape camelCase đầy đủ
 * (row OUTPUT có key snake_case).
 *
 * DB_MODE=memory thì module.exports swap sang cắt lát của memory
 * repository (xem cuối file).
 */

const db = require('../../config/db');
const { TABLES } = require('./tables');

// ============== PRIVATE: HỖ TRỢ DIALECT + GUARD THAM SỐ ==============

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
      '[activity.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

// ==================== PRIVATE: BUILDER INSERT ĐỘNG ====================

/** map camelCase (domain) -> tên cột DB của whs_activity. */
const ACTIVITY_COLUMNS = {
  id: 'id',
  actedAt: 'acted_at',
  userId: 'emp_no',
  // 2026-10-19: DB thật vẫn còn cột user_name NOT NULL — phải ghi lại
  // (shared.logActivity truyền userName = tên nv, fallback = mã nv).
  // Read side (list/insert refetch) KHÔNG select cột này -> response shape
  // không đổi.
  userName: 'user_name',
  actionKey: 'action_key',
  allocationId: 'allocation_id',
  noticeDetailId: 'notice_detail_id',
  // po_id (INT, logical -> pur_order2.id): activity Assign Shelf xảy ra
  // TRƯỚC khi có notice nên phải lưu po_id (yêu cầu user 2026-10-17).
  poId: 'po_id',
  poNumber: 'po_number',
  slotCode: 'slot_code',
  qty: 'qty',
  unit: 'unit',
  detail: 'detail',
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

// ==================== CLASS REPOSITORY ====================

class ActivityModel {
  /**
   * Nhật ký gần nhất (sắp theo acted_at giảm dần, giới hạn `limit` dòng —
   * SQL trả tất cả, JS slice như cũ).
   * @param {number} [limit=50] số dòng giữ lại (<= 0 trả tất cả)
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async list(limit = 50) {
    const sql = `
    -- DECLARE khong can tham so.
    SELECT
      a.id AS [id],
      a.acted_at AS [time],
      a.emp_no AS [userId],
      a.action_key AS [actionKey],
      a.allocation_id AS [allocationId],
      a.notice_detail_id AS [noticeDetailId],
      a.po_id AS [poId],
      a.po_number AS [poNumber],
      a.slot_code AS [slotCode],
      CAST(a.qty AS FLOAT) AS [qty],
      a.unit AS [unit],
      a.detail AS [detail],
      'mock' AS [source]
    FROM whs_activity a
    ORDER BY a.acted_at DESC
  `;
    const params = [];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  /**
   * Ghi 1 dòng nhật ký từ domain object camelCase (ĐỘNG — buildInsert):
   * id, actedAt, userId, actionKey, allocationId, noticeDetailId, poId,
   * poNumber, slotCode, qty, unit, detail. actedAt mặc định = now.
   * Refetch theo id (PK VARCHAR(40)) để trả shape camelCase đầy đủ.
   * @param {Record<string, unknown>} activity domain object camelCase
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async insert(activity, query = db.query) {
    const row = { ...activity };
    if (!row.actedAt) row.actedAt = new Date().toISOString();
    const insert = buildInsert(TABLES.activity, row, ACTIVITY_COLUMNS);
    if (!insert) return null;
    const { rows } = await query(insert.text, insert.values);
    if (!rows[0]) return null;
    const sql = `
    -- DECLARE @id VARCHAR(40) = 'act-0001';
    SELECT
      a.id AS [id],
      a.acted_at AS [time],
      a.emp_no AS [userId],
      a.action_key AS [actionKey],
      a.allocation_id AS [allocationId],
      a.notice_detail_id AS [noticeDetailId],
      a.po_id AS [poId],
      a.po_number AS [poNumber],
      a.slot_code AS [slotCode],
      CAST(a.qty AS FLOAT) AS [qty],
      a.unit AS [unit],
      a.detail AS [detail],
      'mock' AS [source]
    FROM whs_activity a
    WHERE a.id = ?
  `;
    const params = [rows[0].id];
    guardParams(params);
    const { rows: refetched } = await query(toDialect(sql), params);
    return refetched[0] || null;
  }

  /**
   * UNDO ASSIGN (2026-11-07): tìm activity mới nhất của 1 allocation theo
   * action_key — dùng cho idempotency Undo (allocation đã delete nhưng còn
   * UNDO_ASSIGN trong history → ALREADY_UNDONE thay vì 404).
   * @param {string} allocationId PK allocation (đã delete vẫn tra cứu được
   *   vì allocation_id là logical key, không có FK vật lý)
   * @param {string} actionKey ví dụ 'UNDO_ASSIGN'
   * @param {Function} [query] executor (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>} row activity hoặc null
   */
  async findByAllocationAndActionKey(
    allocationId,
    actionKey,
    query = db.query
  ) {
    const sql = `
    -- DECLARE @allocationId VARCHAR(40) = 'al_abc123';
    -- DECLARE @actionKey VARCHAR(30) = 'UNDO_ASSIGN';
    SELECT
      a.id AS [id],
      a.acted_at AS [time],
      a.emp_no AS [userId],
      a.action_key AS [actionKey],
      a.allocation_id AS [allocationId],
      a.po_id AS [poId],
      a.po_number AS [poNumber],
      a.slot_code AS [slotCode],
      CAST(a.qty AS FLOAT) AS [qty],
      a.detail AS [detail]
    FROM whs_activity a
    WHERE a.allocation_id = ? AND a.action_key = ?
    ORDER BY a.acted_at DESC
    OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY;
  `;
    const params = [allocationId, actionKey];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return rows[0] || null;
  }
  /**
   * Ghi 1 dòng nhật ký từ row có key = tên cột DB (snake_case) — dùng
   * cho seed. Tham số `query` tùy chọn: reset truyền txQuery để chạy
   * trong cùng transaction (refetch cũng chạy trên tx đó).
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async insertRaw(row, query = db.query) {
    const raw = { ...row };
    if (!raw.acted_at) raw.acted_at = new Date().toISOString();
    const insert = buildRawInsert(TABLES.activity, raw);
    const { rows } = await query(insert.text, insert.values);
    if (!rows[0]) return null;
    const sql = `
    -- DECLARE @id VARCHAR(40) = 'act-0001';
    SELECT
      a.id AS [id],
      a.acted_at AS [time],
      a.emp_no AS [userId],
      a.action_key AS [actionKey],
      a.allocation_id AS [allocationId],
      a.notice_detail_id AS [noticeDetailId],
      a.po_id AS [poId],
      a.po_number AS [poNumber],
      a.slot_code AS [slotCode],
      CAST(a.qty AS FLOAT) AS [qty],
      a.unit AS [unit],
      a.detail AS [detail],
      'mock' AS [source]
    FROM whs_activity a
    WHERE a.id = ?
  `;
    const params = [rows[0].id];
    guardParams(params);
    const { rows: refetched } = await query(toDialect(sql), params);
    return refetched[0] || null;
  }

  /** Xóa toàn bộ activity (chỉ dùng trong reset seed). */
  async deleteAll(query = db.query) {
    const sql = `
    -- DECLARE khong can tham so.
    DELETE FROM whs_activity
  `;
    const params = [];
    guardParams(params);
    await query(toDialect(sql), params);
  }

  /**
   * Tìm kiếm + phân trang nhật ký hoạt động (GET /api/warehouse/activity).
   * Two-query pattern: rows + count như cũ (tuần tự, đúng thứ tự).
   * Từ khóa khớp (case-insensitive) trên: po_number, user_name, emp_no,
   * slot_code, detail, action_key. Không dùng keyword -> truyền
   * keywordPattern = NULL để bỏ lọc. actionKey (tùy chọn) lọc đúng loại
   * log — NULL bỏ lọc.
   *
   * Filter tùy chọn viết dạng "CAST(? AS NVARCHAR(100)) IS NULL OR ..."
   * vì PG không suy diễn kiểu cho "$n IS NULL" trần (SQL Server không
   * vướng nhưng viết chung 1 dạng để tương thích cả hai bên).
   * @param {{ keyword?: string, actionKey?: string|null, page: number, pageSize: number }} opts
   * @returns {Promise<{ rows: Record<string, unknown>[], total: number }>}
   */
  async searchActivitiesPage(opts) {
    const kw = String(opts.keyword || '').trim();
    const keywordPattern = kw ? `%${kw}%` : null;
    const actionKey = String(opts.actionKey || '').trim() || null;
    const offset = (opts.page - 1) * opts.pageSize;
    const sql = `
    -- DECLARE @keywordPattern NVARCHAR(100) = NULL;
    -- DECLARE @actionKey NVARCHAR(40) = NULL;
    -- DECLARE @offset INT = 0;
    -- DECLARE @pageSize INT = 20;
    SELECT
      a.id AS [id],
      a.acted_at AS [time],
      a.emp_no AS [userId],
      a.action_key AS [actionKey],
      a.allocation_id AS [allocationId],
      a.notice_detail_id AS [noticeDetailId],
      a.po_id AS [poId],
      a.po_number AS [poNumber],
      a.slot_code AS [slotCode],
      CAST(a.qty AS FLOAT) AS [qty],
      a.unit AS [unit],
      a.detail AS [detail],
      'mock' AS [source]
    FROM whs_activity a
    WHERE (
      CAST(? AS NVARCHAR(100)) IS NULL
      OR a.po_number LIKE ?
      OR a.user_name LIKE ?
      OR a.emp_no LIKE ?
      OR a.slot_code LIKE ?
      OR a.detail LIKE ?
      OR a.action_key LIKE ?
    )
    AND (
      CAST(? AS NVARCHAR(40)) IS NULL
      OR a.action_key = ?
    )
    ORDER BY a.acted_at DESC, a.id DESC
    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
  `;
    const params = [
      keywordPattern,
      keywordPattern,
      keywordPattern,
      keywordPattern,
      keywordPattern,
      keywordPattern,
      keywordPattern,
      actionKey,
      actionKey,
      offset,
      opts.pageSize,
    ];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    const countSql = `
    -- DECLARE @keywordPattern NVARCHAR(100) = NULL;
    -- DECLARE @actionKey NVARCHAR(40) = NULL;
    SELECT COUNT(*) AS [total]
    FROM whs_activity a
    WHERE (
      CAST(? AS NVARCHAR(100)) IS NULL
      OR a.po_number LIKE ?
      OR a.user_name LIKE ?
      OR a.emp_no LIKE ?
      OR a.slot_code LIKE ?
      OR a.detail LIKE ?
      OR a.action_key LIKE ?
    )
    AND (
      CAST(? AS NVARCHAR(40)) IS NULL
      OR a.action_key = ?
    )
  `;
    const countParams = [
      keywordPattern,
      keywordPattern,
      keywordPattern,
      keywordPattern,
      keywordPattern,
      keywordPattern,
      keywordPattern,
      actionKey,
      actionKey,
    ];
    guardParams(countParams);
    const counted = await db.query(toDialect(countSql), countParams);
    return {
      rows, // SQL đã alias đầy đủ camelCase
      total: Number(counted.rows[0] ? counted.rows[0].total : 0),
    };
  }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository().activity;
} else {
  module.exports = new ActivityModel();
  module.exports.ActivityModel = ActivityModel; // for reset.repository tx use
}
