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
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  type HostedArtifactKind,
  hostedArtifactKindSchema,
} from "@okouai/api-contracts/contracts/host";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import {
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
} from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/schema/chat-thread";
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
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  max,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import type { Tx } from "../../lib/db-types";
import { now, nowDate } from "../../lib/time";
import { type Db, db$, type ReadonlyDb, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { inferMimetype } from "./chat-event-shared.service";
import { latestReadWatermarkEventSubquery } from "./chat-thread-read-state-query";
import { revokeMorningBriefDeliveryOwnership } from "./morning-brief-delivery.service";
import { revokeMorningBriefNativeThreadAuthority } from "./morning-brief-native-schedule.service";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import { withChatThreadContentWrite } from "./chat-thread-content-erasure-admission.service";
import { persistChatThreadDraftRow } from "./chat-thread-draft-write.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { cancelRun$, type CancelRunResult } from "./run-cancel.service";
import { runOwnedChatEventForRunCondition } from "./chat-event-type.service";
import { cancellationRecoveryPendingForThread } from "./chat-active-run.service";
import { reconcileAutomationEventWatches } from "./automation-event-watch-lifecycle.service";
import { disableThreadBoundWorkflowAutomations } from "./workflow-user-automation-thread.service";
import {
  insertInitialChatThreadConnectorSelections,
  prepareChatThreadConnectorSelections,
  type PreparedChatThreadConnectorSelection,
} from "./chat-thread-connector-selection.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import { ORDINARY_CHAT_THREAD_PROVENANCE } from "./morning-brief-thread-provenance.service";

type ChatThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentId: string;
  readonly draftUserMessage: UserMessageInputDocument | null;
  readonly draftAttachments: readonly PersistedAttachment[] | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: ModelProviderType | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
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

function parseHostedArtifactAliasUrlFromMetadata(
  metadata: unknown,
): string | undefined {
  if (!isRecord(metadata) || typeof metadata.aliasUrl !== "string") {
    return undefined;
  }
  return metadata.aliasUrl;
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
        draftUserMessage: chatThreads.draftUserMessage,
        draftAttachments: chatThreads.draftAttachments,
        computerUseHostId: chatThreads.computerUseHostId,
        cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
        modelProviderId: chatThreads.modelProviderId,
        modelProviderType: chatThreads.modelProviderType,
        modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
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
      draftUserMessage: thread.draftUserMessage ?? null,
      draftAttachments: persistedAttachmentSchema
        .array()
        .nullable()
        .parse(thread.draftAttachments ?? null),
      computerUseHostId: thread.computerUseHostId,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      modelProviderId: thread.modelProviderId,
      modelProviderType:
        thread.modelProviderType === null
          ? null
          : modelProviderTypeSchema.parse(thread.modelProviderType),
      modelProviderCredentialScope: modelProviderCredentialScopeSchema
        .nullable()
        .parse(thread.modelProviderCredentialScope),
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

export function chatThreadDraft(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatThreadDraft | null>> {
  return computed(async (get): Promise<ChatThreadDraft | null> => {
    const thread = await get(ownedChatThread(args.threadId, args.userId));
    if (!thread) {
      return null;
    }

    return {
      draftUserMessage: thread.draftUserMessage,
      draftAttachments: thread.draftAttachments
        ? [...thread.draftAttachments]
        : null,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
const INDICATOR_AGENT_LIMIT = 128;
const INDICATOR_ACTIVE_LIMIT = 50;
const INDICATOR_UNREAD_LIMIT = 50;
const INDICATOR_UNREAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** One indexed lookup for the newest Run terminal marker in each thread. */
function latestRunTerminalAt() {
  return sql`(
    SELECT ${sql`${chatEvents.createdAt}`}
    FROM ${chatEvents}
    WHERE ${sql`${chatEvents.chatThreadId}`} = ${sql`${chatThreads.id}`}
      AND ${chatEventTerminalPredicate(chatEvents.eventType)}
    ORDER BY ${sql`${chatEvents.createdAt}`} DESC NULLS LAST,
      ${sql`${chatEvents.id}`} DESC
    LIMIT 1
  )`.mapWith(nullableDriverValueDecoder(chatEvents.createdAt));
}

function noActiveRunsForCurrentThreadCondition(db: Pick<Db, "select">): SQL {
  return notExists(
    db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, chatThreads.id),
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
          isNotNull(agentRuns.triggerSource),
        ),
      ),
  );
}

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
  return computed(async (get): Promise<ChatThreadDetail | null> => {
    const thread = await get(ownedChatThreadDetail(args.threadId, args.userId));
    if (!thread) {
      return null;
    }
    const cancellationRecoveryPending =
      await cancellationRecoveryPendingForThread(get(db$), {
        threadId: args.threadId,
      });

    return {
      lastReadAt: thread.lastReadAt?.toISOString() ?? null,
      cancellationRecoveryPending,
    };
  });
}

/**
 * The user's unread threads under an agent, each with the creation time of
 * the latest run-finish marker. A thread is unread only when it has at least
 * one run-finish marker and that marker is newer than the read watermark.
 */
export function chatThreadUnreads(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}): Computed<Promise<readonly { threadId: string; unreadAt: string }[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const latestReadWatermark = latestReadWatermarkEventSubquery(
      db,
      chatThreads.id,
    );
    const rows = await db
      .select({
        threadId: chatThreads.id,
        unreadAt: latestReadWatermark.createdAt,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .crossJoinLateral(latestReadWatermark)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(agents.orgId, args.orgId),
          eq(chatThreads.agentId, args.agentId),
          or(
            isNull(chatThreads.lastReadAt),
            gt(latestReadWatermark.createdAt, chatThreads.lastReadAt),
          ),
          noActiveRunsForCurrentThreadCondition(db),
        ),
      );
    return rows.map((row) => {
      return { threadId: row.threadId, unreadAt: row.unreadAt.toISOString() };
    });
  });
}

