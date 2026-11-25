# connectors-automatic-security

## connectors-automatic-security-001

- Vitest: "builtin Automatic account and consent ownership > preserves an existing account and DCR client after a temporary callback failure"
- Mode: run
- Given: A signed-in member connects an Automatic MCP connector whose OAuth provider uses dynamic client registration; the provider's second authorization-code exchange fails with `temporarily_unavailable`.
- When: The member connects via `POST /api/connectors/:connectorSlug/automatic/start` and the OAuth callback `GET /api/connectors/automatic/callback`, then reconnects the account (failing exchange), reads the account, and reconnects again.
- Then: The initial callback reports `success` and its completion receipt returns the account. The interrupted reconnect's callback reports `error`, its receipt `GET /api/connector-accounts/oauth-completions/:attemptId` returns HTTP 404, and `GET /api/connector-accounts/:connectionId` still shows `connected`. The retry succeeds with the same connection ID, and the provider received only one client registration.

## connectors-automatic-security-002

- Vitest: "builtin Automatic account and consent ownership > retires a rejected DCR client during callback and registers a new client on reconnect"
- Mode: run
- Given: A signed-in member has two connected accounts on an Automatic MCP connector whose OAuth provider uses dynamic client registration, and another user in another workspace has their own connected account. The provider rejects the member's next code exchange with `invalid_client`.
- When: The member reconnects the first account through the start and callback routes, reads both accounts, the other owner reads theirs, and the member reconnects again.
- Then: The rejected callback reports `error` and its completion receipt returns HTTP 404. Both of the member's accounts show `reconnect-required`, while the other owner's account stays `connected`. The retry succeeds with the original connection ID, and the provider received three client registrations in total.

## connectors-automatic-security-003

- Vitest: "builtin Automatic account and consent ownership > keeps a rebound account connected when an older invalid-client callback finishes"
- Mode: run
- Given: A signed-in member has a connected Automatic MCP account using a dynamically registered OAuth client, and has started two reconnect attempts. The older attempt's code exchange stalls and then fails with `invalid_client`; the newer attempt's exchange fails with `invalid_client` immediately.
- When: The newer callback completes, the member rebinds the account with a fresh reconnect, and then the stalled older callback finishes.
- Then: The newer callback reports `error`, the rebind callback reports `success`, and the older callback later reports `error` with its completion receipt returning HTTP 404. The account remains `connected`, and the provider received exactly two client registrations.

## connectors-automatic-security-004

- Vitest: "builtin Automatic account and consent ownership > retires an expired unlinked DCR registration during authorization preparation"
- Mode: run
- Given: A signed-in member started an Automatic MCP OAuth authorization whose dynamically registered client secret expires 60 seconds later, and the attempt was never completed (row: unlinked). The clock advances 61 seconds and the provider issues a replacement registration.
- When: The member starts a new authorization via `POST /api/connectors/:connectorSlug/automatic/start`, the old attempt's callback arrives, and then the new attempt's callback arrives.
- Then: The old attempt's callback reports `error` and its completion receipt returns HTTP 404. The new callback reports `success`, the resulting account is `connected`, and each registration endpoint (original and replacement) received exactly one registration.

## connectors-automatic-security-005

- Vitest: "builtin Automatic account and consent ownership > retires an expired linked DCR registration during authorization preparation"
- Mode: run
- Given: A signed-in member connected an Automatic MCP account whose dynamically registered client secret expires 60 seconds later (row: linked). The clock advances 61 seconds and the provider issues a replacement registration.
- When: The member starts a reconnect for the account via `POST /api/connectors/:connectorSlug/automatic/start`, reads the account, and completes the new callback.
- Then: After preparing the reconnect, the account shows `reconnect-required`. The new callback reports `success`, the completion receipt returns the same connection ID, the account is `connected`, and each registration endpoint received exactly one registration.

## connectors-automatic-security-006

- Vitest: "builtin Automatic account and consent ownership > rejects reconnecting an account owned by another user or organization"
- Mode: run
- Given: A signed-in member has an Automatic MCP account connected immediately because the provider needs no authentication.
- When: Another user in the same workspace and the same user in a different workspace each call `POST /api/connectors/:connectorSlug/automatic/start` to reconnect that account.
- Then: Both reconnect attempts return HTTP 409, and the owner's account still reads `connected`.

## connectors-automatic-security-007

- Vitest: "builtin Automatic account and consent ownership > leaves the account connected after two overlapping reconnects"
- Mode: run
- Given: A signed-in member has a connected Automatic MCP account whose OAuth provider uses a client ID metadata document (CIMD), and starts two reconnect attempts for it.
- When: Both OAuth callbacks arrive concurrently at `GET /api/connectors/automatic/callback`.
- Then: Afterwards `GET /api/connector-accounts/:connectionId` shows the account with the same auth method and `connected` status.
