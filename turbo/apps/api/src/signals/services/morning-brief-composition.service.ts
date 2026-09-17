/**
 * The one source-independent Morning Brief composition.
 *
 * Every caller reaches the same engine: it admits the owner through the shared
 * admission that no connector participates in, reads whichever sources that
 * owner actually has, normalizes them into one evidence set, and assembles the
 * exact request a single model call would receive. Gmail-only, Slack-only and
 * no-connector owners all arrive here — an owner without Slack is not an owner
 * without a morning.
 *
 * Two orderings are load-bearing and neither is incidental:
 *
 * - **Every network read finishes before any content is released.** Provider
 *   reads, the language archive read and the request assembly all happen first;
 *   only then is the owner's authority rechecked against live state with a
 *   fresh clock. A revocation during a held storage read must not find the
 *   content already on its way out.
 * - **Language context is read only when there is candidate content.** A
 *   healthy empty collection settles with no storage I/O at all, because asking
 *   which language to write a brief in that will not be written is work nobody
 *   authorized.
 *
 * One absolute deadline, resolved before admission from the phase and the
 * caller's own budget, covers every step including admission itself and the
 * final authority and version checks. It is sampled from the clock after each
 * wait and immediately before the attempt commits to a request, because a
 * timeout callback that has not been delivered yet is not remaining time.
 * Equality is expired.
 *
 * Every started source job is joined before this call completes. A source that
 * fails records its own outcome and leaves its authorized siblings intact, and
 * caller cancellation propagates only once the work this attempt started has
 * settled — nothing is detached and nothing outlives the answer.
 *
 * No database transaction wraps any of this, and no provider payload survives
 * the call.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import type { MorningBriefChatCollection } from "@okouai/api-contracts/contracts/morning-brief-chat-collection-preview";
import type { MorningBriefSourceFailure } from "@okouai/api-contracts/contracts/morning-brief-gmail-collection-preview";
import { MORNING_BRIEF_COLLECTION_VERSION } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { clerk$, type ClerkClient } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  admitMorningBriefCollection,
  startMorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
  type MorningBriefSourceDeadline,
} from "./morning-brief-connector-reader.service";
import {
  allocateMorningBriefRequest,
  morningBriefCompositionDeadline,
  morningBriefSourceBudget,
  morningBriefSourceWaves,
  MORNING_BRIEF_REQUEST_MAX_BYTES,
  type MorningBriefCompositionDeadline,
} from "./morning-brief-collection-plan";
import { collectMorningBriefCalendar } from "./morning-brief-calendar-collection.service";
import {
  morningBriefCalendarDescriptor,
  normalizeMorningBriefCalendar,
} from "./morning-brief-calendar-source";
import { collectMorningBriefChat$ } from "./morning-brief-chat-collection.service";
import {
  morningBriefChatDescriptor,
  normalizeMorningBriefChat,
} from "./morning-brief-chat-source";
import { executeMorningBriefGithubCollection } from "./morning-brief-github-collection.service";
import {
  morningBriefGithubDescriptor,
  normalizeMorningBriefGithub,
} from "./morning-brief-github-source";
import { collectMorningBriefGmail } from "./morning-brief-gmail-collection.service";
import {
  morningBriefGmailDescriptor,
  normalizeMorningBriefGmail,
} from "./morning-brief-gmail-source";
import {
  readMorningBriefLanguageContext$,
  resolveMorningBriefInstructionsVersion,
} from "./morning-brief-language-context.service";
import {
  planMorningBriefLanguage,
  type MorningBriefLanguagePlan,
} from "./morning-brief-language-policy";
import { loadMorningBriefMemberLocale } from "./morning-brief-member-locale.service";
import {
  buildMorningBriefRequest,
  morningBriefCoverageReport,
  morningBriefEnvelopeBytes,
  morningBriefRequestBytes,
  morningBriefWidestCoverageReport,
} from "./morning-brief-request-envelope";
import { collectMorningBriefSlackBundle } from "./morning-brief-slack-collection.service";
import {
  morningBriefSlackDescriptor,
  normalizeMorningBriefSlack,
} from "./morning-brief-slack-source";
import {
  boundMorningBriefDescriptors,
  type MorningBriefRetainedSourceDescriptor,
} from "./morning-brief-source-authority";
import {
  boundCombinedNormalizedItems,
  dedupeMorningBriefItems,
  type MorningBriefSourceCollection,
  type MorningBriefSourceKind,
} from "./morning-brief-source-item";
import { slackUserInstallation } from "./slack-data.service";

/**
 * Chat's reader, bound by the caller.
 *
 * `collectMorningBriefChat$` is a ccstate command, so it can only be invoked
 * from inside a command scope. Binding it once keeps the per-source readers
 * plain functions instead of threading the accessor through every one of them.
 */
type ChatReader = (
  signal: AbortSignal,
) => Promise<MorningBriefChatCollection | null>;

/** The native Slack installation this member reads through. */
interface SlackBinding {
  readonly botToken: string;
  readonly workspaceId: string;
  readonly slackUserId: string;
}

/** Slack's frozen window is the 24 hours ending at the anchor. */
const MORNING_BRIEF_SLACK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How a source finished, including the ways it never ran.
 *
 * `not-started` is the composition's own fact rather than a normalized read
 * outcome: the source was applicable and the attempt's own budget ran out
 * before it could be admitted. Dropping it would make an exhausted attempt
 * indistinguishable from an owner who has that source connected and quiet.
 */
