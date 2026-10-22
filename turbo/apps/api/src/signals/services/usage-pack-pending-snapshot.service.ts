import { z } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  usagePackPendingSnapshotPlan,
  UsagePackPendingSnapshotConflict,
} from "./usage-pack-pending-snapshot-plan";

import { usagePackPendingSnapshotGuards } from "@okouai/db/schema/usage-pack-subscription";

import { and, eq } from "drizzle-orm";
import { command } from "ccstate";
import { settle } from "../utils";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";

import type {
  CreateUsagePackCheckoutSessionArgs,
  UsagePackContext,
  PreparedPendingUsagePackCheckout,
  UsagePackSubscriptionInput,
} from "./usage-pack-subscription.service";
const retainedRowSchema = z.record(z.string(), z.unknown());

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

/** The closed operations are the seven original callbacks. Their early results
 * still pass through after-snapshot/count publication in this same transaction. */
export const writeUsagePackPendingSnapshots$ = command(
  async function writeUsagePackPendingSnapshots(
    { set },
    operation: UsagePackPendingSnapshotOperation,
    signal?: AbortSignal,
  ): Promise<UsagePackPendingSnapshotOutcome> {
    const db = set(writeDb$);

    return await settle(
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0284; new non-billing transactions are prohibited.
      db.transaction(async (tx) => {
        const plan = usagePackPendingSnapshotPlan(operation);
        let step = plan.next();
        while (!step.done) {
          const current = step.value;
          let rows: readonly unknown[] = [];
          switch (current.kind) {
            case "timestamp": {
              rows = [nowDate()];
              break;
            }
            case "abort-check": {
              signal?.throwIfAborted();
              break;
            }
            case "batch": {
              rows = await Promise.all(
                current.statements.map(async (statement) => {
                  return parseRawRows(
                    retainedRowSchema,
                    await tx.execute(statement),
                  );
                }),
              );
              break;
            }
            case "read": {
              rows = parseRawRows(
                retainedRowSchema,
                await tx.execute(current.sql),
              );
              break;
            }
            case "write": {
              await tx.execute(current.sql);
              break;
            }
          }
          step = plan.next(rows);
        }
        return step.value;
      }),
    );
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
