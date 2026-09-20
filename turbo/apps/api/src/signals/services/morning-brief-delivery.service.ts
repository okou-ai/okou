import { createHash } from "node:crypto";

import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { agents } from "@okouai/db/schema/agent";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { morningBriefCollectionOccurrences } from "@okouai/db/schema/morning-brief-collection-occurrence";
import {
  morningBriefDeliveries,
  type MorningBriefDeliveryEmailResolution,
  type MorningBriefDeliveryPurpose,
} from "@okouai/db/schema/morning-brief-delivery";
import { morningBriefGenerations } from "@okouai/db/schema/morning-brief-generation";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Tx } from "../../lib/db-types";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { safeSync, settle } from "../utils";
import { insertChatEvent } from "./chat-event.service";
import { touchChatThreadLastMessageAt } from "./chat-event-shared.service";
import {
  buildFromAddress,
  buildOneClickUnsubscribeUrl,
  buildUnsubscribeHeaders,
  EMAIL_PUBLIC_BRAND,
} from "./email-common.service";
import { currentMorningBriefCollectionAuthority$ } from "./morning-brief-collection-executor.service";
import { revalidateMorningBriefStoredGenerationSources$ } from "./morning-brief-generation-source-revalidation.service";
import { retainMorningBriefGenerationProofUntil } from "./morning-brief-generation-store.service";
import {
  lockCollectionOwner,
  type MorningBriefCollectionAdmission,
} from "./morning-brief-collection-occurrence.service";
import { MORNING_BRIEF_RESULT_EMAIL_TEMPLATE } from "./morning-brief-native-email-admission.service";
import {
  bindMorningBriefNativeThread,
  lockMorningBriefNativeSchedule,
  type MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import {
  excludeMorningBriefChatThread,
  ORDINARY_CHAT_THREAD_PROVENANCE,
} from "./morning-brief-thread-provenance.service";
import {
  MORNING_BRIEF_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS,
  MORNING_BRIEF_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
  MorningBriefResultEmailRenderError,
  renderMorningBriefResultEmail,
} from "./morning-brief-result-email-renderer";
import { morningBriefDescriptorRetainUntil } from "./morning-brief-source-authority";
import {
  ensureWorkflowUserAutomationThread,
  loadWorkflowUserAutomationThreadId,
} from "./workflow-user-automation-thread.service";

const log = logger("MorningBriefDelivery");

/**
 * Deliver one already accepted Morning Brief result.
 *
 * Nothing here collects, prompts, invokes a provider, starts a Run or touches
 * credits. Its only input is a reference to a result that S5 already persisted,
 * and the body it delivers is exactly the Markdown that was accepted then.
 *
 * The transaction is the contract: the sticky thread exclusion, the canonical
 * run-less assistant message, the thread's ordering touch, the delivery
 * identity and the email intent all commit together or not at all. The realtime
 * notification is the only thing that happens afterwards, and it is
 * best-effort: a failed publish must never replay a committed delivery.
 */

export type MorningBriefDeliveryRejection =
  /** No result for this reference under this owner and purpose. */
  | "result-not-found"
  /** The referenced generation is not an accepted deliverable result. */
  | "result-not-deliverable"
  /** The result's bounded retention has elapsed. */
  | "result-expired"
  /** Morning Brief is not installed and enabled for this member. */
  | "morning-brief-unavailable"
  /** The implementation switch is off for this caller. */
  | "implementation-disabled"
  /** Membership, Agent or erasure state no longer admits a write. */
  | "owner-revoked"
  /** The member's installation has no Agent to own a destination thread. */
  | "destination-unavailable";

interface MorningBriefDeliveryOutcome {
  readonly kind: "delivered" | "already-delivered";
  readonly chatThreadId: string;
  readonly chatEventId: string;
  readonly emailResolution: MorningBriefDeliveryEmailResolution;
  readonly deliveredAt: string;
}

type MorningBriefDeliveryResult =
  | MorningBriefDeliveryOutcome
  | {
      readonly kind: "rejected";
      readonly reason: MorningBriefDeliveryRejection;
    };

/** The transaction's own answer, before it is rendered for the caller. */
type CommittedDelivery = {
  readonly kind: "delivered" | "already-delivered";
  readonly chatThreadId: string;
  readonly chatEventId: string;
  readonly emailResolution: MorningBriefDeliveryEmailResolution;
  readonly deliveredAt: Date;
  readonly seqId?: number;
};

/** Translate a live-authority refusal into this route's own vocabulary. */
function rejectionOf(reason: string): MorningBriefDeliveryRejection {
  if (reason === "feature-disabled") {
    return "implementation-disabled";
  }
  if (reason === "membership-revoked") {
    return "owner-revoked";
  }
  return reason === "missing-agent"
    ? "destination-unavailable"
    : "morning-brief-unavailable";
}

/**
 * The validated native execution authority a production delivery must present.
 *
 * It is the epoch and membership generation the occurrence was *claimed* under,
 * not whatever the row holds now: a disable and re-enable, a destination
 * replacement or a transfer all bump the epoch, and an occurrence admitted
 * before that must not deliver.
 */
interface MorningBriefNativeDeliveryAuthority {
  readonly ownerEpoch: number;
  readonly membershipId: string;
}

type MorningBriefDeliveryRequest = {
  readonly orgId: string;
  readonly userId: string;
  /** The opaque attempt the generation returned. Never an owner. */
  readonly resultAttemptId: string;
} & (
  | {
      /** Preview is the compatibility default for the operator-only route. */
      readonly purpose?: "preview";
      readonly nativeAuthority?: never;
    }
  | {
      /** Production effects always carry the occurrence authority that paid. */
      readonly purpose: "production";
      readonly nativeAuthority: MorningBriefNativeDeliveryAuthority;
    }
);

function resultDigest(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function deliverySubject(title: string): string {
  return title.length <= MORNING_BRIEF_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS
    ? title
    : `${title.slice(0, MORNING_BRIEF_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS - 1)}…`;
}

function deliveryTitle(title: string): string {
  return title.length <= MORNING_BRIEF_RESULT_EMAIL_TITLE_MAX_CHARACTERS
    ? title
    : `${title.slice(0, MORNING_BRIEF_RESULT_EMAIL_TITLE_MAX_CHARACTERS - 1)}…`;
}

/**
 * Resolve the recipient without refilling an erased cache.
 *
 * The shared `getUserEmail` helper repopulates `user_cache` from Clerk on a
 * miss. A delivery must never be the thing that resurrects an erased user's
 * address, so this reads the cache only and treats a miss as "no address". The
 * owner keeps their Chat delivery either way.
 */
async function resolveCachedRecipient(
  tx: Tx,
  userId: string,
): Promise<string | null> {
  const [cached] = await tx
    .select({ email: userCache.email })
    .from(userCache)
    .where(eq(userCache.userId, userId))
    .limit(1);
  return cached?.email ?? null;
}

interface EmailIntent {
  readonly resolution: MorningBriefDeliveryEmailResolution;
  readonly outboxId: string | null;
  readonly outboxCreatedAt: Date | null;
}

/**
 * Decide and, when admitted, create this delivery's single email intent.
 *
 * The opt-out row is created and locked before the decision, so a concurrent
 * first-time unsubscribe either commits before this lock and is observed, or
 * waits for this transaction and applies to the next delivery. `FOR UPDATE` on
 * a row that does not exist locks nothing, which is exactly why the row is
 * inserted first.
 *
 * Suppression is checked here as well as by the shared drain: an already
 * suppressed address should not produce an intent at all, and the drain still
 * owns the decision for an address suppressed after enqueue.
 */
async function resolveEmailIntent(
  tx: Tx,
  args: {
    readonly userId: string;
    readonly unsubscribed: boolean;
    readonly threadUrl: string;
    readonly manageUrl: string;
    readonly title: string;
    readonly markdown: string;
  },
): Promise<EmailIntent> {
  if (args.unsubscribed) {
    return {
      resolution: "unsubscribed",
      outboxId: null,
      outboxCreatedAt: null,
    };
  }

  const recipient = await resolveCachedRecipient(tx, args.userId);
  if (!recipient) {
    return { resolution: "no_email", outboxId: null, outboxCreatedAt: null };
  }

  const [suppressed] = await tx
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(
      eq(
        sql`lower(${emailSuppressions.emailAddress})`,
        recipient.toLowerCase(),
      ),
    )
    .limit(1);
  if (suppressed) {
    return { resolution: "suppressed", outboxId: null, outboxCreatedAt: null };
  }

  const unsubscribeUrl = buildOneClickUnsubscribeUrl(args.userId);
  const props = {
    title: deliveryTitle(args.title),
    resultMarkdown: args.markdown,
    threadUrl: args.threadUrl,
    manageUrl: args.manageUrl,
  };
  // Rendered here only to prove the accepted body survives this template. The
  // outbox still stores template plus props, so the first delivery attempt
  // renders under the then-current template version.
  const rendered = safeSync(() => {
    return renderMorningBriefResultEmail(props, unsubscribeUrl);
  });
  if ("error" in rendered) {
    if (!(rendered.error instanceof MorningBriefResultEmailRenderError)) {
      throw rendered.error;
    }
    log.warn("Morning Brief result cannot be carried by email", {
      reason: rendered.error.message,
    });
    return {
      resolution: "render_rejected",
      outboxId: null,
      outboxCreatedAt: null,
    };
  }

  const [row] = await tx
    .insert(emailOutbox)
    .values({
      fromAddress: buildFromAddress(),
      toAddresses: recipient,
      subject: deliverySubject(args.title),
      headers: buildUnsubscribeHeaders(unsubscribeUrl),
      publicBrand: EMAIL_PUBLIC_BRAND,
      template: { template: MORNING_BRIEF_RESULT_EMAIL_TEMPLATE, props },
      status: "pending",
      attempts: 0,
    })
    .returning({ id: emailOutbox.id, createdAt: emailOutbox.createdAt });
  if (!row) {
    throw new Error("Morning Brief email intent was not created");
  }
  return {
    resolution: "enqueued",
    outboxId: row.id,
    outboxCreatedAt: row.createdAt,
  };
}

/** The occurrence one accepted result belongs to. */
interface ResultAnchor {
  readonly scheduledFor: Date;
  readonly collectionKind: string;
  readonly collectionVersion: number;
}

interface DeliverableResult {
  readonly membershipId: string;
  readonly reservedAt: Date;
  readonly title: string;
  readonly markdown: string;
}

function occurrenceKeyCondition(
  owner: { readonly orgId: string; readonly userId: string },
  anchor: ResultAnchor,
) {
  return and(
    eq(morningBriefCollectionOccurrences.orgId, owner.orgId),
    eq(morningBriefCollectionOccurrences.userId, owner.userId),
    eq(morningBriefCollectionOccurrences.scheduledFor, anchor.scheduledFor),
    eq(morningBriefCollectionOccurrences.collectionKind, anchor.collectionKind),
    eq(
      morningBriefCollectionOccurrences.collectionVersion,
      anchor.collectionVersion,
    ),
  );
}

function generationReferenceCondition(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly resultAttemptId: string;
  readonly purpose: MorningBriefDeliveryPurpose;
}) {
  return and(
    eq(morningBriefGenerations.orgId, args.orgId),
    eq(morningBriefGenerations.userId, args.userId),
    eq(morningBriefGenerations.attemptId, args.resultAttemptId),
    eq(morningBriefGenerations.executionPurpose, args.purpose),
  );
}

/**
 * Which occurrence the caller's reference names, and nothing more.
 *
 * The reference is opaque and this lookup is owner-scoped, so another member's
 * attempt does not resolve at all. It deliberately reads no content and grants
 * no authority: it exists so the live authority below can be resolved for the
 * right anchor before any lock is taken.
 */
async function loadResultAnchor(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly resultAttemptId: string;
    readonly purpose: MorningBriefDeliveryPurpose;
  },
): Promise<ResultAnchor | undefined> {
  const [row] = await db
    .select({
      scheduledFor: morningBriefGenerations.scheduledFor,
      collectionKind: morningBriefGenerations.collectionKind,
      collectionVersion: morningBriefGenerations.collectionVersion,
    })
    .from(morningBriefGenerations)
    .where(generationReferenceCondition(args))
    .limit(1);
  return row;
}

