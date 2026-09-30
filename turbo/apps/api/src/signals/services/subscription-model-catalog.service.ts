import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { command } from "ccstate";
import {
  getRunModelAccess,
  isCodexFastModeModel,
  isModelSupportedByProvider,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { subscriptionModelCatalog } from "@okouai/db/schema/subscription-model-catalog";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { nowDate } from "../../lib/time";
import {
  getModelReasoningEfforts,
  reasoningEffortSchema,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { writeDb$, type Db } from "../external/db";
import {
  loadModelRouteSources$,
  type MemberModelRouteContext,
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

type SubscriptionCatalogRow = typeof subscriptionModelCatalog.$inferSelect;

function projectMemberSubscriptionModels(
  rows: readonly SubscriptionCatalogRow[],
  subscriptions: MemberModelRouteContext["subscriptions"],
): readonly MemberSubscriptionModel[] {
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

/** Membership-scoped catalog: no connected account, no subscription models. */
export const loadMemberSubscriptionModels$ = command(
  async (
    { set },
    member: MemberModelRouteContext,
    signal?: AbortSignal,
  ): Promise<readonly MemberSubscriptionModel[]> => {
    const subscriptions = member.subscriptions;
    if (subscriptions.length === 0) {
      return [];
    }
    const rows = await set(writeDb$)
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
    signal?.throwIfAborted();
    return projectMemberSubscriptionModels(rows, subscriptions);
  },
);

interface AutoPersonalSubscriptionRouteArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly model: string | null | undefined;
  readonly providerType: string | null | undefined;
}

/**
 * Pure SQL condition over the catalog: the org is in Auto and the member has a
 * connected account for the subscription type that lists this model.
 */
function autoPersonalSubscriptionRouteCondition(
  args: AutoPersonalSubscriptionRouteArgs & {
    readonly model: string;
    readonly providerType: "claude-code-oauth-token" | "codex-oauth-token";
  },
) {
  return and(
    eq(subscriptionModelCatalog.subscriptionType, args.providerType),
    eq(subscriptionModelCatalog.model, args.model),
    sql`EXISTS (SELECT 1 FROM ${orgMetadata}
      WHERE ${orgMetadata.orgId} = ${args.orgId} AND ${orgMetadata.modelMode} = 'auto')`,
    sql`EXISTS (SELECT 1 FROM ${modelProviderAccounts}
      WHERE ${and(
        eq(modelProviderAccounts.orgId, args.orgId),
        eq(modelProviderAccounts.userId, args.userId),
        eq(modelProviderAccounts.type, args.providerType),
        isNull(modelProviderAccounts.disconnectedAt),
      )})`,
  );
}

function autoPersonalSubscriptionRouteQuery(
  args: AutoPersonalSubscriptionRouteArgs,
) {
  if (
    !args.model ||
    (args.providerType !== "claude-code-oauth-token" &&
      args.providerType !== "codex-oauth-token")
  ) {
    return null;
  }
  const providerType = args.providerType;
  return {
    condition: autoPersonalSubscriptionRouteCondition({
      ...args,
      model: args.model,
      providerType,
    }),
    matches: (rows: readonly SubscriptionCatalogRow[]) => {
      return projectMemberSubscriptionModels(rows, [
        { type: providerType, providerId: null, needsReconnect: false },
      ]).some((entry) => {
        return entry.model === args.model;
      });
    },
  };
}

/** Only an Auto member's connected, catalog-listed subscription is plan-exempt. */
export async function isAutoPersonalSubscriptionRoute(
  args: AutoPersonalSubscriptionRouteArgs & { readonly db: Db },
): Promise<boolean> {
  const query = autoPersonalSubscriptionRouteQuery(args);
  if (!query) {
    return false;
  }
  const rows = await args.db
    .select()
    .from(subscriptionModelCatalog)
    .where(query.condition)
    .limit(1);
  return query.matches(rows);
}

/** Only an Auto member's connected, catalog-listed subscription is plan-exempt. */
export const isAutoPersonalSubscriptionRoute$ = command(
  async (
    { set },
    args: AutoPersonalSubscriptionRouteArgs,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const query = autoPersonalSubscriptionRouteQuery(args);
    if (!query) {
      return false;
    }
    const rows = await set(writeDb$)
      .select()
      .from(subscriptionModelCatalog)
      .where(query.condition)
      .limit(1);
    signal?.throwIfAborted();
    return query.matches(rows);
  },
);

/**
 * A disconnected subscription stops backing an Auto member's selection. Return
 * that member to the org default when no policy or remaining subscription
 * still offers the saved model.
 */
export const resetStaleAutoMemberSelection$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
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
        .select({
          model: orgModelPolicies.model,
          isDefault: orgModelPolicies.isDefault,
        })
        .from(orgModelPolicies)
        .where(eq(orgModelPolicies.orgId, orgId)),
    ]);
    signal.throwIfAborted();
    const selectedModel = member?.selectedModel;
    const defaultPolicy = policies.find((policy) => {
      return policy.isDefault;
    });
    if (
      org?.mode !== "auto" ||
      !selectedModel ||
      !defaultPolicy ||
      policies.some((policy) => {
        return policy.model === selectedModel;
      })
    ) {
      return;
    }
    const sources = await set(
      loadModelRouteSources$,
      orgId,
      userId,
      [selectedModel],
      signal,
    );
    const remaining = await set(
      loadMemberSubscriptionModels$,
      sources.member,
      signal,
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
        selectedModel: defaultPolicy.model,
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
    signal.throwIfAborted();
  },
);
