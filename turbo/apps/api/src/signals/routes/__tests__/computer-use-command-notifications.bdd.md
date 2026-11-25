# computer-use-command-notifications

## computer-use-command-notifications-001

- Vitest: "Native Computer Use command notifications > returns a subscription for the authenticated host's current connection"
- Mode: run
- Given: A signed-in workspace admin runs the Desktop app with a fixed installation ID.
- When: The Desktop registers twice via `POST /api/computer-use/hosts/register`, then polls `POST /api/computer-use/hosts/:hostId/commands/next` with the first connection generation, and stops with the second.
- Then: Each registration returns HTTP 200 with `commandNotifications` `{ channelName: "computer-use-host:<userId>:<orgId>:<hostId>:<connectionGeneration>", eventName: "commandsChanged" }` for its own connection. The second registration keeps the host ID with a higher connection generation and a matching channel name. Polling with the old generation returns HTTP 409, and stopping the current connection returns HTTP 200.

## computer-use-command-notifications-002

- Vitest: "Native Computer Use command notifications > publishes only after a command is available through the HTTP claiming endpoint"
- Mode: run
- Given: A signed-in workspace admin has a registered Desktop host supporting `apps.list`. Whenever a `commandsChanged` notification is published, the Desktop immediately polls the claiming endpoint.
- When: The member creates an `apps.list` command with `POST /api/computer-use/commands`.
- Then: The create returns HTTP 200, and the Desktop's poll triggered by the notification claims exactly that command. `commandsChanged` is published only on the host's notification channel, with a null payload. Reading `GET /api/computer-use/commands/:commandId` then shows `running`, and the Desktop can complete it and stop.

## computer-use-command-notifications-003

- Vitest: "Native Computer Use command notifications > recovers publish failures through both fresh and updated heartbeat responses"
- Mode: run
- Given: A signed-in workspace admin has a registered Desktop host whose first heartbeat reports no pending commands. Publishing the `commandsChanged` notification fails (row: publish).
- When: The member creates an `apps.list` command; the Desktop sends `POST /api/computer-use/hosts/:hostId/heartbeat` immediately and again 31 seconds later, claims the next command and heartbeats again.
- Then: The command create still returns HTTP 200. Both the fresh and the later heartbeat report `hasPendingCommands: true`, the claim returns the created command, and after claiming the heartbeat reports no pending commands.

## computer-use-command-notifications-004

- Vitest: "Native Computer Use command notifications > recovers channel failures through both fresh and updated heartbeat responses"
- Mode: run
- Given: A signed-in workspace admin has a registered Desktop host whose first heartbeat reports no pending commands. Opening the host's realtime channel fails (row: channel).
- When: The member creates an `apps.list` command; the Desktop sends `POST /api/computer-use/hosts/:hostId/heartbeat` immediately and again 31 seconds later, claims the next command and heartbeats again.
- Then: The command create still returns HTTP 200. Both the fresh and the later heartbeat report `hasPendingCommands: true`, the claim returns the created command, and after claiming the heartbeat reports no pending commands.

## computer-use-command-notifications-005

- Vitest: "Native Computer Use command notifications > does not hint work for another host or for unsupported command capabilities"
- Mode: run
- Given: A signed-in workspace admin registers a first Desktop host, creates an `apps.list` command routed to it, then registers a second Desktop host.
- When: The second host heartbeats; the first host heartbeats advertising only `app.state`, then heartbeats with its normal `apps.list` capability; the member reads the command.
- Then: The second host's heartbeat and the first host's `app.state`-only heartbeat report no pending commands, while the first host's normal heartbeat reports pending commands. The command is still `queued`.
