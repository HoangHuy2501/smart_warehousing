'use strict';

/**
 * Repository bảng whs_slots (từ điển kệ hàng GIF3) + whs_slot_movement
 * (lịch sử di chuyển giữa các kệ).
 *
 * Kiến trúc (refactor 2026-10-26 lần 2 theo yêu cầu user — SQL thực thi
 * trực tiếp trong method, không còn tầng hàm sqlXxx và wrapper cũ): SlotModel là
 * class singleton (module.exports = new); MỖI public method tự khai báo
 * câu SQL ngay trong method (`const sql = \`...\``) và tự gọi
 * db.query(toDialect(sql), params) — không còn hàm private sqlXxx() trả
 * { text, params } và không còn wrapper thực thi chung. Tham số bind QUA
 * PLACEHOLDER `?` — db.js tự đổi thành @p1.. (SQL Server) hoặc $1.. (PostgreSQL),
 * tuyệt đối KHÔNG nối giá trị trực tiếp vào chuỗi SQL. Alias [camelCase]
 * giữ đúng shape service/FE cần — SQL tự alias đủ nên KHÔNG cần row-mapper.
 * guardParams() chặn sớm tham số undefined trước khi xuống driver.
 *
 * Test SSMS: copy câu SQL (kèm comment -- DECLARE) sang SSMS, uncomment
 * dòng DECLARE, thay placeholder bằng biến tương ứng là chạy được ngay.
 *
 * DUAL DIALECT (SQL Server production + PostgreSQL sandbox test):
 * SQL viết theo cú pháp SQL Server; toDialect() chỉ chuyển những chỗ PG
 * không chấp nhận nguyên văn (xem JSDoc của toDialect). Phân trang dùng
 * cú pháp chuẩn OFFSET ... FETCH NEXT ... — cả hai bên đều hỗ trợ (đã
 * kiểm chứng trên sandbox PG).
 *
 * Nhóm truy vấn: (1) liệt kê/phân trang/đếm kệ — list/listPaged/count;
 * (2) tra cứu — byCode/byKeeper; (3) tìm mã kệ theo từ khóa —
 * searchCodes; (4) lịch sử di chuyển kệ — movementsList/movementById;
 * (5) reset seed — deleteAll/movementsDeleteAll.
 *
 * is_full CHỈ LÀ CỜ THỦ CÔNG của thủ kho — kệ không có giới hạn vật lý.
 * occupied_capacity = tổng allocated_qty còn active trên kệ.
 *
 * Ghi động (insert / insertRaw / update / insertMovement) dùng builder
 * private buildInsert / buildUpdate / buildRawInsert — cùng hành vi
 * query-builder.js cũ (OUTPUT inserted.* cho mssql / RETURNING * cho pg,
 * chọn theo dialect lúc runtime; JSON_FIELDS stringify). Sau khi ghi,
 * REFETCH bằng câu SQL byCode / movementById khai báo inline trong method
 * để trả shape camelCase đầy đủ (row OUTPUT có key snake_case).
 *
 * DB_MODE=memory thì module.exports swap sang cắt lát của memory
 * repository (xem cuối file).
 */

const db = require('../../config/db');
const { TABLES } = require('./tables');

/** Tên bảng logic (viết trong SQL) -> tên thật (kèm tiền tố nếu có). */
const TABLE_PAIRS = [
  ['bas_emp', TABLES.emps],
  ['bas_goods', TABLES.goods],
  ['pur_order1', TABLES.order1],
  ['pur_order2', TABLES.order2],
  ['pur_notice1', TABLES.notice1],
  ['pur_notice2', TABLES.notice2],
  ['v_pur_notice_detail', TABLES.noticeDetailView],
  ['pur_in1', TABLES.in1],
  ['pur_in2', TABLES.in2],
  ['whs_user_role', TABLES.userRole],
  ['whs_slots', TABLES.slots],
  ['whs_slot_allocation', TABLES.allocation],
  ['whs_allocation_receipt', TABLES.receipt],
  ['whs_slot_movement', TABLES.movement],
  ['whs_activity', TABLES.activity],
  ['whs_keeper_material_assignment', TABLES.keeperMaterialAssignment],
];

