import { array, boolean, object, string, uuid, unknown as zUnknown } from "zod";
import { hostedSites } from "@okouai/db/runtime/hosted-site";
import { linkLayoutFromSegment } from "@okouai/api-contracts/contracts/link-layout";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { chatRelations } from "@okouai/db/schema/chat-relation";
import { artifacts } from "@okouai/db/schema/artifact";
import { command, computed, type Computed } from "ccstate";
import {
  type ChatThreadDraft,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type CodexServiceTier,
  type PersistedAttachment,
  type UserMessageInputDocument,
  type Indicator,
  type Indicators,
  persistedAttachmentSchema,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  type HostedArtifactKind,
  hostedArtifactKindSchema,
} from "@okouai/api-contracts/contracts/host";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import {
  CANONICAL_ASSET_VERSION,
  runUploadedFiles,
} from "@okouai/db/schema/run-uploaded-file";
import { agents } from "@okouai/db/schema/agent";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  or,
  sql,
  is,
  SQL,
} from "drizzle-orm";

import { settle } from "../utils";
import {
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { chatThreadInitializationCtes } from "./chat-thread-initialization-plan";
import { now, nowDate, nowDateSql } from "../../lib/time";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { db$, writeDb$ } from "../external/db";
import { inferMimetype } from "./chat-event-shared.service";
import {
  deleteChatThreadDraft$,
  persistChatThreadDraft$,
} from "./chat-thread-draft-write.service";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
import {
  cancelRun$,
  type CancelRunResult,
} from "./agent-run-terminal-transition.service";
import { cancellationRecoveryPendingForThread } from "./chat-active-run.service";
import { reconcileAutomationEventWatches$ } from "./automation-event-watch-lifecycle.service";
import {
  selectionParentMissing,
  prepareChatThreadConnectorSelections$,
  type PreparedChatThreadConnectorSelection,
} from "./chat-thread-connector-selection.service";
import {
  prepareChatThreadInsert,
  createdChatThreadFromRow,
} from "./chat-thread-create.service";
import { initialRemoteAccessOwnershipPredicate } from "./chat-remote-access.service";

type ChatThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentId: string;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly orgId: string | null;
  readonly lastReadAt: Date | null;
  readonly lastMessageAt: Date;
  readonly pinnedAt: Date | null;
  readonly renamedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type ChatThreadDetailRow = {
  readonly lastReadAt: Date | null;
};

function parseHostedArtifactKind(
  value: unknown,
): HostedArtifactKind | undefined {
  const parsed = hostedArtifactKindSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseHostedArtifactKindFromMetadata(
  metadata: unknown,
): HostedArtifactKind | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  return parseHostedArtifactKind(metadata.artifactKind);
}

const publicHostedArtifactMetadataSchema = object({
  siteId: uuid(),
  aliasUrl: string(),
});

function publicHostedSiteIds(rows: readonly { readonly metadata: unknown }[]) {
  return [
    ...new Set(
      rows.flatMap((row) => {
        const metadata = publicHostedArtifactMetadataSchema.safeParse(
          row.metadata,
        );
        return metadata.success ? [metadata.data.siteId] : [];
      }),
    ),
  ];
}

interface PublicHostedSite {
  readonly url: string;
  readonly title: string | null;
}

function currentHostedArtifactMetadata(
  metadata: unknown,
  publicSites: ReadonlyMap<string, PublicHostedSite>,
) {
  const parsed = publicHostedArtifactMetadataSchema.safeParse(metadata);
  const site = parsed.success ? publicSites.get(parsed.data.siteId) : undefined;
  return {
    ...(site ? { aliasUrl: site.url } : {}),
    ...(site?.title ? { title: site.title } : {}),
  };
}

function canonicalAssetMaterialization(
  status: "pending" | "ready" | "failed" | null,
  error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null,
): NonNullable<
  ChatThreadArtifactRun["files"][number]["assetRef"]
>["materialization"] {
  if (status === "ready") {
    return { status: "ready" };
  }
  if (status === "pending") {
    return { status: "pending" };
  }
  return {
    status: "failed",
    error: error ?? {
      code: "materialization-failed",
      message: "The attachment could not be imported",
      retryable: false,
    },
  };
}

function ownedChatThread(
  threadId: string,
  userId: string,
): Computed<Promise<ChatThreadRow | null>> {
  return computed(async (get): Promise<ChatThreadRow | null> => {
    const db = get(db$);
    const [thread] = await db
      .select({
        id: chatThreads.id,
        title: chatThreads.title,
        agentId: agents.id,
        computerUseHostId: chatThreads.computerUseHostId,
        cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
        codexServiceTier: chatThreads.codexServiceTier,
        orgId: agents.orgId,
        lastReadAt: chatThreads.lastReadAt,
        lastMessageAt: chatThreads.lastMessageAt,
        pinnedAt: chatThreads.pinnedAt,
        renamedAt: chatThreads.renamedAt,
        createdAt: chatThreads.createdAt,
        updatedAt: chatThreads.updatedAt,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
      .limit(1);

    if (!thread?.agentId) {
      return null;
    }

    return {
      id: thread.id,
      title: thread.title,
      agentId: thread.agentId,
      computerUseHostId: thread.computerUseHostId,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      codexServiceTier: thread.codexServiceTier ?? null,
      orgId: thread.orgId ?? null,
      lastReadAt: thread.lastReadAt,
      lastMessageAt: thread.lastMessageAt,
      pinnedAt: thread.pinnedAt ?? null,
      renamedAt: thread.renamedAt ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  });
}

/**
 * The caller's saved draft for one thread, read from `chat_thread_drafts` alone
 * by thread id and owner. A thread the caller does not own, a missing thread
 * and a thread without a draft all read as the empty draft; clients already
 * treat that the same as the former 404.
 */
export function chatThreadDraft(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatThreadDraft>> {
  return computed(async (get): Promise<ChatThreadDraft> => {
    const db = get(db$);
    const [draft] = await db
      .select({
        draftUserMessage: chatThreadDrafts.draftUserMessage,
        draftAttachments: chatThreadDrafts.draftAttachments,
      })
      .from(chatThreadDrafts)
      .where(
        and(
          eq(chatThreadDrafts.chatThreadId, args.threadId),
          eq(chatThreadDrafts.userId, args.userId),
        ),
      )
      .limit(1);
    return {
      draftUserMessage: draft?.draftUserMessage ?? null,
      draftAttachments: persistedAttachmentSchema
        .array()
        .nullable()
        .parse(draft?.draftAttachments ?? null),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;
const INDICATOR_AGENT_LIMIT = 128;
const INDICATOR_ACTIVE_LIMIT = 50;
const INDICATOR_UNREAD_LIMIT = 50;
/** Unread candidates read per request: the newest threads within the lookback. */
export const INDICATOR_UNREAD_CANDIDATE_LIMIT = 128;
export const INDICATOR_UNREAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function ownedChatThreadDetail(
  threadId: string,
  userId: string,
): Computed<Promise<ChatThreadDetailRow | null>> {
  return computed(async (get): Promise<ChatThreadDetailRow | null> => {
    const [thread] = await get(db$)
      .select({
        lastReadAt: chatThreads.lastReadAt,
      })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
      .limit(1);

    if (!thread) {
      return null;
    }

    return {
      lastReadAt: thread.lastReadAt,
    };
  });
}

export function chatThreadDetail(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatThreadDetail | null>> {
  const thread$ = ownedChatThreadDetail(args.threadId, args.userId);
  const recoveryPending$ = cancellationRecoveryPendingForThread(args);
  return computed(async (get): Promise<ChatThreadDetail | null> => {
    const thread = await get(thread$);
    if (!thread) {
      return null;
    }
    const cancellationRecoveryPending = await get(recoveryPending$);

    return {
      lastReadAt: thread.lastReadAt?.toISOString() ?? null,
      cancellationRecoveryPending,
    };
  });
}
type IndicatorOwner = {
  readonly userId: string;
  readonly orgId: string;
};
type IndicatorThreadRow = {
  readonly threadId: string;
  readonly agentId: string | null;
};
type UnreadIndicatorRow = IndicatorThreadRow & {
  readonly unreadAt: Date;
};

function indicatorAgentIds(args: IndicatorOwner) {
  return computed(async (get): Promise<readonly string[]> => {
    const rows = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, args.orgId),
          or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
        ),
      )
      .orderBy(desc(agents.updatedAt), desc(agents.id))
      .limit(INDICATOR_AGENT_LIMIT);
    return rows.map((row) => {
      return row.id;
    });
  });
}

function newestUnreadIndicators(rows: UnreadIndicatorRow[]) {
  rows.sort((left, right) => {
    const byTime = right.unreadAt.getTime() - left.unreadAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return right.threadId < left.threadId ? -1 : 1;
  });
  return rows.slice(0, INDICATOR_UNREAD_LIMIT);
}

function createIndicatorRows(args: IndicatorOwner) {
  const agentIds$ = indicatorAgentIds(args);
  const activeRows$ = computed(
    async (get): Promise<readonly IndicatorThreadRow[]> => {
      const agentIds = await get(agentIds$);
      if (agentIds.length === 0) {
        return [];
      }
      return await get(db$)
        .select({ threadId: chatThreads.id, agentId: chatThreads.agentId })
        .from(agentRuns)
        .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
        .where(
          and(
            eq(agentRuns.userId, args.userId),
            eq(agentRuns.orgId, args.orgId),
            inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
            isNotNull(agentRuns.triggerSource),
            eq(chatThreads.userId, args.userId),
            eq(chatThreads.hidden, false),
            inArray(chatThreads.agentId, agentIds),
          ),
        )
        .groupBy(chatThreads.id, chatThreads.agentId)
        .orderBy(desc(max(agentRuns.createdAt)))
        .limit(INDICATOR_ACTIVE_LIMIT);
    },
  );
  const unreadRows$ = computed(
    async (get): Promise<readonly UnreadIndicatorRow[]> => {
      const agentIds = await get(agentIds$);
      if (agentIds.length === 0) {
        return [];
      }
      const db = get(db$);
      const unreadCutoff = new Date(now() - INDICATOR_UNREAD_LOOKBACK_MS);
      // The newest threads with messages after their read watermark are the only
      // candidates, so the per-thread reads below have a fixed upper bound.
      const candidates = await db
        .select({
          threadId: chatThreads.id,
          agentId: chatThreads.agentId,
          lastReadAt: chatThreads.lastReadAt,
        })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.userId, args.userId),
            inArray(chatThreads.agentId, agentIds),
            eq(chatThreads.muted, false),
            eq(chatThreads.hidden, false),
            gte(chatThreads.lastMessageAt, unreadCutoff),
            or(
              isNull(chatThreads.lastReadAt),
              gt(chatThreads.lastMessageAt, chatThreads.lastReadAt),
            ),
          ),
        )
        .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
        .limit(INDICATOR_UNREAD_CANDIDATE_LIMIT);
      if (candidates.length === 0) {
        return [];
      }
      const candidateIds = candidates.map((row) => {
        return row.threadId;
      });

      const [terminalRows, activeRows] = await Promise.all([
        db
          .selectDistinctOn([chatEvents.chatThreadId], {
            threadId: chatEvents.chatThreadId,
            createdAt: chatEvents.createdAt,
          })
          .from(chatEvents)
          .where(
            and(
              inArray(chatEvents.chatThreadId, candidateIds),
              chatEventTerminalPredicate(chatEvents.eventType),
              gte(chatEvents.createdAt, unreadCutoff),
            ),
          )
          .orderBy(
            chatEvents.chatThreadId,
            desc(chatEvents.createdAt),
            desc(chatEvents.id),
          ),
        db
          .selectDistinct({ threadId: agentRuns.chatThreadId })
          .from(agentRuns)
          .where(
            and(
              inArray(agentRuns.chatThreadId, candidateIds),
              inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
              isNotNull(agentRuns.triggerSource),
            ),
          ),
      ]);

      const latestTerminalAt = new Map<string, Date>();
      for (const row of terminalRows) {
        latestTerminalAt.set(row.threadId, row.createdAt);
      }
      const activeIds = new Set(
        activeRows.map((row) => {
          return row.threadId;
        }),
      );

      const unreadRows: UnreadIndicatorRow[] = [];
      for (const candidate of candidates) {
        const unreadAt = latestTerminalAt.get(candidate.threadId);
        if (
          unreadAt === undefined ||
          activeIds.has(candidate.threadId) ||
          (candidate.lastReadAt !== null &&
            unreadAt.getTime() <= candidate.lastReadAt.getTime())
        ) {
          continue;
        }
        unreadRows.push({
          threadId: candidate.threadId,
          agentId: candidate.agentId,
          unreadAt,
        });
      }
      return newestUnreadIndicators(unreadRows);
    },
  );
  return { activeRows$, unreadRows$ };
}

/**
 * Bounded, non-atomic presentation indicators, not per-Run lifecycle status.
 * Active reflects eligible pending/running Runs; unread reflects unread terminal
 * markers, including failed and cancelled Runs. Independent reads can observe
 * different states during transitions. Missing entries do not prove inactivity
 * or completion, and exclusions do not promise eventual appearance.
 *
 * Covers up to 128 visible agents in the current organization. Agent IDs are
 * loaded first and passed to the bounded thread reads, so those reads do not
 * join against or correlate to the agents table.
 * Each indicator source returns at most 50 rows. Only Run terminal markers
 * contribute unread indicators; they are resolved for at most 128 candidate
 * threads with uncorrelated reads. Active wins for a thread; unread wins for an
 * agent, which can still have other active threads. See indicatorsSchema for
 * the public bounds and outcome-observation contract.
 */
export function chatIndicators(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<Indicators>> {
  const { activeRows$, unreadRows$ } = createIndicatorRows(args);
  return computed(async (get): Promise<Indicators> => {
    const [activeRows, unreadRows] = await Promise.all([
      get(activeRows$),
      get(unreadRows$),
    ]);

    const agentIndicators: Record<string, Indicator> = {};
    const threads: Record<string, Indicator> = {};
    const unreadAt: Record<string, string> = {};
    for (const row of activeRows) {
      threads[row.threadId] = "active";
      if (row.agentId !== null) {
        agentIndicators[row.agentId] = "active";
      }
    }
    for (const row of unreadRows) {
      // The unread reads already exclude threads with active Runs, but they
      // run concurrently with the active read and can observe a newer Run
      // state; the active indicator wins either way.
      if (threads[row.threadId] === "active") {
        continue;
      }
      threads[row.threadId] = "unread";
      unreadAt[row.threadId] = row.unreadAt.toISOString();
      if (row.agentId !== null) {
        agentIndicators[row.agentId] = "unread";
      }
    }
    return { agents: agentIndicators, threads, unreadAt };
  });
}

/**
 * Thread ids owned by the user that currently hold an unsent composer draft
 * (a canonical user message with optional `draftAttachments`).
 */
export function chatThreadDraftIds(args: {
  readonly userId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get): Promise<readonly string[]> => {
    const db = get(db$);
    const rows = await db
      .select({ id: chatThreadDrafts.chatThreadId })
      .from(chatThreadDrafts)
      .where(eq(chatThreadDrafts.userId, args.userId));
    return rows.map((row) => {
      return row.id;
    });
  });
}
function chatThreadArtifactRows(args: {
  readonly threadId: string;
  readonly userId: string;
}) {
  return computed(async (get) => {
    const db = get(db$);
    return await db
      .select({
        assetId: runUploadedFiles.id,
        artifactId: artifacts.id,
        assetVersion: runUploadedFiles.assetVersion,
        runId: runUploadedFiles.runId,
        externalId: runUploadedFiles.externalId,
        filename: runUploadedFiles.filename,
        contentType: runUploadedFiles.contentType,
        sizeBytes: runUploadedFiles.sizeBytes,
        url: runUploadedFiles.url,
        previewImageUrl: runUploadedFiles.previewImageUrl,
        metadata: runUploadedFiles.metadata,
        classification: runUploadedFiles.classification,
        accessLevel: runUploadedFiles.accessLevel,
        materializationStatus: runUploadedFiles.materializationStatus,
        materializationError: runUploadedFiles.materializationError,
        provenance: runUploadedFiles.provenance,
        createdAt: runUploadedFiles.createdAt,
      })
      .from(runUploadedFiles)
      .leftJoin(
        artifacts,
        and(
          or(
            eq(artifacts.projectionFileId, runUploadedFiles.id),
            // Every immutable publication in a chat manages the same site.
            eq(
              artifacts.logicalKey,
              sql`'site:' || (${runUploadedFiles.metadata}->>'siteId')`,
            ),
          ),
          eq(artifacts.orgId, runUploadedFiles.orgId),
          eq(artifacts.authorUserId, args.userId),
        ),
      )
      .leftJoin(
        hostedSites,
        eq(
          sql`${runUploadedFiles.metadata}->>'siteId'`,
          sql`${hostedSites.id}::text`,
        ),
      )
      .where(
        and(
          eq(runUploadedFiles.userId, args.userId),
          isNull(runUploadedFiles.deletedAt),
          isNull(artifacts.deletedAt),
          isNull(hostedSites.deletedAt),
          isNotNull(runUploadedFiles.runId),
          eq(runUploadedFiles.chatThreadId, args.threadId),
        ),
      )
      .orderBy(asc(runUploadedFiles.createdAt), asc(runUploadedFiles.id));
  });
}

function publicHostedArtifactSites(
  userId: string,
  thread$: ReturnType<typeof ownedChatThread>,
  rows$: ReturnType<typeof chatThreadArtifactRows>,
) {
  return computed(async (get) => {
    const thread = await get(thread$);
    if (!thread) {
      return new Map<string, PublicHostedSite>();
    }
    const rows = await get(rows$);
    const publicSiteIds = publicHostedSiteIds(rows);
    // Public aliases are mutable; stored upload metadata identifies the site,
    // while its current row owns the address across every deployment version.
    const publicSites =
      thread.orgId && publicSiteIds.length > 0
        ? await get(db$)
            .select({
              id: hostedSites.id,
              title: artifacts.title,
              publicSlug: hostedSites.publicSlug,
              linkLayoutSegment: hostedSites.linkLayoutSegment,
            })
            .from(hostedSites)
            .leftJoin(
              artifacts,
              and(
                eq(
                  artifacts.logicalKey,
                  sql`'site:' || ${hostedSites.id}::text`,
                ),
                eq(artifacts.orgId, hostedSites.orgId),
                eq(artifacts.authorUserId, userId),
              ),
            )
            .where(
              and(
                inArray(hostedSites.id, publicSiteIds),
                eq(hostedSites.orgId, thread.orgId),
                eq(hostedSites.userId, userId),
                isNull(hostedSites.deletedAt),
                isNotNull(hostedSites.activeDeploymentId),
              ),
            )
        : [];
    return new Map(
      publicSites.map((site) => {
        return [
          site.id,
          {
            url: hostedLinkOrigin(
              linkLayoutFromSegment(site.linkLayoutSegment),
              site.publicSlug,
            ),
            title: site.title,
          },
        ];
      }),
    );
  });
}

export function chatThreadArtifacts(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<readonly ChatThreadArtifactRun[] | null>> {
  const thread$ = ownedChatThread(args.threadId, args.userId);
  const rows$ = chatThreadArtifactRows(args);
  const publicSites$ = publicHostedArtifactSites(args.userId, thread$, rows$);
  return computed(
    async (get): Promise<readonly ChatThreadArtifactRun[] | null> => {
      const thread = await get(thread$);
      if (!thread) {
        return null;
      }

      const rows = await get(rows$);
      const publicSites = await get(publicSites$);

      const visibleRows = rows.filter((row) => {
        return row.runId !== null;
      });

      const rowsByUrl = new Map<string, (typeof visibleRows)[number]>();
      for (const row of visibleRows) {
        if (!row.url) {
          continue;
        }
        rowsByUrl.delete(row.url);
        rowsByUrl.set(row.url, row);
      }

      const byRun = new Map<string, ChatThreadArtifactRun>();
      for (const row of rowsByUrl.values()) {
        if (!row.url || !row.runId) {
          continue;
        }
        const filename = row.filename ?? row.externalId;
        const existing = byRun.get(row.runId) ?? {
          runId: row.runId,
          files: [],
        };
        const artifactKind = parseHostedArtifactKindFromMetadata(row.metadata);
        const hosted = currentHostedArtifactMetadata(row.metadata, publicSites);
        const canonical =
          row.assetVersion === CANONICAL_ASSET_VERSION &&
          row.classification === "published-output" &&
          row.accessLevel === "published";
        existing.files.push({
          id: canonical ? row.assetId : row.externalId,
          // Catalog groups hosted runs and repeated logical outputs. Files
          // outside its current projection keep their own stored resource ID.
          artifactId: row.artifactId ?? row.assetId,
          filename,
          ...hosted,
          contentType: row.contentType ?? inferMimetype(filename),
          size: row.sizeBytes ?? 0,
          url: row.url,
          ...(row.previewImageUrl
            ? { previewImageUrl: row.previewImageUrl }
            : {}),
          ...(canonical
            ? {
                assetRef: {
                  id: row.assetId,
                  classification: "published-output" as const,
                  access: "published" as const,
                  materialization: canonicalAssetMaterialization(
                    row.materializationStatus,
                    row.materializationError,
                  ),
                  ...(row.provenance
                    ? {
                        provenance: {
                          provider: row.provenance.provider,
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(artifactKind ? { artifactKind } : {}),
          createdAt: row.createdAt.toISOString(),
        });
        byRun.set(row.runId, existing);
      }

      return Array.from(byRun.values()).filter((run) => {
        return run.files.length > 0;
      });
    },
  );
}

export interface CreatedChatThread {
  readonly kind: "created";
  readonly id: string;
  readonly createdAt: Date;
}

/** The thread a duplicate delivery of one create request replays. */
export interface ExistingChatThread {
  readonly kind: "existing";
  readonly id: string;
  readonly createdAt: Date;
  readonly title: string | null;
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
}
const existingClientThreadSelection = Object.freeze({
  id: chatThreads.id,
  createdAt: chatThreads.createdAt,
  title: chatThreads.title,
  selectedModel: chatThreads.selectedModel,
  codexServiceTier: chatThreads.codexServiceTier,
});

function existingClientThreadCondition(args: {
  readonly clientThreadId: string | undefined;
  readonly userId: string;
  readonly agentId: string;
  readonly orgId: string;
}) {
  if (args.clientThreadId === undefined) {
    return sql`false`;
  }
  return and(
    eq(chatThreads.id, args.clientThreadId),
    eq(chatThreads.userId, args.userId),
    eq(chatThreads.agentId, args.agentId),
    chatThreadOrganizationPredicate(args.orgId),
  );
}

interface CreateChatThreadArgs {
  /** Only supplied from the authenticated agent token. */
  readonly sourceRunId?: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly title: string | undefined;
  readonly clientThreadId: string | undefined;
  readonly eventId: string | undefined;
  readonly selectedModel: string | null;
  readonly modelSettings?: ModelSettings;
  readonly cloudBrowserEnabled?: boolean;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly connectorSelections?: readonly PreparedChatThreadConnectorSelection[];
  readonly connectorSelectionPolicy?: "required";
  readonly committedThread?: ExistingChatThread;
  readonly initialRemoteAccessOverrides?: readonly InitialRemoteAccessOverride[];
  /** Welcome delivery seeds one immutable message only for the winning INSERT. */
  readonly initialAssistantMessage?: string;
  readonly replayExisting?: false;
}

function canReplayClientThread(args: CreateChatThreadArgs) {
  return args.clientThreadId !== undefined && args.replayExisting !== false;
}

function ordinaryChatThreadInsertPlan(args: CreateChatThreadArgs) {
  return prepareChatThreadInsert({
    orgId: args.orgId,
    ...(args.clientThreadId !== undefined ? { id: args.clientThreadId } : {}),
    userId: args.userId,
    agentId: args.agentId,
    title: args.title ?? null,
    // Positive classification belongs to the INSERT itself. A conflicting
    // replay below returns the existing row without writing this value, so a
    // client id that already names an unknown or excluded thread keeps it.
    lastReadAt: sql`NOW()`,
    selectedModel: args.selectedModel,
    modelSettings: args.modelSettings,
    cloudBrowserEnabled: args.cloudBrowserEnabled,
    codexServiceTier: args.codexServiceTier,
  });
}

function ordinaryInitializationRead(
  plan: ReturnType<typeof ordinaryChatThreadInsertPlan>,
) {
  const settings = plan.values.modelSettings;
  const browser = plan.values.cloudBrowserEnabled;
  return {
    id: sql`gen_random_uuid()`.mapWith(chatThreads.id),
    at: sql`NOW()::timestamp`.mapWith(chatThreads.createdAt),
    atText: sql`NOW()::timestamp::text`.mapWith(pgTextDecoder),
    modelSettings: (is(settings, SQL)
      ? settings
      : sql`${sql.param(settings, chatThreads.modelSettings)}::jsonb`
    ).mapWith(chatThreads.modelSettings),
    cloudBrowserEnabled: (typeof browser === "boolean"
      ? sql`${browser}::boolean`
      : browser
    ).mapWith(chatThreads.cloudBrowserEnabled),
  };
}

function preparedOrdinaryThread(
  args: CreateChatThreadArgs,
  plan: ReturnType<typeof ordinaryChatThreadInsertPlan>,
  read: {
    readonly id: string;
    readonly at: Date;
    readonly atText: string;
    readonly modelSettings: ModelSettings;
    readonly cloudBrowserEnabled: boolean;
  },
) {
  const thread = createdChatThreadFromRow(
    {
      id: args.clientThreadId ?? read.id,
      userId: args.userId,
      title: args.title ?? null,
      selectedModel: plan.values.selectedModel,
      modelSettings: read.modelSettings,
      codexServiceTier: args.codexServiceTier,
      computerUseHostId: null,
      cloudBrowserEnabled: read.cloudBrowserEnabled,
      createdAt: read.at,
    },
    args.agentId,
  );
  return {
    thread,
    values: {
      ...plan.values,
      id: thread.id,
      modelSettings: read.modelSettings,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      lastReadAt: sql`${read.atText}::timestamp`,
      lastMessageAt: sql`${read.atText}::timestamp`,
      createdAt: sql`${read.atText}::timestamp`,
      updatedAt: sql`${read.atText}::timestamp`,
    },
  };
}

const initializedThreadRowSchema = object({
  id: uuid(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema,
});

function createdThreadResult(thread: {
  readonly id: string;
  readonly createdAt: Date;
}): CreatedChatThread {
  return { kind: "created", id: thread.id, createdAt: thread.createdAt };
}

function initialConnectorSelectionInput(args: CreateChatThreadArgs) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    selections: args.connectorSelections ?? [],
    missingAccountPolicy:
      args.connectorSelectionPolicy === "required"
        ? ("reject" as const)
        : ("omit" as const),
  };
}

function initialRemoteOwnershipSelection(args: CreateChatThreadArgs) {
  return {
    owned: initialRemoteAccessOwnershipPredicate(
      args,
      args.initialRemoteAccessOverrides ?? [],
    ).mapWith(pgBooleanDecoder),
  };
}

/** The winning thread INSERT supplies the target; replays cannot invent a parent. */
function createdChatRelationCtes(args: CreateChatThreadArgs) {
  if (args.sourceRunId === undefined) {
    return [];
  }
  return [
    sql`created_chat_relation AS (
    INSERT INTO ${chatRelations}
      (org_id, user_id, type, source_chat_thread_id, target_chat_thread_id, source_run_id, created_at)
    SELECT ${args.orgId}, ${args.userId}, 'created', ${chatThreads.id},
      created_chat_thread.id, ${agentRuns.id}, ${sql.param(nowDate(), chatRelations.createdAt)}
    FROM created_chat_thread
    INNER JOIN ${agentRuns} ON ${eq(agentRuns.id, args.sourceRunId)}
    INNER JOIN ${chatThreads} ON ${chatThreads.id} = ${agentRuns.chatThreadId}
    WHERE ${agentRuns.userId} = ${args.userId}
      AND ${agentRuns.orgId} = ${args.orgId}
      AND ${chatThreads.userId} = ${args.userId}
      AND ${chatThreads.id} <> created_chat_thread.id
  )`,
  ];
}

function failedChatThreadInitialization(error: unknown) {
  // Classify only after the complete initialization has rolled back. Other
  // constraints and database failures remain errors.
  if (selectionParentMissing(error) === "account") {
    return { kind: "connector_account_unavailable" as const };
  }
  throw error;
}

function invalidInitialConnectorSelection(
  prepared: { readonly message: string; readonly accountUnavailable?: true },
  policy: CreateChatThreadArgs["connectorSelectionPolicy"],
) {
  if (prepared.accountUnavailable && policy === "required") {
    return { kind: "connector_account_unavailable" as const };
  }
  return {
    kind: "invalid_connector_selection" as const,
    message: prepared.message,
  };
}

/** Initialization and the ordered created event commit together. */
export const createChatThread$ = command(
  async ({ get, set }, args: CreateChatThreadArgs, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (args.committedThread) {
      return args.committedThread;
    }
    const preparedConnectorSelections = await set(
      prepareChatThreadConnectorSelections$,
      initialConnectorSelectionInput(args),
      signal,
    );
    if (preparedConnectorSelections.kind === "invalid") {
      return invalidInitialConnectorSelection(
        preparedConnectorSelections,
        args.connectorSelectionPolicy,
      );
    }
    const thread = await settle(
      (async () => {
        const readDb = get(db$);
        const [remoteOwnership] =
          (args.initialRemoteAccessOverrides?.length ?? 0) > 0
            ? await readDb
                .select(initialRemoteOwnershipSelection(args))
                .from(sql`(SELECT 1) AS initial_remote_ownership`)
            : [{ owned: true }];
        signal.throwIfAborted();
        if (!remoteOwnership) {
          throw new Error("Initial remote access ownership result is missing");
        }
        if (remoteOwnership.owned) {
          const plan = ordinaryChatThreadInsertPlan(args);
          const [read] = await readDb
            .with(...plan.defaults)
            .select(ordinaryInitializationRead(plan))
            .from(sql`(SELECT 1) AS initial_thread_values`);
          signal.throwIfAborted();
          if (!read) {
            throw new Error("Initial chat thread values are missing");
          }
          const prepared = preparedOrdinaryThread(args, plan, read);
          const db = set(writeDb$);
          const insertion = db
            .insert(chatThreads)
            .values(prepared.values)
            .onConflictDoNothing()
            .returning({
              id: chatThreads.id,
              createdAt: chatThreads.createdAt,
            });
          const ctes = [
            sql`created_chat_thread AS (${insertion.getSQL()})`,
            ...createdChatRelationCtes(args),
            ...chatThreadInitializationCtes({
              orgId: args.orgId,
              eventId: args.eventId,
              thread: prepared.thread,
              selections: preparedConnectorSelections.selections,
              required: args.connectorSelectionPolicy === "required",
              remoteOverrides: args.initialRemoteAccessOverrides ?? [],
              assistantMessage: args.initialAssistantMessage,
            }),
          ];
          const [created] = parseRawRows(
            initializedThreadRowSchema,
            await db.execute(sql`WITH ${sql.join(ctes, sql`, `)}
              SELECT id, created_at::text AS "createdAt" FROM created_chat_thread`),
          );
          signal.throwIfAborted();
          if (created) {
            return createdThreadResult(created);
          }
        }
        if (canReplayClientThread(args)) {
          // A conflicting INSERT may have waited for an uncommitted winner.
          // Read again after that statement; its initial snapshot cannot replay it.
          const [existing] = await readDb
            .select(existingClientThreadSelection)
            .from(chatThreads)
            .where(existingClientThreadCondition(args))
            .limit(1);
          signal.throwIfAborted();
          if (existing) {
            return { kind: "existing" as const, ...existing };
          }
        }
        return remoteOwnership.owned
          ? { kind: "client_thread_conflict" as const }
          : {
              kind: "invalid_remote_access_selection" as const,
              message: "Remote access host not found",
            };
      })(),
      signal,
    );
    signal.throwIfAborted();
    return thread.ok
      ? thread.value
      : failedChatThreadInitialization(thread.error);
  },
);

interface DeleteChatThreadArgs {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly eventId?: string;
}

const deletedThreadRowSchema = object({
  result: object({
    deleted: boolean(),
    activeRuns: array(object({ runId: string(), orgId: string() })),
    disabledAutomations: array(
      object({
        orgId: string(),
        ownerUserId: string(),
        eventType: string().nullable(),
        eventConfig: zUnknown(),
        eventConnectorId: string().nullable(),
      }),
    ),
  }),
});

/** The finite route owner keeps deletion and committed cleanup together. */
const deleteChatThreadContent$ = command(
  async ({ set }, args: DeleteChatThreadArgs, signal: AbortSignal) => {
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    const query = sql`SELECT public.delete_chat_thread_content(
      ${args.threadId}::uuid, ${args.userId}, ${args.orgId},
      ${args.eventId ?? null}, ${nowDateSql(sql`NULL::timestamp`)}
    ) AS result`;
    const rowSchema = deletedThreadRowSchema;
    const result = await (async () => {
      const deletion = await settle(
        (async () => {
          return parseRawRows(rowSchema, await writeDb.execute(query));
        })(),
      );
      if (!deletion.ok) {
        throw new Error(
          `Chat thread deletion SQL execution failed (${safeSqlStateCode(deletion.error) ?? "unknown"})`,
        );
      }
      const [row] = deletion.value;
      if (!row) {
        throw new Error("Chat thread deletion returned no outcome");
      }
      return row.result;
    })();
    signal.throwIfAborted();
    return result;
  },
);
/**
 * Delete a chat thread after winding down everything attached to it. Deleting a
 * thread on its own leaves the linked automations firing and any in-flight runs
 * executing: the canonical run metadata uses `ON DELETE SET NULL`, so a running
 * run simply loses its thread reference and keeps consuming credits.
 *
 * Lock the thread row while deleting it and collecting active runs. Inserts into
 * `agent_runs.chatThreadId` take a FK lock on the same parent row, so this closes
 * the race where a new run attaches after the active-run scan but before the
 * thread delete. All run-side thread ownership now lives in `agent_runs`.
 * Cancellation still happens after the delete transaction because it has runner
 * notifications and queue-drain side effects.
 *
 * Run cancellation has side effects that cannot participate in the thread's
 * delete transaction (`cancelRun$` opens its own transaction and the runner
 * must be notified), so ownership is verified up front and the cancelled-run
 * results are returned for the caller to dispatch the post-cancel side effects.
 */
export const deleteChatThread$ = command(
  async (
    { set },
    args: DeleteChatThreadArgs,
    signal: AbortSignal,
  ): Promise<{
    readonly deleted: boolean;
    readonly cancelledRuns: readonly CancelRunResult[];
  }> => {
    const deletion = await set(deleteChatThreadContent$, args, signal);
    signal.throwIfAborted();
    if (!deletion.deleted) {
      return { deleted: false, cancelledRuns: [] };
    }
    // `chat_thread_drafts` has no foreign key to the thread, so remove its row
    // here with one statement after the deletion commits.
    await set(deleteChatThreadDraft$, args.threadId, signal);
    signal.throwIfAborted();
    const cancelledRuns: CancelRunResult[] = [];
    for (const run of deletion.activeRuns) {
      const result = await set(
        cancelRun$,
        {
          runId: run.runId,
          userId: args.userId,
          orgId: run.orgId,
          runnerCancellationMode: "hard",
        },
        signal,
      );
      signal.throwIfAborted();
      // Pre-filtered to active runs, but a concurrent transition can still race
      // a run to a terminal status; cancelRun$ then returns a frozen error
      // response (no `alreadyCancelled` field), which we skip.
      if ("alreadyCancelled" in result) {
        cancelledRuns.push(result);
      }
    }
    await set(
      reconcileAutomationEventWatches$,
      { automations: deletion.disabledAutomations },
      signal,
    );
    signal.throwIfAborted();
    return { deleted: true, cancelledRuns };
  },
);

/**
 * Save or clear the caller's composer draft for one thread.
 *
 * One statement on `chat_thread_drafts`, keyed by the thread and the caller.
 * Nothing reads or locks `chat_threads`: a write for a thread the caller does
 * not own, or for a missing thread, lands in a row keyed to the caller that no
 * reader ever serves for anyone else. Draft changes do not publish
 * `threadListChanged`; other clients pick the dot up from the drafts endpoint.
 */
export const updateChatThreadDraft$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly userId: string;
      readonly draftUserMessage: UserMessageInputDocument | null;
      readonly draftAttachments: readonly PersistedAttachment[] | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      persistChatThreadDraft$,
      {
        chatThreadId: args.threadId,
        userId: args.userId,
        draftUserMessage: args.draftUserMessage,
        draftAttachments: args.draftAttachments
          ? [...args.draftAttachments]
          : null,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);
