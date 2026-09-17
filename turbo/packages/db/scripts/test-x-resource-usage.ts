import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Storage invariants against replayed and fresh schemas. There is no active
 * observation writer yet, so these states have no production API setup path.
 * Consumer concurrency, time admission and cleanup scheduling belong to #34713. */
export async function validateXResourceUsageSchema(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");

    async function rejects(query: string, parameters: unknown[], code: string) {
      await client.query("SAVEPOINT invalid_x_write");
      await assert.rejects(client.query(query, parameters), { code });
      await client.query("ROLLBACK TO SAVEPOINT invalid_x_write");
    }

    const readSql = `INSERT INTO x_resource_reads (utc_day,resource_type,resource_id)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING resource_id`;
    const key = ["2026-09-16", "post", "9007199254740993"];
    assert.deepEqual((await client.query(readSql, key)).rows, [
      { resource_id: "9007199254740993" },
    ]);
    assert.equal((await client.query(readSql, key)).rowCount, 0);
    for (const separateKey of [
      ["2026-09-17", "post", "9007199254740993"],
      ["2026-09-16", "user", "9007199254740993"],
      ["2026-09-16", "post", "0002"],
      ["2026-09-16", "post", "2"],
    ]) {
      assert.equal((await client.query(readSql, separateKey)).rowCount, 1);
    }
    for (const id of ["", "1\n", "1.0", "１２", "-1"]) {
      await rejects(readSql, ["2026-09-16", "post", id], "23514");
    }
    await rejects(readSql, ["2026-09-16", "relation", "1"], "23514");
    await rejects(readSql, ["infinity", "post", "1"], "23514");

    // Resource writes roll back with their surrounding transaction.
    await client.query("SAVEPOINT failed_x_observation");
    const rolledBack = ["2026-09-17", "post", "3"];
    assert.equal((await client.query(readSql, rolledBack)).rowCount, 1);
    await client.query("ROLLBACK TO SAVEPOINT failed_x_observation");
    assert.equal((await client.query(readSql, rolledBack)).rowCount, 1);

    // The existing ledger still supports count writers and zero-net source
    // idempotency. Its lifecycle has no FK/cascade into shared resource reads.
    const source = randomUUID();
    const legacySql = `INSERT INTO usage_event
      (idempotency_key,org_id,user_id,kind,provider,category,quantity)
      VALUES ($1,$2,$3,'connector','x','tweet.read',0)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
    const legacy = [source, `org_${source}`, `user_${source}`];
    assert.equal((await client.query(legacySql, legacy)).rowCount, 1);
    assert.equal((await client.query(legacySql, legacy)).rowCount, 0);
    await client.query("DELETE FROM usage_event WHERE idempotency_key=$1", [
      source,
    ]);
    assert.equal(
      (await client.query("SELECT resource_id FROM x_resource_reads")).rowCount,
      6,
    );

    // With today fixed to September 18 UTC, cleanup keeps the 17th and 18th.
    // This is a storage deletion check, not the future cleanup/admission worker.
    await client.query(readSql, ["2026-09-18", "post", "1"]);
    const removed = await client.query(
      "DELETE FROM x_resource_reads WHERE utc_day < $1::date - 1 RETURNING resource_id",
      ["2026-09-18"],
    );
    assert.equal(removed.rowCount, 4);
    assert.equal(
      (await client.query("SELECT resource_id FROM x_resource_reads")).rowCount,
      3,
    );
    assert.equal((await client.query(readSql, rolledBack)).rowCount, 0);
    console.log(
      "X resource storage invariants passed (dormant; no ingestion consumer)",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
