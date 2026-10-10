import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { morningBriefPlatformGenerationReceipts as receipts } from "../src/schema/morning-brief-platform-generation-receipt";

/** Anonymous spend facts retain exact provider amounts and invocation identity. */
export async function validatePermanentPlatformGenerationReceipts(
  databaseUrl: string,
) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client);
  const exactId = randomUUID();
  const zeroId = randomUUID();
  const unknownId = randomUUID();
  const ids = [exactId, zeroId, unknownId];
  const startedAt = new Date("2026-10-10T00:00:00Z");
  const invocation = {
    operation: "receipt-validation",
    provider: "fixture-provider",
    requestedModel: "fixture-model",
    startedAt,
    finishedAt: startedAt,
  };
  const exact = {
    ...invocation,
    attemptId: exactId,
    outcome: "response_received",
    costState: "reported",
    costValue: "0.012345678901",
    costUnit: "provider-unit",
    costSource: "chat_completion_usage_cost",
  } satisfies typeof receipts.$inferInsert;
  const expected = [
    exact,
    {
      ...invocation,
      attemptId: zeroId,
      outcome: "response_received",
      costState: "reported",
      costValue: "0",
      costUnit: "provider-unit",
      costSource: "chat_completion_usage_cost",
    },
    {
      ...invocation,
      attemptId: unknownId,
      outcome: "invocation_unknown",
      costState: "invocation_unknown",
      promptTokens: 42,
    },
  ] satisfies (typeof receipts.$inferInsert)[];
  try {
    const stored = await db.insert(receipts).values(expected).returning();
    assert.equal(stored.length, 3);
    assert.equal(stored[0]?.costValue, "0.012345678901");
    assert.equal(stored[0]?.costUnit, "provider-unit");
    assert.equal(stored[1]?.costValue, "0.000000000000");
    assert.equal(stored[1]?.costState, "reported");
    assert.equal(stored[2]?.promptTokens, 42);
    assert.equal(stored[2]?.costValue, null);
    assert.equal(stored[2]?.costUnit, null);
    assert.equal(stored[2]?.costSource, null);

    const retried = await db
      .insert(receipts)
      .values({ ...exact, costValue: "999" })
      .onConflictDoNothing()
      .returning();
    assert.deepEqual(retried, []);
    const [retained] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.attemptId, exactId));
    assert.deepEqual(retained, stored[0]);
    console.log(
      "Anonymous spend receipts retain exact/zero/unknown costs and immutable retries",
    );
  } finally {
    try {
      await db.delete(receipts).where(inArray(receipts.attemptId, ids));
    } finally {
      await client.end();
    }
  }
}