type MorningBriefCompositionCoverage =
  | MorningBriefSourceCollection["coverage"]
  | "not-started";

/** One applicable source's outcome, with no evidence in it. */
interface MorningBriefCompositionSourceOutcome {
  readonly source: MorningBriefSourceKind;
  readonly coverage: MorningBriefCompositionCoverage;
  readonly items: number;
  readonly requests: number;
}

/** True when a source gave an affirmative answer about this owner's day. */
function settledCoverage(coverage: MorningBriefCompositionCoverage): boolean {
  return (
    coverage === "unconfigured" ||
    coverage === "empty" ||
    coverage === "complete"
  );
}

/** What one composition attempt produced, with no provider payload in it. */
interface MorningBriefCompositionResult {
  readonly sources: readonly MorningBriefCompositionSourceOutcome[];
  readonly deadline: {
    readonly startedAt: string;
    readonly deadlineAt: string;
    readonly source: MorningBriefCompositionDeadline["source"];
  };
  readonly waves: readonly (readonly MorningBriefSourceKind[])[];
  readonly normalizedBytes: number;
  readonly omittedByNormalizedCap: number;
  readonly request: {
    readonly envelopeBytes: number;
    readonly totalBytes: number;
    readonly maxBytes: number;
    readonly items: number;
    readonly omittedItems: number;
    readonly omittedBytes: number;
  } | null;
  readonly language: MorningBriefLanguagePlan | null;
  readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
}

/** Why a composition produced no model request. */
type MorningBriefCompositionOutcome =
  | {
      readonly kind: "composed";
      readonly result: MorningBriefCompositionResult;
    }
  /** Nothing was configured or everything healthy-empty: settle, send nothing. */
  | {
      readonly kind: "empty";
      readonly result: MorningBriefCompositionResult;
    }
  /**
   * Usable evidence existed but no request could be made.
   *
   * This is never a healthy empty: the owner had material and the pipeline
   * could not act on it, which has to stay distinguishable so a configuration
   * problem is recovered rather than reported as a quiet morning.
   */
  | {
      readonly kind: "incomplete";
      readonly reason:
        | "language-context-unavailable"
        | "retained-authority-unbounded"
        | "no-item-fits"
        /** The one absolute deadline was reached before the attempt finished. */
        | "deadline-exceeded"
        /** Every source that could have answered failed. */
        | "all-sources-failed"
        /** Nothing contributed and some applicable source never answered. */
        | "incomplete-coverage";
      readonly detail: string;
      /**
       * What each applicable source did, as far as this attempt got.
       *
       * A non-success outcome is exactly where these facts matter: knowing that
       * Chat was never started, rather than that it was quiet, is what makes
       * the difference between recovering the attempt and delivering silence.
       * Empty when the attempt ended before the source plan existed.
       */
      readonly sources: readonly MorningBriefCompositionSourceOutcome[];
    }
  | {
      readonly kind: "denied";
      readonly reason: string;
    }
  /** The owner's authority moved while this attempt was reading. */
  | { readonly kind: "authority-changed" };

/**
 * Run one bounded, source-independent composition.
 *
 * The absolute deadline covers everything from admission to the final authority
 * check, and `deadlineAt` lets a caller that owns a tighter budget hand it in.
 */
