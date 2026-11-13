'use strict';

/**
 * Repository phân công thủ kho NPL (whs_keeper_material_assignment JOIN
 * t8_bas_goods / t8_bas_emp / whs_user_role).
 *
 * Kiến trúc (refactor 2026-10-26 lần 2 theo yêu cầu user — SQL thực thi
 * trực tiếp trong method, không còn tầng hàm sqlXxx/exec): MaterialModel là
 * class singleton (module.exports = new); MỖI public method tự khai báo câu
 * SQL ngay trong method (`const sql = \`...\`;`), tự dựng mảng params theo
 * đúng thứ tự placeholder, rồi tự gọi `db.query(toDialect(sql), params)` —
 * hoặc `query(toDialect(sql), params)` với method nhận executor tx từ bên
 * ngoài. Không còn các hàm private trả { text, params } và không còn wrapper
 * exec — toDialect() chỉ chuyển dialect (SQL Server -> PostgreSQL sandbox),
 * KHÔNG phải lớp builder. Tham số bind QUA PLACEHOLDER `?` — db.js tự đổi
 * thành @p1.. (SQL Server) hoặc $1.. (PostgreSQL), tuyệt đối KHÔNG nối giá
 * trị trực tiếp vào chuỗi SQL. Alias [camelCase] giữ đúng shape service/FE
 * cần — SQL tự alias đủ nên KHÔNG cần row-mapper.
 *
 * Test SSMS: copy câu SQL (kèm comment -- DECLARE) sang SSMS, uncomment
 * dòng DECLARE, thay placeholder bằng biến tương ứng là chạy được ngay.
 *
 * DUAL DIALECT (SQL Server production + PostgreSQL sandbox test):
 * SQL viết theo cú pháp SQL Server; toDialect() chỉ chuyển những chỗ PG
 * không chấp nhận nguyên văn (xem JSDoc của toDialect). Phân trang dùng
 * cú pháp chuẩn OFFSET ... FETCH NEXT ... — cả hai bên đều hỗ trợ.
 *
 * Nhóm truy vấn: (1) liệt kê/đếm NPL — listPaged (kèm câu đếm fallback
 * inline khi trang vượt cuối); (2) tra cứu & lịch sử phân công — byGoods/
 * history/activeByKeeper (bulkAssign tự dựng câu refetch danh sách động);
 * (3) ghi phân công — assignSteps (close active cũ + insert dòng mới);
 * (4) validate — validateGoods/validateGoodsEligible/validateKeeper.
 *
 * UQ filtered (goods_no WHERE ended_at IS NULL): mỗi goods chỉ 1 dòng
 * active — assign mới phải close dòng active cũ trước (assignSteps).
 *
 * assign / bulkAssign: close dòng active cũ + INSERT dòng mới + refetch
 * chạy trong 1 transaction (db.withTransaction) — close và insert phải
 * cùng tx để không vi phạm UQ_whs_kma_goods_active. Tham số `query` tùy
 * chọn cuối để chạy trong transaction bên ngoài (pattern reset như các
 * repo khác).
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

/**
 * NPL eligibility 2026-10-21 (change request): NPL hợp lệ là goods_no bắt
 * đầu bằng M1..M6 hoặc A2 — LIKE từng prefix một (KHÔNG dùng 'M%' / 'A%'
 * rộng hơn, cũng không dùng LEFT / SUBSTRING để giữ SARGable). Dùng chung
 * cho: /materials (listPaged + count fallback) và validate
 * (validateGoodsEligible — bản copy inline giữ nguyên như trước).
 * PACKING chưa có rule — TODO(PACKING), không đoán bằng goods_name.
 */
const ELIGIBLE_NPL_SQL = `(
      g.goods_no LIKE 'M1%' OR g.goods_no LIKE 'M2%'
      OR g.goods_no LIKE 'M3%' OR g.goods_no LIKE 'M4%'
      OR g.goods_no LIKE 'M5%' OR g.goods_no LIKE 'M6%'
      OR g.goods_no LIKE 'A2%'
    )`;

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
      '[material.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

// ==================== CLASS REPOSITORY ====================

