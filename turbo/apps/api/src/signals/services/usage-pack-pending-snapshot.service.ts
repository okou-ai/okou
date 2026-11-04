import {
  array,
  boolean,
  literal,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
} from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { UsagePackPendingSnapshotConflict } from "./usage-pack-pending-snapshot-plan";

import { usagePackPendingSnapshotGuards } from "@okouai/db/schema/usage-pack-subscription";

import { and, eq, sql } from "drizzle-orm";
import { command } from "ccstate";
import { safeJsonParse, settle } from "../utils";
import { writeDb$ } from "../external/db";
import { nowDateSql } from "../../lib/time";
import { retireMarketingMetadata } from "../../lib/marketing-metadata";
import { tierForKnownPlanPrice } from "./billing-checkout.service";
import { ORG_PLAN_ENTITLEMENT_TIER_VALUES } from "./org-plan-entitlement-tier-values";

import type {
  CreateUsagePackCheckoutSessionArgs,
  UsagePackContext,
  PreparedPendingUsagePackCheckout,
  UsagePackSubscriptionInput,
} from "./usage-pack-subscription.service";

export function usagePackPendingSnapshotCountWrite(
  orgId: string,
  before: number,
  after: number,
) {
  if (before === after) {
    return null;
  }
  return {
    values: { pendingSnapshotCount: after },
    condition: and(
      eq(usagePackPendingSnapshotGuards.orgId, orgId),
      eq(usagePackPendingSnapshotGuards.pendingSnapshotCount, before),
    ),
  };
}

export function assertPendingSnapshotPublished(
  published: { readonly orgId: string } | undefined,
): void {
  if (!published) {
    throw new UsagePackPendingSnapshotConflict(
      "Usage pack pending snapshot count changed during publication",
    );
  }
}

export type UsagePackPendingSnapshotOperation =
  | {
      readonly kind: "prepare-purchase";
      readonly purchase: CreateUsagePackCheckoutSessionArgs;
      readonly customerId: string;
      readonly prepared: PreparedPendingUsagePackCheckout;
    }
  | {
      readonly kind: "correlate-claim";
      readonly orgId: string;
      readonly rootId: string;
      readonly sessionId: string;
      readonly customerId: string;
      readonly planPriceId: string;
      readonly tier: UsagePackContext["subscription"]["tier"];
    }
  | {
      readonly kind: "claim-purchase";
      readonly orgId: string;
      readonly rootId: string;
      readonly at: Date;
      readonly planClaimStaleBefore: Date;
    }
  | {
      readonly kind: "publish-purchase";
      readonly orgId: string;
      readonly rootId: string;
      readonly subscription: { readonly id: string; readonly status: string };
    }
  | {
      readonly kind: "synchronize";
      readonly orgId: string;
      readonly rootId: string;
      readonly checkoutSessionId?: string;
      readonly subscription: UsagePackSubscriptionInput;
      readonly shape: {
        readonly tier: UsagePackContext["subscription"]["tier"];
        readonly planPriceId: string;
        readonly projectsOrgPlan: boolean;
      };
    }
  | {
      readonly kind: "deactivate";
      readonly orgId: string;
      readonly rootId: string;
      readonly subscription: UsagePackSubscriptionInput;
      readonly reason: string;
      readonly status: string;
    }
  | {
      readonly kind: "delete";
      readonly orgId: string;
      readonly rootId: string;
      readonly subscriptionId: string;
    };
export type UsagePackPendingSnapshotResult =
  | {
      readonly kind: "prepare-purchase";
      readonly value:
        | { readonly kind: "conflict" }
        | { readonly kind: "redirect"; readonly url: string }
        | {
            readonly kind: "snapshot";
            readonly usagePackSubscriptionId: string;
          };
    }
  | {
      readonly kind: "correlate-claim";
      readonly value: "correlated" | "changed";
    }
  | { readonly kind: "claim-purchase"; readonly value: boolean }
  | { readonly kind: "publish-purchase"; readonly value: boolean }
  | { readonly kind: "synchronize" | "deactivate" | "delete" };

