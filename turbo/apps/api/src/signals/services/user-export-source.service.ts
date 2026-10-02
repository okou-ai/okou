import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { workflows } from "@okouai/db/schema/workflow";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import {
  USER_EXPORT_RESTORE_SCRIPT,
  USER_EXPORT_RESTORE_README,
} from "../../lib/user-export-restore";
import { clerk$, createClerkReadContext } from "../external/clerk";
import { listAllUserOrganizationMemberships } from "../external/clerk-organization-lists";
import { db$, writeDb$ } from "../external/db";
import { readUserExportAgentInstructions$ } from "./user-export-agent-instructions.service";
import { chatEventRowFromDbRow } from "./cron-snapshot-chat-events.service";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  readAcceptedOfficialWorkflowCatalog$,
  readAcceptedOfficialWorkflowRevision$,
} from "./official-workflow-catalog-read.service";
import { settle } from "../utils";
import {
  discordExportKindSchema,
  nextDiscordUserExportKind,
  readDiscordUserExportPage$,
} from "./user-export-discord.service";

const log = logger("service:user-export-source");
const CHAT_PAGE_SIZE = 100;
const CHAT_PAGE_ESTIMATED_BYTES = 2 * 1024 * 1024;
const CHAT_ROW_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const checkpointSchema = z.object({
  phase: z
    .enum([
      "init",
      "threads",
      "messages",
      "agents",
      "workflows",
      "memory",
      "discord",
      "done",
    ])
    .default("init"),
  startedAt: z.string().datetime().optional(),
  orgIds: z.array(z.string()).default([]),
  cursor: z.string().optional(),
  discordKind: discordExportKindSchema.optional(),
  thread: z
    .object({
      id: z.string().uuid(),
      upperSeqId: z.number().int().nonnegative(),
      afterSeqId: z.number().int().nonnegative(),
      snapshotKey: z.string().nullable(),
      snapshotPath: z.string().nullable(),
      physicalCoverage: z.number().int().nonnegative(),
    })
    .optional(),
});

type SourceCheckpoint = z.infer<typeof checkpointSchema>;

export interface UserExportSourceEntry {
  readonly path: string;
  readonly sourceKey?: string;
  readonly content?: Buffer;
  readonly metadata?: Record<string, unknown>;
}

export interface UserExportSourceStep {
  readonly checkpoint: Record<string, unknown>;
  readonly done: boolean;
  readonly entries: readonly UserExportSourceEntry[];
}

interface SourceArgs {
  readonly bucket: string;
  readonly userId: string;
  readonly orgId: string;
  readonly checkpoint: Record<string, unknown>;
}

function jsonEntry(
  path: string,
  value: unknown,
  metadata?: Record<string, unknown>,
): UserExportSourceEntry {
  return {
    path,
    content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    metadata,
  };
}

function step(
  checkpoint: SourceCheckpoint,
  entries: readonly UserExportSourceEntry[] = [],
): UserExportSourceStep {
  return {
    checkpoint: { ...checkpoint },
    entries,
    done: checkpoint.phase === "done",
  };
}

function nextPhase(
  checkpoint: SourceCheckpoint,
  phase: SourceCheckpoint["phase"],
) {
  return step({
    ...checkpoint,
    phase,
    cursor: undefined,
    thread: undefined,
    discordKind: undefined,
  });
}

function startedBefore(checkpoint: SourceCheckpoint): Date {
  if (!checkpoint.startedAt) {
    throw new Error("User export collection start is missing");
  }
  return new Date(checkpoint.startedAt);
}

type SnapshotHead = Pick<
  typeof chatEventSnapshots.$inferSelect,
  | "lastSeqId"
  | "lastEventId"
  | "terminalSeqId"
  | "terminalEventId"
  | "archiveSchemaVersion"
  | "objectKey"
>;

function snapshotEntries(threadId: string, head: SnapshotHead) {
  const digest = /-([0-9a-f]{64})\.ndjson\.gz$/u.exec(head.objectKey)?.[1];
  if (!digest || head.lastSeqId <= 0 || head.terminalSeqId === null) {
    throw new Error("User export snapshot metadata is invalid");
  }
  const path = `chat-messages/${threadId}/snapshots/${head.lastSeqId}-${digest}.ndjson.gz`;
  const metadata = {
    sourceKind: "chat-snapshot",
    threadId,
    ...head,
    expectedSha256: digest,
  };
  // The sidecar JSON this used to emit duplicated `metadata` verbatim, which the
  // files manifest already carries for every entry. One object per snapshot.
  return {
    path,
    entries: [{ path, sourceKey: head.objectKey, metadata }],
  };
}

