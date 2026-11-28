# run-lifecycle-custom-connectors.bdd

## run-lifecycle-custom-connectors.bdd-001

- Vitest: "RUN-02: custom connectors, grants, and network policies > runs connected no-auth HTTP and MCP custom connectors without credentials"
- Mode: run
- Given: An entitled member has a no-auth HTTP custom connector with two URL prefixes templated on a required `region` variable set to `us-east`, a no-auth MCP custom connector, and an Automatic-auth MCP connector whose provider requires no authentication and is connected.
- When: The member starts a chat Run, the Runner reads the execution input, and syncs all three custom targets via `POST /api/runners/runs/:runId/connector-runtime/sync`.
- Then: The HTTP connector's firewall APIs use the `us-east` HTTPS and HTTP bases, the MCP and Automatic connectors use their endpoints, and all have empty header and query auth. Runtime targets carry `region: us-east` for HTTP, no base URL vars for MCP, and the Automatic connection as source. The sync returns all three, in order, with empty auth.

## run-lifecycle-custom-connectors.bdd-002

- Vitest: "RUN-02: custom connectors, grants, and network policies > admits an explicitly connected custom connector without stored values"
- Mode: run
- Given: An entitled member has a custom HTTP connector whose only field is an optional secret used in an `Authorization` header, and has connected it without storing any values.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The execution has a firewall entry for the custom connector and a custom runtime target with no base URL vars and a source ID.

## run-lifecycle-custom-connectors.bdd-003

- Vitest: "RUN-02: custom connectors, grants, and network policies > admits overlapping custom and built-in connector targets"
- Mode: run
- Given: An entitled member has connected Figma with an API token and also has a custom HTTP connector with a secret covering `https://api.figma.com/`.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The execution has both the built-in `figma` firewall and the custom firewall at base `https://api.figma.com/`, runtime targets for both, a `figma` network policy, and unknown policy `allow` for the custom connector. The Run becomes `cancelled` after cancellation.

## run-lifecycle-custom-connectors.bdd-004

- Vitest: "RUN-02: custom connectors, grants, and network policies > keeps a built-in connector when a custom connector only overrides a narrower path"
- Mode: run
- Given: An entitled member has connected Figma with an API token and has a custom HTTP connector with a secret covering only `https://api.figma.com/v1/files/`.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The execution keeps the built-in `figma` firewall and runtime target with source ID, and adds the custom firewall at base `https://api.figma.com/v1/files/`. The Run becomes `cancelled` after cancellation.

## run-lifecycle-custom-connectors.bdd-005

- Vitest: "RUN-02: custom connectors, grants, and network policies > injects enabled custom connector firewalls with resolvable org secrets"
- Mode: run
- Given: A chat-ready member with `claude-fable-5-1` selected has a manual custom HTTP connector with a `secret` and a `tenant` variable (`acme`) used in an `Authorization` header and an `api_key` query parameter, plus a connected Figma token; organization secrets are encrypted with the key service.
- When: The member starts a Run; the Runner syncs the custom runtime and the sandbox resolves its auth via `POST /api/webhooks/run/firewall/auth`; the member then rotates the secret, updates the connector's prefix and header (with the runtime wake-up notification failing), replaces its auth fields, and deletes the connection, with syncs and auth resolutions in between.
- Then: The execution has the custom firewall with unknown policy `allow`, no raw secret value, and a custom runtime target matching the firewall source. The sync is available with tenant `acme`, API base `http://acme.internal.example.com:8080/api/`, and auth resolves to `Bearer custom-secret-value` plus the `api_key` query. Missing or wrong sources sync to the same runtime but auth returns 424 `CONNECTOR_NOT_CONFIGURED`, as does an unknown alias. Rotated and restored secrets resolve immediately; the update publishes a `connector-runtime-sync` message to the Runner group and auth keeps the last good value; a removed field returns 424 `CONNECTOR_NOT_CONFIGURED`; after the connection is deleted, sync reports `absent` with reason `connector-unavailable`.

## run-lifecycle-custom-connectors.bdd-006

