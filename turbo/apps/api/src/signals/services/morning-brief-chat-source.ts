/**
 * Unread Chat, expressed as source-neutral evidence.
 *
 * Chat is the one source that is entirely first-party, and its authorization is
 * not a connector grant: the reader has already excluded the destination thread
 * and every Morning Brief or unknown-provenance thread, and it releases only
 * `provenance: "ordinary"` items. That decision is not re-derived here — the
 * thread and event identities are carried through so a later check can ask the
 * same reader whether those exact threads are still readable.
 *
 * An unread snapshot is also not window activity. The terminal event may be
 * days old; what makes it evidence is that the member has not read it, so it is
 * outstanding rather than something that happened this morning.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import type {
  MorningBriefChatCollection,
  MorningBriefChatItem,
} from "@okouai/api-contracts/contracts/morning-brief-chat-collection-preview";

import {
  morningBriefScopeDigest,
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
 * Chat's authorization surface.
 *
 * There is no external grant to digest: eligibility is the reader's own
 * ownership, visibility and provenance rules. Digesting their names keeps the
 * descriptor shape uniform and still makes a change to that rule set visible.
 */
const MORNING_BRIEF_CHAT_READ_SURFACE: readonly string[] = [
  "chat:thread-owner",
  "chat:unread-snapshot",
  "chat:ordinary-provenance",
];

function chatCoverage(
  collection: MorningBriefChatCollection,
): MorningBriefSourceCoverage {
  if (collection.coverage === "partial") {
    return "partial";
  }
  // `no-eligible-content` is not an empty inbox: unread threads existed and
  // none of them released content. Both are complete reads with no items, and
  // the distinction is carried by the collector's own skip list.
  return collection.items.length === 0 ? "empty" : "complete";
}

/**
 * The exclusions the reader applied by policy rather than by a budget.
 *
 * The destination thread and threads that have hosted Morning Brief content are
 * deliberately never eligible, so counting them as lost evidence would report a
 * coverage gap that does not exist. Every other skip is a thread the owner has
 * unread and this brief could not represent.
 */
function isMorningBriefChatPolicyExclusion(reason: string): boolean {
  return reason === "destination_thread" || reason === "morning_brief_thread";
}

/**
 * The unread snapshot this collection describes.
 *
 * Unread Chat has no activity window: it is standing state observed once, and
 * `collectedAt` is the only instant that makes the count meaningful. Every skip
 * reason and truncation is named so a partial read is never readable as an
 * empty inbox.
 */
function chatProvenance(
  collection: MorningBriefChatCollection,
): MorningBriefSourceProvenance {
  const reasons = new Set<string>(collection.truncations);
  for (const skipped of collection.skipped) {
    reasons.add(skipped.reason);
  }
  return {
    startAt: null,
    endAt: null,
    startDate: null,
    endDateExclusive: null,
    timezone: null,
    observedAt: collection.collectedAt,
    collectedAt: collection.collectedAt,
    branches: [
      {
        name: "unread",
        status: collection.result,
        startAt: null,
        endAt: null,
        observedAt: collection.collectedAt,
      },
    ],
    limitations: [...reasons],
  };
}

/** The readable text of one thread, oldest excerpt first. */
function chatBody(item: MorningBriefChatItem): string {
  return item.excerpts
    .map((excerpt) => {
      return `${excerpt.role}: ${excerpt.text}`;
    })
    .join("\n");
}

/**
 * Normalize one Chat collection.
 *
 * Threads are ranked by their terminal event, most recent first, which is the
 * order the member would see them.
 */
export function normalizeMorningBriefChat(
  collection: MorningBriefChatCollection,
  account: string,
): MorningBriefSourceCollection {
  const ranked = [...collection.items].sort((left, right) => {
    return (
      new Date(right.terminal.at).getTime() -
      new Date(left.terminal.at).getTime()
    );
  });
  const items: MorningBriefSourceItem[] = ranked.map((thread, index) => {
    return {
      identity: {
        source: "chat",
        account,
        container: thread.threadId,
        // The terminal event is the record: a later reply to the same thread is
        // a different unread state, not the same one seen twice.
        record: thread.terminal.eventId,
        instance: thread.terminal.seqId.toString(),
      },
      priority: index,
      occurredAt: new Date(thread.terminal.at),
      // Unread is standing state, not something that happened in the window.
      timeSemantics: "outstanding",
      endsAt: null,
      dateRange: null,
      title: "",
      body: chatBody(thread),
      truncated: thread.truncations.length > 0,
      // Chat carries no program-resolved external link; the reader deliberately
      // exposes no thread URL, and inventing one here would be exactly the
      // fabrication the citation rules exist to prevent.
      links: [],
      // The reader's own provenance decision travels with the item: only
      // `ordinary` threads are released, and that is the fact a later check
      // re-runs rather than re-derives.
      facts: morningBriefItemFacts({
        reasons: [{ branch: "unread", detail: null, unread: true }],
        state: thread.provenance,
        startedAtRaw: thread.terminal.at,
        seriesId: thread.agentId,
        limitations: thread.truncations,
      }),
    };
  });
  return {
    source: "chat",
    coverage: chatCoverage(collection),
    items,
    // Chat reads its own database rather than a provider, so it spends no
    // provider request budget.
    requests: 0,
    provenance: chatProvenance(collection),
    // Chat is the one source that can count what it dropped: every skipped
    // thread is a thread it looked at. Policy exclusions are not losses, and a
    // truncation means candidates it never reached at all.
    omittedBySource: {
      known: collection.skipped.filter((skipped) => {
        return !isMorningBriefChatPolicyExclusion(skipped.reason);
      }).length,
      unknownRemaining: collection.truncations.length > 0,
    },
  };
}

/**
 * The credential-free descriptor a later phase revalidates Chat against.
 *
 * `containers` names the threads that actually contributed. That is what an
 * erasure, ownership change or visibility change is checked against, and it is
 * the reason a thread deleted between collection and delivery cannot have its
 * content released.
 */
export function morningBriefChatDescriptor(args: {
  readonly userId: string;
  readonly membershipId: string;
  readonly agentId: string;
  readonly capturedAt: Date;
  readonly contributed: boolean;
  readonly containers: readonly string[];
}): MorningBriefRetainedSourceDescriptor {
  return {
    source: "chat",
    // First-party: there is no connector row and no provider account.
    connectionId: null,
    accountRef: args.userId,
    scopeDigest: morningBriefScopeDigest(MORNING_BRIEF_CHAT_READ_SURFACE),
    // Chat authorizes against its own threads rather than an HTTP policy, so
    // the containers below are the whole endpoint surface a later check re-asks.
    endpoints: [],
    membershipId: args.membershipId,
    agentId: args.agentId,
    capturedAt: args.capturedAt.toISOString(),
    contributed: args.contributed,
    containers: args.containers,
  };
}