export const composeMorningBrief$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly anchor: Date;
      /** The caller's own budget, when it is tighter than the phase. */
      readonly deadlineAt?: Date | null;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefCompositionOutcome> => {
    const db: Db = set(writeDb$);
    const clerk = get(clerk$);
    const deadline = morningBriefCompositionDeadline(
      nowDate(),
      args.deadlineAt ?? null,
    );
    const phaseStartedAt = deadline.startedAt;
    const phaseDeadlineAt = deadline.deadlineAt;
    // One phase deadline, started before the admission that reads canonical
    // state and this member's live membership, so the preflight spends the same
    // budget the sources are allocated out of instead of running outside it.
    // Its instant is the attempt's own resolved deadline rather than a fresh
    // phase, so a caller's tighter budget reaches the preflight too.
    const phaseDeadline = startMorningBriefSourceDeadline(
      Math.max(0, phaseDeadlineAt.getTime() - nowDate().getTime()),
    );
    const expired = (step: string): MorningBriefDeadlineExceeded | null => {
      return morningBriefExpired(phaseDeadlineAt, step);
    };

    const admitted = await admitMorningBriefAttempt(
      { db, clerk, args, phaseDeadlineAt, phaseDeadline },
      signal,
    );
    if (admitted.kind !== "admitted") {
      return admitted;
    }
    const { scope } = admitted;

    // Discovering the native installation is this attempt's work too, so the
    // clock is sampled again before any source is admitted on its result.
    const installation = await get(
      slackUserInstallation({ orgId: scope.orgId, userId: scope.userId }),
    );
    signal.throwIfAborted();
    const afterBinding = expired("Slack binding discovery");
    if (afterBinding) {
      return afterBinding;
    }
    const { configured, slackBinding } = configuredSources(installation);
    // Bound once, inside the command scope Chat's collector requires.
    const readChat: ChatReader = async (chatSignal) => {
      const collected = await set(
        collectMorningBriefChat$,
        { owner: scope, scheduledFor: scope.anchor },
        chatSignal,
      );
      return collected.kind === "collected" ? collected.collection : null;
    };
    const waves = morningBriefSourceWaves(configured);

    const { collections, descriptors, notStarted } =
      await collectMorningBriefWaves(
        {
          waves,
          db,
          clerk,
          scope,
          slack: slackBinding,
          phaseStartedAt,
          phaseDeadlineAt,
          readChat,
        },
        signal,
      );
    // Every started reader has settled by now, so cancellation is reported here
    // rather than from inside a wave that would have abandoned its siblings.
    signal.throwIfAborted();
    const afterSources = expired("source collection");
    if (afterSources) {
      return afterSources;
    }
    const reduced = reduceMorningBriefCollections({
      waves,
      collections,
      descriptors,
      notStarted,
    });
    if (reduced.kind === "incomplete") {
      return reduced;
    }
    const base = {
      sources: reduced.sources,
      deadline: {
        startedAt: phaseStartedAt.toISOString(),
        deadlineAt: phaseDeadlineAt.toISOString(),
        source: deadline.source,
      },
      waves,
      normalizedBytes: reduced.bounded.bytes,
      omittedByNormalizedCap: reduced.bounded.omitted,
      descriptors: reduced.descriptors,
    };

    if (reduced.contributed.size === 0) {
      const unsettled = unsettledSources(reduced.sources);
      if (unsettled !== null) {
        // Nothing contributed and something never answered. Reporting a quiet
        // morning here would describe a failed or abandoned read as the owner's
        // day, so it stays an explicit non-success with no request at all.
        return unsettled;
      }
      // Healthy empty: settle with no language I/O, no request and no delivery.
      return {
        kind: "empty",
        result: { ...base, request: null, language: null },
      };
    }
    const planned = await set(
      planMorningBriefRequest$,
      {
        scope,
        collections: reduced.bounded.collections,
        phaseDeadlineAt,
        phaseDeadline,
        args,
      },
      signal,
    );
    if (planned.kind === "incomplete") {
      return { ...planned, sources: reduced.sources };
    }
    if (planned.kind !== "planned") {
      return planned;
    }
    return { kind: "composed", result: composedResult(base, planned) };
  },
);

/** The request report one planned composition produced. */
function composedResult(
  base: Omit<MorningBriefCompositionResult, "request" | "language">,
  planned: {
    readonly language: MorningBriefLanguagePlan;
    readonly envelopeBytes: number;
    readonly totalBytes: number;
    readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
  },
): MorningBriefCompositionResult {
  return {
    ...base,
    language: planned.language,
    request: {
      envelopeBytes: planned.envelopeBytes,
      totalBytes: planned.totalBytes,
      maxBytes: MORNING_BRIEF_REQUEST_MAX_BYTES,
      items: planned.allocation.items.length,
      omittedItems: planned.allocation.omittedItems,
      omittedBytes: planned.allocation.omittedBytes,
    },
  };
}

/**
 * Admit the owner inside this attempt's own deadline.
 *
 * Admission is the attempt's work too, so the clock is sampled before it starts
 * and again after it answers: an admission that spent the whole phase leaves
 * every source a zero budget, and reporting that as a quiet morning describes a
 * day nothing ever read.
 */
async function admitMorningBriefAttempt(
  input: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly args: {
      readonly orgId: string;
      readonly userId: string;
      readonly anchor: Date;
    };
    readonly phaseDeadlineAt: Date;
    readonly phaseDeadline: MorningBriefSourceDeadline;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "admitted"; readonly scope: MorningBriefCollectionScope }
  | MorningBriefDeadlineExceeded
  | { readonly kind: "denied"; readonly reason: string }
> {
  const { db, clerk, args, phaseDeadlineAt } = input;
  const beforeAdmission = morningBriefExpired(
    phaseDeadlineAt,
    "before admission",
  );
  if (beforeAdmission) {
    return beforeAdmission;
  }
  const admitted = await admitMorningBriefCollection(
    {
      db,
      clerk,
      orgId: args.orgId,
      userId: args.userId,
      anchor: args.anchor,
      deadline: input.phaseDeadline,
    },
    morningBriefPhaseSignal(signal, phaseDeadlineAt),
  );
  signal.throwIfAborted();
  const afterAdmission = morningBriefExpired(phaseDeadlineAt, "admission");
  if (afterAdmission) {
    return afterAdmission;
  }
  if (admitted.kind !== "ok") {
    return { kind: "denied", reason: admitted.reason };
  }
  return { kind: "admitted", scope: admitted.scope };
}

/**
 * The caller's signal, cut off no later than this attempt's own deadline.
 *
 * A step that waits on the network without consulting the clock is still
 * stopped by this, and every step that can consult the clock still does — the
 * timer is the backstop, never the fence, because its callback can be delivered
 * arbitrarily late under load.
 */
function morningBriefPhaseSignal(
  signal: AbortSignal,
  deadlineAt: Date,
): AbortSignal {
  const remainingMs = Math.max(0, deadlineAt.getTime() - nowDate().getTime());
  return AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]);
}

/** The one outcome an expired attempt may answer with. */
interface MorningBriefDeadlineExceeded {
  readonly kind: "incomplete";
  readonly reason: "deadline-exceeded";
  readonly detail: string;
  readonly sources: readonly MorningBriefCompositionSourceOutcome[];
}