/** map camelCase (domain) -> tên cột DB của whs_slots — whitelist cột cho
 *  buildInsert / buildUpdate (không nhận tên cột tùy ý từ input). */
const SLOT_COLUMNS = {
  code: 'code',
  warehouse: 'warehouse',
  row: 'slot_row',
  floor: 'floor',
  position: 'position',
  keeperId: 'keeper_emp_no',
  locked: 'locked',
  full: 'is_full',
  active: 'active',
};

// Các field kiểu JSON — ghi xuống DB dưới dạng chuỗi JSON.stringify
// (nếu có trong columnMap), đọc lên service tự parse lại.
const JSON_FIELDS = ['iqcHistory'];

// ==================== PRIVATE: HỖ TRỢ DIALECT ====================

/** Dialect hiện tại có phải PostgreSQL (chỉ dùng cho sandbox test)? */
function isPg() {
  return db.getDialect() === 'pg';
}

/**
 * Chuyển câu SQL (viết cú pháp SQL Server) sang PostgreSQL khi chạy
 * sandbox — các thay đổi PG không hỗ trợ nguyên văn:
 *   1. Alias [camelCase] -> "camelCase" (PG không hiểu bracket alias)
 *   2. NVARCHAR(n) -> VARCHAR(n) (PG không có kiểu NVARCHAR — UTF-8 sẵn)
 *   3. LIKE -> ILIKE (PG LIKE phân biệt hoa thường — ILIKE giữ hành vi
 *      tìm kiếm case-insensitive như collation mặc định của SQL Server)
 *   4. CAST(CASE ... THEN 1 ELSE 0 END AS BIT) -> CASE ... TRUE/FALSE
 *      (PG có kiểu boolean thật, không có BIT 0/1)
 *   5. CAST(1 AS BIT) / CAST(0 AS BIT) -> TRUE / FALSE (hằng boolean)
 *   6. GETDATE() / SYSUTCDATETIME() -> NOW() (đồng hồ DB pg)
 *   7. Tiền tố bảng (DB_TABLE_PREFIX) — thay tên logic bằng tên thật
 * SQL Server trả về nguyên văn từng ký tự.
 * @param {string} text câu SQL gốc (cú pháp SQL Server, placeholder ?)
 * @returns {string} câu SQL theo dialect hiện tại
 */
function toDialect(text) {
  if (!isPg()) return text;
  let out = text;
  out = out.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');
  out = out.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
  out = out.replace(/\bLIKE\b/g, 'ILIKE');
  out = out.replace(
    /\bCAST\s*\(\s*CASE\b([\s\S]*?)\bEND\s+AS\s+BIT\s*\)/gi,
    (_m, body) =>
      `CASE${String(body)
        .replace(/\bTHEN\s+1\b/gi, 'THEN TRUE')
        .replace(/\bELSE\s+0\b/gi, 'ELSE FALSE')}END`
  );
  out = out.replace(/\bCAST\s*\(\s*([01])\s+AS\s+BIT\s*\)/gi, (_m, bit) =>
    bit === '1' ? 'TRUE' : 'FALSE'
  );
  out = out.replace(/\bGETDATE\s*\(\s*\)/gi, 'NOW()');
  out = out.replace(/\bSYSUTCDATETIME\s*\(\s*\)/gi, 'NOW()');
  for (const [logical, actual] of TABLE_PAIRS) {
    if (logical === actual) continue;
    out = out.replace(new RegExp(`\\b${logical}\\b`, 'g'), actual);
  }
  return out;
}

/**
 * Chặn sớm tham số undefined trước khi xuống driver — giữ hành vi guard
 * cũ (trước đây nằm trong exec/sql-params, đã loại bỏ theo yêu cầu user).
 * @param {unknown[]} params tham số theo thứ tự placeholder
 */
