import { sql } from "drizzle-orm";
import { afterAll } from "vitest";

import { closeDbPool, db } from "../db";

describe("database pool lifecycle", () => {
  afterAll(closeDbPool);

  it("gives one caller ownership when pool shutdown overlaps", async () => {
    await db().execute(sql`SELECT 1`);

    const firstClose = closeDbPool();
    const overlappingClose = closeDbPool();
    await expect(
      Promise.all([firstClose, overlappingClose]),
    ).resolves.toStrictEqual([undefined, undefined]);

    // The next borrower gets a fresh pool instead of the one whose shutdown
    // already began, so a timed-out test cannot poison the following case.
    await expect(db().execute(sql`SELECT 1`)).resolves.toBeDefined();
  });
});
