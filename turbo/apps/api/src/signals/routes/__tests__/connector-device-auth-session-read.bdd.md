# connector-device-auth-session-read

## connector-device-auth-session-read-001

- Vitest: "Builtin device-auth owned-session reads > rejects each real-session identity boundary before and after completion"
- Mode: run
- Given: The OAuth device connector is enabled. An authenticated owner starts a session using its oauth method and the provider allows completion. No account exists yet.
- When: The caller uses POST /api/connectors/:connectorSlug/oauth/device/sessions/:sessionId/poll before and after valid completion, testing a wrong token, wrong connector, different user in the same workspace and the same user in another workspace. The owner also re-polls with the valid session identity.
- Then: Every mismatched request returns HTTP 404 NOT_FOUND with message OAuth device authorization session not found. The rejected polls create no account. Valid HTTP 200 completion reports a connected oauth account without the session token or provider credentials. Default readback and valid replay both identify the same account.

## connector-device-auth-session-read-002

- Vitest: "Builtin device-auth owned-session reads > requires the exact token for each auth-method session and re-polls its exact account"
- Mode: run
- Given: The enabled OAuth device connector offers distinct oauth and api methods. An authenticated owner starts both sessions and receives different IDs and tokens.
- When: The owner cross-pairs the tokens and IDs at POST /api/connectors/:connectorSlug/oauth/device/sessions/:sessionId/poll before completion, then completes and re-polls each intended pair, and repeats both mismatched combinations.
- Then: Each crossed pair returns HTTP 404 NOT_FOUND. No account exists before valid completion. Each valid poll returns HTTP 200 for its own distinct account with the matching method and connected status, without disclosing credentials. The account list contains exactly the two resulting IDs.
