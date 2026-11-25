# mcp-server

## mcp-server-001

- Vitest: "external MCP authentication and transport > advertises optional native-client scopes without expanding default MCP consent"
- Mode: run
- Given: The MCP resource `https://api.mcp.example.test/mcp` and its OAuth issuer are configured.
- When: A client requests `GET /.well-known/oauth-protected-resource/mcp`, then calls `POST /mcp` `tools/list` without a token.
- Then: The metadata returns HTTP 200 with the resource, the issuer as authorization server, and `scopes_supported` listing the default MCP scopes plus `okou:voice:transcribe`. The unauthenticated call returns HTTP 401 with a `WWW-Authenticate` scope of only the default scopes (without `okou:voice:transcribe`).

## mcp-server-002

- Vitest: "external MCP authentication and transport > rejects invalid access claims {\"aud\":\"https://different-resource.example.test/mcp\"}"
- Mode: run
- Given: A member of an organization holds an otherwise valid signed MCP access token whose audience is `https://different-resource.example.test/mcp`.
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-003

- Vitest: "external MCP authentication and transport > rejects invalid access claims {}"
- Mode: run
- Given: A member of an organization holds an otherwise valid signed MCP access token without an `org_id` claim.
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-004

- Vitest: "external MCP authentication and transport > rejects invalid access claims {}"
- Mode: run
- Given: A member of an organization holds an otherwise valid signed MCP access token without a `client_id` claim.
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-005

- Vitest: "external MCP authentication and transport > rejects invalid access claims {\"client_id\":\" \u0020\u0020\"}"
- Mode: run
- Given: A member of an organization holds an otherwise valid signed MCP access token whose `client_id` is blank (`"   "`).
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-006

- Vitest: "external MCP authentication and transport > rejects invalid access claims {\"client_id\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}"
- Mode: run
- Given: A member of an organization holds an otherwise valid signed MCP access token whose `client_id` is 2049 characters long.
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-007

- Vitest: "external MCP authentication and transport > rejects invalid access claims {\"sub\":\"machine_client\"}"
- Mode: run
- Given: A member of an organization holds an otherwise valid signed MCP access token whose subject is `machine_client` (not a user).
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-008

- Vitest: "external MCP authentication and transport > rejects invalid access claims {\"exp\":1}"
- Mode: run
- Given: A member of an organization holds an otherwise valid signed MCP access token that expired (`exp` 1).
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-009

- Vitest: "external MCP authentication and transport > rejects invalid access claims {\"nbf\":9000000000}"
- Mode: run
- Given: A member of an organization holds an otherwise valid signed MCP access token that is not yet valid (`nbf` 9000000000).
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-010

- Vitest: "external MCP authentication and transport > rejects the signed JWT token type"
- Mode: run
- Given: A member holds an MCP token signed with the correct key but with token type `JWT` instead of `at+jwt`.
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-011

- Vitest: "external MCP authentication and transport > rejects the signed id+jwt token type"
- Mode: run
- Given: A member holds an MCP token signed with the correct key but with token type `id+jwt` instead of `at+jwt`.
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 with body `{ "error": "invalid_token" }`.

## mcp-server-012

- Vitest: "external MCP authentication and transport > rejects a tampered signature"
- Mode: run
- Given: A member holds an MCP access token whose signature has been replaced with zero bytes.
- When: The client calls `POST /mcp` with `tools/list` and the token.
- Then: The response is HTTP 401 `invalid_token` with a `WWW-Authenticate` header asking for the default MCP scopes.

## mcp-server-013

- Vitest: "external MCP authentication and transport > denies discovery and manual invocation without the read grant"
- Mode: run
- Given: A member holds an MCP token with scopes `user:org:read okou:chat:manage` but without `okou:chat:read`.
- When: The client calls `POST /mcp` with `tools/list`, and `tools/call` for `get_chat_indicators`, `get_chat_thread_list`, `list_projects` and `list_models`.
- Then: Every request returns HTTP 403 with body `{ "error": "insufficient_scope" }`.

## mcp-server-014

- Vitest: "external MCP authentication and transport > requests organization consent when only the application read scope is granted"
- Mode: run
- Given: A member holds an MCP token with only the `okou:chat:read` scope (no organization scope).
- When: The client calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 403 `insufficient_scope` with a `WWW-Authenticate` scope of `user:org:read okou:chat:read`.

## mcp-server-015

- Vitest: "external MCP authentication and transport > rejects an organization outside current membership"
- Mode: run
- Given: A user holds a valid MCP token whose `org_id` is an organization they are not a member of.
- When: The client calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 401 `invalid_token`.

