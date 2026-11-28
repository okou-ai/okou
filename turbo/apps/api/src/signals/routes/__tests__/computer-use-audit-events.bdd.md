# computer-use-audit-events

## computer-use-audit-events-001

- Vitest: "Computer Use audit events > preserves session, Clerk OAuth session, PAT, organization and sandbox-token auth controls"
- Mode: run
- Given: A signed-in workspace member has a registered Desktop host on which an `app.open` write command was claimed and completed successfully. The member also has a personal access token, and a chat Run launched with the Desktop selected provides an Agent token and a sandbox token.
- When: `GET /api/computer-use/audit-events` is called without credentials, by a user without an organization, by the member's session, through a Clerk OAuth session, with the personal access token, with the Agent token and with the sandbox token.
- Then: The unauthenticated and organization-less requests return HTTP 401 with an API error. The session, OAuth session and personal access token each return the same single audit event for the command. The Agent token and the sandbox token both return HTTP 403 with `{ error: { message: "This endpoint is not available for sandbox tokens", code: "FORBIDDEN" } }`.

## computer-use-audit-events-002

- Vitest: "Computer Use audit events > preserves exact owner isolation, every selector, nulls and complete redacted payloads"
- Mode: run
- Given: A signed-in member's Desktop host completed an Agent-issued `element.click` in Safari (result includes a private `appState` and metrics) and, one second later, a member-issued `app.open` Finder command that failed with `app_not_found`. A peer in the same workspace and a member of another workspace each have their own completed audit events.
- When: The member lists `GET /api/computer-use/audit-events` with `limit=200`, then filters by `commandId`, `hostId`, `runId`, all three combined, conflicting selector pairs, and the peer's or foreign command and host IDs.
- Then: The full list returns exactly the member's two events, newest first. The failed event has `runId: null`, `redactedResult: null` and the error; the click event has the Run ID, `event: "completed"`, a redacted result with `appStateLength: 13` instead of the app state plus the metrics, and `error: null`, with exact timestamps. No response contains the private state or the peer/foreign labels. Each single selector narrows correctly (host returns both, command and Run return the click), the combination equals the Run filter, conflicting or foreign selectors return empty lists, and no realtime messages are published by these reads.

## computer-use-audit-events-003

- Vitest: "Computer Use audit events > preserves default 50, explicit limits, max 200, descending order and empty results"
- Mode: run
- Given: A signed-in member's Desktop host has completed 51 `app.open` commands, one second apart.
- When: The member calls `GET /api/computer-use/audit-events` with no limit, `limit=7`, `limit=200`, and with an unknown `runId`.
- Then: The default page returns the 50 newest events in descending order, `limit=7` returns the 7 newest, `limit=200` returns all 51 in descending order, and the unknown Run returns an empty list.

## computer-use-audit-events-004

- Vitest: "Computer Use audit events > treats empty optional selectors as unfiltered and accepts a valid command selector"
- Mode: run
- Given: A signed-in member has one completed Desktop command audit event.
- When: The member calls `GET /api/computer-use/audit-events` without selectors, with empty `commandId`, `hostId` and `runId` values, and with the real `commandId`.
- Then: The empty selectors return the same result as the unfiltered list, and the command selector returns exactly one event.