/**
 * Release the accepted content behind the caller's reference.
 *
 * Purpose, state, decision and the result's own retention are all part of the
 * match: a skip, a failed attempt, a reserved slot and an expired result are
 * not deliverable. `at` is the post-lock instant, so a result that expired
 * while this transaction waited is refused rather than delivered; equality with
 * the deadline is already expired.
 */
async function loadDeliverableResult(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly resultAttemptId: string;
    readonly purpose: MorningBriefDeliveryPurpose;
    readonly at: Date;
  },
): Promise<DeliverableResult> {
  const [row] = await tx
    .select({
      membershipId: morningBriefGenerations.membershipId,
      reservedAt: morningBriefGenerations.reservedAt,
      state: morningBriefGenerations.state,
      decision: morningBriefGenerations.decision,
      title: morningBriefGenerations.resultTitle,
      markdown: morningBriefGenerations.resultMarkdown,
      expiresAt: morningBriefGenerations.expiresAt,
    })
    .from(morningBriefGenerations)
    .where(generationReferenceCondition(args))
    .limit(1);
  if (!row) {
    throw new DeliveryRejected("result-not-found");
  }
  if (
    row.state !== "succeeded" ||
    row.decision !== "deliver" ||
    row.title === null ||
    row.markdown === null
  ) {
    throw new DeliveryRejected("result-not-deliverable");
  }
  if (row.expiresAt.getTime() <= args.at.getTime()) {
    throw new DeliveryRejected("result-expired");
  }
  return {
    membershipId: row.membershipId,
    reservedAt: row.reservedAt,
    title: row.title,
    markdown: row.markdown,
  };
}

