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
import type { InitialRemoteAccessOverride } from "@okouai/api-contracts/contracts/chat-remote-access";
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
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
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
  or,
  sql,
} from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { now, nowDate } from "../../lib/time";
import { type Db, db$, type ReadonlyDb, writeDb$ } from "../external/db";
import { inferMimetype } from "./chat-event-shared.service";
import { revokeMorningBriefDeliveryOwnership } from "./morning-brief-delivery.service";
import { revokeMorningBriefNativeThreadAuthority } from "./morning-brief-native-schedule.service";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import {
  deleteChatThreadDraft,
  persistChatThreadDraft,
} from "./chat-thread-draft-write.service";
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
import {
  insertInitialRemoteAccessOverrides,
  ownsInitialRemoteAccessHosts,
} from "./chat-remote-access.service";

type ChatThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentId: string;
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

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
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

type IndicatorOwner = { readonly userId: string; readonly orgId: string };
type IndicatorThreadRow = {
  readonly threadId: string;
  readonly agentId: string | null;
};
type UnreadIndicatorRow = IndicatorThreadRow & {
  readonly unreadAt: Date;
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
  return await db
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
        inArray(chatThreads.agentId, agentIds),
      ),
    )
    .groupBy(chatThreads.id, chatThreads.agentId)
    .orderBy(desc(max(agentRuns.createdAt)))
    .limit(INDICATOR_ACTIVE_LIMIT);
}

async function loadUnreadIndicatorRows(
  db: ReadonlyDb,
  args: IndicatorOwner,
  agentIds: readonly string[],
  unreadCutoff: Date,
): Promise<readonly UnreadIndicatorRow[]> {
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
  unreadRows.sort((left, right) => {
    const byTime = right.unreadAt.getTime() - left.unreadAt.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return right.threadId < left.threadId ? -1 : 1;
  });
  return unreadRows.slice(0, INDICATOR_UNREAD_LIMIT);
}

/**
 * Active and unread indicators for up to 128 visible agents in the current
 * organization. Agent IDs are loaded first and passed to the bounded thread
 * reads, so those reads do not join against or correlate to the agents table.
 * Each indicator source returns at most 50 rows. Only Run terminal markers
 * contribute unread indicators; they are resolved for at most 128 candidate
 * threads with uncorrelated reads. Unread agent state takes precedence over
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
  readonly initialRemoteAccessOverrides?: readonly InitialRemoteAccessOverride[];
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
  const initialRemoteAccessOverrides = args.initialRemoteAccessOverrides ?? [];
  if (
    initialRemoteAccessOverrides.length > 0 &&
    !(await ownsInitialRemoteAccessHosts(
      tx,
      { orgId: args.orgId, userId: args.userId },
      initialRemoteAccessOverrides,
    ))
  ) {
    // A retry may arrive after a host was deleted. Preserve the already-created
    // chat without accepting that stale host for a new chat.
    if (args.clientThreadId) {
      const replay = await resolveExistingClientThread(tx, {
        clientThreadId: args.clientThreadId,
        userId: args.userId,
        agentId: args.agentId,
      });
      if (replay.kind === "existing") {
        return replay;
      }
    }
    return {
      kind: "invalid_remote_access_selection" as const,
      message: "Remote access host not found",
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
  await insertInitialRemoteAccessOverrides(
    tx,
    createdThread.id,
    initialRemoteAccessOverrides,
  );
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

interface DeleteChatThreadArgs {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly eventId?: string;
}

async function lockChatThreadForDeletion(tx: Tx, args: DeleteChatThreadArgs) {
  const ownedThreadCondition = and(
    eq(chatThreads.id, args.threadId),
    eq(chatThreads.userId, args.userId),
    chatThreadOrganizationCondition(tx, args.orgId),
  );
  const [authorizedThread] = await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(ownedThreadCondition);
  if (!authorizedThread) {
    return undefined;
  }

  // Output owns its run before reserving event IDs; an ordinary append owns
  // the sequence before checking the thread FK. Take both children first so
  // cascading deletion cannot invert either order. Lock every attached run:
  // ON DELETE SET NULL also updates terminal runs.
  await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.chatThreadId, args.threadId))
    .orderBy(asc(agentRuns.id))
    .for("no key update");
  await tx
    .select({ id: chatEventSequences.chatThreadId })
    .from(chatEventSequences)
    .where(eq(chatEventSequences.chatThreadId, args.threadId))
    .for("update");

  // Deletion waits for a writer that already owns the thread. A writer that
  // then waits on a locked run or sequence forms a cycle that PostgreSQL's
  // deadlock detector aborts; the deletion request surfaces that failure.
  const [ownedThread] = await tx
    .select({ id: chatThreads.id, agentId: chatThreads.agentId })
    .from(chatThreads)
    .where(ownedThreadCondition)
    .for("update");
  if (!ownedThread?.agentId) {
    return undefined;
  }

  // Include an attachment committed between discovery and the strong fence;
  // the thread lock above waited for any uncommitted attachment.
  await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.chatThreadId, ownedThread.id))
    .orderBy(asc(agentRuns.id))
    .for("no key update");

  return ownedThread;
}

async function deleteChatThreadInTransaction(
  tx: Tx,
  args: DeleteChatThreadArgs,
) {
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

  const ownedThread = await lockChatThreadForDeletion(tx, args);
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

  const disabledAutomations = await disableThreadBoundWorkflowAutomations(tx, {
    userId: args.userId,
    chatThreadId: ownedThread.id,
    currentTime: nowDate(),
  });

  // Search rows are an eventually consistent derived projection without a
  // parent FK. Remove the normal-path rows synchronously; the projection
  // cron repairs only writes that race this transaction. Delete the
  // watermark first so any later projector write also restores the cleanup
  // anchor.
  await tx
    .delete(chatEventSearchMessageWatermarks)
    .where(eq(chatEventSearchMessageWatermarks.chatThreadId, ownedThread.id));
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
}

/** Delete content under the FK attach fence; external cancellation follows commit. */
export async function deleteChatThreadContent(
  db: Db,
  args: DeleteChatThreadArgs,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const result = await db.transaction(async (tx) => {
    return await deleteChatThreadInTransaction(tx, args);
  });
  signal.throwIfAborted();
  return result;
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
    args: DeleteChatThreadArgs,
    signal: AbortSignal,
  ): Promise<{
    readonly deleted: boolean;
    readonly cancelledRuns: readonly CancelRunResult[];
  }> => {
    const writeDb = set(writeDb$);

    const deletion = await deleteChatThreadContent(writeDb, args, signal);
    signal.throwIfAborted();
    if (!deletion.deleted) {
      return { deleted: false, cancelledRuns: [] };
    }

    // `chat_thread_drafts` has no foreign key to the thread, so remove its row
    // here with one statement after the deletion commits.
    await deleteChatThreadDraft(writeDb, args.threadId);
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

    await reconcileAutomationEventWatches(
      { db: writeDb, automations: deletion.disabledAutomations },
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
    await persistChatThreadDraft(set(writeDb$), {
      chatThreadId: args.threadId,
      userId: args.userId,
      draftUserMessage: args.draftUserMessage,
      draftAttachments: args.draftAttachments
        ? [...args.draftAttachments]
        : null,
    });
    signal.throwIfAborted();
  },
);
