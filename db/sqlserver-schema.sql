-- ============================================================
-- SCHEMA SQL SERVER CHO SMART WAREHOUSE v3 (Germton Group)
-- Chay file nay 1 lan tren SQL Server cua team de tao:
--   - 9 bang t8_* (mock T8 ERP, business layer chi READ ONLY)
--   - 1 view t8_v_pur_notice_detail
--   - 5 bang whs_* (Smart Warehouse)
-- Khac biet PostgreSQL sandbox: khong co audit columns / RLS
-- (day la yeu cau rieng cua platform MiaoDa, khong ap dung SQL Server that).
-- KHONG co FK tu whs_* sang t8_* (t8 la mock, logical key only).
-- ============================================================

-- ---- Drop theo thu tu FK (movement -> allocation -> slots) ----
IF OBJECT_ID('dbo.whs_allocation_receipt', 'U') IS NOT NULL DROP TABLE dbo.whs_allocation_receipt;
IF OBJECT_ID('dbo.whs_slot_movement', 'U') IS NOT NULL DROP TABLE dbo.whs_slot_movement;
IF OBJECT_ID('dbo.whs_slot_allocation', 'U') IS NOT NULL DROP TABLE dbo.whs_slot_allocation;
IF OBJECT_ID('dbo.whs_activity', 'U') IS NOT NULL DROP TABLE dbo.whs_activity;
IF OBJECT_ID('dbo.whs_slots', 'U') IS NOT NULL DROP TABLE dbo.whs_slots;
IF OBJECT_ID('dbo.whs_user_role', 'U') IS NOT NULL DROP TABLE dbo.whs_user_role;
-- TAT DROP t8_* (2026-10-16, yeu cau user): KHONG drop cac bang t8_* —
-- neu DB da co t8_* (hoac la bang that cua he thong) thi script se
-- chi tao lai phan whs_*; neu t8_* chua ton tai thi cac CREATE o duoi
-- van chay binh thuong.
-- IF OBJECT_ID('dbo.t8_v_pur_notice_detail', 'V') IS NOT NULL DROP VIEW dbo.t8_v_pur_notice_detail;
-- IF OBJECT_ID('dbo.t8_pur_in2', 'U') IS NOT NULL DROP TABLE dbo.t8_pur_in2;
-- IF OBJECT_ID('dbo.t8_pur_in1', 'U') IS NOT NULL DROP TABLE dbo.t8_pur_in1;
-- IF OBJECT_ID('dbo.t8_pur_notice2', 'U') IS NOT NULL DROP TABLE dbo.t8_pur_notice2;
-- IF OBJECT_ID('dbo.t8_pur_notice1', 'U') IS NOT NULL DROP TABLE dbo.t8_pur_notice1;
-- IF OBJECT_ID('dbo.t8_pur_order2', 'U') IS NOT NULL DROP TABLE dbo.t8_pur_order2;
-- IF OBJECT_ID('dbo.t8_pur_order1', 'U') IS NOT NULL DROP TABLE dbo.t8_pur_order1;
-- IF OBJECT_ID('dbo.t8_bas_goods', 'U') IS NOT NULL DROP TABLE dbo.t8_bas_goods;
-- IF OBJECT_ID('dbo.t8_bas_emp', 'U') IS NOT NULL DROP TABLE dbo.t8_bas_emp;
GO

-- ============================================================
-- 1) T8 MOCK (bas_emp / bas_goods / pur_order1 / pur_order2)
-- ============================================================

-- Nhan vien (mock T8 bas_emp)
CREATE TABLE dbo.t8_bas_emp (
  id       INT           NOT NULL PRIMARY KEY,
  emp_no   NVARCHAR(20)  NOT NULL UNIQUE,
  emp_name NVARCHAR(20)  NOT NULL,
  email    NVARCHAR(255) NULL,
  dept_no  NVARCHAR(20)  NOT NULL,
  org_no   NVARCHAR(20)  NOT NULL,
  duty_no  NVARCHAR(20)  NOT NULL,
  act_sw   CHAR(1)       NOT NULL CONSTRAINT DF_t8_emp_act DEFAULT 'Y'
);
GO