/**
 * Sample the clock against the one absolute deadline. Equality is expired.
 *
 * Returns the outcome to answer with, so a caller cannot accidentally observe
 * expiry and continue anyway.
 */
function morningBriefExpired(
  deadlineAt: Date,
  step: string,
  sources: readonly MorningBriefCompositionSourceOutcome[] = [],
): MorningBriefDeadlineExceeded | null {
  if (nowDate().getTime() < deadlineAt.getTime()) {
    return null;
  }
  return {
    kind: "incomplete",
    reason: "deadline-exceeded",
    detail: `${step} reached ${deadlineAt.toISOString()}`,
    sources,
  };
}

/**
 * Reduce one attempt's raw reads into the facts every outcome is built from.
 *
 * Deduplication, the combined normalized ceiling and the descriptor bound all
 * apply here, so the source report and the retained authority always describe
 * the same reduced evidence the request would be assembled from.
 */
function reduceMorningBriefCollections(input: {
  readonly waves: readonly (readonly MorningBriefSourceKind[])[];
  readonly collections: readonly MorningBriefSourceCollection[];
  readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
  readonly notStarted: ReadonlySet<MorningBriefSourceKind>;
}):
  | {
      readonly kind: "reduced";
      readonly sources: readonly MorningBriefCompositionSourceOutcome[];
      readonly bounded: ReturnType<typeof boundCombinedNormalizedItems>;
      readonly contributed: ReadonlySet<MorningBriefSourceKind>;
      readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
    }
  | Extract<MorningBriefCompositionOutcome, { kind: "incomplete" }> {
  const deduped = input.collections.map((collection) => {
    return {
      ...collection,
      items: dedupeMorningBriefItems(collection.items),
    };
  });
  const bounded = boundCombinedNormalizedItems(deduped);
  const sources = sourceSummary(
    input.waves,
    bounded.collections,
    input.notStarted,
  );
  const contributed = new Set(
    bounded.collections
      .filter((collection) => {
        return collection.items.length > 0;
      })
      .map((collection) => {
        return collection.source;
      }),
  );
  const retained = boundMorningBriefDescriptors(
    input.descriptors.map((descriptor) => {
      return {
        ...descriptor,
        contributed: contributed.has(descriptor.source),
      };
    }),
  );
  if (retained.kind === "rejected") {
    // Failing closed is the whole point of the bound: a descriptor set that
    // quietly became empty would let every later permission check pass by
    // having nothing to check, while the evidence it was meant to cover went
    // out anyway.
    return {
      kind: "incomplete",
      reason: "retained-authority-unbounded",
      detail: retained.reason,
      sources,
    };
  }
  return {
    kind: "reduced",
    sources,
    bounded,
    contributed,
    descriptors: retained.descriptors,
  };
}

/**
 * Classify a collection that contributed nothing.
 *
 * Healthy empty needs an affirmative answer from every applicable source.
 * Unconfigured sources stay silent — an owner who never connected GitHub still
 * had a quiet morning — but a failed, partial or never-started source means
 * this attempt does not know what the owner's day held.
 */
function unsettledSources(
  sources: readonly MorningBriefCompositionSourceOutcome[],
): MorningBriefCompositionOutcome | null {
  const answerable = sources.filter((entry) => {
    return entry.coverage !== "unconfigured";
  });
  const unsettled = answerable.filter((entry) => {
    return !settledCoverage(entry.coverage);
  });
  if (unsettled.length === 0) {
    return null;
  }
  const named = unsettled
    .map((entry) => {
      return `${entry.source}=${entry.coverage}`;
    })
    .join(", ");
  const failed = unsettled.every((entry) => {
    return entry.coverage === "failed";
  });
  if (failed && unsettled.length === answerable.length) {
    return {
      kind: "incomplete",
      reason: "all-sources-failed",
      detail: named,
      sources,
    };
  }
  return {
    kind: "incomplete",
    reason: "incomplete-coverage",
    detail: named,
    sources,
  };
}

/** The distinct containers a normalized collection drew from, in first-seen order. */
function containerIds(
  collection: MorningBriefSourceCollection,
): readonly string[] {
  const seen = new Set<string>();
  for (const item of collection.items) {
    seen.add(item.identity.container);
  }
  return [...seen];
}

/** One source's bounded read, normalized with the descriptor it proves. */
type CollectedSource = {
  readonly normalized: MorningBriefSourceCollection;
  /**
   * Null when the source produced no authorized read at all.
   *
   * A descriptor is evidence that a specific input was authorized. A source
   * that was never admitted has no such input, and fabricating one would give a
   * later permission check something to pass against that nothing observed.
   */
  readonly descriptor: MorningBriefRetainedSourceDescriptor | null;
} | null;

/**
 * What one applicable source's job produced.
 *
 * `not-started` is deliberately not a failed read: the budget ran out before
 * this source was admitted, and reporting it as a failure would claim a read
 * observed something. It is also not nothing, which is what it used to become.
 */
type MorningBriefSourceAttempt =
  | { readonly kind: "read"; readonly collected: CollectedSource }
  | { readonly kind: "not-started" };

/**
 * Report a source the owner never connected as unconfigured, not failed.
 *
 * The connector-backed collectors answer "not connected" through the same
 * unavailable envelope they use for a broken credential, so their normalizers
 * see one shape and call all of it `failed`. Only the composition knows the
 * difference matters: an owner who never connected Calendar still had a quiet
 * morning, while an owner whose Calendar credential broke did not.
 */
