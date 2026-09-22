/**
 * The bounded fan-out plan one Morning Brief attempt runs under.
 *
 * Every number here is a ceiling, never a target. The attempt owns a single
 * absolute collection deadline that includes queue wait, live admission,
 * credential and language work and the finalization preflight; the per-source
 * ceilings the adapters already declare stay in force underneath it. Nothing in
 * this module sleeps, retries or starts work it does not join.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import { MORNING_BRIEF_SLACK_COLLECTION_DEADLINE_MS } from "./morning-brief-slack-collection.service";
import {
  MORNING_BRIEF_SOURCE_ORDER,
  morningBriefItemBytes,
  type MorningBriefSourceCollection,
  type MorningBriefSourceItem,
  type MorningBriefSourceKind,
} from "./morning-brief-source-item";

/** The absolute collection phase, from admission to finalization COMMIT. */
export const MORNING_BRIEF_COLLECTION_PHASE_MS = 45_000;

/**
 * Held back from reading so a started read can still be finalized.
 *
 * It funds the work between the last source answering and the COMMIT that
 * makes the occurrence durable: the language-context read, the member locale
 * read, request assembly and the instruction-version fence. It does **not**
 * fund an authority check — every provider request is authorized before it is
 * issued, and nothing re-asks afterwards.
 *
 * It is a reserve, not a grace period: a source read that has not started by
 * the cutoff does not start at all, because a read that finishes after the
 * commit window has nowhere to be finalized. Collapsing it to zero is what
 * makes a read admitted at 44.9 s settle the attempt as `deadline-exceeded`
 * instead of reporting the per-source facts it actually established.
 *
 * The size is bounded by the composition suite, which requires a read
 * finishing one second past the cutoff to still settle as
 * `incomplete-coverage`: the attempt has to be alive at `cutoff + 1000`, so
 * anything at or below 1000 ms reclassifies it. Measured against
 * `will not call an exhausted collection a quiet morning`, 1000 ms fails and
 * 1001 ms passes. This is the smallest round value above that boundary, which
 * keeps the classification off a one-millisecond margin.
 */
export const MORNING_BRIEF_COMMIT_RESERVE_MS = 2000;

/** No new provider read is admitted at or after this point in the phase. */
export const MORNING_BRIEF_NEW_READ_CUTOFF_MS =
  MORNING_BRIEF_COLLECTION_PHASE_MS - MORNING_BRIEF_COMMIT_RESERVE_MS;

/**
 * Held back inside **one source's** own budget so it can stop by its own clock.
 *
 * The phase reserve above protects the commit; this protects the payload. A
 * source's cancellation signal and the clock its collector consults are two
 * views of the same instant, so a collector that reads until the deadline is
 * always cancelled rather than stopped: the abort escapes as an unclassified
 * rejection, and the composition replaces the whole source with a failed
 * collection carrying zero items — discarding evidence every provider call
 * already returned successfully.
 *
 * So the last stretch of every source budget belongs to finishing, not to
 * reading. New provider reads stop here; the bundle projection that turns a
 * read into a collection spends what is left, and the source hands back the
 * partial evidence it really holds.
 */
export const MORNING_BRIEF_SOURCE_READ_RESERVE_MS = 3000;

/** At most this share of a source's remaining budget becomes the reserve. */
const MORNING_BRIEF_SOURCE_READ_RESERVE_SHARE = 4;

/**
 * The instant one source stops starting provider reads.
 *
 * The reserve is a share of what is actually left, capped at the fixed amount
 * above, rather than the fixed amount itself. Subtracting a flat three seconds
 * from a budget of one would move the cutoff to the moment it was asked, and a
 * collector that is out of time before its first read reports a source that
 * read nothing — which the outcome rules would then have to call a quiet
 * morning. A short budget buys a short read, never no read at all.
 */
