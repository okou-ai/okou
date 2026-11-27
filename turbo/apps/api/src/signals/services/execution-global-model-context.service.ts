import { computed } from "ccstate";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  AUTO_RUN_PRICING_PROVIDER,
  AUTO_SELECTED_MODEL,
} from "@okouai/core/auto-run-model";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { usagePricing } from "@okouai/db/runtime/usage-pricing";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { modelRoutes } from "@okouai/db/schema/model-route";
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

function selectAutoPricingProvider(builder: QueryBuilder) {
  return builder
    .select({ provider: modelRoutes.upstreamModel })
    .from(modelRoutes)
    .where(
      and(
        eq(modelRoutes.model, AUTO_SELECTED_MODEL),
        eq(modelRoutes.providerType, "built-in"),
        eq(modelRoutes.enabled, true),
      ),
    );
}

/** Read execution-wide configuration and the model catalog in one snapshot. */
export function createGlobalModelContext() {
  const keys = {
    id: builtInModelKeys.id,
    vendor: builtInModelKeys.vendor,
  };
  const pricing = {
    kind: usagePricing.kind,
    provider: usagePricing.provider,
    category: usagePricing.category,
  };
  const models = {
    model: runModelCatalog.model,
    displayName: runModelCatalog.displayName,
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
    // Auto bills the preset in this snapshot. Legacy Auto keeps its old key.
    const prices = builder
      .select({
        payload: contextJsonProjection(pricing)
          .mapWith(zodDriverValueDecoder(zUnknown()))
          .as("payload"),
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          or(
            inArray(usagePricing.provider, selectAutoPricingProvider(builder)),
            eq(usagePricing.provider, AUTO_RUN_PRICING_PROVIDER),
          ),
        ),
      );
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
    const [row] = await get(db$)
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
      })
      .from(sql`(values (1)) as context_seed(value)`);
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
  return { managedModelKeys$, modelPricing$, catalog$ };
}
