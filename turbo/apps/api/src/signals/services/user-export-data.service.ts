import { createHash } from "node:crypto";
import { addAbortSignal, PassThrough } from "node:stream";
import { command, type Command } from "ccstate";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { workflows } from "@okouai/db/schema/workflow";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { extractBinaryFilesFromTarGz } from "../../lib/tar";
import { nowDate } from "../../lib/time";
import { clerk$, createClerkReadContext } from "../external/clerk";
import { listAllUserOrganizationMemberships } from "../external/clerk-organization-lists";
import type { Db } from "../external/db";
import { downloadManifest, downloadS3Buffer } from "../external/s3";
import { createDeferredPromise, joinAll, onRejection } from "../utils";
import { agentInstructions } from "./agent-instructions.service";
import { readCurrentChatEventHistory } from "./chat-event-history.service";
import {
  readAcceptedOfficialWorkflowDefinition,
  readAcceptedOfficialWorkflowRevision,
} from "./official-workflow-catalog-read.service";
import type { UserExportArchive } from "./user-export-archive.service";

const EXPORT_PAGE_SIZE = 100;
const CHAT_HISTORY_CONCURRENCY = 4;

interface ExportRuntime {
  readonly db: Db;
  readonly bucket: string;
}

interface ExportContext extends ExportRuntime {
  readonly userId: string;
  readonly orgIds: readonly string[];
  readonly threadIds: string[];
}

type ExportRecordsCommand = Command<
  Promise<number>,
  [ExportContext, PassThrough, AbortSignal]
>;

async function writeJsonLine(
  output: PassThrough,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const written = createDeferredPromise<void>(signal);
  output.write(`${JSON.stringify(value)}\n`, (error) => {
    if (written.settled()) {
      return;
    }
    if (error) {
      written.reject(error);
    } else {
      written.resolve();
    }
  });
  await written.promise;
}