export function morningBriefSourceReadCutoff(
  deadlineAt: number,
  at: number,
): number {
  const remainingMs = Math.max(0, deadlineAt - at);
  const reserveMs = Math.min(
    MORNING_BRIEF_SOURCE_READ_RESERVE_MS,
    Math.floor(remainingMs / MORNING_BRIEF_SOURCE_READ_RESERVE_SHARE),
  );
  return deadlineAt - reserveMs;
}

/** At most three sources are in flight; the rest queue in the fixed order. */
export const MORNING_BRIEF_MAX_CONCURRENT_SOURCES = 3;

/** The one absolute instant an attempt owns, and which bound produced it. */
export interface MorningBriefCompositionDeadline {
  readonly startedAt: Date;
  readonly deadlineAt: Date;
  /** `caller` whenever the caller's budget is the tighter of the two. */
  readonly source: "phase" | "caller";
}

/**
 * Resolve the single absolute deadline the whole attempt runs under.
 *
 * The 45-second phase and the caller's own budget — a scheduled occurrence's
 * remaining lease, or a preview caller's explicit limit — are two upper bounds
 * on the same attempt, so the tighter one wins and the attempt never holds a
 * deadline its caller has already given up on. Resolving it once, before
 * admission, is what makes every later check a sample of the same instant
 * rather than a fresh 45 seconds granted by whichever step asked last.
 */
export function morningBriefCompositionDeadline(
  startedAt: Date,
  callerDeadlineAt: Date | null,
): MorningBriefCompositionDeadline {
  const phaseDeadlineAt = new Date(
    startedAt.getTime() + MORNING_BRIEF_COLLECTION_PHASE_MS,
  );
  if (
    callerDeadlineAt !== null &&
    callerDeadlineAt.getTime() < phaseDeadlineAt.getTime()
  ) {
    return { startedAt, deadlineAt: callerDeadlineAt, source: "caller" };
  }
  return { startedAt, deadlineAt: phaseDeadlineAt, source: "phase" };
}

/** The per-source ceilings each adapter already declares, restated as the plan's. */
export const MORNING_BRIEF_SOURCE_BUDGETS: Readonly<
  Record<
    MorningBriefSourceKind,
    { readonly deadlineMs: number; readonly maxRequests: number }
  >
> = {
  gmail: { deadlineMs: 20_000, maxRequests: 44 },
  calendar: { deadlineMs: 20_000, maxRequests: 18 },
  github: { deadlineMs: 20_000, maxRequests: 24 },
  slack: {
    deadlineMs: MORNING_BRIEF_SLACK_COLLECTION_DEADLINE_MS,
    maxRequests: 40,
  },
  chat: { deadlineMs: 15_000, maxRequests: 0 },
};

/** The exact serialized model request ceiling. */
export const MORNING_BRIEF_REQUEST_MAX_BYTES = 128 * 1024;

/** What one source may spend on this attempt. */
interface MorningBriefSourceBudget {
  readonly source: MorningBriefSourceKind;
  readonly deadlineAt: Date;
  readonly maxRequests: number;
}

/**
 * Resolve one source's budget against the phase that is actually left.
 *
 * The source ceiling and the remaining phase are both upper bounds, so the
 * tighter one wins. A source admitted at the cutoff gets a zero budget rather
 * than a short one, which is how a late admission becomes "not read" instead of
 * a read that cannot be finalized.
 */
export function morningBriefSourceBudget(
  source: MorningBriefSourceKind,
  phaseStartedAt: Date,
  at: Date,
  occurrenceDeadlineAt: Date | null = null,
): MorningBriefSourceBudget {
  const cutoffAt = phaseStartedAt.getTime() + MORNING_BRIEF_NEW_READ_CUTOFF_MS;
  const occurrenceLimit =
    occurrenceDeadlineAt === null ? Infinity : occurrenceDeadlineAt.getTime();
  const admitted = at.getTime() < cutoffAt && at.getTime() < occurrenceLimit;
  const latestEnd = Math.min(
    cutoffAt,
    occurrenceLimit,
    at.getTime() + MORNING_BRIEF_SOURCE_BUDGETS[source].deadlineMs,
  );
  const remainingMs = admitted ? Math.max(0, latestEnd - at.getTime()) : 0;
  return {
    source,
    deadlineAt: new Date(at.getTime() + remainingMs),
    maxRequests:
      remainingMs === 0 ? 0 : MORNING_BRIEF_SOURCE_BUDGETS[source].maxRequests,
  };
}

