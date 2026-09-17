import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { and, eq, sql } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import type {
  NativeDeliveryRecovery,
  NativeSlotExecutor,
  NativeTickDependencies,
} from "./morning-brief-native-executor.service";
import {
  readMorningBriefNativeSchedule,
  type MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";

/**
 * The production wiring of the native Morning Brief tick.
 *
 * The tick itself takes its per-slot execution, delivery recovery and legacy
 * drain predicate as dependencies so a test can substitute an external
 * boundary double without substituting the scheduler. This module is the one
 * place that binds them to the real services.
 */

export type MorningBriefLegacyDrainVerdict =
  | { readonly kind: "proven" }
  | { readonly kind: "unresolved"; readonly reason: string };

/**
 * Prove — or refuse to prove — that the legacy path has drained for one member.
 *
 * The evidence is the real S7a schedule-claim journal, which records the exact
 * scheduled anchor with its queue-event and Run bindings and settles each claim
 * once. The rules this encodes:
 *
 * - An **unsettled** journalled claim is reachable work. It keeps the drain
 *   unresolved; it is never treated as finished because a lease or TTL lapsed.
 * - A member with **no journal rows at all** has unknown history rather than a
 *   proven drain. The journal only starts recording at S7a's deployment, so
 *   earlier work has no recoverable scheduled identity and must not be invented
 *   from `firedAt`, a Run's context or an automation title. That case is
 *   reported as an explicit bounded reason.
 * - Only a member whose journalled claims are all settled is proven drained.
 *
 * This deliberately does not accept `automation.enabled = false`, an empty
 * outbox, a completed agent status or one expired TTL as proof.
 */
export async function proveLegacyMorningBriefDrain(
  db: ReadonlyDb,
  owner: MorningBriefMemberIdentity,
  schedule: MorningBriefNativeScheduleRow | undefined,
): Promise<MorningBriefLegacyDrainVerdict> {
  if (schedule?.legacyAutomationId == null) {
    // Nothing legacy was ever selected for this member, so there is no old
    // producer, callback or mail work that could still be reachable.
    return { kind: "proven" };
  }

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unsettled: sql<number>`count(*) FILTER (WHERE ${morningBriefScheduleClaims.settlement} = 'unsettled')::int`,
    })
    .from(morningBriefScheduleClaims)
    .where(
      and(
        eq(
          morningBriefScheduleClaims.automationId,
          schedule.legacyAutomationId,
        ),
        eq(morningBriefScheduleClaims.orgId, owner.orgId),
        eq(morningBriefScheduleClaims.ownerUserId, owner.userId),
      ),
    );

  if (counts === undefined || counts.total === 0) {
    return {
      kind: "unresolved",
      reason: "legacy-history-unjournalled",
    };
  }
  if (counts.unsettled > 0) {
    return {
      kind: "unresolved",
      reason: "legacy-claim-unsettled",
    };
  }
  return { kind: "proven" };
}

/**
 * The production per-slot executor.
 *
 * The real collection → single platform generation → saved result → Chat and
 * email path is reached through the existing S5 and S6 engines. Those engines
 * currently admit only the preview execution purpose, and a preview result may
 * never be promoted to a production result, so until their production purpose
 * lands this reports a **pre-reservation configuration** state.
 *
 * That is the honest branch of the settlement matrix for this condition: it
 * takes the finite deferral, makes zero provider calls, writes no invocation
 * receipt, and once the bounded policy is exhausted it settles the slot as
 * `not-configured` and schedules the next occurrence rather than disabling the
 * member's Morning Brief. It never fabricates an accepted result and never
 * calls a preview HTTP route.
 */
export const productionSlotExecutor: NativeSlotExecutor = {
  execute: async () => {
    return {
      kind: "defer",
      reason: "generation-production-purpose-unavailable",
    };
  },
};

/**
 * The production delivery recovery.
 *
 * It resolves the durable receipt by the stable native occurrence identity, so
 * a Chat receipt committed before a crash stays delivered even after the S5
 * result expires. With no production-purpose delivery rows reachable yet, no
 * occurrence can carry a pending delivery obligation, so this consumer reports
 * `pending` rather than inventing a terminal failure.
 */
export const productionDeliveryRecovery: NativeDeliveryRecovery = {
  resolve: async () => "pending",
};

/** Bind the tick to the real services. */
export function productionNativeTickDependencies(
  db: ReadonlyDb,
): NativeTickDependencies {
  return {
    executor: productionSlotExecutor,
    delivery: productionDeliveryRecovery,
    legacyDrain: async (owner) => {
      const schedule = await readMorningBriefNativeSchedule(db, owner);
      return await proveLegacyMorningBriefDrain(db, owner, schedule);
    },
  };
}
