import { computed } from "ccstate";
import { asc, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { resolveSkillRef } from "@okouai/core/github-url";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { usagePricing } from "@okouai/db/runtime/usage-pricing";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { skills as skillCatalog } from "@okouai/db/schema/skill";
import { array, unknown as zUnknown } from "zod";
import { db$ } from "../external/db";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
import { validateModelCatalog } from "./model-catalog.service";
import { usagePricingByKey } from "./built-in-route-pricing";
import { observePgOperation } from "../../lib/db-instrumentation";

const seedSkillColumns = Object.freeze({
  url: skillCatalog.url,
  contentBundle: skillCatalog.contentBundle,
});

/** Every Seed Skill bundle; each run filters and checks its own selection. */
function seedSkillRows(builder: QueryBuilder) {
  return builder
    .select({
      payload: contextJsonProjection(seedSkillColumns)
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(skillCatalog)
    .where(inArray(skillCatalog.url, SEED_SKILLS.map(resolveSkillRef)));
}

/** One statement snapshot makes every global read gate enqueue with the catalog. */
export function createGlobalModelContext() {
  const keys = {
    id: builtInModelKeys.id,
    vendor: builtInModelKeys.vendor,
    apiKey: builtInModelKeys.apiKey,
  };
  const pricing = {
    kind: usagePricing.kind,
    provider: usagePricing.provider,
    category: usagePricing.category,
  };
  const models = {
    model: runModelCatalog.model,
    displayName: runModelCatalog.displayName,
    sortOrder: runModelCatalog.sortOrder,
    replacedBy: runModelCatalog.replacedBy,
    builtInOnRestrictedPlans: runModelCatalog.builtInOnRestrictedPlans,
    piRouteClass: runModelCatalog.piRouteClass,
  };
  const routes = {
    model: modelRoutes.model,
    providerType: modelRoutes.providerType,
    concreteProviderType: modelRoutes.concreteProviderType,
    subscriptionType: modelRoutes.subscriptionType,
    upstreamModel: modelRoutes.upstreamModel,
    enabled: modelRoutes.enabled,
    priority: modelRoutes.priority,
    serviceTiers: modelRoutes.serviceTiers,
    defaultServiceTier: modelRoutes.defaultServiceTier,
    efforts: modelRoutes.efforts,
    defaultEffort: modelRoutes.defaultEffort,
    pricingKind: modelRoutes.pricingKind,
    pricingProvider: modelRoutes.pricingProvider,
    longContextMinTotalInputTokens: modelRoutes.longContextMinTotalInputTokens,
  };
  const builder = new QueryBuilder();
  const globalRaw$ = computed(async (get) => {
    const keyRows = builder
      .select({
        payload: contextJsonProjection(keys)
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
      })
      .from(builtInModelKeys);
    const prices = builder
      .select({
        payload: contextJsonProjection(pricing)
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
      })
      .from(usagePricing);
    const modelRows = builder
      .select({
        payload: contextJsonProjection(models)
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
      })
      .from(runModelCatalog)
      .orderBy(asc(runModelCatalog.sortOrder), asc(runModelCatalog.model));
    const routeRows = builder
      .select({
        payload: contextJsonProjection(routes)
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
      })
      .from(modelRoutes)
      .orderBy(
        asc(modelRoutes.model),
        asc(modelRoutes.providerType),
        sql`${modelRoutes.subscriptionType} asc nulls first`,
        asc(modelRoutes.priority),
      );
    const read = async () => {
      return await get(db$)
        .select({
          keys: contextJsonRows(keyRows).mapWith(
            zodDriverValueDecoder(zUnknown()),
          ),
          pricing: contextJsonRows(prices).mapWith(
            zodDriverValueDecoder(zUnknown()),
          ),
          models: contextJsonRows(modelRows).mapWith(
            zodDriverValueDecoder(zUnknown()),
          ),
          routes: contextJsonRows(routeRows).mapWith(
            zodDriverValueDecoder(zUnknown()),
          ),
          seedSkills: contextJsonRows(seedSkillRows(builder)).mapWith(
            zodDriverValueDecoder(zUnknown()),
          ),
        })
        .from(sql`(values (1)) as context_seed(value)`);
    };
    const [row] = await observePgOperation("global_model_read", read);
    if (!row) {
      throw new Error("Global model context query returned no row");
    }
    return row;
  });
  const managedModelKeys$ = computed(async (get) => {
    return array(contextProjectionSchema(keys)).parse(
      (await get(globalRaw$)).keys,
    );
  });
  const modelPricing$ = computed(async (get) => {
    return usagePricingByKey(
      array(contextProjectionSchema(pricing)).parse(
        (await get(globalRaw$)).pricing,
      ),
    );
  });
  const catalog$ = computed(async (get) => {
    const row = await get(globalRaw$);
    return validateModelCatalog(
      array(contextProjectionSchema(models)).parse(row.models),
      array(contextProjectionSchema(routes)).parse(row.routes),
    );
  });
  // Decoding never checks preparation; the consuming run validates its skills.
  const seedSkills$ = computed(async (get) => {
    return array(contextProjectionSchema(seedSkillColumns)).parse(
      (await get(globalRaw$)).seedSkills,
    );
  });
  return { managedModelKeys$, modelPricing$, catalog$, seedSkills$ };
}
