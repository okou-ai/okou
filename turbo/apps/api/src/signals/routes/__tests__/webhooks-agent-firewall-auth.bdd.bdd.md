# webhooks-agent-firewall-auth.bdd

## webhooks-agent-firewall-auth.bdd-001

- Vitest: "FW-1: firewall auth boundaries > rejects missing and malformed firewall auth requests"
- Mode: run
- Given: No running sandbox credential is presented: one request has no Authorization header and another carries the junk bearer token `junk`.
- When: Each request calls `POST /api/webhooks/run/firewall/auth` with empty `authHeaders`.
- Then: Both requests return HTTP 401 with error code `UNAUTHORIZED`.

## webhooks-agent-firewall-auth.bdd-002

- Vitest: "FW-2: template resolution without connector refresh > resolves variable and basic auth header templates"
- Mode: run
- Given: A funded member has a running thread Run whose firewall token is presented. The API environment sets `OKOU_DATA_TOKEN` to `test-data-token` and a data router URL.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with `authHeaders` using a var template (`X-Tenant`), a basic template from a secret and a var (`X-Basic`), a basic template of two quoted literals (`X-Literal-Basic`), and a mixed secret/var header (`X-Shared`), plus `vars` TENANT, BASIC_PASS and OKOU_DATA_TOKEN.
- Then: The response is HTTP 200. `X-Tenant` is `tenant-1`, `X-Basic` is `Basic` base64 of `test-data-token:var-pass`, `X-Literal-Basic` is `Basic` base64 of `alice:literal-pass`, and `X-Shared` is `test-data-token:var-shared`. `refreshedConnectors` and `refreshedSecrets` are empty.

## webhooks-agent-firewall-auth.bdd-003

- Vitest: "FW-2: template resolution without connector refresh > resolves secret templates in the base URL and query"
- Mode: run
- Given: A funded member has a running thread Run whose firewall token is presented. The API environment sets `OKOU_DATA_TOKEN` to `test-data-token`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with empty `authHeaders`, an `authBase` of `https://api.example.test/` plus the `OKOU_DATA_TOKEN` secret template, and an `authQuery` `token` set to the same secret template.
- Then: The response is HTTP 200 with `base` `https://api.example.test/test-data-token`, `query` `{ token: "test-data-token" }`, `expiresAt` null, empty `refreshedConnectors` and `refreshedSecrets`, and `resolvedSecrets` exactly `["OKOU_DATA_TOKEN"]`.

## webhooks-agent-firewall-auth.bdd-004

- Vitest: "FW-2: template resolution without connector refresh > reports unresolvable template references as connector-not-configured"
- Mode: run
- Given: A funded member has a running thread Run whose firewall token is presented. No credential source exists for the secret `NEVER_SET`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with an `Authorization` header template referencing secret `NEVER_SET` and an empty `secretConnectorMap`.
- Then: The response is HTTP 424 with error code `CONNECTOR_NOT_CONFIGURED`.

## webhooks-agent-firewall-auth.bdd-005

- Vitest: "FW-2: template resolution without connector refresh > uses pinned routing variables and current auth-only variables for builtin connectors"
- Mode: run
- Given: A funded member has a running thread Run and connects Jira by manual API token with domain `current.atlassian.net` and email `current@example.test`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with `X-Domain` and `X-Email` var templates, run-start `vars` (`run-start.atlassian.net`, `run-start@example.test`), and a `matchedFirewall` for the Jira connection pinning `JIRA_DOMAIN` to `run-start.atlassian.net`. The member then deletes the Jira account and the Run repeats the request.
- Then: The first response is HTTP 200 with headers exactly `X-Domain: run-start.atlassian.net` and `X-Email: current@example.test`. After disconnection, the response is HTTP 424 with error code `CONNECTOR_NOT_CONFIGURED`.

## webhooks-agent-firewall-auth.bdd-006

- Vitest: "FW-2: template resolution without connector refresh > passes literals through query templates and keeps basic-literal templates opaque"
- Mode: run
- Given: A funded member has a running thread Run whose firewall token is presented. Secret `NEVER_SET` has no credential source.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with basic templates of empty arguments, a quoted literal containing the `NEVER_SET` secret template plus `vars.PASS`, and a quoted `"vars.PASS"` literal plus `vars.PASS`, and an `authQuery` with a literal `token` and a `WORKSPACE_ID` var template. It then sends a second request with only a static `Authorization: Bearer static-token` header and no query.
- Then: The first response is HTTP 200: `X-Empty-Basic` is `Basic` base64 of `:`, `X-Literal-Template` is `Basic` base64 of the literal `NEVER_SET` template text plus `:configured-pass`, `X-Quoted-Namespace` is `Basic` base64 of `vars.PASS:configured-pass`, `query` is `{ token: "literal-query-value", workspace: "workspace-9" }`, and `resolvedSecrets` is empty. The second response is HTTP 200 with no `query` and `Authorization` `Bearer static-token`.

## webhooks-agent-firewall-auth.bdd-007

- Vitest: "FW-3: billable firewall lease > leases billable auth for limited-free-1 workspaces with spendable credits"
- Mode: run
- Given: A funded Pro member has a running thread Run. A signed Stripe `customer.subscription.deleted` webhook cancels the subscription, after which billing status reads tier `limited-free-1`, status `active`, with 20,000 credits.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with empty `authHeaders` and `firewallBillable: true`.
- Then: The response is HTTP 200 and `expiresAt` is between 25 and 35 seconds after the request time.

## webhooks-agent-firewall-auth.bdd-008

