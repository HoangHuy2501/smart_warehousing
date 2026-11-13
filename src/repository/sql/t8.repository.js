'use strict';

/**
 * Repository bảng T8 mock (*) — TẦNG ĐỌC + nguyên thủy cho T8-simulator.
 *
 * Kiến trúc (refactor 2026-10-26 lần 2 theo yêu cầu user — SQL thực thi
 * trực tiếp trong method, không còn tầng hàm sqlXxx/exec): T8Model là
 * class singleton (module.exports = new, kèm giữ class cho
 * reset.repository dùng tx); MỖI public method tự khai báo câu SQL ngay
 * trong thân method (const sql = `...`) và tự gọi
 * db.query(toDialect(sql), params) — không còn hàm dựng SQL riêng, cũng
 * không còn wrapper thực thi dùng chung. Tham số bind QUA PLACEHOLDER `?`
 * — db.js tự đổi
 * thành @p1.. (SQL Server) hoặc $1.. (PostgreSQL), tuyệt đối KHÔNG nối
 * giá trị trực tiếp vào chuỗi SQL. Alias [camelCase] giữ đúng shape
 * service/FE cần — SQL tự alias đủ nên KHÔNG cần row-mapper.
 *
 * Chỉ còn tầng DÙNG CHUNG thật sự: isPg()/toDialect() (chuyển cú pháp
 * SQL Server sang PostgreSQL sandbox), guardParams() (chặn sớm tham số
 * undefined trước khi xuống driver) và các builder INSERT/UPDATE động
 * (buildRawInsert/t8UpdateSql) — đây là SQL động thật, không phải tầng
 * bọc câu SQL cố định.
 *
 * Test SSMS: copy câu SQL (kèm comment -- DECLARE) sang SSMS, uncomment
 * dòng DECLARE, thay ? bằng biến tương ứng là chạy được ngay.
 *
 * DUAL DIALECT (SQL Server production + PostgreSQL sandbox test):
 * SQL viết theo cú pháp SQL Server; toDialect() chỉ chuyển những chỗ PG
 * không chấp nhận nguyên văn (bracket alias / NVARCHAR / LIKE->ILIKE /
 * họ hàm ngày CONVERT-DATEADD-DATETIME / tiền tố bảng).
 *
 * T8 là bảng mock của ERP Germton — business layer CHỈ ĐỌC. T8-simulator
 * (service layer) là layer DUY NHẤT được phép ghi *, và hiện tại toàn
 * bộ lệnh GHI vẫn ĐANG TẮT (2026-10-16, yêu cầu user): mọi method ghi trả
 * về null, phần SQL ghi giữ trong comment ngay tại method để mở lại dễ
 * dàng. KHÔNG re-enable khi chưa hỏi user.
 *
 * DB_MODE=memory thì module.exports swap sang cắt lát t8 của memory
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
 *   4. Hàm ngày SQL Server không có trong PG — bắt buộc cho
 *      findNoticesByPoId (khớp notice theo [del_day, del_day + 1)):
 *        DATEADD(DAY, n, CONVERT(DATE, col)) -> (CAST(col AS DATE) + n * INTERVAL '1 day')
 *        DATEADD(DAY, n, col)                -> (col + n * INTERVAL '1 day')
 *        CONVERT(DATE, col)                  -> CAST(col AS DATE)
 *        DATETIME                            -> TIMESTAMP
 *   5. Tiền tố bảng sandbox (TABLE_PAIRS) — thay tên logic bằng tên thật.
 * SQL Server trả về nguyên văn từng ký tự.
 *
 * Không port rule hoán đổi LIMIT/OFFSET: PG sandbox đã chạy được
 * "OFFSET ? ROWS FETCH NEXT ? ROWS ONLY" với tham số bind, và repo này
 * không có câu phân trang nào.
 * @param {string} text câu SQL gốc (cú pháp SQL Server, placeholder ?)
 * @returns {string} câu SQL theo dialect hiện tại
 */