function guardParams(params) {
  if (params.includes(undefined)) {
    throw new Error(
      '[slot.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

// ==================== PRIVATE: BUILDER INSERT/UPDATE ĐỘNG ====================

/**
 * Dựng câu INSERT từ domain object camelCase qua columnMap (cột thay đổi
 * theo object runtime nên không thể viết tĩnh). Chỉ nhận cột có trong
 * columnMap (whitelist). Vị trí mệnh đề lấy về dòng vừa ghi khác nhau theo
 * dialect: SQL Server đặt OUTPUT inserted.* TRƯỚC VALUES; PG bắt RETURNING
 * ở CUỐI câu — sai vị trí là PG từ chối cú pháp.
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
 * Dựng câu UPDATE từ patch camelCase (chỉ những field có trong patch +
 * columnMap — không đè field không truyền).
 * @param {string} table tên bảng thật
 * @param {Record<string, unknown>} patch domain object camelCase sẽ SET
 * @param {string} whereKey khóa chính dạng camelCase ('code')
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

class SlotModel {
  /**
   * Danh sách toàn bộ kệ (sắp theo code) — kèm occupiedCapacity
   * (CAST tổng allocated_qty còn active AS FLOAT).
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async list() {
    const sql = `
    -- DECLARE khong can tham so.
    SELECT
      s.code AS [code],
      s.warehouse AS [warehouse],
      s.slot_row AS [row],
      s.floor AS [floor],
      s.position AS [position],
      s.keeper_emp_no AS [keeperId],
      s.locked AS [locked],
      s.is_full AS [full],
      s.active AS [active],
      CAST(
        COALESCE(SUM(CASE WHEN a.closed_at IS NULL THEN a.allocated_qty ELSE 0 END), 0)
        AS FLOAT
      ) AS [occupiedCapacity]
    FROM whs_slots s
    LEFT JOIN whs_slot_allocation a ON a.slot_code = s.code
    GROUP BY s.code, s.warehouse, s.slot_row, s.floor, s.position,
             s.keeper_emp_no, s.locked, s.is_full, s.active
    ORDER BY s.code
  `;
    const params = [];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows; // SQL đã alias đầy đủ camelCase
  }

  /**
   * Phân trang kệ (GET /slots?page=&pageSize=). total = COUNT qua
   * subselect (GROUP BY rồi 1 dòng/kệ) — 2 câu chạy song song Promise.all.
   * ORDER BY s.code cần thiết cho OFFSET/FETCH.
   * @param {number} page trang 1-indexed
   * @param {number} pageSize số dòng mỗi trang
   * @returns {Promise<{ rows: Record<string, unknown>[], total: number }>}
   */
  async listPaged(page, pageSize) {
    const offset = (page - 1) * pageSize;
    const sql = `
    -- DECLARE @offset INT = 0;
    -- DECLARE @pageSize INT = 20;
    SELECT
      s.code AS [code],
      s.warehouse AS [warehouse],
      s.slot_row AS [row],
      s.floor AS [floor],
      s.position AS [position],
      s.keeper_emp_no AS [keeperId],
      s.locked AS [locked],
      s.is_full AS [full],
      s.active AS [active],
      CAST(
        COALESCE(SUM(CASE WHEN a.closed_at IS NULL THEN a.allocated_qty ELSE 0 END), 0)
        AS FLOAT
      ) AS [occupiedCapacity]
    FROM whs_slots s
    LEFT JOIN whs_slot_allocation a ON a.slot_code = s.code
    GROUP BY s.code, s.warehouse, s.slot_row, s.floor, s.position,
             s.keeper_emp_no, s.locked, s.is_full, s.active
    ORDER BY s.code
    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
  `;
    const sqlCount = `
    -- DECLARE khong can tham so.
    SELECT COUNT(*) AS [total]
    FROM (
      SELECT
        s.code, s.warehouse, s.slot_row, s.floor, s.position,
        s.keeper_emp_no, s.locked, s.is_full, s.active,
        COALESCE(SUM(CASE WHEN a.closed_at IS NULL THEN a.allocated_qty ELSE 0 END), 0)
          AS occupied_capacity
      FROM whs_slots s
      LEFT JOIN whs_slot_allocation a ON a.slot_code = s.code
      GROUP BY s.code, s.warehouse, s.slot_row, s.floor, s.position,
               s.keeper_emp_no, s.locked, s.is_full, s.active
    ) sub
  `;
    const listParams = [offset, pageSize];
    const countParams = [];
    guardParams(listParams);
    guardParams(countParams);
    const [list, counted] = await Promise.all([
      db.query(toDialect(sql), listParams),
      db.query(toDialect(sqlCount), countParams),
    ]);
    return {
      rows: list.rows,
      total: Number(counted.rows[0] ? counted.rows[0].total : 0),
    };
  }

  /**
   * Tìm kệ theo code — không có thì không trả dòng (null).
   * @param {string} code mã kệ
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async byCode(code) {
    const sql = `
    -- DECLARE @code NVARCHAR(20) = 'A-01-1';
    SELECT * FROM (
      SELECT
        s.code AS [code],
        s.warehouse AS [warehouse],
        s.slot_row AS [row],
        s.floor AS [floor],
        s.position AS [position],
        s.keeper_emp_no AS [keeperId],
        s.locked AS [locked],
        s.is_full AS [full],
        s.active AS [active],
        CAST(
          COALESCE(SUM(CASE WHEN a.closed_at IS NULL THEN a.allocated_qty ELSE 0 END), 0)
          AS FLOAT
        ) AS [occupiedCapacity]
      FROM whs_slots s
      LEFT JOIN whs_slot_allocation a ON a.slot_code = s.code
      GROUP BY s.code, s.warehouse, s.slot_row, s.floor, s.position,
               s.keeper_emp_no, s.locked, s.is_full, s.active
    ) sub
    WHERE sub.code = ?
  `;
    const params = [code];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null; // SQL đã alias đầy đủ camelCase
  }

  /**
   * Danh sách kệ đang thuộc 1 thủ kho (keeper detail / profile).
   * @param {string} empNo mã nhân sự thủ kho
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async byKeeper(empNo) {
    const sql = `
    -- DECLARE @empNo VARCHAR(20) = 'TEST-KPR';
    SELECT * FROM (
      SELECT
        s.code AS [code],
        s.warehouse AS [warehouse],
        s.slot_row AS [row],
        s.floor AS [floor],
        s.position AS [position],
        s.keeper_emp_no AS [keeperId],
        s.locked AS [locked],
        s.is_full AS [full],
        s.active AS [active],
        CAST(
          COALESCE(SUM(CASE WHEN a.closed_at IS NULL THEN a.allocated_qty ELSE 0 END), 0)
          AS FLOAT
        ) AS [occupiedCapacity]
      FROM whs_slots s
      LEFT JOIN whs_slot_allocation a ON a.slot_code = s.code
      GROUP BY s.code, s.warehouse, s.slot_row, s.floor, s.position,
               s.keeper_emp_no, s.locked, s.is_full, s.active
    ) sub
    WHERE sub.[keeperId] = ?
    ORDER BY sub.code
  `;
    const params = [empNo];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Thêm kệ mới từ domain object camelCase (ĐỘNG): code, warehouse, row,
   * floor, position, keeperId, locked, full, active. Trả về row đầy đủ
   * (refetch byCode) sau insert.
   * @param {Record<string, unknown>} slot domain object camelCase
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async insert(slot) {
    const insert = buildInsert(TABLES.slots, slot, SLOT_COLUMNS);
    if (!insert) return null;
    const { rows } = await db.query(insert.text, insert.values);
    if (!rows[0]) return null;
    return this.byCode(rows[0].code);
  }

  /**
   * Thêm kệ từ row có key = tên cột DB (snake_case) — dùng cho seed.
   * Tham số `query` tùy chọn: reset truyền txQuery để chạy trong cùng
   * transaction (refetch cũng chạy trên tx đó).
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async insertRaw(row, query = db.query) {
    const insert = buildRawInsert(TABLES.slots, row);
    const { rows } = await query(insert.text, insert.values);
    if (!rows[0]) return null;
    const sql = `
    -- DECLARE @code NVARCHAR(20) = 'A-01-1';
    SELECT * FROM (
      SELECT
        s.code AS [code],
        s.warehouse AS [warehouse],
        s.slot_row AS [row],
        s.floor AS [floor],
        s.position AS [position],
        s.keeper_emp_no AS [keeperId],
        s.locked AS [locked],
        s.is_full AS [full],
        s.active AS [active],
        CAST(
          COALESCE(SUM(CASE WHEN a.closed_at IS NULL THEN a.allocated_qty ELSE 0 END), 0)
          AS FLOAT
        ) AS [occupiedCapacity]
      FROM whs_slots s
      LEFT JOIN whs_slot_allocation a ON a.slot_code = s.code
      GROUP BY s.code, s.warehouse, s.slot_row, s.floor, s.position,
               s.keeper_emp_no, s.locked, s.is_full, s.active
    ) sub
    WHERE sub.code = ?
  `;
    const params = [rows[0].code];
    guardParams(params);
    const { rows: refetched } = await query(toDialect(sql), params);
    return refetched[0] || null;
  }

  /**
   * UPDATE kệ theo code — chỉ cập nhật các field có trong patch (ĐỘNG).
   * Refetch bằng code SAU khi update (rows[0].code đúng cả khi patch đổi
   * khóa). Trả về row đầy đủ shape camelCase.
   * @param {string} code mã kệ (khóa tìm)
   * @param {Record<string, unknown>} patch các field camelCase cần cập nhật
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async update(code, patch) {
    const update = buildUpdate(TABLES.slots, patch, 'code', code, SLOT_COLUMNS);
    if (!update) return null;
    const { rows } = await db.query(update.text, update.values);
    if (!rows[0]) return null;
    return this.byCode(rows[0].code);
  }

  /**
   * Xóa toàn bộ kệ (chỉ dùng trong reset seed).
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<void>}
   */
  async deleteAll(query = db.query) {
    const sql = `
    DELETE FROM whs_slots
  `;
    const params = [];
    guardParams(params);
    await query(toDialect(sql), params);
  }

  /**
   * Ghi 1 dòng di chuyển (whs_slot_movement, ĐỘNG). `values` có key = tên
   * cột DB (snake_case): id, source_allocation_id, target_allocation_id,
   * from_slot_code, to_slot_code, qty, moved_by_emp_no, moved_at, note.
   * moved_at mặc định = now. Refetch theo id để trả shape camelCase đầy đủ
   * (bỏ qua khi chạy trong tx — moveLot truyền txQuery, movement là WHS-only
   * nên refetch nhẹ nhưng caller trong tx không cần shape display).
   * @param {Record<string, unknown>} values row key = tên cột DB
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async insertMovement(values, query = db.query) {
    const row = { ...values };
    if (!row.moved_at) row.moved_at = new Date().toISOString();
    const insert = buildRawInsert(TABLES.movement, row);
    const { rows } = await query(insert.text, insert.values);
    if (!rows[0]) return null;
    if (query !== db.query) return { id: rows[0].id };
    const sql = `
    -- DECLARE @id VARCHAR(40) = 'mov-0001';
    SELECT
      m.id AS [id],
      m.source_allocation_id AS [sourceAllocationId],
      m.target_allocation_id AS [targetAllocationId],
      m.from_slot_code AS [fromSlotCode],
      m.to_slot_code AS [toSlotCode],
      CAST(m.qty AS FLOAT) AS [qty],
      m.moved_by_emp_no AS [movedByEmpNo],
      m.moved_at AS [movedAt],
      m.note AS [note]
    FROM whs_slot_movement m
    WHERE m.id = ?
  `;
    const params = [rows[0].id];
    guardParams(params);
    const { rows: refetched } = await db.query(toDialect(sql), params);
    return refetched[0] || null;
  }

  /**
   * Danh sách movement gần nhất (cho lịch sử di chuyển; limit xử lý ở JS,
   * sắp theo moved_at DESC).
   * @param {number} [limit=50] số dòng giữ lại (<= 0 trả tất cả)
   * @returns {Promise<Record<string, unknown>[]>}
   */
  /**
   * UNDO ASSIGN (2026-11-07): đếm số dòng whs_slot_movement tham chiếu 1
   * allocation (là nguồn HOẶC đích di chuyển). Movement là downstream
   * không thể đảo ngược + FK vật lý chặn DELETE allocation — Undo phải
   * chặn khi count > 0. Không có movement tham chiếu → xóa an toàn.
   * @param {string} allocationId PK allocation
   * @param {Function} [query] executor (mặc định db.query; Undo truyền
   *   txQuery để đếm trong cùng transaction)
   * @returns {Promise<number>} số dòng movement tham chiếu allocation
   */
  async countMovementsForAllocation(allocationId, query = db.query) {
    const sql = `
    -- DECLARE @allocationId NVARCHAR(40) = 'al_abc123';
    SELECT COUNT(*) AS [count]
    FROM whs_slot_movement
    WHERE source_allocation_id = ? OR target_allocation_id = ?;
  `;
    const params = [allocationId, allocationId];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    // COUNT(*) của PG trả bigint (string) — ép Number cho cả 2 dialect.
    return Number((rows[0] && rows[0].count) || 0);
  }
  async findMovements(limit = 50) {
    const sql = `
    -- DECLARE khong can tham so.
    SELECT
      m.id AS [id],
      m.source_allocation_id AS [sourceAllocationId],
      m.target_allocation_id AS [targetAllocationId],
      m.from_slot_code AS [fromSlotCode],
      m.to_slot_code AS [toSlotCode],
      CAST(m.qty AS FLOAT) AS [qty],
      m.moved_by_emp_no AS [movedByEmpNo],
      m.moved_at AS [movedAt],
      m.note AS [note]
    FROM whs_slot_movement m
    ORDER BY m.moved_at DESC
  `;
    const params = [];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  /**
   * Xóa toàn bộ movement (chỉ dùng trong reset seed).
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<void>}
   */
  async deleteAllMovements(query = db.query) {
    const sql = `
    DELETE FROM whs_slot_movement
  `;
    const params = [];
    guardParams(params);
    await query(toDialect(sql), params);
  }

  /**
   * Tìm mã kệ theo từ khóa (GET /api/warehouse/slots?keyword=). Từ khóa
   * rỗng -> mảng rỗng (không chạy query). Khớp trên: slot_code, lot_no của
   * allocation hoặc PO liên quan (số đơn, mã NPL, tên hàng). Kết quả
   * DISTINCT, sắp xếp tăng dần.
   * @param {string} keyword từ khóa tìm
   * @returns {Promise<string[]>} danh sách mã kệ
   */
  async searchSlotCodes(keyword) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const pattern = `%${kw}%`;
    const sql = `
    -- DECLARE @keywordPattern NVARCHAR(100) = N'%tu_khoa%';
    SELECT DISTINCT a.slot_code AS [slotCode]
    FROM whs_slot_allocation a
    WHERE a.slot_code LIKE ?
      OR a.lot_no LIKE ?
      OR EXISTS (
        SELECT 1 FROM pur_order2 o2
        JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
        WHERE o2.id = a.po_id
          AND (o1.sheet_no LIKE ? OR o2.goods_no LIKE ?)
      )
      OR EXISTS (
        SELECT 1 FROM pur_order2 o2
        JOIN bas_goods g ON g.goods_no = o2.goods_no
        WHERE o2.id = a.po_id AND g.goods_name LIKE ?)
    ORDER BY a.slot_code
  `;
    const params = [pattern, pattern, pattern, pattern, pattern];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows.map((row) => row.slotCode);
  }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository().slots;
} else {
  module.exports = new SlotModel();
  module.exports.SlotModel = SlotModel; // for reset.repository tx use
}
