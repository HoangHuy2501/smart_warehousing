-- Run in the WHS database. Preview first, then stop app and outbound-worker
-- before applying and deploying the live-stock version together.
-- Receipt qty_in_stock is the original IQC quantity. Picked rows are durable.
DECLARE @Apply BIT = 0;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @lock_result INT;
    EXEC @lock_result = sys.sp_getapplock
        @Resource = 'whs-outbound', @LockMode = 'Exclusive',
        @LockOwner = 'Transaction', @LockTimeout = 15000;
    IF @lock_result < 0 THROW 50001, 'outbound_lock_timeout', 1;

    SELECT p.allocation_id, SUM(p.picked_qty) AS picked_qty
    INTO #outbound_picked
    FROM dbo.whs_outbound_pick AS p
    WHERE p.picked_at IS NOT NULL AND p.picked_qty > 0
    GROUP BY p.allocation_id;

    SELECT p.allocation_id,
           a.slot_code,
           a.qty_in_stock AS before_qty,
           q.received_qty AS original_qty,
           p.picked_qty,
           CASE
               WHEN a.status = 'IN_STOCK' AND q.received_qty >= p.picked_qty
               THEN CAST(q.received_qty AS DECIMAL(18,8)) -
                    CAST(p.picked_qty AS DECIMAL(18,8))
           END AS after_qty
    INTO #outbound_stock_preview
    FROM #outbound_picked AS p
    LEFT JOIN dbo.whs_slot_allocation AS a ON a.id = p.allocation_id
    OUTER APPLY (
        SELECT SUM(r.qty_in_stock) AS received_qty
        FROM dbo.whs_allocation_receipt AS r
        WHERE r.allocation_id = p.allocation_id
    ) AS q;

    SELECT * FROM #outbound_stock_preview
    ORDER BY slot_code, allocation_id;

    IF @Apply = 1
    BEGIN
        IF EXISTS (
            SELECT 1 FROM #outbound_stock_preview
            WHERE after_qty IS NULL OR before_qty IS NULL
               OR (before_qty <> original_qty AND before_qty <> after_qty)
        )
            THROW 50002, 'Review missing or inconsistent outbound allocations before applying', 1;

        UPDATE a
        SET a.qty_in_stock = p.after_qty,
            a.closed_at = CASE
                WHEN p.after_qty = 0 AND COALESCE(a.qty_return, 0) = 0
                THEN COALESCE(a.closed_at, SYSUTCDATETIME())
                ELSE a.closed_at
            END
        FROM dbo.whs_slot_allocation AS a
        JOIN #outbound_stock_preview AS p ON p.allocation_id = a.id;
    END;

    DROP TABLE #outbound_stock_preview;
    DROP TABLE #outbound_picked;
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
