# connectors-search

## connectors-search-001

- Vitest: "GET /api/connectors/search > returns 401 when not authenticated"
- Mode: run
- Given: The caller is unauthenticated (no authorization header).
- When: The caller calls `GET /api/connectors/search` without a keyword.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## connectors-search-002

- Vitest: "GET /api/connectors/search > returns connectors array with correct shape"
- Mode: run
- Given: A signed-in workspace member.
- When: The member calls `GET /api/connectors/search` without a keyword.
- Then: The response is HTTP 200 with a `connectors` array of between 1 and 100 entries.

## connectors-search-003

- Vitest: "GET /api/connectors/search > filters connectors by keyword matching slug or label"
- Mode: run
- Given: A signed-in workspace member.
- When: The member calls `GET /api/connectors/search?keyword=GitHub`.
- Then: The response is HTTP 200 with at least one connector, and every result's slug or label contains `github` case-insensitively.

## connectors-search-004

- Vitest: "GET /api/connectors/search > does not search connector descriptions"
- Mode: run
- Given: A signed-in workspace member searches for `permission behavior`, a phrase from connector descriptions rather than slugs or labels.
- When: The member calls `GET /api/connectors/search?keyword=permission behavior`.
- Then: The response is HTTP 200 with an empty `connectors` array.

## connectors-search-005

- Vitest: "GET /api/connectors/search > does not search connector tags"
- Mode: run
- Given: A signed-in workspace member searches for `llm`, a connector tag rather than a slug or label.
- When: The member calls `GET /api/connectors/search?keyword=llm`.
- Then: The response is HTTP 200 with an empty `connectors` array.

## connectors-search-006

- Vitest: "GET /api/connectors/search > performs case-insensitive keyword search"
- Mode: run
- Given: A signed-in workspace member.
- When: The member calls `GET /api/connectors/search` with keyword `github` and then with keyword `GITHUB`.
- Then: Both responses are HTTP 200 and return the same number of connectors.

## connectors-search-007

- Vitest: "GET /api/connectors/search > hides the test OAuth device connector when the test OAuth feature is disabled"
- Mode: run
- Given: A signed-in workspace member without the `TestOauthConnector` feature switch enabled.
- When: The member calls `GET /api/connectors/search?keyword=test oauth device`.
- Then: The response is HTTP 200 and contains no `test-oauth-device` connector.

## connectors-search-008

- Vitest: "GET /api/connectors/search > shows the test OAuth device connector when the test OAuth feature is enabled"
- Mode: run
- Given: A signed-in workspace member has enabled the `TestOauthConnector` feature switch.
- When: The member calls `GET /api/connectors/search?keyword=test oauth device`.
- Then: The response is HTTP 200 and includes `test-oauth-device` with auth methods exactly `[oauth, api]`.

## connectors-search-009

- Vitest: "GET /api/connectors/search > applies accepted auth method visibility to connector search"
- Mode: run
- Given: A signed-in workspace member has saved an empty set of feature switch overrides.
- When: The member calls `GET /api/connectors/search?keyword=cloudflare`.
- Then: The response is HTTP 200 and `cloudflare` lists exactly the auth methods `[oauth]`.

## connectors-search-010

- Vitest: "GET /api/connectors/search > offers LinkedIn OAuth to ordinary workspace members"
- Mode: run
- Given: A signed-in workspace member with the ordinary `org:member` role.
- When: The member calls `GET /api/connectors/search?keyword=linkedin`.
- Then: The response is HTTP 200 and includes `linkedin` with auth methods exactly `[oauth]`.

## connectors-search-011

- Vitest: "GET /api/connectors/search > exposes openai as api-token only"
- Mode: run
- Given: A signed-in workspace member.
- When: The member calls `GET /api/connectors/search` without a keyword.
- Then: The response is HTTP 200 and includes `openai` with auth methods exactly `[api-token]`.

## connectors-search-012

- Vitest: "GET /api/connectors/search > accepts an Okou run token carrying connector:read"
- Mode: run
- Given: A workspace admin's run holds an Okou run execution token that carries the `connector:read` permission.
- When: The run calls `GET /api/connectors/search` with `Authorization: Bearer <run token>`.
- Then: The response is HTTP 200 with a non-empty `connectors` array.
