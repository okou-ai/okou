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
import { MORNING_BRIEF_COLLECTION_VERSION } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { clerk$, type ClerkClient } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  admitMorningBriefCollection,
  freezeMorningBriefSourceSelection,
  startMorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
  type MorningBriefSourceAuthorityLedger,
  type MorningBriefSourceDeadline,
} from "./morning-brief-connector-reader.service";
import {
  allocateMorningBriefRequest,
  morningBriefSourceBudget,
  morningBriefSourceWaves,
  MORNING_BRIEF_COLLECTION_PHASE_MS,
  MORNING_BRIEF_REQUEST_MAX_BYTES,
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
import { revalidateMorningBriefRetainedSources } from "./morning-brief-source-revalidation.service";
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

/** What one source contributed, with no evidence text in it. */
interface MorningBriefSourceReport {
  readonly source: MorningBriefSourceKind;
  readonly coverage: string;
  /** Normalized items that survived the combined ceiling. */
  readonly items: number;
  /** Of those, the ones the request could actually carry. */
  readonly includedInRequest: number;
  readonly requests: number;
  readonly timeSemantics: MorningBriefTimeSemanticsCount;
  readonly omitted: MorningBriefSourceOmissions;
  readonly provenance: MorningBriefSourceProvenance;
  /** A fingerprint of exactly the evidence this source put in the request. */
  readonly evidenceDigest: string;
}

/** What one composition attempt produced, with no provider payload in it. */
interface MorningBriefCompositionResult {
  readonly sources: readonly MorningBriefSourceReport[];
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
        | "no-item-fits";
      readonly detail: string;
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
 * The phase deadline covers everything from here to the final authority check.
 */
export const composeMorningBrief$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly anchor: Date;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefCompositionOutcome> => {
    const db: Db = set(writeDb$);
    const clerk = get(clerk$);
    const phaseStartedAt = nowDate();
    // One phase deadline, started before the admission that reads canonical
    // state and this member's live membership, so the preflight spends the same
    // budget the sources are allocated out of instead of running outside it.
    const phaseDeadline = startMorningBriefSourceDeadline(
      MORNING_BRIEF_COLLECTION_PHASE_MS,
    );
    const phaseDeadlineAt = new Date(phaseDeadline.at);

    const admitted = await admitMorningBriefCollection(
      {
        db,
        clerk,
        orgId: args.orgId,
        userId: args.userId,
        anchor: args.anchor,
        deadline: phaseDeadline,
      },
      signal,
    );
    signal.throwIfAborted();
    if (admitted.kind !== "ok") {
      return { kind: "denied", reason: admitted.reason };
    }
    const { scope } = admitted;

    const installation = await get(
      slackUserInstallation({ orgId: scope.orgId, userId: scope.userId }),
    );
    signal.throwIfAborted();
    const { configured, slackBinding } = configuredSources(installation);
    // Every account choice is frozen here, before any source reads. Resolving
    // each one when its own reader happens to start lets an account selected
    // after admission decide what a later source reads, so the attempt would
    // not be the attempt that was admitted.
    const selections = await freezeMorningBriefSelections(db, scope);
    signal.throwIfAborted();
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

    const { collections, descriptors } = await collectMorningBriefWaves(
      {
        waves,
        db,
        clerk,
        scope,
        slack: slackBinding,
        selections,
        phaseStartedAt,
        phaseDeadlineAt,
        readChat,
      },
      signal,
    );
    const { bounded, candidates, base } = normalizeCollected(
      collections,
      waves,
    );

    if (!candidates) {
      // Healthy empty: settle with no language I/O, no request and no delivery.
      // Nothing was supplied, so nothing is marked contributing.
      const retained = boundMorningBriefDescriptors(descriptors);
      if (retained.kind === "rejected") {
        return unbounded(retained.reason);
      }
      return {
        kind: "empty",
        result: {
          ...base,
          sources: sourceReports(bounded.collections, {
            stages: {
              byNormalizedCap: bounded.omittedBySource,
              byRequest: {},
            },
            accepted: [],
          }),
          descriptors: retained.descriptors,
          request: null,
          language: null,
        },
      };
    }
    const planned = await set(
      planMorningBriefRequest$,
      {
        scope,
        collections: bounded.collections,
        omittedByNormalizedCap: bounded.omittedBySource,
        descriptors,
        slack: slackBinding,
        phaseDeadline,
      },
      signal,
    );
    if (planned.kind !== "planned") {
      return planned;
    }
    const retained = retainSuppliedAuthority(descriptors, planned);
    if (retained.kind === "rejected") {
      return unbounded(retained.reason);
    }
    return {
      kind: "composed",
      result: {
        ...base,
        sources: sourceReports(planned.collections, {
          stages: {
            byNormalizedCap: bounded.omittedBySource,
            byRequest: planned.allocation.omittedBySource,
          },
          accepted: planned.allocation.items,
        }),
        descriptors: retained.descriptors,
        language: planned.language,
        request: requestReport(planned),
      },
    };
  },
);

function normalizeCollected(
  collections: readonly MorningBriefSourceCollection[],
  waves: readonly (readonly MorningBriefSourceKind[])[],
) {
  const deduped = collections.map((collection) => {
    return {
      ...collection,
      items: dedupeMorningBriefItems(collection.items),
    };
  });
  const bounded = boundCombinedNormalizedItems(deduped);
  return {
    bounded,
    candidates: bounded.collections.some((collection) => {
      return collection.items.length > 0;
    }),
    base: {
      waves,
      normalizedBytes: bounded.bytes,
      normalizedMaxBytes: MORNING_BRIEF_COMBINED_NORMALIZED_MAX_BYTES,
      omittedByNormalizedCap: bounded.omitted,
    },
  };
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
function unbounded(detail: string): MorningBriefCompositionOutcome {
  return {
    kind: "incomplete",
    reason: "retained-authority-unbounded",
    detail,
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
 * Read one source inside the budget the plan allows it.
 *
 * A source whose budget has already run out returns null rather than a failed
 * read: it was never started, which is a different fact from a read that failed.
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
    readonly capturedAt: Date;
    readonly readChat: ChatReader;
  },
  signal: AbortSignal,
): Promise<CollectedSource> {
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
  if (budgetMs === 0) {
    return null;
  }
  // The composition already allocated this source's absolute deadline, so the
  // reader is handed that exact instant rather than starting a second budget of
  // its own.
  const sourceDeadline: MorningBriefSourceDeadline = {
    at: budget.deadlineAt.getTime(),
    signal: AbortSignal.timeout(budgetMs),
  };
  const sourceSignal = AbortSignal.any([signal, sourceDeadline.signal]);
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
    | {
        readonly kind: "incomplete";
        readonly reason: "language-context-unavailable" | "no-item-fits";
        readonly detail: string;
      }
    | { readonly kind: "authority-changed" }
  > => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const { scope, phaseDeadline } = input;
    const phaseDeadlineAt = new Date(phaseDeadline.at);
    const bounded = { collections: input.collections };

    const context = await set(
      readMorningBriefLanguageContext$,
      { owner: scope, agentId: scope.agentId, deadlineAt: phaseDeadlineAt },
      signal,
    );
    signal.throwIfAborted();
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
      return {
        kind: "incomplete",
        reason: "no-item-fits",
        detail: `envelope ${first.envelopeBytes.toString()} of ${MORNING_BRIEF_REQUEST_MAX_BYTES.toString()} bytes`,
      };
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
    if (!unchanged) {
      return { kind: "authority-changed" };
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
  | {
      readonly kind: "proved";
      readonly collections: readonly MorningBriefSourceCollection[];
      readonly revoked: ReadonlySet<MorningBriefSourceKind>;
      readonly replanned: MorningBriefAllocated;
    };

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
  if (nowDate().getTime() >= input.deadline.at) {
    return { kind: "withdrawn" };
  }
  const supplied = new Set(
    input.planned.allocation.items.map((item) => {
      return item.identity.source;
    }),
  );
  const revalidation = await revalidateMorningBriefRetainedSources(
    {
      db: input.db,
      clerk: input.clerk,
      scope: input.scope,
      descriptors: input.descriptors.filter((descriptor) => {
        return supplied.has(descriptor.source);
      }),
      slack:
        input.slack === null
          ? null
          : {
              botToken: input.slack.botToken,
              slackUserId: input.slack.slackUserId,
            },
      deadline: input.deadline,
    },
    signal,
  );
  signal.throwIfAborted();
  if (revalidation.kind === "owner-lost") {
    return { kind: "withdrawn" };
  }
  const revoked = new Set(
    revalidation.revoked.map((entry) => {
      return entry.source;
    }),
  );
  if (revoked.size === 0) {
    return {
      kind: "proved",
      collections: input.collections,
      revoked,
      replanned: input.planned,
    };
  }
  // Withdrawn material is removed and the authorized siblings are planned
  // again, so the coverage the model receives describes the day that is
  // actually being summarized rather than the one that was collected.
  const collections = withdrawRevokedSources(input.collections, revoked);
  const replanned = allocateForCollections(collections, {
    language: input.language,
    instructions: input.instructions,
    omittedByNormalizedCap: input.omittedByNormalizedCap,
  });
  // The owner had material and every piece of it lost its authority. That is an
  // authority change, never a quiet morning.
  return replanned.allocation.items.length === 0
    ? { kind: "withdrawn" }
    : { kind: "proved", collections, revoked, replanned };
}

/** One sized request: the fixed envelope, the evidence that fits, the total. */
interface MorningBriefAllocated {
  readonly envelopeBytes: number;
  readonly totalBytes: number;
  readonly allocation: ReturnType<typeof allocateMorningBriefRequest>;
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

/** What each source contributed, with no evidence in it. */
function sourceReports(
  collections: readonly MorningBriefSourceCollection[],
  input: {
    readonly stages: MorningBriefOmissionStages;
    readonly accepted: readonly MorningBriefSourceItem[];
  },
): readonly MorningBriefSourceReport[] {
  return collections.map((collection) => {
    const accepted = input.accepted.filter((item) => {
      return item.identity.source === collection.source;
    });
    const byRequest = input.stages.byRequest[collection.source] ?? 0;
    return {
      source: collection.source,
      coverage: collection.coverage,
      items: collection.items.length,
      includedInRequest: accepted.length,
      requests: collection.requests,
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
    readonly readChat: ChatReader;
  },
  signal: AbortSignal,
): Promise<{
  readonly collections: readonly MorningBriefSourceCollection[];
  readonly descriptors: readonly MorningBriefRetainedSourceDescriptor[];
}> {
  const { waves, db, clerk, scope, phaseStartedAt, phaseDeadlineAt } = input;
  const slackBinding = input.slack;
  const capturedAt = nowDate();
  const collections: MorningBriefSourceCollection[] = [];
  const descriptors: MorningBriefRetainedSourceDescriptor[] = [];

  // Waves are joined one after another, so at most three provider reads are
  // ever in flight and every started read has an owner waiting on it.
  for (const wave of waves) {
    const finished = await Promise.all(
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
            capturedAt,
            readChat: input.readChat,
          },
          signal,
        );
      }),
    );
    signal.throwIfAborted();
    for (const entry of finished) {
      if (entry === null) {
        continue;
      }
      collections.push(entry.normalized);
      if (entry.descriptor !== null) {
        descriptors.push(entry.descriptor);
      }
    }
  }
  return { collections, descriptors };
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
  const normalized = normalizeMorningBriefCalendar(
    collection,
    args.authority.proof?.accountRef ?? args.scope.userId,
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
      // The exact login of the selected token, resolved by the collector.
      login: execution.bundle.login,
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
  const normalized = normalizeMorningBriefGmail(
    collection,
    collection.accountEmail ?? args.scope.userId,
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
