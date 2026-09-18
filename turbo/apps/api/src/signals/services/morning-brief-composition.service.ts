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

import { monotonicNow, nowDate } from "../../lib/time";
import { clerk$, type ClerkClient } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  admitMorningBriefCollection,
  freezeMorningBriefSourceSelection,
  narrowMorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
  type MorningBriefSourceAuthorityLedger,
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
  morningBriefInstructionsProvenance,
  morningBriefInstructionsUnchanged,
  readMorningBriefLanguageContext$,
} from "./morning-brief-language-context.service";
import {
  planMorningBriefLanguage,
  type MorningBriefLanguagePlan,
} from "./morning-brief-language-policy";
import { loadMorningBriefMemberLocale } from "./morning-brief-member-locale.service";
import {
  packMorningBriefRequest,
  type MorningBriefOmissionStages,
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
  morningBriefRetainedCheckExpired,
  revalidateMorningBriefRetainedSources,
  startMorningBriefRetainedCheckDeadline,
} from "./morning-brief-source-revalidation.service";
import {
  boundCombinedNormalizedItems,
  dedupeMorningBriefItems,
  morningBriefEvidenceDigest,
  morningBriefSourceOmissions,
  MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES,
  MORNING_BRIEF_NO_OMISSIONS,
  MORNING_BRIEF_NO_PROVENANCE,
  type MorningBriefSourceCollection,
  type MorningBriefSourceItem,
  type MorningBriefSourceKind,
  type MorningBriefSourceOmissions,
  type MorningBriefSourceProvenance,
  type MorningBriefTimeSemantics,
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

/** How many of one source's items made each kind of time claim. */
interface MorningBriefTimeSemanticsCount {
  readonly instant: number;
  readonly overlap: number;
  readonly dateOnly: number;
  readonly outstanding: number;
}

/** How a source finished, including the ways it never ran. */
type MorningBriefCompositionCoverage =
  | MorningBriefSourceCollection["coverage"]
  | "not-started";

/** What one source contributed, with no evidence text in it. */
interface MorningBriefSourceReport {
  readonly source: MorningBriefSourceKind;
  readonly coverage: MorningBriefCompositionCoverage;
  /** Normalized items that survived the combined ceiling. */
  readonly items: number;
  /** Of those, the ones the request could actually carry. */
  readonly includedInRequest: number;
  /** Null when a rejected source could not return collector accounting. */
  readonly requests: number | null;
  readonly timeSemantics: MorningBriefTimeSemanticsCount;
  readonly omitted: MorningBriefSourceOmissions;
  readonly provenance: MorningBriefSourceProvenance;
  /** A fingerprint of exactly the evidence this source put in the request. */
  readonly evidenceDigest: string;
}

function settledCoverage(coverage: MorningBriefCompositionCoverage): boolean {
  return (
    coverage === "unconfigured" ||
    coverage === "empty" ||
    coverage === "complete"
  );
}

/** What one composition attempt produced, with no provider payload in it. */
interface MorningBriefCompositionResult {
  readonly sources: readonly MorningBriefSourceReport[];
  readonly deadline: {
    readonly startedAt: string;
    readonly deadlineAt: string;
    readonly source: MorningBriefCompositionDeadline["source"];
  };
  readonly waves: readonly (readonly MorningBriefSourceKind[])[];
  readonly normalizedBytes: number;
  readonly normalizedMaxBytes: number;
  readonly omittedByNormalizedCap: number;
  readonly request: {
    readonly envelopeBytes: number;
    readonly totalBytes: number;
    readonly maxBytes: number;
    readonly items: number;
    readonly omittedItems: number;
    readonly omittedBytes: number;
    /** A content-free fingerprint of the evidence items in this request. */
    readonly digest: string;
  } | null;
  readonly language: MorningBriefLanguagePlan | null;
  readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
  /** Exact UTF-8 bytes of the serialized descriptor array consumers retain. */
  readonly descriptorBytes: number;
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
  | {
      readonly kind: "incomplete";
      readonly reason:
        | "language-context-unavailable"
        | "retained-authority-unbounded"
        | "no-item-fits"
        | "deadline-exceeded"
        | "all-sources-failed"
        | "incomplete-coverage";
      readonly detail: string;
      /** Empty only when the source plan did not yet exist. */
      readonly sources: readonly MorningBriefSourceReport[];
    }
  | {
      readonly kind: "denied";
      readonly reason: string;
    }
  /** The owner's authority moved while this attempt was reading. */
  | { readonly kind: "authority-changed" };

function sourceDeadlineForComposition(
  deadline: MorningBriefCompositionDeadline,
  ioStartedAt: number,
): MorningBriefSourceDeadline {
  const budgetMs = Math.max(
    0,
    deadline.deadlineAt.getTime() - deadline.startedAt.getTime(),
  );
  return {
    at: deadline.deadlineAt.getTime(),
    ioAt: ioStartedAt + budgetMs,
    signal: AbortSignal.timeout(budgetMs),
  };
}

/**
 * Run one bounded, source-independent composition.
 *
 * One absolute deadline covers admission, collection, language, retained-source
 * revalidation and the final instruction-version fence. A tighter caller budget
 * can only shorten that deadline.
 */
export const composeMorningBrief$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly anchor: Date;
      readonly deadlineAt?: Date | null;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefCompositionOutcome> => {
    const db: Db = set(writeDb$);
    const clerk = get(clerk$);
    const phaseIoStartedAt = monotonicNow();
    const deadline = morningBriefCompositionDeadline(
      nowDate(),
      args.deadlineAt ?? null,
    );
    const phaseStartedAt = deadline.startedAt;
    const phaseDeadlineAt = deadline.deadlineAt;
    // Keep both shared-authorizer clocks on the one resolved duration. The
    // monotonic start was sampled before the application deadline resolution.
    const phaseDeadline = sourceDeadlineForComposition(
      deadline,
      phaseIoStartedAt,
    );
    const expired = (
      step: string,
      sources: readonly MorningBriefSourceReport[] = [],
    ): MorningBriefDeadlineExceeded | null => {
      return morningBriefExpired(phaseDeadlineAt, step, sources);
    };

    const admitted = await admitMorningBriefAttempt(
      { db, clerk, args, phaseDeadlineAt, phaseDeadline },
      signal,
    );
    if (admitted.kind !== "admitted") {
      return admitted;
    }
    const { scope } = admitted;

    const installation = await get(
      slackUserInstallation({ orgId: scope.orgId, userId: scope.userId }),
    );
    signal.throwIfAborted();
    const afterBinding = expired("Slack binding discovery");
    if (afterBinding) {
      return afterBinding;
    }
    const { configured, slackBinding } = configuredSources(installation);
    const selections = await freezeMorningBriefSelections(db, scope);
    signal.throwIfAborted();
    const afterSelections = expired("source selection");
    if (afterSelections) {
      return afterSelections;
    }
    const readChat: ChatReader = async (chatSignal) => {
      const collected = await set(
        collectMorningBriefChat$,
        { owner: scope, scheduledFor: scope.anchor },
        chatSignal,
      );
      return collected.kind === "collected" ? collected.collection : null;
    };
    const waves = morningBriefSourceWaves(configured);

    const { collections, descriptors, notStarted, unknownRequests } =
      await collectMorningBriefWaves(
        {
          waves,
          db,
          clerk,
          scope,
          slack: slackBinding,
          selections,
          phaseStartedAt,
          phaseDeadlineAt,
          phaseDeadline,
          readChat,
        },
        signal,
      );
    // Promise.allSettled has joined every started source before cancellation is
    // allowed to escape from this public command.
    signal.throwIfAborted();
    const reduced = reduceMorningBriefCollections({
      waves,
      collections,
      notStarted,
      unknownRequests,
    });
    const afterSources = expired("source collection", reduced.reports);
    if (afterSources) {
      return afterSources;
    }
    const base: MorningBriefCompositionBase = {
      deadline: {
        startedAt: phaseStartedAt.toISOString(),
        deadlineAt: phaseDeadlineAt.toISOString(),
        source: deadline.source,
      },
      waves,
      normalizedBytes: reduced.bounded.bytes,
      normalizedMaxBytes: MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES,
      omittedByNormalizedCap: reduced.bounded.omitted,
    };

    const empty = finishEmptyComposition(reduced, descriptors, base);
    if (empty !== null) {
      return empty;
    }

    const planned = await set(
      planMorningBriefRequest$,
      {
        scope,
        collections: reduced.bounded.collections,
        omittedByNormalizedCap: reduced.bounded.omittedBySource,
        descriptors,
        slack: slackBinding,
        phaseDeadlineAt,
        phaseDeadline,
      },
      signal,
    );
    signal.throwIfAborted();
    if (planned.kind === "incomplete") {
      return { ...planned, sources: reduced.reports };
    }
    if (planned.kind !== "planned") {
      return planned;
    }
    return finishPlannedComposition(planned, descriptors, reduced, base);
  },
);

type MorningBriefCompositionBase = Omit<
  MorningBriefCompositionResult,
  "descriptorBytes" | "descriptors" | "language" | "request" | "sources"
>;

type ReducedMorningBriefCollections = ReturnType<
  typeof reduceMorningBriefCollections
>;

interface PlannedMorningBriefRequest {
  readonly language: MorningBriefLanguagePlan;
  readonly envelopeBytes: number;
  readonly totalBytes: number;
  readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
  readonly collections: readonly MorningBriefSourceCollection[];
  readonly revoked: ReadonlySet<MorningBriefSourceKind>;
}

/** Settle the no-candidate branch without hiding partial source work. */
function finishEmptyComposition(
  reduced: ReducedMorningBriefCollections,
  descriptors: readonly MorningBriefRetainedSourceDescriptor[],
  base: MorningBriefCompositionBase,
): MorningBriefCompositionOutcome | null {
  if (reduced.contributed.size > 0) {
    return null;
  }
  const unsettled = unsettledSources(reduced.reports);
  if (unsettled !== null) {
    return unsettled;
  }
  const retained = boundMorningBriefDescriptors(descriptors);
  if (retained.kind === "rejected") {
    return incomplete(
      "retained-authority-unbounded",
      retained.reason,
      reduced.reports,
    );
  }
  return {
    kind: "empty",
    result: {
      ...base,
      sources: reduced.reports,
      descriptors: retained.descriptors,
      descriptorBytes: retained.bytes,
      request: null,
      language: null,
    },
  };
}

/** Preserve the final source facts while converting a proved plan to output. */
function finishPlannedComposition(
  planned: PlannedMorningBriefRequest,
  descriptors: readonly MorningBriefRetainedSourceDescriptor[],
  reduced: ReducedMorningBriefCollections,
  base: MorningBriefCompositionBase,
): MorningBriefCompositionOutcome {
  const sources = sourceReports(reduced.waves, planned.collections, {
    stages: {
      byNormalizedCap: reduced.bounded.omittedBySource,
      byRequest: planned.allocation.omittedBySource,
    },
    accepted: planned.allocation.items,
    notStarted: reduced.notStarted,
    unknownRequests: reduced.unknownRequests,
  });
  const retained = retainSuppliedAuthority(descriptors, planned);
  if (retained.kind === "rejected") {
    return incomplete("retained-authority-unbounded", retained.reason, sources);
  }
  return {
    kind: "composed",
    result: {
      ...base,
      sources,
      descriptors: retained.descriptors,
      descriptorBytes: retained.bytes,
      language: planned.language,
      request: requestReport(planned),
    },
  };
}

interface MorningBriefDeadlineExceeded {
  readonly kind: "incomplete";
  readonly reason: "deadline-exceeded";
  readonly detail: string;
  readonly sources: readonly MorningBriefSourceReport[];
}

function incomplete(
  reason: Extract<
    MorningBriefCompositionOutcome,
    { kind: "incomplete" }
  >["reason"],
  detail: string,
  sources: readonly MorningBriefSourceReport[],
): Extract<MorningBriefCompositionOutcome, { kind: "incomplete" }> {
  return { kind: "incomplete", reason, detail, sources };
}

function morningBriefExpired(
  deadlineAt: Date,
  step: string,
  sources: readonly MorningBriefSourceReport[] = [],
): MorningBriefDeadlineExceeded | null {
  if (nowDate().getTime() < deadlineAt.getTime()) {
    return null;
  }
  return incomplete(
    "deadline-exceeded",
    `${step} reached ${deadlineAt.toISOString()}`,
    sources,
  ) as MorningBriefDeadlineExceeded;
}

function morningBriefPhaseSignal(
  signal: AbortSignal,
  deadlineAt: Date,
): AbortSignal {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(
      Math.max(0, deadlineAt.getTime() - nowDate().getTime()),
    ),
  ]);
}

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
  const before = morningBriefExpired(input.phaseDeadlineAt, "before admission");
  if (before) {
    return before;
  }
  const admitted = await admitMorningBriefCollection(
    {
      db: input.db,
      clerk: input.clerk,
      orgId: input.args.orgId,
      userId: input.args.userId,
      anchor: input.args.anchor,
      deadline: input.phaseDeadline,
    },
    morningBriefPhaseSignal(signal, input.phaseDeadlineAt),
  );
  signal.throwIfAborted();
  const after = morningBriefExpired(input.phaseDeadlineAt, "admission");
  if (after) {
    return after;
  }
  if (admitted.kind !== "ok") {
    return { kind: "denied", reason: admitted.reason };
  }
  return { kind: "admitted", scope: admitted.scope };
}