class MaterialModel {
  /**
   * GET /materials — phân trang + total (COUNT(*) OVER() gắn ngay trong
   * câu rows để khỏi chạy count riêng; trang vượt cuối fallback câu đếm
   * riêng — cùng điều kiện WHERE — giống po.repository). Filter tùy chọn
   * viết dạng "CAST(? AS NVARCHAR(200)) IS NULL OR ..." vì PG không suy
   * diễn kiểu cho "$n IS NULL" trần.
   * @param {{ page: number, pageSize: number, search?: string }} opts
   * @returns {Promise<{ rows: Record<string, unknown>[], total: number }>}
   */
  async listPaged(opts) {
    const offset = (opts.page - 1) * opts.pageSize;
    const searchPattern = opts.search ? `%${opts.search}%` : null;
    const sql = `
    -- DECLARE @searchPattern NVARCHAR(200) = N'%thep%'; -- NULL = khong loc
    -- DECLARE @offset INT = 0;
    -- DECLARE @pageSize INT = 10;
    SELECT
      g.goods_no AS [goodsNo],
      g.goods_name AS [goodsName],
      a.keeper_emp_no AS [keeperEmpNo],
      e.emp_name AS [keeperName],
      a.assigned_at AS [assignedAt],
      CAST(CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS BIT) AS [isAssigned],
      COUNT(*) OVER() AS [totalCnt]
    FROM bas_goods g
    LEFT JOIN whs_keeper_material_assignment a
      ON a.goods_no = g.goods_no AND a.ended_at IS NULL
    LEFT JOIN bas_emp e ON e.emp_no = a.keeper_emp_no
    WHERE ${ELIGIBLE_NPL_SQL}
      AND (
        CAST(? AS NVARCHAR(200)) IS NULL
        OR g.goods_no LIKE ?
        OR g.goods_name LIKE ?
      )
    ORDER BY g.goods_no
    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
  `;
    const params = [
      searchPattern,
      searchPattern,
      searchPattern,
      offset,
      opts.pageSize,
    ];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    if (rows.length === 0 && opts.page > 1) {
      const countSql = `
    -- DECLARE @searchPattern NVARCHAR(200) = N'%thep%'; -- NULL = khong loc
    SELECT COUNT(*) AS [total]
    FROM bas_goods g
    WHERE ${ELIGIBLE_NPL_SQL}
      AND (
        CAST(? AS NVARCHAR(200)) IS NULL
        OR g.goods_no LIKE ?
        OR g.goods_name LIKE ?
      )
  `;
      const countParams = [searchPattern, searchPattern, searchPattern];
      guardParams(countParams);
      const counted = await db.query(toDialect(countSql), countParams);
      return {
        rows: [],
        total: Number(counted.rows[0] ? counted.rows[0].total : 0),
      };
    }
    const cleanRows = rows.map((row) => {
      const copy = { ...row };
      delete copy.totalCnt;
      return copy;
    });
    return {
      rows: cleanRows,
      total: rows.length > 0 ? Number(rows[0].totalCnt) : 0,
    };
  }