function withConfiguredCoverage(
  normalized: MorningBriefSourceCollection,
  failure: MorningBriefSourceFailure | null,
): MorningBriefSourceCollection {
  if (normalized.coverage !== "failed" || failure !== "not-connected") {
    return normalized;
  }
  return { ...normalized, coverage: "unconfigured" };
}

/** A source that answered nothing usable, as the composition records it. */
function failedCollection(
  source: MorningBriefSourceKind,
): MorningBriefSourceCollection {
  return {
    source,
    coverage: "failed",
    items: [],
    requests: 0,
    omittedBySource: 0,
  };
}

/**
 * Read one source inside the budget the plan allows it.
 *
 * A source whose budget has already run out is reported as not started rather
 * than as a failed read: it was never started, which is a different fact from a
 * read that failed.
 */
async function readMorningBriefSource(
  args: {
    readonly source: MorningBriefSourceKind;
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: SlackBinding | null;
    readonly phaseStartedAt: Date;
    readonly phaseDeadlineAt: Date;
    readonly capturedAt: Date;
    readonly readChat: ChatReader;
  },
  signal: AbortSignal,
): Promise<MorningBriefSourceAttempt> {
  const { source, db, clerk, scope, capturedAt } = args;
  const budget = morningBriefSourceBudget(
    source,
    args.phaseStartedAt,
    nowDate(),
    args.phaseDeadlineAt,
  );
  const budgetMs = Math.max(
    0,
    budget.deadlineAt.getTime() - nowDate().getTime(),
  );
  if (budgetMs === 0 || (source === "slack" && args.slack === null)) {
    return { kind: "not-started" };
  }
  // The composition already allocated this source's absolute deadline, so the
  // reader is handed that exact instant rather than starting a second budget of
  // its own.
  const sourceDeadline: MorningBriefSourceDeadline = {
    at: budget.deadlineAt.getTime(),
    signal: AbortSignal.timeout(budgetMs),
  };
  const sourceSignal = AbortSignal.any([signal, sourceDeadline.signal]);
  const read = async (): Promise<CollectedSource> => {
    if (source === "calendar") {
      return await readCalendarSource(
        { db, clerk, scope, capturedAt, deadline: sourceDeadline },
        sourceSignal,
      );
    }
    if (source === "github") {
      return await readGithubSource(
        { db, clerk, scope, capturedAt, deadline: sourceDeadline },
        sourceSignal,
      );
    }
    if (source === "chat") {
      return await readChatSource(
        { scope, capturedAt, readChat: args.readChat },
        sourceSignal,
      );
    }
    if (source === "gmail") {
      return await readGmailSource(
        { db, clerk, scope, capturedAt, deadline: sourceDeadline },
        sourceSignal,
      );
    }
    if (args.slack === null) {
      return null;
    }
    return await readSlackSource(
      { scope, capturedAt, slack: args.slack, budgetMs },
      sourceSignal,
    );
  };
  return { kind: "read", collected: await read() };
}

/**
 * Resolve the language, assemble the request, and prove the authority again.
 *
 * Everything here awaits the network, so the authority recheck lives at the end
 * of it rather than before it: the point of the check is that nothing observed
 * during those awaits has already been released.
 */
const planMorningBriefRequest$ = command(
  async (
    { get, set },
    input: {
      readonly scope: MorningBriefCollectionScope;
      readonly collections: readonly MorningBriefSourceCollection[];
      readonly phaseDeadlineAt: Date;
      readonly phaseDeadline: MorningBriefSourceDeadline;
      readonly args: {
        readonly orgId: string;
        readonly userId: string;
        readonly anchor: Date;
      };
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "planned";
        readonly language: MorningBriefLanguagePlan;
        readonly envelopeBytes: number;
        readonly totalBytes: number;
        readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
      }
    | {
        readonly kind: "incomplete";
        readonly reason:
          | "language-context-unavailable"
          | "no-item-fits"
          | "deadline-exceeded";
        readonly detail: string;
      }
    | { readonly kind: "authority-changed" }
  > => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const { scope, phaseDeadlineAt, phaseDeadline, args } = input;
    const phaseSignal = morningBriefPhaseSignal(signal, phaseDeadlineAt);
    const bounded = { collections: input.collections };
    const expired = (step: string): MorningBriefDeadlineExceeded | null => {
      return morningBriefExpired(phaseDeadlineAt, step);
    };

    const context = await set(
      readMorningBriefLanguageContext$,
      { owner: scope, agentId: scope.agentId, deadlineAt: phaseDeadlineAt },
      phaseSignal,
    );
    signal.throwIfAborted();
    const afterLanguage = expired("language context");
    if (afterLanguage) {
      return afterLanguage;
    }
    if (context.kind === "unavailable") {
      // An owner whose instructions cannot be read has not asked for English.
      return {
        kind: "incomplete",
        reason: "language-context-unavailable",
        detail: context.reason,
      };
    }
    const memberLocale = await loadMorningBriefMemberLocale(db, scope);
    signal.throwIfAborted();
    const afterLocale = expired("member locale");
    if (afterLocale) {
      return afterLocale;
    }
    const language = planMorningBriefLanguage({
      instructions:
        context.kind === "available"
          ? { versionId: context.versionId, digest: context.digest }
          : null,
      memberLocale,
    });
    // The complete text stays in memory and goes straight into the request.
    // Only the version and digest are provenance worth freezing.
    const instructions = context.kind === "available" ? context.text : null;

    const envelopeBytes = morningBriefEnvelopeBytes({
      language,
      instructions,
      // Measured at its widest, because the real counts are only known after
      // allocation and a narrower measurement would under-reserve.
      coverage: morningBriefWidestCoverageReport(bounded.collections),
    });
    const allocation = allocateMorningBriefRequest(bounded.collections, {
      maxBytes: MORNING_BRIEF_REQUEST_MAX_BYTES,
      overheadBytes: envelopeBytes,
    });
    if (allocation.items.length === 0) {
      // Evidence existed and none of it fits beside the fixed context. That is
      // an explicit incomplete outcome with zero model calls, never a brief
      // claiming the owner had a quiet morning.
      return {
        kind: "incomplete",
        reason: "no-item-fits",
        detail: `envelope ${envelopeBytes.toString()} of ${MORNING_BRIEF_REQUEST_MAX_BYTES.toString()} bytes`,
      };
    }
    const request = buildMorningBriefRequest({
      language,
      instructions,
      coverage: morningBriefCoverageReport(
        bounded.collections,
        allocation.omittedBySource,
      ),
      items: allocation.items,
    });
    const totalBytes = morningBriefRequestBytes(request);

    // Everything above awaited the network. Nothing has been released yet, so
    // this is where the owner's authority is proved again — against live state,
    // with a fresh clock, after the last await rather than before the first.
    const proved = await proveMorningBriefAuthority(
      {
        db,
        clerk,
        scope,
        args,
        phaseDeadlineAt,
        phaseDeadline,
        instructionsVersionId:
          context.kind === "available" ? context.versionId : null,
      },
      signal,
    );
    if (proved !== null) {
      return proved;
    }
    return { kind: "planned", language, envelopeBytes, totalBytes, allocation };
  },
);

