import { agents } from "@okouai/db/schema/agent";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { users } from "@okouai/db/schema/user";
import {
  workflows,
  workflowAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
} from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { ClerkClient } from "../external/clerk";
import { settle } from "../utils";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";
import type { Db } from "../external/db";
import { lockCollectionOwner } from "./morning-brief-collection-occurrence.service";
import { loadMorningBriefMigrationState } from "./morning-brief-migration-state.service";
import { lockMorningBriefNativeSchedule } from "./morning-brief-native-schedule.service";

/**
 * Outbox template name of a native Morning Brief delivery.
 *
 * It is deliberately distinct from `official-automation-result`: the legacy
 * template belongs to a real Run and Automation, while a native intent is
 * owned by a delivery row. Keeping them apart is what lets the drain demand
 * native provenance instead of treating a native row as generic email.
 */
export const MORNING_BRIEF_RESULT_EMAIL_TEMPLATE = "morning-brief-result";

type NativeMorningBriefEmailAdmission =
  | { readonly kind: "admitted" }
  | { readonly kind: "rejected"; readonly reason: string }
  /** No usable live-owner evidence this pass. Nothing is sent or failed. */
  | { readonly kind: "deferred"; readonly reason: string };

type NativeMorningBriefDelivery = Pick<
  typeof morningBriefDeliveries.$inferSelect,
  | "orgId"
  | "userId"
  | "scheduledFor"
  | "collectionKind"
  | "collectionVersion"
  | "membershipId"
  | "nativeOwnerEpoch"
  | "executionPurpose"
  | "workflowId"
  | "automationId"
  | "agentId"
  | "chatThreadId"
>;

/**
 * Authority locks taken before the shared worker touches the outbox row.
 *
 * The delivery is deliberately carried as a snapshot: after the worker obtains
 * the outbox lock it re-reads this relationship and refuses any changed or
 * missing provenance instead of accepting across the unlocked discovery gap.
 */
interface LockedNativeMorningBriefEmailAdmission {
  readonly outboxId: string;
  readonly admission: NativeMorningBriefEmailAdmission;
  readonly delivery: NativeMorningBriefDelivery | null;
}

/** Live-owner evidence resolved outside the claim transaction. */
export interface NativeMorningBriefOwnerPreflight {
  /** The exact candidate this evidence was resolved for. */
  readonly outboxId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly resultAttemptId: string;
  readonly purpose: "preview" | "production";
  /** The member's current Clerk membership, or null when they are not one. */
  readonly membershipId: string | null;
  /** A retained-source refusal resolved outside the claim transaction. */
  readonly sourceRefusal?: string;
  /** True when the remote lookup itself could not be completed. */
  readonly unavailable?: boolean;
}

/**
 * The bounds the claim admits a due item against, restated for the preflight.
 *
 * Every field here exists because the claim already applies it. Selecting a
 * candidate the claim cannot admit spends this pass's one remote lookup on a
 * row that will be resolved locally anyway, and — worse — leaves the row the
 * claim does take without evidence of its own.
 */
interface NativeMorningBriefCandidateBounds {
  /** The fixed batch clock the claim uses for retry eligibility. */
  readonly dueAt: Date;
  /** A fresh clock sample for the row's original finite lifetime. */
  readonly observedAt: Date;
  /** The row lifetime the claim derives from `created_at`. */
  readonly outboxTtlMs: number;
  /** The attempt ceiling the claim admits against. */
  readonly maxAttempts: number;
  /** Items this pass already deferred. The claim skips exactly these too. */
  readonly excludedIds: ReadonlySet<string>;
  /** The explicitly scoped items, when the drain was given a subset. */
  readonly itemIds?: readonly string[];
}

/**
 * The owner of the next due native intent, without claiming or locking it.
 *
 * The drain has to reach Clerk for that owner before it opens the claim
 * transaction, and the outbox row itself carries no owner. This read therefore
 * has to name the row the claim will take, or the claim admits a row whose
 * live evidence belongs to somebody else and defers it.
 *
 * Naming it means applying the claim's own admissibility, not just its
 * ordering: the items this pass already deferred, the row's original lifetime
 * and its attempt ceiling. A candidate excluded here still reaches the claim,
 * which resolves it locally — expiry and attempt exhaustion must never need a
 * successful remote read first.
 *
 * The one divergence left is deliberate. This read takes no lock, so a row a
 * concurrent worker is holding can still be named here and skipped by the
 * claim. That mismatch rolls the selected sibling back, excludes the stale or
 * locked candidate for the rest of this pass, and retries the sibling with its
 * own evidence. Evidence is never transferred between owners.
 */
