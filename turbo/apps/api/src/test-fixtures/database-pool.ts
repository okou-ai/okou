import { onTestFinished } from "vitest";

import { closeDbPool } from "../lib/db";
import { mockEnv } from "../lib/env";

export async function useSingleConnectionPoolFixture(): Promise<void> {
  await closeDbPool();
  mockEnv("DB_POOL_MAX", 1);
  onTestFinished(closeDbPool);
}
