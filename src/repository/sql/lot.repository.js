'use strict';

/**
 * Repository bảng whs_slot_allocation (phân phối hàng lên kệ).
 *
 * Kiến trúc (refactor 2026-10-26 lần 2 — theo yêu cầu user): mỗi public
 * method TỰ khai báo câu SQL ngay trong method (`const sql = \`...\``) và tự
 * gọi db.query(toDialect(sql), params) — SQL thực thi TRỰC TIẾP trong
 * method, KHÔNG còn tầng hàm dựng SQL dùng chung lẫn wrapper thực thi
 * trung gian. Tham số bind QUA PLACEHOLDER `?` — db.js tự đổi thành @p1.. (SQL Server) hoặc $1..
 * (PostgreSQL), tuyệt đối KHÔNG nối giá trị trực tiếp vào chuỗi SQL. Alias
 * [camelCase] giữ đúng shape service/FE cần — SQL tự alias đủ nên KHÔNG cần
 * row-mapper. guardParams() chỉ chặn sớm tham số undefined trước khi xuống
 * driver (giữ hành vi guard cũ).
 *
 * Test SSMS: copy câu SQL (kèm comment -- DECLARE) sang SSMS, uncomment
 * dòng DECLARE, thay ? bằng biến tương ứng là chạy được ngay.
 *
 * DUAL DIALECT (SQL Server production + PostgreSQL sandbox test):
 * SQL viết theo cú pháp SQL Server; toDialect() chỉ chuyển những chỗ PG
 * không chấp nhận nguyên văn (bracket alias / NVARCHAR / LIKE->ILIKE /
 * OUTPUT inserted -> RETURNING ở cuối câu / DATETIME / tiền tố bảng).
 *
 * Khối SELECT allocation (đầy đủ cột camelCase) được LẶP LẠI inline trong
 * từng method đọc: findLots / listPaged / findLotById (và trong mọi method
 * ghi để REFETCH sau khi insert/update) / findActiveBySlot /
 * JOIN order2 (PO line),
 * order1 (PO header theo o1.sheet_no = o2.sheet_no — PO identity fix
 * 2026-10-29, o1.id là PK header không phải line), bas_goods (tên vật tư),
 * bas_emp (người gán kệ), GRN (in2+in1 theo i2.pur_no = o1.sheet_no AND
 * i2.pur_id = o2.sheet_id AND i2.goods_no — pur_in2.pur_id là SHEET_ID dòng
 * PO chứ KHÔNG phải order2.id; candidate-first: chỉ dòng PO có allocation).
 * KHÔNG JOIN notice2 — lot chi tiết
 * đọc từ whs_allocation_receipt.
 *
 * Lưu ý kiểu dữ liệu trong SQL:
 *   - số  : CAST(col AS FLOAT) — null giữ nguyên (KHÔNG COALESCE 0)
 *   - bool: cột BIT passthrough (a.has_warning AS [hasWarning])
 *   - id INT -> string: CAST(a.po_id AS VARCHAR(20)) AS [poLine]
 *   - ngày: alias thẳng cột (driver trả Date, JSON hóa thành ISO)
 *
 * INSERT/UPDATE động theo object runtime (insertAllocation /
 * updateAllocation) dùng builder private buildRawInsert/buildRawUpdate —
 * tên cột lấy từ key của object (row key = TÊN CỘT DB, snake_case). Sau
 * khi ghi thành công REFETCH bằng câu SELECT theo id viết inline trong
 * chính method (truyền `query` fn xuyên qua để reset transaction vẫn chạy
 * trên cùng 1 connection) — kết quả trả về là shape camelCase ĐẦY ĐỦ
 * (superset của shape trước).
 *
 * Nghiệp vụ lưu mới (assign từ PO — theo yêu cầu user):
 *   - Ban đầu lot_no = NULL, warehouse_status = 'PO_ASSIGNED',
 *     status = 'WAITING_IQC'. lot_no chỉ là mirror hiển thị — chỉ set khi
 *     allocation có đúng 1 distinct lot receipt (xem receipt.repository.js
 *     + services/receipt-sync.service.js).
 *   - Unique active: (po_id, slot_code) WHERE closed_at IS NULL — move vào
 *     kệ đã có allocation cùng PO thì cộng dồn allocated_qty; move một
 *     phần -> split (service dùng insertAllocation +
 *     decreaseAllocationQty).
 *   - closed_at KHÔNG đồng nghĩa RETURNED — chỉ là đã rời kệ.
 *
 * DB_MODE=memory thì module.exports swap sang cắt lát của memory
 * repository (xem cuối file).
 */