/**
 * The delivery a result reference already produced, if any.
 *
 * This is the durable mapping the generation row cannot provide: its own
 * retention sweep deletes it, while the delivery survives. Scoped to the
 * caller's organization and user, so a foreign reference resolves to nothing.
 */
async function loadDeliveryByAttempt(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly resultAttemptId: string;
    readonly purpose: MorningBriefDeliveryPurpose;
  },
) {
  const [row] = await db
    .select({
      chatThreadId: morningBriefDeliveries.chatThreadId,
      chatEventId: morningBriefDeliveries.chatEventId,
      emailResolution: morningBriefDeliveries.emailResolution,
      deliveredAt: morningBriefDeliveries.deliveredAt,
    })
    .from(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, args.orgId),
        eq(morningBriefDeliveries.userId, args.userId),
        eq(morningBriefDeliveries.executionPurpose, args.purpose),
        eq(morningBriefDeliveries.resultAttemptId, args.resultAttemptId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The delivery this occurrence already has, if any.
 *
 * Read before deliverability and expiry on purpose. Once a delivery has
 * committed, a repeated or replayed request has to be able to recover its
 * identity even though the source result has since expired or been swept —
 * recovery returns only that identity, never expired content, and only inside
 * the caller's own owner scope.
 */
async function loadExistingDelivery(
  tx: Tx,
  owner: { readonly orgId: string; readonly userId: string },
  anchor: ResultAnchor,
) {
  const [row] = await tx
    .select({
      chatThreadId: morningBriefDeliveries.chatThreadId,
      chatEventId: morningBriefDeliveries.chatEventId,
      emailResolution: morningBriefDeliveries.emailResolution,
      deliveredAt: morningBriefDeliveries.deliveredAt,
    })
    .from(morningBriefDeliveries)
    .where(
      and(
        eq(morningBriefDeliveries.orgId, owner.orgId),
        eq(morningBriefDeliveries.userId, owner.userId),
        eq(morningBriefDeliveries.scheduledFor, anchor.scheduledFor),
        eq(morningBriefDeliveries.collectionKind, anchor.collectionKind),
        eq(morningBriefDeliveries.collectionVersion, anchor.collectionVersion),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The instant this delivery commits, never earlier than what the thread has
 * already recorded.
 *
 * The clock is read only after every blocking lock is held, so a concurrent
 * Run terminal marker, another delivery or a mark-read that committed while
 * this transaction waited is already visible. It is still possible for that
 * commit to carry a later wall-clock timestamp than this sample, which would
 * hide the brief behind the read cursor and leave it permanently read. The
 * watermark and the read cursor the thread already holds are therefore the
 * floor: a delivery is always strictly newer than both.
 */
async function monotonicDeliveryInstant(
  tx: Tx,
  chatThreadId: string,
  at: Date,
): Promise<Date> {
  const [thread] = await tx
    .select({ lastReadAt: chatThreads.lastReadAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  const [terminal] = await tx
    .select({ createdAt: chatEvents.createdAt })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        chatEventTerminalPredicate(chatEvents.eventType),
      ),
    )
    .orderBy(desc(chatEvents.createdAt))
    .limit(1);
  const [delivered] = await tx
    .select({ deliveredAt: morningBriefDeliveries.deliveredAt })
    .from(morningBriefDeliveries)
    .where(eq(morningBriefDeliveries.chatThreadId, chatThreadId))
    .orderBy(desc(morningBriefDeliveries.deliveredAt))
    .limit(1);
  const floor = Math.max(
    thread?.lastReadAt?.getTime() ?? 0,
    terminal?.createdAt.getTime() ?? 0,
    delivered?.deliveredAt.getTime() ?? 0,
  );
  return at.getTime() > floor ? at : new Date(floor + 1);
}

/**
 * Resolve the destination thread, locking the thread before its binding.
 *
 * Thread deletion locks the thread row and then the automation binding, so
 * delivery has to take the same two locks in the same order or the two can
 * deadlock. The binding is read unlocked first only to find the thread; the
 * authoritative binding lock is still taken inside
 * `ensureWorkflowUserAutomationThread`, and its answer is what this returns. A
 * binding that moved between the unlocked read and that lock simply resolves to
 * the thread the locked read reports.
 */
async function resolveDestinationThread(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowName: string;
    readonly at: Date;
  },
): Promise<string> {
  const boundThreadId = await loadWorkflowUserAutomationThreadId(tx, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.workflowId,
  });
  if (boundThreadId) {
    await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, boundThreadId))
      .limit(1)
      .for("update");
  }
  return await ensureWorkflowUserAutomationThread(tx, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.workflowId,
    agentId: args.agentId,
    workflowTitle: args.workflowName,
    currentTime: args.at,
  });
}

