# custom-connectors-automatic-preflight

## custom-connectors-automatic-preflight-001

- Vitest: "Automatic custom connector preflight > connects cimd with a parent resource and preserves the transport query"
- Mode: run
- Given: An authenticated admin creates an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp?profile=full. The provider uses client ID metadata and advertises the parent resource https://automatic-mcp.example.test/tenant.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and completes consent through GET /api/custom-connectors/oauth2/callback.
- Then: The provider is probed at the full configured endpoint including its query. Both the authorization URL and token exchange carry https://automatic-mcp.example.test/tenant. The resulting account is connected with read and write scopes.

## custom-connectors-automatic-preflight-002

- Vitest: "Automatic custom connector preflight > connects dcr with a parent resource and preserves the transport query"
- Mode: run
- Given: An authenticated admin creates an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp?profile=full. The provider uses dynamic client registration and advertises the parent resource https://automatic-mcp.example.test.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and completes consent through GET /api/custom-connectors/oauth2/callback.
- Then: The provider is probed at the full configured endpoint including its query. Both the authorization URL and token exchange carry https://automatic-mcp.example.test. The resulting account is connected with read and write scopes.

## custom-connectors-automatic-preflight-003

- Vitest: "Automatic custom connector preflight > rejects an incompatible protected resource https://foreign-mcp.example.test/ before granting an account"
- Mode: run
- Given: An authenticated admin has an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp. Metadata advertises an incompatible protected resource with another origin.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and then lists accounts.
- Then: The start returns HTTP 400 MCP_OAUTH_DISCOVERY_INVALID. The API sends no provider token request and no account is listed.

## custom-connectors-automatic-preflight-004

- Vitest: "Automatic custom connector preflight > rejects an incompatible protected resource https://automatic-mcp.example.test:8443/tenant before granting an account"
- Mode: run
- Given: An authenticated admin has an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp. Metadata advertises an incompatible protected resource with a different port.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and then lists accounts.
- Then: The start returns HTTP 400 MCP_OAUTH_DISCOVERY_INVALID. The API sends no provider token request and no account is listed.

## custom-connectors-automatic-preflight-005

- Vitest: "Automatic custom connector preflight > rejects an incompatible protected resource https://automatic-mcp.example.test/ten before granting an account"
- Mode: run
- Given: An authenticated admin has an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp. Metadata advertises an incompatible protected resource with a partial path segment rather than a valid parent.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and then lists accounts.
- Then: The start returns HTTP 400 MCP_OAUTH_DISCOVERY_INVALID. The API sends no provider token request and no account is listed.

## custom-connectors-automatic-preflight-006

- Vitest: "Automatic custom connector preflight > rejects an incompatible protected resource https://automatic-mcp.example.test/other before granting an account"
- Mode: run
- Given: An authenticated admin has an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp. Metadata advertises an incompatible protected resource with a different path.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and then lists accounts.
- Then: The start returns HTTP 400 MCP_OAUTH_DISCOVERY_INVALID. The API sends no provider token request and no account is listed.

## custom-connectors-automatic-preflight-007

- Vitest: "Automatic custom connector preflight > rejects an incompatible protected resource https://automatic-mcp.example.test/tenant/mcp/child before granting an account"
- Mode: run
- Given: An authenticated admin has an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp. Metadata advertises an incompatible protected resource with a path below the connector endpoint.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and then lists accounts.
- Then: The start returns HTTP 400 MCP_OAUTH_DISCOVERY_INVALID. The API sends no provider token request and no account is listed.

## custom-connectors-automatic-preflight-008

- Vitest: "Automatic custom connector preflight > rejects an incompatible protected resource https://automatic-mcp.example.test/tenant#fragment before granting an account"
- Mode: run
- Given: An authenticated admin has an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp. Metadata advertises an incompatible protected resource with a nonempty URL fragment.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and then lists accounts.
- Then: The start returns HTTP 400 MCP_OAUTH_DISCOVERY_INVALID. The API sends no provider token request and no account is listed.