const db = require('../../config/db');
const { TABLES } = require('./tables');

// ==================== PRIVATE: HỖ TRỢ DIALECT + THỰC THI ====================

/** Tên bảng logic (viết trong SQL) -> tên thật (kèm tiền tố nếu có, lấy
 *  từ TABLES) — quét từng cặp để thay khi chạy PostgreSQL. */
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

/** Dialect hiện tại có phải PostgreSQL (chỉ dùng cho sandbox test)? */
function isPg() {
  return db.getDialect() === 'pg';
}

/**
 * Chuyển câu SQL (viết cú pháp SQL Server) sang PostgreSQL khi chạy
 * sandbox — các thay đổi PG không hỗ trợ nguyên văn:
 *   1. Alias [camelCase] -> "camelCase" (PG không hiểu bracket alias; PG
 *      phân biệt hoa thường với identifier trong nháy kép nên phải giữ
 *      nguyên chữ — SQL đã tự alias đúng camelCase)
 *   2. NVARCHAR(n) -> VARCHAR(n) (PG không có kiểu NVARCHAR — UTF-8 sẵn)
 *   3. LIKE -> ILIKE (PG LIKE phân biệt hoa thường — ILIKE giữ hành vi
 *      tìm kiếm case-insensitive như collation mặc định của SQL Server)
 *   4. OUTPUT inserted.X -> RETURNING X: mssql đặt OUTPUT TRƯỚC WHERE,
 *      pg bắt RETURNING ở CUỐI câu (ngay trước dấu ;) nên phải cắt mệnh
 *      đề ra rồi dán xuống cuối — bắt buộc cho increase/decrease/move/
 *      close (chúng trả về inserted.id để biết dòng có khớp hay không).
 *   5. DATETIME -> TIMESTAMP.
 *   6. Tiền tố bảng sandbox (TABLE_PAIRS) — thay tên logic bằng tên thật.
 * SQL Server trả về nguyên văn từng ký tự.
 *
 * Không port rule hoán đổi LIMIT/OFFSET: PG sandbox đã chạy được
 * "OFFSET ? ROWS FETCH NEXT ? ROWS ONLY" với tham số bind.
 * @param {string} text câu SQL gốc (cú pháp SQL Server, placeholder ?)
 * @returns {string} câu SQL theo dialect hiện tại
 */
function toDialect(text) {
  if (!isPg()) return text;
  let out = text;
  out = out.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');
  out = out.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
  out = out.replace(/\bLIKE\b/g, 'ILIKE');
  // OUTPUT inserted.* -> RETURNING, bọc marker \u0002 để dời xuống cuối câu.
  out = out.replace(
    /\bOUTPUT\s+inserted\.(\*|[A-Za-z_][A-Za-z0-9_]*)/gi,
    (_m, col) => `\u0002RETURNING ${col}\u0002`
  );
  const returningClause = out.match(/\u0002(RETURNING (?:\*|[A-Za-z_][A-Za-z0-9_]*))\u0002/);
  if (returningClause) {
    out = out.replace(/\u0002RETURNING (?:\*|[A-Za-z_][A-Za-z0-9_]*)\u0002/, '');
    out = `${out.replace(/\s*;\s*$/, '').trimEnd()} ${returningClause[1]};`;
  }
  out = out.replace(/\bDATETIME\b/g, 'TIMESTAMP');
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
      '[lot.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

// ==================== PRIVATE: BUILDER INSERT/UPDATE ĐỘNG ====================

// Các field kiểu JSON của domain — ghi xuống DB dưới dạng chuỗi
// JSON.stringify (bảng allocation hiện KHÔNG có cột JSON nào, hằng giữ để
// đồng bộ hành vi encode với các repository khác).
const JSON_FIELDS = ['iqcHistory'];

/**
 * Chuẩn hóa 1 giá trị trước khi bind: field JSON -> JSON.stringify, còn lại
 * giữ nguyên (null/undefined -> null).
 * @param {string} key tên cột DB
 * @param {unknown} value giá trị tương ứng
 * @returns {unknown} giá trị đã chuẩn hóa
 */
function encodeValue(key, value) {
  if (JSON_FIELDS.includes(key)) {
    return value === null || value === undefined ? null : JSON.stringify(value);
  }
  return value === undefined ? null : value;
}

/**
 * Dựng câu INSERT trực tiếp từ row có key = TÊN CỘT DB (snake_case) —
 * cột thay đổi theo object runtime nên không thể viết tĩnh. Vị trí mệnh
 * đề lấy về dòng vừa ghi khác nhau theo dialect: SQL Server đặt OUTPUT
 * inserted.* TRƯỚC VALUES; PG bắt RETURNING ở CUỐI câu — sai vị trí là PG
 * từ chối cú pháp.
 * @param {string} table tên bảng thật (đã qua TABLES)
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

  return { text, values: keys.map((key) => encodeValue(key, row[key])) };
}

/**
 * Dựng câu UPDATE trực tiếp từ patch có key = TÊN CỘT DB (snake_case).
 * @param {string} table tên bảng thật (đã qua TABLES)
 * @param {Record<string, unknown>} patch object key = tên cột DB sẽ SET
 * @param {string} whereCol tên cột điều kiện
 * @param {unknown} whereValue giá trị của cột điều kiện
 * @returns {{ text: string, values: unknown[] } | null} null nếu patch rỗng
 */
function buildRawUpdate(table, patch, whereCol, whereValue) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return null;

  const sets = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => encodeValue(key, patch[key]));
  values.push(whereValue);

  const text = isPg()
    ? `UPDATE ${table} SET ${sets} WHERE ${whereCol} = ? RETURNING *`
    : `UPDATE ${table} SET ${sets} OUTPUT inserted.* WHERE ${whereCol} = ?`;

  return { text, values };
}

