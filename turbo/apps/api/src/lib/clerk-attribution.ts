import { env, optionalEnv } from "./env";

export function clerkAttributionDisabled(): boolean {
  // CI preview jobs share a Clerk test instance. Keep attribution enrichment
  // from consuming the directory quota needed by authentication and E2E tests.
  return (
    env("ENV") === "preview" && Boolean(optionalEnv("OKOU_PREVIEW_JOB_REF"))
  );
}
