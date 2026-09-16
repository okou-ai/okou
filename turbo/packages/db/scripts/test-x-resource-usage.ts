import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Storage-boundary invariants, exercised against replayed and fresh schemas.
 * Accounting, authorization and lifecycle behavior belong to the consumer. */
export async function validateXResourceUsageSchema(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    // The observed day must be UTC even with a non-UTC database session.
    await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
    const scope = randomUUID();
    const otherScope = randomUUID();
    const run = randomUUID();
    const otherRun = randomUUID();
    const binding = randomUUID();
    const otherBinding = randomUUID();
    const source = randomUUID();

    async function rejects(query: string, parameters: unknown[], code: string) {
      await client.query("SAVEPOINT invalid_x_write");
      await assert.rejects(client.query(query, parameters), { code });
      await client.query("ROLLBACK TO SAVEPOINT invalid_x_write");
    }

    await client.query(
      "INSERT INTO x_usage_billing_scopes (id) VALUES ($1), ($2)",
      [scope, otherScope],
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT activated_from_day, closed_through_day FROM x_usage_billing_scopes WHERE id=$1",
          [scope],
        )
      ).rows,
      [{ activated_from_day: null, closed_through_day: null }],
    );

    for (const [runId, bindingId] of [
      [run, binding],
      [otherRun, otherBinding],
    ]) {
      const session = randomUUID();
      const org = `org_${runId}`;
      const user = `user_${runId}`;
      await client.query(
        "INSERT INTO agent_sessions (id,org_id,user_id) VALUES ($1,$2,$3)",
        [session, org, user],
      );
      await client.query(
        "INSERT INTO agent_runs (id,org_id,user_id,session_id,status,prompt) VALUES ($1,$2,$3,$4,'pending','x storage invariants')",
        [runId, org, user, session],
      );
      await client.query(
        `INSERT INTO x_usage_run_bindings
        (id,run_id,org_id,user_id,scope_id,configuration_revision,valid_from,valid_until)
        VALUES ($1,$2,$3,$4,$5,'synthetic-config-v1','2026-09-16T00:00:00Z','2026-09-17T00:00:00Z')`,
        [bindingId, runId, org, user, scope],
      );
    }

    const claimSql = `INSERT INTO x_usage_resource_claims (scope_id,utc_day,namespace,resource_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING resource_id`;
    const key = [scope, "2026-09-16", "post", "9007199254740993"];
    assert.equal((await client.query(claimSql, key)).rowCount, 1);
    assert.equal((await client.query(claimSql, key)).rowCount, 0);
    for (const separateKey of [
      [otherScope, "2026-09-16", "post", "9007199254740993"],
      [scope, "2026-09-17", "post", "9007199254740993"],
      [scope, "2026-09-16", "user", "9007199254740993"],
    ]) {
      assert.equal((await client.query(claimSql, separateKey)).rowCount, 1);
    }
    for (const id of ["", "1\n", "1.0", "１２", "-1"]) {
      await rejects(claimSql, [scope, "2026-09-16", "post", id], "23514");
    }
    await rejects(claimSql, [scope, "2026-09-16", "relation", "1"], "23514");
    await rejects(claimSql, [scope, "infinity", "post", "1"], "23514");
    await rejects(claimSql, [randomUUID(), "2026-09-16", "post", "1"], "23503");

    const receiptSql = `INSERT INTO x_usage_observation_receipts
      (run_id,source_id,binding_id,payload_digest,observed_at,utc_day,net_quantity)
      VALUES ($1,$2,$3,$4,'2026-09-16T23:59:59.999Z',$5,$6)`;
    const receipt = [run, source, binding, "a".repeat(64), "2026-09-16", "0"];
    await client.query(receiptSql, receipt);
    // The same source UUID in another authenticated run is a separate receipt.
    await client.query(receiptSql, [
      otherRun,
      source,
      otherBinding,
      "b".repeat(64),
      "2026-09-16",
      "9007199254740991",
    ]);
    await rejects(receiptSql, receipt, "23505");
    await rejects(
      receiptSql,
      [run, randomUUID(), otherBinding, "a".repeat(64), "2026-09-16", "0"],
      "23503",
    );
    await rejects(
      receiptSql,
      [run, randomUUID(), binding, "z".repeat(64), "2026-09-16", "0"],
      "23514",
    );
    await rejects(
      receiptSql,
      [run, randomUUID(), binding, "a".repeat(64), "2026-09-17", "0"],
      "23514",
    );
    for (const quantity of ["-1", "9007199254740992"]) {
      await rejects(
        receiptSql,
        [run, randomUUID(), binding, "a".repeat(64), "2026-09-16", quantity],
        "23514",
      );
    }
    await rejects(
      "UPDATE x_usage_run_bindings SET valid_until=valid_from WHERE id=$1",
      [binding],
      "23514",
    );
    await rejects(
      "UPDATE x_usage_run_bindings SET valid_until='infinity' WHERE id=$1",
      [binding],
      "23514",
    );
    await rejects(
      "UPDATE x_usage_run_bindings SET configuration_revision='' WHERE id=$1",
      [binding],
      "23514",
    );

    // Old count writers still work, and removing a compactable ledger row
    // cannot remove the durable source receipt.
    await client.query(
      `INSERT INTO usage_event (run_id,idempotency_key,org_id,user_id,kind,provider,category,quantity)
      VALUES ($1,$2,$3,$4,'connector','x','tweet.read',5)`,
      [run, source, `org_${run}`, `user_${run}`],
    );
    await client.query("DELETE FROM usage_event WHERE idempotency_key=$1", [
      source,
    ]);
    assert.equal(
      (
        await client.query(
          "SELECT source_id FROM x_usage_observation_receipts WHERE run_id=$1",
          [run],
        )
      ).rowCount,
      1,
    );

    // Account cleanup can remove binding-owned personal data, and run erasure
    // cascades it too. Neither operation can remove shared daily consumption.
    await client.query("DELETE FROM x_usage_run_bindings WHERE org_id=$1", [
      `org_${otherRun}`,
    ]);
    await client.query("DELETE FROM agent_runs WHERE id=$1", [run]);
    assert.equal(
      (
        await client.query(
          "SELECT id FROM x_usage_run_bindings WHERE id IN ($1,$2)",
          [binding, otherBinding],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT source_id FROM x_usage_observation_receipts WHERE run_id IN ($1,$2)",
          [run, otherRun],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT resource_id FROM x_usage_resource_claims WHERE scope_id IN ($1,$2)",
          [scope, otherScope],
        )
      ).rowCount,
      4,
    );
    await rejects(
      "DELETE FROM x_usage_billing_scopes WHERE id=$1",
      [scope],
      "23503",
    );
    console.log(
      "X resource storage invariants passed (dormant; no ingestion consumer)",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}