// ==================== CLASS REPOSITORY ====================

class LotModel {
  /**
   * Toàn bộ allocation (mọi trạng thái, kể cả đã closed). Không tham số —
   * SELECT inline đầy đủ cột camelCase (JOIN order1/order2/goods/emp/GRN).
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findLots() {
    const sql = `
    -- DECLARE khong can tham so.
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    ORDER BY a.allocated_at, a.id;
  `;
    const params = [];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Phân trang lô (GET /lots?page=&pageSize=) — 2 câu SQL inline chạy
   * song song (Promise.all): câu SELECT phân trang + câu COUNT toàn bảng.
   * Thứ tự giống listLots của service (assignedAt DESC, id DESC) — trang
   * nào cũng ra cùng thứ tự nên không lặp/thiếu dòng khi chuyển trang.
   * COUNT đếm trực tiếp bảng allocation (JOIN 1-1, không fan-out).
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
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    ORDER BY a.allocated_at DESC, a.id DESC
    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
  `;
    const params = [offset, pageSize];

    const sqlCount = `
    -- DECLARE khong can tham so.
    SELECT COUNT(*) AS [total] FROM whs_slot_allocation;
  `;
    const countParams = [];

    guardParams(params);
    guardParams(countParams);
    const [list, counted] = await Promise.all([
      db.query(toDialect(sql), params),
      db.query(toDialect(sqlCount), countParams),
    ]);
    return {
      rows: list.rows,
      total: Number(counted.rows[0] ? counted.rows[0].total : 0),
    };
  }

  /**
   * Tìm allocation theo id (PK VARCHAR(40) chứa genId 23 ký tự). SELECT
   * inline đầy đủ cột camelCase — dùng làm câu REFETCH chuẩn của mọi thao
   * tác ghi trong file này.
   * @param {string} id PK của allocation
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async findLotById(id) {
    const sql = `
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.id = ?;
  `;
    const params = [id];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * Allocation còn vật lý trên kệ (closed_at IS NULL) theo slot_code.
   * @param {string} slotCode mã kệ
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findActiveBySlot(slotCode) {
    const sql = `
    -- DECLARE @slotCode NVARCHAR(20) = 'A-01-1';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.slot_code = ? AND a.closed_at IS NULL;
  `;
    const params = [slotCode];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Allocation active theo po_id (match IQC / assign merge).
   * @param {string} poId po_id = pur_order2.id
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findActiveByPo(poId) {
    const sql = `
    -- DECLARE @poId INT = 3;
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.po_id = ? AND a.closed_at IS NULL;
  `;
    const params = [poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Allocation active theo (po_id, slot_code) — để merge allocated_qty khi
   * move/assign vào kệ đã có allocation cùng PO.
   * @param {string} poId po_id = pur_order2.id
   * @param {string} slotCode mã kệ
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async findActiveAllocationByPoAndSlot(poId, slotCode) {
    const sql = `
    -- DECLARE @poId INT = 3;
    -- DECLARE @slotCode NVARCHAR(20) = 'A-01-1';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.po_id = ? AND a.slot_code = ? AND a.closed_at IS NULL;
  `;
    const params = [poId, slotCode];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * INSERT allocation mới (ĐỘNG — buildRawInsert). `values` có key = tên
   * cột DB (snake_case): id, po_id, goods_no, lot_no (mirror hiển thị, ban
   * đầu NULL), warehouse_status, slot_code, allocated_qty, status,
   * iqc_decision, has_warning, qty_in_stock, qty_return, qty_aod,
   * last_iqc_at, allocated_by_emp_no, allocated_at, closed_at.
   * KHÔNG còn notice_detail_id / notice_confirmed (đã chuyển sang receipt).
   * Tham số `query` tùy chọn: reset truyền txQuery để chạy trong cùng
   * transaction. Sau insert thành công, REFETCH bằng câu SELECT theo id
   * (viết inline dưới đây, cùng `query` fn) để trả về shape camelCase đầy
   * đủ.
   * @param {Record<string, unknown>} values row key = tên cột DB
   * @param {Function} [query] bộ query (mặc định db.query)
   * @param {{ light?: boolean }} [opts] light=true bỏ refetch display
   *   (dùng trong tx để tránh JOIN T8 nặng — #27)
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async insertAllocation(values, query = db.query, opts) {
    const insert = buildRawInsert(TABLES.allocation, values);
    if (!insert) return null;
    guardParams(insert.values);
    const { rows } = await query(toDialect(insert.text), insert.values);
    if (!rows[0]) return null;
    // light = true (moveLot trong tx #27): bỏ refetch display JOIN T8 nặng,
    // chỉ trả row tối thiểu { id } — caller trong tx không cần shape display.
    if (opts && opts.light) return { id: rows[0].id };

    const sql = `
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.id = ?;
  `;
    const params = [rows[0].id];
    guardParams(params);
    const { rows: refetched } = await query(toDialect(sql), params);
    return refetched[0] || null;
  }

  /**
   * UPDATE allocation theo id (ĐỘNG — buildRawUpdate). `patch` có key =
   * tên cột DB (snake_case). Sau update thành công, REFETCH bằng câu SELECT
   * theo id (inline dưới đây) để trả về shape camelCase đầy đủ; null nếu
   * không tìm thấy.
   * @param {string} id PK của allocation
   * @param {Record<string, unknown>} patch các cột DB cần SET
   * @param {Function} [query] bộ query (mặc định db.query) — receipt-sync
   *   truyền txQuery để UPDATE chạy trong cùng transaction với receipt
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async updateAllocation(id, patch, query = db.query) {
    const update = buildRawUpdate(TABLES.allocation, patch, 'id', id);
    if (!update) return null;
    guardParams(update.values);
    const { rows } = await query(toDialect(update.text), update.values);
    if (!rows[0]) return null;

    const sql = `
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.id = ?;
  `;
    const params = [rows[0].id];
    guardParams(params);
    const { rows: refetched } = await query(toDialect(sql), params);
    return refetched[0] || null;
  }

  /**
   * UPDATE allocation theo id — bản LIGHT dành cho worker transaction
   * (#4/#27): chỉ 1 câu WHS-only, KHÔNG refetch display (không JOIN
   * bảng T8 pur_/bas_, không GROUP pur_in2, không trả UI DTO). Receipt tx
   * bắt buộc dùng method này — updateAllocation phía trên refetch nặng
   * JOIN T8 là vi phạm “tx ngắn, không đọc T8 trong tx”.
   * @param {string} id PK của allocation
   * @param {Record<string, unknown>} patch các cột DB cần SET (snake_case)
   * @param {Function} [query] bộ query (mặc định db.query) — truyền txQuery
   * @returns {Promise<boolean>} true nếu có dòng được UPDATE, false nếu không
   */
  async updateAllocationLight(id, patch, query = db.query) {
    const update = buildRawUpdate(TABLES.allocation, patch, 'id', id);
    if (!update) return false;
    guardParams(update.values);
    const { rows } = await query(toDialect(update.text), update.values);
    return Array.isArray(rows) && rows.length > 0;
  }

