/**
 * Chat Event V8 transition code (removed in PR-3 with the dry run).
 *
 * The upgrade module reaches `src/lib/env.ts` through `src/signals/utils.ts`,
 * and that schema validates every required API variable at import. The dry
 * run never calls `env()`: it reads its own `CHAT_EVENT_DRY_RUN_*` inputs.
 * Unset required names therefore get inert placeholders so the import
 * succeeds without exposing any other secret to this job. Real R2 inputs use
 * distinct names, so a placeholder can never stand in for a credential.
 */
const PLACEHOLDER = "chat-event-v8-dry-run-unused";

const REQUIRED_API_ENV_NAMES = [
  "ABLY_API_KEY",
  "APP_URL",
  "AXIOM_DATASET_SUFFIX",
  "AXIOM_TOKEN_SESSIONS",
  "AXIOM_TOKEN_TELEMETRY",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLI_PKG_URL",
  "CRON_SECRET",
  "DATABASE_URL",
  "ENV",
  "FEISHU_CALLBACK_BASE_URL",
  "GIT_COMMIT_SHA",
  "OFFICIAL_RUNNER_SECRET",
  "OKOU_HOST_SCHEME",
  "OKOU_PUBLIC_ARTIFACTS_BASE_URL",
  "OKOU_PUBLIC_HOST_DOMAIN",
  "OKOU_WEB_URL",
  "OPENAI_API_KEY",
  "PUBLIC_ARTIFACTS_BASE_URL",
  "R2_ACCESS_KEY_ID",
  "R2_ACCOUNT_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_USER_ARTIFACTS_ACCESS_KEY_ID",
  "R2_USER_ARTIFACTS_BUCKET_NAME",
  "R2_USER_ARTIFACTS_SECRET_ACCESS_KEY",
  "R2_USER_STORAGES_BUCKET_NAME",
  "SECRETS_ENCRYPTION_KEY",
  "STRIPE_SECRET_KEY",
] as const;

const PLACEHOLDER_OVERRIDES: Partial<
  Record<(typeof REQUIRED_API_ENV_NAMES)[number], string>
> = {
  APP_URL: "https://chat-event-v8-dry-run.invalid",
  AXIOM_DATASET_SUFFIX: "dev",
  CLI_PKG_URL: "https://chat-event-v8-dry-run.invalid/cli.tgz",
  DATABASE_URL: "postgresql://chat-event-v8-dry-run.invalid/unused",
  ENV: "development",
  FEISHU_CALLBACK_BASE_URL: "https://chat-event-v8-dry-run.invalid",
  OKOU_HOST_SCHEME: "https",
  OKOU_PUBLIC_ARTIFACTS_BASE_URL: "https://chat-event-v8-dry-run.invalid",
  OKOU_PUBLIC_HOST_DOMAIN: "chat-event-v8-dry-run.invalid",
  OKOU_WEB_URL: "https://chat-event-v8-dry-run.invalid",
  PUBLIC_ARTIFACTS_BASE_URL: "https://chat-event-v8-dry-run.invalid",
  SECRETS_ENCRYPTION_KEY:
    "0000000000000000000000000000000000000000000000000000000000000000",
  OFFICIAL_RUNNER_SECRET:
    "0000000000000000000000000000000000000000000000000000000000000000",
};

for (const name of REQUIRED_API_ENV_NAMES) {
  if (!process.env[name]) {
    process.env[name] = PLACEHOLDER_OVERRIDES[name] ?? PLACEHOLDER;
  }
}
