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
    // 5 mốc bucket mới (2026-10-20) — date-only YYYY-MM-DD từ service
    today: opts.today ?? null,
    prevMonthStart: opts.prevMonthStart ?? null,
    twoMonthsAgoStart: opts.twoMonthsAgoStart ?? null,
    next3End: opts.next3End ?? null,
    next7End: opts.next7End ?? null,
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
    const source = `
    SELECT
      o1.close_sw, o1.rem, n.sheet_no, n.adj_result, o1.check_date as po_date,
      o.sheet_no as po_no, o.sheet_id as po_id, o.goods_no as mat_no,
      g.goods_name as mat_name, gt.goods_type as mat_type, gt.goods_type_desc as mat_type_desc,
      p.req_date AS pmc_date, datediff(day, p.req_date, n1.sheet_date) as gap_pmc_day,
      o.sheet_qty as po_qty, n.sheet_qty as temp_rcv_qty, n.sheet_qty1 as temp_foc_qty,
      n1.sheet_date as temp_rcv_date, o.del_date as su_reply_date,
      datediff(day, o.del_date, isnull(n1.sheet_date, getdate())) as late_date,
      n.return_qty as fail_qty, n.return_qty1 as fail_foc_qty,
      n.return_qty + n.return_qty1 as total_fail_qty,
      case when n.sheet_qty > 0 then (n.return_qty/ n.sheet_qty) * 100 else 0 end as r_fail_qty,
      case when n.sheet_qty1 > 0 then (n.return_qty/ n.sheet_qty1) * 100 else 0 end as r_fail_foc_qty,
      case when (n.sheet_qty + n.sheet_qty) > 0 then ((n.return_qty + n.return_qty1)/ (n.sheet_qty + n.sheet_qty1)) * 100 else 0 end as r_total_fail_qty,
      case when i.sheet_no is not null and i.sheet_sta = 1 then 'IN_STOCK' -- Đã nhập kho chính thức
           when i.sheet_no is not null and i.sheet_sta <> 1 then 'SEND_STOCK' -- Đã gửi yêu cầu nhập kho
           when n.sheet_no is not null and n.sheet_sta1 = 1 then 'WAITING_STOCK' -- Đã kiểm IQC
           when n.sheet_no is not null and n.sheet_sta1 <> 1 then 'WAITING_IQC' -- Chờ kiểm IQC
           --when n.sheet_no is null then 'NOT_ARRIVED' -- Hàng chưa về nhà máy
           when datediff(day, o.del_date, getdate()) > 0 then 'OVERDUE' -- Lô hàng trễ hẹn
           when datediff(day, o.del_date, getdate()) between -3 and -1 then 'DUE_SOON' -- Dự kiến sắp về
           when datediff(day, o.del_date, getdate()) = 0 then 'DUE_TODAY' -- Dự kiến về hôm nay
           else 'NOT_YET_DUE' end as status_po, -- Chưa đến ngày giao
      CASE WHEN n.id IS NULL THEN CAST(o.id AS VARCHAR(40)) ELSE CONCAT(o.id, '-N', n.id) END AS [id],
      CAST(o.id AS VARCHAR(20)) AS [poLine],
      o.sheet_no AS [poNumber],
      o.goods_no AS [itemCode],
      g.goods_name AS [material],
      o1.su_name11 AS [supplier],
      CAST(COALESCE(n.sheet_qty, o.sheet_qty - COALESCE((SELECT SUM(a.allocated_qty) FROM whs_slot_allocation AS a WHERE a.po_id = o.id), 0)) AS FLOAT) AS [qty],
      CAST(o.sheet_qty AS FLOAT) AS [sheetQty],
      COALESCE(n.unit_no, o.unit_no) AS [unit],
      CAST(o.sheet_pri AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN o1.check_sta = 'Y' THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      o.del_date AS [eta],
      CAST(CASE WHEN (n.id IS NOT NULL OR i.sheet_no IS NOT NULL) THEN 1 ELSE 0 END AS BIT) AS [arrived],
      i.sheet_no AS [grnRef],
      n.made_lot AS [lotNo],
      CAST(COALESCE((SELECT SUM(a.allocated_qty) FROM whs_slot_allocation AS a WHERE a.po_id = o.id), 0) AS FLOAT) AS [assignedQty],
      o.id AS [poSort],
      COALESCE(n.id, 0) AS [lotSort]
    from pur_order2 o with (nolock)
    inner join pur_order1 o1 with(nolock) on o.sheet_no = o1.sheet_no
    inner join bas_goods g with(nolock) on g.goods_no = o.goods_no
    inner join bas_goods_type gt with(nolock) on gt.goods_type = g.goods_type
    left join pur_notice2 n with(nolock) on n.pur_no = o.sheet_no and n.pur_id = o.sheet_id
    left join pur_notice1 n1 with(nolock) on n1.sheet_no = n.sheet_no
    left join pur_in2 i with(nolock) on i.notice_no = n.sheet_no and i.notice_id = n.sheet_id
    left join pur_in1 i1 with(nolock) on i.sheet_no = i1.sheet_no
    left join pur_plan2 p with(nolock) on p.sheet_no = o.plan_no and p.sheet_id = o.plan_id 
    left join pur_plan1 p1 with(nolock) on p1.sheet_no = p.sheet_no
    where o.close_sw = 0
      and o.sheet_sta = 1 and (n.adj_result <> 2 or n.adj_result is null)
      and o1.close_sw = 0 and o.st_no=101 and  p.close_sw = 0 and p1.close_sw = 0 
      and datediff(day, o.del_date, getdate()) between -30 and 30 and left (o.goods_no, 1) <> 'N'
      AND NOT EXISTS (
        SELECT 1
        FROM whs_slot_allocation AS a
        WHERE a.po_id = o.id
          AND a.goods_no = o.goods_no
          AND a.closed_at IS NULL
      )
    order by mat_no
    `;
    // Tìm theo từ khóa trên tập PO đủ điều kiện cố định.
    const query = `
    SELECT p.* FROM (${source}) AS p
    WHERE (
        CAST(? AS NVARCHAR(140)) IS NULL
        OR p.[poNumber] LIKE ?
        OR p.[itemCode] LIKE ?
        OR p.[lotNo] LIKE ?
        OR p.[material] LIKE ?
        OR p.[supplier] LIKE ?
      )
    `;
    const params = [
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
   * Giữ bộ lọc từ khóa khi đếm theo nhóm ngày dự kiến.
   */
  async countPurchaseBuckets(opts) {
    const sp = searchParams(opts);
    const source = this.purchaseQuery(opts);
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

  // danh sách đếm đơn PO theo trạng thái
  async CountPoByStatus() {
    const { rows } = await db.query(`
        ;WITH PO_Base AS
        (
            SELECT 
                o.id AS po_line_id, o.sheet_no,o.sheet_id, o.goods_no,o.del_date,n.sheet_no AS notice_no,n.sheet_sta1, i.sheet_no AS receipt_no,i.sheet_sta
            FROM pur_order2 o WITH (NOLOCK)
            INNER JOIN pur_order1 o1 WITH (NOLOCK) ON o.sheet_no = o1.sheet_no
            INNER JOIN bas_goods g WITH (NOLOCK)   ON g.goods_no = o.goods_no
            INNER JOIN bas_goods_type gt WITH (NOLOCK) ON gt.goods_type = g.goods_type
            LEFT JOIN pur_notice2 n WITH (NOLOCK) ON n.pur_no = o.sheet_no AND n.pur_id = o.sheet_id
            LEFT JOIN pur_in2 i WITH (NOLOCK)  ON i.notice_no = n.sheet_no  AND i.notice_id = n.sheet_id
            LEFT JOIN pur_plan2 pp WITH (NOLOCK) ON pp.sheet_no = o.plan_no  AND pp.sheet_id = o.plan_id
            LEFT JOIN pur_plan1 pp1 WITH (NOLOCK)  ON pp1.sheet_no = pp.sheet_no
            WHERE o.close_sw = 0 AND o.sheet_sta = 1 AND (n.adj_result <> 2 OR n.adj_result IS NULL)  AND o1.close_sw = 0 AND o.st_no = 101 AND pp.close_sw = 0
                AND pp1.close_sw = 0  AND DATEDIFF(DAY, o.del_date, GETDATE()) BETWEEN -30 AND 30 AND LEFT(o.goods_no, 1) <> 'N'
        )
        SELECT
            COUNT(DISTINCT CASE WHEN receipt_no IS NOT NULL AND sheet_sta = 1 THEN sheet_no END) AS [Đã nhập kho chính thức],
            COUNT(DISTINCT CASE WHEN receipt_no IS NOT NULL AND sheet_sta <> 1 THEN sheet_no END) AS [Đã gửi yêu cầu nhập kho],
            COUNT(DISTINCT CASE WHEN notice_no IS NOT NULL AND sheet_sta1 = 1 THEN sheet_no END) AS [Đã kiểm IQC],
            COUNT(DISTINCT CASE WHEN notice_no IS NOT NULL AND sheet_sta1 <> 1 THEN sheet_no END) AS [Đang đợi kiểm IQC],
            COUNT(DISTINCT CASE WHEN notice_no IS NULL THEN sheet_no END) AS [Hàng chưa về],
            COUNT(DISTINCT CASE WHEN notice_no IS NULL AND DATEDIFF(DAY, del_date, GETDATE()) > 0 THEN sheet_no END) AS [Lô hàng trễ hẹn],
            COUNT(DISTINCT CASE WHEN notice_no IS NULL AND DATEDIFF(DAY, del_date, GETDATE()) BETWEEN -3 AND -1 THEN sheet_no END) AS [Lô hàng dự kiến sắp về],
            COUNT(DISTINCT CASE WHEN notice_no IS NULL  AND DATEDIFF(DAY, del_date, GETDATE()) = 0 THEN sheet_no END) AS [Lô hàng dự kiến về hôm nay],
            COUNT(DISTINCT CASE  WHEN notice_no IS NULL  AND DATEDIFF(DAY, del_date, GETDATE()) < -3 THEN sheet_no END) AS [Lô hàng chưa giao]

        FROM PO_Base;
    `);
    return rows;
  }
  // nhà cung cấp giao chậm thiếu
  async supplierLate() {
    const { rows } = await db.query(`
      ;WITH base AS (
      SELECT  o.id AS po_line_id,o.sheet_no AS po_no, o.goods_no AS mat_no, g.goods_name AS mat_name, o1.su_name11 AS supplier,  o.sheet_qty AS po_qty, o.del_date AS su_reply_date,
              ISNULL(n.sheet_qty, 0) + ISNULL(n.sheet_qty1, 0) AS rcv_qty
      FROM pur_order2 o WITH (NOLOCK)
      INNER JOIN pur_order1 o1 WITH (NOLOCK) ON o.sheet_no = o1.sheet_no
      INNER JOIN bas_goods g WITH (NOLOCK) ON g.goods_no = o.goods_no
      INNER JOIN bas_goods_type gt WITH (NOLOCK) ON gt.goods_type = g.goods_type
      LEFT JOIN pur_notice2 n WITH (NOLOCK) ON n.pur_no = o.sheet_no AND n.pur_id = o.sheet_id
      LEFT JOIN pur_notice1 n1 WITH (NOLOCK) ON n1.sheet_no = n.sheet_no
      LEFT JOIN pur_in2 i WITH (NOLOCK) ON i.notice_no = n.sheet_no AND i.notice_id = n.sheet_id
      LEFT JOIN pur_in1 i1 WITH (NOLOCK) ON i.sheet_no = i1.sheet_no
      LEFT JOIN pur_plan2 p WITH (NOLOCK) ON p.sheet_no = o.plan_no AND p.sheet_id = o.plan_id
      LEFT JOIN pur_plan1 p1 WITH (NOLOCK) ON p1.sheet_no = p.sheet_no
      WHERE o.close_sw = 0
        AND o.sheet_sta = 1 AND (n.adj_result <> 2 OR n.adj_result IS NULL)
        AND o1.close_sw = 0 AND o.st_no = 101 AND p.close_sw = 0 AND p1.close_sw = 0
        AND DATEDIFF(DAY, o.del_date, GETDATE()) BETWEEN -30 AND 30
        AND LEFT(o.goods_no, 1) <> 'N'
  ),
  late_line AS (   -- gộp theo dòng PO để cộng dồn các đợt nhận
      SELECT po_line_id, po_no, supplier, mat_no, mat_name, po_qty, su_reply_date,  SUM(rcv_qty) AS rcv_qty
      FROM base
      GROUP BY po_line_id, po_no, supplier, mat_no, mat_name, po_qty, su_reply_date
      HAVING su_reply_date < CAST(GETDATE() AS date)   -- đã quá hạn
        AND SUM(rcv_qty) < po_qty                     -- chưa về đủ
  )
  SELECT TOP 10
        po_no, MAX(supplier) AS supplier_name,
        MAX(DATEDIFF(DAY, su_reply_date, GETDATE())) AS late_days,                 -- badge "Chậm X ngày" 
        STRING_AGG(CAST(mat_name AS nvarchar(max)), N' · ')
              WITHIN GROUP (ORDER BY mat_no) AS materials                           -- dòng mô tả vật tư
  FROM late_line
  GROUP BY po_no
  ORDER BY late_days DESC, po_no;
      `)
    return rows
  }
}

module.exports = new PoModel();
module.exports.PoModel = PoModel;