  /**
   * 1 material đầy đủ theo goods_no — null nếu không có (refetch sau
   * assign: đọc lại dòng active kèm tên thủ kho).
   * @param {string} goodsNo mã NPL
   * @param {Function} [query] bộ query (mặc định db.query) — assignSteps
   *   truyền txQuery để refetch chạy trong cùng transaction
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async byGoods(goodsNo, query = db.query) {
    const sql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'ITEM-SPCC';
    SELECT
      g.goods_no AS [goodsNo],
      g.goods_name AS [goodsName],
      a.keeper_emp_no AS [keeperEmpNo],
      e.emp_name AS [keeperName],
      a.assigned_at AS [assignedAt],
      CAST(CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS BIT) AS [isAssigned]
    FROM bas_goods g
    LEFT JOIN whs_keeper_material_assignment a
      ON a.goods_no = g.goods_no AND a.ended_at IS NULL
    LEFT JOIN bas_emp e ON e.emp_no = a.keeper_emp_no
    WHERE g.goods_no = ?
  `;
    const params = [goodsNo];
    guardParams(params);
    const { rows } = await query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * Lịch sử phân công theo goods_no (assigned_at DESC; dòng active có
   * endedAt = null, gồm cả assignment đã ended).
   * @param {string} goodsNo mã NPL
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async history(goodsNo) {
    const sql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'ITEM-SPCC';
    SELECT
      a.keeper_emp_no AS [keeperEmpNo],
      e.emp_name AS [keeperName],
      a.assigned_by_emp_no AS [assignedByEmpNo],
      b.emp_name AS [assignedByName],
      a.assigned_at AS [assignedAt],
      a.ended_at AS [endedAt],
      a.note AS [note]
    FROM whs_keeper_material_assignment a
    LEFT JOIN bas_emp e ON e.emp_no = a.keeper_emp_no
    LEFT JOIN bas_emp b ON b.emp_no = a.assigned_by_emp_no
    WHERE a.goods_no = ?
    ORDER BY a.assigned_at DESC
  `;
    const params = [goodsNo];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Đếm goods tồn tại trong t8_bas_goods — 1/0.
   * @param {string} goodsNo mã NPL
   * @returns {Promise<number>}
   */
  async validateGoods(goodsNo) {
    const sql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'ITEM-SPCC';
    SELECT COUNT(*) AS [n]
    FROM bas_goods g
    WHERE g.goods_no = ?
  `;
    const params = [goodsNo];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return Number(rows[0] ? rows[0].n : 0);
  }

  /**
   * Đếm goods thuộc NPL eligibility (M1..M6 / A2) — 1/0. Dùng làm điều
   * kiện nghiệp vụ trước khi assign (service kiểm tra rồi mới ghi).
   * @param {string} goodsNo mã NPL
   * @returns {Promise<number>}
   */
  async validateGoodsEligible(goodsNo) {
    const sql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'M1001';
    SELECT COUNT(*) AS [n]
    FROM bas_goods g
    WHERE g.goods_no = ?
      AND (
        g.goods_no LIKE 'M1%' OR g.goods_no LIKE 'M2%'
        OR g.goods_no LIKE 'M3%' OR g.goods_no LIKE 'M4%'
        OR g.goods_no LIKE 'M5%' OR g.goods_no LIKE 'M6%'
        OR g.goods_no LIKE 'A2%'
      )
  `;
    const params = [goodsNo];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return Number(rows[0] ? rows[0].n : 0);
  }

  /**
   * Đếm thủ kho còn hoạt động (role KEEPER, active, không khóa) — 1/0.
   * Đảm bảo FK keeper_emp_no -> whs_user_role(emp_no) không bị vi phạm.
   * @param {string} empNo mã nhân sự
   * @returns {Promise<number>}
   */
  async validateKeeper(empNo) {
    const sql = `
    -- DECLARE @empNo VARCHAR(20) = 'TEST-KPR';
    SELECT COUNT(*) AS [n]
    FROM whs_user_role r
    WHERE r.emp_no = ?
      AND r.role = 'KEEPER'
      AND r.active = CAST(1 AS BIT)
      AND r.locked = CAST(0 AS BIT)
  `;
    const params = [empNo];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return Number(rows[0] ? rows[0].n : 0);
  }

  /**
   * Danh sách NPL active theo thủ kho (profile / manager detail).
   * @param {string} empNo mã nhân sự thủ kho
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async activeByKeeper(empNo) {
    const sql = `
    -- DECLARE @keeperEmpNo VARCHAR(20) = 'TEST-KPR';
    SELECT
      g.goods_no AS [goodsNo],
      g.goods_name AS [goodsName],
      a.keeper_emp_no AS [keeperEmpNo],
      e.emp_name AS [keeperName],
      a.assigned_at AS [assignedAt]
    FROM whs_keeper_material_assignment a
    JOIN bas_goods g ON g.goods_no = a.goods_no
    LEFT JOIN bas_emp e ON e.emp_no = a.keeper_emp_no
    WHERE a.keeper_emp_no = ?
      AND a.ended_at IS NULL
    ORDER BY g.goods_no
  `;
    const params = [empNo];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Kết thúc phân công hiện hành của (goods, keeper): pre-check tồn tại
   * dòng active rồi mới close — trả true nếu đã close, false nếu không có.
   * Pre-check + close chạy trong 1 transaction để tránh tình trạng kiểm tra
   * xong thì dòng active bị luồng khác đổi mất. Close chỉ đóng dòng active
   * của đúng goods + đúng keeper.
   * @param {string} goodsNo mã NPL
   * @param {string} keeperEmpNo mã nhân sự thủ kho
   * @returns {Promise<boolean>} true nếu đã close thành công
   */
  async endAssignment(goodsNo, keeperEmpNo) {
    return db.withTransaction(async (txQuery) => {
      const countSql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'M1001';
    -- DECLARE @keeperEmpNo VARCHAR(20) = 'TEST-KPR';
    SELECT COUNT(*) AS [n]
    FROM whs_keeper_material_assignment
    WHERE goods_no = ?
      AND keeper_emp_no = ?
      AND ended_at IS NULL
  `;
      const countParams = [goodsNo, keeperEmpNo];
      guardParams(countParams);
      const counted = await txQuery(toDialect(countSql), countParams);
      if (Number(counted.rows[0] ? counted.rows[0].n : 0) === 0) return false;
      const closeSql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'M1001';
    -- DECLARE @keeperEmpNo VARCHAR(20) = 'TEST-KPR';
    UPDATE whs_keeper_material_assignment
    SET ended_at = SYSUTCDATETIME()
    WHERE goods_no = ?
      AND keeper_emp_no = ?
      AND ended_at IS NULL
  `;
      const closeParams = [goodsNo, keeperEmpNo];
      guardParams(closeParams);
      await txQuery(toDialect(closeSql), closeParams);
      return true;
    });
  }