/**
 * The binding a delivery is allowed to act under.
 *
 * Both the occurrence that produced the result and the owner's live canonical
 * state have to agree on all four fields. Comparing the occurrence to itself
 * would only prove history is self-consistent, and comparing Agent identity
 * alone would let a reinstalled brief on the same Agent authorize the previous
 * installation's work.
 */
function sameBinding(
  left: {
    readonly membershipId: string;
    readonly workflowId: string;
    readonly automationId: string;
    readonly agentId: string;
  },
  right: {
    readonly membershipId: string;
    readonly workflowId: string;
    readonly automationId: string;
    readonly agentId: string;
  },
): boolean {
  return (
    left.membershipId === right.membershipId &&
    left.workflowId === right.workflowId &&
    left.automationId === right.automationId &&
    left.agentId === right.agentId
  );
}

/**
 * A rejection discovered after the transaction has prepared anything.
 *
 * Resolving the destination can create a thread and its automation binding, and
 * the shared helper may stamp provenance on a reused one. A later rejection
 * that simply returned would commit those writes for a delivery that never
 * happened, so every decision from that point on unwinds the transaction
 * instead. Read-only rejections before it return normally.
 */
class DeliveryCancelled extends Error {
  constructor() {
    super("Morning Brief delivery was cancelled before it was accepted");
    this.name = "DeliveryCancelled";
  }
}

/**
 * Stop a not-yet-accepted delivery the caller has abandoned.
 *
 * The transaction does most of its waiting on row locks, and PostgreSQL does
 * not surrender those to an abort signal, so cancellation is observed at each
 * point a wait has just finished. Throwing unwinds the prepared destination and
 * provenance writes; a delivery that has already committed is never replayed or
 * undone by a late cancellation.
 */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DeliveryCancelled();
  }
}

class DeliveryRejected extends Error {
  constructor(readonly reason: MorningBriefDeliveryRejection) {
    super(`Morning Brief delivery rejected: ${reason}`);
    this.name = "DeliveryRejected";
  }
}