-- Hang hoa (mock T8 bas_goods)
CREATE TABLE dbo.t8_bas_goods (
  id           INT           NOT NULL PRIMARY KEY,
  goods_no     NVARCHAR(30)  NOT NULL UNIQUE,
  goods_name   NVARCHAR(255) NOT NULL,
  goods_spec   NVARCHAR(255) NULL,
  goods_type   NVARCHAR(20)  NOT NULL,
  unit_no      NVARCHAR(20)  NOT NULL,
  pur_unit_no  NVARCHAR(20)  NOT NULL,
  st_no        NVARCHAR(20)  NULL,
  st_bit_no    NVARCHAR(20)  NULL,
  act_sw       CHAR(1)       NOT NULL CONSTRAINT DF_t8_goods_act DEFAULT 'Y'
);
GO

-- Don dat hang - header (mock T8 pur_order1)
CREATE TABLE dbo.t8_pur_order1 (
  id         INT           NOT NULL PRIMARY KEY,
  sheet_no   NVARCHAR(20)  NOT NULL UNIQUE,   -- PO number (PO-25xxx)
  sheet_date DATETIME2     NOT NULL,
  su_no      NVARCHAR(20)  NOT NULL,         -- ma nha cung cap
  su_name11  NVARCHAR(255) NOT NULL,         -- ten nha cung cap
  create_user NVARCHAR(20) NULL,            -- nguoi tao PO (join bas_emp.emp_no, loc ADM)
  emp_no     NVARCHAR(20)  NOT NULL,
  ship_date  DATETIME2     NULL,
  sheet_sta  CHAR(1)       NOT NULL,
  check_sta  CHAR(1)       NOT NULL,
  close_sw   CHAR(1)       NOT NULL CONSTRAINT DF_t8_po1_close DEFAULT 'N'
);
GO

-- Don dat hang - line (mock T8 pur_order2)
-- id nay chinh la whs_slot_allocation.po_id (logical key, khong FK)
CREATE TABLE dbo.t8_pur_order2 (
  id         INT           NOT NULL PRIMARY KEY,
  sheet_id   INT           NOT NULL,         -- = t8_pur_order1.id
  sheet_no   NVARCHAR(20)  NOT NULL,
  goods_no   NVARCHAR(30)  NOT NULL,
  unit_no    NVARCHAR(20)  NOT NULL,
  sheet_qty  NUMERIC(18,8) NOT NULL,
  sheet_pri  NUMERIC(18,8) NOT NULL,
  del_date   DATETIME2     NULL,
  su_del_date DATETIME2    NULL,
  made_lot   NVARCHAR(50)  NULL,
  sheet_lot  NVARCHAR(31)  NULL,
  def02      NVARCHAR(30)  NULL,             -- Customer Style (KEY FINAL [R2])
  close_sw   CHAR(1)       NOT NULL CONSTRAINT DF_t8_po2_close DEFAULT 'N'
);
GO

CREATE INDEX idx_t8_pur_order2_sheet_id ON dbo.t8_pur_order2 (sheet_id);
CREATE INDEX idx_t8_pur_order2_sheet_no ON dbo.t8_pur_order2 (sheet_no, goods_no, def02);
GO

-- ============================================================
-- 2) T8 MOCK (pur_notice1 / pur_notice2 / view / pur_in1 / pur_in2)
-- ============================================================

-- Thong bao den hang - header (mock T8 pur_notice1)
CREATE TABLE dbo.t8_pur_notice1 (
  id         INT          NOT NULL PRIMARY KEY,
  sheet_no   NVARCHAR(20) NOT NULL UNIQUE,    -- PN number
  sheet_date DATETIME2    NOT NULL,
  su_no      NVARCHAR(20) NOT NULL,
  emp_no     NVARCHAR(20) NOT NULL,
  eta        DATETIME2    NOT NULL,
  sheet_sta  CHAR(1)      NOT NULL,
  check_sta  CHAR(1)      NOT NULL
);
GO

