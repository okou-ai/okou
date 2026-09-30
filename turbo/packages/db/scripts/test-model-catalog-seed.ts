import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { getBuiltInRouteProviderVendor } from "@okouai/api-contracts/contracts/model-providers";

const SERVICE_TIERS: ReadonlySet<string> = new Set(["priority", "ultrafast"]);

interface CatalogRow {
  model: string;
  display_name: string;
  sort_order: number;
  is_system_default: boolean;
  replaced_by: string | null;
  built_in_on_restricted_plans: boolean | null;
}

/**
 * Free-plan Built-in entitlement seeded by migration 1299: free plans
 * (`org_plan_entitlements.restricted_built_in_models`) run only okou-1.0 on
 * Built-in routes; these catalog flags, not code, decide the models.
 */
const BUILT_IN_ON_RESTRICTED_PLANS: readonly string[] = ["okou-1.0"];

function modelsWhere(
  rows: readonly CatalogRow[],
  predicate: (row: CatalogRow) => boolean,
): string[] {
  return rows
    .filter(predicate)
    .map((row) => {
      return row.model;
    })
    .sort();
}

function assertRestrictedPlanFlags(rows: readonly CatalogRow[]): void {
  for (const row of rows) {
    assert.equal(
      typeof row.built_in_on_restricted_plans,
      "boolean",
      `${row.model}: built_in_on_restricted_plans`,
    );
  }
  assert.deepEqual(
    modelsWhere(rows, (row) => {
      return row.built_in_on_restricted_plans === true;
    }),
    [...BUILT_IN_ON_RESTRICTED_PLANS].sort(),
    "Built-in models allowed on restricted plans",
  );
}

interface RouteRow {
  model: string;
  provider_type: string;
  concrete_provider_type: string;
  subscription_type: string | null;
  enabled: boolean;
  priority: number;
  service_tiers: string[];
  default_service_tier: string | null;
  efforts: string[];
  default_effort: string | null;
  price_tier: string | null;
  pricing_kind: string | null;
  pricing_provider: string | null;
}

function assertCatalogRows(rows: readonly CatalogRow[]): void {
  const byModel = new Map(
    rows.map((row) => {
      return [row.model, row];
    }),
  );
  for (const row of rows) {
    assert.ok(row.display_name.length > 0, row.model);
    // Each replacement chain ends at an active model without cycles.
    const seen = new Set<string>();
    let current: CatalogRow | undefined = row;
    while (current?.replaced_by) {
      assert.ok(!seen.has(current.model), `${row.model}: replacement cycle`);
      seen.add(current.model);
      current = byModel.get(current.replaced_by);
      assert.ok(current, `${row.model}: unknown replacement`);
    }
  }
  const defaults = rows.filter((row) => {
    return row.is_system_default;
  });
  assert.equal(defaults.length, 1, "exactly one system default");
  assert.equal(defaults[0]?.replaced_by, null, "system default is active");
}

function assertRoute(route: RouteRow): void {
  const label = `${route.model}/${route.provider_type}/${route.priority}`;
  assert.equal(new Set(route.efforts).size, route.efforts.length, label);
  assert.ok(
    route.default_effort === null ||
      route.efforts.includes(route.default_effort),
    `${label}: default effort outside its efforts`,
  );
  assert.ok(
    route.service_tiers.every((tier) => {
      return SERVICE_TIERS.has(tier);
    }),
    `${label}: unknown service tier`,
  );
  assert.ok(
    route.default_service_tier === null ||
      route.service_tiers.includes(route.default_service_tier),
    `${label}: default service tier outside its tiers`,
  );
  assert.ok(
    route.subscription_type === null ||
      route.subscription_type === route.provider_type,
    label,
  );
  if (route.provider_type === "built-in") {
    assert.ok(
      getBuiltInRouteProviderVendor(route.concrete_provider_type),
      `${label}: no Built-in provider for ${route.concrete_provider_type}`,
    );
    assert.ok(route.price_tier, `${label}: missing price tier`);
    assert.equal(route.pricing_kind, "model", label);
    assert.ok(route.pricing_provider, `${label}: missing pricing link`);
    return;
  }
  assert.equal(route.concrete_provider_type, route.provider_type, label);
  assert.deepEqual(
    [route.price_tier, route.pricing_kind, route.pricing_provider],
    [null, null, null],
    `${label}: own routes are not priced by the catalog`,
  );
}

