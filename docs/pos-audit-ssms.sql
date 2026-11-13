/* =============================================================================
   GET /pos AUDIT TREN SQL SERVER (T8) — sinh tu code 2026-10-19
   File     : smart_whs_v3/docs/pos-audit-ssms.sql
   Nguon    : src/repository/sql/queries/po.queries.js (fillPoTemp / fillNoticeTemp /
              fillPurInTemp / searchPurchasesFinal / countPurchaseBucketsFinal)
   Muc dich : do STATISTICS IO / TIME cua pipeline /pos SAU khi fix audit:
     1) close_sw IN ('N','0') loc ngay tai fillPoTemp
     2) bucket + keyword PUSH NGAY vao #PO (list hep) — truoc khi JOIN Notice/PurIn
     3) NULL del_date = od3p (thong nhat list + count)
     4) count bucket chay pipeline RONG (khong bucket) rieng list

   CACH CHAY:
   - Mo SSMS -> ket noi T8 production/test -> New Query
   - THAY TEN BANG neu DB that dung ten production (code dang dung ten t8_*):
       t8_bas_emp            -> bas_emp
       t8_bas_goods          -> bas_goods
       t8_pur_order1         -> pur_order1
       t8_pur_order2         -> pur_order2
       t8_pur_notice2        -> pur_notice2
       t8_pur_in1            -> pur_in1
       t8_pur_in2            -> pur_in2
     (whs_slot_allocation / whs_allocation_receipt giu nguyen)
     SSMS: Edit > Find & Replace (Ctrl+H), thay lan luot.
   - Chay tung SECTION rieng (khong chay ca file cung luc — bien trung ten):
       SECTION 1 = LIST theo bucket cu the (pipeline hep — truong hop chinh)
       SECTION 2 = COUNT bucket cards (pipeline rong)
       SECTION 3 = LIST KHONG bucket (base rong nhat — tham chieu)
   - Doc ket qua o tab Messages: 'Table ... Scan/Logical reads ...' va
     'SQL Server Execution Times / elapsed time'
   - Chu y: card bucket dem theo SO DON (COUNT DISTINCT po_number),
     list tra theo DONG (1 PO nhieu dong hang) — so sanh DISTINCT la dung.

   KHONG CO INDEX MOI / KHONG ALTER — script chi doc + tao #temp.
============================================================================= */
SET STATISTICS IO ON;
SET STATISTICS TIME ON;

/* ===================== SECTION 1 — LIST /pos THEO BUCKET (hep) ============
   Mo phong request: GET /pos?bucket=today&page=1&pageSize=50&counts=0
   Doi @bucket de do bucket khac: 'today' / 'upcoming' / 'od12' / 'od23' / 'od3p'
============================================================================= */
DECLARE @bucket NVARCHAR(10) = 'today';
DECLARE @prefixPattern NVARCHAR(140) = NULL;   -- doi thanh N'PO%' de test keyword
DECLARE @containsPattern NVARCHAR(160) = NULL;
DECLARE @offset INT = 0, @pageSize INT = 50;
DECLARE @windowStart DATETIME, @windowEnd DATETIME, @od12Start DATETIME, @od23Start DATETIME;
SET @windowStart = DATEADD(DAY, -10, CAST(CAST(GETDATE() AS date) AS datetime));
SET @windowEnd   = DATEADD(DAY,  11, CAST(CAST(GETDATE() AS date) AS datetime));
SET @od12Start   = DATEADD(DAY, -60, CAST(CAST(GETDATE() AS date) AS datetime));
SET @od23Start   = DATEADD(DAY, -90, CAST(CAST(GETDATE() AS date) AS datetime));

