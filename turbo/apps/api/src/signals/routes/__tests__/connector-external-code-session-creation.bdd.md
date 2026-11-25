# connector-external-code-session-creation

## connector-external-code-session-creation-001

- Vitest: "Builtin external-code session creation > replaces matching pending sessions while preserving completed replay, another workspace and the chosen non-default account"
- Mode: run
- Given: Authenticated owners in two workspaces use AWS CLI. The first owner has a completed default and non-default account and a pending reconnect for the sibling. The second owner has a pending add session.
- When: The first owner starts a replacement through POST /api/connectors/aws/external-code/sessions for the same sibling, completes through POST /api/connectors/aws/external-code/sessions/:sessionId/complete and reads accounts. Both owners check their original sessions, and the first owner attempts to reconnect the second owner's account.
- Then: The replacement has a distinct ID and token. The prior pending session returns HTTP 400 BAD_REQUEST with the superseded message. The default replays and the foreign session finishes for its actual owner. Reconnecting the foreign account returns HTTP 404 Connector account not found. The replacement completes for the exact non-default account and both lists retain the correct IDs and roles.

## connector-external-code-session-creation-002

- Vitest: "Builtin external-code session creation > rejects reconnect to a deleted account without retiring a previously usable pending session"
- Mode: run
- Given: An authenticated owner has two AWS CLI accounts and has deleted a third. A usable external-code reconnect for the non-default survivor is pending.
- When: The owner requests a reconnect to the deleted ID through POST /api/connectors/aws/external-code/sessions, then submits the pending survivor session through POST /api/connectors/aws/external-code/sessions/:sessionId/complete.
- Then: The deleted ID returns HTTP 404 NOT_FOUND with Connector account not found. The previous pending session still completes over HTTP 200 for the exact surviving non-default account and both original survivors retain their roles.

## connector-external-code-session-creation-003

- Vitest: "Builtin external-code session creation > keeps an in-flight provider completion usable when a replacement session is started"
- Mode: run
- Given: An authenticated owner has a default and a distinct non-default AWS CLI account. Provider exchange for a sibling reconnect has already started and its response is held.
- When: The owner starts a replacement for the same account through POST /api/connectors/aws/external-code/sessions, retries the first session while it is in flight, then lets it finish and completes the replacement through POST /api/connectors/aws/external-code/sessions/:sessionId/complete.
- Then: The duplicate receives HTTP 400 BAD_REQUEST with message External-code authorization session is already completing. The delayed original and the replacement both complete over HTTP 200 for the same connected sibling, and completed replay of the first session still returns that same ID. Readback lists only the original default and non-default accounts.
