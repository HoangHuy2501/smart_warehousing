// SQL cho danh sách PO, tra dòng PO và đối chiếu phiếu tạm nhập.
const db = require('../../config/db');
const pagination = require('../../util/pagination');
const { TABLES } = require('../../config/tables');

// ==================== PRIVATE: HỖ TRỢ DIALECT + GUARD ====================

/** Dialect hiện tại có phải PostgreSQL (chỉ dùng cho sandbox test)? */
function isPg() {
  return db.getDialect() === 'pg';
}

/**
 * Tên bảng logic (viết trong SQL) -> tên thật (kèm tiền tố nếu có) — quy tắc
 * 6 của toDialect quét qua từng cặp để thay.
 */
const TABLE_PAIRS = [
  ['sys_userpass', TABLES.userPass],
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

// Chuyển cú pháp SQL Server cho chế độ PostgreSQL.
function toDialect(text) {
  if (!isPg()) return text;
  let out = text.replace(/\bCOUNT_BIG\s*\(/gi, 'COUNT(');
  // 2. LIKE -> ILIKE — giữ hành vi case-insensitive như mssql collation.
  out = out.replace(/\bLIKE\b/g, 'ILIKE');
  // 3. NVARCHAR(n) -> VARCHAR(n); GETDATE()/SYSUTCDATETIME() -> NOW().
  out = out.replace(/\bNVARCHAR\s*\(/gi, 'VARCHAR(');
  out = out.replace(/\bGETDATE\s*\(\s*\)/gi, 'NOW()');
  out = out.replace(/\bSYSUTCDATETIME\s*\(\s*\)/gi, 'NOW()');
  // 4a. CAST(CASE WHEN ... THEN 1 ELSE 0 END AS BIT) -> CASE ... TRUE/FALSE.
  out = out.replace(
    /\bCAST\s*\(\s*CASE\b([\s\S]*?)\bEND\s+AS\s+BIT\s*\)/gi,
    (_m, body) =>
      `CASE${String(body)
        .replace(/\bTHEN\s+1\b/gi, 'THEN TRUE')
        .replace(/\bELSE\s+0\b/gi, 'ELSE FALSE')}END`
  );
  // 4b. CAST(1 AS BIT) / CAST(0 AS BIT) -> TRUE / FALSE (hằng boolean).
  out = out.replace(/\bCAST\s*\(\s*([01])\s+AS\s+BIT\s*\)/gi, (_m, bit) =>
    bit === '1' ? 'TRUE' : 'FALSE'
  );
  // 5. [aliasBracket] -> "alias" — pg bọc identifier bằng nháy kép.
  out = out.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, '"$1"');
  // 5c. Hàm ngày SQL Server không có trong pg.
  out = out.replace(
    /DATEADD\s*\(\s*DAY\s*,\s*(\d+)\s*,\s*CONVERT\s*\(\s*DATE\s*,\s*([A-Za-z_][\w.]*)\s*\)\s*\)/gi,
    (_m, n, col) => `(CAST(${col} AS DATE) + ${n} * INTERVAL '1 day')`
  );
  out = out.replace(
    /DATEADD\s*\(\s*DAY\s*,\s*(\d+)\s*,\s*([A-Za-z_][\w.]*)\s*\)/gi,
    (_m, n, col) => `(${col} + ${n} * INTERVAL '1 day')`
  );
  // Đồng hồ tạm nhập 24h (2026-10-28): DATEADD(HOUR, -n, GETDATE()) đã
  // thành DATEADD(HOUR, -n, NOW()) sau rule 3 -> (NOW() - n * INTERVAL '1 hour').
  out = out.replace(
    /DATEADD\s*\(\s*HOUR\s*,\s*-(\d+)\s*,\s*NOW\s*\(\s*\)\s*\)/gi,
    (_m, n) => `(NOW() - ${n} * INTERVAL '1 hour')`
  );
  out = out.replace(
    /CONVERT\s*\(\s*DATE\s*,\s*([A-Za-z_][\w.]*)\s*\)/gi,
    (_m, col) => `CAST(${col} AS DATE)`
  );
  out = out.replace(/\bDATETIME\b/g, 'TIMESTAMP');
  // 6. Tiền tố bảng sandbox — thay tên logic bằng tên thật (kèm tiền tố).
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
      '[po.repository] Tham số SQL undefined — kiểm tra biến truyền vào method'
    );
  }
}