/**
 * Prove the owner may still commit this request, and that it is still theirs.
 *
 * Returns `null` when the attempt may proceed. Every wait in here is sampled
 * against the one absolute deadline both before and after, because a membership
 * that answered "still allowed" one millisecond before the deadline proves
 * nothing about an attempt that may no longer commit.
 */
async function proveMorningBriefAuthority(
  input: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly args: {
      readonly orgId: string;
      readonly userId: string;
      readonly anchor: Date;
    };
    readonly phaseDeadlineAt: Date;
    readonly phaseDeadline: MorningBriefSourceDeadline;
    /** Null when this owner has no published instructions to freeze. */
    readonly instructionsVersionId: string | null;
  },
  signal: AbortSignal,
): Promise<
  MorningBriefDeadlineExceeded | { readonly kind: "authority-changed" } | null
> {
  const { db, clerk, scope, args, phaseDeadlineAt } = input;
  const expired = (step: string): MorningBriefDeadlineExceeded | null => {
    return morningBriefExpired(phaseDeadlineAt, step);
  };

  const beforeRecheck = expired("final authority check");
  if (beforeRecheck) {
    return beforeRecheck;
  }
  const recheck = await admitMorningBriefCollection(
    {
      db,
      clerk,
      orgId: args.orgId,
      userId: args.userId,
      anchor: args.anchor,
      deadline: input.phaseDeadline,
    },
    morningBriefPhaseSignal(signal, phaseDeadlineAt),
  );
  signal.throwIfAborted();
  const afterRecheck = expired("final authority check");
  if (afterRecheck) {
    return afterRecheck;
  }
  if (
    recheck.kind !== "ok" ||
    recheck.scope.membershipId !== scope.membershipId ||
    recheck.scope.agentId !== scope.agentId ||
    recheck.scope.installationId !== scope.installationId
  ) {
    return { kind: "authority-changed" };
  }
  // The Agent's instruction version is part of the request, so a change to it
  // between the read and the reservation is a changed request, not a detail.
  if (input.instructionsVersionId !== null) {
    const current = await resolveMorningBriefInstructionsVersion(
      db,
      scope,
      scope.agentId,
    );
    signal.throwIfAborted();
    const afterVersion = expired("instruction version check");
    if (afterVersion) {
      return afterVersion;
    }
    if (
      current.kind !== "resolved" ||
      current.versionId !== input.instructionsVersionId
    ) {
      return { kind: "authority-changed" };
    }
  }
  // The last sample before this attempt commits to a request: every wait above
  // is behind us, so nothing else can consume the reserve unobserved.
  return expired("request admission");
}

/**
 * What each applicable source contributed, with no evidence in it.
 *
 * Driven by the wave plan rather than by whatever came back, so a source the
 * budget never admitted is reported as `not-started` instead of vanishing from
 * the report as though the owner never had it.
 */
function sourceSummary(
  waves: readonly (readonly MorningBriefSourceKind[])[],
  collections: readonly MorningBriefSourceCollection[],
  notStarted: ReadonlySet<MorningBriefSourceKind>,
): MorningBriefCompositionResult["sources"] {
  return waves.flat().map((source) => {
    const collection = collections.find((candidate) => {
      return candidate.source === source;
    });
    if (collection === undefined) {
      return {
        source,
        coverage: notStarted.has(source)
          ? ("not-started" as const)
          : ("unconfigured" as const),
        items: 0,
        requests: 0,
      };
    }
    return {
      source,
      coverage: collection.coverage,
      items: collection.items.length,
      requests: collection.requests,
    };
  });
}

