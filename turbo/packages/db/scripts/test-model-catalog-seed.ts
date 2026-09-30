import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  ACTIVE_RUN_MODELS,
  BUILT_IN_MODEL_PRICE_TIER,
  SUPPORTED_RUN_MODELS,
  getBuiltInModelRouteCandidates,
  getCanonicalModelDisplayName,
  getProviderRuntimeModel,
  getProvidersForModel,
  isCodexFastModeModel,
  isActiveRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { getModelRunOptions } from "@okouai/api-contracts/contracts/model-run-options";

/**
 * Transition validator for migration 1296_global_model_catalog: until readers
 * switch to the catalog, the seeded rows must agree with the code constants
 * they duplicate. Delete with the code lists (PR-E).
 */
export async function validateModelCatalogSeed(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const catalog = await client.query<{
      model: string;
      display_name: string;
      is_system_default: boolean;
      replaced_by: string | null;
    }>(
      `SELECT model, display_name, is_system_default, replaced_by
       FROM run_model_catalog ORDER BY sort_order, model`,
    );
    const active = catalog.rows.filter((row) => {
      return row.replaced_by === null;
    });
    // Active set and order match ACTIVE_RUN_MODELS; labels match the code.
    assert.deepEqual(
      active.map((row) => {
        return row.model;
      }),
      [...ACTIVE_RUN_MODELS],
    );
    for (const row of catalog.rows) {
      assert.equal(row.display_name, getCanonicalModelDisplayName(row.model));
      assert.ok(
        (SUPPORTED_RUN_MODELS as readonly string[]).includes(row.model),
        row.model,
      );
      assert.equal(isActiveRunModel(row.model), row.replaced_by === null);
    }
    assert.deepEqual(
      catalog.rows
        .filter((row) => {
          return row.replaced_by !== null;
        })
        .map((row) => {
          return [row.model, row.replaced_by];
        }),
      [["claude-fable-5", "claude-fable-5-1"]],
    );
    assert.deepEqual(
      catalog.rows
        .filter((row) => {
          return row.is_system_default;
        })
        .map((row) => {
          return row.model;
        }),
      ["okou-1.0"],
    );

    const routes = await client.query<{
      model: string;
      provider_type: string;
      concrete_provider_type: string;
      subscription_type: string | null;
      upstream_model: string;
      enabled: boolean;
      priority: number;
      service_tiers: string[];
      default_service_tier: string | null;
      efforts: string[];
      default_effort: string | null;
      price_tier: string | null;
      pricing_kind: string | null;
      pricing_provider: string | null;
    }>(
      `SELECT model, provider_type, concrete_provider_type, subscription_type,
         upstream_model, enabled, priority, service_tiers, default_service_tier,
         efforts, default_effort, price_tier, pricing_kind, pricing_provider
       FROM model_routes
       ORDER BY model, provider_type, subscription_type NULLS FIRST, priority`,
    );
    const key = (row: {
      model: string;
      provider_type: string;
      subscription_type: string | null;
      priority: number;
    }) => {
      return `${row.model}|${row.provider_type}|${row.subscription_type ?? ""}|${row.priority}`;
    };
    const expected = new Map<string, unknown>();
    const tiers = (model: string, providerType: string) => {
      return [
        ...(isCodexFastModeModel(model) ? ["priority"] : []),
        ...(model === "gpt-6-astra" && providerType === "openai-api-key"
          ? ["ultrafast"]
          : []),
      ];
    };
    for (const model of ACTIVE_RUN_MODELS) {
      const options = getModelRunOptions(model);
      const efforts = [...options.efforts];
      const defaultEffort = options.defaultEffort ?? null;
      getBuiltInModelRouteCandidates(model).forEach((candidate, priority) => {
        const row = {
          model,
          provider_type: "built-in",
          concrete_provider_type: candidate.providerType,
          subscription_type: null,
          upstream_model: candidate.upstreamModel,
          enabled: true,
          priority,
          service_tiers: tiers(model, "built-in"),
          default_service_tier: null,
          efforts,
          default_effort: defaultEffort,
          price_tier: BUILT_IN_MODEL_PRICE_TIER[model],
          pricing_kind: "model",
          pricing_provider: model,
        };
        expected.set(key(row), row);
      });
      for (const providerType of getProvidersForModel(model)) {
        if (providerType === "built-in") {
          continue;
        }
        const row = {
          model,
          provider_type: providerType,
          concrete_provider_type: providerType,
          subscription_type: null,
          upstream_model: getProviderRuntimeModel(providerType, model),
          enabled: true,
          priority: 0,
          service_tiers: tiers(model, providerType),
          default_service_tier: null,
          efforts,
          default_effort: defaultEffort,
          price_tier: null,
          pricing_kind: null,
          pricing_provider: null,
        };
        expected.set(key(row), row);
      }
    }
    // Subscription routes mirror subscription_model_catalog, whose names and
    // order must agree with the global catalog.
    const subscriptions = await client.query<{
      subscription_type: string;
      model: string;
      display_name: string;
      efforts: string[];
      service_tier: string | null;
    }>(
      `SELECT subscription_type, model, display_name, efforts, service_tier
       FROM subscription_model_catalog ORDER BY sort_order, subscription_type, model`,
    );
    assert.ok(subscriptions.rows.length > 0);
    const catalogOrder = active.map((row) => {
      return row.model;
    });
    assert.deepEqual(
      subscriptions.rows.map((row) => {
        return row.model;
      }),
      [...subscriptions.rows]
        .map((row) => {
          return row.model;
        })
        .sort((left, right) => {
          return catalogOrder.indexOf(left) - catalogOrder.indexOf(right);
        }),
    );
    for (const subscription of subscriptions.rows) {
      assert.equal(
        subscription.display_name,
        getCanonicalModelDisplayName(subscription.model),
      );
      const row = {
        model: subscription.model,
        provider_type: subscription.subscription_type,
        concrete_provider_type: subscription.subscription_type,
        subscription_type: subscription.subscription_type,
        upstream_model: subscription.model,
        enabled: true,
        priority: 0,
        service_tiers: subscription.service_tier
          ? [subscription.service_tier]
          : [],
        default_service_tier: null,
        efforts: subscription.efforts,
        default_effort: null,
        price_tier: null,
        pricing_kind: null,
        pricing_provider: null,
      };
      expected.set(key(row), row);
    }
    assert.deepEqual(
      new Map(
        routes.rows.map((row) => {
          return [key(row), row];
        }),
      ),
      expected,
    );
    console.log(
      "   ✅ Seeded model catalog and routes match the code constants",
    );
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  await validateModelCatalogSeed(databaseUrl);
}
