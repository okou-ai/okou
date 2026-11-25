# vercel-crons

## vercel-crons-001

- Vitest: "vercel cron config > matches API-owned cron schedules"
- Mode: run
- Intent: review
- Given: The committed Vercel config and the API-owned path and schedule inventory are present.
- When: The deployed cron declarations are compared with the inventory in the test.
- Then: The arrays match exactly in order, path and schedule. The ordered entries are listed below.

  1. `/api/cron/reconcile-image-generations` at `* * * * *`
  2. `/api/cron/process-background-jobs` at `* * * * *`
  3. `/api/cron/cleanup-sandboxes` at `* * * * *`
  4. `/api/cron/cleanup-x-resource-reads` at `0 * * * *`
  5. `/api/cron/monitor-chat-event-queue` at `* * * * *`
  6. `/api/cron/project-chat-event-search` at `* * * * *`
  7. `/api/cron/snapshot-chat-events` at `*/10 * * * *`
  8. `/api/cron/retain-chat-events` at `* * * * *`
  9. `/api/cron/execute-workflow-automations` at `* * * * *`
  10. `/api/cron/renew-gmail-watches` at `0 */12 * * *`
  11. `/api/cron/renew-google-forms-watches` at `0 */12 * * *`
  12. `/api/cron/renew-google-calendar-watches` at `0 */12 * * *`
  13. `/api/cron/renew-google-workspace-event-subscriptions` at `0 */12 * * *`
  14. `/api/cron/compact-chat-thread-snapshots` at `*/10 * * * *`
  15. `/api/cron/reconcile-artifact-catalog` at `* * * * *`
  16. `/api/cron/compact-usage-events` at `* * * * *`
  17. `/api/cron/telegram-cleanup` at `0 1 * * *`
  18. `/api/cron/connector-oauth-state-cleanup` at `15 * * * *`
  19. `/api/cron/cleanup-suggestions` at `0 * * * *`
  20. `/api/cron/drain-email-outbox` at `* * * * *`
  21. `/api/cron/sync-skills` at `* * * * *`
  22. `/api/cron/sync-connector-catalog` at `*/10 * * * *`
  23. `/api/cron/sync-official-workflow-catalog` at `* * * * *`
  24. `/api/cron/process-usage-events` at `* * * * *`
  25. `/api/cron/reconcile-billing-entitlements` at `0 * * * *`
  26. `/api/cron/prune-storage-presigned-urls` at `* * * * *`
  27. `/api/cron/computer-use-screenshot-cleanup` at `0 * * * *`
  28. `/api/cron/reconcile-browsers` at `* * * * *`
  29. `/api/cron/steer-run-time-budget` at `* * * * *`

## vercel-crons-002

- Vitest: "vercel cron config > targets existing API routes without duplicate paths"
- Mode: run
- Intent: review
- Given: The committed Vercel cron declarations and production API route registry are available.
- When: The cron target paths are checked against the registry.
- Then: Every path is registered and each appears only once in the cron configuration.
