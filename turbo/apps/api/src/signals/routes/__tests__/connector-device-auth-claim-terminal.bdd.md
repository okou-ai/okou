# connector-device-auth-claim-terminal

## connector-device-auth-claim-terminal-001

- Vitest: "Builtin device-auth terminal claim outcomes > preserves supersession and the exact replacement account after a held access_denied response"
- Mode: run
- Given: An authenticated owner has two OAuth device accounts. A reconnect to the non-default account reaches the provider, where an HTTP 400 access_denied response is held.
- When: The owner starts and completes a replacement reconnect for the same account with read and replacement scopes, releases the old provider error, then replays both sessions through POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll.
- Then: The original request and old replay both return HTTP 200 with status error, code session_superseded and the message OAuth device authorization session was superseded. The replacement completes and replays for the same connected non-default account with read and replacement scopes. The list retains both account identities and its original default.

## connector-device-auth-claim-terminal-002

- Vitest: "Builtin device-auth terminal claim outcomes > preserves supersession and the exact replacement account after a held expired_token response"
- Mode: run
- Given: An authenticated owner has two OAuth device accounts. A reconnect to the non-default account reaches the provider, where an HTTP 400 expired_token response is held.
- When: The owner starts and completes a replacement reconnect for the same account with read and replacement scopes, releases the old provider error, then replays both sessions through POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll.
- Then: The original request and old replay both return HTTP 200 with status error, code session_superseded and the message OAuth device authorization session was superseded. The replacement completes and replays for the same connected non-default account with read and replacement scopes. The list retains both account identities and its original default.

## connector-device-auth-claim-terminal-003

- Vitest: "Builtin device-auth terminal claim outcomes > preserves supersession and the exact replacement account after a held invalid_request response"
- Mode: run
- Given: An authenticated owner has two OAuth device accounts. A reconnect to the non-default account reaches the provider, where an HTTP 400 invalid_request response is held.
- When: The owner starts and completes a replacement reconnect for the same account with read and replacement scopes, releases the old provider error, then replays both sessions through POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll.
- Then: The original request and old replay both return HTTP 200 with status error, code session_superseded and the message OAuth device authorization session was superseded. The replacement completes and replays for the same connected non-default account with read and replacement scopes. The list retains both account identities and its original default.

## connector-device-auth-claim-terminal-004

- Vitest: "Builtin device-auth terminal claim outcomes > keeps a reclaimed poll current after its obsolete denial and completes the exact non-default account"
- Mode: run
- Given: An authenticated owner has default and non-default OAuth device accounts. A reconnect to the sibling uses a three-second interval. The first poll at T+3 seconds is waiting for a provider denial.
- When: At T+33.001 seconds the caller submits POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll again and the successful provider response is also held. The earlier denial arrives first, then the successful response.
- Then: The obsolete poll and a new interim poll return HTTP 200 pending with interval 3 and both existing accounts retain their roles. The winning poll completes the exact non-default account as connected and replays identically.

## connector-device-auth-claim-terminal-005

- Vitest: "Builtin device-auth terminal claim outcomes > replays rejected reconnect completion after public account deletion and preserves its surviving default"
- Mode: run
- Given: An authenticated owner has a default and non-default OAuth device account. A reconnect exists for the non-default ID, but the owner deletes that account before polling completes.
- When: The owner calls POST /api/connectors/:slug/oauth/device/sessions/:sessionId/poll twice for that reconnect, then starts and completes a new add session and retries the rejected reconnect again.
- Then: The old session consistently returns HTTP 200 error with connector_account_rejected and Connector account not found. The original default is the only survivor after deletion. The new session completes a distinct non-default account, and readback contains both the surviving default and the new account.