## mcp-server-016

- Vitest: "external MCP authentication and transport > keeps membership outages distinct from invalid credentials"
- Mode: run
- Given: A member holds a valid MCP token, but Clerk's membership lookup fails.
- When: The client calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 503 with error `temporarily_unavailable`.

## mcp-server-017

- Vitest: "external MCP authentication and transport > rejects a removed member after the bounded membership cache expires"
- Mode: run
- Given: A member holds a valid MCP token and is then removed from the organization.
- When: The client calls `POST /mcp` with `tools/list` before the removal and again 61 seconds after it.
- Then: The first call returns HTTP 200. After the membership cache expires the call returns HTTP 401 `invalid_token`.

## mcp-server-018

- Vitest: "external MCP authentication and transport > accepts the supported signed claim representation {\"scp\":[\"user:org:read\",\"okou:chat:read\"]}"
- Mode: run
- Given: A member holds a valid MCP token that carries its scopes as an `scp` array instead of a `scope` string.
- When: The client calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 200.

## mcp-server-019

- Vitest: "external MCP authentication and transport > accepts the supported signed claim representation {\"aud\":[\"https://another.example.test\",\"https://api.mcp.example.test/mcp\"]}"
- Mode: run
- Given: A member holds a valid MCP token whose `aud` is an array containing another audience and the MCP resource.
- When: The client calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 200.

## mcp-server-020

- Vitest: "external MCP authentication and transport > acknowledges legacy initialization notifications without caching them"
- Mode: run
- Given: A member holds a valid MCP token and uses the legacy protocol version `2025-11-25`.
- When: The client posts a `notifications/initialized` notification to `POST /mcp`.
- Then: The response is HTTP 202 with `cache-control: no-store`.

## mcp-server-021

- Vitest: "external MCP authentication and transport > keeps signing-key outages distinct from invalid credentials"
- Mode: run
- Given: A member holds a valid MCP token, and Clerk's JWKS endpoint returns HTTP 503.
- When: The client calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 503 with error `temporarily_unavailable`.

## mcp-server-022

- Vitest: "external MCP authentication and transport > rejects standalone stateless sessions"
- Mode: run
- Given: A member holds a valid MCP token.
- When: The client calls `GET /mcp` and `DELETE /mcp` with legacy protocol headers.
- Then: Both requests return HTTP 405.

## mcp-server-023

- Vitest: "external MCP authentication and transport > rejects Origin https://untrusted.example.test before authorization"
- Mode: run
- Given: An unauthenticated caller sends the header `Origin` set to `https://untrusted.example.test`.
- When: The caller calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 403 with body `{ "error": "Forbidden Origin" }`.

## mcp-server-024

- Vitest: "external MCP authentication and transport > rejects Origin null before authorization"
- Mode: run
- Given: An unauthenticated caller sends the header `Origin` set to `null`.
- When: The caller calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 403 with body `{ "error": "Forbidden Origin" }`.

## mcp-server-025

- Vitest: "external MCP authentication and transport > rejects Origin \u0020before authorization"
- Mode: run
- Given: An unauthenticated caller sends the header `Origin` set to an empty value.
- When: The caller calls `POST /mcp` with `tools/list`.
- Then: The response is HTTP 403 with body `{ "error": "Forbidden Origin" }`.

## mcp-server-026

- Vitest: "external MCP authentication and transport > rejects an unlisted browser origin's preflight and authorized request"
- Mode: run
- Given: A member holds a valid MCP token, and the browser origin `https://client.example.test` is not allowed.
- When: The browser sends a CORS preflight `OPTIONS /mcp` and then an authorized `POST /mcp` `tools/list` from that origin.
- Then: Both return HTTP 403 `Forbidden Origin`, and the authorized response has no `access-control-allow-origin` or `access-control-allow-credentials` header.

## mcp-server-027

- Vitest: "external MCP authentication and transport > bounds the request body before SDK dispatch"
- Mode: run
- Given: A member holds a valid MCP token.
- When: The client calls `POST /mcp` with `tools/list` and a 64 KiB padding parameter.
- Then: The response is HTTP 413.

## mcp-server-028

- Vitest: "external MCP authentication and transport > allows an SSE consumer to cancel without affecting the next request"
- Mode: run
- Given: A member holds a valid MCP token.
- When: The client calls `POST /mcp` `tools/call` for `get_chat_thread_list` with legacy headers, cancels the streamed response body, then calls `tools/list`.
- Then: The streamed call returns HTTP 200, and the following `tools/list` returns HTTP 200.
