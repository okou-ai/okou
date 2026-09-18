/**
 * The one place a retained Morning Brief input is re-asked about.
 *
 * Collection finishes at different moments for different sources. A source that
 * returned early then waits — for a sibling's provider read, for the language
 * archive, for the request to be assembled — and during that wait its grant,
 * its account, the member's organization membership, the Agent's visibility, a
 * Slack channel's sharing or a Chat thread's ownership can all move. A wrapper
 * that answered once while the read was running has not answered for the moment
 * the material is about to be used.
 *
 * So every retained descriptor is checked again here, through the *existing*
 * authorizers rather than a second engine: connector sources re-enter the
 * shared OAuth reader's own identity and URL-policy gates, native Slack re-runs
 * the same shared-conversation proof its collector uses, and Chat re-resolves
 * the same ownership, visibility and provenance predicates its collector
 * resolved. No credential is decrypted, no provider payload is fetched and
 * nothing is collected again: whether an input may still be used is a
 * permission question.
 *
 * **What this does not promise.** An external check cannot atomically prevent a
 * revoke that happens after it answers. Network preflight therefore runs
 * outside any transaction, and the consumer that finally releases the material
 * re-evaluates its own local predicates inside its own fence. What is bounded
 * here is that material whose authority is *already* gone does not reach that
 * consumer.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, eq, inArray, or } from "drizzle-orm";

import { listSharedSlackChannelsPage } from "../../lib/slack-client";
import { monotonicNow, nowDate } from "../../lib/time";
import type { ClerkClient } from "../external/clerk";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  admitMorningBriefCollection,
  revalidateMorningBriefRetainedRead,
  withMorningBriefDatabaseDeadline,
  type MorningBriefCollectionScope,
  type MorningBriefSourceDeadline,
} from "./morning-brief-connector-reader.service";
import { ORDINARY_CHAT_THREAD_PROVENANCE } from "./morning-brief-thread-provenance.service";
import type { MorningBriefRetainedSourceDescriptor } from "./morning-brief-source-authority";
import type { MorningBriefSourceKind } from "./morning-brief-source-item";
import { loadSlackUserBinding } from "./slack-data.service";

/**
 * The ceiling for the whole revalidation phase.
 *
 * It is a phase bound, not a per-source one: the caller's own reservation
 * constrains it further, and whichever is nearer wins. Permission work is
 * counted inside it — re-proving a Slack workspace's shared conversations is
 * the same enumeration the collector spends, so it is bounded here rather than
 * given a budget of its own.
 */
const MORNING_BRIEF_REVALIDATION_PHASE_MS = 5000;
const RETAINED_LOCAL_DATABASE_CAPS = {
  lockTimeoutMs: 1000,
  statementTimeoutMs: 5000,
} as const;

/** Enumeration pages one re-proof may spend, matching the collector's ceiling. */
const SLACK_REPROOF_PAGES = 3;
const SLACK_REPROOF_PAGE_LIMIT = 200;

/**
 * The connector slug an OAuth-backed source is authorized as.
 *
 * `null` marks the first-party sources, whose authority is their own containers
 * rather than a selected connector account.
 */
function connectorSlugOf(source: MorningBriefSourceKind): ConnectorSlug | null {
  if (source === "gmail") {
    return "gmail";
  }
  if (source === "calendar") {
    return "google-calendar";
  }
  return source === "github" ? "github" : null;
}

/** The native Slack binding whose shared conversations are re-proved. */
interface MorningBriefSlackAuthority {
  readonly botToken: string;
  readonly workspaceId: string;
  readonly slackUserId: string;
}

/**
 * Start the one absolute retained-check allowance for this composition.
 *
 * Every finite replan receives this same object. The attempt's reservation may
 * be nearer than five seconds, and its existing signal remains part of the
 * interruption boundary rather than being replaced by a fresh timeout.
 */