- Vitest: "FW-3: billable firewall lease > denies billable auth for suspended workspaces even with credits"
- Mode: run
- Given: A funded Pro member has a running thread Run. A signed Stripe `customer.subscription.updated` webhook sets the subscription to `canceled` without a period-end cancel, after which billing status reads tier `pro`, status `suspended`, with 20,000 credits.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with empty `authHeaders` and `firewallBillable: true`.
- Then: The response is HTTP 402 with error code `INSUFFICIENT_CREDITS`.

## webhooks-agent-firewall-auth.bdd-009

- Vitest: "FW-3: billable firewall lease > does not refresh an expired connector when billable auth is denied"
- Mode: run
- Given: A Pro member has a running tool Run and a Test OAuth connector whose access token expired 60 seconds ago. The provider token endpoint would return a fresh token. The member's Pro plan is then canceled.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the member's exact Test OAuth account and `firewallBillable: true`.
- Then: The response is HTTP 402 with error code `INSUFFICIENT_CREDITS`, and the provider token endpoint receives zero refresh requests.

## webhooks-agent-firewall-auth.bdd-010

- Vitest: "FW-3: billable firewall lease > bounds billable auth expiry by the credit authorization lease"
- Mode: run
- Given: A funded member has a running thread Run whose firewall token is presented.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with empty `authHeaders` and `firewallBillable: true`.
- Then: The response is HTTP 200 and `expiresAt` is between 25 and 35 seconds after the request time.

## webhooks-agent-firewall-auth.bdd-011

- Vitest: "FW-3: billable firewall lease > merges the billable lease with refreshed connector token expiries"
- Mode: run
- Given: A member has a running Run and a Test OAuth connector whose access token expired 60 seconds ago. The provider first refreshes with a token valid for 3600 seconds, then later with a token valid for 65 seconds.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account and `firewallBillable: true`, then repeats it with `forceRefresh: true`.
- Then: The first response is HTTP 200 with `Authorization` `Bearer long-lived-access` and `expiresAt` 25 to 35 seconds ahead (the billable lease bound). The forced response is HTTP 200 with `Authorization` `Bearer short-lived-access` and `expiresAt` 1 to 10 seconds ahead (the token bound).

## webhooks-agent-firewall-auth.bdd-012

- Vitest: "FW-3: billable firewall lease > continues billable firewall auth after subscription deletion when credits remain"
- Mode: run
- Given: A member with a Pro entitlement has a running thread Run, and a billable firewall auth request has already succeeded.
- When: A signed Stripe `customer.subscription.deleted` webhook is posted, then the Run calls `POST /api/webhooks/run/firewall/auth` again with `firewallBillable: true`; afterwards the member cancels the Run and the sandbox reports completion.
- Then: Billing status reads tier `limited-free-1` and subscription status `canceled`. The post-deletion firewall auth returns HTTP 200 with `expiresAt` 25 to 35 seconds ahead. Cancelling the Run and posting the agent completion both return HTTP 200.

## webhooks-agent-firewall-auth.bdd-013

- Vitest: "FW-3: billable firewall lease > denies billable firewall auth when the granted credits already expired"
- Mode: run
- Given: A member holds a Pro entitlement whose period ended 60 days ago, so all granted credits have expired, and has a running thread Run.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with empty `authHeaders` and `firewallBillable: true`.
- Then: The response is HTTP 402 with error code `INSUFFICIENT_CREDITS`. Cancelling the Run and posting the agent completion afterwards both return HTTP 200.

## webhooks-agent-firewall-auth.bdd-014

- Vitest: "FW-4: connector refresh and replacement snapshots > defaults the refreshed expiry when the provider omits expires_in"
- Mode: run
- Given: A member has a running Run and a Test OAuth connector whose access token expired 60 seconds ago. The provider refreshes with access token `fresh-no-expiry` and omits `expires_in`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the member's exact Test OAuth account.
- Then: The response is HTTP 200 with `Authorization` `Bearer fresh-no-expiry` and `expiresAt` 835 to 845 seconds after the request time.

## webhooks-agent-firewall-auth.bdd-015

- Vitest: "FW-4: connector refresh and replacement snapshots > refreshes a stored token with 0 seconds remaining at the effective boundary"
- Mode: run
- Given: A member has a running Run and a Test OAuth connector whose stored token has 0 seconds remaining. The provider refreshes with a token valid for 3600 seconds.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account.
- Then: The response is HTTP 200 with `Authorization` `Bearer positive-lifetime-access`, `expiresAt` 3535 to 3545 seconds ahead, and `refreshedConnectors` `["test-oauth"]`. The provider receives exactly one refresh request.

## webhooks-agent-firewall-auth.bdd-016

- Vitest: "FW-4: connector refresh and replacement snapshots > refreshes a stored token with 60 seconds remaining at the effective boundary"
- Mode: run
- Given: A member has a running Run and a Test OAuth connector whose stored token has 60 seconds remaining. The provider refreshes with a token valid for 3600 seconds.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account.
- Then: The response is HTTP 200 with `Authorization` `Bearer positive-lifetime-access`, `expiresAt` 3535 to 3545 seconds ahead, and `refreshedConnectors` `["test-oauth"]`. The provider receives exactly one refresh request.

## webhooks-agent-firewall-auth.bdd-017

- Vitest: "FW-4: connector refresh and replacement snapshots > fails closed after a 0-second refresh and retains rotation for later recovery"
- Mode: run
- Given: A member has a running Run and an expired Test OAuth connector with refresh token `refresh-1`. The provider's first refresh returns a rotated refresh token with a 0-second access-token lifetime; later refreshes return a 3600-second token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account, then repeats the same request.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, connectors `["test-oauth"]` and `failureReason` `upstream_provider`, after one refresh using `refresh-1`. The second response is HTTP 200 with `Bearer recovered-access` and `expiresAt` 3535 to 3545 seconds ahead; the provider saw refresh tokens `refresh-1` then `rotated-refresh`.

## webhooks-agent-firewall-auth.bdd-018