- Vitest: "RUN-02: custom connectors, grants, and network policies > admits MCP connectors with exact synchronized runtime state"
- Mode: run
- Given: An entitled member has a manual MCP custom connector with a secret and an endpoint with query parameters, and a manual HTTP custom connector with a secret.
- When: The member starts a Run; the Run lists MCP connectors with its Okou token; the Runner syncs the MCP target exactly, without a source, with a wrong source, after the endpoint moves, and with unexpected routing vars; then the MCP account is disconnected (sync, auth, and a new Run) and finally the connector is deleted.
- Then: The MCP list includes the connector's endpoint, target and connection, and both custom connectors are runtime targets. The system prompt's MCP section lists only the MCP slug and `okou mcp list --json`/`list-tools`/`call` usage, without the HTTP slug, display name, endpoint, skill text or token. The MCP firewall base drops the query, uses a public-destination host policy, no permissions, a secret-template `Authorization`, and an allow-all policy; a skill bundle is mounted and auth resolves to `Bearer mcp-runtime-token`. All sync variants return `available` bound to the selected connection (the move updates the base to `/v2/mcp/`). After disconnection sync is `absent` (`connector-unavailable`), auth returns 424 `CONNECTOR_NOT_CONFIGURED`, and a new Run omits the connector; after deletion sync is `absent` too.

## run-lifecycle-custom-connectors.bdd-007

- Vitest: "RUN-02: custom connectors, grants, and network policies > rejects a deleted custom credential and synchronizes its replacement"
- Mode: run
- Given: A chat-ready member has a manual MCP custom connector with a secret and a running Run admitted with that connector account.
- When: The Runner syncs the exact target and captures its auth body; the member deletes that connector account and stores a new secret, creating a replacement default account; the Runner syncs the original target, the sandbox replays the original auth via `POST /api/webhooks/run/firewall/auth`, and the Runner syncs the replacement target.
- Then: The replacement account has a different ID. Syncing the original target reports `available` bound to the replacement account, the original auth body returns HTTP 424 `CONNECTOR_NOT_CONFIGURED`, and the replacement sync's firewall source is the replacement account.

## run-lifecycle-custom-connectors.bdd-008

- Vitest: "RUN-02: custom connectors, grants, and network policies > bounds authorized MCP awareness for an initial Claude run"
- Mode: run
- Given: An entitled member on the native Runner route has one more connected MCP custom connector than the prompt inventory limit, plus an unconnected MCP connector and a connected one turned off for chats.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The Run uses `claude-code`. The system prompt contains `# Agent Tools` and an MCP section listing exactly the first authorized slugs up to the limit in sorted order, omits the last one with the note `1 additional authorized MCP connector was omitted from this prompt`, and contains no unconnected or disabled slug, display names, endpoints or credentials.

## run-lifecycle-custom-connectors.bdd-009

- Vitest: "RUN-02: custom connectors, grants, and network policies > preserves bounded MCP awareness across continuation"
- Mode: run
- Given: An entitled member on the native Runner route has one more connected MCP custom connector than the prompt inventory limit, plus an unconnected and a disabled MCP connector.
- When: The member starts a Run that completes with a native-only session, then continues the conversation.
- Then: The first Run's MCP section has the bounded inventory. The continuation's system prompt contains `# Agent Tools` and exactly the same MCP section.

## run-lifecycle-custom-connectors.bdd-010

- Vitest: "RUN-02: custom connectors, grants, and network policies > keeps bounded MCP awareness identical across Claude and Codex"
- Mode: run
- Given: An entitled member on the native Runner route has one more connected MCP custom connector than the prompt inventory limit, plus an unconnected and a disabled MCP connector; a personal Codex subscription is then added.
- When: The member starts a Claude Run, cancels it, and starts a Run with `gpt-6-astra`.
- Then: The Claude Run has the bounded MCP section. The Codex Run uses the `codex` agent and its MCP section begins with exactly the Claude section, followed only by the built-in image generation upload guidance.

## run-lifecycle-custom-connectors.bdd-011

- Vitest: "RUN-02: custom connectors, grants, and network policies > renders a publicly configured canonical IDN connector through runtime auth"
- Mode: run
- Given: An entitled member on the native Runner route has a manual custom HTTP connector whose prefix is templated on a required `host` variable set to the punycode IDN `xn--mgba3gch31f`, with an optional secret used in an `X-Connector` header that is later filled in by reconnecting.
- When: The member lists custom connectors, starts a Run, the Runner syncs the target with two unsupported IDN hostnames and then with its own target, and the sandbox resolves the runtime auth via `POST /api/webhooks/run/firewall/auth`.
- Then: The listed connector keeps its prefix and header templates. The syncs with unsupported hostnames still report `available` bound to the Run's own connection and routing vars. The exact sync's firewall base is `https://xn--mgba3gch31f.tenant-<suffix>.example.test/api/`, and auth resolves `X-Connector: runtime-batch canonical-runtime-secret`.

