# cron-connector-catalog

## cron-connector-catalog-001

- Vitest: "connector catalog cron authentication > rejects missing and invalid cron credentials"
- Mode: run
- Given: The cron secret is configured.
- When: A caller requests `GET /api/cron/sync-connector-catalog` with `Authorization: Bearer wrong-secret`, and again with no Authorization header.
- Then: The wrong secret returns HTTP 401 `{error: {message: "Invalid cron secret", code: "UNAUTHORIZED"}}`, and the request without credentials returns HTTP 401.

## cron-connector-catalog-002

- Vitest: "connector catalog valid lifecycle > claims single-character Connector Skill bundles with Pi"
- Mode: run
- Given: The catalog source publishes a v4 release with a single-character connector slug `x` whose bundled Skill (a `SKILL.md` and an executable script) uses the legacy descriptor and has a matching preparation receipt; a user who can run chat agents uses a subscription Pi model with Codex execution disabled.
- When: The cron calls `GET /api/cron/sync-connector-catalog`; the user connects `x` with the `api-token` manual grant and starts a chat run with model `gpt-6-luna`.
- Then: The sync returns outcome `accepted`. The run executes with CLI agent type `pi` and mounts a Skill bundle at `/home/user/.pi/agent/skills/x` whose SHA-256 and archive size match the published bundle and whose contents are exactly the two Skill files; the run reads back as `running` before it is failed.

## cron-connector-catalog-003

- Vitest: "connector catalog valid lifecycle > accepts, advances, rolls back, and serves the active database snapshot"
- Mode: run
- Given: The catalog source holds two v4 releases ("Initial catalog" and "External Test Updated"), with the active pointer first on the first release; signed-in users can read the public catalog.
- When: The cron calls `GET /api/cron/sync-connector-catalog` twice, then again after the pointer moves to the second release and again after it moves back to the first; users read `GET /api/connector-catalog/release` and `GET /api/connector-catalog` after each step.
- Then: The first sync returns `{outcome: "accepted", failureCode: null}` and the release endpoint (with `cache-control: no-store`) reports schema version 4 with the first digest and version; the second sync returns `unchanged`. Advancing returns `accepted` and serves the "External Test Updated" connector with the second digest and version. Rolling back returns `accepted` again and serves "Initial catalog" with the first digest and version.

## cron-connector-catalog-004

- Vitest: "connector catalog valid lifecycle > uses a manual GitLab credential in a Run without optional host configuration"
- Mode: run
- Given: A signed-in user.
- When: The user connects GitLab with an access token via `POST /api/connectors/gitlab/manual-grant`, lists connectors, then starts a chat run whose sandbox resolves the `PRIVATE-TOKEN` header from `GITLAB_TOKEN` through `POST /api/webhooks/run/firewall/auth`.
- Then: The account is a connected builtin GitLab `api-token` connection and the token is not visible in the connector list. The run environment has no `GITLAB_HOST`, and the firewall resolves exactly `PRIVATE-TOKEN: manual-gitlab-secret`.

## cron-connector-catalog-005

- Vitest: "connector catalog valid lifecycle > mounts all 17 normally published connector skill versions"
- Mode: run
- Given: A user who can run chat agents uses a Codex OAuth personal model provider with model `gpt-6-luna` and has created 17 manual custom connectors, each with its own published skill markdown and a configured secret.
- When: The user starts two chat runs in turn ("Use all published connector skills" and "Reuse all exact published connector skills").
- Then: In each run exactly 17 matching connector skill mounts are present, each at `/home/user/.pi/agent/skills/<custom connector skill name>` with the SHA-256 and archive size of its published bundle and a download URL.

## cron-connector-catalog-006

- Vitest: "connector catalog valid lifecycle > loads the current published connector skill when a queued Run is prepared"
- Mode: run
- Given: A user who can run chat agents uses a Codex OAuth personal model provider with model `gpt-6-luna`, has a manual custom connector with published skill markdown and a configured secret, and queues a chat run.
- When: While the run is queued the user updates the connector's skill markdown via `PUT /api/custom-connectors/:id`; the queued run then launches, and a later chat run is sent.
- Then: The updated skill bundle has a different SHA-256 from the original. Both the queued run and the later run mount the connector skill with the updated bundle's SHA-256, archive size and a download URL.