- Vitest: "FW-4: connector refresh and replacement snapshots > fails closed after a 5-second refresh and retains rotation for later recovery"
- Mode: run
- Given: A member has a running Run and an expired Test OAuth connector with refresh token `refresh-1`. The provider's first refresh returns a rotated refresh token with a 5-second access-token lifetime; later refreshes return a 3600-second token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account, then repeats the same request.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, connectors `["test-oauth"]` and `failureReason` `upstream_provider`, after one refresh using `refresh-1`. The second response is HTTP 200 with `Bearer recovered-access` and `expiresAt` 3535 to 3545 seconds ahead; the provider saw refresh tokens `refresh-1` then `rotated-refresh`.

## webhooks-agent-firewall-auth.bdd-019

- Vitest: "FW-4: connector refresh and replacement snapshots > fails closed after a 60-second refresh and retains rotation for later recovery"
- Mode: run
- Given: A member has a running Run and an expired Test OAuth connector with refresh token `refresh-1`. The provider's first refresh returns a rotated refresh token with a 60-second access-token lifetime; later refreshes return a 3600-second token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account, then repeats the same request.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, connectors `["test-oauth"]` and `failureReason` `upstream_provider`, after one refresh using `refresh-1`. The second response is HTTP 200 with `Bearer recovered-access` and `expiresAt` 3535 to 3545 seconds ahead; the provider saw refresh tokens `refresh-1` then `rotated-refresh`.

## webhooks-agent-firewall-auth.bdd-020

- Vitest: "FW-4: connector refresh and replacement snapshots > preserves mixed refresh failures and rotation when one refreshed lifetime is unusable"
- Mode: run
- Given: A member has a running Run with expired Test OAuth and Gmail connectors. The Test OAuth provider first refreshes with a rotated refresh token and a 60-second lifetime, later with a 3600-second token. Google's token endpoint rejects the Gmail refresh with `invalid_grant`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with both `TEST_OAUTH_TOKEN` and `GMAIL_TOKEN` header templates mapped to exact accounts, then retries with only the Test OAuth header.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, connectors `gmail` and `test-oauth`, and no `failureReason`; the Test OAuth provider saw only `refresh-1`. The retry is HTTP 200 with `Bearer recovered-access`, `refreshedConnectors` `["test-oauth"]`, `expiresAt` 3535 to 3545 seconds ahead, and refresh tokens `refresh-1` then `rotated-refresh`.

## webhooks-agent-firewall-auth.bdd-021

- Vitest: "FW-4: connector refresh and replacement snapshots > re-runs refresh for a current connector when forceRefresh is set"
- Mode: run
- Given: A member has a running Run and a Test OAuth connector whose token is still valid for 3600 seconds. The provider would refresh to `forced-access`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account and `forceRefresh: true`.
- Then: The response is HTTP 200 with `Authorization` `Bearer forced-access`, `refreshedConnectors` `["test-oauth"]`, and `expiresAt` 3535 to 3545 seconds ahead.

## webhooks-agent-firewall-auth.bdd-022

- Vitest: "FW-4: connector refresh and replacement snapshots > classifies Automatic MCP OAuth invalid_grant refresh failures"
- Mode: run
- Given: A funded member has a running thread Run and a custom Automatic-auth MCP connector registered via CIMD, connected through OAuth with a one-hour token. The provider's token endpoint rejects refresh with `invalid_grant`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with the custom connector's access-token header template, a `matchedFirewall` for the account, and `forceRefresh: true`; it then repeats the request with `forceRefresh` false and true.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, the connector ID, and `failureReason` `reconnect_required`; the account lists as `reconnect-required`. The provider saw an authorization-code grant then one refresh grant. Both repeats return HTTP 502 with `reconnect_required`, and the provider saw four token requests in total.

## webhooks-agent-firewall-auth.bdd-023

- Vitest: "FW-4: connector refresh and replacement snapshots > classifies Automatic MCP OAuth temporarily_unavailable refresh failures"
- Mode: run
- Given: A funded member has a running thread Run and a custom Automatic-auth MCP connector registered via CIMD, connected through OAuth with a one-hour token. The provider's token endpoint returns `temporarily_unavailable` on the first refresh only.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with the custom connector's access-token header template, a `matchedFirewall` for the account, and `forceRefresh: true`, then repeats the same request.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, the connector ID, and `failureReason` `upstream_provider`; the account stays `connected`. The repeat is HTTP 200 with `Bearer automatic-refreshed-access-token` and the connector ID in `refreshedConnectors`; the third token request is a `refresh_token` grant whose `resource` is the MCP endpoint.

## webhooks-agent-firewall-auth.bdd-024

- Vitest: "FW-4: connector refresh and replacement snapshots > classifies Automatic MCP OAuth invalid_client refresh failures"
- Mode: run
- Given: A funded member has a running thread Run and a custom Automatic-auth MCP connector registered via DCR, with two OAuth-connected accounts. The provider's token endpoint rejects refresh with `invalid_client`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with the custom connector's access-token header template, a `matchedFirewall` for the first account, and `forceRefresh: true`. The member then starts a reconnect for that account.
- Then: The response is HTTP 502 with `TOKEN_REFRESH_FAILED`, the connector ID, and `failureReason` `reconnect_required`. The provider saw two authorization-code grants then one refresh grant. Both accounts list as `reconnect-required`, and starting the reconnect performs a second client registration.

## webhooks-agent-firewall-auth.bdd-025

