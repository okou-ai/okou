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
        keys: contextJsonRows(keyRows).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
        pricing: contextJsonRows(prices).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
        models: contextJsonRows(modelRows).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
        routes: contextJsonRows(routeRows).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
      })
      .from(sql`(values (1)) as context_seed(value)`);
    if (!row) {
      throw new Error("Global model context query returned no row");
    }
    return row;
  });
  const managedModelKeys$ = computed(async (get) => {
    return z
      .array(contextProjectionSchema(keys))
      .parse((await get(globalRaw$)).keys);
  });
  const modelPricing$ = computed(async (get) => {
    return usagePricingByKey(
      z
        .array(contextProjectionSchema(pricing))
        .parse((await get(globalRaw$)).pricing),
    );
  });
  const catalog$ = computed(async (get) => {
    const row = await get(globalRaw$);
    return validateModelCatalog(
      z.array(contextProjectionSchema(models)).parse(row.models),
      z.array(contextProjectionSchema(routes)).parse(row.routes),
    );
  });
  return { managedModelKeys$, modelPricing$, catalog$ };
}