## cron-connector-catalog-007

- Vitest: "connector catalog valid lifecycle > makes a verified Steam OpenID identity available to its Run"
- Mode: run
- Given: A signed-in user; Okou's API and web URLs and a Steam Web API key are configured; Steam confirms the OpenID assertion as valid.
- When: The user starts `POST /api/connectors/steam/openid/start` with auth method `openid` and `intent: add`, Steam returns to `GET /api/connectors/steam/callback` with a signed OpenID identity, and the user starts a chat run.
- Then: The start returns HTTP 200 and the callback returns HTTP 307. The default Steam account is connected with auth method `openid` and external ID `76561198000000000`, and the run environment has `STEAM_ID` set to that ID.

## cron-connector-catalog-008

- Vitest: "connector catalog valid lifecycle > refreshes AWS credentials in a Run after external-code authorization"
- Mode: run
- Given: A signed-in user; the AWS sign-in service issues and refreshes credentials through an external-code flow.
- When: The user starts `POST /api/connectors/aws/external-code/sessions` with auth method `cli`, completes `.../sessions/:sessionId/complete` with the verification code, then runs a chat agent (model `claude-fable-5-1`) whose sandbox resolves SigV4 credentials through `POST /api/webhooks/run/firewall/auth` with a forced refresh.
- Then: The account is a builtin AWS `cli` connection for account `123456789012` with scope `openid`. The firewall resolves access key `aws-external-code-credential-id`, the secret key and the session token, and AWS received an `authorization_code` request followed by a `refresh_token` request using `aws-login-refresh-token`.

## cron-connector-catalog-009

- Vitest: "connector catalog valid lifecycle > revokes the connected Slack credential when its account is deleted"
- Mode: run
- Given: A signed-in user; Slack OAuth is available and Slack's token revocation endpoint accepts requests.
- When: The user starts `POST /api/connectors/slack/oauth/start`, completes the Slack callback, and deletes the default Slack account.
- Then: Slack's `auth.revoke` endpoint is called exactly once with `Authorization: Bearer xoxp-bdd-user-token`.

## cron-connector-catalog-010

- Vitest: "connector catalog valid lifecycle > completes an in-flight Slack OAuth operation and reconnects its exact account"
- Mode: run
- Given: A signed-in organization admin; Slack OAuth is available but its token exchange is held until released, and revocation succeeds.
- When: The admin starts Slack OAuth, completes `GET /api/connectors/slack/callback` while the token exchange is in flight (then released), lists Slack accounts, reconnects that account with `intent: reconnect`, and completes the second callback.
- Then: After the first callback there is a connected OAuth Slack account for `U012AB3CD`. After the reconnect the account list contains exactly that same account ID, still OAuth, `U012AB3CD`, and connected.

## cron-connector-catalog-011

- Vitest: "connector catalog valid lifecycle > reuses the published Skill bundle when a compact catalog replaces a legacy descriptor"
- Mode: run
- Given: The catalog source publishes a v4 release for connector `agora` with a bundled Skill in the legacy descriptor plus its preparation receipt, then a later release ("Reused bundled skill") with the compact descriptor for the same Skill version and its receipt.
- When: The cron calls `GET /api/cron/sync-connector-catalog` for each release; a user lists the catalog, connects `agora` with the `api-token` manual grant, and starts a chat run.
- Then: Both syncs return `{outcome: "accepted", failureCode: null}` and the catalog serves only `agora` labelled "Reused bundled skill". The run mounts an `agora` Skill bundle with the originally published SHA-256 and archive size, containing exactly the Skill files.

## cron-connector-catalog-012

- Vitest: "connector catalog executable compatibility > applies test OAuth rollout before connecting its confidential client"
- Mode: run
- Given: A signed-in user without the test OAuth connector feature switch; the test OAuth provider is available with a confidential client.
- When: The user lists `GET /api/connector-catalog`, enables the switch via `POST /api/feature-switches`, lists again, starts `POST /api/connectors/test-oauth/oauth/start`, and completes the callback.
- Then: The first list omits `test-oauth`; after enabling, the list includes `test-oauth` with an `oauth` auth method of grant kind `auth-code` and does not contain the client secret. The authorization URL uses client ID `test-oauth-client`, and the provider receives one token exchange carrying client secret `test-oauth-secret`.
