# computer-use-host-presence

## computer-use-host-presence-001

- Vitest: "Desktop host presence > keeps an idle presence host routable beyond heartbeat freshness and follows presence leave"
- Mode: run
- Given: A signed-in workspace admin registered a Desktop host with `livenessMode: "presence"`, and the realtime presence set on the host's channel contains the user. The clock advances 120 seconds without heartbeats.
- When: The member lists `GET /api/computer-use/hosts` and creates an `apps.list` command; then the host leaves presence and the member lists and creates a command again.
- Then: While present, the host is listed `online` and the command create returns HTTP 200. After presence is empty, the host is listed `offline` and the command create returns HTTP 409.

## computer-use-host-presence-002

- Vitest: "Desktop host presence > issues only current-generation host capabilities and rejects a replaced connection"
- Mode: run
- Given: A signed-in workspace admin registered a presence-mode Desktop host, and the realtime provider issues token requests.
- When: The Desktop requests `POST /api/computer-use/hosts/:hostId/realtime-token` with its connection generation; the same installation re-registers; the old generation requests a token again; after 120 seconds the member lists hosts.
- Then: The first token request returns HTTP 200; the provider was asked for a one-hour token whose capability is only `subscribe` and `presence` on the host's own channel for the user's client ID, and the response carries that capability and client ID. After replacement, the old generation's token request returns HTTP 409, and 120 seconds later the host is listed `offline`.

## computer-use-host-presence-003

- Vitest: "Desktop host presence > repairs lost wakeups from queued command reads and admits the command once"
- Mode: run
- Given: A signed-in workspace admin registered a presence-mode Desktop host. Realtime publishing fails while an `apps.list` command is created, then recovers.
- When: The member reads the queued command via `GET /api/computer-use/commands/:commandId`; the Desktop claims the next command, completes it, and polls again.
- Then: The create returns HTTP 200 and the read reports `queued` while re-publishing `commandsChanged` on the host's channel. The Desktop claim returns that command, the command then reads `succeeded`, and the next poll returns `idle`.

## computer-use-host-presence-004

- Vitest: "Desktop host presence > recovers work through the HTTP queue wait while all Ably wakeup publications fail"
- Mode: run
- Given: A signed-in workspace admin registered a presence-mode Desktop host and every realtime publication fails.
- When: The member creates an `apps.list` command; the Desktop calls `POST /api/computer-use/hosts/:hostId/commands/wait` and then claims the next command.
- Then: The create returns HTTP 200, the wait reports `hasPendingCommands: true`, and the claim returns the created command.

## computer-use-host-presence-005

- Vitest: "Desktop host presence > keeps a recently received HTTP connection usable during an Ably outage"
- Mode: run
- Given: A signed-in workspace admin has just registered a presence-mode Desktop host, and the realtime presence provider is unavailable.
- When: The member lists `GET /api/computer-use/hosts`.
- Then: The list returns HTTP 200 with the recently connected host `online`.

## computer-use-host-presence-006

- Vitest: "Desktop host presence > removes a revoked host session even when its Ably presence is retained"
- Mode: run
- Given: A signed-in workspace admin registered a presence-mode Desktop host whose presence is still retained, but 31 seconds later the user's sign-in session is revoked.
- When: The member lists `GET /api/computer-use/hosts` and the Desktop polls `POST /api/computer-use/hosts/:hostId/commands/next`.
- Then: The host is listed `offline` and the Desktop poll returns HTTP 409.

## computer-use-host-presence-007

- Vitest: "Desktop host presence > reports presence-provider failure as unavailable instead of offline"
- Mode: run
- Given: A signed-in workspace admin registered a presence-mode Desktop host 120 seconds ago and the realtime presence provider is unavailable.
- When: The member lists `GET /api/computer-use/hosts`.
- Then: The request returns HTTP 503 with error code `PROVIDER_UNAVAILABLE`.

## computer-use-host-presence-008

- Vitest: "Desktop host presence > synchronizes changed capabilities and keeps stop authoritative over lingering presence"
- Mode: run
- Given: A signed-in workspace admin registered a presence-mode Desktop host whose presence remains on the channel.
- When: The Desktop posts `POST /api/computer-use/hosts/:hostId/state` with host name "Updated Mac" and only `app.state`; the member lists hosts; the Desktop stops; the member lists again and the old connection requests a realtime token.
- Then: The listing shows display name "Updated Mac" with capabilities `["app.state"]`. After the stop the host is listed `offline` despite lingering presence, and the realtime-token request returns HTTP 409.

## computer-use-host-presence-009

- Vitest: "Presence-only Desktop > uses presence for a fresh host and reports an unavailable provider explicitly"
- Mode: run
- Given: A signed-in workspace admin registered a Desktop with `livenessMode: "presence"` and `presenceOnly: true`.
- When: The member lists hosts while the presence provider is unavailable; then, with an empty presence set, the Desktop posts a state update and the member lists again.
- Then: Registration echoes `livenessMode: "presence"` and `presenceOnly: true`. The unavailable-provider list returns HTTP 503 `PROVIDER_UNAVAILABLE`, and with no presence the host is listed `offline` even after the fresh state update.

## computer-use-host-presence-010

- Vitest: "Presence-only Desktop > accepts only the current connection's diagnostics without granting online status"
- Mode: run
- Given: A signed-in workspace admin registered a presence-only Desktop host.
- When: The Desktop posts `POST /api/computer-use/hosts/:hostId/connection-events` with `ready` for its current generation and `unavailable` (reason 80003) for a newer generation; then, with an empty presence set, the member lists hosts.
- Then: The current-generation event returns HTTP 204, the mismatched generation returns HTTP 409, and the host is still listed `offline`.

## computer-use-host-presence-011

- Vitest: "Presence-only Desktop > expires an unclaimed operation and still admits a fresh command"
- Mode: run
- Given: A signed-in workspace admin registered a presence-only Desktop host and created an `apps.list` command with a 1000 ms timeout.
- When: After 1001 ms the Desktop polls `POST /api/computer-use/hosts/:hostId/commands/next`, the member reads the command, creates a fresh command, and the Desktop polls and completes it.
- Then: The first poll returns `idle` and the expired command reads `failed` with error code `timeout`. The fresh command is claimed by the next poll and completes with HTTP 200.

## computer-use-host-presence-012

- Vitest: "Presence-only Desktop > repairs failed publication without a result reader or idle Desktop polling"
- Mode: run
- Given: A signed-in workspace admin registered a presence-only Desktop host. The first two `commandsChanged` publications fail and the third succeeds.
- When: The member creates an `apps.list` command; after the notification is eventually delivered, the Desktop claims and completes it and the member reads it.
- Then: The create returns HTTP 200 and the notification is delivered without any result read or idle polling. The claim returns the command, and the command reads `succeeded`.
