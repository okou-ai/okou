# connectors-manual-grant-connect

## connectors-manual-grant-connect-001

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > returns 401 when not authenticated"
- Mode: run
- Given: The caller is unauthenticated (no authorization header).
- When: The caller sends `POST /api/connectors/openai/manual-grant` with method `api-token`, intent `add` and an `apiKey` value.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## connectors-manual-grant-connect-002

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > returns 401 when the authenticated session has no organization"
- Mode: run
- Given: The caller has a valid session without an active organization.
- When: The caller sends `POST /api/connectors/openai/manual-grant` with method `api-token`, intent `add` and an `apiKey` value.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## connectors-manual-grant-connect-003

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > accepts server-authored identity syntax before catalog rejection"
- Mode: run
- Given: A signed-in workspace member targets the syntactically valid but uncatalogued connector slug `server-authored-connector` and method `server-authored-method`.
- When: The member sends `POST /api/connectors/server-authored-connector/manual-grant` with intent `add` and an `apiKey` value.
- Then: The response is HTTP 400 with exactly `{ message: server-authored-connector connector is not supported, code: BAD_REQUEST }`.

## connectors-manual-grant-connect-004

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > allows unlabeled additions before optional post-connect naming"
- Mode: run
- Given: A signed-in member has no `openai` accounts.
- When: The member sends `POST /api/connectors/openai/manual-grant` with method `api-token`, intent `add` and no display name, then `POST /api/connectors/openai/no-auth` with the same method, then lists `GET /api/connectors`.
- Then: The manual grant returns HTTP 200 with exactly `{ connectionId }`. The no-auth request returns HTTP 400 with a message containing `openai api-token auth method does not use a no-auth grant`. The connector list contains `openai` with status `connected`.

## connectors-manual-grant-connect-005

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > stores App manual grants in connector-owned state"
- Mode: run
- Given: A signed-in member uses the App client (App client-type header).
- When: The member sends `POST /api/connectors/openai/manual-grant` with method `api-token`, intent `add` and an `apiKey` padded with a leading space and a trailing newline.
- Then: The response is HTTP 200 with exactly `{ connectionId }`, and the connector's default account is a builtin `openai` `api-token` account with status `connected`.

## connectors-manual-grant-connect-006

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > accepts CLI add and reconnect while preserving sibling accounts"
- Mode: run
- Given: A signed-in member uses the CLI client (CLI client-type header). A second member in another workspace also exists.
- When: The member adds an `openai` `api-token` account named `Work`, reconnects it with a new key, adds a sibling named `Personal`, then tries to reconnect a random unknown connection ID; the other member tries to reconnect the first account; and the first member tries to reconnect the first account through the `test-subdomain` connector.
- Then: The reconnect returns the same connection ID and the sibling gets a different one; the account list contains exactly those two accounts. The unknown ID, the other member's attempt and the wrong-connector attempt each return HTTP 404 `Connector account not found`. The `openai` default account remains the first account.

## connectors-manual-grant-connect-007

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > allows concurrent first-account adds"
- Mode: run
- Given: A signed-in member has no `openai` accounts.
- When: The member sends two concurrent `POST /api/connectors/openai/manual-grant` adds named `First` and `Second` with different API keys.
- Then: Both requests return HTTP 200.

## connectors-manual-grant-connect-008

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > connects Test Subdomain manual grant fields through the API"
- Mode: run
- Given: A signed-in member connects the builtin `test-subdomain` connector with the `api-token` method, submitting an API token, email and subdomain that contain surrounding whitespace and a line break.
- When: The member sends `POST /api/connectors/test-subdomain/manual-grant` with intent `add`, reads the default account, and then starts a thread run that a Runner picks up and whose firewall resolves the `Authorization` header template for the API token secret.
- Then: The response is HTTP 200 with exactly `{ connectionId }`. The default account is that connection, `api-token` and `connected`, and does not expose the token. The run's execution environment has `SUBDOMAIN_TEST_EMAIL` `support@example.com` and `SUBDOMAIN_TEST_SUBDOMAIN` `example`, and the resolved header is exactly `Authorization: Bearer test-subdomain-token`.

## connectors-manual-grant-connect-009

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > disconnects a connector and removes its public account and bindings"
- Mode: run
- Given: A signed-in member has connected the builtin `test-subdomain` connector through a manual grant.
- When: The member deletes every `test-subdomain` account through `DELETE /api/connector-accounts/:connectionId` and lists the connector's accounts.
- Then: The connect returned a connection ID, and the account list for `test-subdomain` is empty after deletion.

## connectors-manual-grant-connect-010

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > normalizes a full URL host field for manual grant connectors"
- Mode: run
- Given: A signed-in member connects the builtin `insforge` connector whose domain field is submitted as the full URL `https://9ksx253h.us-west.insforge.app/api/`.
- When: The member sends `POST /api/connectors/insforge/manual-grant` with method `api-token`, intent `add`, an `apiKey` and that `domain`.
- Then: The response is HTTP 200 with exactly `{ connectionId }`, and the default `insforge` account uses the `api-token` method.