export async function peekNativeMorningBriefEmailOwner(
  db: Pick<Db, "select">,
  bounds: NativeMorningBriefCandidateBounds,
): Promise<NativeMorningBriefOwnerPreflight | null> {
  const [row] = await db
    .select({
      outboxId: emailOutbox.id,
      orgId: morningBriefDeliveries.orgId,
      userId: morningBriefDeliveries.userId,
      resultAttemptId: morningBriefDeliveries.resultAttemptId,
      purpose: morningBriefDeliveries.executionPurpose,
    })
    .from(emailOutbox)
    .innerJoin(
      morningBriefDeliveries,
      eq(morningBriefDeliveries.emailOutboxId, emailOutbox.id),
    )
    .where(
      and(
        bounds.itemIds === undefined
          ? undefined
          : inArray(emailOutbox.id, [...bounds.itemIds]),
        bounds.excludedIds.size === 0
          ? undefined
          : notInArray(emailOutbox.id, [...bounds.excludedIds]),
        inArray(emailOutbox.status, ["pending", "sending"]),
        // Past its own lifetime the claim fails the row without a provider
        // request, so resolving live evidence for it would be wasted work that
        // also starves an eligible sibling.
        gt(
          emailOutbox.createdAt,
          new Date(bounds.observedAt.getTime() - bounds.outboxTtlMs),
        ),
        // The claim counts this attempt as `attempts + 1`, so a row already at
        // the ceiling can only be resolved as exhausted.
        lt(emailOutbox.attempts, bounds.maxAttempts),
        or(
          isNull(emailOutbox.nextRetryAt),
          lte(emailOutbox.nextRetryAt, bounds.dueAt),
        ),
      ),
    )
    .orderBy(asc(emailOutbox.createdAt))
    .limit(1);
  return row ? { ...row, membershipId: null } : null;
}

/**
 * The member's current Clerk membership generation.
 *
 * A remove and rejoin issues a new id, and local rows can lag that by a long
 * time, so comparing two stored historical ids proves nothing about the owner
 * who exists now. This is a bounded remote read and is deliberately performed
 * before the claim transaction opens.
 */
export async function currentNativeMorningBriefMembership(
  clerk: ClerkClient,
  candidate: NativeMorningBriefOwnerPreflight,
  signal: AbortSignal,
): Promise<NativeMorningBriefOwnerPreflight> {
  const resolved = await settle(
    loadCurrentMembershipId(
      clerk,
      { orgId: candidate.orgId, userId: candidate.userId },
      signal,
    ),
    signal,
  );
  // A remote failure is not evidence about the owner. It is contained to this
  // one native candidate so the rest of the batch still drains.
  return resolved.ok
    ? { ...candidate, membershipId: resolved.value }
    : { ...candidate, membershipId: null, unavailable: true };
}

function rejected(reason: string): NativeMorningBriefEmailAdmission {
  return { kind: "rejected", reason };
}

/**
 * Decide whether one native Morning Brief outbox row may still be sent.
 *
 * This runs inside the drain's own claim transaction, immediately before the
 * provider request is committed, so it observes the owner's state as of the
 * send rather than as of enqueue. Every failure is closed, and no path here
 * can downgrade a native intent to a generic email.
 *
 * What it re-checks, and why each one is not implied by the others:
 *
 * - the delivery row itself, which is the only native provenance there is;
 * - erasure admission and the durable member row, taken in the same order the
 *   delivery transaction took them;
 * - the **frozen** membership generation recorded on the occurrence, because a
 *   member who left and rejoined is a different owner even though the
 *   organization and user identifiers match;
 * - the live canonical Morning Brief choice and its installation Agent, so a
 *   member who disabled the brief or moved it to another Agent after enqueue
 *   is not mailed;
 * - the destination thread, still owned by that Agent and that user;
 * - the recipient's current opt-out.
 *
 * Suppression stays with the shared drain, which checks the recipient address
 * for every producer. An admission that has already handed a request to the
 * provider cannot be retracted; this gate only decides whether a request is
 * made at all.
 */