DROP TABLE IF EXISTS #PurIn, #Notice, #PO;

    CREATE TABLE #PO (
      po_id INT NOT NULL PRIMARY KEY,
      po_number NVARCHAR(20) NOT NULL,
      supplier NVARCHAR(100) NULL,
      sheet_date DATETIME NULL,
      check_sta CHAR(1) NULL,
      item_code NVARCHAR(30) NULL,
      material NVARCHAR(120) NULL,
      unit NVARCHAR(10) NULL,
      sheet_qty FLOAT NOT NULL,
      unit_price NUMERIC(18, 8) NULL,
      del_date DATETIME NULL,
      del_day DATE NULL,
      def02 NVARCHAR(50) NULL,
      made_lot NVARCHAR(30) NULL,
      unconf_qty FLOAT NOT NULL
    );
  

    -- DECLARE @bucket NVARCHAR(10) = NULL;
    -- DECLARE @windowStart DATETIME = '2026-10-09';
    -- DECLARE @windowEnd   DATETIME = '2026-10-30';
    -- DECLARE @od12Start  DATETIME = '2026-08-20';
    -- DECLARE @od23Start  DATETIME = '2026-07-21';
    -- DECLARE @prefixPattern NVARCHAR(140) = NULL;
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    INSERT INTO #PO (
      po_id, po_number, supplier, sheet_date, check_sta,
      item_code, material, unit, sheet_qty, unit_price,
      del_date, del_day, def02, made_lot, unconf_qty
    )
    SELECT
      o2.id,
      o1.sheet_no,
      o1.su_name11,
      o1.sheet_date,
      o1.check_sta,
      o2.goods_no,
      g.goods_name,
      o2.unit_no,
      o2.sheet_qty,
      o2.sheet_pri,
      o2.del_date,
      CONVERT(DATE, o2.del_date),
      o2.def02,
      o2.made_lot,
      (SELECT COALESCE(SUM(x.allocated_qty), 0)
         FROM whs_slot_allocation x
         WHERE x.po_id = o2.id AND x.closed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM whs_allocation_receipt rx
             WHERE rx.allocation_id = x.id
           )
      )
    FROM t8_pur_order2 o2
    JOIN t8_pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    JOIN t8_bas_emp e
      ON e.emp_no = o1.create_user AND e.emp_name <> 'ADM'
    LEFT JOIN t8_bas_goods g ON g.goods_no = o2.goods_no
    WHERE o1.close_sw IN ('N', '0')
      AND (
        CAST(@bucket AS NVARCHAR(10)) IS NULL
        OR (@bucket = 'today' AND o2.del_date >= @windowStart AND o2.del_date < @windowEnd)
        OR (@bucket = 'upcoming' AND o2.del_date >= @windowEnd)
        OR (@bucket = 'od12' AND o2.del_date > @od12Start AND o2.del_date < @windowStart)
        OR (@bucket = 'od23' AND o2.del_date > @od23Start AND o2.del_date <= @od12Start)
        OR (@bucket = 'od3p' AND (o2.del_date <= @od23Start OR o2.del_date IS NULL))
      )
      AND (
        CAST(@prefixPattern AS NVARCHAR(140)) IS NULL
        OR o1.sheet_no LIKE @prefixPattern
        OR o2.goods_no LIKE @prefixPattern
        OR o2.made_lot LIKE @prefixPattern
        OR g.goods_name LIKE @containsPattern
        OR o1.su_name11 LIKE @containsPattern
        OR EXISTS (
          SELECT 1 FROM t8_pur_notice2 n2k
          WHERE n2k.pur_no = o1.sheet_no
            AND n2k.made_lot LIKE @prefixPattern
        )
      );
  

    CREATE INDEX ix_po_key
      ON #PO (po_number, item_code, def02, del_day);
  

    CREATE TABLE #Notice (
      notice_id INT NOT NULL,
      po_id INT NOT NULL,
      pur_no NVARCHAR(20) NOT NULL,
      goods_no NVARCHAR(30) NOT NULL,
      made_lot NVARCHAR(40) NULL,
      sheet_qty FLOAT NOT NULL,
      def02 NVARCHAR(50) NULL,
      unit_no NVARCHAR(10) NULL,
      assign_qty FLOAT NOT NULL,
      PRIMARY KEY (notice_id, po_id)
    );
  

    INSERT INTO #Notice (
      notice_id, po_id, pur_no, goods_no, made_lot,
      sheet_qty, def02, unit_no, assign_qty
    )
    SELECT
      n2.id,
      p.po_id,
      n2.pur_no,
      n2.goods_no,
      n2.made_lot,
      n2.sheet_qty,
      n2.def02,
      n2.unit_no,
      (SELECT COALESCE(SUM(r.received_qty), 0)
         FROM whs_allocation_receipt r
         WHERE r.notice_detail_id = n2.id)
    FROM #PO p
    JOIN t8_pur_notice2 n2
      ON n2.pur_no = p.po_number
     AND n2.goods_no = p.item_code
     AND n2.def02 = p.def02
     AND n2.def23 >= p.del_day
     AND n2.def23 < DATEADD(DAY, 1, p.del_day);
  

    CREATE INDEX ix_notice_po
      ON #Notice (po_id);
    CREATE INDEX ix_notice_lot
      ON #Notice (pur_no, goods_no, made_lot);
  

    CREATE TABLE #PurIn (
      pur_no NVARCHAR(20) NOT NULL,
      goods_no NVARCHAR(30) NOT NULL,
      made_lot NVARCHAR(40) NULL,
      sheet_no NVARCHAR(30) NULL
    );
  

    INSERT INTO #PurIn (pur_no, goods_no, made_lot, sheet_no)
    SELECT DISTINCT i2.pur_no, i2.goods_no, i2.made_lot, i2.sheet_no
    FROM t8_pur_in2 i2
    JOIN (SELECT DISTINCT po_number FROM #PO) p
      ON p.po_number = i2.pur_no;
  

    CREATE INDEX ix_purin_lot
      ON #PurIn (pur_no, goods_no, made_lot);
    CREATE INDEX ix_purin_po
      ON #PurIn (pur_no, goods_no);
  
-- ---- Ket qua list ----

    -- DECLARE @prefixPattern NVARCHAR(140) = 'PO1%';
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    -- DECLARE @bucket NVARCHAR(10) = 'today';
    -- DECLARE @windowStart DATETIME = '2026-10-09';
    -- DECLARE @windowEnd   DATETIME = '2026-10-30';
    -- DECLARE @od12Start  DATETIME = '2026-08-20';
    -- DECLARE @od23Start  DATETIME = '2026-07-21';
    -- DECLARE @offset INT = 0;
    -- DECLARE @pageSize INT = 20;
    WITH noticed AS (
      SELECT po_id, SUM(sheet_qty) AS noticed_qty
      FROM #Notice
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
        (p.sheet_qty - COALESCE(nc.noticed_qty, 0) - p.unconf_qty) AS qty,
        p.unit AS unit,
        p.unit_price AS unit_price,
        CASE WHEN p.check_sta = 'Y' THEN 1 ELSE 0 END AS confirmed,
        p.del_date AS eta,
        CASE WHEN EXISTS (
          SELECT 1 FROM #PurIn pi
          WHERE pi.pur_no = p.po_number AND pi.goods_no = p.item_code
        ) THEN 1 ELSE 0 END AS arrived,
        (SELECT MAX(pi2.sheet_no) FROM #PurIn pi2
          WHERE pi2.pur_no = p.po_number AND pi2.goods_no = p.item_code)
          AS grn_ref,
        p.made_lot AS lot_no,
        p.unconf_qty AS assigned_qty,
        p.del_date AS del_date,
        p.sheet_date AS sheet_date,
        p.po_id AS po_sort,
        0 AS lot_sort
      FROM #PO p
      LEFT JOIN noticed nc ON nc.po_id = p.po_id
      WHERE (p.sheet_qty - COALESCE(nc.noticed_qty, 0) - p.unconf_qty) > 0
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
        x.unit_no AS unit,
        p2.unit_price AS unit_price,
        CASE WHEN p2.check_sta = 'Y' THEN 1 ELSE 0 END AS confirmed,
        p2.del_date AS eta,
        1 AS arrived,
        CAST(NULL AS VARCHAR(20)) AS grn_ref,
        x.made_lot AS lot_no,
        COALESCE(x.assign_qty, 0) AS assigned_qty,
        p2.del_date AS del_date,
        p2.sheet_date AS sheet_date,
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
          n.assign_qty,
          ROW_NUMBER() OVER (
            PARTITION BY n.notice_id ORDER BY n.po_id ASC
          ) AS rn
        FROM #Notice n
      ) x
      JOIN #PO p2 ON p2.po_id = x.po_id
      WHERE x.rn = 1
        AND (x.sheet_qty - COALESCE(x.assign_qty, 0)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM #PurIn pi
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
    SELECT
      u.id AS [id],
      CAST(u.po_id AS VARCHAR(20)) AS [poLine],
      u.po_number AS [poNumber],
      u.item_code AS [itemCode],
      u.material AS [material],
      u.supplier AS [supplier],
      CAST(u.qty AS FLOAT) AS [qty],
      u.unit AS [unit],
      CAST(u.unit_price AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN u.confirmed = 1 THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      u.eta AS [eta],
      CAST(CASE WHEN u.arrived = 1 THEN 1 ELSE 0 END AS BIT) AS [arrived],
      u.grn_ref AS [grnRef],
      u.lot_no AS [lotNo],
      CAST(u.assigned_qty AS FLOAT) AS [assignedQty],
      CAST(0 AS BIT) AS [closed],
      u.sheet_date AS [sheetDate],
      u.del_date AS [delDate],
      'mock' AS [source],
      COUNT(*) OVER() AS [totalCnt]
    FROM eligible u
    WHERE (
      CAST(@prefixPattern AS NVARCHAR(140)) IS NULL
      OR u.po_number LIKE @prefixPattern
      OR u.item_code LIKE @prefixPattern
      OR u.lot_no LIKE @prefixPattern
      OR u.material LIKE @containsPattern
      OR u.supplier LIKE @containsPattern
    )
    AND (
      CAST(@bucket AS NVARCHAR(10)) IS NULL
      OR (@bucket = 'today' AND u.del_date >= @windowStart AND u.del_date < @windowEnd)
      OR (@bucket = 'upcoming' AND u.del_date >= @windowEnd)
      OR (@bucket = 'od12' AND u.del_date > @od12Start AND u.del_date < @windowStart)
      OR (@bucket = 'od23' AND u.del_date > @od23Start AND u.del_date <= @od12Start)
      OR (@bucket = 'od3p' AND (u.del_date <= @od23Start OR u.del_date IS NULL))
    )
    ORDER BY u.del_date ASC, u.po_sort ASC, u.lot_sort ASC
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
  
DROP TABLE IF EXISTS #PurIn, #Notice, #PO;

GO
/* ===================== SECTION 2 — COUNT BUCKET CARDS (rong) ==============
   Mo phong request: GET /pos?counts=1 — KHONG push bucket (dem TAT CA bucket).
   Keyword (neu co) van duoc push vao #PO.
   (@bucket = NULL => fillPoTemp KHONG loc bucket — pipeline rong)
============================================================================= */
DECLARE @bucket NVARCHAR(10) = NULL;
DECLARE @prefixPattern NVARCHAR(140) = NULL;
DECLARE @containsPattern NVARCHAR(160) = NULL;
DECLARE @windowStart DATETIME, @windowEnd DATETIME, @od12Start DATETIME, @od23Start DATETIME;
SET @windowStart = DATEADD(DAY, -10, CAST(CAST(GETDATE() AS date) AS datetime));
SET @windowEnd   = DATEADD(DAY,  11, CAST(CAST(GETDATE() AS date) AS datetime));
SET @od12Start   = DATEADD(DAY, -60, CAST(CAST(GETDATE() AS date) AS datetime));
SET @od23Start   = DATEADD(DAY, -90, CAST(CAST(GETDATE() AS date) AS datetime));

DROP TABLE IF EXISTS #PurIn, #Notice, #PO;

    CREATE TABLE #PO (
      po_id INT NOT NULL PRIMARY KEY,
      po_number NVARCHAR(20) NOT NULL,
      supplier NVARCHAR(100) NULL,
      sheet_date DATETIME NULL,
      check_sta CHAR(1) NULL,
      item_code NVARCHAR(30) NULL,
      material NVARCHAR(120) NULL,
      unit NVARCHAR(10) NULL,
      sheet_qty FLOAT NOT NULL,
      unit_price NUMERIC(18, 8) NULL,
      del_date DATETIME NULL,
      del_day DATE NULL,
      def02 NVARCHAR(50) NULL,
      made_lot NVARCHAR(30) NULL,
      unconf_qty FLOAT NOT NULL
    );
  

    -- DECLARE @bucket NVARCHAR(10) = NULL;
    -- DECLARE @windowStart DATETIME = '2026-10-09';
    -- DECLARE @windowEnd   DATETIME = '2026-10-30';
    -- DECLARE @od12Start  DATETIME = '2026-08-20';
    -- DECLARE @od23Start  DATETIME = '2026-07-21';
    -- DECLARE @prefixPattern NVARCHAR(140) = NULL;
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    INSERT INTO #PO (
      po_id, po_number, supplier, sheet_date, check_sta,
      item_code, material, unit, sheet_qty, unit_price,
      del_date, del_day, def02, made_lot, unconf_qty
    )
    SELECT
      o2.id,
      o1.sheet_no,
      o1.su_name11,
      o1.sheet_date,
      o1.check_sta,
      o2.goods_no,
      g.goods_name,
      o2.unit_no,
      o2.sheet_qty,
      o2.sheet_pri,
      o2.del_date,
      CONVERT(DATE, o2.del_date),
      o2.def02,
      o2.made_lot,
      (SELECT COALESCE(SUM(x.allocated_qty), 0)
         FROM whs_slot_allocation x
         WHERE x.po_id = o2.id AND x.closed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM whs_allocation_receipt rx
             WHERE rx.allocation_id = x.id
           )
      )
    FROM t8_pur_order2 o2
    JOIN t8_pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    JOIN t8_bas_emp e
      ON e.emp_no = o1.create_user AND e.emp_name <> 'ADM'
    LEFT JOIN t8_bas_goods g ON g.goods_no = o2.goods_no
    WHERE o1.close_sw IN ('N', '0')
      AND (
        CAST(@bucket AS NVARCHAR(10)) IS NULL
        OR (@bucket = 'today' AND o2.del_date >= @windowStart AND o2.del_date < @windowEnd)
        OR (@bucket = 'upcoming' AND o2.del_date >= @windowEnd)
        OR (@bucket = 'od12' AND o2.del_date > @od12Start AND o2.del_date < @windowStart)
        OR (@bucket = 'od23' AND o2.del_date > @od23Start AND o2.del_date <= @od12Start)
        OR (@bucket = 'od3p' AND (o2.del_date <= @od23Start OR o2.del_date IS NULL))
      )
      AND (
        CAST(@prefixPattern AS NVARCHAR(140)) IS NULL
        OR o1.sheet_no LIKE @prefixPattern
        OR o2.goods_no LIKE @prefixPattern
        OR o2.made_lot LIKE @prefixPattern
        OR g.goods_name LIKE @containsPattern
        OR o1.su_name11 LIKE @containsPattern
        OR EXISTS (
          SELECT 1 FROM t8_pur_notice2 n2k
          WHERE n2k.pur_no = o1.sheet_no
            AND n2k.made_lot LIKE @prefixPattern
        )
      );
  

    CREATE INDEX ix_po_key
      ON #PO (po_number, item_code, def02, del_day);
  

    CREATE TABLE #Notice (
      notice_id INT NOT NULL,
      po_id INT NOT NULL,
      pur_no NVARCHAR(20) NOT NULL,
      goods_no NVARCHAR(30) NOT NULL,
      made_lot NVARCHAR(40) NULL,
      sheet_qty FLOAT NOT NULL,
      def02 NVARCHAR(50) NULL,
      unit_no NVARCHAR(10) NULL,
      assign_qty FLOAT NOT NULL,
      PRIMARY KEY (notice_id, po_id)
    );
  

    INSERT INTO #Notice (
      notice_id, po_id, pur_no, goods_no, made_lot,
      sheet_qty, def02, unit_no, assign_qty
    )
    SELECT
      n2.id,
      p.po_id,
      n2.pur_no,
      n2.goods_no,
      n2.made_lot,
      n2.sheet_qty,
      n2.def02,
      n2.unit_no,
      (SELECT COALESCE(SUM(r.received_qty), 0)
         FROM whs_allocation_receipt r
         WHERE r.notice_detail_id = n2.id)
    FROM #PO p
    JOIN t8_pur_notice2 n2
      ON n2.pur_no = p.po_number
     AND n2.goods_no = p.item_code
     AND n2.def02 = p.def02
     AND n2.def23 >= p.del_day
     AND n2.def23 < DATEADD(DAY, 1, p.del_day);
  

    CREATE INDEX ix_notice_po
      ON #Notice (po_id);
    CREATE INDEX ix_notice_lot
      ON #Notice (pur_no, goods_no, made_lot);
  

    CREATE TABLE #PurIn (
      pur_no NVARCHAR(20) NOT NULL,
      goods_no NVARCHAR(30) NOT NULL,
      made_lot NVARCHAR(40) NULL,
      sheet_no NVARCHAR(30) NULL
    );
  

    INSERT INTO #PurIn (pur_no, goods_no, made_lot, sheet_no)
    SELECT DISTINCT i2.pur_no, i2.goods_no, i2.made_lot, i2.sheet_no
    FROM t8_pur_in2 i2
    JOIN (SELECT DISTINCT po_number FROM #PO) p
      ON p.po_number = i2.pur_no;
  

    CREATE INDEX ix_purin_lot
      ON #PurIn (pur_no, goods_no, made_lot);
    CREATE INDEX ix_purin_po
      ON #PurIn (pur_no, goods_no);
  
-- ---- Ket qua dem bucket ----

    -- DECLARE @prefixPattern NVARCHAR(140) = NULL;
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    -- DECLARE @windowStart DATETIME = '2026-10-09';
    -- DECLARE @windowEnd   DATETIME = '2026-10-30';
    -- DECLARE @od12Start  DATETIME = '2026-08-20';
    -- DECLARE @od23Start  DATETIME = '2026-07-21';
    WITH noticed AS (
      SELECT po_id, SUM(sheet_qty) AS noticed_qty
      FROM #Notice
      GROUP BY po_id
    ),
    gap AS (
      SELECT
        p.po_number AS po_number,
        p.item_code AS item_code,
        p.material AS material,
        p.supplier AS supplier,
        p.made_lot AS lot_no,
        p.del_date AS del_date
      FROM #PO p
      LEFT JOIN noticed nc ON nc.po_id = p.po_id
      WHERE (p.sheet_qty - COALESCE(nc.noticed_qty, 0) - p.unconf_qty) > 0
    ),
    notice_branch AS (
      SELECT
        p2.po_number AS po_number,
        p2.item_code AS item_code,
        p2.material AS material,
        p2.supplier AS supplier,
        x.made_lot AS lot_no,
        p2.del_date AS del_date
      FROM (
        SELECT
          n.notice_id,
          n.po_id,
          n.pur_no,
          n.goods_no,
          n.made_lot,
          n.sheet_qty,
          n.assign_qty,
          ROW_NUMBER() OVER (
            PARTITION BY n.notice_id ORDER BY n.po_id ASC
          ) AS rn
        FROM #Notice n
      ) x
      JOIN #PO p2 ON p2.po_id = x.po_id
      WHERE x.rn = 1
        AND (x.sheet_qty - COALESCE(x.assign_qty, 0)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM #PurIn pi
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
    SELECT t.bucket AS [bucket], COUNT(DISTINCT t.po_number) AS [n]
    FROM (
      SELECT
        u.po_number,
        CASE
          WHEN u.del_date >= @windowEnd THEN 'upcoming'
          WHEN u.del_date >= @windowStart THEN 'today'
          WHEN u.del_date > @od12Start THEN 'od12'
          WHEN u.del_date > @od23Start THEN 'od23'
          ELSE 'od3p'
        END AS bucket
      FROM eligible u
      WHERE (
        CAST(@prefixPattern AS NVARCHAR(140)) IS NULL
        OR u.po_number LIKE @prefixPattern
        OR u.item_code LIKE @prefixPattern
        OR u.lot_no LIKE @prefixPattern
        OR u.material LIKE @containsPattern
        OR u.supplier LIKE @containsPattern
      )
    ) t
    GROUP BY t.bucket;
  
DROP TABLE IF EXISTS #PurIn, #Notice, #PO;

GO
/* ===================== SECTION 3 — LIST KHONG bucket (tham chieu) =========
   Mo phong request: GET /pos?page=1&pageSize=50 (khong bucket, khong keyword)
   Day la cau NANG NHAT cua list — dung lam moc so sanh voi SECTION 1.
============================================================================= */
DECLARE @bucket NVARCHAR(10) = NULL;
DECLARE @prefixPattern NVARCHAR(140) = NULL;
DECLARE @containsPattern NVARCHAR(160) = NULL;
DECLARE @offset INT = 0, @pageSize INT = 50;
DECLARE @windowStart DATETIME, @windowEnd DATETIME, @od12Start DATETIME, @od23Start DATETIME;
SET @windowStart = DATEADD(DAY, -10, CAST(CAST(GETDATE() AS date) AS datetime));
SET @windowEnd   = DATEADD(DAY,  11, CAST(CAST(GETDATE() AS date) AS datetime));
SET @od12Start   = DATEADD(DAY, -60, CAST(CAST(GETDATE() AS date) AS datetime));
SET @od23Start   = DATEADD(DAY, -90, CAST(CAST(GETDATE() AS date) AS datetime));

DROP TABLE IF EXISTS #PurIn, #Notice, #PO;

    CREATE TABLE #PO (
      po_id INT NOT NULL PRIMARY KEY,
      po_number NVARCHAR(20) NOT NULL,
      supplier NVARCHAR(100) NULL,
      sheet_date DATETIME NULL,
      check_sta CHAR(1) NULL,
      item_code NVARCHAR(30) NULL,
      material NVARCHAR(120) NULL,
      unit NVARCHAR(10) NULL,
      sheet_qty FLOAT NOT NULL,
      unit_price NUMERIC(18, 8) NULL,
      del_date DATETIME NULL,
      del_day DATE NULL,
      def02 NVARCHAR(50) NULL,
      made_lot NVARCHAR(30) NULL,
      unconf_qty FLOAT NOT NULL
    );
  

    -- DECLARE @bucket NVARCHAR(10) = NULL;
    -- DECLARE @windowStart DATETIME = '2026-10-09';
    -- DECLARE @windowEnd   DATETIME = '2026-10-30';
    -- DECLARE @od12Start  DATETIME = '2026-08-20';
    -- DECLARE @od23Start  DATETIME = '2026-07-21';
    -- DECLARE @prefixPattern NVARCHAR(140) = NULL;
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    INSERT INTO #PO (
      po_id, po_number, supplier, sheet_date, check_sta,
      item_code, material, unit, sheet_qty, unit_price,
      del_date, del_day, def02, made_lot, unconf_qty
    )
    SELECT
      o2.id,
      o1.sheet_no,
      o1.su_name11,
      o1.sheet_date,
      o1.check_sta,
      o2.goods_no,
      g.goods_name,
      o2.unit_no,
      o2.sheet_qty,
      o2.sheet_pri,
      o2.del_date,
      CONVERT(DATE, o2.del_date),
      o2.def02,
      o2.made_lot,
      (SELECT COALESCE(SUM(x.allocated_qty), 0)
         FROM whs_slot_allocation x
         WHERE x.po_id = o2.id AND x.closed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM whs_allocation_receipt rx
             WHERE rx.allocation_id = x.id
           )
      )
    FROM t8_pur_order2 o2
    JOIN t8_pur_order1 o1 ON o1.sheet_no = o2.sheet_no
    JOIN t8_bas_emp e
      ON e.emp_no = o1.create_user AND e.emp_name <> 'ADM'
    LEFT JOIN t8_bas_goods g ON g.goods_no = o2.goods_no
    WHERE o1.close_sw IN ('N', '0')
      AND (
        CAST(@bucket AS NVARCHAR(10)) IS NULL
        OR (@bucket = 'today' AND o2.del_date >= @windowStart AND o2.del_date < @windowEnd)
        OR (@bucket = 'upcoming' AND o2.del_date >= @windowEnd)
        OR (@bucket = 'od12' AND o2.del_date > @od12Start AND o2.del_date < @windowStart)
        OR (@bucket = 'od23' AND o2.del_date > @od23Start AND o2.del_date <= @od12Start)
        OR (@bucket = 'od3p' AND (o2.del_date <= @od23Start OR o2.del_date IS NULL))
      )
      AND (
        CAST(@prefixPattern AS NVARCHAR(140)) IS NULL
        OR o1.sheet_no LIKE @prefixPattern
        OR o2.goods_no LIKE @prefixPattern
        OR o2.made_lot LIKE @prefixPattern
        OR g.goods_name LIKE @containsPattern
        OR o1.su_name11 LIKE @containsPattern
        OR EXISTS (
          SELECT 1 FROM t8_pur_notice2 n2k
          WHERE n2k.pur_no = o1.sheet_no
            AND n2k.made_lot LIKE @prefixPattern
        )
      );
  

    CREATE INDEX ix_po_key
      ON #PO (po_number, item_code, def02, del_day);
  

    CREATE TABLE #Notice (
      notice_id INT NOT NULL,
      po_id INT NOT NULL,
      pur_no NVARCHAR(20) NOT NULL,
      goods_no NVARCHAR(30) NOT NULL,
      made_lot NVARCHAR(40) NULL,
      sheet_qty FLOAT NOT NULL,
      def02 NVARCHAR(50) NULL,
      unit_no NVARCHAR(10) NULL,
      assign_qty FLOAT NOT NULL,
      PRIMARY KEY (notice_id, po_id)
    );
  

    INSERT INTO #Notice (
      notice_id, po_id, pur_no, goods_no, made_lot,
      sheet_qty, def02, unit_no, assign_qty
    )
    SELECT
      n2.id,
      p.po_id,
      n2.pur_no,
      n2.goods_no,
      n2.made_lot,
      n2.sheet_qty,
      n2.def02,
      n2.unit_no,
      (SELECT COALESCE(SUM(r.received_qty), 0)
         FROM whs_allocation_receipt r
         WHERE r.notice_detail_id = n2.id)
    FROM #PO p
    JOIN t8_pur_notice2 n2
      ON n2.pur_no = p.po_number
     AND n2.goods_no = p.item_code
     AND n2.def02 = p.def02
     AND n2.def23 >= p.del_day
     AND n2.def23 < DATEADD(DAY, 1, p.del_day);
  

    CREATE INDEX ix_notice_po
      ON #Notice (po_id);
    CREATE INDEX ix_notice_lot
      ON #Notice (pur_no, goods_no, made_lot);
  

    CREATE TABLE #PurIn (
      pur_no NVARCHAR(20) NOT NULL,
      goods_no NVARCHAR(30) NOT NULL,
      made_lot NVARCHAR(40) NULL,
      sheet_no NVARCHAR(30) NULL
    );
  

    INSERT INTO #PurIn (pur_no, goods_no, made_lot, sheet_no)
    SELECT DISTINCT i2.pur_no, i2.goods_no, i2.made_lot, i2.sheet_no
    FROM t8_pur_in2 i2
    JOIN (SELECT DISTINCT po_number FROM #PO) p
      ON p.po_number = i2.pur_no;
  

    CREATE INDEX ix_purin_lot
      ON #PurIn (pur_no, goods_no, made_lot);
    CREATE INDEX ix_purin_po
      ON #PurIn (pur_no, goods_no);
  
-- ---- Ket qua list (khong bucket) ----

    -- DECLARE @prefixPattern NVARCHAR(140) = 'PO1%';
    -- DECLARE @containsPattern NVARCHAR(160) = NULL;
    -- DECLARE @bucket NVARCHAR(10) = 'today';
    -- DECLARE @windowStart DATETIME = '2026-10-09';
    -- DECLARE @windowEnd   DATETIME = '2026-10-30';
    -- DECLARE @od12Start  DATETIME = '2026-08-20';
    -- DECLARE @od23Start  DATETIME = '2026-07-21';
    -- DECLARE @offset INT = 0;
    -- DECLARE @pageSize INT = 20;
    WITH noticed AS (
      SELECT po_id, SUM(sheet_qty) AS noticed_qty
      FROM #Notice
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
        (p.sheet_qty - COALESCE(nc.noticed_qty, 0) - p.unconf_qty) AS qty,
        p.unit AS unit,
        p.unit_price AS unit_price,
        CASE WHEN p.check_sta = 'Y' THEN 1 ELSE 0 END AS confirmed,
        p.del_date AS eta,
        CASE WHEN EXISTS (
          SELECT 1 FROM #PurIn pi
          WHERE pi.pur_no = p.po_number AND pi.goods_no = p.item_code
        ) THEN 1 ELSE 0 END AS arrived,
        (SELECT MAX(pi2.sheet_no) FROM #PurIn pi2
          WHERE pi2.pur_no = p.po_number AND pi2.goods_no = p.item_code)
          AS grn_ref,
        p.made_lot AS lot_no,
        p.unconf_qty AS assigned_qty,
        p.del_date AS del_date,
        p.sheet_date AS sheet_date,
        p.po_id AS po_sort,
        0 AS lot_sort
      FROM #PO p
      LEFT JOIN noticed nc ON nc.po_id = p.po_id
      WHERE (p.sheet_qty - COALESCE(nc.noticed_qty, 0) - p.unconf_qty) > 0
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
        x.unit_no AS unit,
        p2.unit_price AS unit_price,
        CASE WHEN p2.check_sta = 'Y' THEN 1 ELSE 0 END AS confirmed,
        p2.del_date AS eta,
        1 AS arrived,
        CAST(NULL AS VARCHAR(20)) AS grn_ref,
        x.made_lot AS lot_no,
        COALESCE(x.assign_qty, 0) AS assigned_qty,
        p2.del_date AS del_date,
        p2.sheet_date AS sheet_date,
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
          n.assign_qty,
          ROW_NUMBER() OVER (
            PARTITION BY n.notice_id ORDER BY n.po_id ASC
          ) AS rn
        FROM #Notice n
      ) x
      JOIN #PO p2 ON p2.po_id = x.po_id
      WHERE x.rn = 1
        AND (x.sheet_qty - COALESCE(x.assign_qty, 0)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM #PurIn pi
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
    SELECT
      u.id AS [id],
      CAST(u.po_id AS VARCHAR(20)) AS [poLine],
      u.po_number AS [poNumber],
      u.item_code AS [itemCode],
      u.material AS [material],
      u.supplier AS [supplier],
      CAST(u.qty AS FLOAT) AS [qty],
      u.unit AS [unit],
      CAST(u.unit_price AS FLOAT) AS [unitPrice],
      CAST(CASE WHEN u.confirmed = 1 THEN 1 ELSE 0 END AS BIT) AS [confirmed],
      u.eta AS [eta],
      CAST(CASE WHEN u.arrived = 1 THEN 1 ELSE 0 END AS BIT) AS [arrived],
      u.grn_ref AS [grnRef],
      u.lot_no AS [lotNo],
      CAST(u.assigned_qty AS FLOAT) AS [assignedQty],
      CAST(0 AS BIT) AS [closed],
      u.sheet_date AS [sheetDate],
      u.del_date AS [delDate],
      'mock' AS [source],
      COUNT(*) OVER() AS [totalCnt]
    FROM eligible u
    WHERE (
      CAST(@prefixPattern AS NVARCHAR(140)) IS NULL
      OR u.po_number LIKE @prefixPattern
      OR u.item_code LIKE @prefixPattern
      OR u.lot_no LIKE @prefixPattern
      OR u.material LIKE @containsPattern
      OR u.supplier LIKE @containsPattern
    )
    AND (
      CAST(@bucket AS NVARCHAR(10)) IS NULL
      OR (@bucket = 'today' AND u.del_date >= @windowStart AND u.del_date < @windowEnd)
      OR (@bucket = 'upcoming' AND u.del_date >= @windowEnd)
      OR (@bucket = 'od12' AND u.del_date > @od12Start AND u.del_date < @windowStart)
      OR (@bucket = 'od23' AND u.del_date > @od23Start AND u.del_date <= @od12Start)
      OR (@bucket = 'od3p' AND (u.del_date <= @od23Start OR u.del_date IS NULL))
    )
    ORDER BY u.del_date ASC, u.po_sort ASC, u.lot_sort ASC
    OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
  
DROP TABLE IF EXISTS #PurIn, #Notice, #PO;