- Vitest: "FW-4: connector refresh and replacement snapshots > maintains authoritative and unknown OAuth grants across refresh"
- Mode: run
- Given: A member has a running Run with an Automatic OAuth catalog connector whose grant reports no scopes, plus a Test OAuth connector granted scopes `read provider-added`. Test OAuth refresh first returns scope `provider-added`, then omits scope.
- When: The Run force-refreshes the Test OAuth source twice via `POST /api/webhooks/run/firewall/auth`, then force-refreshes the Automatic connector through its matched firewall.
- Then: The Run's execution input lists the Automatic connection as a runtime target and firewall. The first refresh returns `Bearer narrow-scoped-access` and narrows stored scopes to `["provider-added"]` while staying `connected`; the scope diff shows current and stored `["read"]` with no additions or removals. The omitted-scope refresh keeps `["provider-added"]`. The Automatic refresh returns HTTP 200 with `Bearer automatic-refreshed-access-token` and empty `refreshedConnectors`; its token requests are an authorization-code then a refresh grant, and its scopes stay null.

## webhooks-agent-firewall-auth.bdd-026

- Vitest: "FW-4: connector refresh and replacement snapshots > resolves a current stored connector token"
- Mode: run
- Given: A member has a running Run and a Test OAuth connector with stored access token `db-access` valid for 3600 seconds.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account.
- Then: The response is HTTP 200 with `Authorization` `Bearer db-access`, empty `refreshedConnectors`, and `expiresAt` 3535 to 3545 seconds ahead.

## webhooks-agent-firewall-auth.bdd-027

- Vitest: "FW-4: connector refresh and replacement snapshots > keeps multi-secret connector auth on one replacement snapshot"
- Mode: run
- Given: A funded member has a running thread Run and an AWS connector connected through the external-code flow. The AWS provider issues an old credential set first and a new set on the next connection.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with headers templating `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` mapped to the exact AWS account; while the API is decrypting the stored credentials, the member reconnects AWS so the account is replaced.
- Then: The replacement connection succeeds and the provider receives two token requests. The firewall auth returns HTTP 200 with all three headers taken from the old credential set (no mix of old and new values).

## webhooks-agent-firewall-auth.bdd-028

- Vitest: "FW-4: connector refresh and replacement snapshots > retries standard OAuth authorization_expired_or_revoked and recovers"
- Mode: run
- Given: A funded member has a running thread Run and a Test OAuth connector with refresh token `original-refresh`. The provider rejects refreshes with `invalid_grant` and no error subtype.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` three times with `forceRefresh` true, false, true; the provider then recovers and the Run retries; finally the member reconnects the account with a new refresh token and the Run force-refreshes.
- Then: All three failures are HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `reconnect_required`, connectors `["test-oauth"]`, and three provider calls; the account lists as `reconnect-required` with reason `authorization_expired_or_revoked`. The retry returns HTTP 200 with `Bearer recovered-without-reconnect` and the account returns to `connected` with no reason. After reconnecting, the account is `connected` and the forced refresh returns `Bearer reconnected-access`, using refresh token `replacement-refresh`.

## webhooks-agent-firewall-auth.bdd-029

- Vitest: "FW-4: connector refresh and replacement snapshots > retries standard OAuth provider_session_expired and recovers"
- Mode: run
- Given: A funded member has a running thread Run and a Test OAuth connector with refresh token `original-refresh`. The provider rejects refreshes with `invalid_grant` and error subtype `invalid_rapt`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` three times with `forceRefresh` true, false, true; the provider then recovers and the Run retries; finally the member reconnects the account with a new refresh token and the Run force-refreshes.
- Then: All three failures are HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `reconnect_required`, connectors `["test-oauth"]`, and three provider calls; the account lists as `reconnect-required` with reason `provider_session_expired`. The retry returns HTTP 200 with `Bearer recovered-without-reconnect` and the account returns to `connected` with no reason. After reconnecting, the account is `connected` and the forced refresh returns `Bearer reconnected-access`, using refresh token `replacement-refresh`.

## webhooks-agent-firewall-auth.bdd-030

- Vitest: "FW-4: connector refresh and replacement snapshots > requires reconnect for unknown OAuth refresh error subtypes"
- Mode: run
- Given: A member has a running Run and an expired Test OAuth connector. The provider rejects refresh with `invalid_grant` and an unknown, over-long error subtype starting `invalid_rapt:`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account, and the member then reads the account.
- Then: The response is HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `reconnect_required` and connectors `["test-oauth"]`. The account reads as `reconnect-required` with a null reconnect reason.

## webhooks-agent-firewall-auth.bdd-031

- Vitest: "FW-4: connector refresh and replacement snapshots > classifies transient OAuth refresh errors as upstream failures"
- Mode: run
- Given: A member has a running Run and an expired Test OAuth connector. The provider first rejects refresh with HTTP 400 `temporarily_unavailable`, then later returns a fresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account, then repeats it after the provider recovers.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `upstream_provider` and connectors `["test-oauth"]`. The second response is HTTP 200 with `Authorization` `Bearer after-temporary-outage`.

## webhooks-agent-firewall-auth.bdd-032

- Vitest: "FW-4: connector refresh and replacement snapshots > classifies provider 500s as upstream failures without marking reconnect"
- Mode: run
- Given: A member has a running Run and an expired Test OAuth connector. The provider token endpoint first returns HTTP 500, then later a fresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account, then repeats it after the provider recovers.
- Then: The first response is HTTP 502 with `failureReason` `upstream_provider`. The second response is HTTP 200 with `Authorization` `Bearer after-outage`.

## webhooks-agent-firewall-auth.bdd-033

