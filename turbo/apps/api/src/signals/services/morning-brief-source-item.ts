/**
 * The source-neutral evidence a Morning Brief is composed from.
 *
 * Five providers with five different notions of identity and time have to reach
 * one model request without losing what makes each of them checkable. A
 * normalized item is therefore never a flattened string: it keeps the provider
 * identity that a permission recheck can be run against, the time semantics the
 * source actually declared, the branch and state facts the collector already
 * paid to read, and display links the program resolved — never ones a model
 * proposed.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import { createHash } from "node:crypto";

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
interface MorningBriefItemIdentity {
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
interface MorningBriefDisplayLink {
  readonly label: string;
  readonly url: string;
}

/**
 * Why one branch of a provider read selected this record.
 *
 * Every branch that contributed is kept. A pull request reached by both the
 * notification branch and the review-requested branch is one record with two
 * reasons, and reducing that to the first one is how "you were asked to review
 * this" silently becomes "something changed".
 */
interface MorningBriefItemReason {
  readonly branch: string;
  /** The provider's own reason word for that branch, when it supplies one. */
  readonly detail: string | null;
  /** Whether the record is still unread, when the branch knows. */
  readonly unread: boolean | null;
}

/**
 * The check state the collector observed for one pull request head.
 *
 * `headSha` is part of it because a check result describes a commit, not a pull
 * request: dropping it turns "the head you were asked to review is failing"
 * into an undated claim about a branch that has since moved.
 */
interface MorningBriefCheckState {
  readonly headSha: string;
  /** `unknown` is deliberately not `success`: an unread check is not green. */
  readonly state: string;
  readonly failing: number;
  readonly pending: number;
  readonly succeeded: number;
  readonly failingNames: readonly string[];
  readonly incomplete: boolean;
}

/**
 * The provider facts a flattened title-and-body item would destroy.
 *
 * One shape for all five sources, because the request has to compare them: the
 * fields a source has no answer for stay null rather than being invented. Every
 * value here was already read and paid for by the collector, so discarding it
 * buys nothing and costs the request the ability to distinguish two records
 * that happen to share a title.
 */
interface MorningBriefItemFacts {
  /** Every branch that selected this record, never reduced to the first. */
  readonly reasons: readonly MorningBriefItemReason[];
  /** The provider's own lifecycle or response word for the record. */
  readonly state: string | null;
  readonly draft: boolean | null;
  /**
   * The provider's own start and end strings, verbatim.
   *
   * An all-day event carries calendar dates with an exclusive end and a Slack
   * message carries a microsecond timestamp; both lose information the moment
   * they become a millisecond `Date`, so the original text travels beside it.
   */
  readonly startedAtRaw: string | null;
  readonly endsAtRaw: string | null;
  /** The timezone the record's own times are expressed in. */
  readonly timezone: string | null;
  /** The container's timezone, which may differ from the record's. */
  readonly containerTimezone: string | null;
  /** 0 is the anchor's local day; null when the record starts outside it. */
  readonly localDayOffset: number | null;
  /** The series this record is one instance of. */
  readonly seriesId: string | null;
  readonly checks: MorningBriefCheckState | null;
  /** Who the provider attributes the record to. */
  readonly actor: string | null;
  /** How the collector obtained the body, so a gap is not read as content. */
  readonly bodySource: string | null;
  /** The collector's own limitations on this one record. */
  readonly limitations: readonly string[];
}

/** The facts an adapter did not observe, so absence is explicit. */
const NO_ITEM_FACTS: Readonly<MorningBriefItemFacts> = {
  reasons: [],
  state: null,
  draft: null,
  startedAtRaw: null,
  endsAtRaw: null,
  timezone: null,
  containerTimezone: null,
  localDayOffset: null,
  seriesId: null,
  checks: null,
  actor: null,
  bodySource: null,
  limitations: [],
};

