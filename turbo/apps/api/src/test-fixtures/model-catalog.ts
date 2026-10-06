import { createStore } from "ccstate";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import {
  isPiRouteClass,
  type PiRouteClass,
} from "@okouai/api-contracts/contracts/model-catalog";

import { db } from "../lib/db";
import {
  catalogBuiltInCandidates,
  modelCatalog$,
} from "../signals/services/model-catalog.service";

/**
 * Operators switch the system default directly in the database. Clear the old
 * default before setting the new one, as the partial unique index requires.
 */
export async function setModelCatalogSystemDefaultFixture(
  model: string,
): Promise<() => Promise<void>> {
  const [previous] = await db()
    .select({ model: runModelCatalog.model })
    .from(runModelCatalog)
    .where(eq(runModelCatalog.isSystemDefault, true));
  const swap = async (from: string | undefined, to: string) => {
    await db().transaction(async (tx) => {
      if (from) {
        await tx
          .update(runModelCatalog)
          .set({ isSystemDefault: false })
          .where(eq(runModelCatalog.model, from));
      }
      await tx
        .update(runModelCatalog)
        .set({ isSystemDefault: true })
        .where(eq(runModelCatalog.model, to));
    });
  };
  await swap(previous?.model, model);
  return async () => {
    if (previous) {
      await swap(model, previous.model);
    }
  };
}

/** One retired row of a temporary replacement chain. */
export interface RetiredCatalogRowFixture {
  readonly model: string;
  readonly displayName: string;
  readonly sortOrder: number;
  readonly lineageRank: number;
  readonly replacedBy: string;
}

/**
 * Operators insert retired catalog rows directly in the database. Rows are
 * inserted in the given order, so each row's target must already exist; the
 * returned restore deletes them in reverse order, referrers first.
 */
export async function insertRetiredCatalogRowsFixture(
  rows: readonly RetiredCatalogRowFixture[],
): Promise<() => Promise<void>> {
  // One transaction: a failed insert leaves no partial chain behind.
  await db().transaction(async (tx) => {
    for (const row of rows) {
      const [target] = await tx
        .select({ lineageRank: runModelCatalog.lineageRank })
        .from(runModelCatalog)
        .where(eq(runModelCatalog.model, row.replacedBy));
      if (!target) {
        throw new Error(`Expected catalog model ${row.replacedBy}`);
      }
      await tx.insert(runModelCatalog).values({
        model: row.model,
        displayName: row.displayName,
        sortOrder: row.sortOrder,
        lineageRank: row.lineageRank,
        replacedBy: row.replacedBy,
        replacedByLineageRank: target.lineageRank,
      });
    }
  });
  return async () => {
    for (const row of [...rows].reverse()) {
      await db()
        .delete(runModelCatalog)
        .where(eq(runModelCatalog.model, row.model));
    }
  };
}

/**
 * A thread selection of a retired model cannot be written through the API: the
 * API resolves every new selection to the final active model. It exists only
 * as legacy stored data, so this fixture stages it directly on the thread row
 * (the documented exception for states impossible to construct through the
 * API).
 */
