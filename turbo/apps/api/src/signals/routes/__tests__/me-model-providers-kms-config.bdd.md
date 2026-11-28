# me-model-providers-kms-config

## me-model-providers-kms-config-001

- Vitest: "personal provider KMS configuration > stores a personal provider when AWS configuration comes from the application environment"
- Mode: run
- Given: An authenticated user supplies a Claude Code OAuth credential. Anthropic's profile identifies a Claude Pro account, its usage endpoint responds successfully and the API has working KMS configuration from its deployment environment.
- When: The user sends POST /api/me/model-providers with the OAuth credential and then GET /api/me/model-providers.
- Then: Creation returns HTTP 201 with created true, provider type claude-code-oauth-token and framework claude-code. The HTTP 200 list contains the new ID.