- Vitest: "FW-4: connector refresh and replacement snapshots > recovers a temporary Gmail OAuth response within the same refresh"
- Mode: run
- Given: A member has a running Run and a Gmail connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint first returns HTTP 400 `temporarily_unavailable`, then a fresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GMAIL_TOKEN` bearer template mapped to the exact Gmail account.
- Then: The response is HTTP 200 with `Authorization` `Bearer recovered-gmail-access`, after exactly two token requests.

## webhooks-agent-firewall-auth.bdd-034

- Vitest: "FW-4: connector refresh and replacement snapshots > preserves the Gmail grant after an exhausted temporary retry"
- Mode: run
- Given: A member has a running Run and a Gmail connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint returns HTTP 503 `server_error` with a private description on every attempt, and later returns a fresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GMAIL_TOKEN` bearer template mapped to the exact Gmail account. It then repeats the request after Google recovers.
- Then: The first response is HTTP 502 with `failureReason` `upstream_provider` after exactly two token requests, and the body does not contain the provider's private description. The repeat returns HTTP 200 with `Bearer later-gmail-access`.

## webhooks-agent-firewall-auth.bdd-035

- Vitest: "FW-4: connector refresh and replacement snapshots > does not retry a Gmail invalid_grant response"
- Mode: run
- Given: A member has a running Run and a Gmail connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint returns HTTP 400 `invalid_grant`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GMAIL_TOKEN` bearer template mapped to the exact Gmail account.
- Then: The response is HTTP 502 with `failureReason` `reconnect_required`, after exactly one token request.

## webhooks-agent-firewall-auth.bdd-036

- Vitest: "FW-4: connector refresh and replacement snapshots > does not retry a rate-limited Gmail refresh without Retry-After handling"
- Mode: run
- Given: A member has a running Run and a Gmail connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint returns HTTP 429 `temporarily_unavailable`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GMAIL_TOKEN` bearer template mapped to the exact Gmail account.
- Then: The response is HTTP 502 with `failureReason` `upstream_provider`, after exactly one token request.

## webhooks-agent-firewall-auth.bdd-037

- Vitest: "FW-4: connector refresh and replacement snapshots > does not replay a Gmail refresh after an ambiguous network failure"
- Mode: run
- Given: A member has a running Run and a Gmail connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. The connection to Google's token endpoint fails with a network error.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GMAIL_TOKEN` bearer template mapped to the exact Gmail account.
- Then: The response is HTTP 502 with `failureReason` `upstream_provider`, after exactly one token request.

## webhooks-agent-firewall-auth.bdd-038

- Vitest: "FW-4: connector refresh and replacement snapshots > recovers Google Sheets network failures on attempt 1"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint succeeds on the first attempt (no network failures).
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account.
- Then: The response is HTTP 200 with `Authorization` `Bearer recovered-sheets-access` and `refreshedConnectors` `["google-sheets"]`, after exactly one token request.

## webhooks-agent-firewall-auth.bdd-039

- Vitest: "FW-4: connector refresh and replacement snapshots > recovers Google Sheets network failures on attempt 2"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. The first token request fails with a network error and the second succeeds.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account.
- Then: The response is HTTP 200 with `Authorization` `Bearer recovered-sheets-access` and `refreshedConnectors` `["google-sheets"]`, after exactly two token requests.

## webhooks-agent-firewall-auth.bdd-040

- Vitest: "FW-4: connector refresh and replacement snapshots > recovers Google Sheets network failures on attempt 3"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. The first two token requests fail with network errors and the third succeeds.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account.
- Then: The response is HTTP 200 with `Authorization` `Bearer recovered-sheets-access` and `refreshedConnectors` `["google-sheets"]`, after exactly three token requests.

## webhooks-agent-firewall-auth.bdd-041

- Vitest: "FW-4: connector refresh and replacement snapshots > recovers Google Sheets temporary OAuth responses on the third attempt"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint returns an empty HTTP 503, then HTTP 400 `temporarily_unavailable`, then a fresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account.
- Then: The response is HTTP 200 with `Authorization` `Bearer recovered-sheets-access`, after exactly three token requests.

## webhooks-agent-firewall-auth.bdd-042

- Vitest: "FW-4: connector refresh and replacement snapshots > preserves the Google Sheets grant after three network failures"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Every token request fails with a network error until Google later recovers.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account. It then repeats the request after Google recovers.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `upstream_provider`, connectors `["google-sheets"]`, after exactly three token requests, with no provider private text in the body. The account stays `connected`, and the repeat returns HTTP 200 with `Bearer later-sheets-access`.

## webhooks-agent-firewall-auth.bdd-043

- Vitest: "FW-4: connector refresh and replacement snapshots > preserves the Google Sheets grant after three temporary-response failures"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Every token request returns HTTP 503 `server_error` with a private description until Google later recovers.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account. It then repeats the request after Google recovers.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `upstream_provider`, connectors `["google-sheets"]`, after exactly three token requests, and the body does not contain the private description. The account stays `connected`, and the repeat returns HTTP 200 with `Bearer later-sheets-access`.

## webhooks-agent-firewall-auth.bdd-044

- Vitest: "FW-4: connector refresh and replacement snapshots > stops Google Sheets retries at invalid_grant after 0 transient failures"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint immediately returns HTTP 400 `invalid_grant` (0 transient failures).
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account.
- Then: The response is HTTP 502 with `failureReason` `reconnect_required` after exactly one token request, and the account reads as `reconnect-required`.

## webhooks-agent-firewall-auth.bdd-045

- Vitest: "FW-4: connector refresh and replacement snapshots > stops Google Sheets retries at invalid_grant after 1 transient failures"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. The first token request fails with a network error and the second returns HTTP 503 `invalid_grant` (1 transient failure).
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account.
- Then: The response is HTTP 502 with `failureReason` `reconnect_required` after exactly two token requests, and the account reads as `reconnect-required`.

## webhooks-agent-firewall-auth.bdd-046

- Vitest: "FW-4: connector refresh and replacement snapshots > does not retry a rate-limited Google Sheets refresh"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint returns HTTP 429 `temporarily_unavailable`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account.
- Then: The response is HTTP 502 with `failureReason` `upstream_provider`, after exactly one token request.

