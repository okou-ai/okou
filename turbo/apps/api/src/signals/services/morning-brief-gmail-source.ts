/**
 * Gmail's collection, expressed as source-neutral evidence.
 *
 * The collector already distinguishes the recent half-open window from the
 * current unread backlog, and that distinction is the one thing a flattened
 * "here are some emails" list destroys: a message from the backlog is not
 * something that happened during the window, and a brief that presents it as
 * such is wrong about the owner's morning. So the branch decides the item's
 * time semantics, and the unread snapshot keeps its own observation time.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import type {
  MorningBriefGmailCollection,
  MorningBriefGmailItem,
} from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";

import {
  morningBriefProvenAuthority,
  type MorningBriefSourceAuthorityProof,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import {
  morningBriefItemFacts,
  type MorningBriefSourceCollection,
  type MorningBriefSourceCoverage,
  type MorningBriefSourceItem,
  type MorningBriefSourceProvenance,
} from "./morning-brief-source-item";

/**
 * Whether this message is window evidence or standing backlog.
 *
 * A message selected by the recent branch happened inside the collected window.
 * One selected only by the unread branch is outstanding work that may predate
 * it entirely, and keeping that apart is what stops a week-old unread thread
 * from being reported as this morning's news.
 */
function gmailTimeSemantics(
  item: MorningBriefGmailItem,
): "instant" | "outstanding" {
  return item.branches.includes("recent") ? "instant" : "outstanding";
}

function gmailCoverage(
  collection: MorningBriefGmailCollection,
): MorningBriefSourceCoverage {
  if (collection.status === "unavailable") {
    return "failed";
  }
  if (collection.status === "partial") {
    return "partial";
  }
  return collection.items.length === 0 ? "empty" : "complete";
}

/**
 * The two branches this collection drew from, each with its own time claim.
 *
 * The recent branch asked for a half-open window; the unread branch is a
 * snapshot of the backlog at the instant it was read. They are reported apart
 * because a brief that merges them can present week-old unread mail as window
 * activity, and because a reader cannot judge "3 unread" without knowing when
 * it was counted.
 */
function gmailProvenance(
  collection: MorningBriefGmailCollection,
): MorningBriefSourceProvenance {
  return {
    startAt: collection.recentWindow.from,
    endAt: collection.recentWindow.to,
    startDate: null,
    endDateExclusive: null,
    timezone: collection.timezone,
    observedAt: collection.unreadObservedAt,
    collectedAt: collection.collectedAt,
    branches: [
      {
        name: "recent",
        status: collection.coverage.recent,
        startAt: collection.recentWindow.from,
        endAt: collection.recentWindow.to,
        observedAt: null,
      },
      {
        name: "unread",
        status: collection.coverage.unread,
        startAt: null,
        endAt: null,
        observedAt: collection.unreadObservedAt,
      },
    ],
    limitations: collection.coverage.truncations,
  };
}

/**
 * Normalize one Gmail collection.
 *
 * Window evidence ranks ahead of standing backlog, and within each group the
 * newest message leads. That ordering is what the request allocator consumes
 * when Gmail has to give up its later turns.
 */
export function normalizeMorningBriefGmail(
  collection: MorningBriefGmailCollection,
  account: string,
): MorningBriefSourceCollection {
  const ranked = [...collection.items].sort((left, right) => {
    const leftRecent = left.branches.includes("recent") ? 0 : 1;
    const rightRecent = right.branches.includes("recent") ? 0 : 1;
    if (leftRecent !== rightRecent) {
      return leftRecent - rightRecent;
    }
    return (
      new Date(right.internalDate).getTime() -
      new Date(left.internalDate).getTime()
    );
  });
  const items: MorningBriefSourceItem[] = ranked.map((message, index) => {
    return {
      identity: {
        source: "gmail",
        account,
        // The thread is the container an item belongs to; the message id is the
        // record, so two messages in one thread stay two authorized records.
        container: message.threadId,
        record: message.messageId,
        instance: null,
      },
      priority: index,
      occurredAt: new Date(message.internalDate),
      timeSemantics: gmailTimeSemantics(message),
      endsAt: null,
      dateRange: null,
      title: message.subject ?? "",
      body: message.excerpt,
      // `none` and `html-only` are declared coverage gaps rather than empty
      // messages: the collector could not represent the body, so the excerpt
      // is not the message.
      truncated:
        message.excerptSource === "none" ||
        message.excerptSource === "html-only",
      links: [{ label: "Open in Gmail", url: message.sourceUrl }],
      // Both selecting branches survive, not just the one that decided the time
      // semantics: a message that is recent *and* unread is a different fact
      // from one that is only recent, and the excerpt source says whether the
      // body was read at all.
      facts: morningBriefItemFacts({
        reasons: message.branches.map((branch) => {
          return { branch, detail: null, unread: message.unread };
        }),
        startedAtRaw: message.date,
        actor: message.from,
        bodySource: message.excerptSource,
      }),
    };
  });
  return {
    source: "gmail",
    coverage: gmailCoverage(collection),
    items,
    requests: collection.coverage.requests,
    provenance: gmailProvenance(collection),
    // `truncations` names the caps that fired — list pages, candidates, byte
    // budgets — and none of them knows how many messages were behind them.
    // Reporting that list's length as a message count stated a total nothing
    // observed, so the remainder is an explicit unknown instead.
    omittedBySource: {
      known: 0,
      unknownRemaining:
        collection.coverage.truncations.length > 0 ||
        collection.coverage.recent !== "complete" ||
        collection.coverage.unread !== "complete",
    },
  };
}

/**
 * The credential-free descriptor a later phase revalidates Gmail against.
 *
 * `accountRef` is the exact mailbox the shared reader resolved from the
 * member's selected connection — never a process account or an environment
 * token's identity. `containers` names the threads that actually contributed,
 * so a later check can ask about the real scope of this input rather than
 * trusting a digest of constants.
 */
export function morningBriefGmailDescriptor(args: {
  /**
   * The exact mailbox the shared reader resolved, from the collection.
   *
   * Null means the reader never resolved one. It never means "any mailbox": a
   * later check treats a descriptor without an account reference as unproven
   * rather than allowed.
   */
  readonly accountEmail: string | null;
  /** What this source's reads were actually authorized by, or null. */
  readonly proof: MorningBriefSourceAuthorityProof | null;
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: Date;
  readonly contributed: boolean;
  readonly containers: readonly string[];
}): MorningBriefRetainedSourceDescriptor {
  const proven = morningBriefProvenAuthority(args.proof);
  return {
    source: "gmail",
    connectionId: proven.connectionId,
    accountRef: args.accountEmail ?? args.proof?.accountRef ?? null,
    scopeDigest: proven.scopeDigest,
    endpoints: proven.endpoints,
    membershipId: args.membershipId,
    agentId: args.agentId,
    capturedAt: args.capturedAt.toISOString(),
    contributed: args.contributed,
    containers: args.containers,
  };
}