## custom-connectors-automatic-preflight-009

- Vitest: "Automatic custom connector preflight > rejects an incompatible protected resource https://automatic-mcp.example.test/tenant# before granting an account"
- Mode: run
- Given: An authenticated admin has an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp. Metadata advertises an incompatible protected resource with an empty URL fragment marker.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and then lists accounts.
- Then: The start returns HTTP 400 MCP_OAUTH_DISCOVERY_INVALID. The API sends no provider token request and no account is listed.

## custom-connectors-automatic-preflight-010

- Vitest: "Automatic custom connector preflight > rejects an incompatible protected resource https://user:password@automatic-mcp.example.test/tenant before granting an account"
- Mode: run
- Given: An authenticated admin has an automatic MCP connector at https://automatic-mcp.example.test/tenant/mcp. Metadata advertises an incompatible protected resource with user information in the URL.
- When: The admin calls POST /api/custom-connectors/:id/oauth2/start and then lists accounts.
- Then: The start returns HTTP 400 MCP_OAUTH_DISCOVERY_INVALID. The API sends no provider token request and no account is listed.

## custom-connectors-automatic-preflight-011

- Vitest: "Automatic custom connector preflight > preserves endpoint queries through OAuth discovery and connection"
- Mode: run
- Given: An authenticated admin creates an automatic MCP connector whose configured endpoint includes a language query, repeated tag parameters, an empty value, a percent-encoded space and a literal plus.
- When: The admin starts authorization through POST /api/custom-connectors/:id/oauth2/start, follows the OAuth callback and reads saved accounts.
- Then: The start returns HTTP 200 authorization. The transport probe, authorization resource and token exchange resource retain the exact endpoint and query string. One account is saved.

## custom-connectors-automatic-preflight-012

- Vitest: "Automatic custom connector preflight > adds and reconnects cimd accounts only for the exact user, org and definition"
- Mode: run
- Given: An authenticated admin owns an automatic MCP connector with client ID metadata. A different member, another organization and a different custom definition are available.
- When: The admin adds an account through POST /api/custom-connectors/:id/oauth2/start, then callers attempt reconnect using a different user, organization, definition and an unknown account ID. The original owner reconnects the exact account.
- Then: Valid starts return HTTP 200 authorization that completes through consent. Each mismatched reconnect returns HTTP 404 NOT_FOUND. The connected account keeps its ID after reconnect and the other member's list remains empty.

## custom-connectors-automatic-preflight-013

- Vitest: "Automatic custom connector preflight > adds and reconnects dcr accounts only for the exact user, org and definition"
- Mode: run
- Given: An authenticated admin owns an automatic MCP connector with dynamic client registration. A different member, another organization and a different custom definition are available.
- When: The admin adds an account through POST /api/custom-connectors/:id/oauth2/start, then callers attempt reconnect using a different user, organization, definition and an unknown account ID. The original owner reconnects the exact account.
- Then: Valid starts return HTTP 200 authorization that completes through consent. Each mismatched reconnect returns HTTP 404 NOT_FOUND. The connected account keeps its ID after reconnect and the other member's list remains empty.

## custom-connectors-automatic-preflight-014

- Vitest: "Automatic custom connector preflight > adds and reconnects none accounts only for the exact user, org and definition"
- Mode: run
- Given: An authenticated admin owns an automatic MCP connector with no provider authentication. A different member, another organization and a different custom definition are available.
- When: The admin adds an account through POST /api/custom-connectors/:id/oauth2/start, then callers attempt reconnect using a different user, organization, definition and an unknown account ID. The original owner reconnects the exact account.
- Then: Valid starts return HTTP 200 connected directly. Each mismatched reconnect returns HTTP 404 NOT_FOUND. The connected account keeps its ID after reconnect and the other member's list remains empty.

