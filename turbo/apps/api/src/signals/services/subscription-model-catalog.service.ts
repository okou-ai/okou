import { asc, eq, inArray } from "drizzle-orm";
import {
  getRunModelAccess,
  isCodexFastModeModel,
  isModelSupportedByProvider,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { subscriptionModelCatalog } from "@okouai/db/schema/subscription-model-catalog";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  getModelReasoningEfforts,
  reasoningEffortSchema,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { Db } from "../external/db";
import {
  loadMemberModelRouteContext,
  type MemberModelRouteContext,
  type PreparedMemberModelRouteContext,
} from "./effective-model-route.service";

export type MemberSubscriptionModel = Readonly<{
  id: string;
  model: SupportedRunModel;
  displayName: string;
  efforts: readonly ReasoningEffort[];
  serviceTier: string | null;
  providerType: "claude-code-oauth-token" | "codex-oauth-token";
  providerId: string | null;
  needsReconnect: boolean;
  createdAt: Date;
  updatedAt: Date;
}>;

/** Membership-scoped catalog: no connected account, no subscription models. */
export async function loadMemberSubscriptionModels(
  db: Db,
  member: MemberModelRouteContext | PreparedMemberModelRouteContext,
): Promise<readonly MemberSubscriptionModel[]> {
  const subscriptions =
    "personalMetadata" in member
      ? member.personalMetadata.kind === "not-applicable"
        ? []
        : (await member.personalMetadata.load()).subscriptions
      : member.subscriptions;
  if (subscriptions.length === 0) {
    return [];
  }
  const rows = await db
    .select()
    .from(subscriptionModelCatalog)
    .where(
      inArray(
        subscriptionModelCatalog.subscriptionType,
        subscriptions.map((subscription) => {
          return subscription.type;
        }),
      ),
    )
    .orderBy(
      asc(subscriptionModelCatalog.sortOrder),
      asc(subscriptionModelCatalog.model),
    );
  return rows.flatMap((row) => {
    const subscription = subscriptions.find((candidate) => {
      return candidate.type === row.subscriptionType;
    });
    // Retired catalog models are a reachable state; they simply stop listing.
    if (
      !subscription ||
      !isSupportedRunModel(row.model) ||
      getRunModelAccess(row.model) !== "allowed"
    ) {
      return [];
    }
    if (
      !isModelSupportedByProvider(row.model, subscription.type) ||
      row.efforts.some((effort) => {
        return (
          !reasoningEffortSchema.safeParse(effort).success ||
          !getModelReasoningEfforts(row.model).includes(
            effort as ReasoningEffort,
          )
        );
      }) ||
      (row.serviceTier === "priority" &&
        (subscription.type !== "codex-oauth-token" ||
          !isCodexFastModeModel(row.model)))
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
        serviceTier: row.serviceTier,
        providerType: subscription.type,
        providerId: subscription.providerId,
        needsReconnect: subscription.needsReconnect,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    ];
  });
}

/** Only an Auto member's connected, catalog-listed subscription is plan-exempt. */
export async function isAutoPersonalSubscriptionRoute(args: {
  db: Db;
  orgId: string;
  userId: string;
  model: string | null | undefined;
  providerType: string | null | undefined;
}): Promise<boolean> {
  if (
    !args.model ||
    (args.providerType !== "claude-code-oauth-token" &&
      args.providerType !== "codex-oauth-token")
  ) {
    return false;
  }
  const [org] = await args.db
    .select({ mode: orgMetadata.modelMode })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  if (org?.mode !== "auto") {
    return false;
  }
  const member = await loadMemberModelRouteContext(
    args.db,
    args.orgId,
    args.userId,
  );
  const models = await loadMemberSubscriptionModels(args.db, member);
  return models.some((entry) => {
    return (
      entry.model === args.model && entry.providerType === args.providerType
    );
  });
}