export async function stageLegacyChatThreadSelectedModelFixture(args: {
  readonly threadId: string;
  readonly model: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({ selectedModel: args.model })
    .where(eq(chatThreads.id, args.threadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat thread selection to be staged");
  }
}

/** One Built-in candidate route of a fixture catalog model. */
export interface BuiltInRouteFixture {
  readonly concreteProviderType:
    | "anthropic-api-key"
    | "openrouter-api-key"
    | "deepseek"
    | "openrouter-codex"
    | "openai-api-key";
  readonly upstreamModel: string;
  readonly priority: number;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
  readonly serviceTiers?: readonly ("priority" | "ultrafast")[];
  /**
   * `usage_pricing` provider of the route's pricing link. Defaults to the
   * model ID, which the fixture prices for every category the route can
   * bill; a test naming its own provider owns that provider's pricing.
   */
  readonly pricingProvider?: string;
  /**
   * The route's long-context pricing threshold
   * (`long_context_min_total_input_tokens`); omitted: single tier.
   */
  readonly longContextMinTotalInputTokens?: number;
}

const FIXTURE_MODEL_PRICING_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
].flatMap((category) => {
  return [category, `${category}.long_context`].flatMap((base) => {
    return [base, `${base}.fast`, `${base}.ultrafast`];
  });
});

/**
 * Operators launch a model on an already supported protocol purely by
 * inserting catalog and route rows. Both inserts share one transaction; the
 * restore deletes the routes before the catalog row.
 */
export async function insertCatalogModelFixture(args: {
  readonly model: string;
  readonly displayName: string;
  readonly sortOrder: number;
  readonly piRouteClass?: PiRouteClass;
  readonly builtInRoutes: readonly BuiltInRouteFixture[];
}): Promise<() => Promise<void>> {
  await db().transaction(async (tx) => {
    await tx.insert(runModelCatalog).values({
      model: args.model,
      displayName: args.displayName,
      sortOrder: args.sortOrder,
      lineageRank: 0,
      piRouteClass: args.piRouteClass ?? null,
    });
    await tx.insert(modelRoutes).values(
      args.builtInRoutes.map((route) => {
        return {
          model: args.model,
          providerType: "built-in",
          concreteProviderType: route.concreteProviderType,
          upstreamModel: route.upstreamModel,
          priority: route.priority,
          serviceTiers: [...(route.serviceTiers ?? [])],
          efforts: [...route.efforts],
          defaultEffort: route.defaultEffort,
          priceTier: "$",
          pricingKind: "model",
          pricingProvider: route.pricingProvider ?? args.model,
          longContextMinTotalInputTokens:
            route.longContextMinTotalInputTokens ?? null,
        };
      }),
    );
    // Launching a model includes pricing its default (model ID) link.
    if (
      args.builtInRoutes.some((route) => {
        return route.pricingProvider === undefined;
      })
    ) {
      await tx.insert(usagePricing).values(
        FIXTURE_MODEL_PRICING_CATEGORIES.map((category) => {
          return {
            kind: "model",
            provider: args.model,
            category,
            unitPrice: 1,
            unitSize: 1_000_000,
          };
        }),
      );
    }
  });
  return async () => {
    await db().transaction(async (tx) => {
      await tx
        .delete(usagePricing)
        .where(
          and(
            eq(usagePricing.kind, "model"),
            eq(usagePricing.provider, args.model),
          ),
        );
      await tx.delete(modelRoutes).where(eq(modelRoutes.model, args.model));
      await tx
        .delete(runModelCatalog)
        .where(eq(runModelCatalog.model, args.model));
    });
  };
}

const MIRRORED_ROUTE_PROVIDER_TYPES: readonly string[] = [
  "anthropic-api-key",
  "openrouter-api-key",
  "deepseek",
  "openrouter-codex",
  "openai-api-key",
] satisfies readonly BuiltInRouteFixture["concreteProviderType"][];

function isMirroredRouteProviderType(
  value: string,
): value is BuiltInRouteFixture["concreteProviderType"] {
  return MIRRORED_ROUTE_PROVIDER_TYPES.includes(value);
}

/**
 * Operators launch a test-owned model whose Built-in candidates, Pi route class
 * and pricing links mirror an existing model. Route availability state such as
 * candidate cooldowns is keyed by the selected model, so a test can make this
 * model's candidates unavailable without touching shared models used by
 * concurrent tests. The mirrored routes keep the base model's pricing links.
 */
export async function insertBuiltInModelMirrorFixture(
  baseModel: string,
): Promise<{
  readonly model: string;
  readonly restore: () => Promise<void>;
}> {
  const catalog = await createStore().get(modelCatalog$);
  const base = catalog.byModel.get(baseModel);
  if (!base) {
    throw new Error(`Expected catalog model ${baseModel}`);
  }
  const builtInRoutes = catalogBuiltInCandidates(catalog, baseModel).map(
    (route) => {
      if (!isMirroredRouteProviderType(route.concreteProviderType)) {
        throw new Error(
          `Unsupported mirrored Built-in route ${route.concreteProviderType}`,
        );
      }
      if (route.pricingProvider === null) {
        throw new Error(`Expected a pricing link on ${baseModel} routes`);
      }
      return {
        concreteProviderType: route.concreteProviderType,
        upstreamModel: route.upstreamModel,
        priority: route.priority,
        efforts: route.efforts,
        defaultEffort: route.defaultEffort,
        serviceTiers: route.serviceTiers.filter((tier) => {
          return tier === "priority" || tier === "ultrafast";
        }),
        pricingProvider: route.pricingProvider,
        ...(route.longContextMinTotalInputTokens === null
          ? {}
          : {
              longContextMinTotalInputTokens:
                route.longContextMinTotalInputTokens,
            }),
      };
    },
  );
  if (builtInRoutes.length === 0) {
    throw new Error(`Expected Built-in routes for ${baseModel}`);
  }
  const model = `${baseModel}-mirror-${randomUUID().slice(0, 8)}`;
  const restore = await insertCatalogModelFixture({
    model,
    displayName: `${base.displayName} mirror`,
    sortOrder: base.sortOrder,
    ...(isPiRouteClass(base.piRouteClass)
      ? { piRouteClass: base.piRouteClass }
      : {}),
    builtInRoutes,
  });
  return { model, restore };
}

/** Operators reorder or disable a Built-in candidate directly in the database. */

/** Operators relink a Built-in route's pricing directly in the database. */

/**
 * Operators set a Built-in route's long-context pricing threshold directly in
 * the database. The returned restore puts the previous threshold back.
 */
export async function setBuiltInRouteLongContextThresholdFixture(args: {
  readonly model: string;
  readonly concreteProviderType: string;
  readonly longContextMinTotalInputTokens: number | null;
}): Promise<() => Promise<void>> {
  const where = and(
    eq(modelRoutes.model, args.model),
    eq(modelRoutes.providerType, "built-in"),
    eq(modelRoutes.concreteProviderType, args.concreteProviderType),
  );
  const [previous] = await db()
    .select({ threshold: modelRoutes.longContextMinTotalInputTokens })
    .from(modelRoutes)
    .where(where);
  if (!previous) {
    throw new Error("Expected one Built-in route to set a threshold on");
  }
  await db()
    .update(modelRoutes)
    .set({
      longContextMinTotalInputTokens: args.longContextMinTotalInputTokens,
    })
    .where(where);
  return async () => {
    await db()
      .update(modelRoutes)
      .set({ longContextMinTotalInputTokens: previous.threshold })
      .where(where);
  };
}

/** The model's Pi admission projection from the current database catalog. */

/**
 * Operators set a model's Pi route class directly in the database. The
 * returned restore puts the previous class back.
 */
export async function setModelPiRouteClassFixture(
  model: string,
  piRouteClass: PiRouteClass | null,
): Promise<() => Promise<void>> {
  const [previous] = await db()
    .select({ piRouteClass: runModelCatalog.piRouteClass })
    .from(runModelCatalog)
    .where(eq(runModelCatalog.model, model));
  if (!previous) {
    throw new Error(`Expected catalog model ${model}`);
  }
  await db()
    .update(runModelCatalog)
    .set({ piRouteClass })
    .where(eq(runModelCatalog.model, model));
  return async () => {
    await db()
      .update(runModelCatalog)
      .set({ piRouteClass: previous.piRouteClass })
      .where(eq(runModelCatalog.model, model));
  };
}