## custom-connectors-automatic-preflight-015

- Vitest: "Automatic custom connector preflight > rejects a definition changed while the cimd provider prepares authorization"
- Mode: run
- Given: An authenticated admin starts an automatic MCP connector authorization with client ID metadata. The provider probe is in progress when the admin changes the endpoint, bringing the stored configuration to version 2.
- When: The request through POST /api/custom-connectors/:id/oauth2/start resumes after the update, and the admin reads the definition and its accounts.
- Then: The start returns HTTP 500 Internal server error. The persisted definition stays at storageVersion 2 and no account is saved. The provider received 0 registration requests.

## custom-connectors-automatic-preflight-016

- Vitest: "Automatic custom connector preflight > rejects a definition changed while the dcr provider prepares authorization"
- Mode: run
- Given: An authenticated admin starts an automatic MCP connector authorization with dynamic client registration. The provider probe is in progress when the admin changes the endpoint, bringing the stored configuration to version 2.
- When: The request through POST /api/custom-connectors/:id/oauth2/start resumes after the update, and the admin reads the definition and its accounts.
- Then: The start returns HTTP 500 Internal server error. The persisted definition stays at storageVersion 2 and no account is saved. The provider received 1 registration requests.

## custom-connectors-automatic-preflight-017

- Vitest: "Automatic custom connector preflight > rejects a definition changed while the none provider prepares authorization"
- Mode: run
- Given: An authenticated admin starts an automatic MCP connector authorization with no provider authentication. The provider probe is in progress when the admin changes the endpoint, bringing the stored configuration to version 2.
- When: The request through POST /api/custom-connectors/:id/oauth2/start resumes after the update, and the admin reads the definition and its accounts.
- Then: The start returns HTTP 500 Internal server error. The persisted definition stays at storageVersion 2 and no account is saved. The provider received 0 registration requests.

## custom-connectors-automatic-preflight-018

- Vitest: "Automatic custom connector preflight > rejects cimd consent after the user deletes its definition"
- Mode: run
- Given: An authenticated owner starts automatic MCP OAuth with client ID metadata, then deletes the custom definition before provider consent finishes.
- When: The provider completes GET /api/custom-connectors/oauth2/callback for the original state and the owner lists custom connectors.
- Then: The callback returns HTTP 200 with status error and message Invalid OAuth state - please try again. There is no provider token exchange and no custom connector remains.

## custom-connectors-automatic-preflight-019

- Vitest: "Automatic custom connector preflight > rejects dcr consent after the user deletes its definition"
- Mode: run
- Given: An authenticated owner starts automatic MCP OAuth with dynamic client registration, then deletes the custom definition before provider consent finishes.
- When: The provider completes GET /api/custom-connectors/oauth2/callback for the original state and the owner lists custom connectors.
- Then: The callback returns HTTP 200 with status error and message Invalid OAuth state - please try again. There is no provider token exchange and no custom connector remains.

## custom-connectors-automatic-preflight-020

- Vitest: "Automatic custom connector preflight > rejects a reconnect account deleted while its provider prepares consent"
- Mode: run
- Given: An authenticated owner has a connected automatic MCP account. Provider preparation is in progress for an attempted reconnect when the owner deletes the exact targeted account.
- When: The earlier POST /api/custom-connectors/:id/oauth2/start request resumes and the owner lists accounts.
- Then: The start returns HTTP 404 NOT_FOUND and the account list is empty.

## custom-connectors-automatic-preflight-021

- Vitest: "Automatic custom connector preflight > rejects consent for a reconnect account deleted after authorization starts"
- Mode: run
- Given: An authenticated owner starts a reconnect for a connected automatic MCP account and deletes that exact account before provider consent finishes.
- When: The provider completes GET /api/custom-connectors/oauth2/callback and the owner lists accounts.
- Then: The callback returns HTTP 200 with status error and the account list is empty.
