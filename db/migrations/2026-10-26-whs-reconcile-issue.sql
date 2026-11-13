-- ====================================================================
-- PROPOSAL DDL — whs_reconcile_issue (PERSIST LỆCH RECONCILE)
-- ====================================================================
-- ⚠️ CHƯA ĐƯỢC APPROVE — KHÔNG TỰ CHẠY TRÊN SQL SERVER PRODUCTION.
--     Chờ user review + approve rồi chạy tay trên máy thật.
--     (Sandbox test-postgres đã tạo bản PG tương đương để test code.)
--
-- MỤC ĐÍCH (#31-#36 round-2 hardening): Receipt Sync Worker phát hiện
-- lệch reconcile (EXCESS / SHORTAGE / T8_CHANGED / AMBIGUOUS) phải
-- PERSIST để user nhìn thấy tại kệ / tại PO — không được chỉ in log
-- rồi mất. Vòng đời: OPEN → (lệch hết) → RESOLVED; dòng history giữ
-- lại phục vụ audit.
--
-- Source-of-truth của "đang có lệch" = bảng này (status=OPEN);
-- whs_slot_allocation.has_warning chỉ là cached UI flag.
--
-- IDEMPOTENCY (#36): dedup_key = 'TYPE|allocationId|noticeDetailId'
-- (col VARCHAR(120)) + filtered UNIQUE index CHỈ trên status='OPEN'
-- → worker retry 10 lần không nhân bản 10 dòng OPEN; khi lệch hết,
-- worker resolve (status='RESOLVED') theo allocation / notice.
--
-- BẢN SQL SERVER THẬT (chạy trên DB của smart_whs_v3, KHÔNG phải T8):
-- ====================================================================

CREATE TABLE whs_reconcile_issue (
  id                 VARCHAR(40)     NOT NULL CONSTRAINT PK_whs_reconcile_issue PRIMARY KEY,
  dedup_key          VARCHAR(120)    NOT NULL,
  issue_type         VARCHAR(20)     NOT NULL,  -- EXCESS | SHORTAGE | T8_CHANGED | AMBIGUOUS
  allocation_id      VARCHAR(40)     NULL,      -- NULL = issue cấp notice (SHORTAGE)
  notice_detail_id   NUMERIC(18,0)   NULL,      -- id t8_pur_notice2
  po_id              NUMERIC(18,0)   NOT NULL,  -- id t8_pur_order2
  goods_no           VARCHAR(30)     NOT NULL,
  slot_code          VARCHAR(20)     NULL,
  difference_qty     NUMERIC(18,8)   NOT NULL,  -- decimal safety #33
  status             VARCHAR(10)     NOT NULL,  -- OPEN | RESOLVED
  note               NVARCHAR(500)   NULL,
  created_at         DATETIME2(3)    NOT NULL CONSTRAINT DF_whs_rci_created DEFAULT (SYSUTCDATETIME()),
  updated_at         DATETIME2(3)    NOT NULL CONSTRAINT DF_whs_rci_updated DEFAULT (SYSUTCDATETIME()),
  resolved_at        DATETIME2(3)    NULL,
  resolved_by_emp_no VARCHAR(20)     NULL       -- reserved cho resolve thủ công (chưa dùng bởi worker)
);

-- 1 dòng OPEN duy nhất cho mỗi (type, allocation, notice)
CREATE UNIQUE INDEX UQ_whs_rci_dedup_open
  ON whs_reconcile_issue (dedup_key)
  WHERE status = 'OPEN';

-- sweep phase-2 / resolve theo allocation
CREATE INDEX IX_whs_rci_allocation
  ON whs_reconcile_issue (allocation_id, status);

-- resolve SHORTAGE cấp notice
CREATE INDEX IX_whs_rci_notice
  ON whs_reconcile_issue (notice_detail_id, status);

-- --------------------------------------------------------------------
-- BẢN POSTGRES (chỉ để tạo bảng test trong sandbox test-postgres;
-- KHÔNG dùng cho production — production dùng SQL Server phía trên):
--
-- CREATE TABLE whs_reconcile_issue (
--   id                 VARCHAR(40)   PRIMARY KEY,
--   dedup_key          VARCHAR(120)  NOT NULL,
--   issue_type         VARCHAR(20)   NOT NULL,
--   allocation_id      VARCHAR(40)   NULL,
--   notice_detail_id   NUMERIC(18,0) NULL,
--   po_id              NUMERIC(18,0) NOT NULL,
--   goods_no           VARCHAR(30)   NOT NULL,
--   slot_code          VARCHAR(20)   NULL,
--   difference_qty     NUMERIC(18,8) NOT NULL,
--   status             VARCHAR(10)   NOT NULL,
--   note               VARCHAR(500)  NULL,
--   created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
--   updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
--   resolved_at        TIMESTAMPTZ   NULL,
--   resolved_by_emp_no VARCHAR(20)   NULL
-- );
-- CREATE UNIQUE INDEX UQ_whs_rci_dedup_open
--   ON whs_reconcile_issue (dedup_key) WHERE status = 'OPEN';
-- CREATE INDEX IX_whs_rci_allocation
--   ON whs_reconcile_issue (allocation_id, status);
-- CREATE INDEX IX_whs_rci_notice
--   ON whs_reconcile_issue (notice_detail_id, status);
-- ====================================================================
