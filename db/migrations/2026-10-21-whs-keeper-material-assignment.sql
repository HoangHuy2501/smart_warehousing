-- =============================================================
-- Migration 2026-10-21: bảng whs_keeper_material_assignment
-- Lịch sử phân công NPL -> THỦ KHO (kho thông minh Phase 2)
--
-- Đã chạy THÀNH CÔNG trên SQL Server thật của team (user xác nhận
-- 2026-10-21). Script idempotent: chạy lại không tạo trùng.
--
-- Đối tác code:
--   - src/repository/sql/queries/material.queries.js (SQL hàm)
--   - src/repository/sql/material.repository.js        (Model)
--   - /pos JOIN: IX_whs_kma_keeper_active
--   - history:   IX_whs_kma_goods_history
--   - assign chạy trong db.withTransaction -> không vi phạm UQ
-- =============================================================

SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRAN;

    /* =========================================================
       1. TABLE: lịch sử phân công NPL -> Keeper
       ========================================================= */

    IF OBJECT_ID('dbo.whs_keeper_material_assignment', 'U') IS NULL
    BEGIN
        CREATE TABLE dbo.whs_keeper_material_assignment
        (
            id                  VARCHAR(40)  NOT NULL,
            goods_no            VARCHAR(30)  NOT NULL,
            keeper_emp_no       VARCHAR(20)  NOT NULL,
            assigned_by_emp_no  VARCHAR(20)  NOT NULL,

            assigned_at         DATETIME2(3) NOT NULL,
            ended_at            DATETIME2(3) NULL,

            note                NVARCHAR(200) NULL,

            CONSTRAINT PK_whs_keeper_material_assignment
                PRIMARY KEY (id),

            CONSTRAINT FK_whs_kma_keeper
                FOREIGN KEY (keeper_emp_no)
                REFERENCES dbo.whs_user_role(emp_no),

            CONSTRAINT FK_whs_kma_assigner
                FOREIGN KEY (assigned_by_emp_no)
                REFERENCES dbo.whs_user_role(emp_no),

            CONSTRAINT CK_whs_kma_period
                CHECK (
                    ended_at IS NULL
                    OR ended_at >= assigned_at
                )
        );
    END;


    /* =========================================================
       2. Một goods_no chỉ có 1 Keeper active tại một thời điểm
       ========================================================= */

    IF NOT EXISTS
    (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID('dbo.whs_keeper_material_assignment')
          AND name = 'UQ_whs_kma_goods_active'
    )
    BEGIN
        CREATE UNIQUE INDEX UQ_whs_kma_goods_active
        ON dbo.whs_keeper_material_assignment(goods_no)
        WHERE ended_at IS NULL;
    END;


    /* =========================================================
       3. Index phục vụ GET /pos cho Keeper

       EXISTS:
         keeper_emp_no = @currentEmpNo
         goods_no      = o2.goods_no
         ended_at IS NULL
       ========================================================= */

    IF NOT EXISTS
    (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID('dbo.whs_keeper_material_assignment')
          AND name = 'IX_whs_kma_keeper_active'
    )
    BEGIN
        CREATE INDEX IX_whs_kma_keeper_active
        ON dbo.whs_keeper_material_assignment
        (
            keeper_emp_no,
            goods_no
        )
        INCLUDE
        (
            assigned_at,
            assigned_by_emp_no
        )
        WHERE ended_at IS NULL;
    END;


    /* =========================================================
       4. Index phục vụ xem lịch sử một mã NPL
       ========================================================= */

    IF NOT EXISTS
    (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID('dbo.whs_keeper_material_assignment')
          AND name = 'IX_whs_kma_goods_history'
    )
    BEGIN
        CREATE INDEX IX_whs_kma_goods_history
        ON dbo.whs_keeper_material_assignment
        (
            goods_no,
            assigned_at DESC
        )
        INCLUDE
        (
            keeper_emp_no,
            assigned_by_emp_no,
            ended_at
        );
    END;

    COMMIT TRAN;

    PRINT 'whs_keeper_material_assignment migration SUCCESS';

END TRY
BEGIN CATCH

    IF @@TRANCOUNT > 0
        ROLLBACK TRAN;

    THROW;

END CATCH;