## run-lifecycle-custom-connectors.bdd-012

- Vitest: "RUN-02: custom connectors, grants, and network policies > fails expired custom OAuth without a refresh token at matched auth"
- Mode: run
- Given: An entitled member has an OAuth custom connector whose provider issues a 30-second access token without a refresh token, and has connected it.
- When: The member starts a Run while the token is valid, cancels it, the clock advances 31 seconds, the member lists accounts and starts another Run, and the sandbox resolves the runtime auth via `POST /api/webhooks/run/firewall/auth`.
- Then: The account is `connected` and the first Run targets the connector after exactly one token request. After expiry the account is `reconnect-required` with reason `credential_expired`, yet the new Run still targets it; auth returns HTTP 502 with code `TOKEN_REFRESH_FAILED`, the connector ID, and failure reason `reconnect_required`, with no further token request.

## run-lifecycle-custom-connectors.bdd-013

- Vitest: "RUN-02: custom connectors, grants, and network policies > recovers reconnect-marked custom OAuth and rotates refreshed tokens"
- Mode: run
- Given: A chat-ready member has an OAuth custom connector (client secret basic auth) connected with a one-hour token. The provider rejects the first refresh with `invalid_grant`, then returns rotated tokens (the first adding scope `refreshed`), and later fails with 503.
- When: The member starts a Run; the Runner syncs the target and the sandbox resolves auth via `POST /api/webhooks/run/firewall/auth`: forced with a wrong source, forced, after two hours, again, forced ten minutes later, and forced once more.
- Then: The firewall header uses a secret template and the execution contains no raw token. The wrong source returns 424 `CONNECTOR_NOT_CONFIGURED` without a token request. The first forced refresh returns 502 `TOKEN_REFRESH_FAILED` with `reconnect_required` and marks the account `reconnect-required`. Two hours later auth recovers with the refreshed token, its expiry, and the connector and secret listed as refreshed, and the account is `connected` with scopes `read` and `refreshed`; the next call reuses the token. The forced refresh uses the rotated refresh token and returns the new token. All token requests use Basic client auth, and the final forced refresh returns 502 with `upstream_provider`.

## run-lifecycle-custom-connectors.bdd-014

- Vitest: "RUN-02: custom connectors, grants, and network policies > retries custom OAuth quietly across runs and supports reconnect"
- Mode: run
- Given: An entitled member has an OAuth custom connector connected with a one-hour token, and the provider always rejects refreshes with `invalid_grant`.
- When: The member starts a Run; two hours later the sandbox resolves auth and the Runner resyncs; the member starts a second Run and its sandbox resolves auth; the member reconnects through OAuth and the sandbox forces a refresh.
- Then: Auth returns 502 `TOKEN_REFRESH_FAILED` with `reconnect_required`; the resync keeps the same firewall and policy; the account becomes `reconnect-required`. The second Run still admits the connector's firewall, policy and target, and its auth fails the same way after one more refresh attempt, with the account reason `authorization_expired_or_revoked`. After reconnecting, the account is `connected` with no reason and the forced refresh returns HTTP 200 using the reconnected refresh token.

## run-lifecycle-custom-connectors.bdd-015

- Vitest: "RUN-02: custom connectors, grants, and network policies > resolves current OAuth credentials for admitted MCP connectors"
- Mode: run
- Given: An entitled member has an OAuth MCP custom connector connected with a one-hour access token.
- When: The member starts a Run, the Runner syncs the MCP target, and the sandbox resolves its auth via `POST /api/webhooks/run/firewall/auth`.
- Then: The firewall API base is `https://mcp-oauth.example.test/oauth/mcp` with no permissions. Auth resolves `Authorization: Bearer custom-oauth-initial-access-token`, and that token is not among the execution's secret values.

## run-lifecycle-custom-connectors.bdd-016

