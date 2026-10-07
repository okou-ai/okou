import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

/**
 * Permanent run_model_catalog/model_routes invariants. Runs inside one
 * rolled-back transaction against the real current schema, so it works on
 * both the replayed and the freshly generated migration chains.
 */
export async function validatePermanentModelCatalogConstraints(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const prefix = `catalog-test-${randomUUID().slice(0, 8)}`;
  const id = (name: string) => {
    return `${prefix}-${name}`;
  };

  async function rejects(
    query: string,
    params: readonly unknown[],
    expected: { code: string; constraint: string },
  ) {
    await client.query("SAVEPOINT invalid_write");
    await assert.rejects(client.query(query, [...params]), expected);
    await client.query("ROLLBACK TO SAVEPOINT invalid_write");
    await client.query("RELEASE SAVEPOINT invalid_write");
  }

  async function insertModel(
    name: string,
    options: {
      rank?: number;
      replacedBy?: string;
      isSystemDefault?: boolean;
    } = {},
  ) {
    await client.query(
      `INSERT INTO run_model_catalog (
         model, display_name, sort_order, is_system_default, lineage_rank,
         replaced_by, replaced_by_lineage_rank
       )
       SELECT $1, $1, 1, $2, $3, target.model, target.lineage_rank
       FROM (SELECT 1) AS one
       LEFT JOIN run_model_catalog AS target ON target.model = $4`,
      [
        id(name),
        options.isSystemDefault ?? false,
        options.rank ?? 100,
        options.replacedBy ? id(options.replacedBy) : null,
      ],
    );
  }

  const insertReplaced = `INSERT INTO run_model_catalog (
      model, display_name, sort_order, lineage_rank, replaced_by,
      replaced_by_lineage_rank
    ) VALUES ($1, $1, 1, $2, $3, $4)`;
  const retire =
    "UPDATE run_model_catalog SET replaced_by = $2, replaced_by_lineage_rank = $3 WHERE model = $1";
  const replacementFk = {
    code: "23503",
    constraint: "fk_run_model_catalog_replaced_by",
  };
  const rankCheck = {
    code: "23514",
    constraint: "chk_run_model_catalog_replacement_rank",
  };

  try {
    await client.query("BEGIN");
    // Start from no default so this suite owns the single default slot.
    await client.query(
      "UPDATE run_model_catalog SET is_system_default = false WHERE is_system_default",
    );
    await insertModel("a", { isSystemDefault: true });
    await insertModel("c");
    await insertModel("d");
    // Multi-hop chain x -> b -> c is accepted.
    await insertModel("b", { rank: 50, replacedBy: "c" });
    await insertModel("x", { rank: 10, replacedBy: "b" });

    // Self-reference is rejected.
    await rejects(insertReplaced, [id("self"), 1, id("self"), 1], {
      code: "23514",
      constraint: "chk_run_model_catalog_not_self_replaced",
    });
    // A dangling target, or a rank that is not the target's, is rejected.
    await rejects(
      insertReplaced,
      [id("dangling"), 1, id("missing"), 100],
      replacementFk,
    );
    await rejects(
      insertReplaced,
      [id("lying"), 1, id("c"), 150],
      replacementFk,
    );
    // Both replacement columns are set together, so MATCH SIMPLE cannot skip
    // the foreign key.
    await rejects(insertReplaced, [id("unranked"), 1, id("c"), null], {
      code: "23514",
      constraint: "chk_run_model_catalog_replacement_pair",
    });
    await rejects(insertReplaced, [id("untargeted"), 1, null, 100], {
      code: "23514",
      constraint: "chk_run_model_catalog_replacement_pair",
    });
    // Cycles: A -> B -> A and a longer loop back to the chain start both need
    // a hop that does not increase the rank.
    await insertModel("p", { rank: 1 });
    await insertModel("q", { rank: 2 });
    await client.query(retire, [id("p"), id("q"), 2]);
    await rejects(retire, [id("q"), id("p"), 1], rankCheck);
    await rejects(retire, [id("q"), id("p"), 3], replacementFk);
    await rejects(retire, [id("c"), id("x"), 10], rankCheck);
    // Lowering a target's rank below a referrer's is rejected through the
    // cascaded copy; raising it is always allowed and keeps referrers valid.
    await rejects(
      "UPDATE run_model_catalog SET lineage_rank = 40 WHERE model = $1",
      [id("c")],
      rankCheck,
    );
    await client.query(
      "UPDATE run_model_catalog SET lineage_rank = 200 WHERE model = $1",
      [id("c")],
    );
    // A referenced replacement target cannot be deleted.
    await rejects(
      "DELETE FROM run_model_catalog WHERE model = $1",
      [id("c")],
      replacementFk,
    );

    // At most one default, and the default must stay active.
    await rejects(
      "UPDATE run_model_catalog SET is_system_default = true WHERE model = $1",
      [id("d")],
      { code: "23505", constraint: "idx_run_model_catalog_one_system_default" },
    );
    await rejects(retire, [id("a"), id("c"), 200], {
      code: "23514",
      constraint: "chk_run_model_catalog_default_active",
    });
    await rejects(
      `INSERT INTO run_model_catalog (model, display_name, sort_order, is_system_default, lineage_rank, replaced_by, replaced_by_lineage_rank)
       VALUES ($1, $1, 1, true, 1, $2, 200)`,
      [id("f"), id("c")],
      { code: "23514", constraint: "chk_run_model_catalog_default_active" },
    );

    // Switch the default first, then retire the old default in one
    // transaction; the chain resolves to the final active model.
    await client.query(
      "UPDATE run_model_catalog SET is_system_default = false WHERE model = $1",
      [id("a")],
    );
    await client.query(
      "UPDATE run_model_catalog SET is_system_default = true WHERE model = $1",
      [id("d")],
    );
    await client.query(retire, [id("a"), id("c"), 200]);
    const resolved = await client.query(
      `WITH RECURSIVE chain (source, target) AS (
         SELECT model, replaced_by FROM run_model_catalog
         WHERE model LIKE $1 AND replaced_by IS NOT NULL
         UNION ALL
         SELECT chain.source, next.replaced_by FROM chain
         JOIN run_model_catalog AS next
           ON next.model = chain.target AND next.replaced_by IS NOT NULL
       )
       SELECT chain.source, chain.target FROM chain
       JOIN run_model_catalog AS final
         ON final.model = chain.target AND final.replaced_by IS NULL
       ORDER BY chain.source`,
      [`${prefix}-%`],
    );
    assert.deepEqual(resolved.rows, [
      { source: id("a"), target: id("c") },
      { source: id("b"), target: id("c") },
      { source: id("p"), target: id("q") },
      { source: id("x"), target: id("c") },
    ]);
    const cascaded = await client.query(
      "SELECT replaced_by_lineage_rank FROM run_model_catalog WHERE model = $1",
      [id("b")],
    );
    assert.deepEqual(cascaded.rows, [{ replaced_by_lineage_rank: 200 }]);

    // Routes: model reference, identity, and value domains.
    const insertRoute = `INSERT INTO model_routes (
      model, provider_type, concrete_provider_type, subscription_type,
      upstream_model, priority, service_tiers, default_service_tier,
      efforts, default_effort, price_tier, pricing_kind, pricing_provider
    ) VALUES ($1, $2, $3, $4, $1, $5, $6, $7, $8, $9, $10, $11, $12)`;
    const builtIn = (overrides: Partial<Record<number, unknown>> = {}) => {
      const values: unknown[] = [
        id("d"),
        "built-in",
        "openrouter-codex",
        null,
        0,
        ["priority"],
        null,
        ["low", "high"],
        "high",
        "$",
        "model",
        id("d"),
      ];
      for (const [index, value] of Object.entries(overrides)) {
        values[Number(index)] = value;
      }
      return values;
    };
    await client.query(insertRoute, builtIn());
    await rejects(insertRoute, builtIn({ 4: 1 }), {
      code: "23505",
      constraint: "uq_model_routes_identity",
    });
    await rejects(insertRoute, builtIn({ 0: id("missing") }), {
      code: "23503",
      constraint: "model_routes_model_run_model_catalog_model_fk",
    });
    await rejects(insertRoute, builtIn({ 2: "codex-oauth-token", 4: 1 }), {
      code: "23514",
      constraint: "chk_model_routes_concrete_provider_type",
    });
    await rejects(insertRoute, builtIn({ 8: "max", 4: 1 }), {
      code: "23514",
      constraint: "chk_model_routes_efforts",
    });
    await rejects(insertRoute, builtIn({ 6: "ultrafast", 4: 1 }), {
      code: "23514",
      constraint: "chk_model_routes_service_tiers",
    });
    await rejects(insertRoute, builtIn({ 10: null, 11: null, 4: 1 }), {
      code: "23514",
      constraint: "chk_model_routes_pricing_link",
    });
    await rejects(
      insertRoute,
      builtIn({
        1: "unknown-provider",
        2: "unknown-provider",
        9: null,
        10: null,
        11: null,
      }),
      { code: "23514", constraint: "chk_model_routes_provider_type" },
    );
    await rejects(
      insertRoute,
      builtIn({
        1: "codex-oauth-token",
        2: "codex-oauth-token",
        3: "claude-code-oauth-token",
        9: null,
        10: null,
        11: null,
      }),
      { code: "23514", constraint: "chk_model_routes_subscription_type" },
    );
    await rejects(
      insertRoute,
      builtIn({
        1: "codex-oauth-token",
        2: "codex-oauth-token",
        3: "codex-oauth-token",
        5: [],
        7: [],
        8: null,
        10: null,
        11: null,
      }),
      { code: "23514", constraint: "chk_model_routes_price_tier" },
    );
    // A subscription route coexists with the model's Built-in route.
    await client.query(insertRoute, [
      id("d"),
      "codex-oauth-token",
      "codex-oauth-token",
      "codex-oauth-token",
      0,
      [],
      null,
      [],
      null,
      null,
      null,
      null,
    ]);
    // A catalog row with routes cannot be deleted.
    await client.query(
      "DELETE FROM run_model_catalog WHERE model = ANY($1::varchar[])",
      [[id("x"), id("b"), id("a"), id("p"), id("q")]],
    );
    await rejects("DELETE FROM run_model_catalog WHERE model = $1", [id("d")], {
      code: "23503",
      constraint: "model_routes_model_run_model_catalog_model_fk",
    });
    console.log(
      "   ✅ Model catalog replacement, default and route constraints hold",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  await validatePermanentModelCatalogConstraints(databaseUrl);
}
