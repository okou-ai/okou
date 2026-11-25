# mcp-connectors

## mcp-connectors-001

- Vitest: "GET /api/mcp-connectors > uses the Chat's exact selected account and discovers newly connected MCPs"
- Mode: run
- Given: A member has a manual MCP custom connector `_selected-mcp` with a default account and a second account "Run account", plus a signed HTTP custom connector. A chat thread selects the second MCP account and the HTTP account, and a run is started in it.
- When: Using the run's Okou token, the agent calls `GET /api/mcp-connectors`; the member then changes the MCP connector's storage version, reconnects the default account, and adds a new MCP connector `_post-start-mcp`; the agent lists again; the member bumps the storage version again and reconnects the selected account; the agent lists a third time.
- Then: The first list contains only `_selected-mcp` with the selected account, endpoint, `streamable-http`, `runtimeAvailable` true, `connected`, no missing fields and configured field `secret`. The second list contains the new `_post-start-mcp` (connected) followed by the selected account as unavailable, `reconnect-required` with reason `configuration_invalid`, missing field `secret` and no configured fields. The third list shows both MCPs connected and available again.

## mcp-connectors-002

- Vitest: "GET /api/mcp-connectors > removes a no-auth MCP from the running Run when its only account is deleted"
- Mode: run
- Given: A member has a no-auth MCP custom connector `_public-mcp` with a single account, and a run is started.
- When: The agent lists `GET /api/mcp-connectors` and the Runner syncs connector runtime via `POST /api/runners/runs/:runId/connector-runtime/sync`; the member deletes the only account; the agent lists and the Runner syncs again.
- Then: Initially the list contains the MCP with that account and `runtimeAvailable` true, and the sync reports it `available` bound to the account. After the deletion the list is empty and the sync reports the target `absent` with reason `connector-unavailable`.

## mcp-connectors-003

- Vitest: "GET /api/mcp-connectors > follows the Chat's allowed replacement when its current account is deleted"
- Mode: run
- Given: A member has a manual MCP custom connector with an exact account and a healthy sibling account. A chat run's thread selects the exact account, and the member is an organization admin.
- When: The member deletes the exact account via the connector accounts delete route, then the agent calls `GET /api/mcp-connectors` with the run's token.
- Then: The list contains the connector with the sibling account as `connectionId` and `runtimeAvailable` true.

## mcp-connectors-004

- Vitest: "GET /api/mcp-connectors > requires agent authentication for connector read"
- Mode: run
- Given: An organization admin exists.
- When: `GET /api/mcp-connectors` is called without credentials and then with the admin's Clerk session.
- Then: The unauthenticated request returns HTTP 401 and the Clerk session returns HTTP 403.

## mcp-connectors-005

- Vitest: "POST /api/mcp-connectors/oauth2/reauthorize > reauthorizes the parent-resource cimd account with none and offline access registered=false"
- Mode: run
- Given: A Pro admin has an Automatic MCP custom connector whose OAuth server uses CIMD client registration (auth method `none`) and does not list `offline_access`. The admin connected a default ("Pinned") and a sibling account with scope `read`, and a run is executing on a Runner.
- When: Using the run's Okou token, the agent calls `POST /api/mcp-connectors/oauth2/reauthorize` with scopes `["admin"]` and the user completes that authorization; the authorization server then moves to an alternate issuer and the agent requests scope `owner`, and the user completes that authorization.
- Then: The first reauthorization returns HTTP 200 with kind `oauth`, an expiry and an authorization URL with the resource and scope `read admin offline_access`, without registering a new client. After the callback the pinned account has scopes `read admin offline_access`, the sibling keeps `read`, and the firewall refresh uses the refreshed token. The changed-authority request returns HTTP 200 with a URL at the new issuer; after its callback the token is refreshed with the new issuer without old client credentials, the pinned account is `connected` and the sibling keeps `read`.

## mcp-connectors-006

- Vitest: "POST /api/mcp-connectors/oauth2/reauthorize > reauthorizes the parent-resource dcr account with client_secret_basic and offline access registered=true"
- Mode: run
- Given: A Pro admin has an Automatic MCP custom connector whose OAuth server uses dynamic client registration with `client_secret_basic` and lists `offline_access`. The admin connected a default ("Pinned") and a sibling account with scope `read`, and a run is executing on a Runner.
- When: Using the run's Okou token, the agent calls `POST /api/mcp-connectors/oauth2/reauthorize` with scopes `["admin"]` and the user completes it; the server then moves to an alternate issuer and the agent requests scope `owner`; the user reconnects the pinned account through the new issuer.
- Then: The client was registered with `client_secret_basic`. The first reauthorization returns HTTP 200 with the resource and scope `read admin offline_access` without a new registration, the pinned account gains `read admin offline_access` and the sibling keeps `read`. The changed-authority request returns HTTP 409 `MCP_OAUTH_BINDING_CHANGED` mentioning Reconnect without contacting the new issuer. Reconnecting registers once with the new issuer and its client ID; afterwards refreshes use the new issuer without old client credentials, and the pinned account is `connected`.