function assertRoutes(
  catalog: readonly CatalogRow[],
  routes: readonly RouteRow[],
): void {
  const byModel = new Map(
    catalog.map((row) => {
      return [row.model, row];
    }),
  );
  for (const route of routes) {
    const row = byModel.get(route.model);
    assert.ok(row, `${route.model}: route without a catalog model`);
    assert.equal(row.replaced_by, null, `${route.model}: retired model route`);
    assertRoute(route);
  }
  for (const row of catalog) {
    const builtIn = routes.filter((route) => {
      return route.model === row.model && route.provider_type === "built-in";
    });
    // Built-in candidates have distinct priorities and one display tier.
    assert.equal(
      new Set(
        builtIn.map((route) => {
          return route.priority;
        }),
      ).size,
      builtIn.length,
      `${row.model}: duplicate Built-in priority`,
    );
    assert.ok(
      new Set(
        builtIn.map((route) => {
          return route.price_tier;
        }),
      ).size <= 1,
      `${row.model}: Built-in routes disagree on the price tier`,
    );
    if (row.is_system_default) {
      assert.ok(
        builtIn.some((route) => {
          return route.enabled;
        }),
        "system default needs an enabled Built-in route",
      );
    }
  }
}

/**
 * Validates the internal consistency of the seeded global model catalog:
 * replacement chains, one system default, and route capabilities that agree
 * with themselves (defaults inside their lists, one pricing link and price
 * tier per Built-in route), the restricted-plan entitlement flags, plus the
 * subscription catalog mirror.
 */
export async function validateModelCatalogSeed(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const catalog = await client.query<CatalogRow>(
      `SELECT model, display_name, sort_order, is_system_default, replaced_by,
         built_in_on_restricted_plans
       FROM run_model_catalog ORDER BY sort_order, model`,
    );
    assertCatalogRows(catalog.rows);
    assertRestrictedPlanFlags(catalog.rows);
    const routes = await client.query<RouteRow>(
      `SELECT model, provider_type, concrete_provider_type, subscription_type,
         enabled, priority, service_tiers, default_service_tier, efforts,
         default_effort, price_tier, pricing_kind, pricing_provider
       FROM model_routes`,
    );
    assertRoutes(catalog.rows, routes.rows);

    // Subscription models mirror catalog names, order and routes.
    const subscriptions = await client.query<{
      subscription_type: string;
      model: string;
      display_name: string;
    }>(
      `SELECT subscription_type, model, display_name
       FROM subscription_model_catalog ORDER BY sort_order, subscription_type, model`,
    );
    const order = catalog.rows.map((row) => {
      return row.model;
    });
    assert.deepEqual(
      subscriptions.rows.map((row) => {
        return row.model;
      }),
      subscriptions.rows
        .map((row) => {
          return row.model;
        })
        .sort((left, right) => {
          return order.indexOf(left) - order.indexOf(right);
        }),
    );
    for (const subscription of subscriptions.rows) {
      assert.equal(
        subscription.display_name,
        catalog.rows.find((row) => {
          return row.model === subscription.model;
        })?.display_name,
      );
      assert.ok(
        routes.rows.some((route) => {
          return (
            route.model === subscription.model &&
            route.subscription_type === subscription.subscription_type
          );
        }),
        `${subscription.model}: subscription model without a route`,
      );
    }
    console.log("   ✅ Seeded model catalog and routes are consistent");
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  await validateModelCatalogSeed(databaseUrl);
}
