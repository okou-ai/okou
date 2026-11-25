# webhooks-agent-session-output

## webhooks-agent-session-output-001

- Vitest: "Sandbox transient session output webhook > publishes an unpersisted run through the token-owned channel"
- Mode: run
- Given: A sandbox holds a token signed for a user, organization and Run ID; the Run has not been persisted. Realtime publishing succeeds.
- When: The sandbox calls `POST /api/webhooks/run/session-output` with its Run ID, a thread ID, a run event ID, chunk index 3 and delta `visible delta`.
- Then: The response is HTTP 204 with no body. Exactly one realtime channel `run-output:<userId>:<orgId>:<runId>` is selected and exactly one message is published on topic `<runId>`, whose session-output delta payload carries the thread ID, Run ID, a string event ID, the run event ID, chunk index 3 and delta `visible delta`.

## webhooks-agent-session-output-002

- Vitest: "Sandbox transient session output webhook > derives a stable reconciliation event ID for a run event"
- Mode: run
- Given: A sandbox holds a token signed for its Run ID. Realtime publishing succeeds.
- When: The sandbox concurrently calls `POST /api/webhooks/run/session-output` twice for the same run event ID with chunk indexes 0 and 1.
- Then: Both calls return HTTP 204, two realtime messages are published, and both payloads carry the same reconciliation event ID.

## webhooks-agent-session-output-003

- Vitest: "Sandbox transient session output webhook > rejects a token for another run before selecting a channel"
- Mode: run
- Given: A sandbox holds a token signed for a different Run ID than the one it reports.
- When: The sandbox calls `POST /api/webhooks/run/session-output` for its reported Run ID.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`; no realtime channel is selected and nothing is published.

## webhooks-agent-session-output-004

- Vitest: "Sandbox transient session output webhook > rejects body-supplied channel authority"
- Mode: run
- Given: A sandbox holds a token signed for its Run ID.
- When: The sandbox calls `POST /api/webhooks/run/session-output` with a valid delta plus extra body fields `userId`, `orgId` and `channel` pointing at another user's run-output channel.
- Then: The response is HTTP 400; no realtime channel is selected and nothing is published.
