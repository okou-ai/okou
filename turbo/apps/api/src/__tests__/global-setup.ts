import { restoreGlobalSetupEnvironment } from "./global-setup-env";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { createPgliteSnapshot } from "../test-fixtures/pglite-database";
import {
  installApiTestConnectorCatalog,
  installSharedApiTestConnectorCatalog,
} from "../test-fixtures/connector-catalog";
import {
  seedDevelopmentModelPricingForTests,
  seedIsolatedModelPricingForTests,
} from "../test-fixtures/usage-pricing";
import { settleIncludingAbort } from "../signals/utils";

import { API_DATABASE_SNAPSHOT } from "./database-snapshot";

export async function setup(project: TestProject) {
  const directory = await mkdtemp(join(tmpdir(), "okou-api-database-"));
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
  };
  const initialized = await settleIncludingAbort(async () => {
    await seedDevelopmentModelPricingForTests();
    await installSharedApiTestConnectorCatalog();
    const image = await createPgliteSnapshot(async (database) => {
      await seedIsolatedModelPricingForTests(database);
      await installApiTestConnectorCatalog({ database, ifAbsent: true });
    });
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