## webhooks-agent-firewall-auth.bdd-047

- Vitest: "FW-4: connector refresh and replacement snapshots > does not retry malformed Google Sheets refresh output"
- Mode: run
- Given: A member has a running Run and a Google Sheets connector whose access token expired 60 seconds ago, with Google OAuth client credentials configured. Google's token endpoint returns a body with `expires_in` but no access token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_SHEETS_TOKEN` bearer template mapped to the exact Google Sheets account.
- Then: The response is HTTP 502 with `TOKEN_REFRESH_FAILED`, after exactly one token request.

## webhooks-agent-firewall-auth.bdd-048

- Vitest: "FW-4: connector refresh and replacement snapshots > treats refresh responses without an access token as upstream failures"
- Mode: run
- Given: A member has a running Run and an expired Test OAuth connector. The provider's refresh endpoint returns `{ ok: true }` with no access token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account.
- Then: The response is HTTP 502 with `TOKEN_REFRESH_FAILED` and connectors `["test-oauth"]`.

## webhooks-agent-firewall-auth.bdd-049

- Vitest: "FW-4: connector refresh and replacement snapshots > requires reconnect when the stored connector never kept a refresh token"
- Mode: run
- Given: A member has a running Run and a Test OAuth connector whose access token expired 60 seconds ago and that was stored without a refresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` twice with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account, and the member then reads the account.
- Then: The first response is HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `reconnect_required` and connectors `["test-oauth"]`. The second response is also HTTP 502 with `reconnect_required`. The account reads as `reconnect-required`.

## webhooks-agent-firewall-auth.bdd-050

- Vitest: "FW-4: connector refresh and replacement snapshots > classifies network refresh failures as upstream and recovers"
- Mode: run
- Given: A member has a running Run and an expired Test OAuth connector. The connection to the provider's token endpoint first fails with a network error, then later succeeds.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account, then repeats it after the provider recovers.
- Then: The first response is HTTP 502 with `failureReason` `upstream_provider` and connectors `["test-oauth"]`. The second response is HTTP 200 with `Authorization` `Bearer after-network-outage`.

## webhooks-agent-firewall-auth.bdd-051

- Vitest: "FW-4: connector refresh and replacement snapshots > treats malformed and failing provider token responses as upstream failures"
- Mode: run
- Given: A funded member has a running thread Run and a Lark connector connected by manual app ID and app secret. Lark's tenant access token endpoint first returns `{ code: 0, msg: "ok" }` without a token, then later returns HTTP 500.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `LARK_TOKEN` bearer template mapped to the exact Lark account, once against each provider behavior.
- Then: The malformed response yields HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `upstream_provider` and connectors `["lark"]`. The HTTP 500 yields HTTP 502 with `failureReason` `upstream_provider` and connectors `["lark"]`.

## webhooks-agent-firewall-auth.bdd-052

- Vitest: "FW-4: connector refresh and replacement snapshots > refreshes mapped-input connector access and stores its variable outputs"
- Mode: run
- Given: A member has a running Run and a Test OAuth connector connected through its `api` auth method, with an access token that expired 60 seconds ago. The provider refreshes to `fresh-api-access` with a rotated refresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` twice with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact account.
- Then: The first response is HTTP 200 with `Bearer fresh-api-access`, `refreshedConnectors` `["test-oauth"]` and `refreshedSecrets` `["TEST_OAUTH_TOKEN"]`. The second response is HTTP 200 with `Bearer fresh-api-access` and empty `refreshedConnectors`.

## webhooks-agent-firewall-auth.bdd-053

- Vitest: "FW-5: terminal runs close firewall credential authority > rejects a completed run before connector refresh"
- Mode: run
- Given: A funded member has a thread Run and an expired Test OAuth connector. The sandbox completes the Run successfully through the public Claude completion flow, so it reads back as `completed`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact Test OAuth account.
- Then: The Run reads back with the terminal status, the firewall auth returns HTTP 403 with error code `FORBIDDEN`, and the provider receives zero refresh requests.

## webhooks-agent-firewall-auth.bdd-054

- Vitest: "FW-5: terminal runs close firewall credential authority > rejects a failed run before connector refresh"
- Mode: run
- Given: A funded member has a thread Run and an expired Test OAuth connector. The sandbox posts an agent completion with exit code 1, so the Run reads back as `failed`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact Test OAuth account.
- Then: The Run reads back with the terminal status, the firewall auth returns HTTP 403 with error code `FORBIDDEN`, and the provider receives zero refresh requests.

## webhooks-agent-firewall-auth.bdd-055

- Vitest: "FW-5: terminal runs close firewall credential authority > rejects a cancelled run before connector refresh"
- Mode: run
- Given: A funded member has a thread Run and an expired Test OAuth connector. The member cancels the Run, so it reads back as `cancelled`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_TOKEN` bearer template mapped to the exact Test OAuth account.
- Then: The Run reads back with the terminal status, the firewall auth returns HTTP 403 with error code `FORBIDDEN`, and the provider receives zero refresh requests.

## webhooks-agent-firewall-auth.bdd-056

- Vitest: "FW-6: manual-grant api-token refresh without a provider client > resolves a missing alias through the synchronous input-driven refresh"
- Mode: run
- Given: A funded member has a running thread Run and a Test OAuth connector connected by manual API token `manual-secret` with input variable `manual-var` and tenant `tenant-x`; no provider OAuth client is involved.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_API_TOKEN` bearer template mapped to the exact account.
- Then: The response is HTTP 200 with `Authorization` `Bearer fresh-test-oauth-api-token:manual-secret:manual-var`, `refreshedConnectors` `["test-oauth"]`, and `expiresAt` at least 3500 seconds ahead.

## webhooks-agent-firewall-auth.bdd-057

