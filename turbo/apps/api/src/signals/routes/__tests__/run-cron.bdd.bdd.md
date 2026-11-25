# run-cron.bdd

## run-cron.bdd-001

- Vitest: "RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads > sets up run prerequisites through APIs and exposes the no-credit admission boundary"
- Mode: run
- Given: A signed-in member has a personal subscription model configured but no credits. A Runner group is configured.
- When: The member sends a chat message via `POST /api/chat/events`, reads `GET /api/runs/queue`, the Runner sends `POST /api/runners/heartbeat`, and the member reads `GET /api/runs/:id` and `GET /api/runs/:id/context` for a nonexistent Run ID.
- Then: The message is accepted but the Run is rejected with reason `insufficient_credits`. The queue shows 0 active Runs, and the Runner heartbeat returns `ok`. Both reads for the missing Run return HTTP 404 with code `NOT_FOUND`.

## run-cron.bdd-002

- Vitest: "RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads > keeps official runner held-sandbox heartbeat visible through public endpoints"
- Mode: run
- Given: An official Runner in a configured Runner group holds a reusable sandbox for a thread.
- When: The Runner sends `POST /api/runners/heartbeat` including that held sandbox state.
- Then: The heartbeat returns HTTP 200 with `ok` true.

## run-cron.bdd-003

- Vitest: "RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads > rejects runner metadata reads at unauthenticated and missing boundaries"
- Mode: run
- Given: A signed-in member and an unauthenticated caller; the requested Run ID does not exist.
- When: Each caller requests `GET /api/runs/:id/runner` for that Run ID.
- Then: The unauthenticated request returns HTTP 401 with code `UNAUTHORIZED`, and the member's request returns HTTP 404 with code `NOT_FOUND`.

## run-cron.bdd-004

- Vitest: "RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads > rejects unauthenticated and unauthorized runner, queue, read, context, and cancel requests"
- Mode: run
- Given: A signed-in member, an unauthenticated caller, and a Runner; the Run ID does not exist.
- When: The unauthenticated caller reads `GET /api/runs/queue`, `GET /api/runs/:id`, and `POST /api/runs/:id/cancel`; the member cancels the missing Run; an unauthenticated Runner and an authenticated Runner naming group `other/test` send `POST /api/runners/heartbeat`.
- Then: The unauthenticated queue, read and cancel return HTTP 401 with `UNAUTHORIZED`. The member's cancel returns 404 with `NOT_FOUND`. The unauthenticated heartbeat returns 401 with `UNAUTHORIZED`, and the `other/test` heartbeat returns 400 with `BAD_REQUEST`.

## run-cron.bdd-005

- Vitest: "RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads > issues runner realtime tokens only for authenticated vm0 runner groups"
- Mode: run
- Given: A Runner requests realtime tokens; the realtime provider issues a subscribe-only token for `runner-group:vm0/test`.
- When: An unauthenticated Runner requests `POST /api/runners/realtime/token` for `vm0/test`, an authenticated Runner requests it for `other/test`, and an authenticated Runner requests it for `vm0/test`.
- Then: The unauthenticated request returns HTTP 401 with `UNAUTHORIZED` and the `other/test` request returns 403 with `FORBIDDEN`. The `vm0/test` request returns HTTP 200 with the issued capability; exactly one token is requested from the provider, with subscribe capability on `runner-group:vm0/test` and a one-hour TTL.

## run-cron.bdd-006

- Vitest: "SCHED-02: cron routes > rejects invalid cron auth on shared cron routes"
- Mode: run
- Given: A caller has no valid cron authorization.
- When: The caller invokes the shared cron routes `/api/cron/process-usage-events` and `/api/cron/telegram-cleanup` without cron auth.
- Then: Every cron route responds with HTTP 401.
