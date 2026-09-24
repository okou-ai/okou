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
  admitMorningBriefNativeCollection,
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
  morningBriefSourceReadCutoff,
  morningBriefSourceWaves,
  MORNING_BRIEF_REQUEST_MAX_BYTES,
  type MorningBriefCompositionDeadline,
} from "./morning-brief-collection-plan";
import { collectMorningBriefCalendar } from "./morning-brief-calendar-collection.service";
import { normalizeMorningBriefCalendar } from "./morning-brief-calendar-source";
import { collectMorningBriefChat$ } from "./morning-brief-chat-collection.service";
import { normalizeMorningBriefChat } from "./morning-brief-chat-source";
import { executeMorningBriefGithubCollection } from "./morning-brief-github-collection.service";
import { normalizeMorningBriefGithub } from "./morning-brief-github-source";
import { collectMorningBriefGmail } from "./morning-brief-gmail-collection.service";
import { normalizeMorningBriefGmail } from "./morning-brief-gmail-source";
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
import type { MorningBriefNativeActiveAuthority } from "./morning-brief-native-generation-admission.service";
import {
  morningBriefCitationLinks,
  packMorningBriefRequest,
  type MorningBriefOmissionStages,
  type MorningBriefProviderRequest,
} from "./morning-brief-request-envelope";
import { collectMorningBriefSlackBundle } from "./morning-brief-slack-collection.service";
import { normalizeMorningBriefSlack } from "./morning-brief-slack-source";
import {
  boundCombinedNormalizedItems,
  dedupeMorningBriefItems,
  morningBriefEvidenceDigest,
  morningBriefSourceOmissions,
  MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES,
  MORNING_BRIEF_NO_OMISSIONS,
  MORNING_BRIEF_NO_PROVENANCE,
  type MorningBriefDisplayLink,
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
  /**
   * Exact provider reads issued, or null only when the source job rejected
   * before returning its collector accounting.
   */
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

/**
 * The exact ephemeral request one composition produced.
 *
 * The body is the byte-counted transport sent by S5. Citation links are
 * program-owned and never accepted from provider output.
 */
export interface MorningBriefCompositionTransport {
  readonly body: string;
  readonly bodyBytes: number;
  readonly inputDigest: string;
  readonly citations: ReadonlyMap<string, MorningBriefDisplayLink | null>;
  readonly inputItems: number;
  readonly includedItems: number;
  readonly sourceCoverage: "complete" | "partial" | "empty";
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
}

/** Why a composition produced no model request. */
export type MorningBriefCompositionOutcome =
  | {
      readonly kind: "composed";
      readonly result: MorningBriefCompositionResult;
      /** Never serialized by a route; consumed only by the generation engine. */
      readonly transport: MorningBriefCompositionTransport;
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
  /**
   * The request's own instruction context moved while this attempt was reading.
   *
   * The fence that refused names itself, so a settled occurrence records the
   * reason and a future incident does not need a trace archaeology session.
   */
  | {
      readonly kind: "authority-changed";
      readonly reason: MorningBriefAuthorityChange;
      readonly sources: readonly MorningBriefSourceReport[];
    };

/** Which fence withdrew a composed attempt's authority. */
export type MorningBriefAuthorityChange =
  /** The Agent's instruction context moved between the read and the plan. */
  "instructions-changed";

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
 * One absolute deadline covers admission, collection, language and the final
 * instruction-version fence. A tighter caller budget can only shorten it.
 */
export const composeMorningBrief$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly anchor: Date;
      readonly deadlineAt?: Date | null;
      readonly nativeAuthority?: MorningBriefNativeActiveAuthority;
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

    const { collections, notStarted, unknownRequests } =
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

    const empty = finishEmptyComposition(reduced, base);
    if (empty !== null) {
      return empty;
    }

    const planned = await set(
      planMorningBriefRequest$,
      {
        scope,
        collections: reduced.bounded.collections,
        omittedByNormalizedCap: reduced.bounded.omittedBySource,
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
      // The source facts survive the refusal: a settled occurrence has to be
      // able to show that five sources answered and still delivered nothing.
      return { ...planned, sources: reduced.reports };
    }
    return finishPlannedComposition(planned, reduced, base);
  },
);

type MorningBriefCompositionBase = Omit<
  MorningBriefCompositionResult,
  "language" | "request" | "sources"
>;

type ReducedMorningBriefCollections = ReturnType<
  typeof reduceMorningBriefCollections
>;

interface PlannedMorningBriefRequest {
  readonly language: MorningBriefLanguagePlan;
  readonly envelopeBytes: number;
  readonly totalBytes: number;
  readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
  readonly request: MorningBriefProviderRequest;
  readonly collections: readonly MorningBriefSourceCollection[];
}

/** Settle the no-candidate branch without hiding partial source work. */
function finishEmptyComposition(
  reduced: ReducedMorningBriefCollections,
  base: MorningBriefCompositionBase,
): MorningBriefCompositionOutcome | null {
  if (reduced.contributed.size > 0) {
    return null;
  }
  const unsettled = unsettledSources(reduced.reports);
  if (unsettled !== null) {
    return unsettled;
  }
  return {
    kind: "empty",
    result: {
      ...base,
      sources: reduced.reports,
      request: null,
      language: null,
    },
  };
}

/** Preserve the final source facts while converting a proved plan to output. */
function finishPlannedComposition(
  planned: PlannedMorningBriefRequest,
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
  return {
    kind: "composed",
    result: {
      ...base,
      sources,
      language: planned.language,
      request: requestReport(planned),
    },
    transport: {
      body: planned.request.body,
      bodyBytes: planned.request.bodyBytes,
      inputDigest: planned.request.inputDigest,
      citations: morningBriefCitationLinks(planned.allocation.items),
      inputItems: planned.collections.reduce((total, collection) => {
        return total + collection.items.length;
      }, 0),
      includedItems: planned.allocation.items.length,
      sourceCoverage: aggregateCoverage(
        planned.collections,
        planned.allocation.omittedItems,
      ),
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
      readonly nativeAuthority?: MorningBriefNativeActiveAuthority;
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
  const admissionArgs = {
    db: input.db,
    clerk: input.clerk,
    orgId: input.args.orgId,
    userId: input.args.userId,
    anchor: input.args.anchor,
    deadline: input.phaseDeadline,
  };
  const phaseSignal = morningBriefPhaseSignal(signal, input.phaseDeadlineAt);
  const admitted =
    input.args.nativeAuthority === undefined
      ? await admitMorningBriefCollection(admissionArgs, phaseSignal)
      : await admitMorningBriefNativeCollection(
          { ...admissionArgs, authority: input.args.nativeAuthority },
          phaseSignal,
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

/** The measured request one model call receives, with no evidence text. */
function requestReport(planned: {
  readonly envelopeBytes: number;
  readonly totalBytes: number;
  readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
  readonly request: MorningBriefProviderRequest;
}): NonNullable<MorningBriefCompositionResult["request"]> {
  return {
    envelopeBytes: planned.envelopeBytes,
    totalBytes: planned.totalBytes,
    maxBytes: MORNING_BRIEF_REQUEST_MAX_BYTES,
    items: planned.allocation.items.length,
    omittedItems: planned.allocation.omittedItems,
    omittedBytes: planned.allocation.omittedBytes,
    digest: planned.request.inputDigest,
  };
}

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

/** One source's bounded read, normalized. Null when no read happened at all. */
type CollectedSource = MorningBriefSourceCollection | null;

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
    readonly readChat: ChatReader;
  },
  signal: AbortSignal,
): Promise<MorningBriefSourceAttempt> {
  const { source, db, clerk, scope } = args;
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
          authority: ledgerFor(args.selections, "github"),
          deadline: sourceDeadline,
        },
        sourceSignal,
      );
    }
    if (source === "chat") {
      return await readChatSource(
        { scope, readChat: args.readChat },
        sourceSignal,
      );
    }
    if (source === "gmail") {
      return await readGmailSource(
        {
          db,
          clerk,
          scope,
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
      {
        scope,
        slack: args.slack,
        deadlineAt: sourceDeadline.at,
      },
      sourceSignal,
    );
  };
  return { kind: "read", collected: await read() };
}

/**
 * Resolve the language and assemble the request.
 *
 * Every source read was authorized before it was issued, so what survived
 * collection is the owner's evidence and goes into the request as it stands.
 */
const planMorningBriefRequest$ = command(
  async (
    { set },
    input: {
      readonly scope: MorningBriefCollectionScope;
      readonly collections: readonly MorningBriefSourceCollection[];
      readonly omittedByNormalizedCap: MorningBriefOmissionStages["byNormalizedCap"];
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
        readonly request: MorningBriefProviderRequest;
        readonly collections: readonly MorningBriefSourceCollection[];
      }
    | Extract<MorningBriefCompositionOutcome, { kind: "incomplete" }>
    | {
        readonly kind: "authority-changed";
        readonly reason: MorningBriefAuthorityChange;
      }
  > => {
    const db = set(writeDb$);
    const { scope, phaseDeadlineAt } = input;
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
      return { kind: "authority-changed", reason: "instructions-changed" };
    }
    const beforeCommit = expired("request admission");
    if (beforeCommit) {
      return beforeCommit;
    }
    if (first.request === null) {
      throw new Error("Morning Brief composition planned without a request");
    }
    return {
      kind: "planned",
      language,
      envelopeBytes: first.envelopeBytes,
      totalBytes: first.totalBytes,
      allocation: first.allocation,
      request: first.request,
      collections: bounded.collections,
    };
  },
);

/** Aggregate the complete composition's truthful source coverage. */
function aggregateCoverage(
  collections: readonly MorningBriefSourceCollection[],
  omittedItems: number,
): "complete" | "partial" | "empty" {
  const bounded = collections.some((collection) => {
    return (
      collection.coverage === "partial" || collection.coverage === "failed"
    );
  });
  if (bounded || omittedItems > 0) {
    return "partial";
  }
  return collections.some((collection) => {
    return collection.items.length > 0;
  })
    ? "complete"
    : "empty";
}

/** One sized request: the fixed envelope, the evidence that fits, the total. */
interface MorningBriefAllocated {
  readonly envelopeBytes: number;
  readonly totalBytes: number;
  readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
  readonly request: MorningBriefProviderRequest | null;
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
    request:
      packed.allocation.items.length === 0 ? null : packed.providerRequest,
  };
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
  readonly notStarted: ReadonlySet<MorningBriefSourceKind>;
  readonly unknownRequests: ReadonlySet<MorningBriefSourceKind>;
}> {
  const { waves, db, clerk, scope, phaseStartedAt, phaseDeadlineAt } = input;
  const slackBinding = input.slack;
  const collections: MorningBriefSourceCollection[] = [];
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
      collections.push(entry === null ? failedCollection(source) : entry);
    }
  }
  return { collections, notStarted, unknownRequests };
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
  /** The account choice frozen for this attempt. */
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
  // The shared reader resolved the exact Google account this read was pinned
  // to, so the normalized identity is that account rather than the member's
  // own user id.
  return withConfiguredCoverage(
    normalizeMorningBriefCalendar(
      collection,
      collection.accountRef ?? args.scope.userId,
    ),
    collection.failure,
  );
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
      // The composition allocated this source's absolute deadline before the
      // read started. Letting the collector start its own instead put its
      // graceful budget checks behind the signal that cancels it, so GitHub
      // could only ever end as a rejected job with nothing released.
      deadline: args.deadline,
    },
    signal,
  );
  if (execution.kind !== "collected") {
    // "Not executed" and "invalid anchor" both produce nothing, but neither is
    // a healthy empty read, so neither may be reported as one.
    return {
      source: "github",
      coverage: execution.kind === "not-executed" ? "unconfigured" : "failed",
      items: [],
      requests: 0,
      provenance: MORNING_BRIEF_NO_PROVENANCE,
      omittedBySource: MORNING_BRIEF_NO_OMISSIONS,
    };
  }
  return normalizeMorningBriefGithub(execution.bundle);
}

