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
    options: { replacedBy?: string; isSystemDefault?: boolean } = {},
  ) {
    await client.query(
      `INSERT INTO run_model_catalog (model, display_name, sort_order, is_system_default, replaced_by)
       VALUES ($1, $1, 1, $2, $3)`,
      [id(name), options.isSystemDefault ?? false, options.replacedBy ?? null],
    );
  }

  const replacementFk = {
    code: "23503",
    constraint: "fk_run_model_catalog_replaced_by_active",
  };

  try {
    await client.query("BEGIN");
    // Start from no default so this suite owns the single default slot.
    await client.query(
      "UPDATE run_model_catalog SET is_system_default = false WHERE is_system_default",
    );
    await insertModel("a", { isSystemDefault: true });
    await insertModel("b", { replacedBy: id("a") });
    await insertModel("d");

    // Self-reference, a retired target and a missing target are rejected.
    await rejects(
      `INSERT INTO run_model_catalog (model, display_name, sort_order, replaced_by)
       VALUES ($1, $1, 1, $1)`,
      [id("self")],
      replacementFk,
    );
    await rejects(
      `INSERT INTO run_model_catalog (model, display_name, sort_order, replaced_by)
       VALUES ($1, $1, 1, $2)`,
      [id("chain"), id("b")],
      replacementFk,
    );
    await rejects(
      `INSERT INTO run_model_catalog (model, display_name, sort_order, replaced_by)
       VALUES ($1, $1, 1, $2)`,
      [id("dangling"), id("missing")],
      replacementFk,
    );
    // A cycle requires pointing at a retired row.
    await rejects(
      "UPDATE run_model_catalog SET replaced_by = $2 WHERE model = $1",
      [id("d"), id("b")],
      replacementFk,
    );
    // A referenced replacement target can be neither deleted nor retired
    // while its referrers still point at it.
    await rejects(
      "DELETE FROM run_model_catalog WHERE model = $1",
      [id("a")],
      replacementFk,
    );

    // At most one default, and the default must stay active.
    await rejects(
      "UPDATE run_model_catalog SET is_system_default = true WHERE model = $1",
      [id("d")],
      { code: "23505", constraint: "idx_run_model_catalog_one_system_default" },
    );
    await rejects(
      "UPDATE run_model_catalog SET replaced_by = $2 WHERE model = $1",
      [id("a"), id("d")],
      { code: "23514", constraint: "chk_run_model_catalog_default_active" },
    );
    await rejects(
      `INSERT INTO run_model_catalog (model, display_name, sort_order, is_system_default, replaced_by)
       VALUES ($1, $1, 1, false, NULL), ($2, $2, 1, true, $1)`,
      [id("e"), id("f")],
      { code: "23514", constraint: "chk_run_model_catalog_default_active" },
    );

    // Switch the default first, then retire the old default and repoint its
    // referrer to the final active model within one transaction.
    await client.query(
      "UPDATE run_model_catalog SET is_system_default = false WHERE model = $1",
      [id("a")],
    );
    await client.query(
      "UPDATE run_model_catalog SET is_system_default = true WHERE model = $1",
      [id("d")],
    );
    await rejects(
      "UPDATE run_model_catalog SET replaced_by = $2 WHERE model = $1",
      [id("a"), id("d")],
      replacementFk,
    );
    await client.query(
      "UPDATE run_model_catalog SET replaced_by = $2 WHERE model = $1",
      [id("b"), id("d")],
    );
    await client.query(
      "UPDATE run_model_catalog SET replaced_by = $2 WHERE model = $1",
      [id("a"), id("d")],
    );
    const resolved = await client.query(
      `SELECT model, replaced_by, is_active FROM run_model_catalog
       WHERE model LIKE $1 ORDER BY model`,
      [`${prefix}-%`],
    );
    assert.deepEqual(resolved.rows, [
      { model: id("a"), replaced_by: id("d"), is_active: false },
      { model: id("b"), replaced_by: id("d"), is_active: false },
      { model: id("d"), replaced_by: null, is_active: true },
    ]);

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
        "openai-api-key",
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
    await rejects(insertRoute, builtIn({ 2: "openrouter-codex" }), {
      code: "23505",
      constraint: "uq_model_routes_priority",
    });
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
    await rejects(insertRoute, builtIn({ 8: "max", 4: 1, 2: "deepseek" }), {
      code: "23514",
      constraint: "chk_model_routes_efforts",
    });
    await rejects(
      insertRoute,
      builtIn({ 6: "ultrafast", 4: 1, 2: "deepseek" }),
      {
        code: "23514",
        constraint: "chk_model_routes_service_tiers",
      },
    );
    await rejects(
      insertRoute,
      builtIn({ 10: null, 11: null, 4: 1, 2: "deepseek" }),
      { code: "23514", constraint: "chk_model_routes_pricing_link" },
    );
    await rejects(
      insertRoute,
      builtIn({
        1: "openai-api-key",
        2: "openrouter-codex",
        9: null,
        10: null,
        11: null,
      }),
      { code: "23514", constraint: "chk_model_routes_concrete_provider_type" },
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
        1: "openai-api-key",
        2: "openai-api-key",
        10: null,
        11: null,
      }),
      { code: "23514", constraint: "chk_model_routes_price_tier" },
    );
    // A BYOK route and a subscription route of the same provider coexist.
    for (const subscriptionType of [null, "codex-oauth-token"]) {
      await client.query(insertRoute, [
        id("d"),
        "codex-oauth-token",
        "codex-oauth-token",
        subscriptionType,
        0,
        [],
        null,
        [],
        null,
        null,
        null,
        null,
      ]);
    }
    // A catalog row with routes cannot be deleted.
    await client.query(
      "DELETE FROM run_model_catalog WHERE model = ANY($1::varchar[])",
      [[id("a"), id("b")]],
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