- Vitest: "FW-8: static access tokens and unavailable sources > requires reconnect for expired static tokens and syncs current ones"
- Mode: run
- Given: A member has a running Run and a Test OAuth Device connector whose static access token expired 60 seconds ago.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_DEVICE_TOKEN` bearer template mapped to the exact account. The member then deletes the account, connects a new device token valid for 3600 seconds, and the Run repeats the request against the new account.
- Then: The first response is HTTP 502 with `failureReason` `reconnect_required` and connectors `["test-oauth-device"]`. The second response is HTTP 200 with `Bearer current-device` and empty `refreshedConnectors`.

## webhooks-agent-firewall-auth.bdd-058

- Vitest: "FW-8: static access tokens and unavailable sources > serves static device tokens that were stored without an expiry"
- Mode: run
- Given: A member has a running Run and a Test OAuth Device connector whose static token `no-expiry-device` was stored without an expiry.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `TEST_OAUTH_DEVICE_TOKEN` bearer template mapped to the exact account.
- Then: The response is HTTP 200 with `Bearer no-expiry-device`, empty `refreshedConnectors`, and null `expiresAt`.

## webhooks-agent-firewall-auth.bdd-059

- Vitest: "FW-8: static access tokens and unavailable sources > reports aliases for never-connected connector slugs as not configured"
- Mode: run
- Given: A funded member has a running thread Run and has never connected Notion.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `NOTION_TOKEN` bearer template and `secretConnectorMap` mapping it to `notion`.
- Then: The response is HTTP 424 with error code `CONNECTOR_NOT_CONFIGURED`.

## webhooks-agent-firewall-auth.bdd-060

- Vitest: "FW-9: codex model-provider access > refreshes the exact owned Codex account and serves its stored token afterwards"
- Mode: run
- Given: A member with an active plan has a running thread Run and a personal Codex (ChatGPT) model provider connected by pasting auth JSON, with an access token that expired 60 seconds ago. The ChatGPT token endpoint refreshes to `fresh-chatgpt-token`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` twice with a `CHATGPT_ACCESS_TOKEN` bearer template mapped to `codex-oauth-token` with model-provider metadata naming the member and the exact owned Codex account.
- Then: The first response is HTTP 200 with `Bearer fresh-chatgpt-token`, `refreshedConnectors` `["codex-oauth-token"]` and `refreshedSecrets` `["CHATGPT_ACCESS_TOKEN"]`. The second response is HTTP 200 with `Bearer fresh-chatgpt-token` and empty `refreshedConnectors`.

## webhooks-agent-firewall-auth.bdd-061

- Vitest: "FW-9: codex model-provider access > rejects Codex access when concrete account metadata is omitted"
- Mode: run
- Given: A member with an active plan has a running thread Run and a personal Codex (ChatGPT) model provider connected by pasting auth JSON, with an expired access token. The ChatGPT token endpoint would return a refreshed token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `CHATGPT_ACCESS_TOKEN` bearer template mapped to `codex-oauth-token` but no source metadata.
- Then: The response is HTTP 403 with error code `FORBIDDEN` and no `headers` field.

## webhooks-agent-firewall-auth.bdd-062

- Vitest: "FW-9: codex model-provider access > rejects cross-user model-provider sources and unknown aliases"
- Mode: run
- Given: A member with an active plan has a running thread Run and a personal Codex (ChatGPT) model provider connected by pasting auth JSON, with an expired access token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` three times: with model-provider metadata naming another user, with an unknown `CHATGPT_REFRESH_TOKEN` alias carrying the owned account metadata, and with metadata naming the member but no concrete account ID.
- Then: The cross-user request returns HTTP 403 with an API error. The unknown alias returns HTTP 424 with `CONNECTOR_NOT_CONFIGURED`. The user-scoped request without an account returns HTTP 403 with `FORBIDDEN` and no `headers` field.

## webhooks-agent-firewall-auth.bdd-063

- Vitest: "FW-9: codex model-provider access > recovers an unclassified reconnect-flagged codex provider after a successful refresh"
- Mode: run
- Given: A member with an active plan has a running thread Run and a personal Codex (ChatGPT) model provider connected by pasting auth JSON, with an expired access token. A forced refresh has already failed with an unclassified ChatGPT error (`refresh_token_other`), returning HTTP 502 `TOKEN_REFRESH_FAILED` without a `failureReason`. The ChatGPT token endpoint now returns a fresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `CHATGPT_ACCESS_TOKEN` bearer template mapped to `codex-oauth-token` with model-provider metadata naming the member and the exact owned Codex account.
- Then: The response is HTTP 200 with `Authorization` `Bearer recovered-chatgpt-token`.

## webhooks-agent-firewall-auth.bdd-064

- Vitest: "FW-9: codex model-provider access > re-refreshes unclassified reconnect-flagged codex providers before their token expires"
- Mode: run
- Given: A member with an active plan has a running thread Run and a personal Codex (ChatGPT) model provider connected by pasting auth JSON, with an access token still valid for 3600 seconds. A forced refresh has already failed with an unclassified ChatGPT error, returning HTTP 502 `TOKEN_REFRESH_FAILED` without a `failureReason`. The ChatGPT token endpoint now returns a fresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` (without `forceRefresh`) with a `CHATGPT_ACCESS_TOKEN` bearer template mapped to `codex-oauth-token` with model-provider metadata naming the member and the exact owned Codex account.
- Then: The response is HTTP 200 with `Bearer reauthorized-chatgpt-token` and `refreshedConnectors` `["codex-oauth-token"]`.

## webhooks-agent-firewall-auth.bdd-065

- Vitest: "FW-9: codex model-provider access > reports a missing exact owned Codex account as not configured"
- Mode: run
- Given: A member with an active plan has a running thread Run and no Codex account matching a random account ID.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `CHATGPT_ACCESS_TOKEN` template and model-provider metadata naming the member and the random account ID.
- Then: The response is HTTP 424 with error code `CONNECTOR_NOT_CONFIGURED`.