async function readChatSource(
  args: Pick<SourceReadArgs, "scope"> & {
    readonly readChat: ChatReader;
  },
  signal: AbortSignal,
): Promise<CollectedSource> {
  const collection = await args.readChat(signal);
  if (collection === null) {
    // Not installed or owner unavailable: no authorized read happened.
    return null;
  }
  return normalizeMorningBriefChat(collection, args.scope.userId);
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
  return withConfiguredCoverage(
    normalizeMorningBriefGmail(
      collection,
      collection.accountEmail ?? args.scope.userId,
    ),
    collection.failure,
  );
}

async function readSlackSource(
  args: Pick<SourceReadArgs, "scope"> & {
    readonly slack: SlackBinding;
    /** The exact instant this source's cancellation signal fires. */
    readonly deadlineAt: number;
  },
  signal: AbortSignal,
): Promise<CollectedSource> {
  const { slack, scope } = args;
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
      deadline: args.deadlineAt,
      // Reading stops before the signal that cancels this source fires, so an
      // attempt that runs out of time still releases the channels it read
      // instead of being aborted into a failure with zero items.
      readDeadline: morningBriefSourceReadCutoff(
        args.deadlineAt,
        nowDate().getTime(),
      ),
    },
    signal,
  );
  if (collected.kind !== "collected") {
    return {
      source: "slack",
      coverage: "failed",
      items: [],
      requests: collected.requests,
      provenance: MORNING_BRIEF_NO_PROVENANCE,
      omittedBySource: MORNING_BRIEF_NO_OMISSIONS,
    };
  }
  return normalizeMorningBriefSlack(collected.bundle, {
    workspaceId: slack.workspaceId,
    slackUserId: slack.slackUserId,
  });
}