/**
 * Take the Agent row this delivery depends on and prove the member may use it.
 *
 * The external preflight resolved the Agent before this transaction opened, and
 * this transaction can then wait a long time on the occurrence, thread and
 * binding locks. The Agent writers lock this same row when they change
 * visibility or owner, so taking it here is what stops an Agent that became
 * private — or moved to another member — from being written to anyway. A
 * matching Agent id proves existence, never access.
 */
async function lockUsableAgent(
  tx: Tx,
  owner: { readonly orgId: string; readonly userId: string },
  agentId: string,
): Promise<void> {
  const [agent] = await tx
    .select({ owner: agents.owner, visibility: agents.visibility })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, owner.orgId)))
    .limit(1)
    .for("update");
  if (
    !agent ||
    (agent.visibility === "private" && agent.owner !== owner.userId)
  ) {
    throw new DeliveryRejected("destination-unavailable");
  }
}

/**
 * Create this owner's subscription row and hold it.
 *
 * `FOR UPDATE` on a row that does not exist locks nothing, so the row is
 * inserted first. This is the last admission wait in the transaction, and it is
 * deliberately taken *before* the final freshness decision: a delivery that
 * queues behind a concurrent unsubscribe must re-evaluate the result's deadline
 * after that wait, not before it.
 */
async function lockSubscription(
  tx: Tx,
  userId: string,
): Promise<{ readonly unsubscribed: boolean }> {
  await tx
    .insert(users)
    .values({ id: userId })
    .onConflictDoNothing({ target: users.id });
  const [preference] = await tx
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .for("update")
    .limit(1);
  return { unsubscribed: preference?.emailUnsubscribed ?? false };
}

/**
 * Everything a delivery must hold and prove before it may write anything.
 *
 * Returns the committed delivery when this occurrence already has one, so the
 * caller can answer a repeat request without preparing a destination.
 */
type DeliveryAdmission =
  | CommittedDelivery
  | {
      readonly kind: "admitted";
      readonly native: MorningBriefNativeScheduleRow | null;
    };

async function admitDelivery(
  tx: Tx,
  args: {
    readonly request: MorningBriefDeliveryRequest;
    readonly purpose: MorningBriefDeliveryPurpose;
    readonly anchor: ResultAnchor;
    readonly current: MorningBriefCollectionAdmission;
  },
  signal: AbortSignal,
): Promise<DeliveryAdmission> {
  const { request, anchor, current } = args;
  const owner = { orgId: request.orgId, userId: request.userId };

  // Erasure admission and the durable member row first, in the same order
  // collection and generation take them.
  if (!(await lockCollectionOwner(tx, owner))) {
    throw new DeliveryRejected("owner-revoked");
  }

  let native: MorningBriefNativeScheduleRow | null = null;
  if (args.purpose === "production") {
    const presented = request.nativeAuthority;
    const locked = await lockMorningBriefNativeSchedule(tx, owner);
    if (
      presented === undefined ||
      locked === undefined ||
      (locked.phase !== "native" && locked.phase !== "rollback-draining") ||
      !locked.enabled ||
      locked.ownerEpoch !== presented.ownerEpoch ||
      locked.membershipId !== presented.membershipId ||
      locked.agentId !== current.agentId
    ) {
      throw new DeliveryRejected("owner-revoked");
    }
    native = locked;
  }

  // The occurrence row is this delivery's serialization point. Two callers for
  // the same occurrence contend here, so the second observes the first one's
  // committed delivery instead of racing it to a duplicate key.
  const [occurrence] = await tx
    .select({
      membershipId: morningBriefCollectionOccurrences.membershipId,
      workflowId: morningBriefCollectionOccurrences.workflowId,
      automationId: morningBriefCollectionOccurrences.automationId,
      agentId: morningBriefCollectionOccurrences.agentId,
    })
    .from(morningBriefCollectionOccurrences)
    .where(occurrenceKeyCondition(owner, anchor))
    .limit(1)
    .for("update");
  if (!occurrence) {
    throw new DeliveryRejected("owner-revoked");
  }
  throwIfCancelled(signal);

  const existing = await loadExistingDelivery(tx, owner, anchor);
  if (existing) {
    return { kind: "already-delivered", ...existing };
  }

  if (!sameBinding(occurrence, current)) {
    throw new DeliveryRejected("owner-revoked");
  }

  // Content is validated before anything is prepared, so an undeliverable
  // result never reaches the destination writes below. It is validated again
  // after every wait, because only the second answer is current.
  await loadDeliverableResult(tx, {
    ...owner,
    resultAttemptId: request.resultAttemptId,
    purpose: args.purpose,
    at: nowDate(),
  });

  await lockUsableAgent(tx, owner, current.agentId);
  throwIfCancelled(signal);
  return { kind: "admitted", native };
}

/** The installation name the canonical thread binding is created under. */
async function loadInstallationName(
  tx: Tx,
  args: { readonly orgId: string; readonly workflowId: string },
): Promise<string> {
  const [installation] = await tx
    .select({ name: workflows.name })
    .from(workflows)
    .where(
      and(eq(workflows.id, args.workflowId), eq(workflows.orgId, args.orgId)),
    )
    .limit(1);
  if (!installation) {
    throw new DeliveryRejected("destination-unavailable");
  }
  return installation.name;
}

