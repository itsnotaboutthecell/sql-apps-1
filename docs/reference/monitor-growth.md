# Monitor usage and decide when to grow

Use this workflow after deploying to **Azure SQL Database**: observe a real app action, investigate the limiting resource, make an approved change, and check the result. Start with [Costs and growth](../guides/costs.md) for the billing choices.

SQL Apps deployment checks are readiness checks, not live usage monitoring; use the Azure Cost plugin for actual spend and forecasts. This page does not provide an alternative provisioning path.

## 1. Connect Database Hub for free monitoring

[Database Hub in Microsoft Fabric](https://learn.microsoft.com/fabric/database/hub/overview) brings together existing database resources without moving their data into Fabric.

As documented on 2026-10-09, it is **preview**, available with a **Fabric Free license**, and requires no Fabric capacity or separate Database Hub license to get started. [Enabling SQL performance monitoring](https://learn.microsoft.com/fabric/database/hub/add-sql) has no extra cost and requires no monitoring agents or data stores for you to deploy. This does not make your database, Azure hosting or optional downstream services free.

For your deployed Azure SQL database:

1. Ask your Fabric administrator to enable **Users can access the Database hub (preview)** in tenant settings.
2. Sign in to [Database Hub](https://powerbi.com/workloads/fdh/databaseHub) with your work or school account. Discovery requires subscription **Reader** access or greater and permission to read resource metadata and Azure Monitor metrics. This does not grant database query permissions.
3. Confirm `Microsoft.Sql` is registered for the selected subscription. Follow the official setup instructions if registration is needed; registration is a separate approved subscription change.
4. In **Estate**, select the intended database and choose **Enable Performance Monitoring**. This is an opt-in configuration change, not a read-only inspection. Have an authorized owner approve it and review preview regional availability/data handling first.
5. Open **Performance** and confirm the selected database and time range before interpreting charts. If data is missing, check tenant settings, access, provider registration and monitoring enablement; an empty chart is not proof of low usage.

Use the [current setup](https://learn.microsoft.com/fabric/database/hub/add-sql) and [monitoring instructions](https://learn.microsoft.com/fabric/database/hub/monitor-sql) for permissions and preview limitations. Performance monitoring currently excludes elastic-pool databases and secondary replicas. This is a cloud workflow, not monitoring for the local SQL preview container.

To check the database's opt-in metadata without changing it, connect to the deployed **application database**, not `master`, with an authorized operator identity:

```sql
SELECT name, value
FROM sys.extended_properties
WHERE class = 0
  AND name = N'MS_EnablePerformanceMonitoringPreview';
```

A value of `true` records the opt-in; it does not prove telemetry has arrived or that the app is healthy. Do not enable it by adding an unreviewed startup migration. To disable collection, use the official disable instructions.

## 2. Check allowance and spending separately

Database performance percentages are not a billing meter.

- In the Azure portal, check SQL's **Free monthly vCore amount** / **Free amount remaining**. Review consumption through the month and configure an approved remaining-compute alert before exhaustion.
- Review Container Apps grants across the subscription, not just this application.
- In Cost Management, check actual and forecast costs for both the application resource group and the Container Apps managed infrastructure group. Include registry/network charges.
- Configure budget alerts with reviewed recipients and thresholds if needed. Alerts are delayed notifications, not a hard spending cap.

Keep free-tier SQL pause-at-monthly-limit behavior unless the owner deliberately chooses another reviewed billing plan. Database Hub is not an automatic upgrade or billing-control mechanism. Use the Azure Cost plugin and [costs and growth](../guides/costs.md) for current allowances and billing-policy caveats.

## 3. Investigate a real slow action

Record the action, UTC time, observed delay and selected database: for example, creating and reloading a test item. Use approved synthetic records, not a production load test. Compare that time window in Database Hub.

For a direct check, use your SQL editor to connect to the same **Azure SQL application database** with a separate operator identity that has `VIEW DATABASE STATE`. Subscription Reader alone is not enough; do not broaden the application's execute-only or least-privilege login to run diagnostics.

### Recent resource samples

```sql
SELECT TOP (40)
    end_time AS sample_end_utc,
    avg_cpu_percent,
    avg_data_io_percent,
    avg_log_write_percent,
    max_worker_percent,
    max_session_percent
FROM sys.dm_db_resource_stats
ORDER BY end_time DESC;
```

The view samples every 15 seconds and retains approximately one hour. Forty rows cover roughly ten minutes if all samples are present. Percentages measure the current service-tier limits, not physical machine utilization or remaining free allowance.

### Sustained pressure versus a brief spike

```sql
SELECT
    COUNT(*) AS sample_count,
    MIN(end_time) AS first_sample_utc,
    MAX(end_time) AS last_sample_utc,
    AVG(avg_cpu_percent) AS mean_cpu_percent,
    MAX(avg_cpu_percent) AS peak_cpu_percent,
    AVG(avg_data_io_percent) AS mean_data_io_percent,
    MAX(avg_data_io_percent) AS peak_data_io_percent,
    AVG(avg_log_write_percent) AS mean_log_write_percent,
    MAX(avg_log_write_percent) AS peak_log_write_percent,
    MAX(max_worker_percent) AS peak_worker_percent,
    MAX(max_session_percent) AS peak_session_percent
FROM sys.dm_db_resource_stats
WHERE end_time >= DATEADD(minute, -15, SYSUTCDATETIME());
```

Read `sample_count` and the actual time range first. Zero samples or a permission error is a diagnostic gap, not a healthy result. Failover can shorten the history. Do not run these cloud-only resource-stat queries against the local preview container: that view is unavailable there.

## 4. Choose the smallest useful change

| What you observe | What to investigate before paying for more |
| --- | --- |
| High CPU during slow actions | Expensive queries, unnecessary scans, missing indexes and repeated requests. |
| High data IO | Excessive reads, unbounded lists and query/index design. |
| High log-write usage | Large or frequent writes, batching and avoidable updates. |
| High worker/session usage | Blocking, parallel queries, pool lifetime and concurrent background work. |
| Free allowance running out without resource pressure | Total active time, polling and idle behavior; performance tuning alone might not meet availability needs. |
| Slow first visit but normal later actions | SQL resume/cold starts; buying query capacity is not automatically the right fix. |

Use Database Hub to identify the affected resource and continue in your SQL tooling for query-level investigation. A single peak does not establish a scaling requirement. High memory utilization alone is not proof of a fault: SQL uses memory for its cache.

If people need availability beyond the free allowance, or measured pressure persists after appropriate tuning, review paid sizing, recurring supporting charges and recovery requirements with the owner. Never silently enable paid continuation or treat an alert as approval to spend.

## 5. Verify the outcome

After an approved query or capacity change, repeat the same app action under comparable conditions. Record:

- Whether saving and reloading still works, including user isolation.
- Response time before and after.
- Resource samples for matching windows, with the affected metric identified.
- Actual allowance/cost trends once billing data catches up.

Success means the user's workflow improved without losing correctness or creating unapproved costs, not simply that the database is on a bigger tier.

## References

- [Database Hub free experience and limitations](https://learn.microsoft.com/fabric/database/hub/overview)
- [Enable SQL performance monitoring and data handling](https://learn.microsoft.com/fabric/database/hub/add-sql)
- [Monitor Microsoft SQL in Database Hub](https://learn.microsoft.com/fabric/database/hub/monitor-sql)
- [Azure SQL resource-stat view, retention and permissions](https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-db-resource-stats-azure-sql-database)
