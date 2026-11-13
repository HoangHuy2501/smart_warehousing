-- =====================================================================
-- SMART WAREHOUSE v3 — FINAL WHS DATABASE CORRECTION (2026-10-17)
-- =====================================================================
-- Phan migration NAY chi danh cho 6 bang whs_* tren SQL Server:
--   whs_user_role, whs_slots, whs_slot_allocation,
--   whs_allocation_receipt (MOI), whs_slot_movement, whs_activity
--
-- QUY DINH BAT BUOC (theo yeu cau 2026-10-17):
--   * KHONG co lenh nao tac dong den t8_* / pur_* / bas_* / v_pur_notice_detail.
--   * KHONG DROP du lieu dang ton tai — chi CREATE/ALTER/INDEX/CONSTRAINT
--     co dieu kien (idempotent) + backfill du lieu cu sang schema moi.
--   * KHONG tao trigger.
--   * whs_slot_allocation giu nguyen du lieu cu; 3 cot cu
--     (notice_detail_id / notice_confirmed / notice_confirmed_at) chi duoc
--     DROP SAU khi khoi lenh DUOC COMMENT o cuoi file nay duoc user duyet.
--
-- Chu y: cau lenh INSERT...SELECT o phan backfill lay du lieu tu
-- whs_slot_allocation.notice_detail_id (cot logic cu) — khong doc T8,
-- nen chay tren moi truongProduction cung an toan.
-- =====================================================================

-- TODO: chuyen DB context dung truoc khi chay (VD: USE [WHS_SMART];)
GO

-- =====================================================
-- 1) TAO BANG MOI whs_allocation_receipt
-- =====================================================
IF OBJECT_ID('dbo.whs_allocation_receipt', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.whs_allocation_receipt (
    id               VARCHAR(40)   NOT NULL PRIMARY KEY,
    allocation_id    VARCHAR(40)   NOT NULL CONSTRAINT FK_whs_alloc_receipt_allocation
                                   REFERENCES dbo.whs_slot_allocation (id),
    notice_detail_id INT           NOT NULL,      -- logical ref -> t8_pur_notice2.id (KHONG physical FK sang T8)
    received_qty     NUMERIC(18,8) NOT NULL,
    lot_no           NVARCHAR(50)  NULL,       -- lot cua receiving (pur_notice2)
    iqc_decision     NVARCHAR(15)  NULL,       -- PASS | FAIL_PENDING | EXEMPT | PARTIAL_PASS | RETURN | AOD
    qty_in_stock     NUMERIC(18,8) NULL,
    qty_return       NUMERIC(18,8) NULL,
    qty_aod          NUMERIC(18,8) NULL,
    has_warning      BIT           NOT NULL CONSTRAINT DF_whs_rcpt_warn DEFAULT 0,
    qc_date          DATETIME2     NULL,
    confirmed_at     DATETIME2     NOT NULL CONSTRAINT DF_whs_rcpt_conf DEFAULT GETDATE(),
    updated_at       DATETIME2     NOT NULL CONSTRAINT DF_whs_rcpt_upd DEFAULT GETDATE(),
    CONSTRAINT CK_whs_alloc_receipt_qty CHECK (received_qty > 0),
    CONSTRAINT UQ_whs_alloc_receipt UNIQUE (allocation_id, notice_detail_id)
  );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_whs_alloc_receipt_notice'
               AND object_id = OBJECT_ID('dbo.whs_allocation_receipt'))
  CREATE INDEX idx_whs_alloc_receipt_notice
    ON dbo.whs_allocation_receipt (notice_detail_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_whs_alloc_receipt_allocation'
               AND object_id = OBJECT_ID('dbo.whs_allocation_receipt'))
  CREATE INDEX idx_whs_alloc_receipt_allocation
    ON dbo.whs_allocation_receipt (allocation_id);
GO

-- =====================================================
-- 2) whs_activity: THEM cot po_id
--    (activity Assign Shelf xay ra TRUOC pur_notice2)
-- =====================================================
IF COL_LENGTH('dbo.whs_activity', 'po_id') IS NULL
  ALTER TABLE dbo.whs_activity ADD po_id INT NULL;
