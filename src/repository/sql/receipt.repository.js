'use strict';

/**
 * Repository bảng whs_allocation_receipt (mapping allocation <-> pur_notice2).
 *
 * Kiến trúc (refactor 2026-10-26 lần 2 — SQL thực thi trực tiếp trong
 * method, không còn tầng hàm sqlXxx/exec, theo yêu cầu user): ReceiptModel
 * là class singleton (module.exports = new); MỖI public method tự khai báo
 * câu SQL ngay trong thân method dưới dạng const sql = ... (template
 * literal ngay trong method) rồi tự gọi db.query(toDialect(sql), params)
 * — method có tham số executor tùy chọn thì gọi query(...). toDialect()
 * KHÔNG phải tầng builder: nó chỉ chuyển cú pháp SQL Server sang
 * PostgreSQL cho sandbox test. Tham số bind QUA PLACEHOLDER `?` — db.js tự
 * đổi thành @p1.. (SQL Server) hoặc $1.. (PostgreSQL), tuyệt đối KHÔNG
 * nối giá trị trực tiếp vào chuỗi SQL. Alias [camelCase] giữ đúng shape
 * service/FE cần — SQL tự alias đủ nên KHÔNG cần row-mapper.
 *
 * Test SSMS: copy câu SQL (kèm comment -- DECLARE) sang SSMS, uncomment
 * dòng DECLARE, thay placeholder bằng biến tương ứng là chạy được ngay.
 *
 * DUAL DIALECT (SQL Server production + PostgreSQL sandbox test):
 * SQL viết theo cú pháp SQL Server; toDialect() chỉ chuyển những chỗ PG
 * không chấp nhận nguyên văn (xem JSDoc của toDialect). Phân trang dùng
 * cú pháp chuẩn OFFSET ... FETCH NEXT ... — cả hai bên đều hỗ trợ.
 *
 * 1 dòng receipt = "allocation X đã nhận hàng theo notice Y":
 *   allocation_id    -> physical FK whs_slot_allocation.id
 *   notice_detail_id -> LOGICAL reference pur_notice2.id (KHÔNG FK vật lý)
 *   received_qty     = số lượng của notice đã liên kết vào allocation
 * UQ (allocation_id, notice_detail_id): 1 cặp chỉ tồn tại 1 dòng.
 * Chỉ được tạo bởi receipt-sync khi mapping KHÔNG ambiguous — xem
 * services/receipt-sync.service.js.
 *
 * Nhóm truy vấn: (1) theo allocation — findByAllocationId; (2) theo cặp
 * (allocation, notice) — findByAllocationAndNotice; (3) tổng received
 * theo notice — sumReceivedByNotice; (4) đọc 1 dòng theo id — SQL lặp lại
 * inline trong insertReceipt / updateReceipt (refetch sau ghi); (5) reset
 * seed — deleteAll.
 *
 * Lưu ý kiểu dữ liệu trong SQL:
 *   - số  : CAST(col AS FLOAT) — null giữ nguyên (KHÔNG COALESCE 0)
 *   - bool: cột BIT passthrough (has_warning AS [hasWarning])
 *   - ngày: alias thẳng cột (driver trả Date, JSON hóa thành ISO)
 *
 * Ghi động (insertReceipt / updateReceipt) dùng builder private
 * buildRawInsert / buildRawUpdate — cùng hành vi query-builder.js cũ
 * (OUTPUT inserted.* cho mssql / RETURNING * cho pg, chọn theo dialect lúc
 * runtime). Sau khi ghi, REFETCH bằng câu SELECT theo id khai báo inline
 * trong chính method để trả shape camelCase đầy đủ (row OUTPUT có key
 * snake_case).
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

// ==================== PRIVATE: HỖ TRỢ DIALECT + GUARD THAM SỐ ====================

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
      '[receipt.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

// ==================== PRIVATE: BUILDER INSERT/UPDATE ĐỘNG ====================

/**
 * Dựng câu INSERT trực tiếp từ row có key = TÊN CỘT DB (snake_case) —
 * dùng cho seed / receipt-sync (cột thay đổi theo row runtime nên không
 * thể viết tĩnh). Vị trí mệnh đề lấy về dòng vừa ghi khác nhau theo
 * dialect: SQL Server đặt OUTPUT inserted.* TRƯỚC VALUES; PG bắt
 * RETURNING ở CUỐI câu — sai vị trí là PG từ chối cú pháp.
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

  return { text, values: keys.map((key) => row[key]) };
}

/**
 * Dựng câu UPDATE trực tiếp từ patch có key = TÊN CỘT DB (snake_case).
 * @param {string} table tên bảng thật
 * @param {Record<string, unknown>} patch object key = tên cột DB sẽ SET
 * @param {string} whereCol tên cột điều kiện ('id')
 * @param {unknown} whereValue giá trị của cột điều kiện
 * @returns {{ text: string, values: unknown[] } | null} null nếu patch rỗng
 */