/**
 * Run the waves in order, joining each before the next one starts.
 *
 * Joining is what bounds concurrency to the wave size: nothing is detached, and
 * a cancelled attempt cannot leave a reader running past it. Every job in a
 * wave is settled, never merely raced — `Promise.all` returns on the first
 * rejection, which used to let a failed source hand the attempt back while an
 * authorized sibling was still reading a provider with nobody waiting for it.
 *
 * A rejected job is that source's own failure and nothing more: its siblings'
 * evidence stays, and cancellation is raised by the caller once everything this
 * function started has finished.
 */
async function collectMorningBriefWaves(
  input: {
    readonly waves: readonly (readonly MorningBriefSourceKind[])[];
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: SlackBinding | null;
    readonly phaseStartedAt: Date;
    readonly phaseDeadlineAt: Date;
    readonly readChat: ChatReader;
  },
  signal: AbortSignal,
): Promise<{
  readonly collections: readonly MorningBriefSourceCollection[];
  readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
  readonly notStarted: ReadonlySet<MorningBriefSourceKind>;
}> {
  const { waves, db, clerk, scope, phaseStartedAt, phaseDeadlineAt } = input;
  const slackBinding = input.slack;
  const capturedAt = nowDate();
  const collections: MorningBriefSourceCollection[] = [];
  const descriptors: MorningBriefRetainedSourceDescriptor[] = [];
  const notStarted = new Set<MorningBriefSourceKind>();
  // Every job is bound by the caller and by the attempt's own deadline, so a
  // reader that ignores its budget is still cut off with the phase.
  const phaseSignal = morningBriefPhaseSignal(signal, phaseDeadlineAt);

  // Waves are joined one after another, so at most three provider reads are
  // ever in flight and every started read has an owner waiting on it.
  for (const wave of waves) {
    if (signal.aborted || nowDate().getTime() >= phaseDeadlineAt.getTime()) {
      // No new job is started past the deadline or after cancellation, and the
      // sources that never ran keep saying so.
      for (const source of wave) {
        notStarted.add(source);
      }
      continue;
    }
    const finished = await Promise.allSettled(
      wave.map(async (source) => {
        return await readMorningBriefSource(
          {
            source,
            db,
            clerk,
            scope,
            slack: slackBinding,
            phaseStartedAt,
            phaseDeadlineAt,
            capturedAt,
            readChat: input.readChat,
          },
          phaseSignal,
        );
      }),
    );
    for (const [index, settled] of finished.entries()) {
      const source = wave[index];
      if (source === undefined) {
        continue;
      }
      if (settled.status === "rejected") {
        collections.push(failedCollection(source));
        continue;
      }
      if (settled.value.kind === "not-started") {
        notStarted.add(source);
        continue;
      }
      const entry = settled.value.collected;
      if (entry === null) {
        // The reader ran and produced no authorized read. That is a source this
        // attempt cannot speak for, not a source the owner does not have.
        collections.push(failedCollection(source));
        continue;
      }
      collections.push(entry.normalized);
      if (entry.descriptor !== null) {
        descriptors.push(entry.descriptor);
      }
    }
  }
  return { collections, descriptors, notStarted };
}

/**
 * Which sources this owner actually has, frozen for the attempt.
 *
 * Every connector-backed source is attempted: only its own reader knows whether
 * this member has a usable selected connection, and each reports an
 * unconfigured source as an unavailable or not-executed read rather than
 * throwing. Chat is always eligible — zero connectors is not zero Chat. Only
 * Slack is decided here, because its native installation is the organization's
 * own bot rather than a per-member connector row.
 */
function configuredSources(installation: {
  readonly kind: string;
  readonly botToken?: string;
  readonly workspaceId?: string;
  readonly slackUserId?: string;
}): {
  readonly configured: readonly MorningBriefSourceKind[];
  readonly slackBinding: SlackBinding | null;
} {
  const configured: MorningBriefSourceKind[] = [
    "calendar",
    "gmail",
    "github",
    "chat",
  ];
  if (
    installation.kind !== "connected" ||
    installation.botToken === undefined ||
    installation.workspaceId === undefined ||
    installation.slackUserId === undefined
  ) {
    return { configured, slackBinding: null };
  }
  configured.push("slack");
  return {
    configured,
    slackBinding: {
      botToken: installation.botToken,
      workspaceId: installation.workspaceId,
      slackUserId: installation.slackUserId,
    },
  };
}

/** Arguments every connector-backed reader shares. */
interface SourceReadArgs {
  readonly db: Db;
  readonly clerk: ClerkClient;
  readonly scope: MorningBriefCollectionScope;
  readonly capturedAt: Date;
  /** The absolute deadline this composition allocated for the source. */
  readonly deadline: MorningBriefSourceDeadline;
}