function reduceMorningBriefCollections(input: {
  readonly waves: readonly (readonly MorningBriefSourceKind[])[];
  readonly collections: readonly MorningBriefSourceCollection[];
  readonly notStarted: ReadonlySet<MorningBriefSourceKind>;
  readonly unknownRequests: ReadonlySet<MorningBriefSourceKind>;
}) {
  const deduped = input.collections.map((collection) => {
    return { ...collection, items: dedupeMorningBriefItems(collection.items) };
  });
  const bounded = boundCombinedNormalizedItems(deduped);
  const reports = sourceReports(input.waves, bounded.collections, {
    stages: { byNormalizedCap: bounded.omittedBySource, byRequest: {} },
    accepted: [],
    notStarted: input.notStarted,
    unknownRequests: input.unknownRequests,
  });
  return {
    bounded,
    reports,
    waves: input.waves,
    notStarted: input.notStarted,
    unknownRequests: input.unknownRequests,
    contributed: new Set(
      bounded.collections
        .filter((collection) => {
          return collection.items.length > 0;
        })
        .map((collection) => {
          return collection.source;
        }),
    ),
  };
}

function unsettledSources(
  sources: readonly MorningBriefSourceReport[],
): Extract<MorningBriefCompositionOutcome, { kind: "incomplete" }> | null {
  const answerable = sources.filter((entry) => {
    return entry.coverage !== "unconfigured";
  });
  const unsettled = answerable.filter((entry) => {
    return !settledCoverage(entry.coverage);
  });
  if (unsettled.length === 0) {
    return null;
  }
  const detail = unsettled
    .map((entry) => {
      return `${entry.source}=${entry.coverage}`;
    })
    .join(", ");
  return incomplete(
    unsettled.every((entry) => {
      return entry.coverage === "failed";
    }) && unsettled.length === answerable.length
      ? "all-sources-failed"
      : "incomplete-coverage",
    detail,
    sources,
  );
}