/** Require the member's schedule to still be enabled, under its own row lock. */
async function lockEnabledAutomation(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly automationId: string;
  },
): Promise<void> {
  const [automation] = await tx
    .select({ enabled: workflowAutomations.enabled })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.workflowId, args.workflowId),
      ),
    )
    .limit(1)
    .for("update");
  if (!automation?.enabled) {
    throw new DeliveryRejected("morning-brief-unavailable");
  }
}

async function createNativeDestinationThread(
  tx: Tx,
  owner: { readonly orgId: string; readonly userId: string },
  schedule: MorningBriefNativeScheduleRow,
): Promise<string> {
  const modelSettings = await loadNewChatThreadModelSettings(tx, owner);
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      userId: owner.userId,
      agentId: schedule.agentId,
      title: "Morning Brief",
      provenance: ORDINARY_CHAT_THREAD_PROVENANCE,
      lastReadAt: sql`NOW()`,
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: null,
      modelSettings,
      codexServiceTier: null,
      selectedVideoModel: null,
      selectedImageModel: null,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (thread === undefined) {
    throw new DeliveryRejected("destination-unavailable");
  }
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: owner.userId,
    orgId: owner.orgId,
    chatThreadId: thread.id,
    agentId: schedule.agentId,
    eventId: undefined,
    title: "Morning Brief",
    selectedModel: null,
    modelSettings,
    serviceTier: chatThreadServiceTierFromCodex(null),
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
    createdAt: thread.createdAt,
  });
  if (
    !(await bindMorningBriefNativeThread(tx, owner, {
      expectedEpoch: schedule.ownerEpoch,
      agentId: schedule.agentId,
      chatThreadId: thread.id,
      at: nowDate(),
    }))
  ) {
    throw new DeliveryRejected("owner-revoked");
  }
  return thread.id;
}

async function resolveNativeDestinationThread(
  tx: Tx,
  owner: { readonly orgId: string; readonly userId: string },
  schedule: MorningBriefNativeScheduleRow,
): Promise<string> {
  if (schedule.chatThreadId === null) {
    return await createNativeDestinationThread(tx, owner, schedule);
  }
  const [thread] = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, schedule.chatThreadId),
        eq(chatThreads.userId, owner.userId),
        eq(chatThreads.agentId, schedule.agentId),
        chatThreadOrganizationCondition(tx, owner.orgId),
      ),
    )
    .limit(1)
    .for("update");
  if (thread === undefined) {
    throw new DeliveryRejected("destination-unavailable");
  }
  return thread.id;
}

/** Persist the immutable S6 receipt after every authority wait has completed. */
async function insertDeliveryReceipt(
  tx: Tx,
  args: {
    readonly request: MorningBriefDeliveryRequest;
    readonly purpose: MorningBriefDeliveryPurpose;
    readonly anchor: ResultAnchor;
    readonly current: MorningBriefCollectionAdmission;
    readonly chatThreadId: string;
    readonly chatEventId: string;
    readonly deliveredAt: Date;
    readonly resultMarkdown: string;
    readonly emailResolution: Awaited<
      ReturnType<typeof resolveEmailIntent>
    >["resolution"];
    readonly emailOutboxId: string | null;
  },
): Promise<void> {
  await tx.insert(morningBriefDeliveries).values({
    orgId: args.request.orgId,
    userId: args.request.userId,
    scheduledFor: args.anchor.scheduledFor,
    collectionKind: args.anchor.collectionKind,
    collectionVersion: args.anchor.collectionVersion,
    executionPurpose: args.purpose,
    resultAttemptId: args.request.resultAttemptId,
    membershipId: args.current.membershipId,
    nativeOwnerEpoch: args.request.nativeAuthority?.ownerEpoch ?? null,
    workflowId: args.current.workflowId,
    automationId: args.current.automationId,
    agentId: args.current.agentId,
    chatThreadId: args.chatThreadId,
    chatEventId: args.chatEventId,
    resultDigest: resultDigest(args.resultMarkdown),
    emailResolution: args.emailResolution,
    emailOutboxId: args.emailOutboxId,
    deliveredAt: args.deliveredAt,
  });
}

