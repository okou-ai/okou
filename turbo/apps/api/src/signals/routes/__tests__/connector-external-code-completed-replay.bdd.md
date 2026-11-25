# connector-external-code-completed-replay

## connector-external-code-completed-replay-001

- Vitest: "Builtin external-code completed replay > replays current non-default account state after reconnect and the original session lifetime"
- Mode: run
- Given: An authenticated owner completed AWS CLI external-code sessions for distinct default and sibling AWS identities. After the original sibling session lifetime, reconnect succeeds for that exact sibling and updates its timestamps.
- When: When the AWS token endpoint is unavailable, the owner repeats POST /api/connectors/:connectorSlug/external-code/sessions/:sessionId/complete for the original sibling session and reads the saved AWS accounts.
- Then: The replay returns HTTP 200 with a completion response identical to the reconnect response, including the same sibling ID and new update and token expiry timestamps. No session or provider credentials are exposed. Both accounts remain listed and the original default retains its role.

## connector-external-code-completed-replay-002

- Vitest: "Builtin external-code completed replay > fails replay after the completed non-default account is deleted while its default survives"
- Mode: run
- Given: An authenticated owner completed AWS CLI external-code sessions for distinct default and non-default accounts. The owner deletes the non-default account.
- When: The owner submits the deleted account's original completed session through POST /api/connectors/:connectorSlug/external-code/sessions/:sessionId/complete and lists the accounts.
- Then: The replay returns HTTP 500 with error Internal server error, with no session token or provider credentials. The original default survives as the only account and remains selected.
