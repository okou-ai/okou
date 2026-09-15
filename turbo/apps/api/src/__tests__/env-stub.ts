import { vi } from "vitest";

/** The Vercel SDK reads runtime environment directly, outside lib/env. */
export function stubTestVercelRuntimeToken(token: string | undefined): void {
  vi.stubEnv("VERCEL_OIDC_TOKEN", token);
}

export function stubTestTimezone(
  timezone: "America/New_York" | "Asia/Shanghai" | "UTC",
): void {
  vi.stubEnv("TZ", timezone);
}

export function stubTestWebUrlEnvironment(webUrl: string | undefined): void {
  vi.stubEnv("OKOU_WEB_URL", webUrl);
}

function stubTestDatabaseUrl(): void {
  const vitestWorkerId = process.env.VITEST_WORKER_ID;
  if (!vitestWorkerId) {
    throw new Error("Expected VITEST_WORKER_ID in the API test environment");
  }
  const databaseUrl = new URL(
    process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/vm0_test",
  );
  databaseUrl.searchParams.set(
    "application_name",
    `okou-api-test-${process.pid}-${vitestWorkerId}`,
  );
  vi.stubEnv("DATABASE_URL", databaseUrl.toString());
}

stubTestDatabaseUrl();
vi.stubEnv("CLERK_SECRET_KEY", "sk_test_dummy_for_unit_tests");
vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk_test_dummy_for_unit_tests");
vi.stubEnv(
  "SECRETS_ENCRYPTION_KEY",
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
vi.stubEnv(
  "OFFICIAL_RUNNER_SECRET",
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
);
vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
vi.stubEnv("FAL_KEY", "test-fal-key");
vi.stubEnv("JOGGAI_API_KEY", "test-joggai-key");
vi.stubEnv("JOGGAI_WEBHOOK_SECRET", "test-joggai-webhook-secret");
vi.stubEnv("HEYGEN_API_KEY", "test-heygen-key");
vi.stubEnv("BYTEPLUS_API_KEY", "test-byteplus-key");
vi.stubEnv("MINIMAX_API_KEY", "test-minimax-key");
vi.stubEnv("BYTEPLUS_STT_API_KEY", "test-byteplus-stt-key");
vi.stubEnv("CRON_SECRET", "test-cron-secret");
vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
vi.stubEnv("R2_ACCOUNT_ID", "test-account");
vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-user-storages");
vi.stubEnv("R2_PRIVATE_ARTIFACTS_BUCKET_NAME", "test-private-artifacts");
vi.stubEnv("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID", "test-private-access-key");
vi.stubEnv("R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY", "test-private-secret-key");
vi.stubEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "test-user-artifacts");
vi.stubEnv("R2_USER_ARTIFACTS_ACCESS_KEY_ID", "test-artifacts-access-key");
vi.stubEnv("R2_USER_ARTIFACTS_SECRET_ACCESS_KEY", "test-artifacts-secret-key");
vi.stubEnv("PUBLIC_ARTIFACTS_BASE_URL", "https://cdn.vm7.io");
vi.stubEnv("OKOU_PUBLIC_ARTIFACTS_BASE_URL", "https://a.okou.io");
vi.stubEnv("PUBLIC_ARTIFACT_SHARES_BASE_URL", "https://a.okou.io");
vi.stubEnv("R2_HOSTED_SITES_BUCKET_NAME", "test-hosted-sites");
vi.stubEnv("R2_HOSTED_SITES_ACCESS_KEY_ID", "test-hosted-sites-access-key");
vi.stubEnv("R2_HOSTED_SITES_SECRET_ACCESS_KEY", "test-hosted-sites-secret-key");
vi.stubEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
vi.stubEnv("OKOU_HOST_SCHEME", "https");
vi.stubEnv("ZERO_HOST_DOMAIN", "sites.example.com");
vi.stubEnv("ZERO_HOST_SCHEME", "https");
vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
vi.stubEnv("FEISHU_CALLBACK_BASE_URL", "http://localhost:3000");
stubTestWebUrlEnvironment("http://localhost:3001");
vi.stubEnv("APP_URL", "http://localhost:3002");
vi.stubEnv(
  "CLI_PKG_URL",
  "https://static.okou.io/okou-cli/test-commit/package.tgz",
);
vi.stubEnv("RESEND_API_KEY", "test-resend-key");
vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
vi.stubEnv("RESEND_FROM_DOMAIN", "mail.example.com");
vi.stubEnv("GIT_COMMIT_SHA", "test-commit-sha");
vi.stubEnv("ENV", "development");
vi.stubEnv("AXIOM_TOKEN_SESSIONS", "xaat-test-sessions");
vi.stubEnv("AXIOM_TOKEN_TELEMETRY", "xaat-test-telemetry");
vi.stubEnv("AXIOM_DATASET_SUFFIX", "dev");
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_for_unit_tests");
vi.stubEnv("ATOM_URL", "https://atom.example.test");
vi.stubEnv("OKOU_MACHINE_SECRET_KEY", "msk_test_dummy_for_unit_tests");
vi.stubEnv("ABLY_API_KEY", "test-ably-key");
// The Vercel connector builds its authorization URL from the Integration slug
// read straight from the process environment, outside the API env contract.
vi.stubEnv("VERCEL_INTEGRATION_SLUG", "okou-test-integration");

// Preserve the host's existing filesystem/runtime environment when launching a
// test-owned real Guest. Never inherit the active sandbox's control endpoints.
export function guestBoundaryEnvironment(): Pick<
  NodeJS.ProcessEnv,
  "HOME" | "PATH"
> {
  return { HOME: process.env.HOME, PATH: process.env.PATH };
}