-- Thong bao den hang - detail (mock T8 pur_notice2)
-- id nay chinh la whs_slot_allocation.notice_detail_id (logical key)
-- adj_result: '0' moi, '1' PASS, '2' FAIL_PENDING, '3' EXEMPT,
--             '4' PARTIAL_PASS, '5' RETURN, '6' AOD (ma mock)
CREATE TABLE dbo.t8_pur_notice2 (
  id         INT           NOT NULL PRIMARY KEY,
  sheet_id   INT           NOT NULL,          -- = t8_pur_notice1.id
  sheet_no   NVARCHAR(20)  NOT NULL,
  pur_no     NVARCHAR(20)  NOT NULL,          -- PO number tham chieu
  pur_id     INT           NOT NULL,          -- = t8_pur_order1.id
  goods_no   NVARCHAR(30)  NOT NULL,
  unit_no    NVARCHAR(20)  NOT NULL,
  st_no      NVARCHAR(20)  NOT NULL,
  sheet_qty  NUMERIC(18,8) NOT NULL,
  check_qty  NUMERIC(18,8) NOT NULL CONSTRAINT DF_t8_n2_check DEFAULT 0,
  bad_qty    NUMERIC(18,8) NOT NULL CONSTRAINT DF_t8_n2_bad DEFAULT 0,
  return_qty NUMERIC(18,8) NOT NULL CONSTRAINT DF_t8_n2_return DEFAULT 0,
  qc_level   NVARCHAR(20)  NULL,
  adj_result CHAR(1)       NOT NULL CONSTRAINT DF_t8_n2_adj DEFAULT 'N',
  pro_result CHAR(1)       NULL,
  qc_date    DATETIME2     NULL,
  qc_user_no NVARCHAR(20)  NULL,
  qc_emp_no  NVARCHAR(20)  NULL,
  made_lot   NVARCHAR(50)  NULL,
  sheet_lot  NVARCHAR(31)  NULL,             -- so lo thuc te den kem hang
  def02      NVARCHAR(30)  NULL,             -- Customer Style (KEY FINAL [R2])
  def23      DATETIME2     NULL              -- ngay du kien (KEY FINAL [R2]; so NGAY voi del_date)
);
GO

CREATE INDEX idx_t8_pur_notice2_sheet_id ON dbo.t8_pur_notice2 (sheet_id);
CREATE INDEX idx_t8_pur_notice2_pur_id  ON dbo.t8_pur_notice2 (pur_id);
-- KEY FINAL [R2]: pipeline /pos join notice theo (pur_no, goods_no, def02)
-- + range def23 — index nay giup SQL Server seek thay scan.
CREATE INDEX idx_t8_pur_notice2_purkey ON dbo.t8_pur_notice2 (pur_no, goods_no, def02, def23);
GO

-- View tong hop notice detail + so luong nhap kho / tam nhap
-- (mirror view t8_v_pur_notice_detail cua PostgreSQL sandbox)
CREATE VIEW dbo.t8_v_pur_notice_detail AS
SELECT
  n2.sheet_no,
  n2.pur_no,
  n2.goods_no,
  n2.unit_no,
  n2.st_no,
  n2.sheet_lot,
  n2.made_lot,
  n2.sheet_qty,
  n2.check_qty,
  n2.bad_qty,
  n2.return_qty,
  n2.adj_result,
  n2.pro_result,
  n2.qc_date,
  n2.qc_user_no,
  n2.qc_emp_no,
  COALESCE(grn.in_qty, 0)      AS in_qty,      -- da nhap chinh thuc (GRN)
  n2.sheet_qty - COALESCE(grn.in_qty, 0) AS temp_in_qty -- con tam nhap
