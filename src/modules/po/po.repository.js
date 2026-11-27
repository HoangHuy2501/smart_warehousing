// SQL cho danh sách PO, tra dòng PO và đối chiếu phiếu tạm nhập.
const db = require('../../config/db');
const pagination = require('../../util/pagination');
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

class PoModel {
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
    const { rows } = await db.query(sql, params);
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
    const { rows } = await db.query(sql, params);
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
    const { rows } = await db.query(sql, params);
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
    const { rows } = await db.query(sql, params);
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
    const { rows } = await db.query(sql, params);
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
    const { rows } = await db.query(sql, params);
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
    const { rows } = await db.query(sql, params);
    return Number(rows[0] ? rows[0].total : 0);
  }

  // GET /api/warehouse/pos — SQL chung cho danh sách và số đếm.
  purchaseQuery(opts) {
    const sp = searchParams(opts);
    const query = `
    SELECT
      CASE WHEN n.id IS NULL THEN CAST(o.id AS VARCHAR(40)) ELSE CONCAT(o.id, '-N', n.id) END AS [id],
      CAST(o.id AS VARCHAR(20)) AS [poLine],
      o.sheet_no AS [poNumber],
      o.goods_no AS [itemCode],
      g.goods_name AS [material],
      o1.su_name11 AS [supplier],
      CAST(COALESCE(n.sheet_qty, o.sheet_qty - COALESCE(allocation.assigned_qty, 0)) AS FLOAT) AS [qty],
      CAST(o.sheet_qty AS FLOAT) AS [sheetQty],
      COALESCE(n.unit_no, o.unit_no) AS [unit],
      CAST(o.sheet_pri AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN o1.check_sta = 'Y' THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      o.del_date AS [eta],
      CAST(CASE WHEN (n.id IS NOT NULL OR receipt.grn_ref IS NOT NULL) THEN 1 ELSE 0 END AS BIT) AS [arrived],
      receipt.grn_ref AS [grnRef],
      n.made_lot AS [lotNo],
      CAST(COALESCE(allocation.assigned_qty, 0) AS FLOAT) AS [assignedQty],
      o.id AS [poSort],
      COALESCE(n.id, 0) AS [lotSort],
      o1.check_date AS [po_date],
      o.sheet_no AS [po_no],
      o.sheet_id AS [po_id],
      o.goods_no AS [mat_no],
      g.goods_name AS [mat_name],
      CAST(o.sheet_qty AS FLOAT) AS [po_qty],
      CAST(n.sheet_qty AS FLOAT) AS [temp_rcv_qty],
      CAST(n.sheet_qty1 AS FLOAT) AS [temp_foc_qty],
      n1.sheet_date AS [temp_rcv_date],
      o.del_date AS [su_reply_date],
      CASE WHEN receipt.approved = 1 THEN NULL ELSE eta.days_late END AS [late_date],
      CAST(n.return_qty AS FLOAT) AS [fail_qty],
      CAST(n.return_qty1 AS FLOAT) AS [fail_foc_qty],
      CAST(failure.total_qty AS FLOAT) AS [total_fail_qty],
      CAST(n.return_qty * 100.0 / NULLIF(n.sheet_qty, 0) AS FLOAT) AS [r_fail_qty],
      CAST(n.return_qty1 * 100.0 / NULLIF(n.sheet_qty1, 0) AS FLOAT) AS [r_fail_foc_qty],
      CAST(failure.total_qty * 100.0 / NULLIF(
        COALESCE(n.sheet_qty, 0) + COALESCE(n.sheet_qty1, 0), 0
      ) AS FLOAT) AS [r_total_fail_qty],
      CASE
        WHEN receipt.approved = 1 THEN N'IN_STOCK'
        WHEN receipt.approved = 0 THEN N'SEND_STOCK'
        WHEN n.sheet_sta1 = '1' and (v.adj_result = '1' or v.adj_result = '3')  THEN N'WAITING_STOCK'
        WHEN n.sheet_sta1 = '1' and v.adj_result = '2'  THEN N'RETURNED'
        WHEN n.id IS NOT NULL THEN N'WAITING_IQC'
        WHEN eta.days_late > 0 THEN N'Lô hàng trễ hẹn'
        WHEN eta.days_late BETWEEN -3 AND -1 THEN N'Lô hàng dự kiến sắp về'
        WHEN eta.days_late = 0 THEN N'Lô hàng dự kiến về hôm nay'
        ELSE N'Lô hàng chưa giao'
      END AS [status_po]
    FROM pur_order2 o
    JOIN pur_order1 o1 ON o1.sheet_no = o.sheet_no
    JOIN bas_goods g ON g.goods_no = o.goods_no
    JOIN sys_userpass u ON u.user_no = o1.create_user AND u.user_name <> 'ADM'
    LEFT JOIN pur_notice2 n ON n.pur_no = o.sheet_no
      AND n.pur_id = o.sheet_id
      AND n.goods_no = o.goods_no
      AND (n.def02 = o.def02 OR (n.def02 IS NULL AND o.def02 IS NULL))
    LEFT JOIN pur_notice1 n1 ON n1.sheet_no = n.sheet_no
    LEFT join v_pur_notice_detail v on v.sheet_no = n.sheet_no and v.made_lot=n.made_lot
    OUTER APPLY (
      -- Một dòng tạm nhập có thể có nhiều phiếu nhập.
      SELECT MAX(i.sheet_no) AS grn_ref,
        MAX(CASE WHEN i1.sheet_sta = '1' THEN 1 ELSE 0 END) AS approved
      FROM pur_in2 i
      JOIN pur_in1 i1 ON i1.sheet_no = i.sheet_no
      WHERE i.pur_no = o.sheet_no AND i.pur_id = o.sheet_id
        AND i.goods_no = o.goods_no
        AND (n.id IS NULL OR (i.notice_no = n.sheet_no AND i.notice_id = n.sheet_id))
    ) receipt
    OUTER APPLY (
      SELECT SUM(a.allocated_qty) AS assigned_qty
      FROM whs_slot_allocation a
      WHERE a.po_id = o.id
    ) allocation
    CROSS APPLY (
      SELECT DATEDIFF(DAY, o.del_date, GETDATE()) AS days_late
    ) eta
    CROSS APPLY (
      SELECT CASE WHEN n.return_qty IS NULL AND n.return_qty1 IS NULL THEN NULL
                  ELSE COALESCE(n.return_qty, 0) + COALESCE(n.return_qty1, 0) END AS total_qty
    ) failure
    WHERE o1.close_sw IN ('N', '0')
      AND o1.sheet_sta <> '0'
      AND (
        o.goods_no LIKE 'M1%' OR o.goods_no LIKE 'M2%'
        OR o.goods_no LIKE 'M3%' OR o.goods_no LIKE 'M4%'
        OR o.goods_no LIKE 'M5%' OR o.goods_no LIKE 'M6%'
        OR o.goods_no LIKE 'A2%'
      )
      AND (
        CAST(? AS NVARCHAR(20)) IS NULL
        OR EXISTS (
          SELECT 1 FROM whs_keeper_material_assignment ma
          WHERE ma.keeper_emp_no = ?
            AND ma.goods_no = o.goods_no
            AND ma.ended_at IS NULL
        )
      )
      AND NOT EXISTS (
          SELECT 1
          FROM whs_slot_allocation a
          WHERE a.po_id = o.id
            AND a.goods_no = o.goods_no
      )
      AND (
        CAST(? AS NVARCHAR(10)) IS NULL
        OR (? = 'overdue' AND (o.del_date IS NULL OR o.del_date < ?))
        OR (? = 'od3p' AND (o.del_date IS NULL OR o.del_date < ?))
        OR (? = 'od2' AND o.del_date >= ? AND o.del_date < ?)
        OR (? = 'od1' AND o.del_date >= ? AND o.del_date < ?)
        OR (? = 'next3' AND o.del_date >= ? AND o.del_date < ?)
        OR (? = 'next7' AND o.del_date >= ? AND o.del_date < ?)
      )
      AND (
        CAST(? AS NVARCHAR(140)) IS NULL
        OR o1.sheet_no LIKE ?
        OR o.goods_no LIKE ?
        OR n.made_lot LIKE ?
        OR g.goods_name LIKE ?
        OR o1.su_name11 LIKE ?
      )
    `;
    const params = [
      sp.keeperEmpNo, sp.keeperEmpNo,
      sp.bucket, sp.bucket, sp.today, sp.bucket, sp.twoMonthsAgoStart,
      sp.bucket, sp.twoMonthsAgoStart, sp.prevMonthStart,
      sp.bucket, sp.prevMonthStart, sp.today,
      sp.bucket, sp.today, sp.next3End, sp.bucket, sp.next3End, sp.next7End,
      sp.prefixPattern, sp.prefixPattern, sp.prefixPattern, sp.prefixPattern,
      sp.containsPattern, sp.containsPattern,
    ];
    return { query, params };
  }

  // Lấy trang PO và tổng số dòng, số mã PO theo cùng bộ lọc.
  async searchPurchases(opts) {
    const result = await pagination({
      ...this.purchaseQuery(opts),
      distinctBy: 'poNumber',
      parallel: true,
      page: opts.page,
      pageSize: opts.pageSize,
      orderBy: '[eta], [poSort], [lotSort]',
    });
    return { rows: result.data, total: result.pagination.totalItems, poTotal: result.pagination.totalDistinct };
  }

  /**
   * GET /api/warehouse/pos?counts=1 — đếm mã PO duy nhất theo từng nhóm ETA.
   * Giữ bộ lọc từ khóa và quyền thủ kho để đếm các tab trong cùng request.
   */
  async countPurchaseBuckets(opts) {
    const sp = searchParams({ ...opts, bucket: null });
    const source = this.purchaseQuery({ ...opts, bucket: null });
    const sqlBuckets = `
      WITH bucketed AS (
        SELECT p.[poNumber] AS po_number,
          CASE
            WHEN p.[eta] IS NULL OR p.[eta] < ? THEN 'od3p'
            WHEN p.[eta] >= ? AND p.[eta] < ? THEN 'od2'
            WHEN p.[eta] >= ? AND p.[eta] < ? THEN 'od1'
            WHEN p.[eta] >= ? AND p.[eta] < ? THEN 'next3'
            WHEN p.[eta] >= ? AND p.[eta] < ? THEN 'next7'
          END AS bucket
        FROM (${source.query}) p
      )
      SELECT bucket AS [bucket], COUNT(DISTINCT po_number) AS [n]
      FROM bucketed
      WHERE bucket IS NOT NULL
      GROUP BY bucket
      UNION ALL
      SELECT 'overdue', COUNT(DISTINCT po_number)
      FROM bucketed WHERE bucket IN ('od1', 'od2', 'od3p');
    `;
    const params = [
      sp.twoMonthsAgoStart,
      sp.twoMonthsAgoStart, sp.prevMonthStart,
      sp.prevMonthStart, sp.today,
      sp.today, sp.next3End,
      sp.next3End, sp.next7End,
      ...source.params,
    ];
    const { rows } = await db.query(sqlBuckets, params);
    return rows;
  }

}

module.exports = new PoModel();
module.exports.PoModel = PoModel;