export function startMorningBriefRetainedCheckDeadline(
  reservation: Pick<MorningBriefSourceDeadline, "at" | "ioAt">,
  reservationSignal: AbortSignal,
): MorningBriefSourceDeadline {
  const startedAt = nowDate().getTime();
  const at = Math.min(
    startedAt + MORNING_BRIEF_REVALIDATION_PHASE_MS,
    reservation.at,
  );
  // Preserve the reservation's application/monotonic correspondence. The
  // retained phase may shorten it, but a controlled application-clock jump is
  // not real I/O time and must not manufacture a one-millisecond transaction.
  const ioAt = reservation.ioAt - Math.max(0, reservation.at - at);
  const ioRemainingMs = Math.max(0, Math.floor(ioAt - monotonicNow()));
  return {
    at,
    ioAt,
    signal: AbortSignal.any([
      reservationSignal,
      AbortSignal.timeout(ioRemainingMs),
    ]),
  };
}

/** Equality is expired even before the timeout callback gets a turn. */
export function morningBriefRetainedCheckExpired(
  deadlineAt: number,
  deadlineSignal: AbortSignal,
): boolean {
  return deadlineSignal.aborted || nowDate().getTime() >= deadlineAt;
}

/** One retained source that may no longer be used, and why. */
interface MorningBriefRevokedSource {
  readonly source: MorningBriefSourceKind;
  readonly reason: string;
}

type MorningBriefRevalidationOutcome =
  /**
   * The owner themselves is gone.
   *
   * Nothing survives this: a removed membership, a disabled or reinstalled
   * brief or an Agent this member can no longer act through withdraws the
   * authority every source was admitted under, not one source's material.
   */
  | { readonly kind: "owner-lost"; readonly reason: string }
  | {
      readonly kind: "checked";
      readonly revoked: readonly MorningBriefRevokedSource[];
    };

interface MorningBriefRetainedRevalidationInput {
  readonly db: Db;
  readonly clerk: ClerkClient;
  readonly scope: MorningBriefCollectionScope;
  readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
  readonly slack: MorningBriefSlackAuthority | null;
  /** The attempt's own reservation; the phase bound never outlives it. */
  readonly deadline: MorningBriefSourceDeadline;
}

/**
 * Re-ask the existing authorizers about every retained input.
 *
 * `descriptors` are the sources whose material survived into the request.
 * Sources that supplied nothing are not checked, because an unconfigured or
 * empty source is not a reason to withhold the owner's other authorized
 * material.
 */
