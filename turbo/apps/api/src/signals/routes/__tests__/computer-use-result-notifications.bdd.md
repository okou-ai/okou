# computer-use-result-notifications

## computer-use-result-notifications-001

- Vitest: "Computer Use CLI result subscriptions > issues an exact subscribe-only command grant only when a read caller opts in"
- Mode: run
- Given: A signed-in workspace admin has a registered Desktop host, and the realtime provider signs token requests (row: read).
- When: The member creates an `apps.list` read command via `POST /api/computer-use/commands` with `realtime: true` and a 10 s timeout, then creates another without `realtime`; a different user then reads the first command.
- Then: The opted-in create returns `realtime` with channel `computer-use-result:<userId>:<orgId>:<commandId>`, event `resultChanged`, and a token request for the user's client ID with a 70,000 ms TTL and only `subscribe` on that channel. The non-opted create returns exactly `{ commandId, status: "queued" }`, only one token request is issued in total, and the other user's read returns HTTP 404.

## computer-use-result-notifications-002

- Vitest: "Computer Use CLI result subscriptions > issues an exact subscribe-only command grant only when a write caller opts in"
- Mode: run
- Given: A signed-in workspace admin has a registered Desktop host, and the realtime provider signs token requests (row: write).
- When: The member creates an `app.open` Safari write command via `POST /api/computer-use/write-commands` with `realtime: true` and a 10 s timeout, then creates a read command without `realtime`; a different user then reads the first command.
- Then: The opted-in create returns `realtime` with channel `computer-use-result:<userId>:<orgId>:<commandId>`, event `resultChanged`, and a token request for the user's client ID with a 70,000 ms TTL and only `subscribe` on that channel. The non-opted create returns exactly `{ commandId, status: "queued" }`, only one token request is issued in total, and the other user's read returns HTTP 404.

## computer-use-result-notifications-003

- Vitest: "Computer Use CLI result subscriptions > notifies a durable succeeded result once and keeps completion idempotent"
- Mode: run
- Given: A signed-in workspace admin's Desktop host has claimed an `apps.list` command created with `realtime: true` (row: succeeded).
- When: The Desktop posts the same successful completion twice to `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`.
- Then: Both completions return HTTP 200. When `resultChanged` is published the command already reads `succeeded`; the final read is `succeeded`, and `resultChanged` is published only on the command's result channel with a null payload.

## computer-use-result-notifications-004

- Vitest: "Computer Use CLI result subscriptions > notifies a durable failed result once and keeps completion idempotent"
- Mode: run
- Given: A signed-in workspace admin's Desktop host has claimed an `apps.list` command created with `realtime: true` (row: failed).
- When: The Desktop posts the same `permission_denied` failure twice to `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete`.
- Then: Both completions return HTTP 200. When `resultChanged` is published the command already reads `failed`; the final read is `failed`, and `resultChanged` is published only on the command's result channel with a null payload.

## computer-use-result-notifications-005

- Vitest: "Computer Use CLI result subscriptions > publishes one timeout result and does not let a late completion overwrite it"
- Mode: run
- Given: A signed-in workspace admin's Desktop host has claimed a realtime `apps.list` command with a 1000 ms timeout, and the clock advances 2 seconds.
- When: The member reads the command twice concurrently, then the Desktop posts a late successful completion and the member reads again.
- Then: The late completion returns HTTP 200, but the command reads `failed` with error code `timeout`, and `resultChanged` was published only on that command's result channel.

## computer-use-result-notifications-006

- Vitest: "Computer Use CLI result subscriptions > keeps a created command executable when subscription issuance fails"
- Mode: run
- Given: A signed-in workspace admin has a registered Desktop host, and the realtime provider fails to sign token requests.
- When: The member creates an `apps.list` command with `realtime: true`, and the Desktop claims and completes it.
- Then: The create returns exactly `{ commandId, status: "queued" }` without a realtime grant, the Desktop claim returns the command, and it then reads `succeeded`.

## computer-use-result-notifications-007

- Vitest: "Computer Use CLI result subscriptions > keeps a durable result readable when its notification cannot be published"
- Mode: run
- Given: A signed-in workspace admin's Desktop host has claimed a realtime `apps.list` command, and realtime publishing fails.
- When: The Desktop completes the command successfully and the member reads it.
- Then: The completion returns HTTP 200 and the command reads `succeeded` with result `{ apps: [] }`.

## computer-use-result-notifications-008

- Vitest: "Computer Use CLI result subscriptions > requires the sandbox Agent's existing bound-host capability before issuing a result grant"
- Mode: run
- Given: A signed-in member has a registered Desktop host, a chat Run launched with that host selected, and another chat Run launched without a host; the realtime provider signs token requests.
- When: Each Run's Agent creates an `apps.list` command with `realtime: true` via `POST /api/computer-use/commands`.
- Then: The bound Agent's command includes a token request whose capability is only `subscribe` on `computer-use-result:<userId>:<orgId>:<commandId>`. The unbound Agent gets HTTP 403, and only one token request is issued in total.