export type UsagePackPendingSnapshotOutcome =
  | { readonly ok: true; readonly value: UsagePackPendingSnapshotResult }
  | { readonly ok: false; readonly error: unknown };

// The existing fingerprint serializes decoded Date columns as ISO strings or
// null. Compare their full JavaScript millisecond/TimeClip values in SQL.
const fingerprintDateSchema = string()
  .nullable()
  .transform((value) => {
    return value === null ? null : new Date(value).getTime();
  });
const fingerprintRowSchema = object({
  currentPeriodStart: fingerprintDateSchema,
  currentPeriodEnd: fingerprintDateSchema,
  createdAt: fingerprintDateSchema,
  updatedAt: fingerprintDateSchema,
}).passthrough();
const fingerprintSchema = array(
  object({
    subscription: fingerprintRowSchema,
    allocations: array(fingerprintRowSchema),
  }),
);

const pendingSnapshotSqlResultSchema = union([
  object({
    kind: literal("prepare-purchase"),
    value: union([
      object({ kind: literal("conflict") }),
      object({ kind: literal("redirect"), url: string() }),
      object({
        kind: literal("snapshot"),
        usagePackSubscriptionId: uuid(),
      }),
    ]),
  }),
  object({
    kind: literal("correlate-claim"),
    value: zEnum(["correlated", "changed"]),
  }),
  object({
    kind: zEnum(["claim-purchase", "publish-purchase"]),
    value: boolean(),
  }),
  object({ kind: zEnum(["synchronize", "deactivate", "delete"]) }),
]);

function pendingSnapshotInput(operation: UsagePackPendingSnapshotOperation) {
  if (operation.kind === "prepare-purchase") {
    const { purchase, prepared, customerId } = operation;
    const retained = prepared.retained;
    return {
      kind: operation.kind,
      orgId: purchase.orgId,
      tier: purchase.tier,
      planPriceId: purchase.planPriceId,
      customerId,
      allocations: purchase.allocations.map((allocation) => {
        return {
          usagePackUsd: allocation.usagePackUsd,
          stripePriceId: allocation.stripePriceId,
          ...("userId" in allocation
            ? { userId: allocation.userId }
            : { invitationId: allocation.invitationId }),
        };
      }),
      fingerprint: fingerprintSchema.parse(safeJsonParse(prepared.fingerprint)),
      resolved: prepared.resolved.map((entry) => {
        const root = entry.context.subscription;
        return {
          id: root.id,
          orgId: root.orgId,
          status: root.subscriptionStatus,
          sessionId: root.stripeCheckoutSessionId,
          subscriptionId: root.stripeSubscriptionId,
          retained: entry === retained,
        };
      }),
      retained: retained !== undefined,
      redirect: retained
        ? retained.session.status === "complete"
          ? purchase.successUrl.replace(
              "{CHECKOUT_SESSION_ID}",
              retained.session.id,
            )
          : retained.session.url || null
        : null,
    };
  }
  const scope = {
    kind: operation.kind,
    orgId: operation.orgId,
    rootId: operation.rootId,
  };
  switch (operation.kind) {
    case "correlate-claim":
    case "claim-purchase":
    case "delete": {
      return operation;
    }
    case "publish-purchase": {
      return {
        ...scope,
        subscriptionId: operation.subscription.id,
        status: operation.subscription.status,
      };
    }
    case "synchronize": {
      const cancelAt = operation.subscription.cancel_at;
      const cancelAtPeriodEnd =
        operation.subscription.cancel_at_period_end ||
        (typeof cancelAt === "number" &&
          Number.isSafeInteger(cancelAt) &&
          cancelAt > 0);
      return {
        ...scope,
        subscriptionId: operation.subscription.id,
        status: operation.subscription.status,
        tier: operation.shape.tier,
        planPriceId: operation.shape.planPriceId,
        projectsOrgPlan: operation.shape.projectsOrgPlan,
        cancelAtPeriodEnd,
        ...(operation.checkoutSessionId
          ? { checkoutSessionId: operation.checkoutSessionId }
          : {}),
      };
    }
    case "deactivate": {
      const projectsLimitedPlan = !operation.subscription.items.data.some(
        (item) => {
          return tierForKnownPlanPrice(item.price) === "custom";
        },
      );
      return {
        ...scope,
        subscriptionId: operation.subscription.id,
        status: operation.status,
        projectsLimitedPlan,
        ...(projectsLimitedPlan
          ? {
              limits: ORG_PLAN_ENTITLEMENT_TIER_VALUES["limited-free-1"],
              sourceMetadata: retireMarketingMetadata({
                ...operation.subscription.metadata,
                usagePackInvalidReason: operation.reason,
              }),
            }
          : {}),
      };
    }
  }
}