## connectors-manual-grant-connect-011

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > connects Lark app credentials through the API"
- Mode: run
- Given: A signed-in member connects the builtin `lark` connector with an app ID and app secret that contain surrounding whitespace.
- When: The member sends `POST /api/connectors/lark/manual-grant` with method `api-token` and intent `add`.
- Then: The response is HTTP 200 with exactly `{ connectionId }`, and the default `lark` account is `connected`.

## connectors-manual-grant-connect-012

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > reconnects Lark manual grant state through the API"
- Mode: run
- Given: A signed-in member has connected `lark` with app ID `cli_old` and its secret.
- When: The member sends another `POST /api/connectors/lark/manual-grant` add with app ID `cli_new` and a new secret.
- Then: The request returns HTTP 200, and the default `lark` account is `api-token`, `connected`, with null `reconnectReason` and null `tokenExpiresAt`.

## connectors-manual-grant-connect-013

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > replaces stored manual grant state with new manual grant state"
- Mode: run
- Given: A signed-in member has the `TestOauthConnector` feature switch enabled and a `test-oauth` manual grant with an old API token, input variable and tenant.
- When: The member sends another `POST /api/connectors/test-oauth/manual-grant` add with method `api-token` and new values.
- Then: The request returns HTTP 200 and the default `test-oauth` account uses the `api-token` method.

## connectors-manual-grant-connect-014

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > replaces GitLab manual grant when optional fields are omitted"
- Mode: run
- Given: A signed-in member has a `gitlab` manual grant with an access token and host `gitlab.example.com`.
- When: The member sends another `POST /api/connectors/gitlab/manual-grant` add with only a new `accessToken`, omitting the optional host.
- Then: The request returns HTTP 200 and the default account is a builtin `gitlab` `api-token` account with status `connected`.

## connectors-manual-grant-connect-015

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > rejects private field names and identifies the public field id"
- Mode: run
- Given: A signed-in member connects `openai` with its `api-token` method.
- When: The member sends `POST /api/connectors/openai/manual-grant` whose values use the private secret name `OPENAI_TOKEN` instead of the public field.
- Then: The response is HTTP 400 and the error message names the public field `apiKey` without mentioning `OPENAI_TOKEN` or the submitted value.

## connectors-manual-grant-connect-016

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > rejects unknown public fields without echoing submitted values"
- Mode: run
- Given: A signed-in member connects `openai` with its `api-token` method.
- When: The member sends `POST /api/connectors/openai/manual-grant` with a valid `apiKey` plus an extra `unknownField` carrying a secret-looking value.
- Then: The response is HTTP 400 and the error message mentions `apiKey` but neither `unknownField` nor its submitted value.

## connectors-manual-grant-connect-017

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > rejects required fields that sanitize to empty without private field names"
- Mode: run
- Given: A signed-in member connects `openai` with its `api-token` method.
- When: The member sends `POST /api/connectors/openai/manual-grant` with an `apiKey` consisting only of whitespace.
- Then: The response is HTTP 400 and the error message mentions `apiKey` without mentioning `OPENAI_TOKEN`.

## connectors-manual-grant-connect-018

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > rejects connectors that do not support manual grant auth"
- Mode: run
- Given: A signed-in member targets the builtin `github` connector, which has no `api-token` method.
- When: The member sends `POST /api/connectors/github/manual-grant` with method `api-token`, intent `add` and empty values.
- Then: The response is HTTP 400 with a message containing `github connector does not have api-token auth method`.

## connectors-manual-grant-connect-019

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > rejects selected auth methods without manual grants"
- Mode: run
- Given: A signed-in member targets the builtin `stripe` connector with its `oauth` method, which does not use a manual grant.
- When: The member sends `POST /api/connectors/stripe/manual-grant` with method `oauth`, intent `add` and an `apiKey`.
- Then: The response is HTTP 400 with a message containing `stripe oauth auth method does not use a manual grant`.

## connectors-manual-grant-connect-020

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > connects a BentoML account"
- Mode: run
- Given: A signed-in member connects the builtin `bentoml` connector.
- When: The member sends `POST /api/connectors/bentoml/manual-grant` with method `api-token`, intent `add`, an API token and endpoint `https://example.bentoml.test`.
- Then: The response is HTTP 200 with exactly `{ connectionId }`.

## connectors-manual-grant-connect-021

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > rejects authored-hidden manual grant auth"
- Mode: run
- Given: A signed-in member targets the builtin `cloudflare` connector, whose `api-token` method is hidden by the catalog author.
- When: The member sends `POST /api/connectors/cloudflare/manual-grant` with method `api-token`, intent `add` and empty values.
- Then: The response is HTTP 403 with exactly `{ message: cloudflare connector is not available, code: FORBIDDEN }`.

## connectors-manual-grant-connect-022

- Vitest: "POST /api/connectors/:connectorSlug/manual-grant > publishes one connector change event on successful replacement"
- Mode: run
- Given: A signed-in member connects `openai` with its `api-token` method.
- When: The member sends `POST /api/connectors/openai/manual-grant` with intent `add` and an `apiKey`.
- Then: The request returns HTTP 200, and exactly one realtime `connector:changed` event with `{ connectorSlug: openai }` is published, on the member's `user:<userId>` channel only.
