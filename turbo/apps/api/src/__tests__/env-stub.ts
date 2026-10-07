import { vi } from "vitest";
import { apiTestEnvironment } from "./test-environment";

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
