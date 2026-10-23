import { vi } from "vitest";
import { apiTestEnvironment } from "./test-environment";
import { apiTestDatabaseUrl } from "./test-database-url";

for (const [name, value] of Object.entries(apiTestEnvironment)) {
  vi.stubEnv(name, value);
}

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

/** AWS SDK runtime inputs are scoped separately from the application's env. */
export function stubTestAwsKmsEnvironment(
  configSource: "process" | "application" = "process",
): () => void {
  const values = {
    AWS_REGION: configSource === "process" ? "us-west-2" : undefined,
    AWS_ACCESS_KEY_ID:
      configSource === "process" ? "kms-http-test-access-key" : undefined,
    AWS_SECRET_ACCESS_KEY:
      configSource === "process" ? "kms-http-test-secret-key" : undefined,
    AWS_SESSION_TOKEN: undefined,
    AWS_CREDENTIAL_EXPIRATION: undefined,
    AWS_CREDENTIAL_SCOPE: undefined,
    AWS_ACCOUNT_ID: undefined,
    AWS_PROFILE: undefined,
    AWS_ENDPOINT_URL: undefined,
    AWS_ENDPOINT_URL_KMS: undefined,
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
    AWS_USE_FIPS_ENDPOINT: "false",
    AWS_USE_DUALSTACK_ENDPOINT: "false",
  } as const;
  const previous = Object.keys(values).map((name) => {
    return [name, process.env[name]] as const;
  });
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value);
  }
  return () => {
    for (const [name, value] of previous) {
      vi.stubEnv(name, value);
    }
  };
}

function stubTestDatabaseUrl(): void {
  const vitestWorkerId = process.env.VITEST_WORKER_ID;
  if (!vitestWorkerId) {
    throw new Error("Expected VITEST_WORKER_ID in the API test environment");
  }
  const databaseUrl = apiTestDatabaseUrl(
    process.env.DATABASE_URL,
    process.env.PGOPTIONS,
  );
  databaseUrl.searchParams.set(
    "application_name",
    `okou-api-test-${process.pid}-${vitestWorkerId}`,
  );
  vi.stubEnv("DATABASE_URL", databaseUrl.toString());
}

stubTestDatabaseUrl();