// Bộ lọc GET /api/warehouse/pos do service cung cấp.
function searchParams(opts) {
  const kw = String(opts.keyword || '').trim();
  return {
    bucket: opts.bucket ?? null,
    // 5 mốc bucket mới (2026-10-20) — date-only YYYY-MM-DD từ service
    today: opts.today ?? null,
    prevMonthStart: opts.prevMonthStart ?? null,
    twoMonthsAgoStart: opts.twoMonthsAgoStart ?? null,
    next3End: opts.next3End ?? null,
    next7End: opts.next7End ?? null,
    // Keeper NPL permission — TỪ SESSION, không bao giờ nhận từ client;
    // manager => null (không lọc)
    keeperEmpNo: opts.keeperEmpNo ?? null,
    prefixPattern: kw ? `${kw}%` : null,
    containsPattern: kw ? `%${kw}%` : null,
  };
}

// Dùng cùng điều kiện cho COUNT, danh sách phân trang và danh sách đầy đủ.
// GET /api/warehouse/incoming-pos — dòng PO còn mở.
const INCOMING_PO_SELECT = `
    SELECT
      CAST(o2.id AS VARCHAR(20)) AS [id],
      o1.sheet_no AS [poNumber],
      CAST(o2.id AS VARCHAR(20)) AS [poLine],
      o2.goods_no AS [itemCode],
      g.goods_name AS [material],
      o1.su_name11 AS [supplier],
      CAST(o2.sheet_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      CAST(o2.sheet_pri AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN o1.check_sta = 'Y' THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      o2.del_date AS [eta],
      CAST(CASE WHEN EXISTS (
        SELECT 1 FROM pur_in2 i
        WHERE i.pur_no = o1.sheet_no AND i.pur_id = o2.sheet_id
          AND i.goods_no = o2.goods_no
      ) THEN 1 ELSE 0 END AS BIT) AS [arrived],
      (SELECT MAX(i.sheet_no) FROM pur_in2 i
       WHERE i.pur_no = o1.sheet_no AND i.pur_id = o2.sheet_id
         AND i.goods_no = o2.goods_no) AS [grnRef],
      CAST(NULL AS VARCHAR(40)) AS [lotNo],
      CAST(COALESCE((
        SELECT SUM(a.allocated_qty) FROM whs_slot_allocation a WHERE a.po_id = o2.id
      ), 0) AS FLOAT) AS [assignedQty]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    JOIN sys_userpass u ON u.user_no = o1.create_user AND u.user_name <> 'ADM'
    LEFT JOIN bas_goods g ON g.goods_no = o2.goods_no
    WHERE o1.close_sw IN ('N', '0')
      AND o1.sheet_sta <> '0'
      AND (
        o2.goods_no LIKE 'M1%' OR o2.goods_no LIKE 'M2%'
        OR o2.goods_no LIKE 'M3%' OR o2.goods_no LIKE 'M4%'
        OR o2.goods_no LIKE 'M5%' OR o2.goods_no LIKE 'M6%'
        OR o2.goods_no LIKE 'A2%'
      )
`;