/** The live evidence this claim was resolved with, or a contained refusal. */
function checkPreflight(
  outboxId: string,
  owner: { readonly orgId: string; readonly userId: string },
  membershipId: string,
  preflight: NativeMorningBriefOwnerPreflight | null,
): NativeMorningBriefEmailAdmission | null {
  if (preflight?.unavailable === true && preflight.outboxId === outboxId) {
    // Fail closed, but only for this native intent: the owner's live evidence
    // could not be read, so nothing is sent and nothing is failed. Other
    // producers and this owner's other items keep making progress.
    return {
      kind: "deferred",
      reason: "Morning Brief owner evidence is temporarily unavailable",
    };
  }
  if (
    !preflight ||
    preflight.outboxId !== outboxId ||
    preflight.orgId !== owner.orgId ||
    preflight.userId !== owner.userId
  ) {
    // The claim took a different row than the one this pass resolved live
    // evidence for. Leave it untouched rather than send on evidence that
    // belongs to somebody else.
    return {
      kind: "deferred",
      reason: "Morning Brief email has no live-owner evidence for this pass",
    };
  }
  if (preflight.sourceRefusal !== undefined) {
    return rejected(
      `Morning Brief retained source authority was revoked: ${preflight.sourceRefusal}`,
    );
  }
  if (preflight.membershipId === null) {
    return rejected(
      "Morning Brief recipient is no longer an organization member",
    );
  }
  if (preflight.membershipId !== membershipId) {
    return rejected(
      "Morning Brief recipient rejoined under a new membership generation",
    );
  }
  return null;
}

function nativeDeliverySelection() {
  return {
    orgId: morningBriefDeliveries.orgId,
    userId: morningBriefDeliveries.userId,
    scheduledFor: morningBriefDeliveries.scheduledFor,
    collectionKind: morningBriefDeliveries.collectionKind,
    collectionVersion: morningBriefDeliveries.collectionVersion,
    membershipId: morningBriefDeliveries.membershipId,
    nativeOwnerEpoch: morningBriefDeliveries.nativeOwnerEpoch,
    executionPurpose: morningBriefDeliveries.executionPurpose,
    workflowId: morningBriefDeliveries.workflowId,
    automationId: morningBriefDeliveries.automationId,
    agentId: morningBriefDeliveries.agentId,
    chatThreadId: morningBriefDeliveries.chatThreadId,
  };
}

async function loadNativeDelivery(
  tx: Tx,
  outboxId: string,
): Promise<NativeMorningBriefDelivery | undefined> {
  const [delivery] = await tx
    .select(nativeDeliverySelection())
    .from(morningBriefDeliveries)
    .where(eq(morningBriefDeliveries.emailOutboxId, outboxId))
    .limit(1);
  return delivery;
}

function sameNativeDelivery(
  left: NativeMorningBriefDelivery,
  right: NativeMorningBriefDelivery,
): boolean {
  return (
    left.orgId === right.orgId &&
    left.userId === right.userId &&
    left.scheduledFor.getTime() === right.scheduledFor.getTime() &&
    left.collectionKind === right.collectionKind &&
    left.collectionVersion === right.collectionVersion &&
    left.membershipId === right.membershipId &&
    left.nativeOwnerEpoch === right.nativeOwnerEpoch &&
    left.executionPurpose === right.executionPurpose &&
    left.workflowId === right.workflowId &&
    left.automationId === right.automationId &&
    left.agentId === right.agentId &&
    left.chatThreadId === right.chatThreadId
  );
}

async function lockNativeAuthority(
  tx: Tx,
  delivery: NativeMorningBriefDelivery,
): Promise<NativeMorningBriefEmailAdmission | null> {
  if (delivery.executionPurpose !== "production") {
    return null;
  }
  const native = await lockMorningBriefNativeSchedule(tx, delivery);
  return delivery.nativeOwnerEpoch === null ||
    native === undefined ||
    (native.phase !== "native" && native.phase !== "rollback-draining") ||
    !native.enabled ||
    native.ownerEpoch !== delivery.nativeOwnerEpoch ||
    native.membershipId !== delivery.membershipId ||
    native.agentId !== delivery.agentId ||
    native.chatThreadId !== delivery.chatThreadId
    ? rejected("Morning Brief native delivery authority was revoked")
    : null;
}

