import { randomUUID } from "node:crypto";

import type {
  MorningBriefCollectionOccurrenceView,
  MorningBriefCollectionSkipReason,
  MorningBriefSlackBundle,
} from "@okouai/api-contracts/contracts/morning-brief-collection-preview";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isValidTimeZone } from "@okouai/core/timezone";
import { agents } from "@okouai/db/schema/agent";
import {
  MORNING_BRIEF_COLLECTION_KIND_SLACK,
  MORNING_BRIEF_COLLECTION_VERSION,
  type morningBriefCollectionOccurrences,
} from "@okouai/db/schema/morning-brief-collection-occurrence";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  claimMorningBriefCollection,
  collectionLeaseHeld,
  finalizeMorningBriefCollection,
  loadMorningBriefCollectionOwnerRow,
  morningBriefCollectionBindingMatches,
  type MorningBriefCollectionAdmission,
  type MorningBriefCollectionClaim,
  type MorningBriefCollectionCompletion,
  type MorningBriefCollectionOccurrenceRow,
  type MorningBriefCollectionOwner,
} from "./morning-brief-collection-occurrence.service";
import { loadCurrentMembershipId } from "./morning-brief-membership.service";
import { loadMorningBriefMigrationState } from "./morning-brief-migration-state.service";
import {
  collectMorningBriefSlackBundle,
  MORNING_BRIEF_SLACK_COLLECTION_DEADLINE_MS,
  type MorningBriefSlackCollectionResult,
} from "./morning-brief-slack-collection.service";
import {
  loadSlackUserBinding,
  slackUserInstallation,
} from "./slack-data.service";

/**
 * The explicitly invoked Morning Brief collection executor.
 *
 * It runs the whole path inside the caller's request: admit the owner against
 * live canonical state, claim one attempt on the occurrence, read Slack
 * directly, then finalize under the same authority it was admitted with. There
 * is no background enqueue, no Run, no schedule mutation and no autonomous
 * recovery — a retry is another explicitly authorized invocation.
 *
 * The rules are described in
 * [the collection contract](../../../../../../docs/morning-brief-collection.md).
 */

/** The frozen Slack window is the 24 hours ending at the scheduled anchor. */
const COLLECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Anchors may not run ahead of this instance's clock by more than a minute. */
const MAX_ANCHOR_SKEW_MS = 60_000;

/** The oldest anchor this preview accepts. */
const MAX_ANCHOR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type OccurrenceRow = typeof morningBriefCollectionOccurrences.$inferSelect;

export type MorningBriefCollectionConflict =
  | "in-progress"
  | "retry-pending"
  | "attempts-exhausted"
  | "expired"
  | "binding-changed"
  | "owner-revoked"
  | "claim-lost";

type MorningBriefCollectionExecution =
  | {
      readonly kind: "not-executed";
      readonly reason: MorningBriefCollectionSkipReason;
    }
  | { readonly kind: "invalid-anchor"; readonly message: string }
  | {
      readonly kind: "conflict";
      readonly reason: MorningBriefCollectionConflict;
    }
  | {
      readonly kind: "collected";
      readonly occurrence: MorningBriefCollectionOccurrenceView;
      readonly bundle: MorningBriefSlackBundle;
    }
  | {
      readonly kind: "already-completed";
      readonly occurrence: MorningBriefCollectionOccurrenceView;
    }
  | {
      readonly kind: "failed";
      readonly occurrence: MorningBriefCollectionOccurrenceView;
      readonly retryAfterSeconds?: number;
    };

/**
 * The admitted authority, plus the credential that must never be persisted.
 *
 * `admission` is exactly what the occurrence row stores. The bot token stays
 * beside it in memory for the duration of the request and is deliberately not
 * part of that frozen identity.
 */
interface AdmittedCollection {
  readonly admission: MorningBriefCollectionAdmission;
  readonly botToken: string;
}

type AdmissionResult =
  | { readonly kind: "admitted"; readonly admitted: AdmittedCollection }
  | {
      readonly kind: "not-executed";
      readonly reason: MorningBriefCollectionSkipReason;
    };