async function readCalendarSource(
  args: SourceReadArgs,
  signal: AbortSignal,
): Promise<CollectedSource> {
  const collection = await collectMorningBriefCalendar(
    {
      db: args.db,
      clerk: args.clerk,
      scope: args.scope,
      deadline: args.deadline,
    },
    signal,
  );
  // Like Gmail before its collector returned one, Calendar does not surface the
  // Google account the shared reader resolved. Null records "not observed".
  const normalized = withConfiguredCoverage(
    normalizeMorningBriefCalendar(collection, args.scope.userId),
    collection.failure,
  );
  return {
    normalized,
    descriptor: morningBriefCalendarDescriptor({
      accountRef: null,
      connectionId: null,
      membershipId: args.scope.membershipId,
      agentId: args.scope.agentId,
      capturedAt: args.capturedAt,
      contributed: false,
      containers: containerIds(normalized),
    }),
  };
}

async function readGithubSource(
  args: SourceReadArgs,
  signal: AbortSignal,
): Promise<CollectedSource> {
  const execution = await executeMorningBriefGithubCollection(
    {
      db: args.db,
      clerk: args.clerk,
      owner: { orgId: args.scope.orgId, userId: args.scope.userId },
      anchor: args.scope.anchor,
    },
    signal,
  );
  if (execution.kind !== "collected") {
    // "Not executed" and "invalid anchor" both produce nothing, but neither is
    // a healthy empty read, so neither may be reported as one — and neither
    // authorized an input, so neither yields a descriptor.
    return {
      normalized: {
        source: "github",
        coverage: execution.kind === "not-executed" ? "unconfigured" : "failed",
        items: [],
        requests: 0,
        omittedBySource: 0,
      },
      descriptor: null,
    };
  }
  const normalized = normalizeMorningBriefGithub(execution.bundle);
  return {
    normalized,
    descriptor: morningBriefGithubDescriptor({
      // The exact login of the selected token, resolved by the collector.
      login: execution.bundle.login,
      connectionId: null,
      membershipId: args.scope.membershipId,
      agentId: args.scope.agentId,
      capturedAt: args.capturedAt,
      contributed: false,
      containers: containerIds(normalized),
    }),
  };
}

async function readChatSource(
  args: Pick<SourceReadArgs, "scope" | "capturedAt"> & {
    readonly readChat: ChatReader;
  },
  signal: AbortSignal,
): Promise<CollectedSource> {
  const collection = await args.readChat(signal);
  if (collection === null) {
    // Not installed or owner unavailable. Chat is always applicable, so this is
    // a source that did not answer rather than a source the owner lacks: the
    // wave records it as failed instead of dropping it from the report.
    return null;
  }
  const normalized = normalizeMorningBriefChat(collection, args.scope.userId);
  return {
    normalized,
    descriptor: morningBriefChatDescriptor({
      userId: args.scope.userId,
      membershipId: args.scope.membershipId,
      agentId: args.scope.agentId,
      capturedAt: args.capturedAt,
      contributed: false,
      containers: containerIds(normalized),
    }),
  };
}

async function readGmailSource(
  args: SourceReadArgs,
  signal: AbortSignal,
): Promise<CollectedSource> {
  const collection = await collectMorningBriefGmail(
    {
      db: args.db,
      clerk: args.clerk,
      scope: args.scope,
      deadline: args.deadline,
    },
    signal,
  );
  // The exact mailbox the shared reader resolved for this member's selected
  // connection. Null means the reader never resolved one, which a later check
  // treats as unproven rather than as any mailbox.
  const normalized = withConfiguredCoverage(
    normalizeMorningBriefGmail(
      collection,
      collection.accountEmail ?? args.scope.userId,
    ),
    collection.failure,
  );
  return {
    normalized,
    descriptor: morningBriefGmailDescriptor({
      accountEmail: collection.accountEmail,
      connectionId: null,
      membershipId: args.scope.membershipId,
      agentId: args.scope.agentId,
      capturedAt: args.capturedAt,
      contributed: false,
      containers: containerIds(normalized),
    }),
  };
}

async function readSlackSource(
  args: Pick<SourceReadArgs, "scope" | "capturedAt"> & {
    readonly slack: SlackBinding;
    readonly budgetMs: number;
  },
  signal: AbortSignal,
): Promise<CollectedSource> {
  const { slack, scope, capturedAt } = args;
  const describe = (
    containers: readonly string[],
  ): MorningBriefRetainedSourceDescriptor => {
    return morningBriefSlackDescriptor({
      workspaceId: slack.workspaceId,
      slackUserId: slack.slackUserId,
      membershipId: scope.membershipId,
      agentId: scope.agentId,
      capturedAt,
      contributed: false,
      containers,
    });
  };
  const collected = await collectMorningBriefSlackBundle(
    {
      botToken: slack.botToken,
      slackUserId: slack.slackUserId,
      workspaceId: slack.workspaceId,
      windowStart: new Date(
        scope.anchor.getTime() - MORNING_BRIEF_SLACK_WINDOW_MS,
      ),
      windowEnd: scope.anchor,
      timezone: scope.timezone,
      version: MORNING_BRIEF_COLLECTION_VERSION,
    },
    {
      clock: () => {
        return nowDate().getTime();
      },
      deadline: nowDate().getTime() + args.budgetMs,
    },
    signal,
  );
  if (collected.kind !== "collected") {
    return {
      normalized: {
        source: "slack",
        coverage: "failed",
        items: [],
        requests: 0,
        omittedBySource: 0,
      },
      descriptor: describe([]),
    };
  }
  const normalized = normalizeMorningBriefSlack(collected.bundle, {
    workspaceId: slack.workspaceId,
    slackUserId: slack.slackUserId,
  });
  return { normalized, descriptor: describe(containerIds(normalized)) };
}