// GET /api/warehouse/pos — nguồn chung cho danh sách và số đếm.
const PO_SEARCH_ELIGIBLE_SQL = `
    WITH
    -- PO mở trong phạm vi quyền và bộ lọc hiện tại.
    candidate_po AS (
    SELECT
      o2.id AS po_id,
      o1.sheet_no AS po_number,
      o1.su_name11 AS supplier,
      o1.check_sta AS check_sta,
      o2.goods_no AS item_code,
      g.goods_name AS material,
      o2.unit_no AS unit,
      o2.sheet_qty AS sheet_qty,
      o2.sheet_pri AS unit_price,
      o2.del_date AS del_date,
      o2.def02 AS def02,
      o2.sheet_id AS sheet_id,
      o2.made_lot AS made_lot,
      COALESCE(pa.assigned_total, 0) AS assigned_total,
      COALESCE(pa.gap_assigned, 0) AS gap_assigned
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    JOIN sys_userpass u
      ON u.user_no = o1.create_user AND u.user_name <> 'ADM'
    LEFT JOIN bas_goods g ON g.goods_no = o2.goods_no

    LEFT JOIN (

      SELECT x.po_id,
        SUM(x.allocated_qty) AS assigned_total,
        SUM(CASE WHEN rx.allocation_id IS NULL
          THEN x.allocated_qty ELSE 0 END) AS gap_assigned
      FROM whs_slot_allocation x
      LEFT JOIN (
        SELECT DISTINCT allocation_id
        FROM whs_allocation_receipt
      ) rx ON rx.allocation_id = x.id
      GROUP BY x.po_id
    ) pa ON pa.po_id = o2.id
    WHERE o1.close_sw IN ('N', '0')

      AND o1.sheet_sta <> '0'

        AND (
          o2.goods_no LIKE 'M1%' OR o2.goods_no LIKE 'M2%'
          OR o2.goods_no LIKE 'M3%' OR o2.goods_no LIKE 'M4%'
          OR o2.goods_no LIKE 'M5%' OR o2.goods_no LIKE 'M6%'
          OR o2.goods_no LIKE 'A2%'
        )

      AND (
        CAST(? AS NVARCHAR(20)) IS NULL
        OR EXISTS (
          SELECT 1 FROM whs_keeper_material_assignment ma
          WHERE ma.keeper_emp_no = ?
            AND ma.goods_no = o2.goods_no
            AND ma.ended_at IS NULL
        )
      )

      AND (
        CAST(? AS NVARCHAR(10)) IS NULL
        OR (? = 'overdue' AND (o2.del_date IS NULL OR o2.del_date < ?))
        OR (? = 'od3p' AND (o2.del_date IS NULL OR o2.del_date < ?))
        OR (? = 'od2' AND o2.del_date >= ? AND o2.del_date < ?)
        OR (? = 'od1' AND o2.del_date >= ? AND o2.del_date < ?)
        OR (? = 'next3' AND o2.del_date >= ? AND o2.del_date < ?)
        OR (? = 'next7' AND o2.del_date >= ? AND o2.del_date < ?)
      )
      AND (
        CAST(? AS NVARCHAR(140)) IS NULL
        OR o1.sheet_no LIKE ?
        OR o2.goods_no LIKE ?
        OR o2.made_lot LIKE ?
        OR g.goods_name LIKE ?
        OR o1.su_name11 LIKE ?
        OR EXISTS (
          SELECT 1 FROM pur_notice2 n2k
          WHERE n2k.pur_no = o2.sheet_no
            AND n2k.goods_no = o2.goods_no
            AND (
              n2k.def02 = o2.def02
              OR (n2k.def02 IS NULL AND o2.def02 IS NULL)
            )
            AND n2k.pur_id = o2.sheet_id
            AND n2k.made_lot LIKE ?
        )
      )
    ),
    -- Tạm nhập khớp đúng dòng PO.
    candidate_notice AS (
    SELECT
      n2.id AS notice_id,
      p.po_id AS po_id,
      n2.pur_no AS pur_no,
      n2.goods_no AS goods_no,
      n2.made_lot AS made_lot,
      n2.sheet_qty AS sheet_qty,
      n2.def02 AS def02,
      n2.unit_no AS unit_no,

      n1.create_date AS create_date
    FROM candidate_po p
    JOIN pur_notice2 n2
      ON n2.pur_no = p.po_number
     AND n2.goods_no = p.item_code
     AND n2.pur_id = p.sheet_id
     AND ((n2.def02 IS NULL AND p.def02 IS NULL) OR n2.def02 = p.def02)
    LEFT JOIN pur_notice1 n1 ON n1.sheet_no = n2.sheet_no
    ),
    -- Phiếu nhập của các PO đang xét.
    candidate_receipt AS (
    SELECT DISTINCT
      i2.pur_no AS pur_no,
      i2.goods_no AS goods_no,
      i2.made_lot AS made_lot,
      i2.pur_id AS pur_id,
      i2.sheet_no AS sheet_no
    FROM pur_in2 i2
    JOIN (SELECT DISTINCT po_number FROM candidate_po) p
      ON p.po_number = i2.pur_no
    ),
    noticed AS (
      SELECT po_id, SUM(sheet_qty) AS noticed_qty, MAX(create_date) AS latest_create
      FROM candidate_notice
      GROUP BY po_id
    ),
    gap AS (
      SELECT
        CAST(p.po_id AS VARCHAR(40)) AS id,
        p.po_id AS po_id,
        p.po_number AS po_number,
        p.item_code AS item_code,
        p.material AS material,
        p.supplier AS supplier,
        (p.sheet_qty - COALESCE(nc.noticed_qty, 0) - p.gap_assigned) AS qty,
        p.sheet_qty AS sheet_qty,
        p.unit AS unit,
        p.unit_price AS unit_price,
        CASE WHEN p.check_sta = 'Y' THEN 1 ELSE 0 END AS confirmed,
        p.del_date AS eta,
        CASE WHEN EXISTS (
          SELECT 1 FROM candidate_receipt pi
          WHERE pi.pur_no = p.po_number AND pi.goods_no = p.item_code
            AND pi.pur_id = p.sheet_id
        ) THEN 1 ELSE 0 END AS arrived,
        (SELECT MAX(pi2.sheet_no) FROM candidate_receipt pi2
          WHERE pi2.pur_no = p.po_number AND pi2.goods_no = p.item_code
            AND pi2.pur_id = p.sheet_id)
            AS grn_ref,
        -- Business lot lấy từ dòng tạm nhập.
        CAST(NULL AS VARCHAR(40)) AS lot_no,
        p.assigned_total AS assigned_qty,
        p.del_date AS del_date,
        p.po_id AS po_sort,
        0 AS lot_sort
      FROM candidate_po p
      LEFT JOIN noticed nc ON nc.po_id = p.po_id
      -- Dòng PO chờ giao còn hiện trong cửa sổ tạm nhập 24 giờ.
      WHERE (
        nc.po_id IS NULL
        OR nc.latest_create IS NULL
        OR nc.latest_create >= DATEADD(HOUR, -24, GETDATE())
      )
      -- Lượng tạm nhập quyết định còn dòng chờ giao để hiển thị hay không.
      AND (p.sheet_qty - COALESCE(nc.noticed_qty, 0)) > 0
    ),
    notice_branch AS (
      SELECT
        CONCAT(x.po_id, '-N', x.notice_id) AS id,
        x.po_id AS po_id,
        p2.po_number AS po_number,
        p2.item_code AS item_code,
        p2.material AS material,
        p2.supplier AS supplier,
        x.sheet_qty AS qty,
        p2.sheet_qty AS sheet_qty,
        x.unit_no AS unit,
        p2.unit_price AS unit_price,
        CASE WHEN p2.check_sta = 'Y' THEN 1 ELSE 0 END AS confirmed,
        p2.del_date AS eta,
        1 AS arrived,
        CAST(NULL AS VARCHAR(20)) AS grn_ref,
        x.made_lot AS lot_no,
        p2.assigned_total AS assigned_qty,
        p2.del_date AS del_date,
        x.po_id AS po_sort,
        x.notice_id AS lot_sort
      FROM (
        SELECT
          n.notice_id,
          n.po_id,
          n.pur_no,
          n.goods_no,
          n.made_lot,
          n.sheet_qty,
          n.unit_no,
          n.create_date,
          ROW_NUMBER() OVER (
            PARTITION BY n.notice_id ORDER BY n.po_id ASC
          ) AS rn
        FROM candidate_notice n
      ) x
      JOIN candidate_po p2 ON p2.po_id = x.po_id
      WHERE x.rn = 1
        AND (x.create_date IS NULL
             OR x.create_date >= DATEADD(HOUR, -24, GETDATE()))
        AND NOT EXISTS (
          SELECT 1 FROM candidate_receipt pi
          WHERE pi.pur_no = x.pur_no
            AND pi.goods_no = x.goods_no
            AND pi.made_lot = x.made_lot
        )
    ),
    eligible AS (
      SELECT * FROM gap
      UNION ALL
      SELECT * FROM notice_branch
    )
`;