  /**
   * Áp kết quả IQC: patch gồm status, iqc_decision, has_warning,
   * qty_in_stock, qty_return, qty_aod, last_iqc_at và warehouse_status
   * ('IN' / 'RETURN' / 'AOD'; FAIL_PENDING vẫn 'TEMP_IN'). Ủy quyền cho
   * updateAllocation (1 UPDATE + 1 REFETCH).
   * @param {string} id PK của allocation
   * @param {Record<string, unknown>} patch các cột kết quả IQC
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async applyIqcResult(id, patch) {
    return this.updateAllocation(id, patch);
  }

  /**
   * Cộng dồn số lượng (merge allocation cùng (po_id, slot_code) active).
   * UPDATE inline dùng OUTPUT inserted.id (pg: RETURNING id) — không khớp
   * dòng nào thì trả null; sau khi ghi REFETCH bằng câu SELECT theo id
   * (shape camelCase đầy đủ).
   * Tham số `query` tùy chọn: moveLot truyền txQuery để chạy trong cùng
   * transaction — khi đó BỎ refetch display (JOIN T8 nặng #27) và trả về
   * row tối thiểu { id } (caller không cần shape đầy đủ trong tx).
   * @param {string} id PK của allocation
   * @param {number} delta lượng cộng thêm vào allocated_qty
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async increaseAllocationQty(id, delta, query = db.query) {
    const sql = `
    -- DECLARE @delta NUMERIC(18,8) = 10;
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    UPDATE whs_slot_allocation
    SET allocated_qty = allocated_qty + ?
    OUTPUT inserted.id
    WHERE id = ? AND closed_at IS NULL;
  `;
    const params = [delta, id];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    if (!rows[0]) return null;
    // Trong tx: bỏ refetch display JOIN T8 nặng (#27) — chỉ trả row tối thiểu.
    if (query !== db.query) return { id: rows[0].id };

    const sqlRefetch = `
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.id = ?;
  `;
    const refetchParams = [rows[0].id];
    guardParams(refetchParams);
    const { rows: refetched } = await db.query(
      toDialect(sqlRefetch),
      refetchParams
    );
    return refetched[0] || null;
  }

  /**
   * Giảm số lượng (move một phần sang kệ khác). Điều kiện inline:
   *   (1) allocated_qty - delta >= 0
   *   (2) BẢO VỆ RECEIPT (I4 — #23): allocated_qty mới PHẢI >= tổng
   *       received_qty đã reconcile vào allocation này — subquery tính
   *       TỒNG FRESH ngay trong cùng câu UPDATE (atomic check-and-set),
   *       không phụ thuộc tổng đã đọc bên ngoài (chống race Worker-vs-Move:
   *       worker ghi receipt giữa lúc move đọc tổng và giảm qty). Null nếu
   *       giảm vượt mức / vi phạm I4 / không tồn tại.
   * UPDATE dùng OUTPUT inserted.id (pg: RETURNING id), sau đó REFETCH bằng
   * câu SELECT theo id (bỏ qua khi chạy trong tx — caller không cần display).
   * @param {string} id PK của allocation
   * @param {number} delta lượng trừ khỏi allocated_qty
   * @param {Function} [query] bộ query (mặc định db.query) — moveLot truyền
   *   txQuery để chạy trong cùng transaction
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async decreaseAllocationQty(id, delta, query = db.query) {
    const sql = `
    -- DECLARE @delta NUMERIC(18,8) = 10;
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    UPDATE whs_slot_allocation
    SET allocated_qty = allocated_qty - ?
    OUTPUT inserted.id
    WHERE id = ?
      AND allocated_qty - ? >= 0
      AND allocated_qty - ? >= COALESCE((
            SELECT SUM(received_qty)
            FROM whs_allocation_receipt
            WHERE allocation_id = whs_slot_allocation.id
          ), 0);
  `;
    const params = [delta, id, delta, delta];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    if (!rows[0]) return null;
    // Trong tx: bỏ refetch display JOIN T8 nặng (#27) — chỉ trả row tối thiểu.
    if (query !== db.query) return { id: rows[0].id };
    // Ngoài tx (caller cũ): vẫn REFETCH để trả shape camelCase đầy đủ.

    const sqlRefetch = `
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.id = ?;
  `;
    const refetchParams = [rows[0].id];
    guardParams(refetchParams);
    const { rows: refetched } = await db.query(
      toDialect(sqlRefetch),
      refetchParams
    );
    return refetched[0] || null;
  }

  /**
   * Move allocation sang kệ khác (chỉ dòng còn active). UPDATE inline dùng
   * OUTPUT inserted.id (pg: RETURNING id) — không khớp thì null; sau đó
   * REFETCH bằng câu SELECT theo id.
   * @param {string} id PK của allocation
   * @param {string} targetSlotCode mã kệ đích
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async moveAllocationSlot(id, targetSlotCode, query = db.query) {
    const sql = `
    -- DECLARE @targetSlotCode NVARCHAR(20) = 'B-02-1';
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    UPDATE whs_slot_allocation
    SET slot_code = ?
    OUTPUT inserted.id
    WHERE id = ? AND closed_at IS NULL;
  `;
    const params = [targetSlotCode, id];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    if (!rows[0]) return null;
    // Trong tx (moveLot): bỏ refetch display JOIN T8 nặng (#27).
    if (query !== db.query) return { id: rows[0].id };

    const sqlRefetch = `
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.id = ?;
  `;
    const refetchParams = [rows[0].id];
    guardParams(refetchParams);
    const { rows: refetched } = await db.query(
      toDialect(sqlRefetch),
      refetchParams
    );
    return refetched[0] || null;
  }

  /**
   * Đóng allocation (hạ khỏi kệ — closed_at = thời điểm đó; lưu ý:
   * closed_at KHÔNG đồng nghĩa RETURNED, chỉ là đã rời kệ). UPDATE inline
   * dùng OUTPUT inserted.id (pg: RETURNING id); sau đó REFETCH bằng câu
   * SELECT theo id (bỏ qua khi chạy trong tx).
   * @param {string} id PK của allocation
   * @param {string | Date} closedAt thời điểm đóng (Date được chuẩn hóa ISO)
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async closeAllocation(id, closedAt, query = db.query) {
    const closedIso =
      closedAt instanceof Date ? closedAt.toISOString() : closedAt;

    const sql = `
    -- DECLARE @closedAt DATETIME = '2026-10-19T00:00:00';
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    UPDATE whs_slot_allocation
    SET closed_at = ?
    OUTPUT inserted.id
    WHERE id = ?;
  `;
    const params = [closedIso, id];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    if (!rows[0]) return null;
    // Trong tx (moveLot): bỏ refetch display JOIN T8 nặng (#27).
    if (query !== db.query) return { id: rows[0].id };

    const sqlRefetch = `
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [id],
      COALESCE(o1.sheet_no, o2.sheet_no) AS [poNumber],
      CAST(a.po_id AS VARCHAR(20)) AS [poLine],
      a.goods_no AS [itemCode],
      g.goods_name AS [material],
      a.lot_no AS [lotCode],
      o1.su_name11 AS [supplier],
      CAST(a.allocated_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      COALESCE(grn.received_at, o2.del_date) AS [receivedAt],
      a.slot_code AS [shelfCode],
      a.allocated_by_emp_no AS [assignedBy],
      a.allocated_at AS [assignedAt],
      a.status AS [status],
      a.iqc_decision AS [iqcDecision],
      a.has_warning AS [hasWarning],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      a.last_iqc_at AS [iqcUpdatedAt],
      'mock' AS [source],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.lot_no AS [lotNo],
      a.warehouse_status AS [warehouseStatus],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.closed_at AS [closedAt],
      o1.id AS [order1Id],
      CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
      o2.made_lot AS [madeLot],
      e.emp_name AS [allocatedByName],
      grn.grn_no AS [grnNo],
      CAST(grn.grn_qty AS FLOAT) AS [grnQty]
    FROM whs_slot_allocation a
    LEFT JOIN pur_order2 o2 ON o2.id = a.po_id
    LEFT JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.allocated_by_emp_no
    LEFT JOIN (
      SELECT i2.pur_no, i2.pur_id, i2.goods_no,
             SUM(i2.sheet_qty) AS grn_qty,
             MAX(i2.sheet_no) AS grn_no,
             MAX(i1.sheet_date) AS received_at
      FROM pur_in2 i2
      JOIN pur_order2 o2g
        ON o2g.sheet_no = i2.pur_no
       AND o2g.sheet_id = i2.pur_id
       AND o2g.goods_no = i2.goods_no
      LEFT JOIN pur_in1 i1 ON i1.sheet_no = i2.sheet_no
      -- Candidate-first: chỉ dòng PO đang có allocation, không GROUP toàn pur_in2
      WHERE EXISTS (
        SELECT 1 FROM whs_slot_allocation ag
        WHERE ag.po_id = o2g.id AND ag.goods_no = i2.goods_no
      )
      GROUP BY i2.pur_no, i2.pur_id, i2.goods_no
    ) grn ON grn.pur_no = o1.sheet_no AND grn.pur_id = o2.sheet_id
     AND grn.goods_no = a.goods_no
    WHERE a.id = ?;
  `;
    const refetchParams = [rows[0].id];
    guardParams(refetchParams);
    const { rows: refetched } = await db.query(
      toDialect(sqlRefetch),
      refetchParams
    );
    return refetched[0] || null;
  }

  /**
   * Xóa toàn bộ allocation (chỉ dùng trong reset seed). Không tham số.
   * @param {Function} [query] bộ query (mặc định db.query; reset truyền
   *   txQuery để chạy trong cùng transaction)
   * @returns {Promise<void>}
   */
  async deleteAll(query = db.query) {
    const sql = `
    -- DECLARE khong can tham so.
    DELETE FROM whs_slot_allocation;
  `;
    const params = [];
    guardParams(params);
    await query(toDialect(sql), params);
  }

