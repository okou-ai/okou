import type { MorningBriefPreferenceResponse } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import {
  MORNING_BRIEF_PREFERENCE_PROJECTION_VERSION,
  morningBriefInstalledPreferences,
} from "@okouai/db/schema/morning-brief-installed-preference";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { settle } from "../utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import {
  loadMorningBriefMigrationState,
  type MorningBriefMigrationState,
  type MorningBriefStateReader,
} from "./morning-brief-migration-state.service";

/**
 * The gated installed-preference projection for `simple-morning-brief`.
 *
 * This is a persistence rehearsal, not an authority. Writers copy the canonical
 * legacy state described in
 * [the migration contract](../../../../../../docs/morning-brief-migration-state.md),
 * and the reader hands a copy back only while it still equals that live state.
 * Anything else — a missing row, an unsupported version, a field an old writer
 * changed without refreshing here — falls back to the legacy answer.
 */

const L = logger("morning-brief-preference-projection.service");

type MorningBriefInstalledState = Extract<
  MorningBriefMigrationState,
  { readonly kind: "installed" }
>;

type MorningBriefPreferenceProjection =
  typeof morningBriefInstalledPreferences.$inferSelect;

type MorningBriefProjectionRefresh =
  | { readonly outcome: "refreshed" }
  | { readonly outcome: "cleared" }
  | {
      readonly outcome: "skipped";
      readonly reason: "feature-disabled" | "membership-unavailable";
    }
  | { readonly outcome: "failed" };

function ownerWhere(owner: MorningBriefMemberIdentity) {
  return and(
    eq(morningBriefInstalledPreferences.orgId, owner.orgId),
    eq(morningBriefInstalledPreferences.userId, owner.userId),
  );
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  return left === null || right === null
    ? left === right
    : left.getTime() === right.getTime();
}

/**
 * Every field the projection copies has to still equal its source.
 *
 * The row's own `updatedAt` proves nothing: an old API binary, the scheduler
 * advancing `nextRunAt`, a catalog action, or a thread deletion all move the
 * legacy state without touching this table. Equality against the state loaded
 * in this same request is the only freshness evidence available.
 */
function matchesInstalledState(
  row: MorningBriefPreferenceProjection,
  state: MorningBriefInstalledState,
): boolean {
  return (
    row.projectionVersion === MORNING_BRIEF_PREFERENCE_PROJECTION_VERSION &&
    row.orgId === state.owner.orgId &&
    row.userId === state.owner.userId &&
    row.workflowId === state.installation.id &&
    row.agentId === state.installation.agentId &&
    row.automationId === state.automation.id &&
    row.chatThreadId === state.chatThreadId &&
    row.enabled === state.automation.enabled &&
    row.cronExpression === state.automation.cronExpression &&
    row.timezone === state.automation.timezone &&
    sameInstant(row.nextRunAt, state.automation.nextRunAt)
  );
}

/**
 * Serve the Settings response from the projection, or `null` to keep the
 * legacy one. Reading never installs, repairs, backfills or creates a thread.
 */
export async function readMorningBriefPreferenceProjection(
  db: MorningBriefStateReader,
  state: MorningBriefInstalledState,
): Promise<MorningBriefPreferenceResponse | null> {
  const [row] = await db
    .select()
    .from(morningBriefInstalledPreferences)
    .where(ownerWhere(state.owner))
    .limit(1);
  if (!row || !matchesInstalledState(row, state)) {
    return null;
  }
  return {
    enabled: row.enabled,
    status: row.enabled ? "enabled" : "paused",
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    timezone: row.timezone,
    unavailableReason: null,
  };
}

async function writeMorningBriefPreferenceProjection(
  tx: Tx,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefProjectionRefresh> {
  // Erasure admission before any business row, held through COMMIT. A closed
  // subject aborts this transaction rather than gaining a new native row.
  await assertErasureSubjectWritable(tx, [
    { subjectKind: "organization", subjectId: owner.orgId },
    { subjectKind: "user", subjectId: owner.userId },
  ]);
  const state = await loadMorningBriefMigrationState(tx, owner);
  if (state.kind !== "installed") {
    // Absent, pending and inconsistent installations keep their legacy
    // branches, and no copy of a state we cannot reproduce may survive.
    await tx.delete(morningBriefInstalledPreferences).where(ownerWhere(owner));
    return { outcome: "cleared" };
  }

  // Lock the exact cache parent this row hangs from and recheck it here, so a
  // membership cleanup either waits for this commit and then cascades the row
  // away, or has already removed the parent and leaves nothing to write. This
  // writer never creates or refills that parent.
  const [member] = await tx
    .select({ orgId: orgMembersCache.orgId })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, owner.orgId),
        eq(orgMembersCache.userId, owner.userId),
      ),
    )
    .limit(1)
    .for("key share");
  if (!member) {
    return { outcome: "skipped", reason: "membership-unavailable" };
  }

  const copied = {
    projectionVersion: MORNING_BRIEF_PREFERENCE_PROJECTION_VERSION,
    workflowId: state.installation.id,
    automationId: state.automation.id,
    agentId: state.installation.agentId,
    chatThreadId: state.chatThreadId,
    enabled: state.automation.enabled,
    cronExpression: state.automation.cronExpression,
    timezone: state.automation.timezone,
    nextRunAt: state.automation.nextRunAt,
    updatedAt: nowDate(),
  };
  await tx
    .insert(morningBriefInstalledPreferences)
    .values({ ...owner, ...copied })
    .onConflictDoUpdate({
      target: [
        morningBriefInstalledPreferences.orgId,
        morningBriefInstalledPreferences.userId,
      ],
      set: copied,
    });
  return { outcome: "refreshed" };
}

async function refreshWhileSelected(
  db: Db,
  owner: MorningBriefMemberIdentity,
  signal: AbortSignal,
): Promise<MorningBriefProjectionRefresh> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    owner.orgId,
    owner.userId,
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.SimpleMorningBrief, featureSwitchContext)
  ) {
    return { outcome: "skipped", reason: "feature-disabled" };
  }
  return await db.transaction(async (tx) => {
    return await writeMorningBriefPreferenceProjection(tx, owner);
  });
}

/**
 * Re-copy the member's installed state after a legacy write already committed.
 *
 * The preference advisory lock serializes this against the other preference
 * writers, but it is not a shared transaction: the legacy mutation runs on the
 * outer `Db` and has already committed by the time this starts. A failure here
 * therefore reports an operational problem and leaves the committed user choice
 * alone — it never replays the mutation or turns a real outcome into an error.
 * Cancellation still propagates, so a cancelled request cannot leave a write
 * running behind it.
 */
export async function refreshMorningBriefPreferenceProjection(
  db: Db,
  owner: MorningBriefMemberIdentity,
  signal: AbortSignal,
): Promise<MorningBriefProjectionRefresh> {
  signal.throwIfAborted();
  const refreshed = await settle(
    refreshWhileSelected(db, owner, signal),
    signal,
  );
  if (!refreshed.ok) {
    // An expected switch-off, uninstalled brief or missing membership parent is
    // reported as a skip above. Reaching here means the copy itself failed,
    // which stays visible instead of being recorded as a healthy projection.
    L.warn("Morning Brief preference projection refresh failed", {
      ...owner,
      error: refreshed.error,
    });
    return { outcome: "failed" };
  }
  return refreshed.value;
}