/** The measured request one model call would receive, with no evidence in it. */
function requestReport(planned: {
  readonly envelopeBytes: number;
  readonly totalBytes: number;
  readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
}): NonNullable<MorningBriefCompositionResult["request"]> {
  return {
    envelopeBytes: planned.envelopeBytes,
    totalBytes: planned.totalBytes,
    maxBytes: MORNING_BRIEF_REQUEST_MAX_BYTES,
    items: planned.allocation.items.length,
    omittedItems: planned.allocation.omittedItems,
    omittedBytes: planned.allocation.omittedBytes,
    digest: morningBriefEvidenceDigest(planned.allocation.items),
  };
}

/**
 * Keep exactly the proofs the final request needs, and no others.
 *
 * Contribution is decided by the material the request actually carries, not by
 * what survived collection: an item dropped by allocation supplied nothing, and
 * claiming it did would make a later check defend evidence the model never
 * received. A source whose authority was withdrawn keeps no descriptor at all,
 * because its material was removed from the request.
 */
function retainSuppliedAuthority(
  descriptors: readonly MorningBriefRetainedSourceDescriptor[],
  planned: {
    readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
    readonly revoked: ReadonlySet<MorningBriefSourceKind>;
  },
): ReturnType<typeof boundMorningBriefDescriptors> {
  const supplied = new Set(
    planned.allocation.items.map((item) => {
      return item.identity.source;
    }),
  );
  return boundMorningBriefDescriptors(
    descriptors
      .filter((descriptor) => {
        return !planned.revoked.has(descriptor.source);
      })
      .map((descriptor) => {
        return {
          ...descriptor,
          contributed: supplied.has(descriptor.source),
        };
      }),
  );
}