/**
 * Whether an occurrence's local authority is unchanged, and how it moved.
 *
 * `binding-changed` is deliberately distinct from a brief that stopped being
 * executable at all: a different-but-valid current binding is a different
 * authority, never a licence to act for the old one.
 */
export type MorningBriefLocalAuthority =
  | { readonly kind: "current" }
  | {
      readonly kind: "not-executed";
      readonly reason: MorningBriefCollectionSkipReason;
    }
  | { readonly kind: "binding-changed" };

/** Everything this attempt owns at the instant its collection becomes durable. */
export interface MorningBriefCollectionHandoffContext {
  readonly admission: MorningBriefCollectionAdmission;
  readonly claim: MorningBriefCollectionClaim;
  readonly completion: MorningBriefCollectionCompletion;
  readonly occurrence: MorningBriefCollectionOccurrenceRow;
  /** The fresh in-memory bundle. It is never persisted and never replayable. */
  readonly bundle: MorningBriefSlackBundle;
  readonly at: Date;
}

/**
 * The narrow collection-to-generation handoff.
 *
 * A completed occurrence is metadata, not a checkpoint, so the only moment a
 * downstream stage can be admitted for a bundle is while this executor still
 * holds it. `onCollected` runs inside the finalize transaction, after the
 * guarded update matched, so the collected facts and the downstream admission
 * become durable together or not at all: throwing rolls the finalization back
 * and leaves the occurrence reclaimable.
 *
 * It is optional, and the collect-only entrypoint passes none — that path keeps
 * exactly its previous behavior.
 */
interface MorningBriefCollectionHandoff {
  readonly onCollected: (
    tx: Tx,
    context: MorningBriefCollectionHandoffContext,
  ) => Promise<void>;
}

function occurrenceView(
  row: OccurrenceRow,
): MorningBriefCollectionOccurrenceView {
  if (row.status === "running" || row.outcome === null) {
    throw new Error("Morning Brief occurrence finalized without an outcome");
  }
  return {
    scheduledFor: row.scheduledFor.toISOString(),
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    timezone: row.timezone,
    collectionKind: "slack",
    collectionVersion: row.collectionVersion,
    attempt: row.attempt,
    status: row.status,
    outcome: row.outcome,
  };
}

/**
 * The Agent the canonical installation runs on, when it is still usable.
 *
 * The installation pins the Agent it was created on rather than whichever Agent
 * is the org default today, so this revalidates that exact reference. A deleted
 * Agent, or a private Agent belonging to somebody else, is a missing Agent —
 * never a reason to silently substitute another one.
 */
async function loadInstallationAgentId(
  db: Pick<ReadonlyDb, "select">,
  owner: MorningBriefCollectionOwner,
  agentId: string,
): Promise<string | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, owner.orgId)))
    .limit(1);
  if (
    !agent ||
    (agent.visibility === "private" && agent.owner !== owner.userId)
  ) {
    return null;
  }
  return agent.id;
}

/**
 * The member's current Clerk membership generation.
 *
 * The exact-member lookup and its immutable-id pin are shared with the
 * Simple Morning Brief connector reader, so both admit on one authority.
 */
const currentMembershipId$ = command(
  async (
    { get },
    owner: MorningBriefCollectionOwner,
    signal: AbortSignal,
  ): Promise<string | null> => {
    return await loadCurrentMembershipId(get(clerk$), owner, signal);
  },
);

/** The installation-side authority, with no Slack binding and no membership. */
type LocalMorningBriefInstallation =
  | {
      readonly kind: "resolved";
      readonly timezone: string;
      /** The parent generation this resolution hangs from. */
      readonly memberCreatedAt: Date;
      readonly workflowId: string;
      readonly automationId: string;
      readonly agentId: string;
    }
  | {
      readonly kind: "not-executed";
      readonly reason: MorningBriefCollectionSkipReason;
    };

