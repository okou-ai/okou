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
import { nowDate } from "../../lib/time";
import type { ClerkClient } from "../external/clerk";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  admitMorningBriefCollection,
  revalidateMorningBriefRetainedRead,
  type MorningBriefCollectionScope,
  type MorningBriefSourceDeadline,
} from "./morning-brief-connector-reader.service";
import { ORDINARY_CHAT_THREAD_PROVENANCE } from "./morning-brief-thread-provenance.service";
import type { MorningBriefRetainedSourceDescriptor } from "./morning-brief-source-authority";
import type { MorningBriefSourceKind } from "./morning-brief-source-item";

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
  readonly slackUserId: string;
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

/**
 * Re-ask the existing authorizers about every retained input.
 *
 * `descriptors` are the sources whose material survived into the request.
 * Sources that supplied nothing are not checked, because an unconfigured or
 * empty source is not a reason to withhold the owner's other authorized
 * material.
 */
export async function revalidateMorningBriefRetainedSources(
  input: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
    readonly slack: MorningBriefSlackAuthority | null;
    /** The attempt's own reservation; the phase bound never outlives it. */
    readonly deadline: MorningBriefSourceDeadline;
  },
  signal: AbortSignal,
): Promise<MorningBriefRevalidationOutcome> {
  const { db, clerk, scope } = input;
  const remainingMs = input.deadline.at - nowDate().getTime();
  if (remainingMs <= 0) {
    return { kind: "owner-lost", reason: "deadline-exceeded" };
  }
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(
      Math.min(MORNING_BRIEF_REVALIDATION_PHASE_MS, remainingMs),
    ),
  ]);

  // The owner-level gate first: one answer covers every source, and a lost
  // owner makes the per-source answers irrelevant.
  const admitted = await settle(
    admitMorningBriefCollection(
      {
        db,
        clerk,
        orgId: scope.orgId,
        userId: scope.userId,
        anchor: scope.anchor,
        // The attempt's own reservation, never a fresh one: a slow check
        // shortens what is left rather than earning a new allowance.
        deadline: input.deadline,
      },
      bounded,
    ),
    signal,
  );
  if (!admitted.ok) {
    return { kind: "owner-lost", reason: "check-unavailable" };
  }
  if (admitted.value.kind !== "ok") {
    return { kind: "owner-lost", reason: admitted.value.reason };
  }
  const current = admitted.value.scope;
  if (
    current.membershipId !== scope.membershipId ||
    current.agentId !== scope.agentId ||
    current.installationId !== scope.installationId ||
    current.automationId !== scope.automationId ||
    current.chatThreadId !== scope.chatThreadId
  ) {
    return { kind: "owner-lost", reason: "owner-changed" };
  }

  const revoked: MorningBriefRevokedSource[] = [];
  for (const descriptor of input.descriptors) {
    const reason = await settle(
      revalidateSource(
        { db, clerk, scope, slack: input.slack, descriptor },
        bounded,
      ),
      signal,
    );
    // An unfinished check is not a proof of authority. A source whose answer
    // did not arrive inside the phase is withheld like a revoked one.
    const outcome = reason.ok ? reason.value : "check-unavailable";
    if (outcome !== null) {
      revoked.push({ source: descriptor.source, reason: outcome });
    }
  }
  return { kind: "checked", revoked };
}

/** `null` means this source's retained material may still be used. */
async function revalidateSource(
  args: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: MorningBriefSlackAuthority | null;
    readonly descriptor: MorningBriefRetainedSourceDescriptor;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const { descriptor } = args;
  const connectorSlug = connectorSlugOf(descriptor.source);
  if (connectorSlug !== null) {
    if (descriptor.connectionId === null) {
      // No connection was ever proved, so there is nothing to re-ask. An
      // unproven account never authorizes retained content.
      return "unproven-account";
    }
    return await revalidateMorningBriefRetainedRead(
      {
        db: args.db,
        clerk: args.clerk,
        scope: args.scope,
        connectorSlug,
        connectionId: descriptor.connectionId,
        endpoints: descriptor.endpoints,
      },
      signal,
    );
  }
  if (descriptor.source === "slack") {
    return await revalidateSlackContainers(
      { slack: args.slack, containers: descriptor.containers },
      signal,
    );
  }
  return await revalidateChatContainers(
    { db: args.db, scope: args.scope, containers: descriptor.containers },
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
    readonly slack: MorningBriefSlackAuthority | null;
    readonly containers: readonly string[];
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (args.containers.length === 0) {
    return null;
  }
  if (args.slack === null) {
    return "not-connected";
  }
  const unproven = new Set(args.containers);
  let cursor: string | undefined;
  for (let page = 0; page < SLACK_REPROOF_PAGES; page += 1) {
    const result = await settle(
      listSharedSlackChannelsPage(
        args.slack.botToken,
        args.slack.slackUserId,
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
      return null;
    }
    cursor = result.value.response_metadata?.next_cursor || undefined;
    if (cursor === undefined) {
      break;
    }
  }
  return "source-revoked";
}

/**
 * Re-resolve the same predicates Chat's collector resolved for every thread.
 *
 * Ownership, the Agent's organization and visibility, and the thread's
 * provenance are all live state that can move while a sibling source is held.
 * This is a read outside any transaction on purpose: the consumer that finally
 * releases the brief takes its own locks and re-reads these rows there.
 */
async function revalidateChatContainers(
  args: {
    readonly db: Db;
    readonly scope: MorningBriefCollectionScope;
    readonly containers: readonly string[];
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (args.containers.length === 0) {
    return null;
  }
  const rows = await args.db
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
