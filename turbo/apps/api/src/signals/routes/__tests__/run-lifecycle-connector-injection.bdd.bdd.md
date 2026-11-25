# run-lifecycle-connector-injection.bdd

## run-lifecycle-connector-injection.bdd-001

- Vitest: "RUN-02: stored connector injection into dispatched Runs > omits connected stored connectors when the account is disabled for Chats"
- Mode: run
- Given: An entitled member has connected X through OAuth but turned X off as a default connector for chats.
- When: The member starts a chat Run, the Runner reads the execution input, and the member cancels it.
- Then: The execution has no `X_TOKEN` in its environment or secret connector map, no `x` firewall entry, billable firewall or network policy, and the Run becomes `cancelled`.

## run-lifecycle-connector-injection.bdd-002

- Vitest: "RUN-02: stored connector injection into dispatched Runs > injects oauth connector tokens with billable firewalls and resolvable secrets"
- Mode: run
- Given: An entitled member has connected X through OAuth and connected Slack, but turned Slack off for chats.
- When: The member starts a chat Run, the Runner reads the execution input, and the sandbox asks `POST /api/webhooks/run/firewall/auth` to resolve `Authorization: Bearer ${{ secrets.X_TOKEN }}`.
- Then: The environment has an `X_TOKEN` placeholder and no X access or refresh tokens; the secret map and metadata name the X connector as source. The execution has a built-in `x` firewall with source ID, `x` is billable and its unknown policy is `allow`. Slack has no token, firewall, billing or policy. Firewall auth returns HTTP 200 with header `Authorization: Bearer x-bdd-access`.

## run-lifecycle-connector-injection.bdd-003

- Vitest: "RUN-02: stored connector injection into dispatched Runs > maps stored connector variable sources to runtime aliases for permission manifests"
- Mode: run
- Given: A Pro member with a personal subscription has connected the `test-oauth` connector through OAuth.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The `test-oauth` firewall entry is a built-in entry with a source ID and base URL variable `TEST_OAUTH_TENANT_ID` mapped to `test-oauth-oauth-tenantid`, and the environment's `TEST_OAUTH_TENANT_ID` is `test-oauth-oauth-tenantId`.

## run-lifecycle-connector-injection.bdd-004

- Vitest: "RUN-02: stored connector injection into dispatched Runs > injects manual-grant api-token connectors and their optional variables"
- Mode: run
- Given: An entitled member has connected GitLab with an API token and no host.
- When: The member starts a Run, reconnects GitLab with host `gitlab.example.com`, starts another Run, and cancels both.
- Then: The first execution has a `GITLAB_TOKEN` placeholder mapped to the `gitlab` connector and no `GITLAB_HOST`. The second has the token placeholder plus `GITLAB_HOST` `gitlab.example.com` in both environment and vars. After cancellation the queue shows 0 active Runs.

## run-lifecycle-connector-injection.bdd-005

- Vitest: "RUN-02: stored connector injection into dispatched Runs > keeps prefetched connector credentials behind placeholders in the Runner execution"
- Mode: run
- Given: An entitled member on the native Runner route has connected X through OAuth and GitLab and Figma with API tokens.
- When: The member starts a chat Run, the Runner reads the execution input, and the member cancels it.
- Then: The environment has placeholders for `X_TOKEN`, `GITLAB_TOKEN` and `FIGMA_TOKEN` and no X refresh token; none of the real access, refresh or API token values appear anywhere in the execution. The Run becomes `cancelled`.

## run-lifecycle-connector-injection.bdd-006

- Vitest: "RUN-02: stored connector injection into dispatched Runs > uses the builtin Figma firewall for personal access tokens"
- Mode: run
- Given: An entitled member has connected Figma with a personal access token.
- When: The member starts a chat Run, the Runner reads the execution input, and the sandbox resolves the `X-Figma-Token` template via `POST /api/webhooks/run/firewall/auth`, once with and once without the secret metadata map.
- Then: The environment has a `FIGMA_TOKEN` placeholder mapped to `figma`, and the Figma firewall is a built-in entry with source ID. Resolution with metadata returns HTTP 200 with `X-Figma-Token: figd_bdd`; without it returns HTTP 424 with code `CONNECTOR_NOT_CONFIGURED`. The Run becomes `cancelled` after cancellation.

## run-lifecycle-connector-injection.bdd-007