async function lockOccurrence(
  tx: Tx,
  delivery: NativeMorningBriefDelivery,
): Promise<NativeMorningBriefEmailAdmission | null> {
  const [occurrence] = await tx
    .select({ membershipId: morningBriefCollectionOccurrences.membershipId })
    .from(morningBriefCollectionOccurrences)
    .where(
      and(
        eq(morningBriefCollectionOccurrences.orgId, delivery.orgId),
        eq(morningBriefCollectionOccurrences.userId, delivery.userId),
        eq(
          morningBriefCollectionOccurrences.scheduledFor,
          delivery.scheduledFor,
        ),
        eq(
          morningBriefCollectionOccurrences.collectionKind,
          delivery.collectionKind,
        ),
        eq(
          morningBriefCollectionOccurrences.collectionVersion,
          delivery.collectionVersion,
        ),
      ),
    )
    .limit(1)
    .for("key share");
  return occurrence?.membershipId === delivery.membershipId
    ? null
    : rejected(
        "Morning Brief delivery no longer matches its frozen membership generation",
      );
}

async function lockInstallationAgent(
  tx: Tx,
  delivery: NativeMorningBriefDelivery,
): Promise<NativeMorningBriefEmailAdmission | null> {
  const [agent] = await tx
    .select({ owner: agents.owner, visibility: agents.visibility })
    .from(agents)
    .where(
      and(eq(agents.id, delivery.agentId), eq(agents.orgId, delivery.orgId)),
    )
    .limit(1)
    .for("update");
  return agent &&
    (agent.visibility !== "private" || agent.owner === delivery.userId)
    ? null
    : rejected("Morning Brief installation Agent is no longer usable");
}

function stateMatchesDelivery(
  state: Awaited<ReturnType<typeof loadMorningBriefMigrationState>>,
  delivery: NativeMorningBriefDelivery,
): boolean {
  return (
    state.kind === "installed" &&
    state.installation.id === delivery.workflowId &&
    state.installation.agentId === delivery.agentId &&
    state.automation.id === delivery.automationId &&
    state.chatThreadId === delivery.chatThreadId
  );
}

/**
 * Lock the destination and canonical installation in thread-deletion order.
 *
 * Discovery is intentionally unlocked. The exact thread, workflow/thread
 * binding, installation and automation are then locked and the canonical state
 * is resolved again after the last wait. A thread deletion that won first is
 * therefore observed; one that arrived later waits before it can detach the
 * outbox relationship.
 */
async function lockOwnerBinding(
  tx: Tx,
  delivery: NativeMorningBriefDelivery,
): Promise<NativeMorningBriefEmailAdmission | null> {
  if (delivery.executionPurpose !== "production") {
    const discovered = await loadMorningBriefMigrationState(tx, {
      orgId: delivery.orgId,
      userId: delivery.userId,
    });
    if (!stateMatchesDelivery(discovered, delivery)) {
      return rejected(
        "Morning Brief is no longer installed on the binding this delivery used",
      );
    }
  }

  const [destination] = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, delivery.chatThreadId),
        eq(chatThreads.userId, delivery.userId),
        eq(chatThreads.agentId, delivery.agentId),
      ),
    )
    .limit(1)
    .for("update");
  if (!destination) {
    return rejected("Morning Brief delivery destination is no longer owned");
  }
  if (delivery.executionPurpose === "production") {
    // Native authority was locked first. Once the canonical destination is
    // pinned too, a deleted legacy Workflow is no longer part of delivery
    // authority and cannot suppress an already-admitted native obligation.
    return null;
  }

  const [binding] = await tx
    .select({ workflowId: workflowUserAutomationThreads.workflowId })
    .from(workflowUserAutomationThreads)
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, delivery.orgId),
        eq(workflowUserAutomationThreads.userId, delivery.userId),
        eq(workflowUserAutomationThreads.workflowId, delivery.workflowId),
        eq(workflowUserAutomationThreads.chatThreadId, delivery.chatThreadId),
      ),
    )
    .limit(1)
    .for("update");
  if (!binding) {
    return rejected(
      "Morning Brief is no longer installed on the binding this delivery used",
    );
  }

  const [installation] = await tx
    .select({ agentId: workflows.agentId })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, delivery.workflowId),
        eq(workflows.orgId, delivery.orgId),
        eq(workflows.ownerUserId, delivery.userId),
      ),
    )
    .limit(1)
    .for("update");
  if (installation?.agentId !== delivery.agentId) {
    return rejected(
      "Morning Brief is no longer installed on the binding this delivery used",
    );
  }

  const [automation] = await tx
    .select({ enabled: workflowAutomations.enabled })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, delivery.automationId),
        eq(workflowAutomations.orgId, delivery.orgId),
        eq(workflowAutomations.ownerUserId, delivery.userId),
        eq(workflowAutomations.workflowId, delivery.workflowId),
      ),
    )
    .limit(1)
    .for("update");
  if (!automation?.enabled) {
    return rejected("Morning Brief is no longer enabled for this owner");
  }

  const current = await loadMorningBriefMigrationState(tx, {
    orgId: delivery.orgId,
    userId: delivery.userId,
  });
  return stateMatchesDelivery(current, delivery)
    ? null
    : rejected(
        "Morning Brief is no longer installed on the binding this delivery used",
      );
}