- Vitest: "RUN-02: custom connectors, grants, and network policies > keeps a no-auth catalog firewall when Automatic discovery resolves OAuth"
- Mode: run
- Given: An entitled member has connected a built-in Automatic MCP connector whose catalog entry has no auth headers, while discovery at the provider resolved OAuth with a one-hour token.
- When: The member starts a Run; the Run checks the connector URL with its Okou token via the connector check route; the sandbox resolves firewall auth with the Automatic bearer template and with the catalog's empty headers (both forced); the Runner syncs the target.
- Then: The built-in firewall entry names the connection as source and the catalog has no auth headers. The check resolves with credential resolution `none`. The bearer template returns HTTP 424 `CONNECTOR_NOT_CONFIGURED`, the catalog headers return HTTP 200 with no headers, and no token refresh happens. The sync reports `available` without a firewall.

## run-lifecycle-custom-connectors.bdd-017

- Vitest: "RUN-02: custom connectors, grants, and network policies > rotates expired builtin Automatic credentials and requires reconnect after revocation"
- Mode: run
- Given: An entitled member has connected a built-in Automatic MCP connector with a two-minute token; the provider rotates tokens on the first two refreshes and then rejects with `invalid_grant`.
- When: Three minutes after connecting, the sandbox resolves firewall auth, resolves again, forces a refresh, forces another, and resolves once more; the Runner then syncs the target.
- Then: The expired token is refreshed using the original refresh token and returns `builtin-rotated-access-1`, which the next call reuses. The forced refresh uses the rotated refresh token and returns `builtin-rotated-access-2`. The next forced refresh returns HTTP 502 `TOKEN_REFRESH_FAILED` with `reconnect_required` and the account becomes `reconnect-required`; the following call fails the same way without another token request. The sync reports `available` without a firewall.

## run-lifecycle-custom-connectors.bdd-018

- Vitest: "RUN-02: custom connectors, grants, and network policies > uses a builtin Automatic access token without optional refresh until it expires"
- Mode: run
- Given: An entitled member has connected a built-in Automatic MCP connector with a one-minute token and no refresh token.
- When: The sandbox resolves firewall auth, and again two minutes after connecting.
- Then: The first call returns exactly `Authorization: Bearer automatic-initial-access-token`. After expiry it returns HTTP 502 `TOKEN_REFRESH_FAILED` with `reconnect_required`.

## run-lifecycle-custom-connectors.bdd-019

- Vitest: "RUN-02: custom connectors, grants, and network policies > synthesizes OAuth bearer auth and clears credentials after normal Automatic MCP no-auth reconnect"
- Mode: run
- Given: A chat-ready member has an Automatic-auth MCP custom connector connected through OAuth; later the provider stops requiring authentication.
- When: The member starts a Run, the Runner syncs and the sandbox resolves auth; the member reconnects the same account (now no-auth), cancels the Run, starts another, and the Runner syncs it.
- Then: The first firewall's `Authorization` header is a secret template for the OAuth access token and auth resolves `Bearer automatic-initial-access-token`. Reconnecting returns `connected` with the same connection ID and the account is `connected`. The next Run has the same runtime target, empty header and query auth in both the firewall and the sync, and neither the execution nor the runtime mentions the old access or refresh tokens or the secret key.

## run-lifecycle-custom-connectors.bdd-020

- Vitest: "RUN-02: custom connectors, grants, and network policies > injects proposed custom connector fields into headers, query, and host templates"
- Mode: run
- Given: An entitled member on the native Runner route has saved a custom connector proposal with a required secret in an `Authorization` header, a `subdomain` variable (`münich`) in the host and a `tenant` query parameter, and a `scope` query variable.
- When: The member starts a Run; the sandbox resolves firewall auth via `POST /api/webhooks/run/firewall/auth`; the member reconnects with new variable values; the Runner resyncs and auth resolves again; the member starts another Run.
- Then: No secret is decrypted when the Run is created. The firewall base uses the punycode host `xn--mnich-kva`, the runtime target pins `subdomain: münich`, and header and query values are secret templates. Auth resolves the secret and `tenant: münich`, `scope: initial-scope` with one decryption. Reconnecting publishes no runtime notification; the resync uses `later-run` in vars and base, and auth then returns `tenant: later-run`, `scope: later-scope`. The later Run targets `later-run` too.

## run-lifecycle-custom-connectors.bdd-021

