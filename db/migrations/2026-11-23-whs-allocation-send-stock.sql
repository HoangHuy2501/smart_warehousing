-- Chạy trên database WHS trước khi triển khai API gửi phiếu T8.
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.whs_slot_allocation', N'U') IS NULL
    THROW 50001, N'Không tìm thấy dbo.whs_slot_allocation trong database hiện tại.', 1;

BEGIN TRY
    BEGIN TRANSACTION;

    IF EXISTS (
        SELECT 1
        FROM sys.check_constraints
        WHERE parent_object_id = OBJECT_ID(N'dbo.whs_slot_allocation', N'U')
          AND name = N'CK_whs_alloc_status'
    )
        ALTER TABLE dbo.whs_slot_allocation DROP CONSTRAINT CK_whs_alloc_status;

    ALTER TABLE dbo.whs_slot_allocation WITH CHECK
        ADD CONSTRAINT CK_whs_alloc_status CHECK (
            status IN ('WAITING_IQC', 'WAITING_STOCK', 'SEND_STOCK',
                       'IN_STOCK', 'RETURNED', 'AOD_PENDING')
        );

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0
        ROLLBACK TRANSACTION;
    THROW;
END CATCH;
