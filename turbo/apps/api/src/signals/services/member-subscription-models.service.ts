import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { modelRoutes } from "@okouai/db/schema/model-route";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import type { ModelCatalog } from "./model-catalog.service";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { nowDate } from "../../lib/time";
import {
  reasoningEffortSchema,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { Db, ReadonlyDb } from "../external/db";
import {
  isMemberSubscriptionRoute,
  loadMemberModelRouteContext,
  type MemberModelRouteContext,
  type PreparedMemberModelRouteContext,
} from "./effective-model-route.service";
export type MemberSubscriptionModel = Readonly<{
  id: string;
  model: string;
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
  db: Pick<Db, "select">,
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
  // Personal subscription routes live in the global catalog; replaced
  // models have no routes, and names and ordering come from the model row.
  const rows = await db
    .select({
      id: modelRoutes.id,
      model: modelRoutes.model,
      subscriptionType: modelRoutes.subscriptionType,
      displayName: runModelCatalog.displayName,
      efforts: modelRoutes.efforts,
      serviceTiers: modelRoutes.serviceTiers,
      createdAt: modelRoutes.createdAt,
      updatedAt: modelRoutes.updatedAt,
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
    .orderBy(asc(runModelCatalog.sortOrder), asc(modelRoutes.model));
  return rows.flatMap((row) => {
    const subscription = subscriptions.find((candidate) => {
      return candidate.type === row.subscriptionType;
    });
    // Retired catalog models are a reachable state; they simply stop listing.
    if (!subscription) {
      return [];
    }
    const serviceTier = row.serviceTiers.includes("priority")
      ? "priority"
      : null;
    // The route row is the product authority for efforts and tiers; only
    // protocol facts are checked: the effort vocabulary, and Fast
    // (`priority`) exists only on the Codex protocol.
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

/**
 * Admission read of `isMemberSubscriptionRoute` from current connection facts:
 * in Auto and Custom mode alike, only the member's own valid subscription on
 * the model's catalog subscription route is plan-exempt.
 */
export async function isPersonalSubscriptionRoute(args: {
  db: ReadonlyDb;
  catalog: ModelCatalog;
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
  return isMemberSubscriptionRoute({
    catalog: args.catalog,
    member: await loadMemberModelRouteContext(args.db, args.orgId, args.userId),
    model: args.model,
    providerType: args.providerType,
    credentialScope: "member",
  });
}

/**
 * A disconnected subscription stops backing an Auto member's selection. Return
 * that member to the system default when no policy or remaining subscription
 * still offers the saved model.
 */
export async function resetStaleAutoMemberSelection(
  catalogSnapshot: ModelCatalog,
  db: Db,
  orgId: string,
  userId: string,
): Promise<void> {
  const [[org], [member], policies] = await Promise.all([
    db
      .select({ mode: orgMetadata.modelMode })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1),
    db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1),
    db
      .select({ model: orgModelPolicies.model })
      .from(orgModelPolicies)
      .where(eq(orgModelPolicies.orgId, orgId)),
  ]);
  const selectedModel = member?.selectedModel;
  if (
    org?.mode !== "auto" ||
    !selectedModel ||
    policies.some((policy) => {
      return policy.model === selectedModel;
    })
  ) {
    return;
  }
  const remaining = await loadMemberSubscriptionModels(
    db,
    await loadMemberModelRouteContext(db, orgId, userId),
  );
  if (
    remaining.some((entry) => {
      return entry.model === selectedModel;
    })
  ) {
    return;
  }
  await db
    .update(orgMembersMetadata)
    .set({
      selectedModel: await catalogSnapshot.systemDefaultModel,
      serviceTier: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
        eq(orgMembersMetadata.selectedModel, selectedModel),
      ),
    );
}
