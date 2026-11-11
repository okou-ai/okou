import { computed, type Computed } from "ccstate";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { resolveSkillRef } from "@okouai/core/github-url";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { usagePricing } from "@okouai/db/runtime/usage-pricing";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { skills as skillCatalog } from "@okouai/db/schema/skill";
import { array, object, unknown as zUnknown, type infer as zInfer } from "zod";
import { db$ } from "../external/db";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
import { validateModelCatalog } from "./model-catalog.service";
import { usagePricingByKey } from "./built-in-route-pricing";

const keyColumns = Object.freeze({
  id: builtInModelKeys.id,
  vendor: builtInModelKeys.vendor,
  apiKey: builtInModelKeys.apiKey,
});
const pricingColumns = Object.freeze({
  kind: usagePricing.kind,
  provider: usagePricing.provider,
  category: usagePricing.category,
});
const modelColumns = Object.freeze({
  model: runModelCatalog.model,
  displayName: runModelCatalog.displayName,
  sortOrder: runModelCatalog.sortOrder,
  replacedBy: runModelCatalog.replacedBy,
  builtInOnRestrictedPlans: runModelCatalog.builtInOnRestrictedPlans,
  piRouteClass: runModelCatalog.piRouteClass,
});
const routeColumns = Object.freeze({
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
});
const seedSkillColumns = Object.freeze({
  url: skillCatalog.url,
  contentBundle: skillCatalog.contentBundle,
});

/** Raw row groups are decoded by their consuming model/Skill nodes. */
export const globalModelCaptureSchema = object({
  keys: zUnknown(),
  pricing: zUnknown(),
  models: zUnknown(),
  routes: zUnknown(),
  seedSkills: zUnknown(),
});
type GlobalModelCapture = zInfer<typeof globalModelCaptureSchema>;

type GlobalModelRequest =
  | { readonly kind: "admission" }
  | {
      readonly kind: "claim";
      readonly modelKeyId: string | null;
      readonly hasModel: boolean;
      readonly hasAgent: boolean;
    };

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

function globalModelKeyCondition(request: GlobalModelRequest) {
  if (request.kind === "admission") {
    return undefined;
  }
  return request.modelKeyId === null
    ? sql`false`
    : eq(builtInModelKeys.id, request.modelKeyId);
}

/** Scalar groups can share their request owner's query without multiplying rows. */
export function globalModelContextRead(request: GlobalModelRequest) {
  const builder = new QueryBuilder();
  const keyRows = builder
    .select({
      payload: contextJsonProjection(keyColumns)
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(builtInModelKeys)
    .where(globalModelKeyCondition(request));
  const prices = builder
    .select({
      payload: contextJsonProjection(pricingColumns)
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(usagePricing);
  const modelRows = builder
    .select({
      payload: contextJsonProjection(modelColumns)
        .mapWith(zodDriverValueDecoder(zUnknown()))
        .as("payload"),
    })
    .from(runModelCatalog)
    .orderBy(asc(runModelCatalog.sortOrder), asc(runModelCatalog.model));
  const routeRows = builder
    .select({
      payload: contextJsonProjection(routeColumns)
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
  const needsCatalog = request.kind === "admission" || request.hasModel;
  return sql`jsonb_build_object(
    'keys', ${contextJsonRows(keyRows)},
    'pricing', ${request.kind === "admission" ? contextJsonRows(prices) : sql`'[]'::jsonb`},
    'models', ${needsCatalog ? contextJsonRows(modelRows) : sql`'[]'::jsonb`},
    'routes', ${needsCatalog ? contextJsonRows(routeRows) : sql`'[]'::jsonb`},
    'seedSkills', ${request.kind === "claim" && request.hasAgent ? contextJsonRows(seedSkillRows(builder)) : sql`'[]'::jsonb`}
  )`.mapWith(zodDriverValueDecoder(globalModelCaptureSchema));
}

/** Admission owns its global read; Claim supplies its shared source capture. */
export function createGlobalModelCapture(
  request$: Computed<Promise<GlobalModelRequest>>,
) {
  return computed(async (get) => {
    const request = await get(request$);
    const [row] = await get(db$)
      .select({ context: globalModelContextRead(request) })
      .from(sql`(values (1)) as context_seed(value)`);
    if (!row) {
      throw new Error("Global model context query returned no row");
    }
    return row.context;
  });
}

/** Decode the facts captured by the owning admission or Claim statement. */
export function createGlobalModelContext(
  capture$: Computed<Promise<GlobalModelCapture>>,
) {
  const managedModelKeys$ = computed(async (get) => {
    return array(contextProjectionSchema(keyColumns)).parse(
      (await get(capture$)).keys,
    );
  });
  const modelPricing$ = computed(async (get) => {
    return usagePricingByKey(
      array(contextProjectionSchema(pricingColumns)).parse(
        (await get(capture$)).pricing,
      ),
    );
  });
  const catalog$ = computed(async (get) => {
    const row = await get(capture$);
    return validateModelCatalog(
      array(contextProjectionSchema(modelColumns)).parse(row.models),
      array(contextProjectionSchema(routeColumns)).parse(row.routes),
    );
  });
  // Decoding never checks preparation; the consuming run validates its skills.
  const seedSkills$ = computed(async (get) => {
    return array(contextProjectionSchema(seedSkillColumns)).parse(
      (await get(capture$)).seedSkills,
    );
  });
  return { managedModelKeys$, modelPricing$, catalog$, seedSkills$ };
}