  /**
   * Gán / đổi thủ kho NPL: closeActive + INSERT + refetch trong 1
   * transaction (close cũ trước khi insert mới để không đụng filtered
   * unique UQ_whs_kma_goods_active). values = { id, goodsNo, keeperEmpNo,
   * assignedByEmpNo, assignedAt, note }. Tham số `query` tùy chọn: truyền
   * txQuery để chạy trong transaction bên ngoài; không truyền -> tự mở
   * withTransaction.
   * @param {{ id: string, goodsNo: string, keeperEmpNo: string,
   *   assignedByEmpNo: string, assignedAt: string, note?: string }} values
   * @param {Function} [query] tx query bên ngoài (tùy chọn)
   * @returns {Promise<Record<string, unknown> | null>} material full shape
   */
  async assign(values, query) {
    if (query) return this.assignSteps(values, query);
    return db.withTransaction((txQuery) => this.assignSteps(values, txQuery));
  }

  /**
   * Gán hàng loạt NPL cho cùng 1 thủ kho trong 1 transaction: close mỗi
   * goods active cũ + insert dòng mới + cuối cùng refetch tất cả goods có
   * hiệu lực (đã gán thành công). Goods không tồn tại / ngoài eligibility
   * được tự động bỏ qua. Câu refetch dựng động danh sách placeholder
   * `IN (?, ?, ...)` theo đúng số goods đã gán (giữ nguyên thứ tự).
   * @param {{ goodsNos: string[], keeperEmpNo: string,
   *   assignedByEmpNo: string, assignedAt: string, note?: string| null }} values
   * @returns {Promise<Record<string, unknown>[]>} danh sách NPL sau gán (full shape)
   */
  async bulkAssign(values) {
    // Id từng dòng assignment do SERVICE sinh sẵn (values.ids, cùng thứ
    // tự goodsNos) — repository không phụ thuộc ngược sang service layer
    // (refactor 2026-10-26 theo mẫu Kanban).
    const pendingIds = Array.isArray(values.ids) ? [...values.ids] : [];
    return db.withTransaction(async (txQuery) => {
      const results = [];
      for (const goodsNo of values.goodsNos) {
        const existsSql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'ITEM-SPCC';
    SELECT COUNT(*) AS [n]
    FROM bas_goods g
    WHERE g.goods_no = ?
  `;
        const existsParams = [goodsNo];
        guardParams(existsParams);
        const exists = await txQuery(toDialect(existsSql), existsParams);
        if (Number(exists.rows[0] ? exists.rows[0].n : 0) === 0) continue;
        const eligibleSql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'M1001';
    SELECT COUNT(*) AS [n]
    FROM bas_goods g
    WHERE g.goods_no = ?
      AND (
        g.goods_no LIKE 'M1%' OR g.goods_no LIKE 'M2%'
        OR g.goods_no LIKE 'M3%' OR g.goods_no LIKE 'M4%'
        OR g.goods_no LIKE 'M5%' OR g.goods_no LIKE 'M6%'
        OR g.goods_no LIKE 'A2%'
      )
  `;
        const eligibleParams = [goodsNo];
        guardParams(eligibleParams);
        const eligible = await txQuery(
          toDialect(eligibleSql),
          eligibleParams
        );
        if (Number(eligible.rows[0] ? eligible.rows[0].n : 0) === 0) continue;
        const id = pendingIds.shift();
        if (!id) {
          throw new Error(
            '[material.repository] bulkAssign thiếu id cho dòng assignment mới'
          );
        }
        await this.assignSteps(
          {
            id,
            goodsNo,
            keeperEmpNo: values.keeperEmpNo,
            assignedByEmpNo: values.assignedByEmpNo,
            assignedAt: values.assignedAt,
            note: values.note ?? null,
          },
          txQuery
        );
        results.push(goodsNo);
      }
      if (results.length === 0) return [];
      // Refetch tất cả goods vừa gán để trả full shape
      const placeholders = results.map(() => '?').join(', ');
      const refetchSql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'ITEM-SPCC'; -- 1 dong DECLARE moi goods
    SELECT
      g.goods_no AS [goodsNo],
      g.goods_name AS [goodsName],
      a.keeper_emp_no AS [keeperEmpNo],
      e.emp_name AS [keeperName],
      a.assigned_at AS [assignedAt],
      CAST(CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS BIT) AS [isAssigned]
    FROM bas_goods g
    LEFT JOIN whs_keeper_material_assignment a
      ON a.goods_no = g.goods_no AND a.ended_at IS NULL
    LEFT JOIN bas_emp e ON e.emp_no = a.keeper_emp_no
    WHERE g.goods_no IN (${placeholders})
    ORDER BY g.goods_no
  `;
      const refetchParams = [...results];
      guardParams(refetchParams);
      const { rows } = await txQuery(toDialect(refetchSql), refetchParams);
      return rows;
    });
  }

  /**
   * @private 3 lệnh assign (close cũ / insert mới / refetch) chạy trên cùng
   * 1 query fn để nằm trong cùng transaction. Close dòng active cũ trước
   * (UQ filtered: chỉ 1 dòng active / goods) rồi mới insert dòng mới
   * (id = genId, assigned_at = JS ISO string). Refetch trong cùng
   * transaction để trả material full shape — đọc lại dòng vừa insert (đã
   * đóng active cũ nên chỉ có 1 dòng active).
   * @param {{ id: string, goodsNo: string, keeperEmpNo: string,
   *   assignedByEmpNo: string, assignedAt: string, note?: string|null }} values
   * @param {Function} query tx query
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async assignSteps(values, query) {
    const closeSql = `
    -- DECLARE @goodsNo VARCHAR(30) = 'ITEM-SPCC';
    UPDATE whs_keeper_material_assignment
    SET ended_at = SYSUTCDATETIME()
    WHERE goods_no = ? AND ended_at IS NULL
  `;
    const closeParams = [values.goodsNo];
    guardParams(closeParams);
    await query(toDialect(closeSql), closeParams);
    const insertSql = `
    -- DECLARE @id VARCHAR(40) = 'kma-1730092800000-ab12';
    -- DECLARE @goodsNo VARCHAR(30) = 'ITEM-SPCC';
    -- DECLARE @keeperEmpNo VARCHAR(20) = 'TEST-KPR';
    -- DECLARE @assignedByEmpNo VARCHAR(20) = 'TEST-MGR';
    -- DECLARE @assignedAt DATETIME2(3) = '2026-10-20T08:00:00Z';
    -- DECLARE @note NVARCHAR(200) = NULL;
    INSERT INTO whs_keeper_material_assignment
      (id, goods_no, keeper_emp_no, assigned_by_emp_no, assigned_at, ended_at, note)
    VALUES
      (?, ?, ?, ?, ?, NULL, ?)
  `;
    const insertParams = [
      values.id,
      values.goodsNo,
      values.keeperEmpNo,
      values.assignedByEmpNo,
      values.assignedAt,
      values.note ?? null,
    ];
    guardParams(insertParams);
    await query(toDialect(insertSql), insertParams);
    // Refetch trong cùng transaction để trả material full shape — đọc lại
    // dòng vừa insert (đã đóng active cũ nên chỉ có 1 dòng active).
    return this.byGoods(values.goodsNo, query);
  }
}

const { getMemoryRepository } = require('../memory.repository');

if (db.getMode() === 'memory') {
  module.exports = getMemoryRepository().materials;
} else {
  module.exports = new MaterialModel();
  module.exports.MaterialModel = MaterialModel; // for reset.repository tx use
}