/** Fill the facts an adapter observed, leaving the rest explicitly absent. */
export function morningBriefItemFacts(
  observed: Partial<MorningBriefItemFacts>,
): MorningBriefItemFacts {
  return { ...NO_ITEM_FACTS, ...observed };
}

/** Fields every normalized piece of evidence carries. */
interface MorningBriefSourceItemBase {
  readonly identity: MorningBriefItemIdentity;
  /** Ranking within its own source; smaller sorts first. Adapter-owned. */
  readonly priority: number;
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
  readonly facts: MorningBriefItemFacts;
}

/** A calendar date range is not an instant and never receives a UTC timestamp. */
interface MorningBriefDateOnlyItem extends MorningBriefSourceItemBase {
  readonly timeSemantics: "date-only";
  readonly occurredAt: null;
  readonly endsAt: null;
  readonly dateRange: {
    readonly startDate: string;
    readonly endDateExclusive: string;
    readonly timezone: string;
  };
}

/** Every non-date-only claim is represented by real observed instants. */
interface MorningBriefInstantItem extends MorningBriefSourceItemBase {
  readonly timeSemantics: Exclude<MorningBriefTimeSemantics, "date-only">;
  readonly occurredAt: Date;
  readonly endsAt: Date | null;
  readonly dateRange: null;
}

/** One normalized piece of evidence, discriminated by its temporal semantics. */
export type MorningBriefSourceItem =
  | MorningBriefDateOnlyItem
  | MorningBriefInstantItem;

/**
 * What one provider branch asked for, so a window edge stays checkable.
 *
 * A branch is either a half-open activity window or an outstanding-work
 * snapshot, and the two make different claims: a snapshot says "this was true
 * when I looked", never "this happened during the window".
 */
export interface MorningBriefSourceBranch {
  readonly name: string;
  readonly status: string;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly observedAt: string | null;
}

/**
 * The window and snapshot context one source's evidence is only true within.
 *
 * Calendar is the source that proves why this cannot be dropped: an all-day
 * date means nothing without the timezone it was frozen in and the local day
 * range it was selected against, and a brief that lost them reports a
 * three-day conference as "today".
 */
export interface MorningBriefSourceProvenance {
  /** The half-open activity window, when the source has one. */
  readonly startAt: string | null;
  readonly endAt: string | null;
  /** The frozen local dates that window covers, end-exclusive. */
  readonly startDate: string | null;
  readonly endDateExclusive: string | null;
  /** The owner timezone those local dates were frozen in. */
  readonly timezone: string | null;
  /** When an outstanding-backlog snapshot was taken. */
  readonly observedAt: string | null;
  /** When the source finished reading. */
  readonly collectedAt: string | null;
  readonly branches: readonly MorningBriefSourceBranch[];
  /** The collector's declared limitations, by its own names. */
  readonly limitations: readonly string[];
}

/** The provenance of a source that never produced an authorized read. */
export const MORNING_BRIEF_NO_PROVENANCE: Readonly<MorningBriefSourceProvenance> =
  {
    startAt: null,
    endAt: null,
    startDate: null,
    endDateExclusive: null,
    timezone: null,
    observedAt: null,
    collectedAt: null,
    branches: [],
    limitations: [],
  };

/**
 * What a source itself dropped before normalization ever saw it.
 *
 * A count and "there was more" are different facts and the second one is not a
 * number. Gmail's `truncations` list names the caps that fired — pages,
 * candidates, byte budgets — and none of them knows how many messages were on
 * the other side of them. Reporting that list's length as an item count states
 * a total nothing observed, so the honest report is a known count plus an
 * explicit unknown remainder.
 */
export interface MorningBriefOmissionAccount {
  /** Records the collector identified and dropped, when it could count them. */
  readonly known: number;
  /** True when a declared cap ended the read before the rest was enumerated. */
  readonly unknownRemaining: boolean;
}

export const MORNING_BRIEF_NO_OMISSIONS: Readonly<MorningBriefOmissionAccount> =
  {
    known: 0,
    unknownRemaining: false,
  };

