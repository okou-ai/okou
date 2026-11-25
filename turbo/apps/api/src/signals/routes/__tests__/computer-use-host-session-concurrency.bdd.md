# computer-use-host-session-concurrency

## computer-use-host-session-concurrency-001

- Vitest: "Computer Use host session concurrency > lets only one of several concurrent claims start a command on a host"
- Mode: run
- Given: A signed-in workspace member has a registered Desktop host and has queued two `apps.list` read commands via `POST /api/computer-use/commands`.
- When: The Desktop sends three concurrent `POST /api/computer-use/hosts/:hostId/commands/next` claims.
- Then: Exactly one claim returns a command, and it is the first command. Reading the commands shows the first `running` and the second still `queued`.

## computer-use-host-session-concurrency-002

- Vitest: "Computer Use host session concurrency > broadcasts one online transition when concurrent heartbeats revive a host"
- Mode: run
- Given: A signed-in workspace member has a registered Desktop host whose last heartbeat is 120 seconds old, past the online window.
- When: The Desktop sends three concurrent `POST /api/computer-use/hosts/:hostId/heartbeat` requests.
- Then: All three heartbeats succeed for the host. Exactly one realtime publication occurs, `computerUseHostsChanged` with a null payload, and `GET /api/computer-use/hosts` lists the host as `online`.

## computer-use-host-session-concurrency-003

- Vitest: "Computer Use host session concurrency > records exactly one completion when a host reports the same command concurrently"
- Mode: run
- Given: A signed-in workspace member's Desktop host has claimed an `app.open` Finder write command.
- When: The Desktop sends two concurrent `POST /api/computer-use/hosts/:hostId/commands/:commandId/complete` requests reporting success.
- Then: Both requests return HTTP 200, the command reads `succeeded`, and `GET /api/computer-use/audit-events` for the command returns exactly one audit event.

## computer-use-host-session-concurrency-004

- Vitest: "Computer Use host session concurrency > lets only one of two concurrent stops end the host session"
- Mode: run
- Given: A signed-in workspace member has a registered Desktop host.
- When: The Desktop sends two concurrent `POST /api/computer-use/hosts/:hostId/stop` requests, then a heartbeat.
- Then: One stop returns HTTP 200 and the other HTTP 409. The later heartbeat returns HTTP 409 and the host is listed as `offline`.