/**
 * Everything the local database decides about this owner's brief.
 *
 * It is deliberately separate from the Clerk membership: a caller holding a
 * transaction may re-resolve exactly this much without ever waiting on a
 * network round trip, while the remote evidence stays outside that transaction.
 * Nothing here reads the disposable installed-preference projection — the
 * canonical installation and its schedule decide whether a brief is enabled.
 */
async function resolveLocalMorningBriefInstallation(
  db: Pick<ReadonlyDb, "select">,
  owner: MorningBriefCollectionOwner,
): Promise<LocalMorningBriefInstallation> {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    owner.orgId,
    owner.userId,
  );
  if (
    !isFeatureEnabled(FeatureSwitchKey.SimpleMorningBrief, featureSwitchContext)
  ) {
    return { kind: "not-executed", reason: "feature-disabled" };
  }

  const state = await loadMorningBriefMigrationState(db, owner);
  if (state.kind !== "installed") {
    return {
      kind: "not-executed",
      reason:
        state.kind === "absent"
          ? "brief-absent"
          : state.kind === "pending"
            ? "brief-pending"
            : "brief-inconsistent",
    };
  }
  if (!state.automation.enabled) {
    return { kind: "not-executed", reason: "brief-paused" };
  }

  // One read of the durable member row supplies both the timezone an enabled
  // brief requires and the generation of the parent this resolution acts under.
  // A member row that a cleanup removed is simply absent here.
  const member = await loadMorningBriefCollectionOwnerRow(db, owner);
  if (
    member === null ||
    member.timezone === null ||
    !isValidTimeZone(member.timezone)
  ) {
    return { kind: "not-executed", reason: "missing-timezone" };
  }
  const agentId = await loadInstallationAgentId(
    db,
    owner,
    state.installation.agentId,
  );
  if (agentId === null) {
    return { kind: "not-executed", reason: "missing-agent" };
  }
  return {
    kind: "resolved",
    timezone: member.timezone,
    memberCreatedAt: member.memberCreatedAt,
    workflowId: state.installation.id,
    automationId: state.automation.id,
    agentId,
  };
}

/** One vocabulary for an unusable Slack binding, whatever read produced it. */
function slackBindingSkipReason(
  kind: "not-installed" | "not-connected",
): MorningBriefCollectionSkipReason {
  return kind === "not-installed"
    ? "slack-not-installed"
    : "slack-not-connected";
}

/**
 * Resolve every authority this collection depends on, against live state.
 *
 * The local installation resolution above decides whether a brief is enabled
 * and which Agent it runs on; the Slack binding is the organization's own
 * native bot installation intersected with this member's connected account in
 * that exact workspace, and the membership generation comes from Clerk. Each
 * way it can fail is an explicit non-executing outcome returned before any
 * claim exists, so none of them reaches Slack.
 */
const admitMorningBriefCollection$ = command(
  async (
    { get, set },
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly scheduledFor: Date;
    },
    signal: AbortSignal,
  ): Promise<AdmissionResult> => {
    const db = set(writeDb$);
    const { owner } = args;
    const local = await resolveLocalMorningBriefInstallation(db, owner);
    signal.throwIfAborted();
    if (local.kind !== "resolved") {
      return local;
    }

    const membershipId = await set(currentMembershipId$, owner, signal);
    signal.throwIfAborted();
    if (membershipId === null) {
      return { kind: "not-executed", reason: "membership-revoked" };
    }

    const installation = await get(
      slackUserInstallation({ orgId: owner.orgId, userId: owner.userId }),
    );
    signal.throwIfAborted();
    if (installation.kind !== "connected") {
      return {
        kind: "not-executed",
        reason: slackBindingSkipReason(installation.kind),
      };
    }

    return {
      kind: "admitted",
      admitted: {
        botToken: installation.botToken,
        admission: {
          owner,
          memberCreatedAt: local.memberCreatedAt,
          scheduledFor: args.scheduledFor,
          collectionKind: MORNING_BRIEF_COLLECTION_KIND_SLACK,
          windowStart: new Date(
            args.scheduledFor.getTime() - COLLECTION_WINDOW_MS,
          ),
          windowEnd: args.scheduledFor,
          timezone: local.timezone,
          membershipId,
          workflowId: local.workflowId,
          automationId: local.automationId,
          agentId: local.agentId,
          slackWorkspaceId: installation.workspaceId,
          slackUserId: installation.slackUserId,
        },
      },
    };
  },
);

