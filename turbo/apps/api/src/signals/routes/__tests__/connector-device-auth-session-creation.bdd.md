# connector-device-auth-session-creation

## connector-device-auth-session-creation-001

- Vitest: "Builtin device-auth session creation > replaces matching waiting sessions while preserving completed replay, another workspace and the chosen non-default account"
- Mode: run
- Given: Authenticated owners in two workspaces have device OAuth enabled. The first owner has a completed default and non-default device account and an awaiting reconnect to the latter. The second owner has a pending add session.
- When: The first owner creates a replacement for the same target via POST /api/connectors/:slug/oauth/device/sessions, polls the superseded session, replays the completed default and later polls the replacement. The other owner completes their own session and the first owner tries to reconnect that foreign account.
- Then: The replacement has a distinct ID and token. The old waiting session returns HTTP 200 with status error, code session_superseded and the message OAuth device authorization session was superseded. The completed default replays its ID and the foreign session completes for its actual owner. Reconnecting the foreign ID returns HTTP 404 Connector account not found. The replacement completes for the exact original non-default account and both account lists preserve their respective IDs and default roles. Completed responses omit session tokens and provider credentials.

## connector-device-auth-session-creation-002

- Vitest: "Builtin device-auth session creation > rejects reconnect to a deleted account without retiring a previously usable waiting session"
- Mode: run
- Given: An authenticated owner has two connected device OAuth accounts and deletes a third. A valid waiting reconnect to the non-default survivor already exists.
- When: The owner requests reconnect to the deleted ID via POST /api/connectors/:slug/oauth/device/sessions, then polls the waiting survivor session.
- Then: The deleted ID returns HTTP 404 NOT_FOUND with Connector account not found. The valid pending session still completes under HTTP 200 for the exact survivor and the account list retains its original default beside that non-default account.

## connector-device-auth-session-creation-003

- Vitest: "Builtin device-auth session creation > retires an in-flight polling claim without publishing its account when a replacement session is started"
- Mode: run
- Given: An authenticated owner has a default and non-default device account. A poll for a new pending device session has reached the provider and is awaiting a successful response.
- When: The owner requests a replacement session through POST /api/connectors/:slug/oauth/device/sessions targeting the non-default account for reconnect. The owner polls the old session before and after releasing the first provider response, and completes the replacement.
- Then: The old requests all return HTTP 200 with status error, code session_superseded and the message OAuth device authorization session was superseded. The late provider success publishes no extra account. The replacement completes for the existing sibling and readback keeps exactly the original default and sibling roles.
