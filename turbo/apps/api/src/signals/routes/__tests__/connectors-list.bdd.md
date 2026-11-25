# connectors-list

## connectors-list-001

- Vitest: "GET /api/connectors > returns an empty connectors list"
- Mode: run
- Given: A signed-in workspace member has no connector accounts.
- When: The member calls `GET /api/connectors`.
- Then: The response is HTTP 200 with an empty `connectors` array.

## connectors-list-002

- Vitest: "GET /api/connectors > returns connectors created through the connector API"
- Mode: run
- Given: A signed-in member has connected `gitlab` through `POST /api/connectors/gitlab/manual-grant` with the `api-token` method, an access token and host `gitlab.example.com`.
- When: The member calls `GET /api/connectors`.
- Then: The response is HTTP 200 and the `connectors` list contains a `gitlab` entry with `authMethod` `api-token` and status `connected`.

## connectors-list-003

- Vitest: "GET /api/connectors > lists HTTP and MCP accounts"
- Mode: run
- Given: A signed-in member has connected the HTTP connector `gitlab` and the MCP connector `manual-mcp`, both via `api-token` manual grants.
- When: The member calls `GET /api/connectors`.
- Then: The response is HTTP 200 and the listed slugs include both `gitlab` and `manual-mcp`.

## connectors-list-004

- Vitest: "GET /api/connectors > projects the selected default account and removes it after public disconnect"
- Mode: run
- Given: A signed-in member has two `gitlab` `api-token` accounts for different hosts and sets the second one as default via `POST /api/connector-accounts/:connectionId/default`.
- When: The member lists the accounts and calls `GET /api/connectors`, reads the default account, then deletes both accounts through `DELETE /api/connector-accounts/:connectionId` and calls `GET /api/connectors` again.
- Then: The two accounts have different IDs; the account list has two entries with only the second marked default. `GET /api/connectors` returns exactly one `gitlab` entry with the second account's ID and status `connected`, and the default-account read returns the second account. After both deletions `GET /api/connectors` returns exactly `{ connectors: [] }` and the account list has a null `defaultConnection`.

## connectors-list-005

- Vitest: "GET /api/connectors > keeps current-entry account and scope reads available after a capability change"
- Mode: run
- Given: A signed-in member has a connected `gitlab` `api-token` account, and the legacy user-storage bucket is unavailable. After the first list, the deployment changes capabilities by removing the Box OAuth client configuration.
- When: The member calls `GET /api/connectors` before and after the capability change, then reads `GET /api/connector-accounts/connections`, `GET /api/connector-accounts/:connectionId`, its `deletion-impact` and `scope-diff`, and `POST /api/connector-accounts/inspect` for that account.
- Then: The first list contains exactly the `gitlab` entry with the account's ID, `api-token` and `connected`, and the second list is identical. The connections list and single-account read are unchanged. Deletion impact is `{ connectionId, explicitSelectionCount: 0, hasSibling: false }`, the scope diff has empty added, removed, current and stored scopes, and inspect returns one `available` result with the account's fields, no missing required fields and configured field keys `[accessToken, host]`.

## connectors-list-006

- Vitest: "GET /api/connectors > returns 401 when not authenticated"
- Mode: run
- Given: The caller is unauthenticated (no authorization header).
- When: The caller calls `GET /api/connectors`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## connectors-list-007

- Vitest: "GET /api/connectors > returns 401 when the authenticated session has no organization"
- Mode: run
- Given: The caller has a valid session that has no active organization.
- When: The caller calls `GET /api/connectors`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.