## mcp-connectors-007

- Vitest: "POST /api/mcp-connectors/oauth2/reauthorize > reauthorizes the parent-resource dcr account with client_secret_post and offline access registered=true"
- Mode: run
- Given: A Pro admin has an Automatic MCP custom connector whose OAuth server uses dynamic client registration with `client_secret_post` and lists `offline_access`. The admin connected a default ("Pinned") and a sibling account with scope `read`, and a run is executing on a Runner.
- When: Using the run's Okou token, the agent calls `POST /api/mcp-connectors/oauth2/reauthorize` with scopes `["admin"]` and the user completes it; the server then moves to an alternate issuer and the agent requests scope `owner`; the user reconnects the pinned account through the new issuer.
- Then: The client was registered with `client_secret_post`. The first reauthorization returns HTTP 200 with the resource and scope `read admin offline_access` without a new registration, the pinned account gains `read admin offline_access` and the sibling keeps `read`. The changed-authority request returns HTTP 409 `MCP_OAUTH_BINDING_CHANGED` mentioning Reconnect without contacting the new issuer. Reconnecting registers once with the new issuer and its client ID; afterwards refreshes use the new issuer without old client credentials, and the pinned account is `connected`.

## mcp-connectors-008

- Vitest: "POST /api/mcp-connectors/oauth2/reauthorize > reauthorizes the parent-resource dcr account with none and offline access registered=true"
- Mode: run
- Given: A Pro admin has an Automatic MCP custom connector whose OAuth server uses dynamic client registration that returns method `none` while advertising only `client_secret_basic` and `client_secret_post`, and lists `offline_access`. The admin connected a default ("Pinned") and a sibling account with scope `read`, and a run is executing.
- When: Using the run's Okou token, the agent calls `POST /api/mcp-connectors/oauth2/reauthorize` with scopes `["admin"]` and the user completes it; the server then moves to an alternate issuer and the agent requests scope `owner`; the user reconnects the pinned account through the new issuer.
- Then: The registration requested `client_secret_basic`. The first reauthorization returns HTTP 200 with the resource and scope `read admin offline_access` without a new registration, the pinned account gains `read admin offline_access` and the sibling keeps `read`. The changed-authority request returns HTTP 409 `MCP_OAUTH_BINDING_CHANGED` mentioning Reconnect without contacting the new issuer. Reconnecting registers once with the new issuer; afterwards refreshes use the new issuer without old client credentials, and the pinned account is `connected`.

## mcp-connectors-009

- Vitest: "POST /api/mcp-connectors/oauth2/reauthorize > reauthorizes the parent-resource dcr account with client_secret_basic and offline access registered=false"
- Mode: run
- Given: A Pro admin has an Automatic MCP custom connector whose OAuth server uses dynamic client registration with `client_secret_basic` but did not list `offline_access` when the client was registered. The admin connected two accounts, and a run is executing on a Runner.
- When: After the server starts advertising `admin` and `offline_access`, the agent calls `POST /api/mcp-connectors/oauth2/reauthorize` with scopes `["admin"]` using the run's Okou token.
- Then: The API responds with HTTP 409 and code `MCP_OAUTH_CLIENT_REGISTRATION_CONFLICT`, and no additional client registration is made.

## mcp-connectors-010

- Vitest: "POST /api/mcp-connectors/oauth2/reauthorize > discovers Automatic no-auth accounts without offering OAuth reauthorization"
- Mode: run
- Given: A Pro admin connected an Automatic MCP custom connector whose server requires no authentication, and a run is executing on a Runner.
- When: Using the run's Okou token, the agent calls `GET /api/mcp-connectors` and then `POST /api/mcp-connectors/oauth2/reauthorize` with scopes `["admin"]`.
- Then: The list contains the connector with `runtimeAvailable` true. The reauthorization returns HTTP 409 with code `CONFLICT`.

## mcp-connectors-011

- Vitest: "POST /api/mcp-connectors/oauth2/reauthorize > requires agent authentication for connector write"
- Mode: run
- Given: An organization admin exists, and a random custom connector ID is used.
- When: `POST /api/mcp-connectors/oauth2/reauthorize` is called with scopes `["admin"]` without credentials and then with the admin's Clerk session.
- Then: The unauthenticated request returns HTTP 401 and the Clerk session returns HTTP 403.