- Vitest: "RUN-02: custom connectors, grants, and network policies > fails closed when a custom auth header references an optional missing value"
- Mode: run
- Given: An entitled member has saved a custom connector proposal whose `Authorization` header combines a required `api_key` and an optional, unset `secondary_token`, with an optional `tenant_id` query variable set.
- When: The member starts a Run, the Runner syncs the target, the sandbox resolves auth via `POST /api/webhooks/run/firewall/auth`, the member reconnects with the secondary token, and the sandbox resolves auth again.
- Then: Both the execution's firewall and the synced runtime use secret templates for the combined header and the tenant query. Auth first returns HTTP 424 `CONNECTOR_NOT_CONFIGURED`; after the secondary token is stored it returns `Authorization: Bearer optional-primary:optional-secondary` and `tenant: initial-tenant`.

## run-lifecycle-custom-connectors.bdd-022

- Vitest: "RUN-02: custom connectors, grants, and network policies > omits storage-incompatible custom connectors from new runs"
- Mode: run
- Given: An entitled member saved a custom connector with a stored secret, then updated it to add a required `replacement` secret, raising its storage version to 2.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The update reports storage version 2, and the Run has no firewall, network policy or runtime target for the connector.

## run-lifecycle-custom-connectors.bdd-023

- Vitest: "RUN-02: custom connectors, grants, and network policies > omits incompatible custom connectors until required credentials are rewritten"
- Mode: run
- Given: A chat-ready member saved a custom connector with an `api_key` secret, then changed it to require a new `replacement_key` secret instead.
- When: The member lists the connector's accounts, starts a Run, reconnects the same account with the replacement secret, lists accounts again, and starts another Run.
- Then: The account is first `reconnect-required` with reason `configuration_invalid`, no configured fields and `replacement_key` missing, and the Run has no firewall, policy or runtime target for the connector. After reconnecting the same connection ID, the account is `connected` with `replacement_key` configured and nothing missing, and the next Run admits the connector's firewall, policy and target.

## run-lifecycle-custom-connectors.bdd-024

- Vitest: "RUN-02: custom connectors, grants, and network policies > admits a custom connector only in runs created after full recovery"
- Mode: run
- Given: An entitled member saved a custom connector with an `api_key` secret and a `subdomain` variable in the host, then deleted its default account.
- When: The member starts a Run, tries to restore only the API key, restores both fields with a 55-character subdomain, adds a long fixed prefix to the host template, starts a Run, then reconnects with subdomain `version-two` and starts another Run.
- Then: The Run without an account omits the connector. Restoring only the API key returns HTTP 400 with `All required fields must be provided when connecting or restoring`. The Run whose host would be unroutable omits the connector. The final Run targets the connector with `subdomain: version-two` and firewall base `https://very-long-fixed-prefix-for-custom-runtime-version-two.<rand>.recovery.test/v1/`.

## run-lifecycle-custom-connectors.bdd-025

- Vitest: "RUN-02: custom connectors, grants, and network policies > keeps an active custom firewall while optional query auth is unavailable"
- Mode: run
- Given: An entitled member saved a custom connector with a stored secret in an `Authorization` header and an optional, unset `tenant` variable in a query parameter.
- When: The member starts a Run, the Runner syncs the target, the sandbox resolves auth via `POST /api/webhooks/run/firewall/auth`, the member reconnects with tenant `restored-tenant`, and auth is resolved again.
- Then: The Run admits the connector's firewall with unknown policy `allow`, and the runtime uses secret templates for header and query. Auth first returns HTTP 424 `CONNECTOR_NOT_CONFIGURED`; afterwards it returns `Authorization: Bearer optional-only-secret` and `tenant: restored-tenant`.

## run-lifecycle-custom-connectors.bdd-026

- Vitest: "RUN-02: custom connectors, grants, and network policies > keeps connector-owned vars out of custom connector base urls"
- Mode: run
- Given: An entitled member has connected the `test-subdomain` connector with subdomain `münich`, and has a custom HTTP connector at `https://internal.example.com/api/` with a secret.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The `test-subdomain` firewall and runtime target carry `SUBDOMAIN_TEST_SUBDOMAIN: xn--mnich-kva` with a source ID, while the custom connector's base stays `https://internal.example.com/api/`. The Run becomes `cancelled` after cancellation.

## run-lifecycle-custom-connectors.bdd-027

