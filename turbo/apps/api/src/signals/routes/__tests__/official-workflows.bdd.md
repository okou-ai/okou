# official-workflows

## official-workflows-001

- Vitest: "My Okou proactive settings > sets hourly checks and new suggestion delivery together without changing other sources or legacy clients"
- Mode: run
- Given: A newly created workspace's member (organization created via a signed Clerk `organization.created` webhook) has hourly proactive checks off, and has turned feed offers off via `PATCH /api/feed/sources`.
- When: The member sets `PUT /api/preferences/proactive-suggestions/with-feed` to `false` then `true`, reading `GET /api/preferences/proactive-suggestions` and `GET /api/feed/sources` after each; finally a legacy client sets `PUT /api/preferences/proactive-suggestions` to `false`.
- Then: Initially hourly checks are disabled and feed suggestions are enabled. After each combined update the hourly preference matches the chosen value and the feed sources are exactly `{ suggestions: <value>, offers: false, whatsNew: true, systemUpdates: true }`. After the legacy update the feed suggestions source is still enabled.

## official-workflows-002

- Vitest: "Daily profile learning through Suggestions > keeps an opt-in cancellable while the Learning time zone is unavailable"
- Mode: run
- Given: A newly created workspace's onboarded member has no Learning time zone available.
- When: The member enables `PUT /api/preferences/proactive-suggestions`, disables it, sets their time zone to `Asia/Shanghai`, and reads `GET /api/preferences/proactive-suggestions`.
- Then: Enabling returns `enabled: true`, `status: "preparing"` and `unavailableReason: "missing-timezone"`. Disabling returns `enabled: false`, `status: "paused"`. The final read returns `enabled: false`, `status: "paused"` and no unavailable reason.

## official-workflows-003

- Vitest: "Proactive Suggestions preference > keeps the shared Suggestions choice while the catalog is unavailable"
- Mode: run
- Given: A newly created workspace's onboarded member while the Suggestions catalog is unavailable.
- When: The member reads `GET /api/preferences/proactive-suggestions`, enables it via `PUT`, reads `GET /api/preferences/morning-brief`, reads Suggestions again, and disables it.
- Then: The initial read is `enabled: false`, `paused`; enabling returns `enabled: true`, `preparing`. The Morning Brief preference stays disabled, the reread keeps Suggestions enabled, and disabling returns `enabled: false`, `paused`.

## official-workflows-004

- Vitest: "Morning Brief preference > preserves enable intent while timezone is unavailable"
- Mode: run
- Given: A workspace member without a time zone.
- When: The member reads `GET /api/preferences/morning-brief`, enables it via `PUT /api/preferences/morning-brief`, and lists `GET /api/workflows`.
- Then: The read returns `enabled: false` with `unavailableReason: "missing-timezone"`. The update returns HTTP 200 with `status: "preparing"`, `enabled: true` and `unavailableReason: "missing-timezone"`. No official Morning Brief workflow appears in the list.

## official-workflows-005

- Vitest: "Workflow schedule recovery > completes an in-flight user schedule using its edited recurrence"
- Mode: run
- Given: At 2030-01-01T00:00Z a member in UTC has a workflow with a 10-minute loop automation, and a Runner is available.
- When: The member runs the automation now (`POST /api/workflow-automations/:id/run`), at 00:10 edits it to cron `*/5 * * * *` in UTC via `PATCH`, the in-flight Run completes successfully at 00:16, and the member reads `GET /api/workflow-automations/:id`.
- Then: The launched Runner execution uses `claude-code`. The edit returns the cron schedule with next run `2030-01-01T00:15:00.000Z`. After completion the automation is still enabled with the cron schedule and next run `2030-01-01T00:20:00.000Z`.

## official-workflows-006

- Vitest: "Workflow schedule recovery > stops a user-created schedule after three failed manual runs"
- Mode: run
- Given: A member in UTC has a workflow with a 10-minute loop automation, and a Runner is available.
- When: Three times, one minute apart, the member runs the automation now and the Run completes with exit code 1 ("Managed provider temporarily unavailable"), then reads the automation.
- Then: After the third failed manual Run the automation reads `enabled: false` with `nextRunAt: null`.

## official-workflows-007

- Vitest: "Morning Brief initialization > keeps recovery of an absent brief free of installation side effects"
- Mode: run
- Given: A newly created workspace's member initialized preferences in `Asia/Tokyo` and later changed their time zone to `Asia/Shanghai`; no Morning Brief is installed.
- When: The member calls `POST /api/preferences/morning-brief/retry`.
- Then: The response is HTTP 200 with `enabled: false` and `status: "paused"`, and no official Morning Brief workflow is installed.

## official-workflows-008

- Vitest: "Morning Brief initialization > keeps an explicit timezone choice when initialization runs later"
- Mode: run
- Given: A newly created workspace's member explicitly set their time zone to `Asia/Tokyo`.
- When: The member calls `POST /api/user-preferences/initialize` with time zone `America/Los_Angeles`, then reads `GET /api/user-preferences`.
- Then: Initialization returns time zone `Asia/Tokyo`, and the reread also returns `Asia/Tokyo`.

## official-workflows-009

- Vitest: "Debug Morning Brief > requires a signed-in session and Okou Debug"
- Mode: run
- Given: An anonymous caller, and a signed-in workspace member with the Okou Debug feature switch off.
- When: Each calls `POST /api/debug/morning-brief` with a request ID and `GET /api/debug/morning-brief/:id`.
- Then: The anonymous requests return HTTP 401, and the member's requests return HTTP 403.

## official-workflows-010

- Vitest: "Workflow Run admission > captures ordinary Workflows at dispatch and applies edits to later Runs"
- Mode: run
- Given: A chat member with model `claude-fable-5-1` has published two ordinary workflows with distinct instructions.
- When: The member sends a chat Run, then updates the first workflow's instruction via `PATCH /api/workflows/:workflowId`, then sends a second chat Run; both Runner executions are read and failed.
- Then: Each execution has 2 plus the built-in count of skill bundles. In the first Run both workflow `SKILL.md` files contain their original instructions; in the second Run the first workflow contains the revised instruction and the other keeps its original.

## official-workflows-011

- Vitest: "Workflow Run admission > launches an idle ordinary workflow input with source annotations"
- Mode: run
- Given: A chat member owns an ordinary workflow, and a running source chat Run holds its Okou run token.
- When: The source Run calls `POST /api/workflows/:workflowId/run` with origin `https://app.okou.ai`.
- Then: The response is HTTP 200 with `runId: null` and a new chat thread different from the source thread. A Run different from the source Run launches on that thread with prompt `/<workflow name>`, and its appended system prompt contains `SOURCE_RUN_ID: <source run>` and `SOURCE_THREAD_ID: <source thread>`.