/**
 * Failing closed is the whole point of the bound.
 *
 * A descriptor set that quietly lost a source would let every later permission
 * check pass by having nothing to check, while the evidence it was meant to
 * cover went out anyway.
 */
/** The OAuth-backed sources whose account choice is frozen for the attempt. */
const MORNING_BRIEF_SELECTED_SOURCES = [
  { source: "calendar", connectorSlug: "google-calendar" },
  { source: "gmail", connectorSlug: "gmail" },
  { source: "github", connectorSlug: "github" },
] as const;

type MorningBriefSelections = ReadonlyMap<
  MorningBriefSourceKind,
  MorningBriefSourceAuthorityLedger
>;

/**
 * Freeze every OAuth source's account choice before any of them reads.
 *
 * Explicit absence is frozen too: a source the owner had not connected when the
 * attempt was admitted does not acquire an account mid-attempt, so connecting
 * one while an earlier source is held cannot add it to this brief.
 */
async function freezeMorningBriefSelections(
  db: Db,
  scope: MorningBriefCollectionScope,
): Promise<MorningBriefSelections> {
  const frozen = new Map<
    MorningBriefSourceKind,
    MorningBriefSourceAuthorityLedger
  >();
  for (const { source, connectorSlug } of MORNING_BRIEF_SELECTED_SOURCES) {
    frozen.set(
      source,
      await freezeMorningBriefSourceSelection(db, scope, connectorSlug),
    );
  }
  return frozen;
}