- Vitest: "RUN-02: custom connectors, grants, and network policies > isolates stored connector base URL vars outside their host policy (GitLab enabled true)"
- Mode: run
- Given: An entitled member has connected Jira with an attacker-controlled domain and GitLab with host `gitlab.example.com`, and GitLab is enabled for chats.
- When: The member starts an unrelated chat Run and the Runner reads the execution input.
- Then: Jira contributes no firewall, billing, policy, runtime target, environment, vars or secret entries, and nothing references the Jira connection. GitLab has a firewall, policy and runtime target for its connection, a `GITLAB_TOKEN` placeholder sourced from that connection, and `GITLAB_HOST` `gitlab.example.com` in environment and vars. The Jira account is still readable, and after cancellation the queue shows 0 active Runs.

## run-lifecycle-custom-connectors.bdd-028

- Vitest: "RUN-02: custom connectors, grants, and network policies > isolates stored connector base URL vars outside their host policy (GitLab enabled false)"
- Mode: run
- Given: An entitled member has connected Jira with an attacker-controlled domain and GitLab with host `gitlab.example.com`, and GitLab is turned off for chats.
- When: The member starts an unrelated chat Run and the Runner reads the execution input.
- Then: Jira contributes no firewall, billing, policy, runtime target, environment, vars or secret entries, and nothing references the Jira connection. GitLab has no runtime target and no `GITLAB_TOKEN`. The Jira account is still readable, and after cancellation the queue shows 0 active Runs.

## run-lifecycle-custom-connectors.bdd-029

- Vitest: "RUN-02: custom connectors, grants, and network policies > applies expired and revoked connector grants before dispatch"
- Mode: run
- Given: An entitled member has connected Slack and allowed `chat:write` for one hour.
- When: Two hours later the member starts a Run; then the member allows `chat:write` permanently, replaces Slack's grants with an empty list, and starts another Run.
- Then: Both Runs' Slack policies deny `chat:write` and do not allow it.

## run-lifecycle-custom-connectors.bdd-030

- Vitest: "RUN-02: custom connectors, grants, and network policies > skips connector catalog work for a current writer without built-ins"
- Mode: run
- Given: An entitled member with no built-in connectors.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The environment has a `CLAUDE_CODE_OAUTH_TOKEN` and there are no billable firewalls.

## run-lifecycle-custom-connectors.bdd-031

- Vitest: "RUN-02: custom connectors, grants, and network policies > distinguishes terminal connector runtime sync from missing runs"
- Mode: run
- Given: An entitled member on the native Runner route has a completed Run and a failed Run; the member and a colleague in the same organization each have CLI personal access tokens.
- When: Using those tokens, they call `POST /api/runners/runs/:runId/connector-runtime/sync` for the completed Run, the colleague for the same Run, the member for a nonexistent Run, and the member for the failed Run.
- Then: The member's sync for the completed Run returns HTTP 409 with the terminal-Run error code and message `Run is terminal`. The colleague's request and the nonexistent Run return 404 `NOT_FOUND`. The failed Run's sync returns 409 with the terminal-Run error code.

## run-lifecycle-custom-connectors.bdd-032

- Vitest: "RUN-02: custom connectors, grants, and network policies > resumes a session while refreshing its network policy"
- Mode: run
- Given: An entitled member on the native Runner route has connected Slack and completed a first Run with a native-only session.
- When: The member continues the conversation and the Runner reads the execution input.
- Then: The first Run has a Slack network policy and is `completed`. The continuation resumes the first session with the first Run as generation Run and again includes a Slack network policy.

## run-lifecycle-custom-connectors.bdd-033

- Vitest: "RUN-02: custom connectors, grants, and network policies > applies Cloudflare permission overrides without changing the sibling Slack policy"
- Mode: run
- Given: An entitled member has connected Cloudflare and Slack through OAuth.
- When: The member runs a chat Run, then allows `dns-firewall.write` and the unknown-permission grant for Cloudflare, and runs another.
- Then: By default Cloudflare allows `dns-firewall.read`, denies `dns-firewall.write` and has unknown policy `deny`. After the overrides Cloudflare allows both read and write, no longer denies write, and has unknown policy `allow`, while the Slack policy is unchanged.

## run-lifecycle-custom-connectors.bdd-034

- Vitest: "RUN-02: custom connectors, grants, and network policies > loads stored connectors and applies default named policies to runs without explicit policies"
- Mode: run
- Given: A Pro member with a personal subscription has connected Cloudflare through OAuth and set no explicit policies.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The environment has a `CLOUDFLARE_TOKEN` placeholder mapped to `cloudflare`, the firewall entry is `cloudflare` with a source ID, and the policy allows `dns-firewall.read`, denies `dns-firewall.write` and has unknown policy `deny`.
