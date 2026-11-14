-- Apply before deploying the API and workers. Existing timestamps stay unknown.
IF COL_LENGTH('dbo.whs_slot_allocation', 'status_recorded_at') IS NULL
BEGIN
    ALTER TABLE dbo.whs_slot_allocation ADD status_recorded_at DATETIME2 NULL;
END;
GO