function buildRawUpdate(table, patch, whereCol, whereValue) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return null;

  const sets = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => patch[key]);
  values.push(whereValue);

  const text = isPg()
    ? `UPDATE ${table} SET ${sets} WHERE ${whereCol} = ? RETURNING *`
    : `UPDATE ${table} SET ${sets} OUTPUT inserted.* WHERE ${whereCol} = ?`;

  return { text, values };
}

// ==================== CLASS REPOSITORY ====================

class ReceiptModel {
  /**
   * Toàn bộ receipt của 1 allocation (thứ tự theo notice_detail_id).
   * Service dùng để: mirror lot_no, áp IQC, log activity.
   * @param {string} allocationId PK của whs_slot_allocation
   * @param {Function} [query] bộ query (mặc định db.query) — receipt-sync
   *   truyền txQuery để đọc trong cùng transaction với ghi receipt
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findByAllocationId(allocationId, query = db.query) {
    const sql = `
    -- DECLARE @allocationId NVARCHAR(40) = 'al_abc123';
    SELECT
      r.id AS [id],
      r.allocation_id AS [allocationId],
      r.notice_detail_id AS [noticeDetailId],
      CAST(r.received_qty AS FLOAT) AS [receivedQty],
      r.lot_no AS [lotNo],
      r.iqc_decision AS [iqcDecision],
      CAST(r.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(r.qty_return AS FLOAT) AS [qtyReturn],
      CAST(r.qty_aod AS FLOAT) AS [qtyAod],
      r.has_warning AS [hasWarning],
      r.qc_date AS [qcDate],
      r.confirmed_at AS [confirmedAt],
      r.updated_at AS [updatedAt]
    FROM whs_allocation_receipt r
    WHERE r.allocation_id = ?
    ORDER BY r.notice_detail_id;
  `;
    const params = [allocationId];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return rows;
  }

  /**
   * UNDO ASSIGN (2026-11-07): hard-delete mọi receipt mapping của 1
   * allocation — giải phóng số lượng Notice allocation cũ đang chiếm
   * (mapping đã MATCHED vẫn được release vì Receipt Sync không phải
   * downstream không thể đảo ngược). Trả về id các dòng đã xóa làm bằng
   * chứng kết quả — executor không trả affected-count trong transaction.
   * KHÔNG chạm T8.
   * @param {string} allocationId PK allocation
   * @param {Function} [query] executor (mặc định db.query; Undo truyền
   *   txQuery để xóa trong cùng transaction)
   * @returns {Promise<number>} số dòng đã xóa
   */
  async deleteReceiptsByAllocation(allocationId, query = db.query) {
    const sql = isPg()
      ? `
      -- DECLARE @allocationId VARCHAR(40) = 'al_abc123';
      DELETE FROM whs_allocation_receipt WHERE allocation_id = ? RETURNING id;
    `
      : `
      -- DECLARE @allocationId NVARCHAR(40) = 'al_abc123';
      DELETE FROM whs_allocation_receipt OUTPUT deleted.id
      WHERE allocation_id = ?;
    `;
    const params = [allocationId];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return rows.length;
  }
  /**
   * BATCH (sweep phase-2 revalidation): receipt của NHIỀU allocation trong
   * 1 câu — chống N+1 khi sweep revalidate cả batch allocation đã sync
   * (#10/#46). Placeholder IN liệt kê từng phần tử (parameterized hết,
   * không ghép chuỗi giá trị — #42 SQLi).
   * @param {string[]} allocationIds danh sách PK allocation (khác rỗng)
   * @returns {Promise<Record<string, unknown>[]>} mọi dòng shape giống
   *   findByAllocationId (kèm allocationId để caller group theo allocation)
   */
  async findReceiptsByAllocationIds(allocationIds) {
    if (!Array.isArray(allocationIds) || allocationIds.length === 0) {
      return [];
    }
    const sql = `
    SELECT
      r.id AS [id],
      r.allocation_id AS [allocationId],
      r.notice_detail_id AS [noticeDetailId],
      CAST(r.received_qty AS FLOAT) AS [receivedQty],
      r.lot_no AS [lotNo],
      r.updated_at AS [updatedAt]
    FROM whs_allocation_receipt r
    WHERE r.allocation_id IN (${allocationIds.map(() => '?').join(', ')})
    ORDER BY r.allocation_id, r.notice_detail_id;
  `;
    const params = [...allocationIds];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Tìm receipt theo (allocation_id, notice_detail_id) — kiểm tra tồn tại
   * trước khi tạo mới để giữ UQ (idempotent).
   * @param {string} allocationId PK của whs_slot_allocation
   * @param {string} noticeDetailId pur_notice2.id (tham chiếu logic)
   * @param {Function} [query] bộ query (mặc định db.query) — receipt-sync
   *   truyền txQuery để kiểm tra UQ trong cùng transaction với ghi receipt
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async findByAllocationAndNotice(allocationId, noticeDetailId, query = db.query) {
    const sql = `
    -- DECLARE @allocationId NVARCHAR(40) = 'al_abc123';
    -- DECLARE @noticeDetailId INT = 9001;
    SELECT
      r.id AS [id],
      r.allocation_id AS [allocationId],
      r.notice_detail_id AS [noticeDetailId],
      CAST(r.received_qty AS FLOAT) AS [receivedQty],
      r.lot_no AS [lotNo],
      r.iqc_decision AS [iqcDecision],
      CAST(r.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(r.qty_return AS FLOAT) AS [qtyReturn],
      CAST(r.qty_aod AS FLOAT) AS [qtyAod],
      r.has_warning AS [hasWarning],
      r.qc_date AS [qcDate],
      r.confirmed_at AS [confirmedAt],
      r.updated_at AS [updatedAt]
    FROM whs_allocation_receipt r
    WHERE r.allocation_id = ?
      AND r.notice_detail_id = ?;
  `;
    const params = [allocationId, noticeDetailId];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * Tổng received_qty đã liên kết vào 1 notice (dấu hiệu notice đã được
   * allocation nào "nhận" chưa — dùng cho /pos nhánh notice lot).
   * Executor tùy chọn: receipt-sync truyền txQuery để ĐỌC FRESH trong cùng
   * transaction sau khi giành advisory lock — chống over-consume khi 2
   * worker cùng allocation song song (#41).
   * @param {string} noticeDetailId pur_notice2.id
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<number>}
   */
  async sumReceivedByNotice(noticeDetailId, query = db.query) {
    const sql = `
    -- DECLARE @noticeDetailId INT = 9001;
    SELECT COALESCE(SUM(received_qty), 0) AS [total]
    FROM whs_allocation_receipt
    WHERE notice_detail_id = ?;
  `;
    const params = [noticeDetailId];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return Number(rows[0] ? rows[0].total : 0);
  }

  /**
   * Tổng received_qty đã ghi cho 1 allocation (không qua LEFT JOIN ở
   * receipt-sync.repository — dùng trực tiếp khi cần 1 con số, vd guard
   * Move Shelf không chuyển phần hàng T8 đã nhận #17).
   * @param {string} allocationId PK whs_slot_allocation
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<number>}
   */
  async sumReceivedByAllocation(allocationId, query = db.query) {
    const sql = `
    -- DECLARE @allocationId NVARCHAR(40) = 'al_abc123';
    SELECT COALESCE(SUM(received_qty), 0) AS [total]
    FROM whs_allocation_receipt
    WHERE allocation_id = ?;
  `;
    const params = [allocationId];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return Number(rows[0] ? rows[0].total : 0);
  }

  /**
   * BATCH SET-BASED (#10/#46): tổng received_qty GROUP BY notice cho nhiều
   * notice cùng lúc — sweep phân loại hàng trăm allocation bằng 1 câu WHS
   * thay vì N câu sumReceivedByNotice (anti-pattern N+1).
   * @param {number[]} noticeIds danh sách pur_notice2.id (tối thiểu 1 phần tử)
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Map<number, number>>} noticeDetailId -> tổng received
   */
  async sumReceivedByNoticeIds(noticeIds, query = db.query) {
    if (!Array.isArray(noticeIds) || noticeIds.length === 0) {
      return new Map();
    }
    const placeholders = noticeIds.map(() => '?').join(', ');
    const sql = `
    -- DECLARE @noticeIds TABLE (id INT);
    SELECT notice_detail_id AS [noticeDetailId],
           COALESCE(SUM(received_qty), 0) AS [total]
    FROM whs_allocation_receipt
    WHERE notice_detail_id IN (${placeholders})
    GROUP BY notice_detail_id;
  `;
    const params = noticeIds.slice();
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    const totals = new Map();
    for (const row of rows) {
      totals.set(Number(row.noticeDetailId), Number(row.total));
    }
    return totals;
  }

  /**
   * INSERT receipt mới (ĐỘNG). `values` có key = tên cột DB (snake_case):
   * id, allocation_id, notice_detail_id, received_qty, lot_no,
   * iqc_decision, qty_in_stock, qty_return, qty_aod, has_warning, qc_date,
   * confirmed_at, updated_at.
   * Tham số `query` tùy chọn: reset truyền txQuery để chạy trong cùng
   * transaction (NẾU dùng pool ngoài tx sẽ tự dead-lock với FK lock).
   * Sau insert thành công, REFETCH bằng câu SELECT theo id khai báo inline
   * trong method (cùng `query` fn) để trả về shape camelCase đầy đủ.
   * @param {Record<string, unknown>} values row key = tên cột DB
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async insertReceipt(values, query = db.query) {
    const insert = buildRawInsert(TABLES.receipt, values);
    const { rows } = await query(insert.text, insert.values);
    if (!rows[0]) return null;
    const sql = `
    -- DECLARE @id NVARCHAR(40) = 'rc_abc123';
    SELECT
      r.id AS [id],
      r.allocation_id AS [allocationId],
      r.notice_detail_id AS [noticeDetailId],
      CAST(r.received_qty AS FLOAT) AS [receivedQty],
      r.lot_no AS [lotNo],
      r.iqc_decision AS [iqcDecision],
      CAST(r.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(r.qty_return AS FLOAT) AS [qtyReturn],
      CAST(r.qty_aod AS FLOAT) AS [qtyAod],
      r.has_warning AS [hasWarning],
      r.qc_date AS [qcDate],
      r.confirmed_at AS [confirmedAt],
      r.updated_at AS [updatedAt]
    FROM whs_allocation_receipt r
    WHERE r.id = ?;
  `;
    const params = [rows[0].id];
    guardParams(params);
    const { rows: refetched } = await query(toDialect(sql), params);
    return refetched[0] || null;
  }

  /**
   * UPDATE receipt theo id (ĐỘNG). `patch` có key = tên cột DB
   * (snake_case). Executor tùy chọn: receipt-sync truyền txQuery để
   * TĂNG received_qty của receipt đang có trong cùng transaction sau
   * advisory lock (#6 — receipt có thể grow an toàn, không chỉ insert).
   * Sau update thành công, REFETCH bằng câu SELECT theo id khai báo
   * inline trong method (cùng executor) để trả shape camelCase đầy đủ;
   * null nếu không tìm thấy.
   * @param {string} id PK của receipt
   * @param {Record<string, unknown>} patch các cột DB cần SET
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async updateReceipt(id, patch, query = db.query) {
    const update = buildRawUpdate(TABLES.receipt, patch, 'id', id);
    if (!update) return null;
    const { rows } = await query(update.text, update.values);
    if (!rows[0]) return null;
    const sql = `
    -- DECLARE @id NVARCHAR(40) = 'rc_abc123';
    SELECT
      r.id AS [id],
      r.allocation_id AS [allocationId],
      r.notice_detail_id AS [noticeDetailId],
      CAST(r.received_qty AS FLOAT) AS [receivedQty],
      r.lot_no AS [lotNo],
      r.iqc_decision AS [iqcDecision],
      CAST(r.qty_in_stock AS FLOAT) AS [qtyInStock],
      CAST(r.qty_return AS FLOAT) AS [qtyReturn],
      CAST(r.qty_aod AS FLOAT) AS [qtyAod],
      r.has_warning AS [hasWarning],
      r.qc_date AS [qcDate],
      r.confirmed_at AS [confirmedAt],
      r.updated_at AS [updatedAt]
    FROM whs_allocation_receipt r
    WHERE r.id = ?;
  `;
    const params = [rows[0].id];
    guardParams(params);
    const { rows: refetched } = await query(toDialect(sql), params);
    return refetched[0] || null;
  }

  /**
   * Xóa toàn bộ receipt (chỉ dùng trong reset seed).
   * @param {Function} [query] bộ query (mặc định db.query)
   * @returns {Promise<void>}
   */
  async deleteAll(query = db.query) {
    const sql = `
    DELETE FROM whs_allocation_receipt;
  `;
    const params = [];
    guardParams(params);
    await query(toDialect(sql), params);
  }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository().receipts;
} else {
  module.exports = new ReceiptModel();
  module.exports.ReceiptModel = ReceiptModel; // for reset.repository tx use
}
