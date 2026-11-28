# runners-builtin-firewalls

## runners-builtin-firewalls-001

- Vitest: "runner builtin firewall resolver > requires runner authentication"
- Mode: run
- Given: An unauthenticated caller with no authorization header.
- When: The caller posts `POST /api/runners/builtin-firewalls/resolve` with `names: ["github"]`.
- Then: The response is HTTP 401 with error code `UNAUTHORIZED`.

## runners-builtin-firewalls-002

- Vitest: "runner builtin firewall resolver > rejects unknown builtin firewall names and preserves subsequent valid resolution"
- Mode: run
- Given: An official Runner authenticates with its `vm0_official_` bearer credential.
- When: The Runner posts `POST /api/runners/builtin-firewalls/resolve` with `names: ["github", "not-a-builtin-firewall"]`, then with `names: ["github"]`.
- Then: The first request returns HTTP 400 with message "Unknown builtin firewall: not-a-builtin-firewall". The second returns HTTP 200 with exactly the catalog digest, catalog version and only the `github` firewall from the generated Runner firewall catalog.

## runners-builtin-firewalls-003

- Vitest: "runner builtin firewall resolver > resolves connector and model-provider builtin firewalls"
- Mode: run
- Given: An official Runner authenticates with its `vm0_official_` bearer credential.
- When: The Runner posts `POST /api/runners/builtin-firewalls/resolve` with `names: ["github", "github", "model-provider:claude-code-oauth-token"]`.
- Then: The response is HTTP 200 with the catalog digest and version, and exactly the two keys `github` and `model-provider:claude-code-oauth-token`. The `github` firewall is named `github`, and the Claude Code OAuth firewall's first API is `https://api.anthropic.com/v1/messages` with an `Authorization: Bearer ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` header and no permissions.

## runners-builtin-firewalls-004

- Vitest: "runner builtin firewall resolver > publishes the Codex OAuth backend API firewall to Runner"
- Mode: run
- Given: An official Runner authenticates with its `vm0_official_` bearer credential.
- When: The Runner posts `POST /api/runners/builtin-firewalls/resolve` with `names: ["model-provider:codex-oauth-token"]`.
- Then: The Codex OAuth firewall has exactly two APIs: `https://chatgpt.com/backend-api` with `Authorization: Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}` and `ChatGPT-Account-ID: ${{ secrets.CHATGPT_ACCOUNT_ID }}` headers and a `codex:api` permission allowing `GET /{path*}` and `POST /{path*}`; and `https://auth.openai.com` with empty headers and no permissions.

## runners-builtin-firewalls-005

- Vitest: "runner builtin firewall resolver > handles concurrent full generated builtin firewall catalog resolves"
- Mode: run
- Given: An official Runner authenticates with its `vm0_official_` bearer credential.
- When: The Runner sends three concurrent `POST /api/runners/builtin-firewalls/resolve` requests with an empty body.
- Then: Each returns HTTP 200 with the generated catalog digest and version and firewall keys exactly matching the full catalog's sorted names.

## runners-builtin-firewalls-006

- Vitest: "runner builtin firewall resolver > isolates concurrent full and selected firewall responses with one catalog identity"
- Mode: run
- Given: An official Runner authenticates with its `vm0_official_` bearer credential.
- When: The Runner concurrently posts `POST /api/runners/builtin-firewalls/resolve` with an empty body, with `names: ["github", "github", "model-provider:codex-oauth-token"]`, and with only the Codex OAuth name; then posts an empty body again.
- Then: Each concurrent response is exactly the shared catalog digest and version with its own firewall set: the full catalog, `github` plus the Codex OAuth firewall, and only the Codex OAuth firewall. The subsequent full request returns exactly the full catalog.

## runners-builtin-firewalls-007

- Vitest: "runner builtin firewall resolver > keeps the complete serialized builtin firewall catalog within the Runner byte budget"
- Mode: run
- Given: An official Runner authenticates with its `vm0_official_` bearer credential.
- When: The Runner posts `POST /api/runners/builtin-firewalls/resolve` with an empty JSON body.
- Then: The response is HTTP 200 and parses against the response contract with the `github` and `model-provider:claude-code-oauth-token` firewalls present, and the serialized body is no larger than the Runner builtin firewall catalog byte budget.

## runners-builtin-firewalls-008

- Vitest: "runner builtin firewall resolver > resolves the full generated builtin firewall catalog when names are omitted"
- Mode: run
- Given: An official Runner authenticates with its `vm0_official_` bearer credential.
- When: The Runner posts `POST /api/runners/builtin-firewalls/resolve` with an empty body (no names).
- Then: The response is HTTP 200 with the catalog digest and version, a body valid against the response contract, firewall keys exactly matching the full catalog's sorted names, a `github` firewall named `github`, and the Claude Code OAuth firewall's first API at `https://api.anthropic.com/v1/messages` with the OAuth token header and no permissions.
