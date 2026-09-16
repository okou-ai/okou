import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { usageEvent } from "../src/schema/usage-event";
import { usageEventHourlyRollup } from "../src/schema/usage-event-hourly-rollup";

// Exercise old-writer defaults and the subset invariant on replayed and fresh schemas.
export async function validatePermanentUsageDedupProvenance(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      const db = drizzle(client);
      const base = {
        orgId: `dedup_org_${randomUUID()}`,
        userId: `dedup_user_${randomUUID()}`,
        kind: "connector",
        provider: "x",
        category: "posts.read",
        quantity: 5,
      };
      const insertRaw = async (nonDeduplicatedQuantity?: number) => {
        return await db
          .insert(usageEvent)
          .values({
            ...base,
            idempotencyKey: randomUUID(),
            nonDeduplicatedQuantity,
          })
          .returning({ value: usageEvent.nonDeduplicatedQuantity });
      };
      const insertHourly = async (nonDeduplicatedQuantity?: number) => {
        return await db
          .insert(usageEventHourlyRollup)
          .values({
            ...base,
            processedHour: new Date("2026-09-16T00:00:00Z"),
            billingContext: "runless",
            billingAnchorAt: new Date("2026-09-16T00:30:00Z"),
            creditsCharged: 0,
            allowanceUnits: 0,
            nonDeduplicatedQuantity,
          })
          .returning({ value: usageEventHourlyRollup.nonDeduplicatedQuantity });
      };
      for (const [insert, constraint] of [
        [insertRaw, "chk_usage_event_non_deduplicated_quantity"],
        [insertHourly, "chk_usage_event_hourly_non_deduplicated_quantity"],
      ] as const) {
        assert.deepEqual(await insert(), [{ value: 0 }]);
        assert.deepEqual(await insert(2), [{ value: 2 }]);
        assert.deepEqual(await insert(5), [{ value: 5 }]);
        for (const invalid of [-1, 6]) {
          await client.query("SAVEPOINT invalid_quantity");
          await assert.rejects(insert(invalid), (error: unknown) => {
            assert.ok(error instanceof Error);
            const cause = error.cause;
            assert.ok(cause instanceof Error && "code" in cause);
            assert.equal(cause.code, "23514");
            assert.ok("constraint" in cause);
            assert.equal(cause.constraint, constraint);
            return true;
          });
          await client.query("ROLLBACK TO SAVEPOINT invalid_quantity");
          await client.query("RELEASE SAVEPOINT invalid_quantity");
        }
      }
      console.log(
        "   ✅ Usage provenance defaults and subset constraints hold",
      );
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}
