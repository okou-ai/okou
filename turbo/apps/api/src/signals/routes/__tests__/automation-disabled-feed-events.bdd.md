# automation-disabled-feed-events

## automation-disabled-feed-events-001

- Vitest: "recurring automation auto-disable platform feed events > keeps platform events intact when an Agent reuses their identity for a suggestion"
- Mode: run
- Given: At 2030-01-01T12:00Z, a workspace owner has a private workflow with an enabled automation on an every-minute cron schedule, and three manual Runs have failed so the automation was auto-disabled and the owner's feed has its disable event. The owner then starts a chat Run whose sandbox carries an Okou token; a peer in the same workspace and the same user in another workspace also exist.
- When: The agent calls `POST /api/feed/items` to create a suggestion reusing the platform event's ID; the peer and other-workspace user read `GET /api/feed/items?type=event` and dismiss the event; the owner dismisses it via `POST /api/feed/items/:id/dismiss`.
- Then: The agent's create returns HTTP 409 and the owner's feed still contains exactly the original event. The peer and other-workspace user see no events and their dismissals return HTTP 404. The owner's dismissal returns HTTP 204, the owner's feed becomes empty, and the automation stays disabled with `nextRunAt` null.

## automation-disabled-feed-events-002

- Vitest: "recurring automation auto-disable platform feed events > excludes credit failures and deduplicates the runtime disable feed event"
- Mode: run
- Given: At 2030-01-01T12:00Z, a workspace owner has a private workflow with an enabled automation on a 60-second loop schedule.
- When: Twice, the owner starts a manual Run (`POST /api/workflow-automations/:id/run`) and the sandbox reports completion with exit code 1 and error "Scheduled execution failed" (muting the automation thread the first time); then a Run fails with `insufficient_credits`; then a fourth Run fails normally and its completion webhook is delivered again. The owner then toggles feed sources via `PATCH /api/feed/sources` and checks `GET /api/feed/summary`, `GET /api/feed/sources` and `POST /api/feed/items/:id/read`.
- Then: After two ordinary failures and the credit failure the automation stays enabled and the feed has no events. The next ordinary failure disables it (`nextRunAt` null) and the feed has exactly one event: an active `automation-disabled` platform event with no expiry containing the automation, workflow and workspace IDs, the workflow name and description, the disable time, `consecutiveFailures` 3 and `recoveryScheduled` false; the repeated completion adds no event. With suggestions, what's-new and offers off, the summary still has unread items; with system updates off it has none, while the event list is unchanged; re-enabling suggestions and offers leaves `systemUpdates` false and no unread; re-enabling system updates restores unread, and marking the event read clears it. The automation stays disabled.

## automation-disabled-feed-events-003

- Vitest: "recurring automation auto-disable platform feed events > stops future system update deliveries until enabled again without changing automation failure handling"
- Mode: run
- Given: At 2030-01-01T12:00Z, a workspace owner has a private workflow with an enabled automation on an every-minute cron schedule.
- When: The owner turns system updates off via `PATCH /api/feed/sources`; three times, the owner starts a manual Run (`POST /api/workflow-automations/:id/run`) and the sandbox reports completion with exit code 1 and error "Scheduled execution failed"; the owner turns system updates on, re-enables the automation via `POST /api/workflow-automations/:id/enable`, and three more manual Runs fail.
- Then: The sources update returns exactly suggestions, what's-new and offers true and `systemUpdates` false. After the first three failures the automation is disabled and the feed has no events, and turning system updates back on does not backfill one. After the next three failures the automation is disabled again and the feed has exactly one event: an active `automation-disabled` platform event with no expiry containing the automation, workflow and workspace IDs, the workflow name and description, the disable time, `consecutiveFailures` 3 and `recoveryScheduled` false.

## automation-disabled-feed-events-004

- Vitest: "recurring automation auto-disable platform feed events > does not emit for a manual disable and can emit again after re-enabling"
- Mode: run
- Given: At 2030-01-01T12:00Z, a workspace owner has a private workflow with an enabled automation on an every-minute cron schedule.
- When: The owner disables it with `POST /api/workflow-automations/:id/disable`; then twice the owner re-enables it with `POST /api/workflow-automations/:id/enable` and three manual Runs fail.
- Then: After the manual disable the feed has no events. After the first cycle of three failures there is one event, and after the second cycle there are two.

## automation-disabled-feed-events-005

- Vitest: "recurring automation auto-disable platform feed events > does not emit when a one-time schedule stops after its attempt"
- Mode: run
- Given: At 2030-01-01T12:00Z, a workspace owner has a private workflow with an enabled automation on a one-time schedule one minute ahead, and the clock is at the scheduled time.
- When: The scheduler calls `GET /api/cron/execute-workflow-automations` with the cron secret, and the resulting Run's sandbox reports completion with exit code 1.
- Then: The cron call returns HTTP 200 and the scheduled Run appears in the automation thread. The Run is `failed`, the automation is disabled with `nextRunAt` null, and the owner's feed has no events.

## automation-disabled-feed-events-006

- Vitest: "recurring automation auto-disable platform feed events > admits one cron occurrence when two scheduler ticks overlap"
- Mode: run
- Given: At 2030-01-01T12:00Z, a workspace owner has a private workflow with an enabled automation on an every-minute cron schedule, and the clock is at its next occurrence.
- When: Two concurrent scheduler ticks call `GET /api/cron/execute-workflow-automations` with the cron secret, and the admitted Run then completes successfully.
- Then: Both ticks return HTTP 200 and together report exactly one executed automation; the thread has exactly one prompt with a Run. After success the automation is enabled with `nextRunAt` one minute after the occurrence.

## automation-disabled-feed-events-007

- Vitest: "recurring automation auto-disable platform feed events > admits one loop occurrence when two scheduler ticks overlap"
- Mode: run
- Given: At 2030-01-01T12:00Z, a workspace owner has a private workflow with an enabled automation on a 60-second loop schedule, and the clock is at its next occurrence.
- When: Two concurrent scheduler ticks call `GET /api/cron/execute-workflow-automations` with the cron secret, and the admitted Run then completes successfully.
- Then: Both ticks return HTTP 200 and together report exactly one executed automation; the thread has exactly one prompt with a Run. After success the automation is enabled with `nextRunAt` 60 seconds after the occurrence.

## automation-disabled-feed-events-008

- Vitest: "recurring automation auto-disable platform feed events > publishes a feed event after three run preparation failures"
- Mode: run
- Given: At 2030-01-01T12:00Z, a workspace owner has a private workflow with an enabled automation on an every-minute cron schedule, and storage cannot sign URLs, so Run preparation fails.
- When: Three times, the clock moves to the next occurrence and the scheduler calls `GET /api/cron/execute-workflow-automations` with the cron secret.
- Then: Each cron call returns HTTP 200 and the background preparation fails with "Run execution preparation failed". The automation stays enabled after the first two failures and is disabled after the third. The owner's feed then has exactly one event: an active `automation-disabled` platform event with no expiry containing the automation, workflow and workspace IDs, the workflow name and description, the disable time, `consecutiveFailures` 3 and `recoveryScheduled` false.