type IndicatorOwner = { readonly userId: string; readonly orgId: string };
type IndicatorThreadRow = {
  readonly threadId: string;
  readonly agentId: string | null;
};
type UnreadIndicatorRow = IndicatorThreadRow & {
  readonly unreadAt: Date | null;
};

async function loadIndicatorAgentIds(
  db: ReadonlyDb,
  args: IndicatorOwner,
): Promise<readonly string[]> {
  const rows = await db
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
}

async function loadActiveIndicatorRows(
  db: ReadonlyDb,
  args: IndicatorOwner,
  agentIds: readonly string[],
): Promise<readonly IndicatorThreadRow[]> {
  const activeRunRows = await db
    .select({ threadId: agentRuns.chatThreadId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        isNotNull(agentRuns.triggerSource),
        isNotNull(agentRuns.chatThreadId),
        exists(
          db
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(
              and(
                eq(chatThreads.id, agentRuns.chatThreadId),
                eq(chatThreads.userId, args.userId),
                inArray(chatThreads.agentId, agentIds),
              ),
            ),
        ),
      ),
    )
    .groupBy(agentRuns.chatThreadId)
    .orderBy(desc(max(agentRuns.createdAt)))
    .limit(INDICATOR_ACTIVE_LIMIT);
  const activeIds = activeRunRows.flatMap((row) => {
    return row.threadId === null ? [] : [row.threadId];
  });
  if (activeIds.length === 0) {
    return [];
  }
  return await db
    .select({ threadId: chatThreads.id, agentId: chatThreads.agentId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, args.userId),
        inArray(chatThreads.id, activeIds),
        inArray(chatThreads.agentId, agentIds),
      ),
    )
    .limit(INDICATOR_ACTIVE_LIMIT);
}

