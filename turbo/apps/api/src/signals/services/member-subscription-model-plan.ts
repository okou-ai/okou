import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { reasoningEffortSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { MemberModelRouteContext } from "./effective-model-route.service";
import type { MemberSubscriptionModel } from "./member-subscription-models.service";

type Subscriptions = MemberModelRouteContext["subscriptions"];
type CatalogRow = Pick<
  typeof modelRoutes.$inferSelect,
  | "id"
  | "model"
  | "subscriptionType"
  | "efforts"
  | "serviceTiers"
  | "createdAt"
  | "updatedAt"
> &
  Pick<typeof runModelCatalog.$inferSelect, "displayName">;

/** A connection-free plan; the computed/command owns SELECT and decoding. */
export function memberSubscriptionModelsQuery(subscriptions: Subscriptions) {
  return new QueryBuilder()
    .select({
      id: modelRoutes.id,
      model: modelRoutes.model,
      subscriptionType: modelRoutes.subscriptionType,
      displayName: runModelCatalog.displayName,
      efforts: modelRoutes.efforts,
      serviceTiers: modelRoutes.serviceTiers,
      createdAt: modelRoutes.createdAt,
      updatedAt: modelRoutes.updatedAt,
      sortOrder: runModelCatalog.sortOrder,
    })
    .from(modelRoutes)
    .innerJoin(runModelCatalog, eq(modelRoutes.model, runModelCatalog.model))
    .where(
      and(
        eq(modelRoutes.enabled, true),
        isNull(runModelCatalog.replacedBy),
        inArray(
          modelRoutes.subscriptionType,
          subscriptions.map((subscription) => {
            return subscription.type;
          }),
        ),
      ),
    )
    .orderBy(asc(runModelCatalog.sortOrder), asc(modelRoutes.model))
    .as("member_subscription_models");
}

export function memberSubscriptionModelsFromRows(
  rows: readonly CatalogRow[],
  subscriptions: Subscriptions,
): readonly MemberSubscriptionModel[] {
  return rows.flatMap((row) => {
    const subscription = subscriptions.find((candidate) => {
      return candidate.type === row.subscriptionType;
    });
    if (!subscription) {
      return [];
    }
    const serviceTier = row.serviceTiers.includes("priority")
      ? "priority"
      : null;
    if (
      row.efforts.some((effort) => {
        return !reasoningEffortSchema.safeParse(effort).success;
      }) ||
      (serviceTier === "priority" && subscription.type !== "codex-oauth-token")
    ) {
      throw new Error(
        `Invalid subscription model catalog row ${row.subscriptionType}/${row.model}`,
      );
    }
    return [
      {
        id: row.id,
        model: row.model,
        displayName: row.displayName,
        efforts: row.efforts.map((effort) => {
          return reasoningEffortSchema.parse(effort);
        }),
        serviceTier,
        providerType: subscription.type,
        providerId: subscription.providerId,
        needsReconnect: subscription.needsReconnect,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    ];
  });
}
