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
  startMorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
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

/** What one composition attempt produced, with no provider payload in it. */
interface MorningBriefCompositionResult {
  readonly sources: readonly {
    readonly source: MorningBriefSourceKind;
    readonly coverage: string;
    readonly items: number;
    readonly requests: number;
  }[];
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
        phaseStartedAt,
        phaseDeadlineAt,
        readChat,
      },
      signal,
    );
    const deduped = collections.map((collection) => {
      return {
        ...collection,
        items: dedupeMorningBriefItems(collection.items),
      };
    });
    const bounded = boundCombinedNormalizedItems(deduped);
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
      descriptors.map((descriptor) => {
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
      };
    }

    const base = {
      sources: sourceSummary(bounded.collections),
      waves,
      normalizedBytes: bounded.bytes,
      omittedByNormalizedCap: bounded.omitted,
      descriptors: retained.descriptors,
    };

    if (contributed.size === 0) {
      // Healthy empty: settle with no language I/O, no request and no delivery.
      return {
        kind: "empty",
        result: { ...base, request: null, language: null },
      };
    }
    const planned = await set(
      planMorningBriefRequest$,
      { scope, collections: bounded.collections, phaseDeadline, args },
      signal,
    );
    if (planned.kind !== "planned") {
      return planned;
    }
    const { language, envelopeBytes, totalBytes, allocation } = planned;
    return {
      kind: "composed",
      result: {
        ...base,
        language,
        request: {
          envelopeBytes,
          totalBytes,
          maxBytes: MORNING_BRIEF_REQUEST_MAX_BYTES,
          items: allocation.items.length,
          omittedItems: allocation.omittedItems,
          omittedBytes: allocation.omittedBytes,
        },
      },
    };
  },
);

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
        readonly reason: "language-context-unavailable" | "no-item-fits";
        readonly detail: string;
      }
    | { readonly kind: "authority-changed" }
  > => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const { scope, phaseDeadline, args } = input;
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
    if (nowDate().getTime() >= phaseDeadlineAt.getTime()) {
      return { kind: "authority-changed" };
    }
    const recheck = await admitMorningBriefCollection(
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
    if (context.kind === "available") {
      const current = await resolveMorningBriefInstructionsVersion(
        db,
        scope,
        scope.agentId,
      );
      signal.throwIfAborted();
      if (
        current.kind !== "resolved" ||
        current.versionId !== context.versionId
      ) {
        return { kind: "authority-changed" };
      }
    }
    return { kind: "planned", language, envelopeBytes, totalBytes, allocation };
  },
);

/** What each source contributed, with no evidence in it. */
function sourceSummary(
  collections: readonly MorningBriefSourceCollection[],
): MorningBriefCompositionResult["sources"] {
  return collections.map((collection) => {
    return {
      source: collection.source,
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
 * a cancelled attempt cannot leave a reader running past it.
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
  const normalized = normalizeMorningBriefCalendar(
    collection,
    args.scope.userId,
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