async function loadUnreadIndicatorRows(
  db: ReadonlyDb,
  args: IndicatorOwner,
  agentIds: readonly string[],
  unreadCutoff: Date,
): Promise<readonly UnreadIndicatorRow[]> {
  const commonConditions = and(
    eq(chatThreads.userId, args.userId),
    inArray(chatThreads.agentId, agentIds),
    gte(chatThreads.lastMessageAt, unreadCutoff),
    or(
      isNull(chatThreads.lastReadAt),
      gt(chatThreads.lastMessageAt, chatThreads.lastReadAt),
    ),
    noActiveRunsForCurrentThreadCondition(db),
  );
  const latestRunAt = latestRunTerminalAt();
  return await db
    .select({
      threadId: chatThreads.id,
      agentId: chatThreads.agentId,
      unreadAt: latestRunAt,
    })
    .from(chatThreads)
    .where(
      and(
        commonConditions,
        exists(
          db
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, chatThreads.id),
                chatEventTerminalPredicate(chatEvents.eventType),
                gte(chatEvents.createdAt, unreadCutoff),
                or(
                  isNull(chatThreads.lastReadAt),
                  gt(chatEvents.createdAt, chatThreads.lastReadAt),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(latestRunAt), desc(chatThreads.id))
    .limit(INDICATOR_UNREAD_LIMIT);
}

/**
 * Active and unread indicators for up to 128 visible agents in the current
 * organization. Agent IDs are loaded first and passed to the bounded thread
 * reads, so those reads do not join against or correlate to the agents table.
 * Each indicator source returns at most 50 rows. Only Run terminal markers
 * contribute unread indicators. Unread agent state takes precedence over
 * active state.
 */
export function chatIndicators(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<Indicators>> {
  return computed(async (get): Promise<Indicators> => {
    const db = get(db$);
    const agentIds = await loadIndicatorAgentIds(db, args);
    if (agentIds.length === 0) {
      return { agents: {}, threads: {}, unreadAt: {} };
    }
    const unreadCutoff = new Date(now() - INDICATOR_UNREAD_LOOKBACK_MS);
    const [activeRows, unreadRows] = await Promise.all([
      loadActiveIndicatorRows(db, args, agentIds),
      loadUnreadIndicatorRows(db, args, agentIds, unreadCutoff),
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
      if (row.unreadAt === null) {
        throw new Error("Unread indicator is missing its read watermark");
      }
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
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          isNotNull(chatThreads.draftUserMessage),
        ),
      );
    return rows.map((row) => {
      return row.id;
    });
  });
}

function loadChatThreadArtifactRows(
  db: ReadonlyDb,
  args: { readonly threadId: string; readonly userId: string },
) {
  return db
    .select({
      assetId: runUploadedFiles.id,
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
    .innerJoin(agentRuns, eq(agentRuns.id, runUploadedFiles.runId))
    .where(
      and(
        eq(runUploadedFiles.userId, args.userId),
        isNotNull(agentRuns.triggerSource),
        or(
          eq(agentRuns.chatThreadId, args.threadId),
          exists(
            db
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(
                runOwnedChatEventForRunCondition({
                  runId: runUploadedFiles.runId,
                  chatThreadId: args.threadId,
                }),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(agentRuns.createdAt), asc(runUploadedFiles.createdAt));
}

export function chatThreadArtifacts(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<readonly ChatThreadArtifactRun[] | null>> {
  return computed(
    async (get): Promise<readonly ChatThreadArtifactRun[] | null> => {
      const thread = await get(ownedChatThread(args.threadId, args.userId));
      if (!thread) {
        return null;
      }

      const db = get(db$);
      const rows = await loadChatThreadArtifactRows(db, args);

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
        const aliasUrl = parseHostedArtifactAliasUrlFromMetadata(row.metadata);
        const canonical =
          row.assetVersion === CANONICAL_ASSET_VERSION &&
          row.classification === "published-output" &&
          row.accessLevel === "published";
        existing.files.push({
          id: canonical ? row.assetId : row.externalId,
          filename,
          contentType: row.contentType ?? inferMimetype(filename),
          size: row.sizeBytes ?? 0,
          url: row.url,
          ...(row.previewImageUrl
            ? { previewImageUrl: row.previewImageUrl }
            : {}),
          ...(aliasUrl ? { aliasUrl } : {}),
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

/**
 * The thread a repeated create request already owns, read inside the same
 * transaction that lost the insert conflict. Ownership stays scoped to the
 * caller and the requested agent, so an id held by another member, org, or
 * agent resolves to a conflict the route answers without disclosing it.
 */
async function resolveExistingClientThread(
  tx: Tx,
  args: {
    readonly clientThreadId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<ExistingChatThread | { readonly kind: "client_thread_conflict" }> {
  const [existingThread] = await tx
    .select({
      id: chatThreads.id,
      createdAt: chatThreads.createdAt,
      title: chatThreads.title,
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.clientThreadId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentId, args.agentId),
      ),
    )
    .limit(1);
  if (!existingThread) {
    return { kind: "client_thread_conflict" as const };
  }
  return { kind: "existing" as const, ...existingThread };
}

interface CreateChatThreadArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly title: string | undefined;
  readonly clientThreadId: string | undefined;
  readonly eventId: string | undefined;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
  readonly modelSettings?: ModelSettings;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: ImageModelId | null;
  readonly connectorSelections?: readonly PreparedChatThreadConnectorSelection[];
}

/** Compose ordinary thread initialization inside a caller-owned transaction. */
export async function createChatThreadInTransaction(
  tx: Tx,
  args: CreateChatThreadArgs,
) {
  const modelSettings =
    args.modelSettings ??
    (await loadNewChatThreadModelSettings(tx, {
      orgId: args.orgId,
      userId: args.userId,
    }));
  const preparedConnectorSelections =
    await prepareChatThreadConnectorSelections(tx, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
      selections: args.connectorSelections ?? [],
      missingAccountPolicy: "omit",
    });
  if (preparedConnectorSelections.kind === "invalid") {
    return {
      kind: "invalid_connector_selection" as const,
      message: preparedConnectorSelections.message,
    };
  }
  const insert = tx.insert(chatThreads).values({
    ...(args.clientThreadId !== undefined ? { id: args.clientThreadId } : {}),
    userId: args.userId,
    agentId: args.agentId,
    title: args.title ?? null,
    // Positive classification belongs to the INSERT itself. A conflicting
    // replay below returns the existing row without writing this value, so a
    // client id that already names an unknown or excluded thread keeps it.
    provenance: ORDINARY_CHAT_THREAD_PROVENANCE,
    lastReadAt: sql`NOW()`,
    modelProviderId: args.modelProviderId,
    modelProviderType:
      args.modelProviderType === null
        ? null
        : modelProviderTypeSchema.parse(args.modelProviderType),
    modelProviderCredentialScope: args.modelProviderCredentialScope,
    selectedModel: args.selectedModel,
    modelSettings,
    codexServiceTier: args.codexServiceTier,
    selectedVideoModel: args.selectedVideoModel,
    selectedImageModel: args.selectedImageModel,
  });
  // Tolerate only the primary key. Each caller owns its replay policy; every
  // other database fault still propagates and rolls back initialization.
  const [createdThread] = await insert
    .onConflictDoNothing({ target: chatThreads.id })
    .returning({
      id: chatThreads.id,
      createdAt: chatThreads.createdAt,
    });
  if (!createdThread) {
    return { kind: "client_thread_conflict" as const };
  }
  await insertInitialChatThreadConnectorSelections(tx, {
    chatThreadId: createdThread.id,
    selections: preparedConnectorSelections.selections,
  });
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: createdThread.id,
    agentId: args.agentId,
    eventId: args.eventId,
    title: args.title ?? null,
    selectedModel: args.selectedModel,
    modelSettings,
    serviceTier: chatThreadServiceTierFromCodex(args.codexServiceTier),
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: args.selectedVideoModel,
    selectedImageModel: args.selectedImageModel,
    createdAt: createdThread.createdAt,
  });
  return { kind: "created" as const, ...createdThread };
}

export const createChatThread$ = command(
  async ({ set }, args: CreateChatThreadArgs, signal: AbortSignal) => {
    const thread = await set(writeDb$).transaction(async (tx) => {
      const result = await createChatThreadInTransaction(tx, args);
      if (result.kind !== "client_thread_conflict") {
        return result;
      }
      // Preserve ordinary creation's same-transaction, owner-and-agent-scoped
      // replay. Welcome creation answers 404 on a conflict and never replays.
      if (args.clientThreadId === undefined) {
        return undefined;
      }
      return await resolveExistingClientThread(tx, {
        clientThreadId: args.clientThreadId,
        userId: args.userId,
        agentId: args.agentId,
      });
    });
    signal.throwIfAborted();
    if (!thread) {
      throw new Error("Failed to create chat thread");
    }
    return thread;
  },
);

interface ThreadRunToCancel {
  readonly runId: string;
  readonly orgId: string;
}

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
    args: {
      readonly threadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly eventId?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly deleted: boolean;
    readonly cancelledRuns: readonly CancelRunResult[];
  }> => {
    const writeDb = set(writeDb$);

    const deletion = await writeDb.transaction(async (tx) => {
      // Native authority is always fenced before the destination row. A
      // delivery that already owns the schedule lock therefore commits first;
      // this delete then bumps the epoch before the thread cascade is allowed.
      await revokeMorningBriefNativeThreadAuthority(
        tx,
        {
          orgId: args.orgId,
          userId: args.userId,
          chatThreadId: args.threadId,
        },
        nowDate(),
      );

      const [ownedThread] = await tx
        .select({
          id: chatThreads.id,
          agentId: chatThreads.agentId,
        })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.id, args.threadId),
            eq(chatThreads.userId, args.userId),
            chatThreadOrganizationCondition(tx, args.orgId),
          ),
        )
        .for("update");
      if (!ownedThread?.agentId) {
        return {
          deleted: false,
          activeRuns: [] as readonly ThreadRunToCancel[],
          disabledAutomations: [],
        };
      }

      // Capture related active runs while the thread row blocks new FK attaches.
      // Terminal runs (completed/failed/cancelled) are left untouched; only
      // queued/pending/running runs need stopping.
      const activeRuns = await tx
        .select({ runId: agentRuns.id, orgId: agentRuns.orgId })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.chatThreadId, ownedThread.id),
            eq(agentRuns.userId, args.userId),
            inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
            isNotNull(agentRuns.triggerSource),
          ),
        );

      const disabledAutomations = await disableThreadBoundWorkflowAutomations(
        tx,
        {
          userId: args.userId,
          chatThreadId: ownedThread.id,
          currentTime: nowDate(),
        },
      );

      // Search rows are an eventually consistent derived projection without a
      // parent FK. Remove them synchronously under the thread lock taken above:
      // the projector now takes a conflicting KEY SHARE on this same row and
      // revalidates the thread inside its transaction, so it either commits
      // before this delete removes its rows or finds the thread gone and writes
      // nothing. Delete the watermark first so the bounded orphan repair, which
      // still covers pre-fence rows and older producers, keeps its anchor.
      await tx
        .delete(chatEventSearchMessageWatermarks)
        .where(
          eq(chatEventSearchMessageWatermarks.chatThreadId, ownedThread.id),
        );
      await tx
        .delete(chatEventSearchMessages)
        .where(eq(chatEventSearchMessages.chatThreadId, ownedThread.id));

      // A native Morning Brief delivery cascades away with this thread, and it
      // is the only association to its still-unsent mail. Remove both here, so
      // the cascade cannot orphan content-bearing email.
      await revokeMorningBriefDeliveryOwnership(tx, {
        kind: "thread",
        chatThreadId: ownedThread.id,
      });

      // Delete the thread after cleanup under its row lock. Cascades chat_events.
      // Captured active runs lose their canonical chatThreadId, while any retained legacy
      // row is independently nulled by its own foreign key.
      const [deletedThread] = await tx
        .delete(chatThreads)
        .where(eq(chatThreads.id, ownedThread.id))
        .returning({ id: chatThreads.id });

      if (deletedThread) {
        // Acquire the user/org event sequence only after all cleanup and
        // cascading deletes. A blocked child row must not hold this shared
        // lock and stall events for other threads. Keep the tombstone in this
        // transaction so deletion and its ordered event become visible
        // together.
        await appendChatThreadEvent(tx, {
          kind: "deleted",
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: ownedThread.id,
          agentId: ownedThread.agentId,
          eventId: args.eventId,
        });
      }

      return {
        deleted: Boolean(deletedThread),
        activeRuns,
        disabledAutomations,
      };
    });
    signal.throwIfAborted();
    if (!deletion.deleted) {
      return { deleted: false, cancelledRuns: [] };
    }

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

    await reconcileAutomationEventWatches(
      { db: writeDb, automations: deletion.disabledAutomations },
      signal,
    );
    signal.throwIfAborted();

    return { deleted: true, cancelledRuns };
  },
);

/**
 * The legacy draft `UPDATE` matched no owned thread.
 *
 * `chat_threads.user_id` is not a key column, so the retained `FOR KEY SHARE`
 * lock does not conflict with a concurrent non-key `UPDATE` that moves the
 * thread to another account, and under READ COMMITTED the legacy statement then
 * re-evaluates its predicate against the moved row and matches nothing. The
 * child row staged earlier in the same transaction must not survive that, so
 * this rolls the whole write back and the route keeps its existing 404.
 */
class ChatThreadDraftNotWritten extends Error {
  constructor() {
    super("Chat thread draft write matched no owned thread");
    this.name = "ChatThreadDraftNotWritten";
  }
}

/**
 * Update a chat thread's draft content + attachments.
 *
 * Ownership check via the WHERE clause; missing or cross-user thread → returns
 * `{ updated: false }` so the route handler emits the correct 404. Draft
 * changes do not publish `threadListChanged`: the editing client updates its
 * own sidebar locally, and other clients pick the dot up from the drafts
 * endpoint on their next list reload.
 *
 * A draft and its attachment descriptors are account content, so the write now
 * runs under the shared B1 admission and the canonical Agent/thread locks in
 * {@link withChatThreadContentWrite}. B1 closure reuses the same
 * `{ updated: false }` 404 disposition, which keeps the endpoint non-oracular.
 * This route deliberately requires no organization and accepts a thread without
 * an Agent, so a legal null-Agent thread keeps its thread-user-only subject.
 *
 * The draft is written to `chat_thread_drafts` and to the legacy `chat_threads`
 * columns in this one transaction, so the two can never disagree about an
 * accepted or a rejected write. Every reader still serves the legacy columns;
 * moving them onto the child row is the next, separately released slice of
 * #36173. The child upsert deliberately runs first: the legacy `UPDATE` is what
 * upgrades the hot parent row to `FOR NO KEY UPDATE`, and running it last keeps
 * that exclusive lock held for the shortest part of the transaction. It does
 * not remove the wait — this path still contends for the same thread row that
 * event projection and the read cursor write.
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
  ): Promise<{ readonly updated: boolean }> => {
    const writeDb = set(writeDb$);
    const draftAttachments = args.draftAttachments
      ? [...args.draftAttachments]
      : null;
    const result = await settle(
      withChatThreadContentWrite(
        writeDb,
        {
          chatThreadId: args.threadId,
          authorize: (identity) => {
            return identity.userId === args.userId;
          },
        },
        async (tx) => {
          await persistChatThreadDraftRow(tx, {
            chatThreadId: args.threadId,
            draftUserMessage: args.draftUserMessage,
            draftAttachments,
          });
          const updated = await tx
            .update(chatThreads)
            .set({
              draftUserMessage: args.draftUserMessage,
              draftAttachments,
            })
            .where(
              and(
                eq(chatThreads.id, args.threadId),
                eq(chatThreads.userId, args.userId),
              ),
            )
            .returning({ id: chatThreads.id });
          if (updated.length === 0) {
            throw new ChatThreadDraftNotWritten();
          }
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      // The legacy statement matched no owned thread, so the transaction rolled
      // back with the child row it had already staged and the route keeps its
      // existing 404. Every other failure propagates unchanged.
      if (result.error instanceof ChatThreadDraftNotWritten) {
        return { updated: false };
      }
      throw result.error;
    }

    return { updated: result.value.outcome === "written" };
  },
);