/** The thread's saved composer draft; no row means no draft. */

function threadSourceStep<T extends { readonly id: string }>(
  thread: T,
  draftValues: {
    readonly draftUserMessage:
      | typeof chatThreadDrafts.$inferSelect.draftUserMessage
      | null;
    readonly draftAttachments: typeof chatThreadDrafts.$inferSelect.draftAttachments;
  },
  head: SnapshotHead | undefined,
  lastSeqId: number | undefined,
  checkpoint: SourceCheckpoint,
) {
  const upperSeqId = Math.max(lastSeqId ?? 0, head?.lastSeqId ?? 0);
  // Stage the immutable prefix before advancing the source cursor.
  const snapshot = head ? snapshotEntries(thread.id, head) : undefined;
  const physicalCoverage = head?.lastSeqId ?? 0;
  const entries = [
    jsonEntry(
      `chat-threads/${thread.id}.json`,
      { ...thread, ...draftValues },
      {
        sourceKind: "chat-thread",
        threadId: thread.id,
        upperSeqId,
        snapshotPath: snapshot?.path ?? null,
        physicalCoverage,
      },
    ),
    ...(snapshot?.entries ?? []),
  ];
  // A snapshot that already covers the bound leaves no tail to page. Paging
  // anyway costs a whole extra step per thread to read zero rows.
  if (physicalCoverage >= upperSeqId) {
    return step(
      {
        ...checkpoint,
        phase: "threads",
        cursor: thread.id,
        thread: undefined,
      },
      entries,
    );
  }
  return step(
    {
      ...checkpoint,
      phase: "messages",
      thread: {
        id: thread.id,
        upperSeqId,
        afterSeqId: physicalCoverage,
        snapshotKey: head?.objectKey ?? null,
        snapshotPath: snapshot?.path ?? null,
        physicalCoverage,
      },
    },
    entries,
  );
}

