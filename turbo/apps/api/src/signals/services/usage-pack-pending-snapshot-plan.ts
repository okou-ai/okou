import {
  usagePackPendingSnapshotGuards,
  usagePackSubscriptions,
  usagePackAllocations,
} from "@okouai/db/schema/usage-pack-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  and,
  eq,
  inArray,
  or,
  desc,
  isNull,
  notExists,
  getTableColumns,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { int, object, string, uuid } from "zod";
import { retireMarketingMetadata } from "../../lib/marketing-metadata";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import {
  inFlightUsagePackPurchaseQuery,
  inFlightPlanPurchaseQuery,
  USAGE_PACK_PURCHASE_CLAIM_STATUS,
} from "./billing-purchase-claim.service";
import { tierForKnownPlanPrice } from "./billing-checkout.service";
import type {
  CreateUsagePackCheckoutSessionArgs,
  UsagePackContext,
  PreparedPendingUsagePackCheckout,
} from "./usage-pack-subscription.service";
import type {
  UsagePackPendingSnapshotOperation,
  UsagePackPendingSnapshotResult,
} from "./usage-pack-pending-snapshot.service";
import {
  usagePackSqlRows,
  usagePackSqlWrite,
  usagePackSqlClock,
  usagePackSqlAbortCheck,
  usagePackSqlSelection,
  usagePackSqlRow,
  usagePackSqlInsert,
  usagePackSqlUpdate,
  type UsagePackRetainedPlan,
} from "./usage-pack-retained-sql";
export class UsagePackPendingSnapshotConflict extends Error {}
function isPending(status: string): boolean {
  return status === "checkout_pending" || status === "purchase_pending";
}
interface SnapshotRow {
  readonly id: string;
  readonly orgId: string;
  readonly status: string;
}
function pendingRows(rows: readonly SnapshotRow[], orgId: string) {
  return rows.filter((row) => {
    return row.orgId === orgId && isPending(row.status);
  });
}
export function usagePackCheckoutAllocationsMatch(
  current: readonly (typeof usagePackAllocations.$inferSelect)[],
  requested: readonly CreateUsagePackCheckoutSessionArgs["allocations"][number][],
): boolean {
  return (
    current.length === requested.length &&
    requested.every((candidate) => {
      return current.some((allocation) => {
        const sameOwner =
          "userId" in candidate
            ? allocation.userId === candidate.userId &&
              allocation.invitationId === null
            : allocation.invitationId === candidate.invitationId &&
              allocation.userId === null;
        return (
          sameOwner &&
          allocation.status === "pending_payment" &&
          allocation.usagePackUsd === candidate.usagePackUsd &&
          allocation.stripePriceId === candidate.stripePriceId
        );
      });
    })
  );
}
export function usagePackCheckoutConfigurationMatches(
  args: CreateUsagePackCheckoutSessionArgs,
  customerId: string,
  context: UsagePackContext,
): boolean {
  return (
    context.subscription.tier === args.tier &&
    context.subscription.stripePlanPriceId === args.planPriceId &&
    context.subscription.stripeCustomerId === customerId &&
    usagePackCheckoutAllocationsMatch(context.allocations, args.allocations)
  );
}
function hasCheckoutSession(context: UsagePackContext): boolean {
  return context.subscription.stripeCheckoutSessionId !== null;
}
export function pendingUsagePackCheckoutFingerprint(
  contexts: readonly UsagePackContext[],
): string {
  return JSON.stringify(
    [...contexts]
      .map(({ subscription, allocations }) => {
        return {
          subscription,
          allocations: [...allocations].sort((left, right) => {
            return left.id.localeCompare(right.id);
          }),
        };
      })
      .sort((left, right) => {
        return left.subscription.id.localeCompare(right.subscription.id);
      }),
  );
}
const PENDING_STATUSES = ["checkout_pending", "purchase_pending"] as const;
function unchangedCheckoutWhere(
  subscription: UsagePackContext["subscription"],
) {
  return and(
    eq(usagePackSubscriptions.id, subscription.id),
    eq(usagePackSubscriptions.orgId, subscription.orgId),
    eq(
      usagePackSubscriptions.subscriptionStatus,
      subscription.subscriptionStatus,
    ),
    subscription.stripeCheckoutSessionId === null
      ? isNull(usagePackSubscriptions.stripeCheckoutSessionId)
      : eq(
          usagePackSubscriptions.stripeCheckoutSessionId,
          subscription.stripeCheckoutSessionId,
        ),
    subscription.stripeSubscriptionId === null
      ? isNull(usagePackSubscriptions.stripeSubscriptionId)
      : eq(
          usagePackSubscriptions.stripeSubscriptionId,
          subscription.stripeSubscriptionId,
        ),
    inArray(usagePackSubscriptions.subscriptionStatus, [...PENDING_STATUSES]),
  );
}
function* pendingCheckoutContextsPlan(
  orgId: string,
): UsagePackRetainedPlan<readonly UsagePackContext[]> {
  const columns = getTableColumns(usagePackSubscriptions);
  const children = getTableColumns(usagePackAllocations);
  const subscriptions = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(usagePackSqlSelection(columns))
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.orgId, orgId),
          inArray(usagePackSubscriptions.subscriptionStatus, [
            ...PENDING_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(usagePackSubscriptions.updatedAt))
      .getSQL(),
    usagePackSqlRow(columns),
  );
  const batches = yield {
    kind: "batch",
    statements: subscriptions.map((subscription) => {
      return new QueryBuilder()
        .select(usagePackSqlSelection(children))
        .from(usagePackAllocations)
        .where(
          eq(usagePackAllocations.usagePackSubscriptionId, subscription.id),
        )
        .getSQL();
    }),
  };
  const allocations = usagePackSqlRow(children).array().array().parse(batches);
  return subscriptions.map((subscription, index) => {
    const rows = allocations[index];
    if (!rows) {
      throw new Error("Missing pending checkout child result");
    }
    return { subscription, allocations: rows };
  });
}
function* retireCheckoutPlan(
  context: UsagePackContext,
): UsagePackRetainedPlan<void> {
  const at = yield* usagePackSqlClock();
  const [retired] = yield* usagePackSqlRows(
    usagePackSqlUpdate(
      usagePackSubscriptions,
      { subscriptionStatus: "checkout_expired", updatedAt: at },
      unchangedCheckoutWhere(context.subscription),
      { id: usagePackSubscriptions.id },
    ),
    usagePackSqlRow({ id: usagePackSubscriptions.id }),
  );
  if (!retired) {
    throw new UsagePackPendingSnapshotConflict(
      "Usage pack purchase changed during retirement",
    );
  }
  yield* usagePackSqlWrite(
    usagePackSqlUpdate(
      usagePackAllocations,
      { status: "inactive", updatedAt: at },
      eq(usagePackAllocations.usagePackSubscriptionId, context.subscription.id),
    ),
  );
}
function* preparePurchasePlan(
  operation: Extract<
    UsagePackPendingSnapshotOperation,
    { kind: "prepare-purchase" }
  >,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  const args = operation.purchase;
  const customerId = operation.customerId;
  const prepared = operation.prepared;
  yield* usagePackSqlAbortCheck();
  const [claimed] = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(usagePackSqlSelection({ id: usagePackSubscriptions.id }))
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.orgId, args.orgId),
          eq(
            usagePackSubscriptions.subscriptionStatus,
            USAGE_PACK_PURCHASE_CLAIM_STATUS,
          ),
          isNull(usagePackSubscriptions.stripeCheckoutSessionId),
          isNull(usagePackSubscriptions.stripeSubscriptionId),
        ),
      )
      .limit(1)
      .getSQL(),
    usagePackSqlRow({ id: usagePackSubscriptions.id }),
  );
  if (claimed) {
    return {
      kind: "prepare-purchase",
      value: { kind: "conflict" },
    };
  }
  const current = yield* pendingCheckoutContextsPlan(args.orgId);
  if (
    pendingUsagePackCheckoutFingerprint(current.filter(hasCheckoutSession)) !==
    prepared.fingerprint
  ) {
    return {
      kind: "prepare-purchase",
      value: { kind: "conflict" },
    };
  }
  const snapshots = current.filter((context) => {
    return !hasCheckoutSession(context);
  });
  const { retained } = prepared;
  for (const entry of prepared.resolved) {
    if (entry !== retained) {
      yield* retireCheckoutPlan(entry.context);
    }
  }
  if (retained) {
    for (const snapshot of snapshots) {
      yield* retireCheckoutPlan(snapshot);
    }
    const url = retainedCheckoutRedirect(args, retained.session);
    return {
      kind: "prepare-purchase",
      value: { kind: "redirect", url },
    };
  }
  const matchingSnapshot = snapshots.find((context) => {
    return (
      context.subscription.subscriptionStatus === "purchase_pending" &&
      usagePackCheckoutConfigurationMatches(args, customerId, context)
    );
  });
  for (const snapshot of snapshots) {
    if (snapshot !== matchingSnapshot) {
      yield* retireCheckoutPlan(snapshot);
    }
  }
  let usagePackSubscriptionId: string;
  if (matchingSnapshot) {
    usagePackSubscriptionId = matchingSnapshot.subscription.id;
  } else {
    const [subscription] = yield* usagePackSqlRows(
      usagePackSqlInsert(
        usagePackSubscriptions,
        {
          orgId: args.orgId,
          tier: args.tier,
          stripePlanPriceId: args.planPriceId,
          stripeCustomerId: customerId,
          subscriptionStatus: "purchase_pending",
        },
        { returning: { id: usagePackSubscriptions.id } },
      ),
      usagePackSqlRow({ id: usagePackSubscriptions.id }),
    );
    if (!subscription) {
      throw new Error("Failed to create usage pack subscription snapshot");
    }
    if (args.allocations.length > 0) {
      yield* usagePackSqlWrite(
        usagePackSqlInsert(
          usagePackAllocations,
          args.allocations.map((allocation) => {
            return {
              usagePackSubscriptionId: subscription.id,
              orgId: args.orgId,
              usagePackUsd: allocation.usagePackUsd,
              stripePriceId: allocation.stripePriceId,
              ...("userId" in allocation
                ? { userId: allocation.userId }
                : { invitationId: allocation.invitationId }),
            };
          }),
          {},
        ),
      );
    }
    usagePackSubscriptionId = subscription.id;
  }
  yield* usagePackSqlAbortCheck();
  return {
    kind: "prepare-purchase",
    value: { kind: "snapshot", usagePackSubscriptionId },
  };
}
function* correlateClaimPlan(
  operation: Extract<
    UsagePackPendingSnapshotOperation,
    { kind: "correlate-claim" }
  >,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  const rows = yield* usagePackSqlRows(
    usagePackSqlUpdate(
      usagePackSubscriptions,
      {
        stripeCheckoutSessionId: operation.sessionId,
        subscriptionStatus: "checkout_pending",
        updatedAt: yield* usagePackSqlClock(),
      },
      and(
        eq(usagePackSubscriptions.id, operation.rootId),
        eq(usagePackSubscriptions.orgId, operation.orgId),
        eq(usagePackSubscriptions.stripeCustomerId, operation.customerId),
        eq(usagePackSubscriptions.stripePlanPriceId, operation.planPriceId),
        eq(usagePackSubscriptions.tier, operation.tier),
        eq(
          usagePackSubscriptions.subscriptionStatus,
          USAGE_PACK_PURCHASE_CLAIM_STATUS,
        ),
        isNull(usagePackSubscriptions.stripeCheckoutSessionId),
        isNull(usagePackSubscriptions.stripeSubscriptionId),
      ),
      { id: usagePackSubscriptions.id },
    ),
    usagePackSqlRow({ id: usagePackSubscriptions.id }),
  );
  return {
    kind: "correlate-claim",
    value: rows.length === 1 ? "correlated" : "changed",
  };
}
function* claimPurchasePlan(
  operation: Extract<
    UsagePackPendingSnapshotOperation,
    { kind: "claim-purchase" }
  >,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  const rows = yield* usagePackSqlRows(
    usagePackSqlUpdate(
      usagePackSubscriptions,
      {
        subscriptionStatus: USAGE_PACK_PURCHASE_CLAIM_STATUS,
        updatedAt: operation.at,
      },
      and(
        eq(usagePackSubscriptions.id, operation.rootId),
        eq(usagePackSubscriptions.orgId, operation.orgId),
        eq(usagePackSubscriptions.subscriptionStatus, "purchase_pending"),
        isNull(usagePackSubscriptions.stripeCheckoutSessionId),
        isNull(usagePackSubscriptions.stripeSubscriptionId),
        notExists(
          inFlightUsagePackPurchaseQuery({
            orgId: operation.orgId,
            sourceSubscriptionId: null,
            excludeUsagePackSubscriptionId: operation.rootId,
          }),
        ),
        notExists(
          inFlightPlanPurchaseQuery(
            operation.orgId,
            operation.planClaimStaleBefore,
          ),
        ),
      ),
      { id: usagePackSubscriptions.id },
    ),
    usagePackSqlRow({ id: usagePackSubscriptions.id }),
  );
  return { kind: "claim-purchase", value: rows.length === 1 };
}
function* publishPurchasePlan(
  operation: Extract<
    UsagePackPendingSnapshotOperation,
    { kind: "publish-purchase" }
  >,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  const rows = yield* usagePackSqlRows(
    usagePackSqlUpdate(
      usagePackSubscriptions,
      {
        stripeSubscriptionId: operation.subscription.id,
        subscriptionStatus: operation.subscription.status,
        updatedAt: yield* usagePackSqlClock(),
      },
      and(
        eq(usagePackSubscriptions.id, operation.rootId),
        eq(usagePackSubscriptions.orgId, operation.orgId),
        eq(
          usagePackSubscriptions.subscriptionStatus,
          USAGE_PACK_PURCHASE_CLAIM_STATUS,
        ),
        isNull(usagePackSubscriptions.stripeCheckoutSessionId),
        isNull(usagePackSubscriptions.stripeSubscriptionId),
      ),
      { id: usagePackSubscriptions.id },
    ),
    usagePackSqlRow({ id: usagePackSubscriptions.id }),
  );
  let value = rows.length === 1;
  if (!value) {
    const [current] = yield* usagePackSqlRows(
      new QueryBuilder()
        .select(
          usagePackSqlSelection({
            subscriptionId: usagePackSubscriptions.stripeSubscriptionId,
          }),
        )
        .from(usagePackSubscriptions)
        .where(eq(usagePackSubscriptions.id, operation.rootId))
        .getSQL(),
      usagePackSqlRow({
        subscriptionId: usagePackSubscriptions.stripeSubscriptionId,
      }),
    );
    value = current?.subscriptionId === operation.subscription.id;
  }
  return { kind: "publish-purchase", value };
}
function* synchronizePlan(
  operation: Extract<
    UsagePackPendingSnapshotOperation,
    { kind: "synchronize" }
  >,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  const updatedAt = yield* usagePackSqlClock();
  const cancelAt = operation.subscription.cancel_at;
  const cancelAtPeriodEnd =
    operation.subscription.cancel_at_period_end ||
    (typeof cancelAt === "number" &&
      Number.isSafeInteger(cancelAt) &&
      cancelAt > 0);
  yield* usagePackSqlWrite(
    usagePackSqlUpdate(
      usagePackSubscriptions,
      {
        tier: operation.shape.tier,
        stripePlanPriceId: operation.shape.planPriceId,
        stripeSubscriptionId: operation.subscription.id,
        subscriptionStatus: operation.subscription.status,
        cancelAtPeriodEnd,
        updatedAt,
        ...(operation.checkoutSessionId
          ? { stripeCheckoutSessionId: operation.checkoutSessionId }
          : {}),
      },
      eq(usagePackSubscriptions.id, operation.rootId),
    ),
  );
  if (operation.shape.projectsOrgPlan) {
    yield* usagePackSqlWrite(
      usagePackSqlUpdate(
        orgMetadata,
        {
          subscriptionStatus: operation.subscription.status,
          cancelAtPeriodEnd,
          updatedAt,
        },
        and(
          eq(orgMetadata.orgId, operation.orgId),
          eq(orgMetadata.stripeSubscriptionId, operation.subscription.id),
        ),
      ),
    );
  }
  return { kind: "synchronize" };
}
function* deactivatePlan(
  operation: Extract<UsagePackPendingSnapshotOperation, { kind: "deactivate" }>,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  const updatedAt = yield* usagePackSqlClock();
  yield* usagePackSqlWrite(
    usagePackSqlUpdate(
      usagePackSubscriptions,
      {
        stripeSubscriptionId: operation.subscription.id,
        subscriptionStatus: operation.status,
        cancelAtPeriodEnd: false,
        updatedAt,
      },
      eq(usagePackSubscriptions.id, operation.rootId),
    ),
  );
  yield* usagePackSqlWrite(
    usagePackSqlUpdate(
      usagePackAllocations,
      { status: "inactive", updatedAt },
      eq(usagePackAllocations.usagePackSubscriptionId, operation.rootId),
    ),
  );
  if (
    !operation.subscription.items.data.some((item) => {
      return tierForKnownPlanPrice(item.price) === "custom";
    })
  ) {
    const downgraded = yield* usagePackSqlRows(
      usagePackSqlUpdate(
        orgMetadata,
        {
          tier: "limited-free-1",
          stripeSubscriptionId: null,
          subscriptionStatus: operation.status,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          updatedAt,
        },
        and(
          eq(orgMetadata.orgId, operation.orgId),
          eq(orgMetadata.stripeSubscriptionId, operation.subscription.id),
        ),
        { orgId: orgMetadata.orgId },
      ),
      usagePackSqlRow({ orgId: orgMetadata.orgId }),
    );
    for (const row of downgraded) {
      const sourceMetadata = retireMarketingMetadata({
        ...operation.subscription.metadata,
        usagePackInvalidReason: operation.reason,
      });
      const values = orgPlanEntitlementValues(
        {
          orgId: row.orgId,
          tier: "limited-free-1",
          source: "stripe_subscription",
          sourceMetadata,
        },
        { stripeSubscriptionId: null, sourceMetadata },
        yield* usagePackSqlClock(),
      );
      yield* usagePackSqlWrite(
        usagePackSqlInsert(orgPlanEntitlements, values, {
          conflict: {
            target: orgPlanEntitlements.orgId,
            set: {
              planKey: values.planKey,
              planRank: values.planRank,
              source: values.source,
              status: values.status,
              baseConcurrencyLimit: values.baseConcurrencyLimit,
              canBuyConcurrency: values.canBuyConcurrency,
              canBuyCredits: values.canBuyCredits,
              showUsagePack: values.showUsagePack,
              autoRechargeAllowed: values.autoRechargeAllowed,
              restrictedBuiltInModels: values.restrictedBuiltInModels,
              workflowWebhookTriggerAllowed:
                values.workflowWebhookTriggerAllowed,
              audioLifetimeLimit: values.audioLifetimeLimit,
              audioDailyRateLimit: values.audioDailyRateLimit,
              audioDailyDurationSeconds: values.audioDailyDurationSeconds,
              stripeSubscriptionId: values.stripeSubscriptionId,
              stripeProductId: null,
              stripePriceId: values.stripePriceId,
              currentPeriodStart: values.currentPeriodStart,
              currentPeriodEnd: values.currentPeriodEnd,
              cancelAt: values.cancelAt,
              expiresAt: values.expiresAt,
              metadataHash: null,
              sourceMetadata: values.sourceMetadata,
              updatedAt: values.updatedAt,
            },
          },
        }),
      );
    }
  }
  return { kind: "deactivate" };
}
function* deletePlan(
  operation: Extract<UsagePackPendingSnapshotOperation, { kind: "delete" }>,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  const updatedAt = yield* usagePackSqlClock();
  yield* usagePackSqlWrite(
    usagePackSqlUpdate(
      usagePackSubscriptions,
      {
        stripeSubscriptionId: operation.subscriptionId,
        subscriptionStatus: "canceled",
        cancelAtPeriodEnd: false,
        updatedAt,
      },
      eq(usagePackSubscriptions.id, operation.rootId),
    ),
  );
  yield* usagePackSqlWrite(
    usagePackSqlUpdate(
      usagePackAllocations,
      { status: "inactive", updatedAt },
      eq(usagePackAllocations.usagePackSubscriptionId, operation.rootId),
    ),
  );
  return { kind: "delete" };
}
function* preparePendingScopePlan(
  operation: UsagePackPendingSnapshotOperation,
) {
  const orgIds = [
    operation.kind === "prepare-purchase"
      ? operation.purchase.orgId
      : operation.orgId,
  ];
  const referencedSubscriptionIds =
    operation.kind === "prepare-purchase" ? [] : [operation.rootId];
  const orderedOrgIds = [...new Set(orgIds)].sort();
  if (orderedOrgIds.length === 0) {
    throw new Error("Usage pack writes require an organization scope");
  }
  const roots = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(
        usagePackSqlSelection({
          id: usagePackSubscriptions.id,
          orgId: usagePackSubscriptions.orgId,
        }),
      )
      .from(usagePackSubscriptions)
      .where(
        or(
          inArray(usagePackSubscriptions.orgId, orderedOrgIds),
          inArray(usagePackSubscriptions.id, referencedSubscriptionIds),
        ),
      )
      .getSQL(),
    usagePackSqlRow({
      id: usagePackSubscriptions.id,
      orgId: usagePackSubscriptions.orgId,
    }),
  );
  if (
    roots.some((root) => {
      return !orderedOrgIds.includes(root.orgId);
    })
  ) {
    throw new Error("Usage pack subscription moved outside its locked scope");
  }
  for (const orgId of orderedOrgIds) {
    yield* usagePackSqlWrite(
      usagePackSqlInsert(
        usagePackPendingSnapshotGuards,
        { orgId, pendingSnapshotCount: 0 },
        { conflict: {} },
      ),
    );
  }
  // READ COMMITTED gives each statement a new snapshot. Read the guard and
  // business rows together so a committed transition cannot look like damage.
  const scopeRows = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(
        usagePackSqlSelection({
          guardOrgId: usagePackPendingSnapshotGuards.orgId,
          guardCount: usagePackPendingSnapshotGuards.pendingSnapshotCount,
          snapshotId: usagePackSubscriptions.id,
          snapshotOrgId: usagePackSubscriptions.orgId,
          snapshotStatus: usagePackSubscriptions.subscriptionStatus,
        }),
      )
      .from(usagePackPendingSnapshotGuards)
      .leftJoin(
        usagePackSubscriptions,
        eq(usagePackSubscriptions.orgId, usagePackPendingSnapshotGuards.orgId),
      )
      .where(inArray(usagePackPendingSnapshotGuards.orgId, orderedOrgIds))
      .getSQL(),
    object({
      guardOrgId: string(),
      guardCount: int(),
      snapshotId: uuid().nullable(),
      snapshotOrgId: string().nullable(),
      snapshotStatus: string().nullable(),
    }),
  );
  const scope = scopeRows.map((row) => {
    return {
      guard: { orgId: row.guardOrgId, pendingSnapshotCount: row.guardCount },
      snapshot:
        row.snapshotId === null
          ? null
          : object({ id: uuid(), orgId: string(), status: string() }).parse({
              id: row.snapshotId,
              orgId: row.snapshotOrgId,
              status: row.snapshotStatus,
            }),
    };
  });
  const guards = orderedOrgIds.map((orgId) => {
    const row = scope.find(({ guard }) => {
      return guard.orgId === orgId;
    });
    if (!row) {
      throw new Error("Usage pack pending snapshot count disappeared");
    }
    return row.guard;
  });
  const before = scope.flatMap(({ snapshot }) => {
    return snapshot ? [snapshot] : [];
  });
  for (const guard of guards) {
    if (
      guard.pendingSnapshotCount !== pendingRows(before, guard.orgId).length
    ) {
      throw new Error("Usage pack pending snapshot guard requires repair");
    }
  }

  return { orderedOrgIds, before };
}
function* finishPendingScopePlan(scope: {
  orderedOrgIds: readonly string[];
  before: readonly SnapshotRow[];
}): UsagePackRetainedPlan<void> {
  const { orderedOrgIds, before } = scope;
  const after = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(
        usagePackSqlSelection({
          id: usagePackSubscriptions.id,
          orgId: usagePackSubscriptions.orgId,
          status: usagePackSubscriptions.subscriptionStatus,
        }),
      )
      .from(usagePackSubscriptions)
      .where(
        or(
          inArray(usagePackSubscriptions.orgId, orderedOrgIds),
          inArray(
            usagePackSubscriptions.id,
            before.map((row) => {
              return row.id;
            }),
          ),
        ),
      )
      .getSQL(),
    usagePackSqlRow({
      id: usagePackSubscriptions.id,
      orgId: usagePackSubscriptions.orgId,
      status: usagePackSubscriptions.subscriptionStatus,
    }),
  );
  if (
    after.some((row) => {
      return !orderedOrgIds.includes(row.orgId);
    })
  ) {
    throw new Error("Usage pack subscription moved outside its locked scope");
  }
  for (const orgId of orderedOrgIds) {
    const prior = new Set(
      pendingRows(before, orgId).map((row) => {
        return row.id;
      }),
    );
    const pending = pendingRows(after, orgId);
    if (
      pending.length > 1 &&
      pending.some((row) => {
        return !prior.has(row.id);
      })
    ) {
      throw new Error(
        "Another usage-pack purchase is already pending for this organization",
      );
    }
    const beforeCount = prior.size;
    const afterCount = pending.length;
    if (beforeCount !== afterCount) {
      const [published] = yield* usagePackSqlRows(
        usagePackSqlUpdate(
          usagePackPendingSnapshotGuards,
          { pendingSnapshotCount: afterCount },
          and(
            eq(usagePackPendingSnapshotGuards.orgId, orgId),
            eq(
              usagePackPendingSnapshotGuards.pendingSnapshotCount,
              beforeCount,
            ),
          ),
          { orgId: usagePackPendingSnapshotGuards.orgId },
        ),
        usagePackSqlRow({ orgId: usagePackPendingSnapshotGuards.orgId }),
      );
      if (!published) {
        throw new UsagePackPendingSnapshotConflict(
          "Usage pack pending snapshot count changed during publication",
        );
      }
    }
  }
}
function* pendingMutationPlan(
  operation: UsagePackPendingSnapshotOperation,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  switch (operation.kind) {
    case "prepare-purchase": {
      return yield* preparePurchasePlan(operation);
    }
    case "correlate-claim": {
      return yield* correlateClaimPlan(operation);
    }
    case "claim-purchase": {
      return yield* claimPurchasePlan(operation);
    }
    case "publish-purchase": {
      return yield* publishPurchasePlan(operation);
    }
    case "synchronize": {
      return yield* synchronizePlan(operation);
    }
    case "deactivate": {
      return yield* deactivatePlan(operation);
    }
    case "delete": {
      return yield* deletePlan(operation);
    }
  }
}
export function* usagePackPendingSnapshotPlan(
  operation: UsagePackPendingSnapshotOperation,
): UsagePackRetainedPlan<UsagePackPendingSnapshotResult> {
  const scope = yield* preparePendingScopePlan(operation);
  const result = yield* pendingMutationPlan(operation);
  yield* finishPendingScopePlan(scope);
  return result;
}

function retainedCheckoutRedirect(
  args: CreateUsagePackCheckoutSessionArgs,
  session: PreparedPendingUsagePackCheckout["resolved"][number]["session"],
): string {
  let url: string;
  if (session.status === "complete") {
    url = args.successUrl.replace("{CHECKOUT_SESSION_ID}", session.id);
  } else {
    if (!session.url) {
      throw new Error("Stripe checkout session did not return a URL");
    }
    url = session.url;
  }
  return url;
}