/**
 * Whether the local half of an occurrence's authority still holds, right now.
 *
 * It exists because remote evidence and local state expire differently. A
 * caller that already proved the Clerk membership outside a transaction still
 * has to survive a Settings disable, an Agent transfer or a Slack rebinding
 * that committed while it waited for a lock, and those are all local rows. This
 * re-resolves exactly the installation resolution admission uses and compares
 * it against the occurrence with the shared binding comparator, so there is no
 * second adoption algorithm and no always-allow path. The membership generation
 * is carried over from the occurrence rather than re-resolved: holding a
 * transaction open across a Clerk round trip is never acceptable.
 */
export async function morningBriefLocalAuthorityStillCurrent(
  db: Pick<ReadonlyDb, "select">,
  occurrence: MorningBriefCollectionOccurrenceRow,
): Promise<MorningBriefLocalAuthority> {
  const owner = { orgId: occurrence.orgId, userId: occurrence.userId };
  const local = await resolveLocalMorningBriefInstallation(db, owner);
  if (local.kind !== "resolved") {
    return local;
  }
  const binding = await loadSlackUserBinding(db, owner);
  if (binding.kind !== "connected") {
    return {
      kind: "not-executed",
      reason: slackBindingSkipReason(binding.kind),
    };
  }
  return morningBriefCollectionBindingMatches(occurrence, {
    owner,
    memberCreatedAt: local.memberCreatedAt,
    scheduledFor: occurrence.scheduledFor,
    collectionKind: occurrence.collectionKind,
    windowStart: occurrence.windowStart,
    windowEnd: occurrence.windowEnd,
    timezone: local.timezone,
    membershipId: occurrence.membershipId,
    workflowId: local.workflowId,
    automationId: local.automationId,
    agentId: local.agentId,
    slackWorkspaceId: binding.installation.slackWorkspaceId,
    slackUserId: binding.slackUserId,
  })
    ? { kind: "current" }
    : { kind: "binding-changed" };
}

/**
 * The owner's live Morning Brief authority, without the Slack credential.
 *
 * It is the same canonical resolution admission uses — the implementation
 * switch, the canonical installed-and-enabled brief, the member timezone, the
 * installation's Agent, a fresh exact-member Clerk membership and the native
 * Slack binding — exposed so a later stage can revalidate that exact authority
 * instead of inventing a second adoption algorithm. The bot token stays inside
 * this module: a caller that only needs to know *whether* the authority still
 * holds never receives a credential.
 */
export const currentMorningBriefCollectionAuthority$ = command(
  async (
    { set },
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly scheduledFor: Date;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "admitted";
        readonly admission: MorningBriefCollectionAdmission;
      }
    | {
        readonly kind: "not-executed";
        readonly reason: MorningBriefCollectionSkipReason;
      }
  > => {
    const resolved = await set(admitMorningBriefCollection$, args, signal);
    signal.throwIfAborted();
    return resolved.kind === "admitted"
      ? { kind: "admitted", admission: resolved.admitted.admission }
      : resolved;
  },
);

/**
 * Prove the admitted authority is still exactly the same before accepting data.
 *
 * Collection runs outside any transaction and can take seconds, so the
 * membership generation, canonical enabled choice, Agent and native Slack
 * binding are re-resolved and compared field by field. Anything that moved
 * means this attempt may no longer speak for the owner, and its bundle is
 * discarded rather than finalized.
 */
