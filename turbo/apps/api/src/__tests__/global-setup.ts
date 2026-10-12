import { restoreGlobalSetupEnvironment } from "./global-setup-env";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { createPgliteSnapshot } from "../test-fixtures/pglite-database";
import { Client } from "pg";
import { z } from "zod";
import { env } from "../lib/env";
import { API_DATABASE_SEED_FILES } from "../test-fixtures/database-seeds";
import { onRejection, settleIncludingAbort } from "../signals/utils";

import { API_DATABASE_SNAPSHOT } from "./database-snapshot";

export async function setup(project: TestProject) {
  const directory = await mkdtemp(join(tmpdir(), "okou-api-database-"));
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
  };
  const initialized = await settleIncludingAbort(async () => {
    // Startup owns one short-lived connection. Never initialize the app pool:
    // cases may choose an unavailable endpoint before their first app DB read.
    const client = new Client({ connectionString: env("DATABASE_URL") });
    const seeded = (async () => {
      await client.connect();
      const timezone = await client.query("SHOW TimeZone");
      if (
        !z.object({ TimeZone: z.literal("UTC") }).safeParse(timezone.rows[0])
          .success
      ) {
        throw new Error("Native API test database must use UTC before seeding");
      }
      for (const file of API_DATABASE_SEED_FILES) {
        await client.query(await readFile(file, "utf8"));
      }
    })();
    await onRejection(seeded, () => {
      return client.end();
    });
    await client.end();
    const image = await createPgliteSnapshot();
    const path = join(directory, "seeded.tar");
    await writeFile(path, new Uint8Array(await image.arrayBuffer()));
    project.provide(API_DATABASE_SNAPSHOT, path);
  });
  restoreGlobalSetupEnvironment();
  if (!initialized.ok) {
    await cleanup();
    throw initialized.error;
  }
  return cleanup;
}
