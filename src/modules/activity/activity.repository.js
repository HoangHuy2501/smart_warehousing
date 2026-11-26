'use strict';

const { ACCOUNT_AUDIT_ACTIONS } = require('../../config/account-audit');

/** SQL cho nhật ký hoạt động và kiểm toán. */

const db = require('../../config/db');
const { TABLES } = require('../../config/tables');
const pagination = require('../../util/pagination');

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

class ActivityModel {
  // Ghi nhật ký thay đổi kệ, lô và tài khoản.
  async insert(activity, query = db.query) {
    const sql = `
      INSERT INTO ${TABLES.activity} (
        id, acted_at, emp_no, user_name, action_key, allocation_id,
        notice_detail_id, po_id, po_number, slot_code, qty, unit, detail
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    await query(toDialect(sql), [
      activity.id, activity.actedAt, activity.userId, activity.userName,
      activity.actionKey, activity.allocationId, activity.noticeDetailId,
      activity.poId, activity.poNumber, activity.slotCode, activity.qty,
      activity.unit, activity.detail,
    ].map((value) => value ?? null));
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
    const actionKeys = opts.actionKeys ?? ACCOUNT_AUDIT_ACTIONS;
    const actionFilter = `AND a.action_key ${opts.actionKeys ? 'IN' : 'NOT IN'}
      (${actionKeys.map(() => '?').join(', ')})`;
    const sql = `
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
    ${actionFilter}
    `;
    const result = await pagination({
      query: toDialect(sql),
      params: [keywordPattern, keywordPattern, keywordPattern, keywordPattern, keywordPattern, keywordPattern, keywordPattern, actionKey, actionKey, ...actionKeys],
      orderBy: toDialect('[time] DESC, [id] DESC'),
      page: opts.page,
      pageSize: opts.pageSize,
    });
    return { rows: result.data, total: result.pagination.totalItems };
  }
}

module.exports = new ActivityModel();
module.exports.ActivityModel = ActivityModel;