const admissionStillCurrent$ = command(
  async (
    { set },
    admission: MorningBriefCollectionAdmission,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const revalidated = await set(
      admitMorningBriefCollection$,
      { owner: admission.owner, scheduledFor: admission.scheduledFor },
      signal,
    );
    signal.throwIfAborted();
    if (revalidated.kind !== "admitted") {
      return false;
    }
    const current = revalidated.admitted.admission;
    return (
      current.memberCreatedAt.getTime() ===
        admission.memberCreatedAt.getTime() &&
      current.membershipId === admission.membershipId &&
      current.workflowId === admission.workflowId &&
      current.automationId === admission.automationId &&
      current.agentId === admission.agentId &&
      current.slackWorkspaceId === admission.slackWorkspaceId &&
      current.slackUserId === admission.slackUserId &&
      current.timezone === admission.timezone
    );
  },
);

function validateAnchor(
  scheduledFor: Date,
  at: Date,
): { readonly kind: "invalid-anchor"; readonly message: string } | null {
  const offset = scheduledFor.getTime() - at.getTime();
  if (offset > MAX_ANCHOR_SKEW_MS) {
    return {
      kind: "invalid-anchor",
      message: "scheduledFor must not be a future instant.",
    };
  }
  if (-offset > MAX_ANCHOR_AGE_MS) {
    return {
      kind: "invalid-anchor",
      message: "scheduledFor is older than the supported collection window.",
    };
  }
  return null;
}

/**
 * Turn what the collector observed into the terminal facts to record.
 *
 * A bounded read and a healthy empty read stay distinguishable from every
 * failure, and a rate limit carries the provider's own `Retry-After` so the
 * next explicit invocation is bounded without this request ever sleeping.
 */
function completionOf(
  collected: MorningBriefSlackCollectionResult,
): MorningBriefCollectionCompletion {
  if (collected.kind === "rate-limited") {
    return {
      status: "failed",
      outcome: "rate_limited",
      ...(collected.retryAfterSeconds !== undefined && {
        retryAfterSeconds: collected.retryAfterSeconds,
      }),
    };
  }
  if (collected.kind === "permission-denied") {
    return { status: "failed", outcome: "permission_denied" };
  }
  if (collected.kind === "provider-failed") {
    return { status: "failed", outcome: "provider_failed" };
  }
  const { bundle } = collected;
  return {
    status: "completed",
    outcome:
      bundle.coverage === "partial"
        ? "partial"
        : bundle.channels.length === 0
          ? "no_shared_channels"
          : "complete",
    counts: {
      channels: bundle.counts.channels,
      threads: bundle.counts.threads,
      messages: bundle.counts.messages,
      requests: bundle.counts.requests,
    },
    truncated: bundle.coverage === "partial",
  };
}

async function claimAttempt(
  db: Db,
  admission: MorningBriefCollectionAdmission,
): Promise<
  | { readonly kind: "claimed"; readonly claim: MorningBriefCollectionClaim }
  | { readonly kind: "already-completed"; readonly occurrence: OccurrenceRow }
  | {
      readonly kind: "conflict";
      readonly reason: MorningBriefCollectionConflict;
    }
> {
  // The lease, retry and lifetime instants belong to the admitted transition,
  // not to the request that started before admission resolved, so the clock is
  // handed to the guarded transition instead of being sampled here.
  const leaseToken = randomUUID();
  const claimed = await db.transaction(async (tx) => {
    return await claimMorningBriefCollection(
      tx,
      admission,
      leaseToken,
      nowDate,
    );
  });
  if (claimed.kind === "rejected") {
    return { kind: "conflict", reason: claimed.reason };
  }
  return claimed.kind === "claimed"
    ? { kind: "claimed", claim: claimed.claim }
    : { kind: "already-completed", occurrence: claimed.occurrence };
}

/**
 * Run one explicitly authorized Morning Brief Slack collection.
 *
 * The bundle only ever exists in memory. It is returned when — and only when —
 * this attempt still holds an unexpired lease on the occurrence it claimed and
 * the owner's authority is unchanged. Otherwise it is dropped and the caller is
 * told the claim was lost, because no metadata row could reproduce it.
 */
