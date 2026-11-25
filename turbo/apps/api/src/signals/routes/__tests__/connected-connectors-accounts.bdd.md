# connected-connectors-accounts

## connected-connectors-accounts-001

- Vitest: "builtin connected directory includes saved accounts when the default requires reconnect"
- Mode: run
- Given: An authenticated organization admin has a saved default Stripe CLI account issued in live mode 91 days earlier. Its credential is past its usable lifetime. The admin can authorize two fresh accounts through Stripe device authorization.
- When: The admin reads GET /api/connectors/connected, connects Work and Personal, reads GET /api/connector-accounts/connections and GET /api/connector-catalog/stripe, deletes all three connections and reads the connected directory again.
- Then: The first directory HTTP 200 contains only the Stripe built-in brief. The connections HTTP 200 reports three accounts, two connected and the default reconnect-required. The catalog detail reports stripe. Each DELETE returns HTTP 200 and the final directory shows empty built-in and custom lists.

## connected-connectors-accounts-002

- Vitest: "custom connected directory includes saved accounts when the default requires reconnect"
- Mode: run
- Given: An authenticated organization admin has an automatic streamable-HTTP custom MCP connector whose default grant was issued two minutes earlier, had a 60-second lifetime and lacked a refresh token. The provider supports adding two fresh accounts.
- When: The admin reads GET /api/connectors/connected, connects Work and Personal through OAuth and reads GET /api/connector-accounts/connections and GET /api/custom-connectors, then deletes all three accounts and reads the connected directory again.
- Then: The first directory HTTP 200 contains only the custom connector brief. The connections HTTP 200 reports three accounts, two connected. The definitions list still contains the exact custom connector ID. Each DELETE returns HTTP 200 and the final directory shows empty built-in and custom lists.