/** True while this attempt may still start a provider read it can finalize. */
export function morningBriefMayStartRead(
  phaseStartedAt: Date,
  at: Date,
  occurrenceDeadlineAt: Date | null = null,
): boolean {
  if (
    occurrenceDeadlineAt !== null &&
    at.getTime() >= occurrenceDeadlineAt.getTime()
  ) {
    return false;
  }
  return (
    at.getTime() - phaseStartedAt.getTime() < MORNING_BRIEF_NEW_READ_CUTOFF_MS
  );
}

/**
 * The order sources are admitted in, capped at the concurrency ceiling.
 *
 * Configured sources keep the fixed order so two attempts with the same
 * connectors always start the same way; the returned waves are what the caller
 * joins, so no work is ever started without an owner.
 */
export function morningBriefSourceWaves(
  configured: readonly MorningBriefSourceKind[],
): readonly (readonly MorningBriefSourceKind[])[] {
  const ordered = MORNING_BRIEF_SOURCE_ORDER.filter((source) => {
    return configured.includes(source);
  });
  const waves: MorningBriefSourceKind[][] = [];
  for (
    let offset = 0;
    offset < ordered.length;
    offset += MORNING_BRIEF_MAX_CONCURRENT_SOURCES
  ) {
    waves.push(
      ordered.slice(offset, offset + MORNING_BRIEF_MAX_CONCURRENT_SOURCES),
    );
  }
  return waves;
}

/** What survived request budgeting, and what it cost to say so honestly. */
export interface MorningBriefRequestAllocation {
  readonly items: readonly MorningBriefSourceItem[];
  readonly bytes: number;
  readonly omittedBySource: Readonly<
    Partial<Record<MorningBriefSourceKind, number>>
  >;
  readonly omittedItems: number;
  readonly omittedBytes: number;
}

/**
 * Fill the model request in rounds, one item per nonempty source at a time.
 *
 * Concatenating sources in order is the failure this replaces: a busy inbox
 * would consume every byte and the brief would silently claim the owner had no
 * meetings. Round-robin over the fixed order means a large early source can
 * only ever take one slot ahead of the others, and each source keeps its own
 * priority ranking inside its queue.
 *
 * Items are dropped whole. Nothing is sliced, so a truncated body can never be
 * attributed to a real record, and the omission counts returned here are what
 * the coverage note reports.
 */
