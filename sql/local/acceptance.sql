SET NOCOUNT ON;
IF USER_NAME() <> N'$(LocalDabUser)'
    THROW 51000, 'Acceptance must use the least-privilege app identity.', 1;
IF IS_ROLEMEMBER(N'db_owner') = 1 OR HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL') = 1
    THROW 51001, 'App identity must not have administrative permissions.', 1;
IF IS_ROLEMEMBER(N'db_datareader') = 1 OR IS_ROLEMEMBER(N'db_datawriter') = 1
    THROW 51002, 'App identity must reach data only through granted procedures, not database-wide read or write roles.', 1;
PRINT N'LOCAL SQL ACCEPTANCE PASSED';