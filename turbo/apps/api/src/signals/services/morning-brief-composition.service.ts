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

import { MORNING_BRIEF_COLLECTION_VERSION } from "@okouai/db/schema/morning-brief-collection-occurrence";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import {
  admitMorningBriefCollection,
  type MorningBriefCollectionScope,
} from "./morning-brief-connector-reader.service";
import {
  allocateMorningBriefRequest,
  morningBriefSourceBudget,
  morningBriefSourceWaves,
  MORNING_BRIEF_COLLECTION_PHASE_MS,
  MORNING_BRIEF_REQUEST_MAX_BYTES,
} from "./morning-brief-collection-plan";
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

/** Slack's frozen window is the 24 hours ending at the anchor. */
const MORNING_BRIEF_SLACK_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What one composition attempt produced, with no provider payload in it. */
export interface MorningBriefCompositionResult {
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
export type MorningBriefCompositionOutcome =
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

/** Which sources this owner actually has, frozen for the attempt. */
async function configuredSources(
  get: (value: ReturnType<typeof slackUserInstallation>) => Promise<{
    readonly kind: string;
    readonly botToken?: string;
    readonly workspaceId?: string;
    readonly slackUserId?: string;
  }>,
  scope: MorningBriefCollectionScope,
): Promise<{
  readonly sources: readonly MorningBriefSourceKind[];
  readonly slack: {
    readonly botToken: string;
    readonly workspaceId: string;
    readonly slackUserId: string;
  } | null;
}> {
  const installation = await get(
    slackUserInstallation({ orgId: scope.orgId, userId: scope.userId }),
  );
  const slack =
    installation.kind === "connected" &&
    installation.botToken !== undefined &&
    installation.workspaceId !== undefined &&
    installation.slackUserId !== undefined
      ? {
          botToken: installation.botToken,
          workspaceId: installation.workspaceId,
          slackUserId: installation.slackUserId,
        }
      : null;
  // Gmail is always attempted: the shared reader is the only thing that knows
  // whether this member has a usable selected connection, and it reports an
  // unconfigured source as an unavailable collection rather than throwing.
  const sources: MorningBriefSourceKind[] = ["gmail"];
  if (slack !== null) {
    sources.push("slack");
  }
  return { sources, slack };
}

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
    const phaseDeadlineAt = new Date(
      phaseStartedAt.getTime() + MORNING_BRIEF_COLLECTION_PHASE_MS,
    );

    const admitted = await admitMorningBriefCollection(
      {
        db,
        clerk,
        orgId: args.orgId,
        userId: args.userId,
        anchor: args.anchor,
      },
      signal,
    );
    signal.throwIfAborted();
    if (admitted.kind !== "ok") {
      return { kind: "denied", reason: admitted.reason };
    }
    const { scope } = admitted;

    const configured = await configuredSources(get, scope);
    signal.throwIfAborted();
    const waves = morningBriefSourceWaves(configured.sources);

    const collections: MorningBriefSourceCollection[] = [];
    const descriptors: MorningBriefRetainedSourceDescriptor[] = [];
    const capturedAt = nowDate();

    // Waves are joined one after another, so at most three provider reads are
    // ever in flight and every started read has an owner waiting on it.
    for (const wave of waves) {
      const started = wave.map(async (source) => {
        const budget = morningBriefSourceBudget(
          source,
          phaseStartedAt,
          nowDate(),
          phaseDeadlineAt,
        );
        const budgetMs = Math.max(
          0,
          budget.deadlineAt.getTime() - nowDate().getTime(),
        );
        if (budgetMs === 0) {
          return null;
        }
        const sourceSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(budgetMs),
        ]);
        if (source === "gmail") {
          const collection = await collectMorningBriefGmail(
            { db, clerk, scope },
            sourceSignal,
          );
          // The item identity's account segment is the owning member: the
          // collector does not currently return the mailbox the shared reader
          // resolved, so inventing one here would be worse than naming the
          // member the connection belongs to. The exact mailbox is requested
          // from the Gmail collector as `accountEmail` on its collection;
          // until it is returned, `accountRef` stays null rather than holding
          // a value nothing observed.
          const normalized = normalizeMorningBriefGmail(
            collection,
            scope.userId,
          );
          return {
            normalized,
            descriptor: morningBriefGmailDescriptor({
              accountEmail: null,
              connectionId: null,
              membershipId: scope.membershipId,
              agentId: scope.agentId,
              capturedAt,
              contributed: false,
              containers: containerIds(normalized),
            }),
          };
        }
        const slack = configured.slack;
        if (slack === null) {
          return null;
        }
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
            deadline: nowDate().getTime() + budgetMs,
          },
          sourceSignal,
        );
        if (collected.kind !== "collected") {
          return {
            normalized: {
              source: "slack" as const,
              coverage: "failed" as const,
              items: [],
              requests: 0,
              omittedBySource: 0,
            },
            descriptor: morningBriefSlackDescriptor({
              workspaceId: slack.workspaceId,
              slackUserId: slack.slackUserId,
              membershipId: scope.membershipId,
              agentId: scope.agentId,
              capturedAt,
              contributed: false,
              containers: [],
            }),
          };
        }
        const normalized = normalizeMorningBriefSlack(collected.bundle, {
          workspaceId: slack.workspaceId,
          slackUserId: slack.slackUserId,
        });
        return {
          normalized,
          descriptor: morningBriefSlackDescriptor({
            workspaceId: slack.workspaceId,
            slackUserId: slack.slackUserId,
            membershipId: scope.membershipId,
            agentId: scope.agentId,
            capturedAt,
            contributed: false,
            containers: containerIds(normalized),
          }),
        };
      });
      const finished = await Promise.all(started);
      signal.throwIfAborted();
      for (const entry of finished) {
        if (entry !== null) {
          collections.push(entry.normalized);
          descriptors.push(entry.descriptor);
        }
      }
    }

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

    const summary = bounded.collections.map((collection) => {
      return {
        source: collection.source,
        coverage: collection.coverage,
        items: collection.items.length,
        requests: collection.requests,
      };
    });
    const base = {
      sources: summary,
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

    const coverage = morningBriefCoverageReport(bounded.collections, {});
    const envelopeBytes = morningBriefEnvelopeBytes({
      language,
      instructions,
      coverage,
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