- Vitest: "RUN-02: stored connector injection into dispatched Runs > keeps refresh-owned connector secrets out of the sandbox environment"
- Mode: run
- Given: An entitled member has connected Lark with an app ID and secret, and Figma with an unrelated token.
- When: The member starts a chat Run; the Runner reads the execution input and syncs the Lark runtime via `POST /api/runners/runs/:runId/connector-runtime/sync`; the member adds a sibling Lark account and makes it default; the Runner syncs again with the exact target, with no source ID, and with the Figma connection's ID as source.
- Then: The environment has only a `LARK_TOKEN` placeholder (no app ID, secret or access token); the secret metadata, firewall and runtime target all name the connected Lark account. The first sync reports Lark `available`. The sibling becomes default, and the next sync reports Lark `available` bound to the sibling; the source-less and wrong-source syncs return exactly the same result. The Run becomes `cancelled` after cancellation.

## run-lifecycle-connector-injection.bdd-008

- Vitest: "RUN-02: stored connector injection into dispatched Runs > uses exact current-catalog builtin accounts and custom metadata for mixed sync"
- Mode: run
- Given: An entitled member has connected Lark and created two manual HTTP custom connectors with secrets, one using the `builtin:slack@1` permission bundle with `chat:write` allowed and one plain.
- When: The member starts a chat Run, and the Runner syncs the Lark and both custom targets together via `POST /api/runners/runs/:runId/connector-runtime/sync`, then the plain target alone.
- Then: The Lark target names the connected account and syncs as `available`. The permissioned custom runtime uses its firewall source, no base URL vars, includes a `chat:write` permission, allows `chat:write`, denies others and has unknown policy `deny`. The plain custom runtime has no permissions, and syncing it alone returns the same projection. The Run becomes `cancelled` after cancellation.

## run-lifecycle-connector-injection.bdd-009

- Vitest: "RUN-02: stored connector injection into dispatched Runs > emits lazy platform-secret metadata without snapshotting platform secrets"
- Mode: run
- Given: An entitled member has connected Google Ads through OAuth while the platform Google Ads developer token has one value; the platform value changes after the Run is prepared.
- When: The member starts a chat Run, and the sandbox resolves Google Ads headers via `POST /api/webhooks/run/firewall/auth` with full metadata, without metadata, with a conflicting connector source and matched firewall, and with a conflicting connector source alone.
- Then: The environment has no developer token; the secret map lists both tokens under `google-ads`, with the access token sourced from the connector and the developer token from a `platform-secret`, and the firewall shares the connector source ID. Full resolution returns HTTP 200 with the OAuth access token and the current (post-preparation) developer token. Without metadata it returns 424 `CONNECTOR_NOT_CONFIGURED`, the conflicting source with matched firewall returns 400, and the conflicting source alone returns 424 `CONNECTOR_NOT_CONFIGURED`.

## run-lifecycle-connector-injection.bdd-010

- Vitest: "RUN-02: stored connector injection into dispatched Runs > omits OpenAI credentials and firewall rules without a connected account"
- Mode: run
- Given: An entitled member has not connected OpenAI.
- When: The member starts a chat Run and the Runner reads the execution input.
- Then: The environment has no `OPENAI_TOKEN` and there is no `openai` firewall. The Run becomes `cancelled` after cancellation.

## run-lifecycle-connector-injection.bdd-011

- Vitest: "RUN-02: stored connector injection into dispatched Runs > dispatches a public Codex subscription generation 2 with its captured tier"
- Mode: run
- Given: An entitled member uses a Codex subscription Pi model, with no Codex service tier chosen.
- When: The member sends a chat message on `gpt-6-luna` with reasoning effort `high` and the Runner reads the execution input.
- Then: The execution runs `pi` with the conversation ID as Pi session, and its Pi model config is exactly schema version 2, dialect `openai-codex-responses` over `sse`, provider `openai-codex` at `https://chatgpt.com/backend-api`, model `gpt-6-luna`, thinking level `high`, with access-token and account-ID credential bindings, and no service tier.

## run-lifecycle-connector-injection.bdd-012

- Vitest: "RUN-02: stored connector injection into dispatched Runs > dispatches a public Codex subscription generation 3 with its captured tier"
- Mode: run
- Given: An entitled member uses a Codex subscription Pi model and chooses the `fast` Codex service tier.
- When: The member sends a chat message on `gpt-6-luna` with reasoning effort `high` and the Runner reads the execution input.
- Then: The execution runs `pi` with the conversation ID as Pi session, and its Pi model config is exactly schema version 3, dialect `openai-codex-responses` over `sse`, provider `openai-codex` at `https://chatgpt.com/backend-api`, model `gpt-6-luna`, thinking level `high`, with access-token and account-ID credential bindings and service tier `fast`.
