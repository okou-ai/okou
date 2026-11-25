# connector-device-auth-completed-replay

## connector-device-auth-completed-replay-001

- Vitest: "Builtin device-auth completed replay > reloads the exact non-default account after reconnect and the completed session lifetime"
- Mode: run
- Given: An authenticated owner has completed device OAuth for a default account and a distinct non-default account. The sibling initially has read and write scopes. Reconnecting that exact sibling through the provider changes its scopes to read.
- When: After the original sibling session lifetime passes and the provider token endpoint becomes unavailable, the owner repeats POST /api/connectors/:connectorSlug/oauth/device/sessions/:sessionId/poll with the original sibling's session ID and token.
- Then: The replay returns HTTP 200 complete with the same connected non-default oauth account and the current read scope, without provider credentials or the session token. The accounts list and default readback preserve the original default and non-default roles.

## connector-device-auth-completed-replay-002

- Vitest: "Builtin device-auth completed replay > fails completed replay after the exact account is deleted rather than substituting the surviving default"
- Mode: run
- Given: An authenticated owner completed separate device OAuth sessions for a default account and a distinct sibling. The owner deletes the sibling, leaving the default intact.
- When: The owner replays the sibling's original session through POST /api/connectors/:connectorSlug/oauth/device/sessions/:sessionId/poll.
- Then: The replay returns HTTP 500 with error Internal server error and does not expose credentials or the session token. The remaining account is still the original default.