export function allocateMorningBriefRequest(
  collections: readonly MorningBriefSourceCollection[],
  options: {
    readonly maxBytes?: number;
    /**
     * Bytes the fixed request envelope already spends before any evidence:
     * the language policy, the output schema, the coverage report and the
     * frozen Agent instruction text. Evidence may only use what is left.
     */
    readonly overheadBytes?: number;
  } = {},
): MorningBriefRequestAllocation {
  const maxBytes = options.maxBytes ?? MORNING_BRIEF_REQUEST_MAX_BYTES;
  const capacity = Math.max(0, maxBytes - (options.overheadBytes ?? 0));
  const queues = MORNING_BRIEF_SOURCE_ORDER.map((source) => {
    const collection = collections.find((candidate) => {
      return candidate.source === source;
    });
    return {
      source,
      items: [...(collection?.items ?? [])].sort((left, right) => {
        return left.priority - right.priority;
      }),
      cursor: 0,
      placed: false,
    };
  }).filter((queue) => {
    return queue.items.length > 0;
  });

  const accepted: MorningBriefSourceItem[] = [];
  const omittedBySource = new Map<MorningBriefSourceKind, number>();
  let bytes = 0;
  let omittedBytes = 0;

  /**
   * The sources whose first item the opening round holds capacity for.
   *
   * Round-robin alone does not make the first round fair: an early source's
   * first item can be large enough to consume everything that is left, and a
   * later source with a small first item then contributes nothing at all. So
   * until every source has placed one item, an admission also leaves room for
   * the first item of each source still waiting.
   *
   * Reserving for *every* waiting source is the defect that replaces: a
   * reservation nobody can honour suppresses the items that could have been
   * honoured. A 247-byte Calendar item and a 40,242-byte Chat item sharing
   * 1,000 bytes of capacity both got dropped, because Calendar was charged a
   * reserve for a Chat item that could never fit under any allocation at all —
   * so the attempt reported that nothing fitted while holding something that
   * did.
   *
   * The reservation is therefore chosen up front and is always jointly
   * satisfiable: smallest first item first, taking each while the running total
   * still fits the capacity. Smallest-first admits the largest number of
   * sources any selection can, and among those the one that leaves the most
   * room for the rounds that follow; equal sizes keep the fixed source order.
   * A source left out of it is not excluded from the request — it simply
   * carries no reservation, and still takes its ordinary turn in every round.
   */
  const reservedFirstBytes = new Map<MorningBriefSourceKind, number>();
  const firstItemCharges = queues
    .map((queue, index) => {
      const first = queue.items[0];
      return {
        source: queue.source,
        index,
        bytes: first === undefined ? 0 : morningBriefItemBytes(first),
      };
    })
    .filter((entry) => {
      return entry.bytes > 0;
    })
    .sort((left, right) => {
      return left.bytes - right.bytes || left.index - right.index;
    });
  let reservedTotal = 0;
  for (const entry of firstItemCharges) {
    if (reservedTotal + entry.bytes > capacity) {
      continue;
    }
    reservedTotal += entry.bytes;
    reservedFirstBytes.set(entry.source, entry.bytes);
  }

  /** What the still-waiting reserved sources after this one are holding. */
  const reserveForWaitingSources = (afterIndex: number): number => {
    let reserve = 0;
    for (let index = afterIndex + 1; index < queues.length; index += 1) {
      const queue = queues[index];
      if (queue === undefined || queue.placed) {
        continue;
      }
      reserve += reservedFirstBytes.get(queue.source) ?? 0;
    }
    return reserve;
  };

  // A source is only retired from the rounds once its queue is exhausted, so a
  // single oversized item cannot end that source's turn for the whole request.
  let remaining = queues.length;
  let firstRound = true;
  while (remaining > 0) {
    remaining = 0;
    for (const [index, queue] of queues.entries()) {
      if (queue.cursor >= queue.items.length) {
        continue;
      }
      const item = queue.items[queue.cursor];
      queue.cursor += 1;
      if (queue.cursor < queue.items.length) {
        remaining += 1;
      }
      if (item === undefined) {
        continue;
      }
      const itemBytes = morningBriefItemBytes(item);
      // One items array carries every source, so only the very first item
      // placed pays no separator. Charging exactly what the array grows by is
      // what lets a request budgeted to the ceiling reach it precisely.
      const charge = itemBytes - (accepted.length === 0 ? 1 : 0);
      const reserve = firstRound ? reserveForWaitingSources(index) : 0;
      if (bytes + charge + reserve > capacity) {
        omittedBySource.set(
          queue.source,
          (omittedBySource.get(queue.source) ?? 0) + 1,
        );
        omittedBytes += itemBytes;
        continue;
      }
      bytes += charge;
      queue.placed = true;
      accepted.push(item);
    }
    firstRound = false;
  }

  const omitted: Partial<Record<MorningBriefSourceKind, number>> = {};
  let omittedItems = 0;
  for (const [source, count] of omittedBySource) {
    omitted[source] = count;
    omittedItems += count;
  }
  return {
    items: accepted,
    bytes,
    omittedBySource: omitted,
    omittedItems,
    omittedBytes,
  };
}
