/**
 * The source-neutral evidence a Morning Brief is composed from.
 *
 * Five providers with five different notions of identity and time have to reach
 * one model request without losing what makes each of them checkable. A
 * normalized item is therefore never a flattened string: it keeps the provider
 * identity that a permission recheck can be run against, the time semantics the
 * source actually declared, and display links the program resolved — never ones
 * a model proposed.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

/** Every provider the composed brief can read. */
export const MORNING_BRIEF_SOURCE_KINDS = [
  "gmail",
  "calendar",
  "github",
  "slack",
  "chat",
] as const;

export type MorningBriefSourceKind =
  (typeof MORNING_BRIEF_SOURCE_KINDS)[number];

/**
 * The fixed order sources are started, reduced and rendered in.
 *
 * It is deliberately one order for all three: a reader comparing two briefs, a
 * request that had to drop items, and a coverage note all describe the same
 * sequence. Calendar leads because a frozen local day is the least recoverable
 * context, and Chat trails because its own reader is already the tightest.
 */
export const MORNING_BRIEF_SOURCE_ORDER: readonly MorningBriefSourceKind[] = [
  "calendar",
  "gmail",
  "github",
  "slack",
  "chat",
];

/**
 * How completely a source answered, independent of how much of it survived
 * request budgeting.
 *
 * `unconfigured` is not `empty`: an owner who never connected GitHub has no
 * GitHub evidence, which is a different fact from a GitHub account with nothing
 * outstanding, and only the second one is a healthy answer about their day.
 */
export type MorningBriefSourceCoverage =
  | "unconfigured"
  | "empty"
  | "complete"
  | "partial"
  | "failed";

/** Where an item's instant came from, so a window edge is never rounded away. */
export type MorningBriefTimeSemantics =
  /** A precise instant inside the collected half-open window. */
  | "instant"
  /** A timed span that overlaps the window rather than starting inside it. */
  | "overlap"
  /** A whole-day date in the frozen local timezone, end-exclusive. */
  | "date-only"
  /** Backlog that predates the window and is still outstanding. */
  | "outstanding";

/**
 * A provider record's identity, as the provider itself names it.
 *
 * `account` is the exact selected connection's account reference — never the
 * process account, an environment token's identity or a workspace default. Two
 * items are the same record only when every segment matches, which is what
 * stops two calendars' copies of one meeting, or an email and the Chat thread
 * discussing it, from being silently merged.
 */
export interface MorningBriefItemIdentity {
  readonly source: MorningBriefSourceKind;
  readonly account: string;
  /** Container: mailbox, calendar, repository, channel or thread. */
  readonly container: string;
  /** The provider's own record id within that container. */
  readonly record: string;
  /**
   * The occurrence discriminator for recurring or threaded records: a calendar
   * recurrence instance, a Slack thread timestamp, a Chat event. Null when the
   * record id is already unique.
   */
  readonly instance: string | null;
}

/**
 * A display link the program resolved from collected input.
 *
 * Both fields come from the source adapter, never from generated text. The
 * renderer emits a link only when an opaque citation id resolves to one of
 * these, so a model cannot invent a URL, and no link in generated text is ever
 * fetched.
 */
export interface MorningBriefDisplayLink {
  readonly label: string;
  readonly url: string;
}

/** One normalized piece of evidence. */
export interface MorningBriefSourceItem {
  readonly identity: MorningBriefItemIdentity;
  /** Ranking within its own source; smaller sorts first. Adapter-owned. */
  readonly priority: number;
  readonly occurredAt: Date;
  readonly timeSemantics: MorningBriefTimeSemantics;
  /** All-day and multi-day records keep their exclusive end. */
  readonly endsAt: Date | null;
  readonly title: string;
  readonly body: string;
  /**
   * True when the source clipped this item's text at its own ceiling.
   *
   * It travels into the request because the model has to know it is reading a
   * fragment. A clipped message presented as a whole one is how a brief ends up
   * confidently summarizing the half of a thread that happened to fit.
   */
  readonly truncated: boolean;
  readonly links: readonly MorningBriefDisplayLink[];
}

/** What one source contributed to one attempt. */
export interface MorningBriefSourceCollection {
  readonly source: MorningBriefSourceKind;
  readonly coverage: MorningBriefSourceCoverage;
  readonly items: readonly MorningBriefSourceItem[];
  /** Provider reads actually spent, for budget reporting. */
  readonly requests: number;
  /** Items the adapter itself dropped before normalization. */
  readonly omittedBySource: number;
}

/** The combined normalized input ceiling, metadata included. */
export const MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES = 1024 * 1024;

/**
 * The exact shape one item takes inside the model request.
 *
 * The request carries this projection, not the in-memory item: `Date` values
 * become ISO 8601 strings and nothing else changes. Serializing the same object
 * the request will serialize is the only way the byte budget can be exact.
 */
