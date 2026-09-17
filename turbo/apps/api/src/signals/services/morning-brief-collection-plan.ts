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
 * Held back for the final authority checks and the guarded commit.
 *
 * It is a reserve, not a grace period: a source read that has not started by
 * the cutoff does not start at all, because a read that finishes after the
 * commit window has nowhere to be finalized.
 */
export const MORNING_BRIEF_FINAL_CHECK_RESERVE_MS = 5000;

/** No new provider read is admitted at or after this point in the phase. */
export const MORNING_BRIEF_NEW_READ_CUTOFF_MS =
  MORNING_BRIEF_COLLECTION_PHASE_MS - MORNING_BRIEF_FINAL_CHECK_RESERVE_MS;

/** At most three sources are in flight; the rest queue in the fixed order. */
export const MORNING_BRIEF_MAX_CONCURRENT_SOURCES = 3;

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
interface MorningBriefRequestAllocation {
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
   * What the sources that have not yet placed anything still need.
   *
   * Round-robin alone does not make the first round fair: an early source's
   * first item can be large enough to consume everything that is left, and a
   * later source with a small first item then contributes nothing at all. So
   * until every source has placed one item, an admission must also leave room
   * for the first item of each source still waiting.
   */
  const reserveForWaitingSources = (afterIndex: number): number => {
    let reserve = 0;
    for (let index = afterIndex + 1; index < queues.length; index += 1) {
      const queue = queues[index];
      if (queue === undefined || queue.placed) {
        continue;
      }
      const first = queue.items[0];
      if (first !== undefined) {
        reserve += morningBriefItemBytes(first);
      }
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
      const reserve = firstRound ? reserveForWaitingSources(index) : 0;
      if (bytes + itemBytes + reserve > capacity) {
        omittedBySource.set(
          queue.source,
          (omittedBySource.get(queue.source) ?? 0) + 1,
        );
        omittedBytes += itemBytes;
        continue;
      }
      bytes += itemBytes;
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