/** The frozen ledger for one source; readers never resolve their own. */
function ledgerFor(
  selections: MorningBriefSelections,
  source: MorningBriefSourceKind,
): MorningBriefSourceAuthorityLedger {
  const ledger = selections.get(source);
  if (ledger === undefined) {
    throw new Error(`Morning Brief source ${source} has no frozen selection`);
  }
  return ledger;
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

type MorningBriefSourceAttempt =
  | { readonly kind: "read"; readonly collected: CollectedSource }
  | { readonly kind: "not-started" };

function withConfiguredCoverage(
  normalized: MorningBriefSourceCollection,
  failure: MorningBriefSourceFailure | null,
): MorningBriefSourceCollection {
  if (normalized.coverage !== "failed" || failure !== "not-connected") {
    return normalized;
  }
  return { ...normalized, coverage: "unconfigured" };
}

function failedCollection(
  source: MorningBriefSourceKind,
): MorningBriefSourceCollection {
  return {
    source,
    coverage: "failed",
    items: [],
    // Internal request assembly does not serialize this count. Public source
    // outcomes override it with null when a rejection made spend unknowable.
    requests: 0,
    provenance: MORNING_BRIEF_NO_PROVENANCE,
    omittedBySource: MORNING_BRIEF_NO_OMISSIONS,
  };
}

/**
 * Read one source inside the budget the plan allows it.
 *
 * A source whose budget has already run out is explicitly not started, which is
 * a different fact from a read that failed.
 */
async function readMorningBriefSource(
  args: {
    readonly source: MorningBriefSourceKind;
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: SlackBinding | null;
    readonly selections: MorningBriefSelections;
    readonly phaseStartedAt: Date;
    readonly phaseDeadlineAt: Date;
    readonly phaseDeadline: MorningBriefSourceDeadline;
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
  // reader receives a narrowed view of the phase deadline rather than starting
  // a second budget of its own.
  const sourceDeadline = narrowMorningBriefSourceDeadline(
    { at: args.phaseDeadline.at, ioAt: args.phaseDeadline.ioAt },
    budget.deadlineAt.getTime(),
    args.phaseDeadline.signal,
  );
  const sourceSignal = AbortSignal.any([signal, sourceDeadline.signal]);
  const read = async (): Promise<CollectedSource> => {
    if (source === "calendar") {
      return await readCalendarSource(
        {
          db,
          clerk,
          scope,
          capturedAt,
          authority: ledgerFor(args.selections, "calendar"),
          deadline: sourceDeadline,
        },
        sourceSignal,
      );
    }
    if (source === "github") {
      return await readGithubSource(
        {
          db,
          clerk,
          scope,
          capturedAt,
          authority: ledgerFor(args.selections, "github"),
          deadline: sourceDeadline,
        },
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
        {
          db,
          clerk,
          scope,
          capturedAt,
          authority: ledgerFor(args.selections, "gmail"),
          deadline: sourceDeadline,
        },
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
      readonly omittedByNormalizedCap: MorningBriefOmissionStages["byNormalizedCap"];
      readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
      readonly slack: SlackBinding | null;
      readonly phaseDeadlineAt: Date;
      readonly phaseDeadline: MorningBriefSourceDeadline;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "planned";
        readonly language: MorningBriefLanguagePlan;
        readonly envelopeBytes: number;
        readonly totalBytes: number;
        readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
        /** The final collections, with any withdrawn source's day removed. */
        readonly collections: readonly MorningBriefSourceCollection[];
        readonly revoked: ReadonlySet<MorningBriefSourceKind>;
      }
    | Extract<MorningBriefCompositionOutcome, { kind: "incomplete" }>
    | { readonly kind: "authority-changed" }
  > => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const { scope, phaseDeadline, phaseDeadlineAt } = input;
    const bounded = { collections: input.collections };
    const expired = (step: string): MorningBriefDeadlineExceeded | null => {
      return morningBriefExpired(phaseDeadlineAt, step);
    };
    const context = await set(
      readMorningBriefLanguageContext$,
      { owner: scope, agentId: scope.agentId, deadlineAt: phaseDeadlineAt },
      signal,
    );
    signal.throwIfAborted();
    const afterContext = expired("language context");
    if (afterContext) {
      return afterContext;
    }
    if (context.kind === "unavailable") {
      // An owner whose instructions cannot be read has not asked for English.
      return incomplete("language-context-unavailable", context.reason, []);
    }
    const memberLocale = await loadMorningBriefMemberLocale(db, scope);
    signal.throwIfAborted();
    const afterLocale = expired("member locale");
    if (afterLocale) {
      return afterLocale;
    }
    const language = planMorningBriefLanguage({
      instructions: morningBriefInstructionsProvenance(context),
      memberLocale,
    });
    // The complete text stays in memory and goes straight into the request.
    // Only the version and digest are provenance worth freezing.
    const instructions = context.kind === "available" ? context.text : null;

    const first = allocateForCollections(bounded.collections, {
      language,
      instructions,
      omittedByNormalizedCap: input.omittedByNormalizedCap,
    });
    if (first.allocation.items.length === 0) {
      // Evidence existed and none of it fits beside the fixed context. That is
      // an explicit incomplete outcome with zero model calls, never a brief
      // claiming the owner had a quiet morning.
      return incomplete(
        "no-item-fits",
        `envelope ${first.envelopeBytes.toString()} of ${MORNING_BRIEF_REQUEST_MAX_BYTES.toString()} bytes`,
        [],
      );
    }

    const proved = await proveRetainedAuthority(
      {
        db,
        clerk,
        scope,
        slack: input.slack,
        descriptors: input.descriptors,
        collections: bounded.collections,
        planned: first,
        language,
        instructions,
        omittedByNormalizedCap: input.omittedByNormalizedCap,
        deadline: phaseDeadline,
      },
      signal,
    );
    signal.throwIfAborted();
    if (proved.kind === "incomplete") {
      return proved;
    }
    if (proved.kind !== "proved") {
      return { kind: "authority-changed" };
    }
    const { collections, revoked, replanned } = proved;

    // The Agent's instruction context is part of the request, so a change to it
    // between the read and the reservation is a changed request, not a detail —
    // and that is as true of a proven absence as of a version that was read.
    // An owner who publishes their first instructions, or replaces an empty
    // file, while this attempt holds its authority has changed what the brief
    // would be written from.
    const unchanged = await morningBriefInstructionsUnchanged(
      db,
      scope,
      scope.agentId,
      context,
    );
    signal.throwIfAborted();
    const afterInstructions = expired("instruction version check");
    if (afterInstructions) {
      return afterInstructions;
    }
    if (!unchanged) {
      return { kind: "authority-changed" };
    }
    const beforeCommit = expired("request admission");
    if (beforeCommit) {
      return beforeCommit;
    }
    return {
      kind: "planned",
      language,
      envelopeBytes: replanned.envelopeBytes,
      totalBytes: replanned.totalBytes,
      allocation: replanned.allocation,
      collections,
      revoked,
    };
  },
);

type RetainedAuthorityOutcome =
  | { readonly kind: "withdrawn" }
  | MorningBriefDeadlineExceeded
  | {
      readonly kind: "proved";
      readonly collections: readonly MorningBriefSourceCollection[];
      readonly revoked: ReadonlySet<MorningBriefSourceKind>;
      readonly replanned: MorningBriefAllocated;
    };

/** Outer expiry owns the public result when both retained clocks meet. */
function retainedAuthorityExpired(
  outerDeadlineAt: Date,
  retainedDeadlineAt: number,
  retainedSignal: AbortSignal,
): MorningBriefDeadlineExceeded | { readonly kind: "withdrawn" } | null {
  const outer = morningBriefExpired(outerDeadlineAt, "final authority check");
  if (outer) {
    return outer;
  }
  return morningBriefRetainedCheckExpired(retainedDeadlineAt, retainedSignal)
    ? { kind: "withdrawn" }
    : null;
}

/**
 * Re-ask the authorizers about every supplied source, then plan what survives.
 *
 * Everything before this awaited the network, so it runs after the last await
 * rather than before the first: the point of the check is that nothing observed
 * during those awaits has already been released. Only the sources whose
 * material the request would actually carry are re-checked, because a source
 * that supplied nothing is not a reason to withhold the owner's other
 * authorized work.
 */
async function proveRetainedAuthority(
  input: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: SlackBinding | null;
    readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
    readonly collections: readonly MorningBriefSourceCollection[];
    readonly planned: MorningBriefAllocated;
    readonly language: MorningBriefLanguagePlan;
    readonly instructions: string | null;
    readonly omittedByNormalizedCap: MorningBriefOmissionStages["byNormalizedCap"];
    /** The attempt's own reservation; the check never outlives it. */
    readonly deadline: MorningBriefSourceDeadline;
  },
  signal: AbortSignal,
): Promise<RetainedAuthorityOutcome> {
  const outerDeadlineAt = new Date(input.deadline.at);
  const before = morningBriefExpired(outerDeadlineAt, "final authority check");
  if (before) {
    return before;
  }
  const reservation = input.deadline;
  const deadline = startMorningBriefRetainedCheckDeadline(
    { at: reservation.at, ioAt: reservation.ioAt },
    reservation.signal,
  );
  const initialExpiry = retainedAuthorityExpired(
    outerDeadlineAt,
    deadline.at,
    deadline.signal,
  );
  if (initialExpiry) {
    return initialExpiry;
  }
  const descriptors = new Map(
    input.descriptors.map((descriptor) => {
      return [descriptor.source, descriptor] as const;
    }),
  );
  const revoked = new Set<MorningBriefSourceKind>();
  let collections = input.collections;
  let replanned = input.planned;

  // Every pass proves the complete supplied set. If a refusal changes
  // allocation, the next pass re-proves every input in the new final request,
  // not only the source that entered during reallocation. Each changed pass
  // removes at least one source, so at most five sources make this finite; all
  // passes spend the one retained deadline and the outer composition deadline.
  for (let pass = 0; pass <= input.descriptors.length; pass += 1) {
    const beforePass = retainedAuthorityExpired(
      outerDeadlineAt,
      deadline.at,
      deadline.signal,
    );
    if (beforePass) {
      return beforePass;
    }
    const supplied = allocatedSourceKinds(replanned);
    let removed = false;
    for (const source of supplied) {
      if (!descriptors.has(source)) {
        revoked.add(source);
        removed = true;
      }
    }
    if (!removed) {
      const retained = input.descriptors.filter((descriptor) => {
        return supplied.has(descriptor.source);
      });
      const revalidation = await revalidateMorningBriefRetainedSources(
        {
          db: input.db,
          clerk: input.clerk,
          scope: input.scope,
          descriptors: retained,
          slack:
            input.slack === null
              ? null
              : {
                  botToken: input.slack.botToken,
                  workspaceId: input.slack.workspaceId,
                  slackUserId: input.slack.slackUserId,
                },
          deadline,
        },
        signal,
      );
      signal.throwIfAborted();
      const afterRevalidation = retainedAuthorityExpired(
        outerDeadlineAt,
        deadline.at,
        deadline.signal,
      );
      if (afterRevalidation) {
        return afterRevalidation;
      }
      if (revalidation.kind === "owner-lost") {
        return { kind: "withdrawn" };
      }
      for (const refused of revalidation.revoked) {
        revoked.add(refused.source);
        removed = true;
      }
    }
    if (!removed) {
      const beforeRelease = retainedAuthorityExpired(
        outerDeadlineAt,
        deadline.at,
        deadline.signal,
      );
      return (
        beforeRelease ?? { kind: "proved", collections, revoked, replanned }
      );
    }
    collections = withdrawRevokedSources(input.collections, revoked);
    replanned = allocateForCollections(collections, {
      language: input.language,
      instructions: input.instructions,
      omittedByNormalizedCap: input.omittedByNormalizedCap,
    });
    if (replanned.allocation.items.length === 0) {
      return { kind: "withdrawn" };
    }
  }
  return { kind: "withdrawn" };
}

/** One sized request: the fixed envelope, the evidence that fits, the total. */
interface MorningBriefAllocated {
  readonly envelopeBytes: number;
  readonly totalBytes: number;
  readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
}

/** The sources whose material the current request would actually release. */
function allocatedSourceKinds(
  planned: MorningBriefAllocated,
): ReadonlySet<MorningBriefSourceKind> {
  return new Set(
    planned.allocation.items.map((item) => {
      return item.identity.source;
    }),
  );
}

/** Allocate with the shared consumed serializer/packing contract. */
function allocateForCollections(
  collections: readonly MorningBriefSourceCollection[],
  context: {
    readonly language: MorningBriefLanguagePlan;
    readonly instructions: string | null;
    readonly omittedByNormalizedCap: MorningBriefOmissionStages["byNormalizedCap"];
  },
): MorningBriefAllocated {
  const packed = packMorningBriefRequest({ collections, ...context });
  return {
    envelopeBytes: packed.envelopeBytes,
    totalBytes: packed.totalBytes,
    allocation: packed.allocation,
  };
}

/**
 * Remove a withdrawn source's material while keeping its day accounted for.
 *
 * The collection stays, with no items and a failed coverage: a source whose
 * authority was withdrawn mid-attempt did not have a quiet morning, and
 * dropping the row entirely would let the coverage report imply it did.
 */
function withdrawRevokedSources(
  collections: readonly MorningBriefSourceCollection[],
  revoked: ReadonlySet<MorningBriefSourceKind>,
): readonly MorningBriefSourceCollection[] {
  return collections.map((collection) => {
    if (!revoked.has(collection.source)) {
      return collection;
    }
    return {
      ...collection,
      coverage: "failed",
      items: [],
      omittedBySource: MORNING_BRIEF_NO_OMISSIONS,
    };
  });
}

/** How many of one source's items made each kind of time claim. */
function timeSemanticsCount(
  items: readonly MorningBriefSourceItem[],
): MorningBriefTimeSemanticsCount {
  const counted: Record<MorningBriefTimeSemantics, number> = {
    instant: 0,
    overlap: 0,
    "date-only": 0,
    outstanding: 0,
  };
  for (const item of items) {
    counted[item.timeSemantics] += 1;
  }
  return {
    instant: counted.instant,
    overlap: counted.overlap,
    dateOnly: counted["date-only"],
    outstanding: counted.outstanding,
  };
}

/** What each applicable source contributed, with no evidence in it. */
function sourceReports(
  waves: readonly (readonly MorningBriefSourceKind[])[],
  collections: readonly MorningBriefSourceCollection[],
  input: {
    readonly stages: MorningBriefOmissionStages;
    readonly accepted: readonly MorningBriefSourceItem[];
    readonly notStarted: ReadonlySet<MorningBriefSourceKind>;
    readonly unknownRequests: ReadonlySet<MorningBriefSourceKind>;
  },
): readonly MorningBriefSourceReport[] {
  return waves.flat().map((source) => {
    const collection = collections.find((candidate) => {
      return candidate.source === source;
    });
    if (collection === undefined) {
      return {
        source,
        coverage: input.notStarted.has(source)
          ? ("not-started" as const)
          : ("unconfigured" as const),
        items: 0,
        includedInRequest: 0,
        requests: 0,
        timeSemantics: timeSemanticsCount([]),
        omitted: morningBriefSourceOmissions({
          bySource: MORNING_BRIEF_NO_OMISSIONS,
          byNormalizedCap: 0,
          byRequest: 0,
        }),
        provenance: MORNING_BRIEF_NO_PROVENANCE,
        evidenceDigest: morningBriefEvidenceDigest([]),
      };
    }
    const accepted = input.accepted.filter((item) => {
      return item.identity.source === collection.source;
    });
    const byRequest = input.stages.byRequest[collection.source] ?? 0;
    return {
      source,
      coverage: collection.coverage,
      items: collection.items.length,
      includedInRequest: accepted.length,
      requests: input.unknownRequests.has(source) ? null : collection.requests,
      timeSemantics: timeSemanticsCount(collection.items),
      omitted: morningBriefSourceOmissions({
        bySource: collection.omittedBySource,
        byNormalizedCap: input.stages.byNormalizedCap[collection.source] ?? 0,
        byRequest,
      }),
      provenance: collection.provenance,
      evidenceDigest: morningBriefEvidenceDigest(accepted),
    };
  });
}
/**
 * Run the waves in order, joining each before the next one starts.
 *
 * Joining is what bounds concurrency to the wave size: nothing is detached, and
 * a cancelled attempt cannot leave a reader running past it.
 */
async function collectMorningBriefWaves(
  input: {
    readonly waves: readonly (readonly MorningBriefSourceKind[])[];
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly scope: MorningBriefCollectionScope;
    readonly slack: SlackBinding | null;
    readonly selections: MorningBriefSelections;
    readonly phaseStartedAt: Date;
    readonly phaseDeadlineAt: Date;
    readonly phaseDeadline: MorningBriefSourceDeadline;
    readonly readChat: ChatReader;
  },
  signal: AbortSignal,
): Promise<{
  readonly collections: readonly MorningBriefSourceCollection[];
  readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
  readonly notStarted: ReadonlySet<MorningBriefSourceKind>;
  readonly unknownRequests: ReadonlySet<MorningBriefSourceKind>;
}> {
  const { waves, db, clerk, scope, phaseStartedAt, phaseDeadlineAt } = input;
  const slackBinding = input.slack;
  const capturedAt = nowDate();
  const collections: MorningBriefSourceCollection[] = [];
  const descriptors: MorningBriefRetainedSourceDescriptor[] = [];
  const notStarted = new Set<MorningBriefSourceKind>();
  const unknownRequests = new Set<MorningBriefSourceKind>();
  const phaseSignal = morningBriefPhaseSignal(signal, phaseDeadlineAt);

  for (const [waveIndex, wave] of waves.entries()) {
    if (signal.aborted || nowDate().getTime() >= phaseDeadlineAt.getTime()) {
      for (const laterWave of waves.slice(waveIndex)) {
        for (const source of laterWave) {
          notStarted.add(source);
        }
      }
      break;
    }
    // allSettled is the lifecycle fence. Promise.all would return on the first
    // rejection and abandon still-running siblings even though the wave shape
    // continued to look bounded in a unit assertion.
    const finished = await Promise.allSettled(
      wave.map(async (source) => {
        return await readMorningBriefSource(
          {
            source,
            db,
            clerk,
            scope,
            slack: slackBinding,
            selections: input.selections,
            phaseStartedAt,
            phaseDeadlineAt,
            phaseDeadline: input.phaseDeadline,
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
        unknownRequests.add(source);
        continue;
      }
      if (settled.value.kind === "not-started") {
        notStarted.add(source);
        continue;
      }
      const entry = settled.value.collected;
      if (entry === null) {
        collections.push(failedCollection(source));
        continue;
      }
      collections.push(entry.normalized);
      if (entry.descriptor !== null) {
        descriptors.push(entry.descriptor);
      }
    }
  }
  return { collections, descriptors, notStarted, unknownRequests };
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
  /** The account choice frozen for this attempt, and this read's proof. */
  readonly authority: MorningBriefSourceAuthorityLedger;
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
      authority: args.authority,
      deadline: args.deadline,
    },
    signal,
  );
  // The shared reader resolved and proved the exact Google account this read
  // was pinned to, so the normalized identity is that account rather than the
  // member's own user id.
  const normalized = withConfiguredCoverage(
    normalizeMorningBriefCalendar(
      collection,
      args.authority.proof?.accountRef ?? args.scope.userId,
    ),
    collection.failure,
  );
  return {
    normalized,
    descriptor: morningBriefCalendarDescriptor({
      proof: args.authority.proof,
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
      authority: args.authority,
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
        provenance: MORNING_BRIEF_NO_PROVENANCE,
        omittedBySource: MORNING_BRIEF_NO_OMISSIONS,
      },
      descriptor: null,
    };
  }
  const normalized = normalizeMorningBriefGithub(execution.bundle);
  return {
    normalized,
    descriptor: morningBriefGithubDescriptor({
      proof: args.authority.proof,
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
    // Not installed or owner unavailable: no authorized read happened.
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
      authority: args.authority,
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
      proof: args.authority.proof,
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
        provenance: MORNING_BRIEF_NO_PROVENANCE,
        omittedBySource: MORNING_BRIEF_NO_OMISSIONS,
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
