import { Client } from "pg";
import { afterAll, beforeAll } from "vitest";

import { env } from "../lib/env";

const OFFICIAL_WORKFLOW_CATALOG_TEST_LEASE =
  "api-test:official-workflow-catalog-singleton";

/**
 * The Official Workflow catalog is intentionally a production singleton.
 * Suites that replace or clean it therefore take this test-only, cross-worker
 * lease instead of adding test namespaces to the production schema.
 *
 * PostgreSQL releases the session lock if a Vitest worker exits unexpectedly.
 */
async function acquireOfficialWorkflowCatalogTestLease(): Promise<
  () => Promise<void>
> {
  const client = new Client({ connectionString: env("DATABASE_URL") });
  const [acquired] = await Promise.allSettled([
    (async () => {
      await client.connect();
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1::text, 0))",
        [OFFICIAL_WORKFLOW_CATALOG_TEST_LEASE],
      );
    })(),
  ]);
  if (acquired?.status === "rejected") {
    await client.end();
    throw acquired.reason;
  }

  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    const [unlocked] = await Promise.allSettled([
      client.query<{ readonly unlocked: boolean }>(
        "SELECT pg_advisory_unlock(hashtextextended($1::text, 0)) AS unlocked",
        [OFFICIAL_WORKFLOW_CATALOG_TEST_LEASE],
      ),
    ]);
    const [ended] = await Promise.allSettled([client.end()]);
    if (unlocked?.status === "rejected") {
      throw unlocked.reason;
    }
    if (unlocked?.value.rows[0]?.unlocked !== true) {
      throw new Error("Official Workflow catalog test lease was not held");
    }
    if (ended?.status === "rejected") {
      throw ended.reason;
    }
  };
}

/** Serialize a suite that mutates the production-shaped catalog singleton. */
export function serializeOfficialWorkflowCatalogTests(): void {
  let release: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    release = await acquireOfficialWorkflowCatalogTestLease();
  }, 10 * 60_000);

  afterAll(async () => {
    const ownedRelease = release;
    release = undefined;
    await ownedRelease?.();
  });
}