async function deliverInTransaction(
  tx: Tx,
  args: {
    readonly request: MorningBriefDeliveryRequest;
    readonly purpose: MorningBriefDeliveryPurpose;
    readonly anchor: ResultAnchor;
    readonly current: MorningBriefCollectionAdmission;
  },
  signal: AbortSignal,
): Promise<CommittedDelivery> {
  const { request, anchor, current } = args;
  const owner = { orgId: request.orgId, userId: request.userId };
  const admitted = await admitDelivery(tx, args, signal);
  if (admitted.kind !== "admitted") {
    return admitted;
  }

  let chatThreadId: string;
  if (admitted.native !== null) {
    chatThreadId = await resolveNativeDestinationThread(
      tx,
      owner,
      admitted.native,
    );
  } else {
    const workflowName = await loadInstallationName(tx, {
      orgId: request.orgId,
      workflowId: current.workflowId,
    });

    // Thread, then binding, then automation: the exact order thread deletion
    // takes across the same rows. Delivery must never hold the automation while
    // waiting for a thread that a deletion holds.
    chatThreadId = await resolveDestinationThread(tx, {
      orgId: request.orgId,
      userId: request.userId,
      workflowId: current.workflowId,
      agentId: current.agentId,
      workflowName,
      at: nowDate(),
    });

    await lockEnabledAutomation(tx, {
      orgId: request.orgId,
      userId: request.userId,
      workflowId: current.workflowId,
      automationId: current.automationId,
    });
    throwIfCancelled(signal);
  }

  // The last admission wait. Everything after it is local work only.
  const subscription = await lockSubscription(tx, request.userId);
  throwIfCancelled(signal);

  // The admission waits this transaction can predict are held now. The
  // result's own deadline is evaluated against a fresh clock, so a result that
  // expired while this transaction waited is refused and the destination
  // preparation above unwinds with it. One more wait still follows the message
  // write, and it is re-checked there.
  const acceptedAt = nowDate();
  const result = await loadDeliverableResult(tx, {
    ...owner,
    resultAttemptId: request.resultAttemptId,
    purpose: args.purpose,
    at: acceptedAt,
  });
  if (result.membershipId !== current.membershipId) {
    throw new DeliveryRejected("owner-revoked");
  }

  // The displayed instant may have to move past a marker that committed while
  // this transaction waited, so the delivery cannot land behind the thread's
  // own read cursor. It is deliberately not the acceptance deadline.
  const at = await monotonicDeliveryInstant(tx, chatThreadId, acceptedAt);

  // Exactly the operation #34815 owns. The exclusion and the content it
  // describes commit together, so the brief can never feed tomorrow's.
  await excludeMorningBriefChatThread(tx, {
    chatThreadId,
    userId: request.userId,
  });

  const appended = await insertChatEvent(tx, {
    chatThreadId,
    eventType: "output.message",
    content: result.markdown,
    createdAt: at,
  });
  if (!appended) {
    throw new Error("Morning Brief delivery event was not appended");
  }

  // This UPSERTs the owner's sidebar sequence row, which is shared across all
  // of their threads, so another thread's mutation can hold it. It is the last
  // wait in the transaction, and the acceptance deadline is therefore checked
  // once more after it rather than assumed still valid from before.
  await touchChatThreadLastMessageAt(tx, chatThreadId, at, appended.id);
  throwIfCancelled(signal);
  await loadDeliverableResult(tx, {
    ...owner,
    resultAttemptId: request.resultAttemptId,
    purpose: args.purpose,
    at: nowDate(),
  });

  const appUrl = env("APP_URL");
  const intent = await resolveEmailIntent(tx, {
    userId: request.userId,
    unsubscribed: subscription.unsubscribed,
    threadUrl: `${appUrl}/chats/${encodeURIComponent(chatThreadId)}`,
    manageUrl: `${appUrl}/settings/morning-brief`,
    title: result.title,
    markdown: result.markdown,
  });
  if (intent.outboxCreatedAt !== null) {
    const retained = await retainMorningBriefGenerationProofUntil(tx, {
      owner,
      attemptId: request.resultAttemptId,
      retainedUntil: morningBriefDescriptorRetainUntil(
        result.reservedAt,
        intent.outboxCreatedAt,
      ),
    });
    if (!retained) {
      throw new DeliveryRejected("result-not-found");
    }
  }

  await insertDeliveryReceipt(tx, {
    request,
    purpose: args.purpose,
    anchor,
    current,
    chatThreadId,
    chatEventId: appended.id,
    deliveredAt: appended.createdAt,
    resultMarkdown: result.markdown,
    emailResolution: intent.resolution,
    emailOutboxId: intent.outboxId,
  });

  return {
    kind: "delivered",
    chatThreadId,
    chatEventId: appended.id,
    emailResolution: intent.resolution,
    deliveredAt: appended.createdAt,
    seqId: appended.seqId,
  };
}

