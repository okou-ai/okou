import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { z } from "zod";

async function rejectsObservation(
  databaseUrl: string,
  readSql: string,
  parameters: string[],
  observationSql: string,
): Promise<void> {
  const [day, type, id] = z
    .tuple([z.string(), z.string(), z.string()])
    .parse(parameters);
  const pgClient = new Client({ connectionString: databaseUrl });
  const failures: unknown[] = [];
  let ownedKeys: string[][] = [];
  const deleteSql = `DELETE FROM x_resource_reads
    WHERE utc_day=$1 AND resource_type=$2 AND resource_id=$3
    RETURNING resource_id`;
  try {
    await pgClient.connect();
    await pgClient.query("SET TIME ZONE 'Asia/Shanghai'");
    const probe = await pgClient.query(readSql, parameters);
    ownedKeys = z
      .array(z.object({ resource_id: z.string() }))
      .parse(probe.rows)
      .map((row) => {
        return [day, type, row.resource_id];
      });
    assert.equal(probe.rowCount, 1);
    assert.deepEqual(probe.rows, [{ resource_id: id }]);

    // Consume ownership before attempting deletion: a lost response is unknown,
    // not permission to retry cleanup or to delete an ON CONFLICT loser.
    const probeKey = ownedKeys.pop();
    assert.ok(probeKey);
    assert.equal((await pgClient.query(deleteSql, probeKey)).rowCount, 1);

    await assert.rejects(
      pgClient.query(observationSql, parameters).then((result) => {
        // Both writes project their actual full keys, including the date's
        // explicit text representation, even if a broken CHECK accepts them.
        ownedKeys = z
          .array(
            z.object({
              utc_day: z.string(),
              resource_type: z.string(),
              resource_id: z.string(),
            }),
          )
          .parse(result.rows)
          .map((row) => {
            return [row.utc_day, row.resource_type, row.resource_id];
          });
        assert.equal(result.rowCount, ownedKeys.length);
      }),
      { code: "23514", constraint: "x_resource_read_type_check" },
    );
    assert.equal(
      (
        await pgClient.query(
          `SELECT resource_id FROM x_resource_reads
           WHERE utc_day=$1 AND resource_id=$3
             AND resource_type IN ($2, 'relation')`,
          parameters,
        )
      ).rowCount,
      0,
    );
  } catch (error) {
    failures.push(error);
  } finally {
    for (const ownedKey of ownedKeys) {
      try {
        assert.equal((await pgClient.query(deleteSql, ownedKey)).rowCount, 1);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await pgClient.end();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "X observation fixture cleanup failed");
  }
}

/** Migration invariants against isolated replayed and fresh schemas, before
 * an API is running against either database. Production ingestion, concurrency,
 * time admission and cleanup behavior are covered by the API route tests. */
export async function validateXResourceUsageSchema(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0438; new non-billing transactions are prohibited.
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");

    async function rejects(query: string, parameters: unknown[], code: string) {
      const pgClient = new Client({ connectionString: databaseUrl });
      const failures: unknown[] = [];
      let inserted = false;
      try {
        await pgClient.connect();
        await pgClient.query("SET TIME ZONE 'Asia/Shanghai'");
        await assert.rejects(
          pgClient.query(query, parameters).then((result) => {
            inserted = result.rowCount === 1;
          }),
          { code },
        );
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          // A broken CHECK must fail the assertion without leaving its write.
          // ON CONFLICT returns no row, so an existing key is never ours to delete.
          if (inserted) {
            const removed = await pgClient.query(
              `DELETE FROM x_resource_reads
               WHERE utc_day=$1 AND resource_type=$2 AND resource_id=$3
               RETURNING resource_id`,
              parameters,
            );
            assert.equal(removed.rowCount, 1);
          }
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            await pgClient.end();
          } catch (error) {
            failures.push(error);
          }
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "X rejection fixture cleanup failed",
        );
      }
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

    // A dependent CHECK failure rolls back the whole autocommit statement.
    const rolledBack = ["2026-09-17", "post", "3"];
    await rejectsObservation(
      databaseUrl,
      readSql,
      rolledBack,
      `WITH observed AS (
        INSERT INTO x_resource_reads (utc_day,resource_type,resource_id)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
        RETURNING utc_day::text AS utc_day, resource_type, resource_id
      ), rejected AS (
        INSERT INTO x_resource_reads (utc_day,resource_type,resource_id)
        SELECT utc_day::date, 'relation', resource_id FROM observed
        ON CONFLICT DO NOTHING
        RETURNING utc_day::text AS utc_day, resource_type, resource_id
      )
      SELECT utc_day, resource_type, resource_id FROM observed
      UNION ALL
      SELECT utc_day, resource_type, resource_id FROM rejected`,
    );
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
    // This verifies migration storage; the API suite covers the cleanup worker.
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
    console.log("X resource storage invariants passed");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