  /**
 * UNDO ASSIGN (2026-11-07): đọc 1 dòng allocation WHS-only theo id —
 * KHÔNG JOIN T8. Dùng re-read trong transaction Undo (dòng đã bị
 * acquireAllocationLock giữ nên dữ liệu ổn định để quyết định
 * downstream/quantity mà không nạp display JOIN nặng.
 * @param {string} id PK allocation
 * @param {Function} [query] executor (mặc định db.query; Undo truyền
 *   txQuery để đọc dòng đã lock trong cùng transaction)
 * @returns {Promise<Record<string, unknown> | null>} row WHS camelCase
 */
  async findAllocationRow(id, query = db.query) {
    const sql = `
    -- DECLARE @id NVARCHAR(40) = 'al_abc123';
    SELECT
      a.id AS [id],
      a.po_id AS [poId],
      a.goods_no AS [goodsNo],
      a.slot_code AS [slotCode],
      a.lot_no AS [lotNo],
      CAST(a.allocated_qty AS FLOAT) AS [allocatedQty],
      a.allocated_by_emp_no AS [allocatedByEmpNo],
      a.allocated_at AS [allocatedAt],
      a.status AS [status],
      a.warehouse_status AS [warehouseStatus],
      a.iqc_decision AS [iqcDecision],
      a.last_iqc_at AS [lastIqcAt],
      CAST(a.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(a.qty_return AS FLOAT) AS [qtyReturn],
      CAST(a.qty_aod AS FLOAT) AS [qtyAod],
      a.has_warning AS [hasWarning],
      a.closed_at AS [closedAt]
    FROM whs_slot_allocation a
    WHERE a.id = ?;
  `;
    const params = [id];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return rows || null;
  }

