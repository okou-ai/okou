import { agents } from "@okouai/db/schema/agent";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { users } from "@okouai/db/schema/user";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { command } from "ccstate";

import type { Tx } from "../../lib/db-types";
import { clerk$ } from "../external/clerk";
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

export type NativeMorningBriefEmailAdmission =
  | { readonly kind: "admitted" }
  | { readonly kind: "rejected"; readonly reason: string }
  /** No usable live-owner evidence this pass. Nothing is sent or failed. */
  | { readonly kind: "deferred"; readonly reason: string };

/** Live-owner evidence resolved outside the claim transaction. */
export interface NativeMorningBriefOwnerPreflight {
  readonly orgId: string;
  readonly userId: string;
  /** The member's current Clerk membership, or null when they are not one. */
  readonly membershipId: string | null;
}

/**
 * The owner of the next due native intent, without claiming or locking it.
 *
 * The drain has to reach Clerk for that owner before it opens the claim
 * transaction, and the outbox row itself carries no owner. This read uses the
 * same due-item ordering the claim uses, so it normally names the row the claim
 * will take. When a concurrent worker takes a different one, the mismatch is
 * detected inside the transaction and that row is simply left for the next
 * pass rather than sent on stale evidence.
 */
export async function peekNativeMorningBriefEmailOwner(
  db: Pick<Db, "select">,
  currentTime: Date,
  itemIds?: readonly string[],
): Promise<NativeMorningBriefOwnerPreflight | null> {
  const [row] = await db
    .select({
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
        itemIds === undefined
          ? undefined
          : inArray(emailOutbox.id, [...itemIds]),
        inArray(emailOutbox.status, ["pending", "sending"]),
        or(
          isNull(emailOutbox.nextRetryAt),
          lte(emailOutbox.nextRetryAt, currentTime),
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
export const currentNativeMorningBriefMembership$ = command(
  async (
    { get },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<NativeMorningBriefOwnerPreflight> => {
    const memberships = await get(
      clerk$,
    ).organizations.getOrganizationMembershipList(
      { organizationId: owner.orgId, userId: [owner.userId], limit: 1 },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    const membership = memberships.data.find((entry) => {
      return (
        entry.publicUserData?.userId === owner.userId &&
        entry.organization.id === owner.orgId
      );
    });
    return { ...owner, membershipId: membership?.id ?? null };
  },
);

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
/**
 * Re-check the owner's live Morning Brief choice for one queued native email.
 *
 * Once the member is in the native phase, the durable native row is the whole
 * choice: no live Official Workflow installation, catalog reconciliation or
 * legacy `enabled` bit is consulted, so an email enqueued by a native delivery
 * still sends after legacy scheduling has been disabled. The epoch recorded on
 * the delivery must still be the member's current one, which is what stops a
 * revoked occurrence's mail from going out after a disable and re-enable.
 *
 * Every other phase keeps the previous behaviour exactly: the installation,
 * schedule and Agent must all still be current, and the automation row is
 * locked rather than read so a mid-flight disable is waited for.
 *
 * Returns `null` when the owner still permits the send.
 */
/**
 * Prove the recipient is still the same member generation this delivery owned.
 *
 * Split out of {@link admitNativeMorningBriefEmail}; the reads, locks and their
 * order are unchanged. Returns `null` when the member still permits the send.
 */
async function admitMemberGenerationForNativeEmail(
  tx: Tx,
  owner: { readonly orgId: string; readonly userId: string },
  args: {
    readonly preflightMembershipId: string | null;
    readonly delivery: {
      readonly orgId: string;
      readonly userId: string;
      readonly scheduledFor: Date;
      readonly collectionKind: string;
      readonly collectionVersion: number;
      readonly membershipId: string;
    };
  },
): Promise<NativeMorningBriefEmailAdmission | null> {
  const preflight = { membershipId: args.preflightMembershipId };
  const delivery = args.delivery;
  if (preflight.membershipId === null) {
    return rejected(
      "Morning Brief recipient is no longer an organization member",
    );
  }
  if (preflight.membershipId !== delivery.membershipId) {
    return rejected(
      "Morning Brief recipient rejoined under a new membership generation",
    );
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

  return null;
}

async function admitOwnerChoiceForNativeEmail(
  tx: Tx,
  owner: { readonly orgId: string; readonly userId: string },
  delivery: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly automationId: string;
    readonly agentId: string;
  },
): Promise<NativeMorningBriefEmailAdmission | null> {
  const native = await lockMorningBriefNativeSchedule(tx, owner);
  if (native !== undefined && native.phase === "native") {
    if (!native.enabled) {
      return rejected("Morning Brief is no longer enabled for this owner");
    }
    if (native.agentId !== delivery.agentId) {
      return rejected(
        "Morning Brief now speaks as a different Agent than this delivery used",
      );
    }
    return null;
  }

  // The exact installation, schedule and Agent this delivery acted under, all
  // still current and still enabled. Comparing the Agent alone would let a
  // reinstalled brief on the same Agent authorize the previous installation's
  // mail. The automation row is locked rather than read, so a disable that is
  // mid-flight is waited for instead of missed.
  const state = await loadMorningBriefMigrationState(tx, owner);
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
  if (!automation?.enabled) {
    return rejected("Morning Brief is no longer enabled for this owner");
  }

  return null;
}

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
  if (
    !preflight ||
    preflight.orgId !== owner.orgId ||
    preflight.userId !== owner.userId
  ) {
    // The claim took a different row than the one this pass resolved live
    // evidence for. Leave it untouched for the next pass rather than send on
    // evidence that belongs to somebody else.
    return {
      kind: "deferred",
      reason: "Morning Brief email has no live-owner evidence for this pass",
    };
  }
  const member = await admitMemberGenerationForNativeEmail(tx, owner, {
    preflightMembershipId: preflight.membershipId,
    delivery,
  });
  if (member !== null) {
    return member;
  }

  const binding = await admitOwnerChoiceForNativeEmail(tx, owner, delivery);
  if (binding !== null) {
    return binding;
  }

  // The installation Agent must still be one this member may actually use: a
  // deleted Agent, or a private Agent that now belongs to somebody else, is a
  // missing Agent rather than a reason to send under a substitute.
  const [agent] = await tx
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(
      and(eq(agents.id, delivery.agentId), eq(agents.orgId, delivery.orgId)),
    )
    .limit(1);
  if (
    !agent ||
    (agent.visibility === "private" && agent.owner !== delivery.userId)
  ) {
    return rejected("Morning Brief installation Agent is no longer usable");
  }

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
  if (!destination) {
    return rejected("Morning Brief delivery destination is no longer owned");
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

  // The subscription lock above can wait, and the Agent writers take this row
  // when they change visibility or owner. Re-reading it under a conflicting
  // lock after that wait is what stops an Agent that became private while this
  // claim was held from still authorising the send.
  const [held] = await tx
    .select({ owner: agents.owner, visibility: agents.visibility })
    .from(agents)
    .where(
      and(eq(agents.id, delivery.agentId), eq(agents.orgId, delivery.orgId)),
    )
    .limit(1)
    .for("update");
  if (
    !held ||
    (held.visibility === "private" && held.owner !== delivery.userId)
  ) {
    return rejected("Morning Brief installation Agent is no longer usable");
  }

  return { kind: "admitted" };
}