FROM dbo.t8_pur_notice2 n2
LEFT JOIN (
  SELECT notice_id, SUM(sheet_qty) AS in_qty
  FROM   dbo.t8_pur_in2
  WHERE  notice_id IS NOT NULL
  GROUP BY notice_id
) grn ON grn.notice_id = n2.id;
GO

-- Phieu nhap kho - header (mock T8 pur_in1 / GRN)
CREATE TABLE dbo.t8_pur_in1 (
  id         INT          NOT NULL PRIMARY KEY,
  sheet_no   NVARCHAR(20) NOT NULL,            -- GRN number
  sheet_date DATETIME2    NOT NULL,
  su_no      NVARCHAR(20) NOT NULL,
  emp_no     NVARCHAR(20) NOT NULL,
  st_no      NVARCHAR(20) NOT NULL,
  sheet_sta  CHAR(1)      NOT NULL,
  check_sta  CHAR(1)      NOT NULL
);
GO

-- Phieu nhap kho - detail (mock T8 pur_in2)
-- PO den hang CHUA co notice -> notice_no / notice_id NULL
CREATE TABLE dbo.t8_pur_in2 (
  id         INT           NOT NULL PRIMARY KEY,
  sheet_id   INT           NOT NULL,           -- = t8_pur_in1.id
  sheet_no   NVARCHAR(20)  NOT NULL,
  notice_no  NVARCHAR(20)  NULL,
  notice_id  INT           NULL,               -- = t8_pur_notice1.id
  pur_no     NVARCHAR(20)  NOT NULL,
  pur_id     INT           NOT NULL,           -- = t8_pur_order1.id
  goods_no   NVARCHAR(30)  NOT NULL,
  unit_no    NVARCHAR(20)  NOT NULL,
  st_no      NVARCHAR(20)  NOT NULL,
  st_bit_no  NVARCHAR(20)  NULL,
  sheet_qty  NUMERIC(18,8) NOT NULL,
  made_lot   NVARCHAR(50)  NULL,
  su_lot_no  NVARCHAR(50)  NULL,
  sheet_lot  NVARCHAR(31)  NULL
);
GO

CREATE INDEX idx_t8_pur_in2_sheet_id  ON dbo.t8_pur_in2 (sheet_id);
CREATE INDEX idx_t8_pur_in2_notice_id ON dbo.t8_pur_in2 (notice_id);
CREATE INDEX idx_t8_pur_in2_pur_id    ON dbo.t8_pur_in2 (pur_id);
-- KEY FINAL [R3]: loai notice da GRN theo (pur_no, goods_no, made_lot)
CREATE INDEX idx_t8_pur_in2_lotkey ON dbo.t8_pur_in2 (pur_no, goods_no, made_lot);
GO

-- ============================================================
-- 3) SMART WAREHOUSE (whs_*)
-- ============================================================

-- Vai tro nguoi dung (demo: KEEPER / MANAGER)
CREATE TABLE dbo.whs_user_role (
  emp_no   NVARCHAR(20) NOT NULL PRIMARY KEY,
  role     NVARCHAR(10)  NOT NULL,             -- KEEPER | MANAGER
  password NVARCHAR(60)  NOT NULL CONSTRAINT DF_whs_role_pw DEFAULT '123456',
  locked   BIT           NOT NULL CONSTRAINT DF_whs_role_locked DEFAULT 0,
  active   BIT           NOT NULL CONSTRAINT DF_whs_role_active DEFAULT 1
);
GO

-- Ke hang (gia do GIF3)
CREATE TABLE dbo.whs_slots (
  code           NVARCHAR(20) NOT NULL PRIMARY KEY,
  warehouse      NVARCHAR(20) NOT NULL,
  slot_row       NVARCHAR(5)  NOT NULL,       -- "row" gan tu khoa nen dat slot_row
  floor          NVARCHAR(2)  NOT NULL,
  position       NVARCHAR(2)  NOT NULL,
  keeper_emp_no  NVARCHAR(20) NULL,           -- emp_no cua thu kho (t8_bas_emp)
  locked         BIT          NOT NULL CONSTRAINT DF_whs_slot_locked DEFAULT 0,
  is_full        BIT          NOT NULL CONSTRAINT DF_whs_slot_full DEFAULT 0,
  active         BIT          NOT NULL CONSTRAINT DF_whs_slot_active DEFAULT 1
);
GO