function toDialect(text) {
  if (!isPg()) return text;
  let out = text;
  out = out.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');
  out = out.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
  out = out.replace(/\bLIKE\b/g, 'ILIKE');
  // DATEADD bọc CONVERT bên trong phải thay TRƯỚC rule DATEADD chung.
  out = out.replace(
    /DATEADD\s*\(\s*DAY\s*,\s*(\d+)\s*,\s*CONVERT\s*\(\s*DATE\s*,\s*([A-Za-z_][\w.]*)\s*\)\s*\)/gi,
    (_m, n, col) => `(CAST(${col} AS DATE) + ${n} * INTERVAL '1 day')`
  );
  out = out.replace(
    /DATEADD\s*\(\s*DAY\s*,\s*(\d+)\s*,\s*([A-Za-z_][\w.]*)\s*\)/gi,
    (_m, n, col) => `(${col} + ${n} * INTERVAL '1 day')`
  );
  out = out.replace(
    /CONVERT\s*\(\s*DATE\s*,\s*([A-Za-z_][\w.]*)\s*\)/gi,
    (_m, col) => `CAST(${col} AS DATE)`
  );
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
      '[t8.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

// ==================== PRIVATE: BUILDER GHI (đang TẮT) ====================

/**
 * Câu UPDATE ... OUTPUT inserted.* (mssql) / ... RETURNING * (pg).
 * Vị trí mệnh đề lấy về dòng vừa ghi khác nhau giữa 2 dialect: mssql đặt
 * OUTPUT inserted NGAY SAU SET (trước WHERE), còn pg bắt RETURNING ở CUỐI
 * câu (sau WHERE). Chỉ dùng lại trong các khối GHI đang TẮT bên dưới.
 * @param {string} table tên bảng thật (đã qua TABLES)
 * @param {string} setClause phần "col = ?" đã ghép sẵn
 * @param {string} whereClause điều kiện WHERE đã ghép sẵn
 * @returns {string} câu UPDATE theo dialect hiện tại
 */
function t8UpdateSql(table, setClause, whereClause) {
  return isPg()
    ? `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`
    : `UPDATE ${table} SET ${setClause} OUTPUT inserted.* WHERE ${whereClause}`;
}

/**
 * Dựng câu INSERT trực tiếp từ row có key = TÊN CỘT DB (snake_case) —
 * port từ query-builder.buildRawInsert. Vị trí mệnh đề lấy về dòng vừa
 * ghi khác nhau theo dialect (mssql OUTPUT trước VALUES / pg RETURNING ở
 * cuối câu). Chỉ dùng lại trong các khối GHI đang TẮT bên dưới.
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
 * Thực thi INSERT từ row có key = tên cột DB; trả về row đầy đủ.
 * Chỉ dùng lại trong các khối GHI đang TẮT bên dưới.
 * @param {Function} query bộ query cần dùng
 * @param {string} table tên bảng thật
 * @param {Record<string, unknown>} row row key = tên cột DB
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function rawInsertRow(query, table, row) {
  const insert = buildRawInsert(table, row);
  if (!insert) return null;
  const { rows } = await query(insert.text, insert.values);
  return rows[0] || null;
}

// ==================== CLASS REPOSITORY ====================

class T8Model {
  // ================================================================
  // SEED / RESET (gọi trong transaction của resetAll)
  // ================================================================

  /** Xóa toàn bộ nhân viên (bas_emp). Hiện tắt ghi — no-op. */
  async deleteAllEmps() {
    // TẮT GHI * (2026-10-16): không xóa bảng thật.
    // await query(`DELETE FROM ${TABLES.emps}`);
  }

  /** Xóa toàn bộ hàng hóa (bas_goods). Hiện tắt ghi — no-op. */
  async deleteAllGoods() {
    // TẮT GHI * (2026-10-16): không xóa bảng thật.
    // await query(`DELETE FROM ${TABLES.goods}`);
  }

  /** Xóa toàn bộ PO header (pur_order1). Hiện tắt ghi — no-op. */
  async deleteAllOrder1() {
    // TẮT GHI * (2026-10-16): không xóa bảng thật.
    // await query(`DELETE FROM ${TABLES.order1}`);
  }

  /** Xóa toàn bộ PO line (pur_order2). Hiện tắt ghi — no-op. */
  async deleteAllOrder2() {
    // TẮT GHI * (2026-10-16): không xóa bảng thật.
    // await query(`DELETE FROM ${TABLES.order2}`);
  }

  /** Xóa toàn bộ notice header (pur_notice1). Hiện tắt ghi — no-op. */
  async deleteAllNotice1() {
    // TẮT GHI * (2026-10-16): không xóa bảng thật.
    // await query(`DELETE FROM ${TABLES.notice1}`);
  }

  /** Xóa toàn bộ notice detail (pur_notice2). Hiện tắt ghi — no-op. */
  async deleteAllNotice2() {
    // TẮT GHI * (2026-10-16): không xóa bảng thật.
    // await query(`DELETE FROM ${TABLES.notice2}`);
  }

  /** Xóa toàn bộ GRN header (pur_in1). Hiện tắt ghi — no-op. */
  async deleteAllIn1() {
    // TẮT GHI * (2026-10-16): không xóa bảng thật.
    // await query(`DELETE FROM ${TABLES.in1}`);
  }

  /** Xóa toàn bộ GRN line (pur_in2). Hiện tắt ghi — no-op. */
  async deleteAllIn2() {
    // TẮT GHI * (2026-10-16): không xóa bảng thật.
    // await query(`DELETE FROM ${TABLES.in2}`);
  }

  /**
   * Thêm nhân viên (row key = tên cột DB snake_case).
   * Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @returns {Promise<null>}
   */
  async insertEmp(row) {
    // TẮT GHI * (2026-10-16): không chèn vào bảng thật.
    // return rawInsertRow(db.query, TABLES.emps, row);
    return null;
  }

  /**
   * Thêm hàng hóa (row key = tên cột DB snake_case).
   * Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @returns {Promise<null>}
   */
  async insertGoods(row) {
    // TẮT GHI * (2026-10-16): không chèn vào bảng thật.
    // return rawInsertRow(db.query, TABLES.goods, row);
    return null;
  }

  /**
   * Thêm PO header (row key = tên cột DB snake_case).
   * Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @returns {Promise<null>}
   */
  async insertOrder1(row) {
    // TẮT GHI * (2026-10-16): không chèn vào bảng thật.
    // return rawInsertRow(db.query, TABLES.order1, row);
    return null;
  }

  /**
   * Thêm PO line (row key = tên cột DB snake_case).
   * Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @returns {Promise<null>}
   */
  async insertOrder2(row) {
    // TẮT GHI * (2026-10-16): không chèn vào bảng thật.
    // return rawInsertRow(db.query, TABLES.order2, row);
    return null;
  }

  /**
   * Thêm notice header (row key = tên cột DB snake_case).
   * Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @returns {Promise<null>}
   */
  async insertNotice1(row) {
    // TẮT GHI * (2026-10-16): không chèn vào bảng thật.
    // return rawInsertRow(db.query, TABLES.notice1, row);
    return null;
  }

  /**
   * Thêm notice detail (row key = tên cột DB snake_case).
   * Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @returns {Promise<null>}
   */
  async insertNotice2(row) {
    // TẮT GHI * (2026-10-16): không chèn vào bảng thật.
    // return rawInsertRow(db.query, TABLES.notice2, row);
    return null;
  }

  /**
   * Thêm GRN header (row key = tên cột DB snake_case).
   * Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @returns {Promise<null>}
   */
  async insertIn1(row) {
    // TẮT GHI * (2026-10-16): không chèn vào bảng thật.
    // return rawInsertRow(db.query, TABLES.in1, row);
    return null;
  }

  /**
   * Thêm GRN line (row key = tên cột DB snake_case).
   * Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} row row key = tên cột DB
   * @returns {Promise<null>}
   */
  async insertIn2(row) {
    // TẮT GHI * (2026-10-16): không chèn vào bảng thật.
    // return rawInsertRow(db.query, TABLES.in2, row);
    return null;
  }

  // ================================================================
  // T8-SIMULATOR (layer duy nhất được ghi *)
  // ================================================================

  /**
   * Đảm bảo có notice cho 1 dòng PO (po_id = pur_order2.id):
   * - Đọc notice thật khớp PO line theo (pur_no = o1.sheet_no, goods_no)
   *   — join order1 ĐÃ XÁC NHẬN theo o1.sheet_no = o2.sheet_no (sheet_lot
   *   ĐÃ BỊ CHỨNG MINH KHÔNG là khóa — bỏ hoàn toàn). PO-LINE KEY theo
   *   (pur_no, goods_no) là CHƯA XÁC NHẬN [U1]. Có -> trả về notice cuối
   *   cùng theo id.
   * - Ngược lại: phần TẠO notice đã bị TẮT (ghi t8 thật 2026-10-16) nên
   *   trả về null — luồng IQC vẫn áp kết quả lên allocation, receipt
   *   KHÔNG được tạo giả.
   *
   * SQL bước 1 (dòng PO đầy đủ = order2 JOIN order1 theo sheet_no ĐÃ XÁC
  * NHẬN) alias GIỮ NGUYÊN tên cột kiểu cũ (po_id, sheet_id, goods_no,
   * unit_no, sheet_qty, made_lot, del_date, order1_id, po_number, su_no,
   * emp_no) — JS bên dưới truy cập trực tiếp các tên này. SQL bước 2 (notice thật)
   * alias đầy đủ camelCase như shape mapNotice2Row cũ.
   * @param {string} poId po_id = pur_order2.id
   * @returns {Promise<Record<string, unknown> | null>} notice row
   *   (camelCase) hoặc null
   */
  async ensureNoticeForPo(poId) {
    // Bước 1: dòng PO (po_id) + header PO đã xác nhận.
    const sqlPoLine = `
    -- DECLARE @poId INT = 3;
    SELECT o2.id AS po_id, o2.sheet_id, o2.goods_no, o2.unit_no,
           o2.sheet_qty, o2.made_lot, o2.del_date,
           o1.id AS order1_id, o1.sheet_no AS po_number,
           o1.su_no, o1.emp_no
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE o2.id = ?;
  `;
    const paramsPoLine = [poId];
    guardParams(paramsPoLine);
    const { rows: poRows } = await db.query(
      toDialect(sqlPoLine),
      paramsPoLine
    );
    const po = poRows[0];
    if (!po) return null;

    // Bước 2: notice thật khớp PO line theo KEY FINAL [R2] = pur_no +
    // goods_no + def02 (NULL-safe) VÀ pur_id = o2.sheet_id (PO identity
    // fix 2026-10-29 — pur_id là sheet_id dòng PO, KHÔNG phải order2.id;
    // điều kiện ngày def23 đã bỏ theo user duyệt 2026-10-28); KHÔNG dùng
    // sheet_lot. Mirror memory: noticesOfOrder2(). Lấy notice cuối cùng
    // theo id (ORDER BY n2.id DESC).
    const sqlNotice = `
    -- DECLARE @poId INT = 3;
    SELECT
      n2.id AS [id],
      n2.sheet_id AS [sheetId],
      n2.sheet_no AS [sheetNo],
      n2.pur_no AS [purNo],
      n2.pur_id AS [purId],
      n2.goods_no AS [goodsNo],
      n2.unit_no AS [unitNo],
      n2.st_no AS [stNo],
      CAST(n2.sheet_qty AS FLOAT) AS [sheetQty],
      CAST(n2.check_qty AS FLOAT) AS [checkQty],
      CAST(n2.bad_qty AS FLOAT) AS [badQty],
      CAST(n2.return_qty AS FLOAT) AS [returnQty],
      n2.qc_level AS [qcLevel],
      n2.adj_result AS [adjResult],
      n2.pro_result AS [proResult],
      n2.qc_date AS [qcDate],
      n2.qc_user_no AS [qcUserNo],
      n2.qc_emp_no AS [qcEmpNo],
      n2.made_lot AS [madeLot],
      n2.sheet_lot AS [sheetLot]
    FROM pur_notice2 n2
    JOIN pur_order2 o2 ON o2.id = ?
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE n2.pur_no = o1.sheet_no
      AND n2.pur_id = o2.sheet_id
      AND n2.goods_no = o2.goods_no
      AND ((n2.def02 IS NULL AND o2.def02 IS NULL) OR n2.def02 = o2.def02)
    ORDER BY n2.id DESC;
  `;
    const paramsNotice = [po.po_id];
    guardParams(paramsNotice);
    const { rows: existingRows } = await db.query(
      toDialect(sqlNotice),
      paramsNotice
    );
    // SQL đã alias đầy đủ camelCase — trả thẳng, không cần mapper.
    if (existingRows[0]) return existingRows[0];

    /* TẮT GHI * (2026-10-16, yêu cầu user): không tự tạo notice
       pur_notice1/2 trên DB thật — luồng IQC chỉ áp dụng khi
       allocation ĐÃ match notice thật từ T8. Khởi tạo notice bên
       dưới bị comment lại; phần đọc existing phía trên vẫn hoạt động.
       Muốn mở lại: bỏ comment + giải quyết `query` tx từ service.
    // Sinh id moi = MAX(id) + 1 cho notice1 / notice2
    const max1 = await db.query(`SELECT MAX(id) AS max_id FROM ${TABLES.notice1}`);
    const max2 = await db.query(`SELECT MAX(id) AS max_id FROM ${TABLES.notice2}`);
    const n1Id = Number(max1.rows[0] ? max1.rows[0].max_id : 0) + 1;
    const n2Id = Number(max2.rows[0] ? max2.rows[0].max_id : 0) + 1;

    const nowIso = new Date().toISOString();
 // Business lot (2026-10-29): lot duy nhất = made_lot có sẵn — không
    // fake LOT-<timestamp> khi thiếu (made_lot NULL → để NULL, worker sẽ
    // giữ WAITING_LOT thay vì bịa lot).
    const lotCode = po.made_lot;
    const sheetNo = `PN-SIM-${String(Date.now()).slice(-10)}`;
    const etaIso = po.del_date ? new Date(po.del_date).toISOString() : nowIso;

    await rawInsertRow(db.query, TABLES.notice1, {
      id: n1Id,
      sheet_no: sheetNo,
      sheet_date: nowIso,
      su_no: po.su_no,
      emp_no: po.emp_no,
      eta: etaIso,
      sheet_sta: 'Y',
      check_sta: 'Y',
    });
    const inserted = await rawInsertRow(db.query, TABLES.notice2, {
      id: n2Id,
      // sheet_id là line seq của receipt (KHÔNG phải notice1.id —
      // header join chuẩn T8 là n1.sheet_no = n2.sheet_no)
      sheet_id: 1,
      sheet_no: sheetNo,
      pur_no: po.po_number,
        // PO identity fix (2026-10-29): pur_id = pur_order2.sheet_id
      // (line seq), KHÔNG phải order2.id (po_id).
      pur_id: po.sheet_id,
      goods_no: po.goods_no,
      unit_no: po.unit_no,
      st_no: '01',
      sheet_qty: Number(po.sheet_qty),
      check_qty: 0,
      bad_qty: 0,
      return_qty: 0,
      qc_level: null,
      adj_result: '0',
      pro_result: null,
      qc_date: null,
      qc_user_no: null,
      qc_emp_no: null,
      made_lot: lotCode,
      sheet_lot: lotCode,
    });
    // KEY FINAL [R2]: notice mới phải khớp lại dòng PO gốc theo def02 —
    // khi mở lại phải SELECT thêm o2.def02 trong câu SQL bước 1 của
    // method này (điều kiện ngày def23 đã bỏ theo user duyệt 2026-10-28;
    // pur_id đã dùng po.sheet_id đúng semantics 2026-10-29).
    return inserted || null;
    */
    return null;
  }

  /**
   * Cập nhật lot trên PO line: pur_order2.made_lot.
   * Hiện tắt ghi — luôn trả null.
   * @param {string} poId pur_order2.id
   * @param {string} lotCode mã lot mới
   * @returns {Promise<null>}
   */
  async setOrder2Lot(poId, lotCode) {
    // TẮT GHI * (2026-10-16): không cập nhật made_lot trên PO line thật.
    // const { rows } = await db.query(
    //   t8UpdateSql(TABLES.order2, 'made_lot = ?', 'id = ?'),
    //   [lotCode, poId]
    // );
    // return rows[0] || null;
    return null;
  }

  /**
   * Cập nhật lot trên notice: pur_notice2.made_lot.
   * Hiện tắt ghi — luôn trả null.
   * @param {string} noticeId pur_notice2.id
   * @param {string} lotCode mã lot mới
   * @returns {Promise<null>}
   */
  async setNoticeLot(noticeId, lotCode) {
    // TẮT GHI * (2026-10-16): không cập nhật made_lot trên notice thật.
    // const { rows } = await db.query(
    //   t8UpdateSql(TABLES.notice2, 'made_lot = ?', 'id = ?'),
    //   [lotCode, noticeId]
    // );
    // return rows[0] || null;
    return null;
  }

  /**
   * Mô phỏng push kết quả IQC từ T8 vào pur_notice2:
   * params = { noticeDetailId, adjResult, checkQty, badQty, returnQty,
   *            qcDate? }. qcDate mặc định = now.
   * Hiện tắt ghi — luôn trả null.
   * @param {{ noticeDetailId: string, adjResult: string, checkQty?: number,
   *   badQty?: number, returnQty?: number, qcDate?: string|Date }} params
   *   dữ liệu quyết định IQC
   * @returns {Promise<null>}
   */
  async pushIqcDecision(params) {
    /* TẮT GHI * (2026-10-16, yêu cầu user): không đẩy kết quả IQC
       vào pur_notice2 trên DB thật — WHS vẫn cập nhật allocation
       (whs_slot_allocation) bình thường, chỉ bộ phận ghi sang T8 tắt.
    const qcDateIso = params.qcDate
      ? params.qcDate instanceof Date
        ? params.qcDate.toISOString()
        : params.qcDate
      : new Date().toISOString();
    const { rows } = await db.query(
      t8UpdateSql(
        TABLES.notice2,
        'adj_result = ?, qc_date = ?, check_qty = ?, bad_qty = ?, return_qty = ?',
        'id = ?'
      ),
      [
        params.adjResult,
        qcDateIso,
        params.checkQty ?? 0,
        params.badQty ?? 0,
        params.returnQty ?? 0,
        params.noticeDetailId,
      ]
    );
    return rows[0] || null;
    */
    return null;
  }

  /**
   * Thêm nhân viên mới (bas_emp) — params camelCase, id =
   * findMaxEmpId(). Hiện tắt ghi — luôn trả null.
   * @param {Record<string, unknown>} params hồ sơ nhân viên camelCase
   * @returns {Promise<null>}
   */
  async createEmployee(params) {
    // TẮT GHI * (2026-10-16): không tạo hồ sơ nhân viên trên DB thật.
    // return rawInsertRow(db.query, TABLES.emps, {
    //   id: params.id,
    //   emp_no: params.emp_no,
    //   emp_name: params.emp_name,
    //   email: params.email,
    //   dept_no: 'GI',
    //   org_no: 'GI',
    //   duty_no: '10',
    //   act_sw: 'Y',
    // });
    return null;
  }

  /**
   * Cập nhật hồ sơ nhân viên: patch = { empName?, email? }.
   * Hiện tắt ghi — luôn trả null.
   * @param {string} empNo mã nhân sự
   * @param {{ empName?: string, email?: string }} patch field cần đổi
   * @returns {Promise<null>}
   */
  async updateEmployee(empNo, patch) {
    // TẮT GHI * (2026-10-16): không cập nhật hồ sơ nhân viên DB thật.
    // const sets = [];
    // const values = [];
    // if (patch.empName !== undefined) {
    //   sets.push('emp_name = ?');
    //   values.push(patch.empName);
    // }
    // if (patch.email !== undefined) {
    //   sets.push('email = ?');
    //   values.push(patch.email);
    // }
    // if (sets.length === 0) return null;
    // values.push(empNo);
    // const { rows } = await db.query(
    //   t8UpdateSql(TABLES.emps, sets.join(', '), 'emp_no = ?'),
    //   values
    // );
    // return rows[0] || null;
    return null;
  }

  /**
   * Đổi mã nhân sự trong bas_emp (các bảng whs_* do account repo lo).
   * Hiện tắt ghi — luôn trả null.
   * @param {string} oldEmpNo mã cũ
   * @param {string} newEmpNo mã mới
   * @returns {Promise<null>}
   */
  async renameEmployee(oldEmpNo, newEmpNo) {
    // TẮT GHI * (2026-10-16): không đổi mã nhân sự trên DB thật
    // (chỉ whs_user_role do account repo cập nhật).
    // const { rows } = await db.query(
    //   t8UpdateSql(TABLES.emps, 'emp_no = ?', 'emp_no = ?'),
    //   [newEmpNo, oldEmpNo]
    // );
    // return rows[0] || null;
    return null;
  }

  /**
   * Tìm hồ sơ nhân viên theo emp_no (bas_emp) — SELECT thẳng cột
   * (nguyên thủy, không alias — account/t8-simulator đọc raw row).
   * @param {string} empNo mã nhân sự
   * @returns {Promise<Record<string, unknown> | null>} hồ sơ hoặc null
   */
  async findEmpByNo(empNo) {
    const sql = `
    -- DECLARE @empNo NVARCHAR(40) = 'EMP-001';
    SELECT * FROM bas_emp WHERE emp_no = ?;
  `;
    const params = [empNo];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * Id nhân viên tiếp theo (bas_emp) — MAX(id) + 1, bảng rỗng thì 1.
   * @returns {Promise<number>} id kế tiếp
   */
  async findMaxEmpId() {
    const sql = `
    -- DECLARE khong can tham so.
    SELECT COALESCE(MAX(id), 0) + 1 AS [next] FROM bas_emp;
  `;
    const params = [];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return Number(rows[0] ? rows[0].next : 1);
  }

  /** Reset mock T8: notice2 về chưa có quyết định IQC. Hiện tắt ghi —
   *  no-op. */
  async resetT8Mocks() {
    // TẮT GHI * (2026-10-16): không reset mock T8 trên DB thật.
    // await db.query(
    //   `UPDATE ${TABLES.notice2}
    //    SET adj_result = '0', pro_result = NULL, qc_date = NULL,
    //        check_qty = 0, bad_qty = 0, return_qty = 0`
    // );
  }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository().t8;
} else {
  module.exports = new T8Model();
  module.exports.T8Model = T8Model; // giữ class cho reset.repository dùng tx
}