function streamError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const writeJsonlFile$ = command(
  async (
    { set },
    archive: UserExportArchive,
    args: {
      readonly path: string;
      readonly source$: ExportRecordsCommand;
      readonly context: ExportContext;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const { path, source$, context } = args;
    signal.throwIfAborted();
    const output = addAbortSignal(signal, new PassThrough());
    const reading = onRejection(
      archive.append({ path, content: output }, signal),
      (error) => {
        output.destroy(streamError(error));
      },
    );
    const writing = onRejection(
      (async () => {
        const count = await set(source$, context, output, signal);
        signal.throwIfAborted();
        output.end();
        return count;
      })(),
      (error) => {
        output.destroy(streamError(error));
      },
    );
    const [count] = await joinAll([writing, reading]);
    signal.throwIfAborted();
    output.destroy();
    return count;
  },
);

const exportChatThreads$ = command(
  async (
    _,
    context: ExportContext,
    output: PassThrough,
    signal: AbortSignal,
  ): Promise<number> => {
    let cursor: string | undefined;
    for (;;) {
      const rows = await context.db
        .select({
          id: chatThreads.id,
          userId: chatThreads.userId,
          title: chatThreads.title,
          agentId: chatThreads.agentId,
          orgId: agents.orgId,
          sourceScheduleRunId: chatThreads.sourceScheduleRunId,
          draftUserMessage: chatThreads.draftUserMessage,
          draftAttachments: chatThreads.draftAttachments,
          createdAt: chatThreads.createdAt,
          updatedAt: chatThreads.updatedAt,
          lastMessageAt: chatThreads.lastMessageAt,
          lastReadAt: chatThreads.lastReadAt,
          pinnedAt: chatThreads.pinnedAt,
          pinOrder: chatThreads.pinOrder,
          renamedAt: chatThreads.renamedAt,
          selectedModel: chatThreads.selectedModel,
          selectedImageModel: chatThreads.selectedImageModel,
          selectedVideoModel: chatThreads.selectedVideoModel,
          modelSettings: chatThreads.modelSettings,
          codexServiceTier: chatThreads.codexServiceTier,
        })
        .from(chatThreads)
        .leftJoin(agents, eq(agents.id, chatThreads.agentId))
        .where(
          and(
            eq(chatThreads.userId, context.userId),
            cursor ? gt(chatThreads.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(chatThreads.id))
        .limit(EXPORT_PAGE_SIZE);
      signal.throwIfAborted();
      for (const row of rows) {
        await writeJsonLine(output, row, signal);
        context.threadIds.push(row.id);
      }
      if (rows.length < EXPORT_PAGE_SIZE) {
        return context.threadIds.length;
      }
      cursor = rows.at(-1)?.id;
    }
  },
);

const exportAgents$ = command(
  async (
    { get },
    context: ExportContext,
    output: PassThrough,
    signal: AbortSignal,
  ): Promise<number> => {
    if (context.orgIds.length === 0) {
      return 0;
    }
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await context.db
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
            inArray(agents.orgId, context.orgIds),
            // A subject data export carries the subject's own records only.
            eq(agents.owner, context.userId),
            cursor ? gt(agents.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(agents.id))
        .limit(EXPORT_PAGE_SIZE);
      signal.throwIfAborted();
      for (const row of rows) {
        const instructions = await get(
          agentInstructions(
            {
              agentId: row.id,
              orgId: row.orgId,
              userId: context.userId,
            },
            signal,
          ),
        );
        signal.throwIfAborted();
        if (instructions === null) {
          throw new Error(`Agent became unavailable during export: ${row.id}`);
        }
        if (instructions.content === null) {
          throw new Error(`Agent instructions are unavailable: ${row.id}`);
        }
        await writeJsonLine(
          output,
          { ...row, instructions: instructions.content },
          signal,
        );
        count += 1;
      }
      if (rows.length < EXPORT_PAGE_SIZE) {
        return count;
      }
      cursor = rows.at(-1)?.id;
    }
  },
);

const exportWorkflows$ = command(
  async (
    _,
    context: ExportContext,
    output: PassThrough,
    signal: AbortSignal,
  ): Promise<number> => {
    if (context.orgIds.length === 0) {
      return 0;
    }
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await context.db
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
        .innerJoin(agents, eq(agents.id, workflows.agentId))
        .where(
          and(
            inArray(workflows.orgId, context.orgIds),
            eq(workflows.ownerUserId, context.userId),
            or(
              isNull(workflows.officialDefinitionName),
              eq(workflows.officialInstallationState, "installed"),
            ),
            cursor ? gt(workflows.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(workflows.id))
        .limit(EXPORT_PAGE_SIZE);
      signal.throwIfAborted();
      for (const row of rows) {
        if (row.officialDefinitionName === null) {
          await writeJsonLine(output, row, signal);
        } else {
          const definition = await readAcceptedOfficialWorkflowDefinition(
            context.db,
            row.officialDefinitionName,
          );
          signal.throwIfAborted();
          if (!definition) {
            throw new Error(`Workflow definition is unavailable: ${row.id}`);
          }
          const revision = await readAcceptedOfficialWorkflowRevision(
            context.db,
            {
              name: definition.name,
              revision: definition.revision,
            },
          );
          signal.throwIfAborted();
          if (!revision) {
            throw new Error(`Workflow revision is unavailable: ${row.id}`);
          }
          await writeJsonLine(
            output,
            {
              ...row,
              displayName: revision.definition.workflow.displayName,
              description: revision.definition.workflow.description,
              instruction: revision.definition.workflow.instruction,
            },
            signal,
          );
        }
        count += 1;
      }
      if (rows.length < EXPORT_PAGE_SIZE) {
        return count;
      }
      cursor = rows.at(-1)?.id;
    }
  },
);

const exportMemory$ = command(
  async (
    { get },
    context: ExportContext,
    archive: UserExportArchive,
    signal: AbortSignal,
  ): Promise<number> => {
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await context.db
        .select({
          id: storages.id,
          orgId: storages.orgId,
          headVersionId: storages.headVersionId,
          fileCount: storages.fileCount,
        })
        .from(storages)
        .where(
          and(
            eq(storages.userId, context.userId),
            eq(storages.name, MEMORY_ARTIFACT_NAME),
            cursor ? gt(storages.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(storages.id))
        .limit(EXPORT_PAGE_SIZE);
      signal.throwIfAborted();
      for (const storage of rows) {
        if (storage.fileCount === 0) {
          continue;
        }
        if (!storage.headVersionId) {
          throw new Error(`Memory version is missing: ${storage.id}`);
        }
        const [version] = await context.db
          .select({ s3Key: storageVersions.s3Key })
          .from(storageVersions)
          .where(
            and(
              eq(storageVersions.storageId, storage.id),
              eq(storageVersions.id, storage.headVersionId),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!version) {
          throw new Error(`Memory version is missing: ${storage.id}`);
        }
        const manifest = await get(
          downloadManifest(context.bucket, version.s3Key, signal),
        );
        signal.throwIfAborted();
        const buffer = await get(
          downloadS3Buffer(
            context.bucket,
            `${version.s3Key}/archive.tar.gz`,
            signal,
          ),
        );
        signal.throwIfAborted();
        const files = extractBinaryFilesFromTarGz(
          buffer,
          manifest.files.map((file) => {
            return file.path;
          }),
        );
        if (
          files.length !== manifest.files.length ||
          files.length !== storage.fileCount
        ) {
          throw new Error(`Memory archive is incomplete: ${storage.id}`);
        }
        const expectedFiles = new Map(
          manifest.files.map((file) => {
            return [file.path.replace(/^\.\//, ""), file];
          }),
        );
        for (const file of files) {
          const expectedFile = expectedFiles.get(file.path);
          if (file.content.length !== expectedFile?.size) {
            throw new Error(
              `Memory file size mismatch: ${storage.id}/${file.path}`,
            );
          }
          if (
            createHash("sha256").update(file.content).digest("hex") !==
            expectedFile.hash
          ) {
            throw new Error(
              `Memory file checksum mismatch: ${storage.id}/${file.path}`,
            );
          }
          await archive.append(
            {
              path: `memory/${storage.orgId}/${file.path}`,
              content: file.content,
            },
            signal,
          );
          count += 1;
        }
      }
      if (rows.length < EXPORT_PAGE_SIZE) {
        return count;
      }
      cursor = rows.at(-1)?.id;
    }
  },
);

async function* jsonLines(rows: readonly unknown[]): AsyncGenerator<string> {
  for (const row of rows) {
    yield `${JSON.stringify(row)}\n`;
  }
}

export const collectUserExportData$ = command(
  async (
    { get, set },
    runtime: ExportRuntime,
    args: { readonly userId: string; readonly requestOrgId: string },
    archive: UserExportArchive,
    signal: AbortSignal,
  ): Promise<void> => {
    const { userId, requestOrgId } = args;
    const startedAt = nowDate().toISOString();
    const memberships = await listAllUserOrganizationMemberships(
      get(clerk$).users,
      userId,
      createClerkReadContext(),
      signal,
    );
    const context: ExportContext = {
      ...runtime,
      userId,
      orgIds: [
        ...new Set(
          memberships.map((membership) => {
            return membership.organization.id;
          }),
        ),
      ],
      threadIds: [],
    };
    const chatThreadsCount = await set(
      writeJsonlFile$,
      archive,
      { path: "chat-threads.jsonl", source$: exportChatThreads$, context },
      signal,
    );
    let chatMessages = 0;
    for (
      let offset = 0;
      offset < context.threadIds.length;
      offset += CHAT_HISTORY_CONCURRENCY
    ) {
      // This reader validates the immutable snapshot and combines it with its
      // PostgreSQL tail in one repeatable-read transaction, including controls.
      const threadIds = context.threadIds.slice(
        offset,
        offset + CHAT_HISTORY_CONCURRENCY,
      );
      const histories = await joinAll(
        threadIds.map((threadId) => {
          return get(readCurrentChatEventHistory(runtime, threadId, signal));
        }),
      );
      signal.throwIfAborted();
      for (const [index, rows] of histories.entries()) {
        await archive.append(
          {
            path: `chat-messages/${threadIds[index]}.jsonl`,
            content: jsonLines(rows),
          },
          signal,
        );
        chatMessages += rows.length;
      }
    }
    const agentCount = await set(
      writeJsonlFile$,
      archive,
      { path: "agents.jsonl", source$: exportAgents$, context },
      signal,
    );
    const workflowCount = await set(
      writeJsonlFile$,
      archive,
      { path: "workflows.jsonl", source$: exportWorkflows$, context },
      signal,
    );
    const memoryFiles = await set(exportMemory$, context, archive, signal);
    await archive.append(
      {
        path: "export-manifest.json",
        content: JSON.stringify(
          {
            formatVersion: 2,
            chatEventSchemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
            startedAt,
            exportedAt: nowDate().toISOString(),
            userId,
            requestOrgId,
            accessibleOrgIds: context.orgIds,
            counts: {
              chatThreads: chatThreadsCount,
              chatMessages,
              agents: agentCount,
              workflows: workflowCount,
              memoryFiles,
            },
            files: archive.files,
          },
          null,
          2,
        ),
      },
      signal,
    );
    await archive.finalize(signal);
  },
);