async function lockSubscription(
  tx: Tx,
  userId: string,
): Promise<NativeMorningBriefEmailAdmission | null> {
  // Delivery creates this row before enqueueing, so FOR UPDATE always has a
  // row to retain. Every opt-out writer upserts the same row.
  const [preference] = await tx
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .for("update")
    .limit(1);
  return preference?.emailUnsubscribed
    ? rejected("Recipient unsubscribed from optional email")
    : null;
}

/**
 * Acquire native authority and policy locks before the shared worker claims an
 * outbox row.
 *
 * Cleanup paths acquire member, thread/automation or Agent first and outbox
 * last. Mirroring that protocol here removes the old outbox → authority edge.
 * Remote membership evidence has already been resolved before this transaction.
 */
export async function lockNativeMorningBriefEmailAdmission(
  tx: Tx,
  preflight: NativeMorningBriefOwnerPreflight | null,
): Promise<LockedNativeMorningBriefEmailAdmission | null> {
  if (!preflight) {
    return null;
  }
  const delivery = await loadNativeDelivery(tx, preflight.outboxId);
  if (!delivery) {
    return {
      outboxId: preflight.outboxId,
      admission: rejected(
        "Morning Brief email has no native delivery provenance",
      ),
      delivery: null,
    };
  }

  const owner = { orgId: delivery.orgId, userId: delivery.userId };
  let admission = checkPreflight(
    preflight.outboxId,
    owner,
    delivery.membershipId,
    preflight,
  );
  if (!admission && !(await lockCollectionOwner(tx, owner))) {
    admission = rejected("Morning Brief delivery owner was revoked or erased");
  }
  admission ??= await lockNativeAuthority(tx, delivery);
  admission ??= await lockOccurrence(tx, delivery);
  admission ??= await lockInstallationAgent(tx, delivery);
  if (!admission && delivery.executionPurpose !== "production") {
    admission = await lockOwnerBinding(tx, delivery);
  }
  admission ??= await lockSubscription(tx, delivery.userId);

  return {
    outboxId: preflight.outboxId,
    admission: admission ?? { kind: "admitted" },
    delivery,
  };
}

/**
 * Revalidate the exact delivery relationship after the outbox row is locked.
 *
 * The authority locks above keep valid policy stable while this transaction
 * waits. This final read closes the earlier unlocked discovery window itself:
 * missing or changed provenance is rejected, never sent as generic email.
 */
export async function admitNativeMorningBriefEmail(
  tx: Tx,
  outboxId: string,
  locked: LockedNativeMorningBriefEmailAdmission | null,
): Promise<NativeMorningBriefEmailAdmission> {
  if (!locked || locked.outboxId !== outboxId) {
    // A provenance-free native template can appear here without a preflight,
    // because candidate discovery joins through the delivery row. Resolve that
    // corrupt state instead of deferring it forever; a valid delivery selected
    // by a different concurrent claim still waits for its own live evidence.
    const delivery = await loadNativeDelivery(tx, outboxId);
    return delivery
      ? {
          kind: "deferred",
          reason:
            "Morning Brief email has no live-owner evidence for this pass",
        }
      : rejected("Morning Brief email has no native delivery provenance");
  }
  if (locked.admission.kind !== "admitted") {
    return locked.admission;
  }
  if (!locked.delivery) {
    return rejected("Morning Brief email has no native delivery provenance");
  }
  const current = await loadNativeDelivery(tx, outboxId);
  return current && sameNativeDelivery(current, locked.delivery)
    ? { kind: "admitted" }
    : rejected("Morning Brief email native delivery provenance changed");
}
