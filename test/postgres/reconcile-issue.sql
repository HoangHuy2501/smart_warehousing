CREATE TABLE whs_reconcile_issue (
  id                 VARCHAR(40)   PRIMARY KEY,
  dedup_key          VARCHAR(120)  NOT NULL,
  issue_type         VARCHAR(20)   NOT NULL,
  allocation_id      VARCHAR(40)   NULL,
  notice_detail_id   NUMERIC(18,0) NULL,
  po_id              NUMERIC(18,0) NOT NULL,
  goods_no           VARCHAR(30)   NOT NULL,
  slot_code          VARCHAR(20)   NULL,
  difference_qty     NUMERIC(18,8) NOT NULL,
  status             VARCHAR(10)   NOT NULL,
  note               VARCHAR(500)  NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ   NULL,
  resolved_by_emp_no VARCHAR(20)   NULL
);
CREATE UNIQUE INDEX UQ_whs_rci_dedup_open
  ON whs_reconcile_issue (dedup_key) WHERE status = 'OPEN';
CREATE INDEX IX_whs_rci_allocation
  ON whs_reconcile_issue (allocation_id, status);
CREATE INDEX IX_whs_rci_notice
  ON whs_reconcile_issue (notice_detail_id, status);