const PO_SEARCH_KEYWORD_SQL = `
    (
      CAST(? AS NVARCHAR(140)) IS NULL
      OR u.po_number LIKE ?
      OR u.item_code LIKE ?
      OR u.lot_no LIKE ?
      OR u.material LIKE ?
      OR u.supplier LIKE ?
    )
`;

function poCandidateParams(sp) {
  return [
    sp.keeperEmpNo, sp.keeperEmpNo,
    sp.bucket, sp.bucket, sp.today, sp.bucket, sp.twoMonthsAgoStart,
    sp.bucket, sp.twoMonthsAgoStart, sp.prevMonthStart,
    sp.bucket, sp.prevMonthStart, sp.today,
    sp.bucket, sp.today, sp.next3End,
    sp.bucket, sp.next3End, sp.next7End,
    ...poSearchKeywordParams(sp), sp.prefixPattern,
  ];
}

function poSearchKeywordParams({ prefixPattern, containsPattern }) {
  return [prefixPattern, prefixPattern, prefixPattern, prefixPattern, containsPattern, containsPattern];
}

class PoModel {
  // GET /api/warehouse/incoming-pos (không phân trang).
  async list() {
    const { rows } = await db.query(toDialect(`
      ${INCOMING_PO_SELECT}
      ORDER BY o1.close_sw, o2.del_date, o2.id;
    `));
    return rows;
  }