export const deliverMorningBriefResult$ = command(
  async (
    { set },
    request: MorningBriefDeliveryRequest,
    signal: AbortSignal,
  ): Promise<MorningBriefDeliveryResult> => {
    const db = set(writeDb$);
    const owner = { orgId: request.orgId, userId: request.userId };
    const purpose: MorningBriefDeliveryPurpose = request.purpose ?? "preview";

    // A delivery that already committed is recoverable from the reference the
    // caller still holds, even after the generation row has been swept. This
    // read is owner and purpose scoped and releases only the delivery identity,
    // never content, so it needs neither the source result nor a fresh
    // authority resolution.
    const recovered = await loadDeliveryByAttempt(db, {
      ...owner,
      resultAttemptId: request.resultAttemptId,
      purpose,
    });
    signal.throwIfAborted();
    if (recovered) {
      return {
        kind: "already-delivered",
        chatThreadId: recovered.chatThreadId,
        chatEventId: recovered.chatEventId,
        emailResolution: recovered.emailResolution,
        deliveredAt: recovered.deliveredAt.toISOString(),
      };
    }

    // The occurrence this reference belongs to, read before any lock is held.
    // It carries no authority of its own: everything below re-derives that.
    const anchor = await loadResultAnchor(db, {
      ...owner,
      resultAttemptId: request.resultAttemptId,
      purpose,
    });
    signal.throwIfAborted();
    if (!anchor) {
      return { kind: "rejected", reason: "result-not-found" };
    }

    // Re-run the same source-specific proof S5 used. This is outside the Chat
    // transaction because connector and Slack checks can reach the network.
    const sourceRefusal = await set(
      revalidateMorningBriefStoredGenerationSources$,
      {
        owner,
        resultAttemptId: request.resultAttemptId,
        purpose,
      },
      signal,
    );
    signal.throwIfAborted();
    if (sourceRefusal !== null) {
      return {
        kind: "rejected",
        reason:
          sourceRefusal === "result-not-found"
            ? "result-not-found"
            : "owner-revoked",
      };
    }

    // The live canonical authority, resolved through the collection executor's
    // own reader rather than a second adoption algorithm. It reaches Clerk, so
    // it runs before the transaction opens and never inside one.
    const authority = await set(
      currentMorningBriefCollectionAuthority$,
      {
        owner,
        scheduledFor: anchor.scheduledFor,
        collectionKind: anchor.collectionKind,
      },
      signal,
    );
    signal.throwIfAborted();
    if (authority.kind !== "admitted") {
      return { kind: "rejected", reason: rejectionOf(authority.reason) };
    }

    // A rejection after the destination was prepared unwinds the whole
    // transaction, so nothing partial is committed for a delivery that did not
    // happen.
    const settled = await settle(
      db.transaction(async (tx) => {
        return await deliverInTransaction(
          tx,
          { request, purpose, anchor, current: authority.admission },
          signal,
        );
      }),
    );
    signal.throwIfAborted();
    // A cancelled attempt reports cancellation rather than an outcome. When it
    // was cancelled before acceptance nothing was committed; when a delivery
    // had already committed, the receipt-first lookup above recovers it on the
    // next request rather than replaying it here.
    if (!settled.ok) {
      if (settled.error instanceof DeliveryRejected) {
        return { kind: "rejected", reason: settled.error.reason };
      }
      throw settled.error;
    }
    const committed = settled.value;
    signal.throwIfAborted();

    if (committed.kind === "delivered") {
      // Best effort, and deliberately outside the transaction: a failed
      // publish leaves a committed delivery that the next canonical read
      // returns, and must never replay the write.
      await publishChatThreadMessageCreatedSafely({
        userId: request.userId,
        orgId: request.orgId,
        threadId: committed.chatThreadId,
        syncThroughSeqId: committed.seqId,
      });
      signal.throwIfAborted();
    }
    return {
      kind: committed.kind,
      chatThreadId: committed.chatThreadId,
      chatEventId: committed.chatEventId,
      emailResolution: committed.emailResolution,
      deliveredAt: committed.deliveredAt.toISOString(),
    };
  },
);

/** The owner scope a cleanup transaction revokes delivery ownership for. */
type MorningBriefDeliveryRevocationScope =
  | {
      readonly kind: "membership";
      readonly orgId: string;
      readonly userId: string;
    }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  /** One destination thread, removed before its own cascade runs. */
  | { readonly kind: "thread"; readonly chatThreadId: string }
  /** One Agent, removed before its own cascade runs. */
  | { readonly kind: "agent"; readonly agentId: string };

function revocationWhere(scope: MorningBriefDeliveryRevocationScope) {
  if (scope.kind === "membership") {
    return and(
      eq(morningBriefDeliveries.orgId, scope.orgId),
      eq(morningBriefDeliveries.userId, scope.userId),
    );
  }
  if (scope.kind === "user") {
    return eq(morningBriefDeliveries.userId, scope.userId);
  }
  if (scope.kind === "thread") {
    return eq(morningBriefDeliveries.chatThreadId, scope.chatThreadId);
  }
  return scope.kind === "agent"
    ? eq(morningBriefDeliveries.agentId, scope.agentId)
    : eq(morningBriefDeliveries.orgId, scope.orgId);
}

/**
 * Drop this scope's delivery ownership inside a cleanup transaction.
 *
 * Called from the earliest local revocation each cleanup path already commits,
 * alongside collection ownership, and from the Agent and thread deletions
 * themselves. Those two cascade the delivery row away, which would otherwise
 * drop the only association to its still-unsent mail; running this first inside
 * the same deleting transaction is what keeps that content from being
 * orphaned. An unsent native intent still carries the
 * recipient address and the rendered brief, so owner deletion removes the mail
 * itself rather than relying on the drain to refuse an orphan. The delete
 * returns the outbox identities it just detached, so the association and the
 * mail it names are removed in one atomic step: a failure rolls both back and a
 * retry sees the association again. It therefore requires a transaction rather
 * than a bare connection. Rows belonging to other producers and other owners
 * are never touched, and an intent the provider already accepted cannot be
 * retracted — only its local record is removed.
 */
export async function revokeMorningBriefDeliveryOwnership(
  tx: Tx,
  scope: MorningBriefDeliveryRevocationScope,
): Promise<void> {
  const revoked = await tx
    .delete(morningBriefDeliveries)
    .where(revocationWhere(scope))
    .returning({ emailOutboxId: morningBriefDeliveries.emailOutboxId });
  const outboxIds = revoked.flatMap((row) => {
    return row.emailOutboxId === null ? [] : [row.emailOutboxId];
  });
  if (outboxIds.length > 0) {
    await tx.delete(emailOutbox).where(inArray(emailOutbox.id, outboxIds));
  }
}
