-- Personal Claude/Codex subscriptions are stored only in model_provider_accounts
-- and model_provider_account_secrets. Drop the legacy singleton mirror in
-- secrets; organization (__org__) providers and other provider types keep it.
UPDATE "model_providers"
SET "secret_id" = NULL
WHERE "user_id" <> '__org__'
  AND "type" IN ('claude-code-oauth-token', 'codex-oauth-token')
  AND "secret_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "secrets" AS s
USING "model_providers" AS mp
WHERE mp."user_id" <> '__org__'
  AND mp."type" IN ('claude-code-oauth-token', 'codex-oauth-token')
  AND s."org_id" = mp."org_id"
  AND s."user_id" = mp."user_id"
  AND s."type" = 'model-provider'
  AND s."connector_id" IS NULL
  AND (
    (mp."type" = 'claude-code-oauth-token' AND s."name" = 'CLAUDE_CODE_OAUTH_TOKEN')
    OR (
      mp."type" = 'codex-oauth-token'
      AND s."name" IN (
        'CHATGPT_ACCESS_TOKEN',
        'CHATGPT_REFRESH_TOKEN',
        'CHATGPT_ACCOUNT_ID',
        'CHATGPT_ID_TOKEN',
        'CODEX_AUTH_JSON'
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "model_providers" AS other WHERE other."secret_id" = s."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "model_provider_connections" AS c WHERE c."secret_id" = s."id"
  );--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_provider_accounts_provider_identity" ON "model_provider_accounts" USING btree ("model_provider_id","external_account_id");