-- Phan phoi len ke (ket qua "Gan ke") — FINAL SCHEMA v3 (2026-10-17)
-- USER tao allocation (Assign Shelf), SYSTEM chi UPDATE trang thai.
-- po_id = t8_pur_order2.id. KHONG con notice_detail_id / notice_confirmed
-- tren allocation nua: quan he allocation <-> pur_notice2 (N-N) nam trong
-- bang rieng whs_allocation_receipt (xem duoi).
-- lot_no chi la cache/display compatibility: NULL khi vua Assign Shelf;
-- neu allocation lien quan nhieu lot thi lot_no giu NULL va doc danh sach
-- lot tu whs_allocation_receipt.
-- closed_at = thoi diem xuat kho/roi ke (khong phai RETURNED).
CREATE TABLE dbo.whs_slot_allocation (
  id                  VARCHAR(40)   NOT NULL PRIMARY KEY, -- genId ~22-23 ky tu
  po_id               INT           NOT NULL,   -- = t8_pur_order2.id (logical, khong FK T8)
  goods_no            NVARCHAR(30)  NOT NULL,
  lot_no              NVARCHAR(50)  NULL,       -- cache display; NULL khi chua match hoac da-lot
  warehouse_status    NVARCHAR(20)  NOT NULL CONSTRAINT DF_whs_alloc_whsta DEFAULT 'PO_ASSIGNED',
  slot_code           NVARCHAR(20)  NOT NULL CONSTRAINT FK_whs_alloc_slot
                                    REFERENCES dbo.whs_slots (code),
  allocated_qty       NUMERIC(18,8) NOT NULL,
  status              NVARCHAR(20)  NOT NULL CONSTRAINT DF_whs_alloc_status DEFAULT 'WAITING_IQC', -- WAITING_IQC | IN_STOCK | RETURNED | AOD_PENDING
  iqc_decision        NVARCHAR(15)  NULL,       -- PASS | FAIL_PENDING | EXEMPT | PARTIAL_PASS | RETURN | AOD
  has_warning         BIT           NOT NULL CONSTRAINT DF_whs_alloc_warn DEFAULT 0,
  qty_in_stock        NUMERIC(18,8) NULL,
  qty_return          NUMERIC(18,8) NULL,
  qty_aod             NUMERIC(18,8) NULL,
  last_iqc_at         DATETIME2     NULL,
  allocated_by_emp_no NVARCHAR(20)  NOT NULL,
  allocated_at        DATETIME2     NOT NULL,
  closed_at           DATETIME2     NULL,
  CONSTRAINT CK_whs_alloc_qty CHECK (allocated_qty > 0)
);
GO

CREATE INDEX idx_whs_alloc_slot   ON dbo.whs_slot_allocation (slot_code);
CREATE INDEX idx_whs_alloc_po     ON dbo.whs_slot_allocation (po_id);
-- Unique (po_id, slot_code) chi ap dung cho allocation con mo (chua closed)
CREATE UNIQUE INDEX uq_whs_alloc_active
  ON dbo.whs_slot_allocation (po_id, slot_code)
  WHERE closed_at IS NULL;
GO

-- Lich su di chuyen giua cac ke (partial move / hop khat)
CREATE TABLE dbo.whs_slot_movement (
  id                  VARCHAR(40)   NOT NULL PRIMARY KEY,
  source_allocation_id VARCHAR(40)  NOT NULL CONSTRAINT FK_whs_move_source
                                     REFERENCES dbo.whs_slot_allocation (id),
  target_allocation_id VARCHAR(40)  NULL CONSTRAINT FK_whs_move_target
                                     REFERENCES dbo.whs_slot_allocation (id),
  from_slot_code      NVARCHAR(20)  NOT NULL,
  to_slot_code        NVARCHAR(20)  NOT NULL,
  qty                 NUMERIC(18,8) NOT NULL,
  moved_by_emp_no     NVARCHAR(20)  NOT NULL,
  moved_at            DATETIME2     NOT NULL,
  note                NVARCHAR(500) NULL,
  CONSTRAINT CK_whs_move_qty   CHECK (qty > 0),
  CONSTRAINT CK_whs_move_slots CHECK (from_slot_code <> to_slot_code)
);
GO