/** What one source contributed to one attempt. */
export interface MorningBriefSourceCollection {
  readonly source: MorningBriefSourceKind;
  readonly coverage: MorningBriefSourceCoverage;
  readonly items: readonly MorningBriefSourceItem[];
  /** Provider reads actually spent, as the collector counted them. */
  readonly requests: number;
  readonly provenance: MorningBriefSourceProvenance;
  /** What the adapter itself dropped before normalization. */
  readonly omittedBySource: MorningBriefOmissionAccount;
}

/**
 * Every omission that stands between one source and the model request.
 *
 * Three independent reductions can each drop evidence: the collector's own
 * caps, the combined normalized ceiling and request packing. They act on
 * disjoint sets — an item the collector never returned cannot also be dropped
 * by the request — so the known counts add, and an unknown remainder stays a
 * flag rather than being folded into a total it cannot support.
 */
export interface MorningBriefSourceOmissions {
  readonly bySource: MorningBriefOmissionAccount;
  readonly byNormalizedCap: number;
  readonly byRequest: number;
  readonly knownTotal: number;
  readonly unknownRemaining: boolean;
}

export function morningBriefSourceOmissions(input: {
  readonly bySource: MorningBriefOmissionAccount;
  readonly byNormalizedCap: number;
  readonly byRequest: number;
}): MorningBriefSourceOmissions {
  return {
    ...input,
    knownTotal: input.bySource.known + input.byNormalizedCap + input.byRequest,
    unknownRemaining: input.bySource.unknownRemaining,
  };
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
type MorningBriefSerializedTime =
  | {
      readonly kind: "date-only";
      readonly startDate: string;
      readonly endDateExclusive: string;
      readonly timezone: string;
    }
  | {
      readonly kind: Exclude<MorningBriefTimeSemantics, "date-only">;
      readonly occurredAt: string;
      readonly endsAt: string | null;
    };

interface MorningBriefSerializedItem {
  readonly identity: MorningBriefItemIdentity;
  readonly priority: number;
  readonly time: MorningBriefSerializedTime;
  readonly title: string;
  readonly body: string;
  readonly truncated: boolean;
  readonly links: readonly MorningBriefDisplayLink[];
  readonly facts: MorningBriefItemFacts;
}

export function serializeMorningBriefItem(
  item: MorningBriefSourceItem,
): MorningBriefSerializedItem {
  const time: MorningBriefSerializedTime =
    item.timeSemantics === "date-only"
      ? { kind: "date-only", ...item.dateRange }
      : {
          kind: item.timeSemantics,
          occurredAt: item.occurredAt.toISOString(),
          endsAt: item.endsAt === null ? null : item.endsAt.toISOString(),
        };
  return {
    identity: item.identity,
    priority: item.priority,
    time,
    title: item.title,
    body: item.body,
    truncated: item.truncated,
    links: item.links,
    facts: item.facts,
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

/** One source's exact contribution to the combined normalized document. */
interface MorningBriefSerializedCollection {
  readonly source: MorningBriefSourceKind;
  readonly coverage: MorningBriefSourceCoverage;
  readonly requests: number;
  readonly provenance: MorningBriefSourceProvenance;
  readonly omittedBySource: MorningBriefOmissionAccount;
  readonly items: readonly MorningBriefSerializedItem[];
}

/**
 * The one aggregate representation the combined normalized ceiling bounds.
 *
 * The ceiling is on the normalized evidence *and* its metadata, so there has to
 * be a single document the number describes. Summing item bodies is not that
 * document: coverage, provenance windows, request counts and omission
 * accounting are all carried alongside the items, and a budget blind to them
 * bounds something nobody holds.
 */
export function serializeMorningBriefAggregate(
  collections: readonly MorningBriefSourceCollection[],
): { readonly sources: readonly MorningBriefSerializedCollection[] } {
  return {
    sources: collections.map((collection) => {
      return {
        source: collection.source,
        coverage: collection.coverage,
        requests: collection.requests,
        provenance: collection.provenance,
        omittedBySource: collection.omittedBySource,
        items: collection.items.map(serializeMorningBriefItem),
      };
    }),
  };
}

/** The exact UTF-8 size of that aggregate document. */
function morningBriefAggregateBytes(
  collections: readonly MorningBriefSourceCollection[],
): number {
  return Buffer.byteLength(
    JSON.stringify(serializeMorningBriefAggregate(collections)),
    "utf8",
  );
}

/**
 * A content-free fingerprint of exactly the evidence that reached a request.
 *
 * It is the one externally checkable proof that two different provider states
 * produce two different requests. A normalization that silently discarded the
 * branch a pull request was selected by, or the head its checks describe, used
 * to leave "review requested, checks failing" and "assigned, checks green"
 * byte-identical here — indistinguishable to every consumer downstream.
 */
export function morningBriefEvidenceDigest(
  items: readonly MorningBriefSourceItem[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(items.map(serializeMorningBriefItem)), "utf8")
    .digest("hex");
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
 *
 * Each item is charged exactly what it adds to the aggregate document — its own
 * serialization, plus the one separator byte every item after the first in its
 * source's array costs — so the returned size is the document's real size and
 * not a parallel counter that can drift from it.
 */
export function boundCombinedNormalizedItems(
  collections: readonly MorningBriefSourceCollection[],
  maxBytes: number = MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES,
): {
  readonly collections: readonly MorningBriefSourceCollection[];
  readonly omitted: number;
  readonly omittedBySource: Readonly<
    Partial<Record<MorningBriefSourceKind, number>>
  >;
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

  /** Build the exact representation implied by the currently kept items. */
  const currentCollections = (): readonly MorningBriefSourceCollection[] => {
    return ordered.map((collection) => {
      const kept = keptBySource.get(collection.source) ?? [];
      const dropped = collection.items.length - kept.length;
      return {
        ...collection,
        items: kept,
        coverage:
          dropped > 0 && collection.coverage === "complete"
            ? ("partial" as const)
            : collection.coverage,
      };
    });
  };

  let bytes = morningBriefAggregateBytes(currentCollections());
  let omitted = 0;
  for (const collection of ordered) {
    const kept: MorningBriefSourceItem[] = [];
    keptBySource.set(collection.source, kept);
    const sorted = [...collection.items].sort((left, right) => {
      return left.priority - right.priority;
    });
    for (const item of sorted) {
      const itemBytes =
        morningBriefItemBytes(item) - (kept.length === 0 ? 1 : 0);
      // If this is the last missing item, the exact final representation changes
      // `partial` back to `complete`. Charge that byte in the same decision;
      // neither a smaller provisional status nor a wider blanket reservation can
      // move an otherwise exact-boundary item across the cap.
      const coverageBytes =
        collection.coverage === "complete" &&
        kept.length + 1 === collection.items.length
          ? Buffer.byteLength(JSON.stringify("complete"), "utf8") -
            Buffer.byteLength(JSON.stringify("partial"), "utf8")
          : 0;
      const charge = itemBytes + coverageBytes;
      if (bytes + charge > maxBytes) {
        omitted += 1;
        continue;
      }
      kept.push(item);
      bytes += charge;
    }
  }
  const bounded = currentCollections();
  const omittedBySource: Partial<Record<MorningBriefSourceKind, number>> = {};
  for (const collection of ordered) {
    const dropped =
      collection.items.length -
      (keptBySource.get(collection.source)?.length ?? 0);
    if (dropped > 0) {
      omittedBySource[collection.source] = dropped;
    }
  }
  return {
    collections: bounded,
    omitted,
    omittedBySource,
    // Re-measure the consumer's document rather than exposing the running
    // counter as the oracle.
    bytes: morningBriefAggregateBytes(bounded),
  };
}
