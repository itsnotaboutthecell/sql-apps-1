-- Read-only readiness procedure behind role-based-data.json readinessPath. Replace or extend with your own procedures.
CREATE PROCEDURE dbo.AppReady
AS
SET NOCOUNT ON;
SELECT CAST(1 AS bit) AS ready, DB_NAME() AS [database], SYSUTCDATETIME() AS checked_at;