GO

-- Backfill po_id tu allocation cu (chi cho dong log da co allocation_id)
UPDATE act
SET act.po_id = a.po_id
FROM dbo.whs_activity act
JOIN dbo.whs_slot_allocation a ON a.id = act.allocation_id
WHERE act.po_id IS NULL
  AND act.allocation_id IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_whs_activity_po'
               AND object_id = OBJECT_ID('dbo.whs_activity'))
  CREATE INDEX idx_whs_activity_po ON dbo.whs_activity (po_id);
GO

-- =====================================================
-- 3) BACKFILL whs_allocation_receipt tu du lieu cu
--    Chuyen doi moi 1-N: moi allocation cu co notice_detail_id
--    thi tao 1 receipt tuong ung (received_qty = allocated_qty).
--    Idempotent: bo qua cap (allocation_id, notice_detail_id) da ton tai.
-- =====================================================
INSERT INTO dbo.whs_allocation_receipt
  (id, allocation_id, notice_detail_id, received_qty, lot_no,
   iqc_decision, qty_in_stock, qty_return, qty_aod, has_warning,
   qc_date, confirmed_at, updated_at)
SELECT
  'M' + a.id,
  a.id,
  a.notice_detail_id,
  a.allocated_qty,
  a.lot_no,
  a.iqc_decision,
  a.qty_in_stock,
  a.qty_return,
  a.qty_aod,
  a.has_warning,
  a.last_iqc_at,
  COALESCE(a.notice_confirmed_at, a.allocated_at),
  GETDATE()
FROM dbo.whs_slot_allocation a
WHERE a.notice_detail_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM dbo.whs_allocation_receipt r
    WHERE r.allocation_id = a.id
      AND r.notice_detail_id = a.notice_detail_id
  );
GO

-- =====================================================
-- 4) CHECK CONSTRAINT cho whs_slot_allocation
-- =====================================================
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = 'CK_whs_alloc_qty')
  ALTER TABLE dbo.whs_slot_allocation
    ADD CONSTRAINT CK_whs_alloc_qty CHECK (allocated_qty > 0);
GO

-- =====================================================
-- 5) CHECK CONSTRAINT cho whs_slot_movement
-- =====================================================
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = 'CK_whs_move_qty')
  ALTER TABLE dbo.whs_slot_movement
    ADD CONSTRAINT CK_whs_move_qty CHECK (qty > 0);
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = 'CK_whs_move_slots')
  ALTER TABLE dbo.whs_slot_movement
    ADD CONSTRAINT CK_whs_move_slots CHECK (from_slot_code <> to_slot_code);
GO

-- =====================================================
-- 6) DEFAULT cho whs_slot_allocation.status (WAITING_IQC)
-- =====================================================
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints dc
               JOIN sys.columns c ON c.default_object_id = dc.object_id
               WHERE dc.name = 'DF_whs_alloc_status'
                 AND c.object_id = OBJECT_ID('dbo.whs_slot_allocation'))
  ALTER TABLE dbo.whs_slot_allocation
    ADD CONSTRAINT DF_whs_alloc_status DEFAULT 'WAITING_IQC' FOR status;
GO

-- =====================================================================
-- 7) GOI Y DROP 3 COT CU — PHAN NAY CHI CHAY KHI USER DUYET
-- =====================================================================
-- Truoc khi chay: kiem tra da backfill du lieu receipt o buoc 3:
--   SELECT COUNT(*) FROM dbo.whs_slot_allocation
--   WHERE notice_detail_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM dbo.whs_allocation_receipt r
--                     WHERE r.allocation_id = whs_slot_allocation.id);
-- Phai bang 0 truoc khi DROP.
--
-- ALTER TABLE dbo.whs_slot_allocation DROP COLUMN notice_detail_id;
-- ALTER TABLE dbo.whs_slot_allocation DROP COLUMN notice_confirmed;
-- ALTER TABLE dbo.whs_slot_allocation DROP COLUMN notice_confirmed_at;
-- DROP INDEX idx_whs_alloc_notice ON dbo.whs_slot_allocation;
-- GO