## webhooks-agent-firewall-auth.bdd-066

- Vitest: "FW-9: codex model-provider access > stops retrying terminal chatgpt refresh failures"
- Mode: run
- Given: A member with an active plan has a running thread Run. For each terminal ChatGPT refresh error (`refresh_token_reused`, `refresh_token_expired`, `refresh_token_invalidated`) the member connects an expired Codex account and the ChatGPT token endpoint returns HTTP 401 with that code.
- When: For each error, the Run calls `POST /api/webhooks/run/firewall/auth` three times with a `CHATGPT_ACCESS_TOKEN` bearer template mapped to `codex-oauth-token` with model-provider metadata naming the member and the exact owned Codex account.
- Then: Every response is HTTP 502 with `TOKEN_REFRESH_FAILED`, `failureReason` `reconnect_required` and connectors `["codex-oauth-token"]`, and the ChatGPT token endpoint is called only once per error code.

## webhooks-agent-firewall-auth.bdd-067

- Vitest: "FW-9: codex model-provider access > keeps terminal Codex failure on the exact account until reconnect"
- Mode: run
- Given: A member with an active plan has a running thread Run and two Codex accounts connected through device auth: `expired-account` (token expired) and `healthy-account` (valid two hours, activated). The ChatGPT token endpoint rejects refresh with `refresh_token_reused`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` twice with metadata naming the expired account; the member then reconnects that exact account through device auth and the Run repeats the request.
- Then: Both failures are HTTP 502 with `TOKEN_REFRESH_FAILED` and `reconnect_required`, after one refresh call. The provider list shows the expired account with `needsReconnect: true` and `lastRefreshErrorCode` `refresh_token_reused`, and the healthy account active with no reconnect flag or error. After reconnecting, the expired account shows no reconnect flag or error, and the request returns HTTP 200 with the newly issued access token and empty `refreshedConnectors`, after one device token exchange.

## webhooks-agent-firewall-auth.bdd-068

- Vitest: "FW-9: codex model-provider access > retries a transient codex refresh failure"
- Mode: run
- Given: A member with an active plan has a running thread Run and a personal Codex (ChatGPT) model provider connected by pasting auth JSON, with an expired access token. The ChatGPT token endpoint first returns HTTP 503 `server_error`, then a fresh token.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` twice with a `CHATGPT_ACCESS_TOKEN` bearer template mapped to `codex-oauth-token` with model-provider metadata naming the member and the exact owned Codex account.
- Then: The first response is HTTP 502 with `failureReason` `upstream_provider`. The second response is HTTP 200 with `Bearer recovered-chatgpt-token`, after exactly two refresh calls.

## webhooks-agent-firewall-auth.bdd-069

- Vitest: "FW-10: platform connector secrets > resolves platform-secret aliases from current API env"
- Mode: run
- Given: A member has a running Run and a Google Ads connector with access token `google-ads-access`. The API environment sets `GOOGLE_ADS_DEVELOPER_TOKEN` to `developer-token-current`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_ADS_TOKEN` bearer template mapped to the exact Google Ads account and a `developer-token` header templating `GOOGLE_ADS_DEVELOPER_TOKEN` with platform-secret metadata.
- Then: The response is HTTP 200 with `Authorization` `Bearer google-ads-access`, `developer-token` `developer-token-current`, and `resolvedSecrets` `["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_TOKEN"]`.

## webhooks-agent-firewall-auth.bdd-070

- Vitest: "FW-10: platform connector secrets > reports missing platform env as connector-not-configured"
- Mode: run
- Given: A member has a running Run and a Google Ads connector. The API environment has no `GOOGLE_ADS_DEVELOPER_TOKEN`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `developer-token` header templating `GOOGLE_ADS_DEVELOPER_TOKEN`, mapped to `google-ads` with platform-secret metadata.
- Then: The response is HTTP 424 with error code `CONNECTOR_NOT_CONFIGURED`.

## webhooks-agent-firewall-auth.bdd-071

- Vitest: "FW-10: platform connector secrets > rejects platform metadata for non-platform connector aliases"
- Mode: run
- Given: A member has a running Run and a Google Ads connector, and the API environment sets `GOOGLE_ADS_DEVELOPER_TOKEN`.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with a `GOOGLE_ADS_TOKEN` bearer template mapped to `google-ads` but labelled with platform-secret metadata.
- Then: The response is HTTP 424 with error code `CONNECTOR_NOT_CONFIGURED`.

## webhooks-agent-firewall-auth.bdd-072

- Vitest: "FW-11: aws sigv4 template resolution > resolves aws sigv4 credentials from variable templates"
- Mode: run
- Given: A funded member has a running thread Run whose firewall token is presented.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with empty `authHeaders`, `authAwsSigv4` var templates for access key ID, secret access key and session token, and matching `vars`.
- Then: The response is HTTP 200 with empty `headers`, `awsSigv4` exactly `{ accessKeyId: "access-key-id", secretAccessKey: "secret-access-key", sessionToken: "session-token" }`, empty `resolvedSecrets`, and null `expiresAt`.

## webhooks-agent-firewall-auth.bdd-073

- Vitest: "FW-11: aws sigv4 template resolution > rejects empty resolved aws sigv4 credentials as connector-not-configured"
- Mode: run
- Given: A funded member has a running thread Run whose firewall token is presented.
- When: The Run calls `POST /api/webhooks/run/firewall/auth` with `authAwsSigv4` var templates where `AWS_ACCESS_KEY_ID` resolves to an empty string.
- Then: The response is HTTP 424 with error code `CONNECTOR_NOT_CONFIGURED`.