const collectThread$ = command(
  async (
    { set },
    args: SourceArgs,
    checkpoint: SourceCheckpoint,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    return await db.transaction(
      async (tx) => {
        const [thread] = await tx
          .select({
            id: chatThreads.id,
            userId: chatThreads.userId,
            title: chatThreads.title,
            agentId: chatThreads.agentId,
            orgId: agents.orgId,
            sourceScheduleRunId: chatThreads.sourceScheduleRunId,
            createdAt: chatThreads.createdAt,
            updatedAt: chatThreads.updatedAt,
            lastMessageAt: chatThreads.lastMessageAt,
            lastReadAt: chatThreads.lastReadAt,
            pinnedAt: chatThreads.pinnedAt,
            pinOrder: chatThreads.pinOrder,
            archived: chatThreads.archived,
            renamedAt: chatThreads.renamedAt,
            selectedModel: chatThreads.selectedModel,
            modelSettings: chatThreads.modelSettings,
            codexServiceTier: chatThreads.codexServiceTier,
          })
          .from(chatThreads)
          .leftJoin(agents, eq(agents.id, chatThreads.agentId))
          .where(
            and(
              eq(chatThreads.userId, args.userId),
              lte(chatThreads.createdAt, startedBefore(checkpoint)),
              checkpoint.cursor
                ? gt(chatThreads.id, checkpoint.cursor)
                : undefined,
            ),
          )
          .orderBy(asc(chatThreads.id))
          .limit(1);
        signal.throwIfAborted();
        if (!thread) {
          return nextPhase(checkpoint, "agents");
        }

        const [draft] = await tx
          .select({
            draftUserMessage: chatThreadDrafts.draftUserMessage,
            draftAttachments: chatThreadDrafts.draftAttachments,
          })
          .from(chatThreadDrafts)
          .where(eq(chatThreadDrafts.chatThreadId, thread.id))
          .limit(1);
        signal.throwIfAborted();
        const draftValues = {
          draftUserMessage: draft?.draftUserMessage ?? null,
          draftAttachments: draft?.draftAttachments ?? null,
        };

        const [head] = await tx
          .select({
            lastSeqId: chatEventSnapshots.lastSeqId,
            lastEventId: chatEventSnapshots.lastEventId,
            terminalSeqId: chatEventSnapshots.terminalSeqId,
            terminalEventId: chatEventSnapshots.terminalEventId,
            archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
            objectKey: chatEventSnapshots.objectKey,
          })
          .from(chatEventSnapshots)
          .where(
            and(
              eq(chatEventSnapshots.chatThreadId, thread.id),
              eq(
                chatEventSnapshots.archiveSchemaVersion,
                CURRENT_CHAT_EVENT_SCHEMA_VERSION,
              ),
            ),
          )
          .limit(1);
        signal.throwIfAborted();

        const [lastEvent] = await tx
          .select({ seqId: chatEvents.seqId })
          .from(chatEvents)
          .where(eq(chatEvents.chatThreadId, thread.id))
          .orderBy(desc(chatEvents.seqId))
          .limit(1);
        signal.throwIfAborted();
        return threadSourceStep(
          thread,
          draftValues,
          head,
          lastEvent?.seqId,
          checkpoint,
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
);

function messageSourceWindow(
  current: NonNullable<SourceCheckpoint["thread"]>,
  head: SnapshotHead | undefined,
) {
  const physicalCoverage = head?.lastSeqId ?? 0;
  if (physicalCoverage < current.physicalCoverage) {
    throw new Error("User export snapshot coverage moved backwards");
  }
  const snapshot =
    head && head.objectKey !== current.snapshotKey
      ? snapshotEntries(current.id, head)
      : undefined;
  // A newer canonical snapshot is retained as a whole. Its controls may
  // affect earlier messages, so trimming it to an older cutoff is invalid.
  // When it overtakes the bound, this step completes the thread immediately.
  const upperSeqId = Math.max(current.upperSeqId, physicalCoverage);
  const afterSeqId = Math.max(current.afterSeqId, physicalCoverage);

  return { physicalCoverage, snapshot, upperSeqId, afterSeqId };
}

function chatPagePayloadPlan(
  candidates: readonly { readonly id: string; readonly payloadBytes: number }[],
) {
  const ids: string[] = [];
  let estimatedBytes = 0;
  for (const row of candidates) {
    if (row.payloadBytes > CHAT_ROW_MAX_PAYLOAD_BYTES) {
      throw new Error(
        "A legacy chat event exceeds the 32 MiB export payload limit",
      );
    }
    const rowBytes = row.payloadBytes * 2 + 1024;
    if (
      ids.length > 0 &&
      estimatedBytes + rowBytes > CHAT_PAGE_ESTIMATED_BYTES
    ) {
      break;
    }
    ids.push(row.id);
    estimatedBytes += rowBytes;
  }
  const hasMore =
    ids.length < candidates.length || candidates.length === CHAT_PAGE_SIZE;
  return { ids, hasMore };
}

function messageSourceStep(
  checkpoint: SourceCheckpoint,
  current: NonNullable<SourceCheckpoint["thread"]>,
  head: SnapshotHead | undefined,
  window: ReturnType<typeof messageSourceWindow>,
  page: {
    readonly rows: readonly Parameters<typeof chatEventRowFromDbRow>[0][];
    readonly hasMore: boolean;
  },
) {
  const { rows, hasMore } = page;
  const { physicalCoverage, snapshot, upperSeqId, afterSeqId } = window;

  const thread = {
    ...current,
    upperSeqId,
    afterSeqId: rows.at(-1)?.seqId ?? afterSeqId,
    snapshotKey: head?.objectKey ?? null,
    snapshotPath: snapshot?.path ?? current.snapshotPath,
    physicalCoverage,
  };
  const entries: UserExportSourceEntry[] = [...(snapshot?.entries ?? [])];
  if (rows.length > 0) {
    entries.push({
      path: `chat-messages/${current.id}/tail/${String(afterSeqId).padStart(20, "0")}.jsonl`,
      content: Buffer.from(
        rows
          .map((row) => {
            return JSON.stringify(chatEventRowFromDbRow(row));
          })
          .join("\n") + "\n",
      ),
      metadata: {
        sourceKind: "chat-tail",
        threadId: current.id,
        afterSeqId,
        lastSeqId: thread.afterSeqId,
      },
    });
  }
  if (!hasMore || thread.afterSeqId >= upperSeqId) {
    // No per-thread index file: the bound lives on the thread entry's
    // manifest metadata and the snapshot entries carry their own coverage.
    return step(
      {
        ...checkpoint,
        phase: "threads",
        cursor: current.id,
        thread: undefined,
      },
      entries,
    );
  }
  return step({ ...checkpoint, thread }, entries);
}

const collectMessages$ = command(
  async (
    { set },
    args: SourceArgs,
    checkpoint: SourceCheckpoint,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const current = checkpoint.thread;
    if (!current) {
      throw new Error("User export thread cursor is missing");
    }
    return await db.transaction(
      async (tx) => {
        const [owned] = await tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, current.id),
              eq(chatThreads.userId, args.userId),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!owned) {
          throw new Error("User export thread became unavailable");
        }

        const [head] = await tx
          .select({
            lastSeqId: chatEventSnapshots.lastSeqId,
            lastEventId: chatEventSnapshots.lastEventId,
            terminalSeqId: chatEventSnapshots.terminalSeqId,
            terminalEventId: chatEventSnapshots.terminalEventId,
            archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
            objectKey: chatEventSnapshots.objectKey,
          })
          .from(chatEventSnapshots)
          .where(
            and(
              eq(chatEventSnapshots.chatThreadId, current.id),
              eq(
                chatEventSnapshots.archiveSchemaVersion,
                CURRENT_CHAT_EVENT_SCHEMA_VERSION,
              ),
            ),
          )
          .limit(1);
        signal.throwIfAborted();

        const window = messageSourceWindow(current, head);
        const { upperSeqId, afterSeqId } = window;
        // Select only bounded metadata first: 100 accepted large messages must never
        // materialize together before the worker can commit a checkpoint.
        const candidates = await tx
          .select({
            id: chatEvents.id,
            seqId: chatEvents.seqId,
            payloadBytes:
              sql`octet_length(COALESCE(${chatEvents.payload}::text, ''))`.mapWith(
                pgIntegerDecoder,
              ),
          })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.chatThreadId, current.id),
              gt(chatEvents.seqId, afterSeqId),
              lte(chatEvents.seqId, upperSeqId),
            ),
          )
          .orderBy(asc(chatEvents.seqId))
          .limit(CHAT_PAGE_SIZE);
        signal.throwIfAborted();
        const { ids, hasMore } = chatPagePayloadPlan(candidates);
        const rows = await tx
          .select({
            id: chatEvents.id,
            chatThreadId: chatEvents.chatThreadId,
            runId: chatEvents.runId,
            revokesEventId: chatEvents.revokesEventId,
            eventType: chatEvents.eventType,
            payload: chatEvents.payload,
            failureReason: chatEvents.failureReason,
            contextType: chatEvents.contextType,
            contextId: chatEvents.contextId,
            runEventSequenceNumber: chatEvents.runEventSequenceNumber,
            runEventId: chatEvents.runEventId,
            seqId: chatEvents.seqId,
            createdAt: chatEvents.createdAt,
          })
          .from(chatEvents)
          .where(
            and(
              eq(chatEvents.chatThreadId, current.id),
              inArray(chatEvents.id, ids),
            ),
          )
          .orderBy(asc(chatEvents.seqId));
        signal.throwIfAborted();
        return messageSourceStep(checkpoint, current, head, window, {
          rows,
          hasMore,
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
);

const collectAgent$ = command(
  async (
    { get, set },
    args: SourceArgs,
    checkpoint: SourceCheckpoint,
    signal: AbortSignal,
  ) => {
    if (checkpoint.orgIds.length === 0) {
      return nextPhase(checkpoint, "workflows");
    }
    const [agent] = await get(db$)
      .select({
        id: agents.id,
        orgId: agents.orgId,
        name: agents.name,
        displayName: agents.displayName,
        visibility: agents.visibility,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(
        and(
          inArray(agents.orgId, checkpoint.orgIds),
          // A subject data export carries the subject's own records. A public
          // agent authored by a colleague is their content, not this user's.
          eq(agents.owner, args.userId),
          lte(agents.createdAt, startedBefore(checkpoint)),
          checkpoint.cursor ? gt(agents.id, checkpoint.cursor) : undefined,
        ),
      )
      .orderBy(asc(agents.id))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return nextPhase(checkpoint, "workflows");
    }
    // One unreadable instruction document must not strand the whole export.
    // The committed checkpoint resumes before this agent, so a hard throw here
    // reselects it on every retry until the job exhausts its failure budget.
    const instructions = await settle(
      set(
        readUserExportAgentInstructions$,
        {
          bucket: args.bucket,
          agentId: agent.id,
          orgId: agent.orgId,
          userId: args.userId,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    const unreadable = instructions.ok
      ? undefined
      : instructions.error instanceof Error
        ? instructions.error.message
        : "Agent instructions could not be read";
    if (unreadable) {
      log.warn("Agent instructions are unreadable and were exported empty", {
        agentId: agent.id,
        orgId: agent.orgId,
        error: unreadable,
      });
    }
    return step({ ...checkpoint, cursor: agent.id }, [
      jsonEntry(
        `agents/${agent.id}.json`,
        {
          ...agent,
          instructions: instructions.ok ? instructions.value : null,
          instructionsUnavailableReason: unreadable ?? null,
        },
        {
          sourceKind: "agent",
          agentId: agent.id,
          orgId: agent.orgId,
          instructionsUnavailable: Boolean(unreadable),
        },
      ),
    ]);
  },
);

const collectWorkflow$ = command(
  async (
    { get, set },
    args: SourceArgs,
    checkpoint: SourceCheckpoint,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    if (checkpoint.orgIds.length === 0) {
      return nextPhase(checkpoint, "memory");
    }
    const [workflow] = await db
      .select({
        id: workflows.id,
        orgId: workflows.orgId,
        agentId: workflows.agentId,
        name: workflows.name,
        displayName: workflows.displayName,
        description: workflows.description,
        instruction: workflows.instruction,
        visibility: workflows.visibility,
        officialDefinitionName: workflows.officialDefinitionName,
        createdAt: workflows.createdAt,
        updatedAt: workflows.updatedAt,
      })
      .from(workflows)
      .where(
        and(
          inArray(workflows.orgId, checkpoint.orgIds),
          // Owned only, for the same reason as agents. The installation guard
          // stays: a half-installed official workflow has no readable revision.
          eq(workflows.ownerUserId, args.userId),
          or(
            isNull(workflows.officialDefinitionName),
            eq(workflows.officialInstallationState, "installed"),
          ),
          lte(workflows.createdAt, startedBefore(checkpoint)),
          checkpoint.cursor ? gt(workflows.id, checkpoint.cursor) : undefined,
        ),
      )
      .orderBy(asc(workflows.id))
      .limit(1);
    signal.throwIfAborted();
    if (!workflow) {
      return nextPhase(checkpoint, "memory");
    }
    let record = workflow;
    if (workflow.officialDefinitionName !== null) {
      const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
      const definition = catalog?.payload.definitions.find((definition) => {
        return definition.name === workflow.officialDefinitionName;
      });
      signal.throwIfAborted();
      if (!definition) {
        throw new Error(`Workflow definition is unavailable: ${workflow.id}`);
      }
      const revision = await set(
        readAcceptedOfficialWorkflowRevision$,
        {
          name: definition.name,
          revision: definition.revision,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!revision) {
        throw new Error(`Workflow revision is unavailable: ${workflow.id}`);
      }
      record = {
        ...workflow,
        displayName: revision.definition.workflow.displayName,
        description: revision.definition.workflow.description,
        instruction: revision.definition.workflow.instruction,
      };
    }
    return step({ ...checkpoint, cursor: workflow.id }, [
      jsonEntry(`workflows/${workflow.id}.json`, record, {
        sourceKind: "workflow",
        workflowId: workflow.id,
        agentId: workflow.agentId,
        orgId: workflow.orgId,
      }),
    ]);
  },
);

const collectMemory$ = command(
  async (
    { get, set },
    args: SourceArgs,
    checkpoint: SourceCheckpoint,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [storage] = await db
      .select({
        id: storages.id,
        orgId: storages.orgId,
        headVersionId: storages.headVersionId,
        fileCount: storages.fileCount,
      })
      .from(storages)
      .where(
        and(
          eq(storages.userId, args.userId),
          eq(storages.name, MEMORY_ARTIFACT_NAME),
          lte(storages.createdAt, startedBefore(checkpoint)),
          checkpoint.cursor ? gt(storages.id, checkpoint.cursor) : undefined,
        ),
      )
      .orderBy(asc(storages.id))
      .limit(1);
    signal.throwIfAborted();
    if (!storage) {
      return await set(
        collectDiscord$,
        args,
        { ...checkpoint, cursor: undefined },
        "installations",
        signal,
      );
    }
    const next = { ...checkpoint, cursor: storage.id };
    if (storage.fileCount === 0) {
      return step(next);
    }
    if (!storage.headVersionId) {
      throw new Error(`Memory version is missing: ${storage.id}`);
    }
    const [version] = await db
      .select({
        s3Key: storageVersions.s3Key,
        archiveSize: storageVersions.archiveSize,
        fileCount: storageVersions.fileCount,
      })
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, storage.id),
          eq(storageVersions.id, storage.headVersionId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!version || version.fileCount !== storage.fileCount) {
      throw new Error(
        `Memory version is unavailable or incomplete: ${storage.id}`,
      );
    }
    const path = `memory/${storage.orgId}/${storage.id}`;
    const metadata = {
      sourceKind: "memory",
      storageId: storage.id,
      orgId: storage.orgId,
      versionId: storage.headVersionId,
      fileCount: storage.fileCount,
    };
    return step(next, [
      {
        path: `${path}/archive.tar.gz`,
        sourceKey: `${version.s3Key}/archive.tar.gz`,
        metadata: { ...metadata, expectedBytes: version.archiveSize },
      },
      {
        path: `${path}/manifest.json`,
        sourceKey: `${version.s3Key}/manifest.json`,
        metadata,
      },
    ]);
  },
);

const collectDiscord$ = command(
  async (
    { set },
    args: SourceArgs,
    checkpoint: SourceCheckpoint,
    initialKind: z.infer<typeof discordExportKindSchema>,
    signal: AbortSignal,
  ) => {
    let kind: z.infer<typeof discordExportKindSchema> | undefined = initialKind;
    let cursor = checkpoint.cursor;
    while (kind) {
      const rows = await set(
        readDiscordUserExportPage$,
        {
          userId: args.userId,
          kind,
          cursor,
          startedAt: startedBefore(checkpoint),
        },
        signal,
      );
      signal.throwIfAborted();
      const last = rows.at(-1);
      if (last) {
        return step(
          {
            ...checkpoint,
            phase: "discord",
            discordKind: kind,
            cursor: last.key,
          },
          rows.map(({ key, row }) => {
            return jsonEntry(`integrations/discord/${kind}/${key}.json`, row, {
              sourceKind: "discord",
              discordKind: kind,
            });
          }),
        );
      }
      kind = nextDiscordUserExportKind(kind);
      cursor = undefined;
    }
    return nextPhase(checkpoint, "done");
  },
);

/** One resumable source page, independent of archive size or prior invocations. */
export const collectUserExportSourceStep$ = command(
  async (
    { get, set },
    args: SourceArgs,
    signal: AbortSignal,
  ): Promise<UserExportSourceStep> => {
    signal.throwIfAborted();
    const checkpoint = checkpointSchema.parse(args.checkpoint);
    switch (checkpoint.phase) {
      case "init": {
        const memberships = await listAllUserOrganizationMemberships(
          get(clerk$).users,
          args.userId,
          createClerkReadContext(),
          signal,
        );
        signal.throwIfAborted();
        return step(
          {
            phase: "threads",
            startedAt: nowDate().toISOString(),
            orgIds: [
              ...new Set(
                memberships.map((membership) => {
                  return membership.organization.id;
                }),
              ),
            ],
          },
          [
            {
              path: "README.md",
              content: Buffer.from(USER_EXPORT_RESTORE_README),
            },
            {
              path: "restore.py",
              content: Buffer.from(USER_EXPORT_RESTORE_SCRIPT),
            },
          ],
        );
      }
      case "threads": {
        return await set(collectThread$, args, checkpoint, signal);
      }
      case "messages": {
        return await set(collectMessages$, args, checkpoint, signal);
      }
      case "agents": {
        return await set(collectAgent$, args, checkpoint, signal);
      }
      case "workflows": {
        return await set(collectWorkflow$, args, checkpoint, signal);
      }
      case "memory": {
        return await set(collectMemory$, args, checkpoint, signal);
      }
      case "discord": {
        if (!checkpoint.discordKind) {
          throw new Error("User export Discord source kind is missing");
        }
        return await set(
          collectDiscord$,
          args,
          checkpoint,
          checkpoint.discordKind,
          signal,
        );
      }
      case "done": {
        return step(checkpoint);
      }
    }
  },
);