/** One atomic SQL step owns the pending snapshot. Cancellation after SQL
 * admission can leave a complete retryable preparation; the following signal
 * check stops the caller before it starts a new provider operation. */
export const writeUsagePackPendingSnapshots$ = command(
  async function writeUsagePackPendingSnapshots(
    { set },
    operation: UsagePackPendingSnapshotOperation,
    signal?: AbortSignal,
  ): Promise<UsagePackPendingSnapshotOutcome> {
    const db = set(writeDb$);
    const outcome = await settle(
      (async () => {
        signal?.throwIfAborted();
        const payload = JSON.stringify(pendingSnapshotInput(operation));
        const [row] = parseRawRows(
          object({ result: pendingSnapshotSqlResultSchema }),
          await db.execute(sql`SELECT public.write_usage_pack_pending_snapshot(
          ${payload}::jsonb, ${nowDateSql(sql`NULL::timestamp`)}
        ) AS result`),
        );
        if (!row) {
          throw new Error("Pending snapshot write returned no result");
        }
        return row.result;
      })(),
    );
    // Prevent a cancelled preparation from starting a new provider operation.
    // A successful SQL statement is already committed at this frontier.
    signal?.throwIfAborted();
    if (!outcome.ok) {
      const conflict = object({
        cause: object({ code: literal("P0U01"), message: string() }),
      }).safeParse(outcome.error);
      if (conflict.success) {
        return {
          ok: false,
          error: new UsagePackPendingSnapshotConflict(
            conflict.data.cause.message,
          ),
        };
      }
    }
    return outcome;
  },
);

export function pendingSnapshotResult(
  outcome: UsagePackPendingSnapshotOutcome,
  kind: "prepare-purchase",
): Extract<
  UsagePackPendingSnapshotResult,
  { kind: "prepare-purchase" }
>["value"];
export function pendingSnapshotResult(
  outcome: UsagePackPendingSnapshotOutcome,
  kind: "correlate-claim",
): "correlated" | "changed";
export function pendingSnapshotResult(
  outcome: UsagePackPendingSnapshotOutcome,
  kind: "claim-purchase" | "publish-purchase",
): boolean;
export function pendingSnapshotResult(
  outcome: UsagePackPendingSnapshotOutcome,
  kind: "synchronize" | "deactivate" | "delete",
): void;
export function pendingSnapshotResult(
  outcome: UsagePackPendingSnapshotOutcome,
  kind: UsagePackPendingSnapshotOperation["kind"],
):
  | Extract<
      UsagePackPendingSnapshotResult,
      { kind: "prepare-purchase" }
    >["value"]
  | "correlated"
  | "changed"
  | boolean
  | void {
  if (!outcome.ok) {
    if (outcome.error instanceof UsagePackPendingSnapshotConflict) {
      if (kind === "prepare-purchase") {
        return { kind: "conflict" };
      }
      if (kind === "claim-purchase") {
        return false;
      }
    }
    throw outcome.error;
  }
  const result = outcome.value;
  if (result.kind !== kind) {
    throw new Error("Usage pack operation result kind mismatch");
  }
  if ("value" in result) {
    return result.value;
  }
}