  /**
   * UNDO ASSIGN (2026-11-07): hard-delete 1 allocation theo id. Trả về id
   * các dòng đã xóa (OUTPUT deleted / RETURNING id) làm bằng chứng kết quả
   * — executor không trả affected-count trong transaction. Với FK vật lý
   * whs_slot_movement → allocation, caller phải chặn movement trước khi gọi.
   * @param {string} id PK allocation
   * @param {Function} [query] executor (mặc định db.query; Undo truyền
   *   txQuery để xóa trong cùng transaction)
   * @returns {Promise<number>} số dòng đã xóa (0 = allocation không tồn tại)
   */
  async deleteAllocation(id, query = db.query) {
    const sql = isPg()
      ? `
      DELETE FROM whs_slot_allocation WHERE id = ? RETURNING id;
    `
      : `
      DELETE FROM whs_slot_allocation OUTPUT deleted.id WHERE id = ?;
    `;
    const params = [id];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return rows.length;
  }

  // Alias theo tên cũ để service layer (B2) gọi tiện
  list() {
    return this.findLots();
  }
  byId(id) {
    return this.findLotById(id);
  }
  byShelf(slotCode) {
    return this.findActiveBySlot(slotCode);
  }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository().lots;
} else {
  module.exports = new LotModel();
  module.exports.LotModel = LotModel; // for reset.repository tx use
}