interface MorningBriefSerializedItem {
  readonly identity: MorningBriefItemIdentity;
  readonly priority: number;
  readonly occurredAt: string;
  readonly timeSemantics: MorningBriefTimeSemantics;
  readonly endsAt: string | null;
  readonly title: string;
  readonly body: string;
  readonly truncated: boolean;
  readonly links: readonly MorningBriefDisplayLink[];
}

export function serializeMorningBriefItem(
  item: MorningBriefSourceItem,
): MorningBriefSerializedItem {
  return {
    identity: item.identity,
    priority: item.priority,
    occurredAt: item.occurredAt.toISOString(),
    timeSemantics: item.timeSemantics,
    endsAt: item.endsAt === null ? null : item.endsAt.toISOString(),
    title: item.title,
    body: item.body,
    truncated: item.truncated,
    links: item.links,
  };
}

/**
 * The item's exact serialized size in the request it will travel in.
 *
 * An earlier version of this summed the field values. That is not the same
 * number and it is not conservative: a controller probe fed 32 Slack-sized
 * items whose text is entirely quote characters, accepted 31 of them at a
 * reported 130,727 bytes, and their actual JSON array was 263,863 — roughly
 * double, because every `"` becomes `\"` and none of the property names,
 * separators, braces, `priority` or the `null`s were counted at all. A budget
 * that undercounts by 2x does not bound the request; it just fails later.
 *
 * So this serializes. `JSON.stringify` of the exact projection, plus the one
 * byte the comma separating array elements costs, is what the request actually
 * spends on this item.
 */
export function morningBriefItemBytes(item: MorningBriefSourceItem): number {
  return (
    Buffer.byteLength(JSON.stringify(serializeMorningBriefItem(item)), "utf8") +
    // Every item but the first is preceded by a separator; charging all of them
    // keeps the estimate on the safe side of the ceiling by exactly one byte.
    1
  );
}

/**
 * The exact serialized size of an item array, including its brackets.
 *
 * This is measured rather than summed so the two can be asserted equal: if the
 * per-item charge ever drifts from what the array costs, a test comparing them
 * fails instead of a request silently exceeding its ceiling.
 */
export function morningBriefItemsBytes(
  items: readonly MorningBriefSourceItem[],
): number {
  return Buffer.byteLength(
    JSON.stringify(items.map(serializeMorningBriefItem)),
    "utf8",
  );
}

function identityKey(identity: MorningBriefItemIdentity): string {
  return [
    identity.source,
    identity.account,
    identity.container,
    identity.record,
    identity.instance ?? "",
  ].join("\u0000");
}

/**
 * Drop repeats of the same provider record, and nothing else.
 *
 * Deduplication is deliberately identity-only. Two calendar copies of one
 * meeting held in different calendars are two authorized records with two
 * identities, and an email whose subject matches a GitHub issue title is not
 * the same record at all. Relating those facts is the model's job inside the
 * single pass, where the original identities are still attached; collapsing
 * them here would destroy the evidence a permission recheck needs.
 */
export function dedupeMorningBriefItems(
  items: readonly MorningBriefSourceItem[],
): readonly MorningBriefSourceItem[] {
  const seen = new Set<string>();
  const kept: MorningBriefSourceItem[] = [];
  for (const item of items) {
    const key = identityKey(item.identity);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  return kept;
}

/**
 * Apply the combined normalized ceiling by dropping whole trailing items.
 *
 * Items are considered in the fixed source order, then by each adapter's own
 * priority, so the cap removes the least important evidence rather than
 * whatever happened to be collected last. Bodies are never sliced: a half
 * sentence attributed to a real message is worse evidence than no message.
 */
export function boundCombinedNormalizedItems(
  collections: readonly MorningBriefSourceCollection[],
  maxBytes: number = MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES,
): {
  readonly collections: readonly MorningBriefSourceCollection[];
  readonly omitted: number;
  readonly bytes: number;
} {
  const ordered = [...collections].sort((left, right) => {
    return (
      MORNING_BRIEF_SOURCE_ORDER.indexOf(left.source) -
      MORNING_BRIEF_SOURCE_ORDER.indexOf(right.source)
    );
  });
  const keptBySource = new Map<
    MorningBriefSourceKind,
    MorningBriefSourceItem[]
  >();
  let bytes = 0;
  let omitted = 0;
  for (const collection of ordered) {
    const kept: MorningBriefSourceItem[] = [];
    const sorted = [...collection.items].sort((left, right) => {
      return left.priority - right.priority;
    });
    for (const item of sorted) {
      const itemBytes = morningBriefItemBytes(item);
      if (bytes + itemBytes > maxBytes) {
        omitted += 1;
        continue;
      }
      bytes += itemBytes;
      kept.push(item);
    }
    keptBySource.set(collection.source, kept);
  }
  return {
    collections: ordered.map((collection) => {
      const kept = keptBySource.get(collection.source) ?? [];
      const dropped = collection.items.length - kept.length;
      return {
        ...collection,
        items: kept,
        coverage:
          dropped > 0 && collection.coverage === "complete"
            ? "partial"
            : collection.coverage,
      };
    }),
    omitted,
    bytes,
  };
}