  // GET /api/warehouse/incoming-pos — trang và tổng số dòng.
  async listPaged(page, pageSize) {
    const result = await pagination({
      query: toDialect(INCOMING_PO_SELECT),
      orderBy: toDialect('[eta], [id]'),
      page,
      pageSize,
    });
    return { rows: result.data, total: result.pagination.totalItems };
  }

  /**
   * Tìm dòng PO theo po_id (= pur_order2.id).
   * @param {number|string} poId po_id = pur_order2.id
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async byId(poId) {
    const sql = `
    -- DECLARE @confirmedFlag CHAR(1) = 'Y';
    -- DECLARE @poId INT = 3;
    SELECT
      CAST(o2.id AS VARCHAR(20)) AS [id],
      o1.sheet_no AS [poNumber],
      CAST(o2.id AS VARCHAR(20)) AS [poLine],
      o2.goods_no AS [itemCode],
      g.goods_name AS [material],
      o1.su_name11 AS [supplier],
      CAST(o2.sheet_qty AS FLOAT) AS [qty],
      o2.unit_no AS [unit],
      CAST(o2.sheet_pri AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN o1.check_sta = ? THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      o2.del_date AS [eta],
      CAST(CASE WHEN EXISTS (
        SELECT 1 FROM pur_in2 i2
        WHERE i2.pur_no = o1.sheet_no AND i2.pur_id = o2.sheet_id
          AND i2.goods_no = o2.goods_no
      ) THEN 1 ELSE 0 END AS BIT) AS [arrived],
      (SELECT MAX(i2g.sheet_no) FROM pur_in2 i2g
        WHERE i2g.pur_no = o1.sheet_no AND i2g.pur_id = o2.sheet_id
          AND i2g.goods_no = o2.goods_no) AS [grnRef],
      -- lotNo (2026-10-29): KHÔNG expose pur_order2.made_lot — giữ NULL.
      CAST(NULL AS VARCHAR(40)) AS [lotNo],
      CAST((SELECT COALESCE(SUM(x.allocated_qty), 0)
            FROM whs_slot_allocation x
            WHERE x.po_id = o2.id) AS FLOAT) AS [assignedQty],
      CAST(CASE WHEN o1.close_sw = 'Y' THEN 1 ELSE 0 END AS BIT) AS [closed],
      o1.sheet_date AS [sheetDate],
      o2.del_date AS [delDate],
      'mock' AS [source]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN bas_goods g ON g.goods_no = o2.goods_no
    WHERE o2.id = ?;
  `;
    const params = ['Y', poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * 1 dòng PO đầy đủ từ order2 + order1 (join theo sheet_no ĐÃ XÁC NHẬN).
   * @param {string} poId po_id = pur_order2.id
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async findOrder2ByPoId(poId) {
    const sql = `
    -- DECLARE @poId INT = 3;
    SELECT o2.id AS [id],
           o2.sheet_id AS [sheetId],
           o1.sheet_no AS [poNumber],
           o2.goods_no AS [goodsNo],
           o2.unit_no AS [unitNo],
           CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
           o2.made_lot AS [madeLot],
           o2.del_date AS [delDate],
           o1.su_name11 AS [suName11],
           o1.su_no AS [suNo]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE o2.id = ?;
  `;
    const params = [poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows[0] || null;
  }

  /**
   * Notice khớp 1 dòng PO theo KEY FINAL [R2]: pur_no + goods_no + def02
   * + pur_id = sheet_id (PO identity fix 2026-10-29 — 1 PO nhiều dòng cùng
   * goods/def02 phải tách bằng pur_id; 2026-10-28 user duyệt bỏ điều kiện
   * ngày def23/del_date; KHÔNG dùng sheet_lot).
   * Shape = mapNotice2Row (camelCase).
   * @param {string} poId po_id = pur_order2.id
   * @param {number[]} [noticeIds] HINT candidate IDs (sweep đã có sẵn —
   *   job chỉ re-read đúng các ID này thay vì re-run full PO/date search;
   *   relation [R2] vẫn được ép đầy đủ trong SQL nên ID sai范围 tự loại).
   *   Bỏ trống/rỗng → full query như cũ. KHÔNG được dùng hint làm con số
   *   quyết định ghi receipt — service vẫn tính FRESH trong tx.
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findNoticesForPoLine(poId, noticeIds) {
    const idFilter =
      Array.isArray(noticeIds) && noticeIds.length > 0
        ? `AND n2.id IN (${noticeIds.map(() => '?').join(', ')})`
        : '';
    const sql = `
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
      n2.sheet_lot AS [sheetLot],
      -- Giờ tạm nhập của notice (từ header notice1) — dùng cho DTO
      -- candidates AMBIGUOUS (spec #15 createdAt), KHÔNG dùng làm matching key.
      n1.create_date AS [createdAt]
    FROM pur_notice2 n2
    JOIN pur_order2 o2 ON o2.id = ?
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    LEFT JOIN pur_notice1 n1 ON n1.sheet_no = n2.sheet_no
    WHERE n2.pur_no = o1.sheet_no
      AND n2.goods_no = o2.goods_no
      AND ((n2.def02 IS NULL AND o2.def02 IS NULL) OR n2.def02 = o2.def02)
      -- PO identity fix 2026-10-29: pur_id trỏ về DÒNG PO (sheet_id) —
      -- notice của dòng khác (cùng PO + goods + def02) KHÔNG match ở đây.
      AND n2.pur_id = o2.sheet_id
      ${idFilter}
    ORDER BY n2.id;
  `;
    const params = [poId];
    if (idFilter) {
      for (const nid of noticeIds) {
        const value = Number(nid);
        if (!Number.isFinite(value)) {
          throw new Error(
            '[po.repository] findNoticesForPoLine: noticeIds chứa ID không hợp lệ'
          );
        }
        params.push(value);
      }
    }
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * BATCH SET-BASED của findOrder2ByPoId (#11/#46 — sweep phân loại cả
   * lượt candidate bằng 1 câu thay vì N câu theo từng allocation):
   * po_id chính là candidate key từ WHS pending — KHÔNG scan toàn
   * pur_order2 (#12). Shape giống findOrder2ByPoId; caller tự map
   * theo id.
   * @param {number[]} poIds danh sách pur_order2.id (rỗng → [])
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findOrder2ByPoIds(poIds) {
    if (!Array.isArray(poIds) || poIds.length === 0) return [];
    const placeholders = poIds.map(() => '?').join(', ');
    const sql = `
    -- DECLARE @poIds TABLE (id INT);
    SELECT o2.id AS [id],
           o2.sheet_id AS [sheetId],
           o1.sheet_no AS [poNumber],
           o2.goods_no AS [goodsNo],
           o2.unit_no AS [unitNo],
           CAST(o2.sheet_qty AS FLOAT) AS [sheetQty],
           o2.made_lot AS [madeLot],
           o2.del_date AS [delDate],
           o1.su_name11 AS [suName11],
           o1.su_no AS [suNo]
    FROM pur_order2 o2
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE o2.id IN (${placeholders});
  `;
    const params = poIds.slice();
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * BATCH SET-BASED của findNoticesForPoLine (#11/#46): candidate-first
   * — JOIN o2 theo candidate po_ids rồi áp cùng relation [R2] (KHÔNG đổi
   * matching rule, KHÔNG GROUP toàn pur_notice2 #12, KHÔNG dùng
   * n2.pur_id = o2.id). Mỗi dòng kèm [poId] để caller group theo PO
   * trong service. ORDER BY o2.id, n2.id.
   * @param {number[]} poIds danh sách pur_order2.id (rỗng → [])
   * @returns {Promise<Array<Record<string, unknown> & { poId: number }>>}
   */
  async findNoticesForPoDetails(poIds) {
    if (!Array.isArray(poIds) || poIds.length === 0) return [];
    const placeholders = poIds.map(() => '?').join(', ');
    const sql = `
    -- DECLARE @poIds TABLE (id INT);
    SELECT
      o2.id AS [poId],
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
    JOIN pur_order2 o2 ON o2.id IN (${placeholders})
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE n2.pur_no = o1.sheet_no
      AND n2.goods_no = o2.goods_no
      AND ((n2.def02 IS NULL AND o2.def02 IS NULL) OR n2.def02 = o2.def02)
      -- PO identity fix 2026-10-29: pur_id = sheet_id (đúng dòng PO)
      AND n2.pur_id = o2.sheet_id
    ORDER BY o2.id, n2.id;
  `;
    const params = poIds.slice();
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Notice "mồ côi" theo key [R2] 3 trường cũ (pur_no + goods_no + def02)
   * nhưng pur_id NULL hoặc KHÔNG trỏ về dòng nào của chính PO đó
   * (PO identity fix 2026-10-29 — dữ liệu legacy thiếu/ sai pur_id).
   * Các notice này KHÔNG được dùng để sync receipt; worker dùng danh sách
   * này để mở issue DATA_ERROR (type VARCHAR(20) — không cần DDL).
   * Shape tối thiểu: id, sheetNo, purNo, purId, goodsNo, sheetQty, madeLot.
   * @param {string} poId po_id = pur_order2.id
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async findOrphanNoticesForPoLine(poId) {
    const sql = `
    -- DECLARE @poId INT = 3;
    SELECT
      n2.id AS [id],
      n2.sheet_id AS [sheetId],
      n2.sheet_no AS [sheetNo],
      n2.pur_no AS [purNo],
      n2.pur_id AS [purId],
      n2.goods_no AS [goodsNo],
      CAST(n2.sheet_qty AS FLOAT) AS [sheetQty],
      n2.made_lot AS [madeLot]
    FROM pur_notice2 n2
    JOIN pur_order2 o2 ON o2.id = ?
    JOIN pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    WHERE n2.pur_no = o1.sheet_no
      AND n2.goods_no = o2.goods_no
      AND ((n2.def02 IS NULL AND o2.def02 IS NULL) OR n2.def02 = o2.def02)
      -- Mồ côi: pur_id trống hoặc không trỏ về dòng nào của PO này
      AND (
        n2.pur_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM pur_order2 o2x
          WHERE o2x.sheet_no = o1.sheet_no AND o2x.sheet_id = n2.pur_id
        )
      )
    ORDER BY n2.id;
  `;
    const params = [poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return rows;
  }

  /**
   * Tổng allocated_qty còn active (closed_at IS NULL) theo po_id.
   * @param {string} poId po_id = pur_order2.id
   * @returns {Promise<number>}
   */
  async sumAllocatedByPo(poId) {
    const sql = `
    -- DECLARE @poId INT = 3;
    SELECT COALESCE(SUM(allocated_qty), 0) AS [total]
    FROM whs_slot_allocation
    WHERE po_id = ? AND closed_at IS NULL;
  `;
    const params = [poId];
    guardParams(params);
    const { rows } = await db.query(toDialect(sql), params);
    return Number(rows[0] ? rows[0].total : 0);
  }

  // GET /api/warehouse/pos — danh sách và tổng số dòng khớp bộ lọc.
  async searchPurchases(opts) {
    const sp = searchParams(opts);
    const filterParams = [...poCandidateParams(sp), ...poSearchKeywordParams(sp)];
    const result = await pagination({
      query: toDialect(`
    SELECT
      u.id AS [id],
      CAST(u.po_id AS VARCHAR(20)) AS [poLine],
      u.po_number AS [poNumber],
      u.item_code AS [itemCode],
      u.material AS [material],
      u.supplier AS [supplier],
      CAST(u.qty AS FLOAT) AS [qty],
      CAST(u.sheet_qty AS FLOAT) AS [sheetQty],
      u.unit AS [unit],
      CAST(u.unit_price AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN u.confirmed = 1 THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      u.eta AS [eta],
      CAST(CASE WHEN u.arrived = 1 THEN 1 ELSE 0 END AS BIT) AS [arrived],
      u.grn_ref AS [grnRef],
      u.lot_no AS [lotNo],
      CAST(u.assigned_qty AS FLOAT) AS [assignedQty],
      u.po_sort AS [poSort],
      u.lot_sort AS [lotSort]
    FROM eligible u
    WHERE ${PO_SEARCH_KEYWORD_SQL}
      `),
      withSql: toDialect(PO_SEARCH_ELIGIBLE_SQL),
      distinctBy: 'poNumber',
      params: filterParams,
      page: opts.page,
      pageSize: opts.pageSize,
      orderBy: toDialect('[eta], [poSort], [lotSort]'),
    });
    return { rows: result.data, total: result.pagination.totalItems, poTotal: result.pagination.totalDistinct };
  }

  /**
   * GET /api/warehouse/pos?counts=1 — đếm mã PO duy nhất theo từng nhóm ETA.
   * Giữ bộ lọc từ khóa và quyền thủ kho để đếm các tab trong cùng request.
   */
  async countPurchaseBuckets(opts) {
    const sp = searchParams({ ...opts, bucket: null });
    const sqlBuckets = `
    ${PO_SEARCH_ELIGIBLE_SQL},
    bucketed AS (
      SELECT
        u.po_number,
        CASE
          WHEN u.del_date IS NULL OR u.del_date < ? THEN 'od3p'
          WHEN u.del_date >= ? AND u.del_date < ? THEN 'od2'
          WHEN u.del_date >= ? AND u.del_date < ? THEN 'od1'
          WHEN u.del_date >= ? AND u.del_date < ? THEN 'next3'
          WHEN u.del_date >= ? AND u.del_date < ? THEN 'next7'
          ELSE NULL
        END AS bucket
      FROM eligible u
      WHERE ${PO_SEARCH_KEYWORD_SQL}
    )
    SELECT bucket AS [bucket], COUNT(DISTINCT po_number) AS [n]
    FROM bucketed WHERE bucket IS NOT NULL
    GROUP BY bucket
    UNION ALL
    SELECT 'overdue', COUNT(DISTINCT po_number)
    FROM bucketed WHERE bucket IN ('od1', 'od2', 'od3p');
  `;
    const params = [
      ...poCandidateParams(sp),
      sp.twoMonthsAgoStart,
      sp.twoMonthsAgoStart, sp.prevMonthStart,
      sp.prevMonthStart, sp.today,
      sp.today, sp.next3End,
      sp.next3End, sp.next7End,
      ...poSearchKeywordParams(sp),
    ];
    const { rows } = await db.query(toDialect(sqlBuckets), params);
    return rows;
  }

}

module.exports = new PoModel();
module.exports.PoModel = PoModel;
