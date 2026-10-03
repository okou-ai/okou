import { computed } from "ccstate";
import { asc, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { z } from "zod";
import { db$ } from "../external/db";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
import { validateModelCatalog } from "./model-catalog.service";
import { usagePricingByKey } from "./built-in-route-pricing";

/** Two statement snapshots retain the catalog's pre-enqueue failure boundary. */
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
    isSystemDefault: runModelCatalog.isSystemDefault,
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
    priceTier: modelRoutes.priceTier,
    pricingKind: modelRoutes.pricingKind,
    pricingProvider: modelRoutes.pricingProvider,
    longContextMinTotalInputTokens: modelRoutes.longContextMinTotalInputTokens,
  };
  const builder = new QueryBuilder();
  const credentialsRaw$ = computed(async (get) => {
    const keyRows = builder
      .select({
        payload: contextJsonProjection(keys)
          .mapWith(zodDriverValueDecoder(z.unknown()))
          .as("payload"),
      })
      .from(builtInModelKeys);
    const prices = builder
      .select({
        payload: contextJsonProjection(pricing)
          .mapWith(zodDriverValueDecoder(z.unknown()))
          .as("payload"),
      })
      .from(usagePricing);
    const [row] = await get(db$)
      .select({
        keys: contextJsonRows(keyRows).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
        pricing: contextJsonRows(prices).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
      })
      .from(sql`(values (1)) as context_seed(value)`);
    if (!row) {
      throw new Error("Global model credentials query returned no row");
    }
    return row;
  });
  const catalogRaw$ = computed(async (get) => {
    const modelRows = builder
      .select({
        payload: contextJsonProjection(models)
          .mapWith(zodDriverValueDecoder(z.unknown()))
          .as("payload"),
      })
      .from(runModelCatalog)
      .orderBy(asc(runModelCatalog.sortOrder), asc(runModelCatalog.model));
    const routeRows = builder
      .select({
        payload: contextJsonProjection(routes)
          .mapWith(zodDriverValueDecoder(z.unknown()))
          .as("payload"),
      })
      .from(modelRoutes)
      .orderBy(
        asc(modelRoutes.model),
        asc(modelRoutes.providerType),
        sql`${modelRoutes.subscriptionType} asc nulls first`,
        asc(modelRoutes.priority),
      );
    const [row] = await get(db$)
      .select({
        models: contextJsonRows(modelRows).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
        routes: contextJsonRows(routeRows).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
      })
      .from(sql`(values (1)) as context_seed(value)`);
    if (!row) {
      throw new Error("Global model catalog query returned no row");
    }
    return row;
  });
  const managedModelKeys$ = computed(async (get) => {
    return z
      .array(contextProjectionSchema(keys))
      .parse((await get(credentialsRaw$)).keys);
  });
  const modelPricing$ = computed(async (get) => {
    return usagePricingByKey(
      z
        .array(contextProjectionSchema(pricing))
        .parse((await get(credentialsRaw$)).pricing),
    );
  });
  const catalog$ = computed(async (get) => {
    const row = await get(catalogRaw$);
    return validateModelCatalog(
      z.array(contextProjectionSchema(models)).parse(row.models),
      z.array(contextProjectionSchema(routes)).parse(row.routes),
    );
  });
  return { managedModelKeys$, modelPricing$, catalog$ };
}
