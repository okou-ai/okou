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
  indicatorSchema,
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
import { chatEvents } from "@okouai/db/schema/chat-event";
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
import { unionAll } from "drizzle-orm/pg-core";
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
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { zodEnumDriverValueDecoder } from "../../lib/db-structured-result";
import type { Tx } from "../../lib/db-types";
import { now, nowDate } from "../../lib/time";
import { type Db, db$, type ReadonlyDb, writeDb$ } from "../external/db";
import { inferMimetype } from "./chat-event-shared.service";
import { latestRunFinishEventSubquery } from "./chat-thread-read-state-query";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
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
const INDICATOR_UNREAD_LIMIT = 50;
const INDICATOR_UNREAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const indicatorDecoder = zodEnumDriverValueDecoder(indicatorSchema);

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
    const lastRunFinish = latestRunFinishEventSubquery(db, chatThreads.id);
    const rows = await db
      .select({
        threadId: chatThreads.id,
        unreadAt: lastRunFinish.createdAt,
      })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .crossJoinLateral(lastRunFinish)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(agents.orgId, args.orgId),
          eq(chatThreads.agentId, args.agentId),
          or(
            isNull(chatThreads.lastReadAt),
            gt(lastRunFinish.createdAt, chatThreads.lastReadAt),
          ),
          noActiveRunsForCurrentThreadCondition(db),
        ),
      );
    return rows.map((row) => {
      return { threadId: row.threadId, unreadAt: row.unreadAt.toISOString() };
    });
  });
}

/**
 * Active and unread indicators for the user's agents and threads in the
 * current organization. Active threads are complete; unread threads are the
 * latest 50 terminal markers from the last seven days. Active threads are
 * computed once and reused to keep unread classification within one database
 * snapshot. Unread agent aggregates take precedence so unread actions remain
 * available while another thread for the same agent is active.
 */
export function chatIndicators(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<Indicators>> {
  return computed(async (get): Promise<Indicators> => {
    const db = get(db$);
    const unreadCutoff = new Date(now() - INDICATOR_UNREAD_LOOKBACK_MS);
    const activeThreads = db.$with("active_threads").as(
      db
        .selectDistinct({
          threadId: chatThreads.id,
          agentId: chatThreads.agentId,
        })
        .from(agentRuns)
        .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .where(
          and(
            eq(chatThreads.userId, args.userId),
            eq(agents.orgId, args.orgId),
            inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
            isNotNull(agentRuns.triggerSource),
          ),
        ),
    );
    const lastRunFinish = latestRunFinishEventSubquery(db, chatThreads.id);
    const unreadThreads = db.$with("unread_threads").as(
      db
        .select({
          threadId: chatThreads.id,
          agentId: chatThreads.agentId,
        })
        .from(chatThreads)
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .leftJoin(activeThreads, eq(activeThreads.threadId, chatThreads.id))
        .crossJoinLateral(lastRunFinish)
        .where(
          and(
            eq(chatThreads.userId, args.userId),
            eq(agents.orgId, args.orgId),
            isNull(activeThreads.threadId),
            gte(chatThreads.lastMessageAt, unreadCutoff),
            or(
              isNull(chatThreads.lastReadAt),
              gt(chatThreads.lastMessageAt, chatThreads.lastReadAt),
            ),
            gte(lastRunFinish.createdAt, unreadCutoff),
            or(
              isNull(chatThreads.lastReadAt),
              gt(lastRunFinish.createdAt, chatThreads.lastReadAt),
            ),
          ),
        )
        .orderBy(desc(lastRunFinish.createdAt), desc(chatThreads.id))
        .limit(INDICATOR_UNREAD_LIMIT),
    );
    const indicatorRows = db.$with("indicator_rows").as(
      unionAll(
        db
          .select({
            threadId: activeThreads.threadId,
            agentId: activeThreads.agentId,
            indicator: sql`'active'`.mapWith(indicatorDecoder).as("indicator"),
          })
          .from(activeThreads),
        db
          .select({
            threadId: unreadThreads.threadId,
            agentId: unreadThreads.agentId,
            indicator: sql`'unread'`.mapWith(indicatorDecoder).as("indicator"),
          })
          .from(unreadThreads),
      ),
    );
    const rows = await db
      .with(activeThreads, unreadThreads, indicatorRows)
      .select()
      .from(indicatorRows);

    const agentIndicators: Record<string, Indicator> = {};
    const threads: Record<string, Indicator> = {};
    for (const row of rows) {
      threads[row.threadId] = row.indicator;
      if (
        row.agentId !== null &&
        (row.indicator === "unread" ||
          agentIndicators[row.agentId] === undefined)
      ) {
        agentIndicators[row.agentId] = row.indicator;
      }
    }
    return { agents: agentIndicators, threads };
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

      const hostedArtifactRunIds = new Set(
        rows
          .filter((row) => {
            return (
              row.runId !== null &&
              parseHostedArtifactKindFromMetadata(row.metadata) !== undefined
            );
          })
          .flatMap((row) => {
            return row.runId ? [row.runId] : [];
          }),
      );
      const visibleRows = rows.filter((row) => {
        if (!row.runId) {
          return false;
        }
        const artifactKind = parseHostedArtifactKindFromMetadata(row.metadata);
        return (
          !hostedArtifactRunIds.has(row.runId) || artifactKind !== undefined
        );
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

export async function chatThreadForRunFromDb(
  db: Pick<Db, "select">,
  runId: string,
): Promise<{
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
} | null> {
  const [row] = await db
    .select({
      chatThreadId: agentRuns.chatThreadId,
      userId: chatThreads.userId,
      orgId: agentRuns.orgId,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(agentRuns.chatThreadId, chatThreads.id))
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);

  if (!row?.chatThreadId) {
    return null;
  }
  return {
    chatThreadId: row.chatThreadId,
    userId: row.userId,
    orgId: row.orgId,
  };
}

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

      await appendChatThreadEvent(tx, {
        kind: "deleted",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: ownedThread.id,
        agentId: ownedThread.agentId,
        eventId: args.eventId,
      });

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
      // parent FK. Remove the normal-path rows synchronously; the projection
      // cron repairs only writes that race this transaction. Delete the
      // watermark first so any later projector write also restores the cleanup
      // anchor.
      await tx
        .delete(chatEventSearchMessageWatermarks)
        .where(
          eq(chatEventSearchMessageWatermarks.chatThreadId, ownedThread.id),
        );
      await tx
        .delete(chatEventSearchMessages)
        .where(eq(chatEventSearchMessages.chatThreadId, ownedThread.id));

      // Delete the thread last inside the lock. Cascades chat_events; captured
      // active runs lose their canonical chatThreadId, while any retained legacy
      // row is independently nulled by its own foreign key.
      const [deletedThread] = await tx
        .delete(chatThreads)
        .where(eq(chatThreads.id, ownedThread.id))
        .returning({ id: chatThreads.id });

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
 * Update a chat thread's draft content + attachments.
 *
 * Ownership check via the WHERE clause; missing or cross-user thread → returns
 * `{ updated: false }` so the route handler emits the correct 404. Draft
 * changes do not publish `threadListChanged`: the editing client updates its
 * own sidebar locally, and other clients pick the dot up from the drafts
 * endpoint on their next list reload.
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
    const updated = await writeDb
      .update(chatThreads)
      .set({
        draftUserMessage: args.draftUserMessage,
        draftAttachments: args.draftAttachments
          ? [...args.draftAttachments]
          : null,
      })
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();

    return { updated: updated.length > 0 };
  },
);