export const executeMorningBriefSlackCollection$ = command(
  async (
    { set },
    args: {
      readonly owner: MorningBriefCollectionOwner;
      readonly scheduledFor: Date;
      readonly handoff?: MorningBriefCollectionHandoff;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefCollectionExecution> => {
    const db = set(writeDb$);
    const startedAt = nowDate();
    const invalid = validateAnchor(args.scheduledFor, startedAt);
    if (invalid) {
      return invalid;
    }

    const admitted = await set(admitMorningBriefCollection$, args, signal);
    signal.throwIfAborted();
    if (admitted.kind !== "admitted") {
      return admitted;
    }
    const { admission, botToken } = admitted.admitted;

    const claimed = await claimAttempt(db, admission);
    signal.throwIfAborted();
    if (claimed.kind === "conflict") {
      return claimed;
    }
    if (claimed.kind === "already-completed") {
      // Terminal success is metadata about a collection, never a checkpoint of
      // one, so this makes no provider call and offers no bundle.
      return {
        kind: "already-completed",
        occurrence: occurrenceView(claimed.occurrence),
      };
    }
    const { claim } = claimed;

    // Cancellation and the lease are both checked before the first provider
    // call, and the deadline never outlives the lease this attempt holds.
    if (!collectionLeaseHeld(claim, nowDate())) {
      return { kind: "conflict", reason: "claim-lost" };
    }
    const budgetMs = Math.max(
      0,
      Math.min(
        claim.leaseExpiresAt.getTime() - nowDate().getTime(),
        MORNING_BRIEF_SLACK_COLLECTION_DEADLINE_MS,
      ),
    );
    const collected = await collectMorningBriefSlackBundle(
      {
        botToken,
        slackUserId: admission.slackUserId,
        workspaceId: admission.slackWorkspaceId,
        windowStart: admission.windowStart,
        windowEnd: admission.windowEnd,
        timezone: admission.timezone,
        version: MORNING_BRIEF_COLLECTION_VERSION,
      },
      {
        clock: () => {
          return nowDate().getTime();
        },
        deadline: nowDate().getTime() + budgetMs,
      },
      AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]),
    );
    signal.throwIfAborted();

    if (!(await set(admissionStillCurrent$, admission, signal))) {
      return { kind: "conflict", reason: "owner-revoked" };
    }
    signal.throwIfAborted();
    const completion = completionOf(collected);
    // The guarded write is the lease check immediately before completion: it
    // matches the exact occurrence, attempt, token, running status and an
    // unexpired deadline in one statement, so no separate check can disagree
    // with it. Equality with the deadline is already expired. The instant it
    // compares is read inside that transition, after its owner and row locks,
    // because waiting for them can outlast the lease this attempt holds.
    const finalized = await db.transaction(async (tx) => {
      const result = await finalizeMorningBriefCollection(
        tx,
        admission,
        claim,
        completion,
        nowDate,
      );
      // The handoff joins this transaction rather than following it, so no
      // downstream stage can ever be admitted for a bundle whose collection
      // did not become durable, and none can be admitted for a bundle that was
      // discarded because the claim was lost.
      if (result.kind === "finalized" && collected.kind === "collected") {
        await args.handoff?.onCollected(tx, {
          admission,
          claim,
          completion,
          occurrence: result.occurrence,
          bundle: collected.bundle,
          at: result.at,
        });
      }
      return result;
    });
    signal.throwIfAborted();
    if (finalized.kind !== "finalized") {
      return {
        kind: "conflict",
        reason:
          finalized.kind === "owner-revoked" ? "owner-revoked" : "claim-lost",
      };
    }
    const occurrence = occurrenceView(finalized.occurrence);
    if (collected.kind !== "collected") {
      return {
        kind: "failed",
        occurrence,
        ...(completion.retryAfterSeconds !== undefined && {
          retryAfterSeconds: completion.retryAfterSeconds,
        }),
      };
    }
    return { kind: "collected", occurrence, bundle: collected.bundle };
  },
);