CREATE INDEX idx_whs_move_source ON dbo.whs_slot_movement (source_allocation_id);
CREATE INDEX idx_whs_move_target ON dbo.whs_slot_movement (target_allocation_id);
GO

-- Nhat ky hoat dong (po_number la snapshot, khong FK sang T8)
-- po_id can co vi activity Assign Shelf xay ra TRUOC khi co pur_notice2.
CREATE TABLE dbo.whs_activity (
  id               VARCHAR(40)   NOT NULL PRIMARY KEY,
  acted_at         DATETIME2     NOT NULL,
  emp_no           NVARCHAR(20)  NOT NULL,
  user_name        NVARCHAR(80)  NULL,        -- da bo ghi (2026-10-17): code khong ghi nua, chua NULL cho khop DB that
  action_key       NVARCHAR(30)  NOT NULL,
  allocation_id    VARCHAR(40)   NULL,       -- logical key sang whs_slot_allocation
  po_id            INT           NULL,      -- logical key sang t8_pur_order2 (Assign Shelf xay ra truoc notice)
  notice_detail_id INT           NULL,      -- logical key sang t8_pur_notice2
  po_number        NVARCHAR(20)  NULL,       -- snapshot (PO-25xxx)
  slot_code        NVARCHAR(20)  NULL,
  qty              NUMERIC(18,8) NULL,
  unit             NVARCHAR(20)  NULL,
  detail           NVARCHAR(MAX) NULL
);
GO

CREATE INDEX idx_whs_activity_allocation ON dbo.whs_activity (allocation_id);
CREATE INDEX idx_whs_activity_action     ON dbo.whs_activity (action_key);
CREATE INDEX idx_whs_activity_time        ON dbo.whs_activity (acted_at DESC);
GO

-- ============================================================
-- 4) WHS ALLOCATION RECEIPT (FINAL SCHEMA v3 — 2026-10-17)
-- ============================================================

-- Quan he allocation (ke) <-> pur_notice2 (receiving) — N-N.
-- notice_detail_id la LOGICAL reference toi t8_pur_notice2.id,
-- KHONG tao physical FK sang T8.
-- Chi he thong ghi bang nay khi map la duy nhat (1 allocation active x
-- 1 notice cho cung po_id + goods_no); neu nhieu ben thi GIU trang thai
-- chua map — KHONG doan (khong FIFO, khong chia deu).
-- received_qty: so luong receiving thuoc allocation nay (co the < notice.sheet_qty).
CREATE TABLE dbo.whs_allocation_receipt (
  id               VARCHAR(40)   NOT NULL PRIMARY KEY,
  allocation_id    VARCHAR(40)   NOT NULL CONSTRAINT FK_whs_alloc_receipt_allocation
                                 REFERENCES dbo.whs_slot_allocation (id),
  notice_detail_id INT           NOT NULL,      -- logical ref -> t8_pur_notice2.id
  received_qty     NUMERIC(18,8) NOT NULL,
  lot_no           NVARCHAR(50)  NULL,       -- lot cua receiving (pur_notice2)
  iqc_decision     NVARCHAR(15)  NULL,       -- ket qua IQC ap dung cho receipt nay
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
GO

CREATE INDEX idx_whs_alloc_receipt_notice     ON dbo.whs_allocation_receipt (notice_detail_id);
CREATE INDEX idx_whs_alloc_receipt_allocation ON dbo.whs_allocation_receipt (allocation_id);
GO
