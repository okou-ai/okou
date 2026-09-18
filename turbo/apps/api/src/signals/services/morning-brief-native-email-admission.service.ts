import { agents } from "@okouai/db/schema/agent";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { users } from "@okouai/db/schema/user";
import { workflowAutomations } from "@okouai/db/schema/workflow";
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

/** Live-owner evidence resolved outside the claim transaction. */
export interface NativeMorningBriefOwnerPreflight {
  /** The exact candidate this evidence was resolved for. */
  readonly outboxId: string;
  readonly orgId: string;
  readonly userId: string;
  /** The member's current Clerk membership, or null when they are not one. */
  readonly membershipId: string | null;
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

/**
 * The exact installation, schedule and Agent this delivery acted under, all
 * still current and still enabled.
 *
 * Comparing the Agent alone would let a reinstalled brief on the same Agent
 * authorize the previous installation's mail. The Agent row is locked before
 * the automation, because Chat delivery takes those two rows in that order;
 * the opposite order here would let a delivery holding the Agent and a drain
 * holding the automation wait on each other.
 */
async function checkOwnerBinding(
  tx: Tx,
  delivery: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly automationId: string;
    readonly agentId: string;
  },
): Promise<NativeMorningBriefEmailAdmission | null> {
  const [agent] = await tx
    .select({
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(
      and(eq(agents.id, delivery.agentId), eq(agents.orgId, delivery.orgId)),
    )
    .limit(1)
    .for("update");
  if (
    !agent ||
    (agent.visibility === "private" && agent.owner !== delivery.userId)
  ) {
    return rejected("Morning Brief installation Agent is no longer usable");
  }

  const state = await loadMorningBriefMigrationState(tx, {
    orgId: delivery.orgId,
    userId: delivery.userId,
  });
  if (
    state.kind !== "installed" ||
    state.installation.id !== delivery.workflowId ||
    state.installation.agentId !== delivery.agentId ||
    state.automation.id !== delivery.automationId
  ) {
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
  return automation?.enabled
    ? null
    : rejected("Morning Brief is no longer enabled for this owner");
}

/** The destination thread this delivery wrote to, still owned by that Agent. */
async function checkDestination(
  tx: Tx,
  delivery: {
    readonly userId: string;
    readonly agentId: string;
    readonly chatThreadId: string;
  },
): Promise<NativeMorningBriefEmailAdmission | null> {
  const [destination] = await tx
    .select({ threadId: chatThreads.id })
    .from(chatThreads)
    .innerJoin(
      agents,
      and(eq(agents.id, chatThreads.agentId), eq(agents.id, delivery.agentId)),
    )
    .where(
      and(
        eq(chatThreads.id, delivery.chatThreadId),
        eq(chatThreads.userId, delivery.userId),
      ),
    )
    .limit(1);
  return destination
    ? null
    : rejected("Morning Brief delivery destination is no longer owned");
}

/**
 * Decide whether one native Morning Brief outbox row may still be sent.
 *
 * This runs inside the drain's own claim transaction, immediately before the
 * provider request is committed, so it observes the owner's state as of the
 * send rather than as of enqueue. Every failure is closed, and no path here
 * can downgrade a native intent to a generic email. An admission that has
 * already handed a request to the provider cannot be retracted; this gate only
 * decides whether a request is made at all.
 */
export async function admitNativeMorningBriefEmail(
  tx: Tx,
  outboxId: string,
  preflight: NativeMorningBriefOwnerPreflight | null,
): Promise<NativeMorningBriefEmailAdmission> {
  const [delivery] = await tx
    .select({
      orgId: morningBriefDeliveries.orgId,
      userId: morningBriefDeliveries.userId,
      scheduledFor: morningBriefDeliveries.scheduledFor,
      collectionKind: morningBriefDeliveries.collectionKind,
      collectionVersion: morningBriefDeliveries.collectionVersion,
      membershipId: morningBriefDeliveries.membershipId,
      workflowId: morningBriefDeliveries.workflowId,
      automationId: morningBriefDeliveries.automationId,
      agentId: morningBriefDeliveries.agentId,
      chatThreadId: morningBriefDeliveries.chatThreadId,
    })
    .from(morningBriefDeliveries)
    .where(eq(morningBriefDeliveries.emailOutboxId, outboxId))
    .limit(1);
  if (!delivery) {
    return rejected("Morning Brief email has no native delivery provenance");
  }

  const owner = { orgId: delivery.orgId, userId: delivery.userId };
  const preflightRefusal = checkPreflight(
    outboxId,
    owner,
    delivery.membershipId,
    preflight,
  );
  if (preflightRefusal) {
    return preflightRefusal;
  }

  if (!(await lockCollectionOwner(tx, owner))) {
    return rejected("Morning Brief delivery owner was revoked or erased");
  }

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
    .limit(1);
  if (!occurrence || occurrence.membershipId !== delivery.membershipId) {
    return rejected(
      "Morning Brief delivery no longer matches its frozen membership generation",
    );
  }

  const bindingRefusal = await checkOwnerBinding(tx, delivery);
  if (bindingRefusal) {
    return bindingRefusal;
  }

  const destinationRefusal = await checkDestination(tx, delivery);
  if (destinationRefusal) {
    return destinationRefusal;
  }

  // The delivery transaction created this row before deciding, so the lock has
  // something to take. Explicit unsubscribe and complaint handling upsert the
  // same row, which is what serializes them with this decision.
  const [preference] = await tx
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, delivery.userId))
    .for("update")
    .limit(1);
  if (preference?.emailUnsubscribed ?? false) {
    return rejected("Recipient unsubscribed from optional email");
  }

  return { kind: "admitted" };
}