export async function revalidateMorningBriefRetainedSources(
  input: MorningBriefRetainedRevalidationInput,
  signal: AbortSignal,
): Promise<MorningBriefRevalidationOutcome> {
  const { db, clerk, scope, deadline } = input;
  if (morningBriefRetainedCheckExpired(deadline.at, deadline.signal)) {
    return { kind: "owner-lost", reason: "deadline-exceeded" };
  }
  const bounded = AbortSignal.any([signal, deadline.signal]);

  // The owner-level gate first: one answer covers every source, and a lost
  // owner makes the per-source answers irrelevant.
  const initialOwnerLoss = await retainedOwnerLossReason(
    input,
    bounded,
    signal,
  );
  if (initialOwnerLoss !== null) {
    return { kind: "owner-lost", reason: initialOwnerLoss };
  }

  const revoked: MorningBriefRevokedSource[] = [];
  for (const descriptor of input.descriptors) {
    if (morningBriefRetainedCheckExpired(deadline.at, deadline.signal)) {
      return { kind: "owner-lost", reason: "deadline-exceeded" };
    }
    const reason = await settle(
      revalidateSource(
        {
          db,
          clerk,
          scope,
          slack: input.slack,
          descriptor,
          deadline: input.deadline,
        },
        bounded,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (morningBriefRetainedCheckExpired(deadline.at, deadline.signal)) {
      return { kind: "owner-lost", reason: "deadline-exceeded" };
    }
    // An unfinished check is not a proof of authority. A source whose answer
    // did not arrive inside the phase is withheld like a revoked one.
    const outcome = reason.ok ? reason.value : "check-unavailable";
    if (outcome !== null) {
      revoked.push({ source: descriptor.source, reason: outcome });
    }
  }
  // Source checks may wait on provider I/O. Re-enter the same owner authorizer
  // afterwards so a membership, installation or Agent change committed during
  // the last wait cannot release the previous owner's material.
  const finalOwnerLoss = await retainedOwnerLossReason(input, bounded, signal);
  return finalOwnerLoss === null
    ? { kind: "checked", revoked }
    : { kind: "owner-lost", reason: finalOwnerLoss };
}

/** `null` means the exact original owner scope still holds. */
async function retainedOwnerLossReason(
  input: MorningBriefRetainedRevalidationInput,
  bounded: AbortSignal,
  signal: AbortSignal,
): Promise<string | null> {
  const deadline = input.deadline;
  if (morningBriefRetainedCheckExpired(deadline.at, deadline.signal)) {
    return "deadline-exceeded";
  }
  const admitted = await settle(
    admitMorningBriefCollection(
      {
        db: input.db,
        clerk: input.clerk,
        orgId: input.scope.orgId,
        userId: input.scope.userId,
        anchor: input.scope.anchor,
        deadline: input.deadline,
      },
      bounded,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (morningBriefRetainedCheckExpired(deadline.at, deadline.signal)) {
    return "deadline-exceeded";
  }
  if (!admitted.ok) {
    return "check-unavailable";
  }
  if (admitted.value.kind !== "ok") {
    return admitted.value.reason;
  }
  const current = admitted.value.scope;
  return current.membershipId !== input.scope.membershipId ||
    current.agentId !== input.scope.agentId ||
    current.installationId !== input.scope.installationId ||
    current.automationId !== input.scope.automationId ||
    current.chatThreadId !== input.scope.chatThreadId
    ? "owner-changed"
    : null;
}

/** `null` means this source's retained material may still be used. */
async function revalidateSource(
  args: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: MorningBriefSlackAuthority | null;
    readonly descriptor: MorningBriefRetainedSourceDescriptor;
    readonly deadline: MorningBriefSourceDeadline;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const { descriptor } = args;
  if (
    descriptor.membershipId !== args.scope.membershipId ||
    descriptor.agentId !== args.scope.agentId
  ) {
    return "source-provenance-changed";
  }
  const connectorSlug = connectorSlugOf(descriptor.source);
  if (connectorSlug !== null) {
    if (
      descriptor.connectionId === null ||
      descriptor.accountRef === null ||
      descriptor.scopeDigest === ""
    ) {
      // No exact connection, account and exercised grant were ever proved, so
      // there is nothing complete to re-ask.
      return "unproven-account";
    }
    return await revalidateMorningBriefRetainedRead(
      {
        db: args.db,
        clerk: args.clerk,
        scope: args.scope,
        connectorSlug,
        connectionId: descriptor.connectionId,
        accountRef: descriptor.accountRef,
        scopeDigest: descriptor.scopeDigest,
        endpoints: descriptor.endpoints,
        deadline: args.deadline,
      },
      signal,
    );
  }
  if (descriptor.source === "slack") {
    return await revalidateSlackContainers(
      {
        db: args.db,
        scope: args.scope,
        slack: args.slack,
        descriptor,
        deadline: args.deadline,
      },
      signal,
    );
  }
  return await revalidateChatContainers(
    {
      db: args.db,
      scope: args.scope,
      containers: descriptor.containers,
      deadline: args.deadline,
    },
    signal,
  );
}

/**
 * Re-prove that the connected member still shares every conversation this
 * material came from.
 *
 * The bot keeps its own access after the member loses theirs, so the
 * intersection is enumerated again rather than remembered. A conversation the
 * re-proof could not reach is unproven, and unproven material is withheld.
 */
async function revalidateSlackContainers(
  args: {
    readonly db: Db;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: MorningBriefSlackAuthority | null;
    readonly descriptor: MorningBriefRetainedSourceDescriptor;
    readonly deadline: MorningBriefSourceDeadline;
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (args.descriptor.containers.length === 0) {
    return null;
  }
  const slack = args.slack;
  if (slack === null) {
    return "not-connected";
  }
  const bound = { ...args, slack };
  if (!(await slackBindingMatchesDescriptor(bound, signal))) {
    return "not-connected";
  }
  signal.throwIfAborted();

  const unproven = new Set(args.descriptor.containers);
  let cursor: string | undefined;
  for (let page = 0; page < SLACK_REPROOF_PAGES; page += 1) {
    const result = await settle(
      listSharedSlackChannelsPage(
        slack.botToken,
        slack.slackUserId,
        { limit: SLACK_REPROOF_PAGE_LIMIT, cursor },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      return "check-unavailable";
    }
    for (const channel of result.value.channels) {
      unproven.delete(channel.id);
    }
    if (unproven.size === 0) {
      break;
    }
    cursor = result.value.response_metadata?.next_cursor || undefined;
    if (cursor === undefined) {
      return "source-revoked";
    }
  }
  if (unproven.size > 0) {
    return "source-revoked";
  }

  // The external answer ran without a database lock. Re-read the canonical
  // installation/member connection afterwards so a disconnect or rebind that
  // committed while Slack was held wins this decision. A later change remains
  // the final consumer's responsibility; no remote check can make it atomic.
  return (await slackBindingMatchesDescriptor(bound, signal))
    ? null
    : "not-connected";
}

/** Credential-free comparison against the exact retained native identity. */
async function slackBindingMatchesDescriptor(
  args: {
    readonly db: Db;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: MorningBriefSlackAuthority;
    readonly descriptor: MorningBriefRetainedSourceDescriptor;
    readonly deadline: MorningBriefSourceDeadline;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const binding = await withMorningBriefDatabaseDeadline(
    {
      db: args.db,
      deadline: args.deadline,
      caps: RETAINED_LOCAL_DATABASE_CAPS,
      transactionConfig: {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      },
    },
    signal,
    async (tx, beforeStatement) => {
      return await loadSlackUserBinding(
        tx,
        { orgId: args.scope.orgId, userId: args.scope.userId },
        beforeStatement,
      );
    },
  );
  if (binding.kind !== "connected") {
    return false;
  }
  const workspaceId = binding.installation.slackWorkspaceId;
  return (
    workspaceId === args.slack.workspaceId &&
    binding.slackUserId === args.slack.slackUserId &&
    args.descriptor.accountRef === `${workspaceId}:${binding.slackUserId}`
  );
}

/**
 * Re-resolve the same predicates Chat's collector resolved for every thread.
 *
 * Ownership, the Agent's organization and visibility, and the thread's
 * provenance are all live state that can move while a sibling source is held.
 * This remains a credential-free proof rather than the final consumer lock; its
 * short read-only transaction only keeps the query inside the retained deadline.
 */
async function revalidateChatContainers(
  args: {
    readonly db: Db;
    readonly scope: MorningBriefCollectionScope;
    readonly containers: readonly string[];
    readonly deadline: MorningBriefSourceDeadline;
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (args.containers.length === 0) {
    return null;
  }
  const rows = await withMorningBriefDatabaseDeadline(
    {
      db: args.db,
      deadline: args.deadline,
      caps: RETAINED_LOCAL_DATABASE_CAPS,
      transactionConfig: {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      },
    },
    signal,
    async (tx) => {
      return await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .where(
          and(
            inArray(chatThreads.id, [...args.containers]),
            eq(chatThreads.userId, args.scope.userId),
            eq(agents.orgId, args.scope.orgId),
            eq(chatThreads.provenance, ORDINARY_CHAT_THREAD_PROVENANCE),
            or(
              eq(agents.visibility, "public"),
              eq(agents.owner, args.scope.userId),
            ),
          ),
        );
    },
  );
  signal.throwIfAborted();
  const authorized = new Set(
    rows.map((row) => {
      return row.id;
    }),
  );
  return args.containers.every((container) => {
    return authorized.has(container);
  })
    ? null
    : "source-revoked";
}
