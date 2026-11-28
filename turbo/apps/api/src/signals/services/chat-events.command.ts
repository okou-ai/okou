import { createHash, randomUUID } from "node:crypto";
import {
  resolveVoiceClipRecords,
  voiceClipRequestError,
} from "./voice-clips.service";
import {
  publishChatThreadMessageCreated$,
  projectCommittedChatThreadSearch$,
} from "./chat-event-publication.service";
import { deliverMarketingRewardEvents$ } from "./marketing-reward-event-delivery.service";
import { organizationAuthContext$ } from "../auth/auth-context";
import { apiStartTime$, route$ } from "../context/hono";
import { db$, writeDb$ } from "../external/db";
import { cancelRun$ } from "./agent-run-cancellation.service";
import { notifyBrowserUserActionCallback$ } from "./browser-user-action-callback.service";
import { touchSentChatThreadSort$ } from "./chat-event-shared.service";
import {
  notifyRunningChatRunOfPendingInput$,
  pickEnqueuedChatThread$,
} from "./chat-thread-queue-drain.service";
import {
  AUTO_SELECTED_MODEL,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import {
  pgTimestampWithoutTimezoneToDateSchema,
  parseRawRows,
} from "../../lib/db-raw-rows";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import type { EnqueuedChatInputFacts } from "./chat-run-preparation-facts";

import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import type {
  CodexServiceTier,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { resolveChatEventRecommendedFollowups } from "@okouai/api-contracts/validators/chat-threads";
import {
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import {
  modelSettingsSchema,
  withModelReasoningEffort,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatEvents,
  type ChatEventAttachFileMetadata,
} from "@okouai/db/schema/chat-event";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command, computed } from "ccstate";
import {
  and,
  asc,
  DrizzleQueryError,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  SQL,
  sql,
} from "drizzle-orm";
import { literal, object, uuid, type infer as zInfer } from "zod";
import { alias, PgDialect } from "drizzle-orm/pg-core";
import {
  normalChatInputConditionalValues,
  normalChatInputUpdateSet,
  normalChatInputConflictSql,
  normalChatInputInsertSql,
  normalChatInputPublicationSql,
  normalChatInputWriteGate,
  normalChatInputWritten,
  type NormalChatInputGuard,
  type NormalChatInputWrite,
} from "./normal-chat-input-publication-sql";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { remoteDeviceMode } from "./remote-device-access";
import { normalizeWebUploadContentType } from "../../lib/uploads-constants";
import { buildGenerationTemplatePrompt } from "../../lib/generation-template-prompt";
import { now, nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { waitUntil } from "../context/wait-until";
import { publishThreadListChangedSafely } from "../external/realtime";
import {
  bestEffort,
  joinAll,
  joinAllInOrder,
  safeSync,
  settle,
  settleIncludingAbort,
} from "../utils";
import {
  createAgentRunContextSignals,
  type AgentRunContextSignals,
  preloadAgentRunContext$,
} from "./agent-run-context.signals";
import {
  resolveRunSelectionModel,
  type ModelSelectionBootstrap,
  resolveDefaultModelFirstPin$,
} from "./model-selection.service";
import {
  queuedChatThreadPublicationPlan,
  type PublishedChatThreadLease,
} from "./queued-chat-thread.service";
import {
  measureChatEnqueue,
  ChatEnqueueTimingCollector,
} from "./chat-enqueue-timing.service";

import type { CancelRunResult } from "./agent-run-terminal-transition.service";
import { files as filesTable } from "@okouai/db/schema/file";
import {
  canonicalChatEventContent,
  canonicalChatEventError,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import {
  pendingChatQueueEventFromRow,
  pendingChatQueueEventReadPlan,
} from "./chat-event-queue.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { reportChatEventSideEffect } from "./chat-event-write-side-effects.service";
import {
  normalChatInputContextSql,
  prepareChatEvent,
  prepareChatEventReplacement,
  chatEventInsertSql,
  chatEventReplacementInsertSql,
  chatEventReplacementTargetSchema,
  chatEventReplacementTargetSql,
  requireChatEventReplacementTarget,
  type NewChatEvent,
} from "./chat-event.service";
import type { ChatInputEnqueueCommit } from "./chat-input-enqueue-observation";
import {
  capturedModelReplacement,
  resolveChatInputModelSelection$,
} from "./chat-input-model.service";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import { prepareChatThreadInsert } from "./chat-thread-create.service";
import {
  chatThreadEventInsertSql,
  chatThreadEventInsertPlan,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import {
  PLATFORM_TASK_THREAD_READ_ONLY_MESSAGE,
  isPlatformTaskThread$,
} from "./platform-task-thread.service";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import type { ExistingSendThreadRow } from "./execution-org-member-context.signals";
import {
  chatRunSourceTitleSnapshot,
  hasChatRunSourceAnnotation,
  projectUserMessage,
  repairUserMessageText,
  userMessagePhysicalFiles,
  withChatRunSourceAnnotation,
  type ChatRunSourceAnnotation,
  withServerSourceAnnotation,
} from "./chat-user-message.service";
import {
  workflowRewardQueuedEventInsert,
  workflowRewardSourceEventId,
} from "./workflow-reward-source-publication";
import { env } from "../../lib/env";
import type { ModelCatalog } from "./model-catalog.service";
import { isCatalogCodexServiceTierSupported } from "./model-route-capabilities.service";
import type { ExecutionOrgPlan } from "./execution-org-context.service";
import { selectedUserPresentationTemplateIds } from "./presentation-template-data.service";
import { selectedUserTemplateIds } from "./user-template-data.service";
import {
  shouldDispatchCancelSideEffects,
  dispatchCancelSideEffects$,
} from "./run-cancel.service";
import {
  createPublicArtifactObjectReads,
  resolvedArtifactObject$,
} from "./artifact-storage.service";
import {
  completedPrivateAttachmentSize,
  privateArtifactFromRow,
  readPrivateAttachmentRows,
  type PrivateAttachmentRow,
} from "./private-artifact-storage.service";
import { s3ObjectHead } from "../external/s3";
import { webChatContextId } from "./web-chat-queue-context.service";
/** Canonical ChatEvent write commands. */
export const chatEnqueueTiming$ = computed((get) => {
  return get(route$) === chatEventsContract.send
    ? new ChatEnqueueTimingCollector(get(apiStartTime$))
    : undefined;
});

type SendBody =
  import("@okouai/api-contracts/contracts/chat-event-send").ChatEventSendBody;
interface NormalSendBody {
  readonly prompt: string;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly chatThreadEventId?: string;
  readonly chatThreadSortEventId?: string;
  readonly sourceRunId?: string;
  /** Null selects Auto; omission keeps the thread selection. */
  readonly model?: string | null;
  readonly runOptions?: {
    readonly codexServiceTier?: CodexServiceTier;
    readonly reasoningEffort?: ReasoningEffort;
  };
  readonly userMessage: UserMessageDocument;
  readonly hasTextContent: boolean;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly clientEventId?: string;
  readonly revokesEventId?: string;
  /** Ask the input's run to capture network bodies; gated at run creation. */
  readonly captureNetworkBodies?: boolean;
}
interface RecallSendBody {
  readonly threadId: string;
  readonly revokesEventId: string;
  readonly clientEventId?: string;
}
interface InterruptSendBody {
  readonly threadId: string;
  readonly interruptsRunId: string;
  readonly clientEventId?: string;
}
type OrganizationAuthContext = AuthContext & {
  readonly orgId: string;
};
interface NormalSendRequest {
  readonly enqueueTiming?: ChatEnqueueTimingCollector;
  readonly bootstrap?: NormalSendBootstrap;
  readonly onAcceptedDocument?: (document: UserMessageDocument) => void;
  readonly projectId?: string;
  readonly projectReferences?: EnqueuedChatInputFacts["projectReferences"];
  readonly body: NormalSendBody;
  readonly auth: OrganizationAuthContext;
  readonly userId: string;
  readonly orgId: string;
  readonly skipThreadSortTouch?: boolean;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly getStartedWorkflowId?: string;
  /**
   * The request-scoped plan of the authenticated organization, supplied by a
   * caller inside an auth route whose `orgId` is that organization, so the
   * send and its model selection share one read.
   */
  readonly orgPlanCapabilities?: ExecutionOrgPlan | null;
  /**
   * Route-entry time of `POST /api/chat/events`. A run picked by this request
   * for this input is measured from it; other callers omit it.
   */
  readonly requestReceivedAt?: number;
}
type NormalSendArgs = NormalSendRequest;
type NormalSendFailure =
  | ReturnType<typeof notFound>
  | ReturnType<typeof forbidden>
  | ReturnType<typeof conflict>
  | ReturnType<typeof badRequestMessage>;
/**
 * The send response. A send only enqueues its input and never waits for a
 * run, so `runId` is always null; the key stays for clients that require it.
 * The run, or an `input.rejected` explaining why none started, appears in the
 * thread's event stream.
 */
export interface CreatedChatEventResponse {
  /** Server-side only: whether an earlier send already stored this input. */
  readonly replayed?: boolean;
  readonly status: 201;
  readonly body: {
    readonly threadId: string;
    readonly createdAt: string;
  };
}
type AppendEventResult =
  | {
      readonly ok: true;
      readonly createdAt: Date;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };
type ClientEventIdResolution =
  | {
      readonly kind: "available";
    }
  | {
      readonly kind: "accepted";
      readonly createdAt: Date;
    }
  | {
      readonly kind: "conflict";
    };
const INSUFFICIENT_CREDITS_MARKER = "insufficient_credits";
function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}
function duplicateClientEventIdResponse() {
  return conflict("clientEventId is already in use");
}
function acceptedSendResponse(
  threadId: string,
  createdAt: Date,
  replayed: boolean,
): CreatedChatEventResponse {
  return {
    replayed,
    status: 201,
    body: { threadId, createdAt: createdAt.toISOString() },
  };
}
function normalSendTriggerSource(
  auth: OrganizationAuthContext,
): "web" | "agent" {
  return auth.tokenType === "agent" ? "agent" : "web";
}
const resolveChatRunSourceById$ = command(
  async (
    { get },
    auth: OrganizationAuthContext,
    sourceRunId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly annotation: ChatRunSourceAnnotation | null;
    readonly autonomyBudget: number;
  } | null> => {
    const db = get(db$);
    const [source] = await db
      .select({
        runId: agentRuns.id,
        threadId: chatThreads.id,
        title: chatThreads.title,
        autonomyBudget: agentRuns.autonomyBudget,
      })
      .from(agentRuns)
      .leftJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.orgId, auth.orgId),
          eq(chatThreads.userId, auth.userId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, sourceRunId),
          eq(agentRuns.userId, auth.userId),
          eq(agentRuns.orgId, auth.orgId),
          isNotNull(agentRuns.triggerSource),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!source || source.autonomyBudget === null) {
      return null;
    }
    const annotation =
      source.threadId === null
        ? null
        : {
            runId: source.runId,
            threadId: source.threadId,
            titleSnapshot: chatRunSourceTitleSnapshot(source.title),
          };
    return { annotation, autonomyBudget: source.autonomyBudget };
  },
);
const resolveNormalSendChatRunSource$ = command(
  async (
    { set },
    params: {
      readonly auth: OrganizationAuthContext;
      readonly userMessage: UserMessageDocument;
      readonly sourceRunId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly source: ChatRunSourceAnnotation | null;
        readonly sourceAutonomyBudget: number | null;
      }
    | {
        readonly response: ReturnType<typeof badRequestMessage>;
      }
  > => {
    if (hasChatRunSourceAnnotation(params.userMessage)) {
      return {
        response: badRequestMessage(
          "Forwarded chat references are server-managed",
        ),
      };
    }
    if (params.sourceRunId !== undefined) {
      if (
        params.auth.tokenType === "agent" ||
        params.auth.tokenType === "sandbox"
      ) {
        return {
          response: badRequestMessage(
            "Forward source runs are only accepted from user-authenticated sessions",
          ),
        };
      }
      const resolved = await set(
        resolveChatRunSourceById$,
        params.auth,
        params.sourceRunId,
        signal,
      );
      if (resolved === null) {
        return { response: badRequestMessage("Forward source run not found") };
      }
      if (resolved.annotation === null) {
        return {
          response: badRequestMessage(
            "Forward source run is not linked to a chat thread",
          ),
        };
      }
      return { source: resolved.annotation, sourceAutonomyBudget: null };
    }
    if (params.auth.tokenType !== "agent") {
      return { source: null, sourceAutonomyBudget: null };
    }
    const resolved = await set(
      resolveChatRunSourceById$,
      params.auth,
      params.auth.runId,
      signal,
    );
    if (resolved === null) {
      return { response: badRequestMessage("Source run not found") };
    }
    if (resolved.annotation === null) {
      return {
        response: badRequestMessage(
          "Source run is not linked to a chat thread",
        ),
      };
    }
    return {
      source: resolved.annotation,
      sourceAutonomyBudget: resolved.autonomyBudget,
    };
  },
);
/** A started source resolution; its outcome is observed after authorization. */
type NormalSendChatRunSourceRead = ReturnType<
  typeof settle<
    Awaited<ReturnType<(typeof resolveNormalSendChatRunSource$)["write"]>>
  >
>;
/**
 * Reject a template selection that can never resolve. Only the selection's
 * own syntax is checked here; whether the caller may use an uploaded
 * template is decided when the input is picked, which mounts only the
 * templates the caller may read.
 */
function invalidGenerationTemplateSelection(
  userMessage: UserMessageDocument,
): ReturnType<typeof badRequestMessage> | undefined {
  const { templates } = projectUserMessage(userMessage);
  const mountedUserPresentationTemplateIds =
    selectedUserPresentationTemplateIds(templates);
  for (const template of templates) {
    if (template.type === "custom") {
      continue;
    }
    const validation = buildGenerationTemplatePrompt(template, {
      mountedUserPresentationTemplateIds,
    });
    if (validation.status === "invalid") {
      return badRequestMessage(validation.message);
    }
  }
  return undefined;
}
const resolveClientEventId$ = command(
  async (
    { get },
    params: {
      readonly clientEventId: string;
      readonly orgId: string;
      readonly threadId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<ClientEventIdResolution> => {
    const db = get(db$);
    const [row] = await db
      .select({
        chatThreadId: chatEvents.chatThreadId,
        threadUserId: chatThreads.userId,
        eventType: chatEvents.eventType,
        eventCreatedAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .where(
        and(
          eq(chatEvents.id, params.clientEventId),
          chatThreadOrganizationCondition(params.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return { kind: "available" };
    }
    if (
      row.chatThreadId !== params.threadId ||
      row.threadUserId !== params.userId ||
      row.eventType !== "input.prompt"
    ) {
      return { kind: "conflict" };
    }
    return { kind: "accepted", createdAt: row.eventCreatedAt };
  },
);
function clientEventIdResolutionResponse(
  resolution: ClientEventIdResolution,
  threadId: string,
):
  | CreatedChatEventResponse
  | ReturnType<typeof duplicateClientEventIdResponse>
  | undefined {
  if (resolution.kind === "available") {
    return undefined;
  }
  if (resolution.kind === "conflict") {
    return duplicateClientEventIdResponse();
  }
  return acceptedSendResponse(threadId, resolution.createdAt, true);
}
// MCP returns the accepted input identity, including on retries. A duplicate
// Web send can also acknowledge a collision with another kind of event.
export const readAcceptedChatInputReceipt$ = command(
  async (
    { get, set },
    threadId: string,
    clientEventId: string,
    signal: AbortSignal,
  ) => {
    const { orgId, userId } = get(organizationAuthContext$);
    const resolution = await set(
      resolveClientEventId$,
      { orgId, userId, threadId, clientEventId },
      signal,
    );
    return (
      clientEventIdResolutionResponse(resolution, threadId) ??
      duplicateClientEventIdResponse()
    );
  },
);
function isCancelResult(value: unknown): value is CancelRunResult {
  return (
    typeof value === "object" && value !== null && "alreadyCancelled" in value
  );
}
function isRecallSendBody(
  body: SendBody,
): body is Extract<SendBody, RecallSendBody> {
  return (
    "revokesEventId" in body &&
    body.revokesEventId !== undefined &&
    !("prompt" in body && body.prompt !== undefined)
  );
}
function isInterruptSendBody(
  body: SendBody,
): body is Extract<SendBody, InterruptSendBody> {
  return "interruptsRunId" in body && body.interruptsRunId !== undefined;
}
function isNormalSendBody(
  body: SendBody,
): body is Extract<SendBody, NormalSendBody> {
  return "prompt" in body && body.prompt !== undefined;
}
const ATTACHMENT_METADATA_CONCURRENCY = 4;
type AttachmentRecord = PrivateAttachmentRow;
type PrivateAttachmentRecord = Pick<AttachmentRecord, "id" | "storageKey">;
interface ResolvedChatAttachment {
  readonly file: ChatEventAttachFileMetadata;
  readonly owned: PrivateAttachmentRecord | null;
}
interface AttachmentObject {
  readonly key: string;
  readonly size: number;
  readonly layout: LinkLayout;
  readonly owned: PrivateAttachmentRecord | null;
}
interface AttachmentLookup {
  readonly file: ReturnType<typeof userMessagePhysicalFiles>[number];
  result?: Awaited<ReturnType<typeof settleIncludingAbort<AttachmentObject>>>;
}
function attachmentResolutionCounts(
  files: ReturnType<typeof userMessagePhysicalFiles>,
) {
  return {
    references: files.length,
    unique: 0,
    completedPrivate: 0,
    verifiedPrivate: 0,
    public: 0,
    sqlReads: 0,
    head: 0,
    list: 0,
    contentTypes: [
      ...new Set(
        files.map((file) => {
          return normalizeWebUploadContentType(file.contentType).replace(
            /;.*$/u,
            "",
          );
        }),
      ),
    ].sort(),
  };
}
interface IncomingAttachmentRecords {
  readonly files: ReturnType<typeof userMessagePhysicalFiles>;
  readonly voiceIds: readonly string[];
  readonly rows: ReturnType<
    typeof settleIncludingAbort<Map<string, AttachmentRecord>>
  >;
  readonly counts: ReturnType<typeof attachmentResolutionCounts>;
}
const startIncomingAttachmentRecords$ = command(
  (
    { get },
    userMessage: UserMessageDocument,
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): IncomingAttachmentRecords | undefined => {
    const files = userMessagePhysicalFiles(userMessage);
    const voiceIds = userMessage.parts.flatMap((part) => {
      return part.type === "voice"
        ? part.clips.map((clip) => {
            return clip.fileId;
          })
        : [];
    });
    if (files.length === 0 && voiceIds.length === 0) {
      return undefined;
    }
    const counts = attachmentResolutionCounts(files);
    const rows = settleIncludingAbort(async () => {
      signal.throwIfAborted();
      const fileIds = [
        ...new Set(
          files.flatMap(({ fileId }) => {
            return uuid().safeParse(fileId).success
              ? [fileId.toLowerCase()]
              : [];
          }),
        ),
      ];
      const clipIds = [
        ...new Set(
          voiceIds.map((id) => {
            return id.toLowerCase();
          }),
        ),
      ];
      if (fileIds.length === 0 && clipIds.length === 0) {
        return new Map<string, AttachmentRecord>();
      }
      counts.sqlReads += 1;
      // One statement captures every referenced record together. Binding the
      // UUID array also keeps the parameter count independent of file count.
      const loaded = await readPrivateAttachmentRows(
        get(db$),
        or(
          fileIds.length
            ? sql`${filesTable.id} = ANY(${sql.param(fileIds)}::uuid[])`
            : undefined,
          clipIds.length
            ? and(
                sql`${filesTable.id} = ANY(${sql.param(clipIds)}::uuid[])`,
                eq(filesTable.orgId, owner.orgId),
                eq(filesTable.ownerUserId, owner.userId),
                isNull(filesTable.deletedAt),
              )
            : undefined,
        ),
      );
      signal.throwIfAborted();
      return new Map(
        loaded.map((row) => {
          return [row.id, row];
        }),
      );
    });
    return { files, voiceIds, rows, counts };
  },
);

async function validateIncomingVoiceClips(
  args: { readonly orgId: string; readonly userId: string },
  { voiceIds, rows }: IncomingAttachmentRecords,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const error = voiceClipRequestError(voiceIds);
  if (error) {
    return error;
  }
  const records = await rows;
  signal.throwIfAborted();
  if (!records.ok) {
    throw records.error;
  }
  const voice = resolveVoiceClipRecords(
    { orgId: args.orgId, userId: args.userId, fileIds: voiceIds },
    records.value,
  );
  return "status" in voice ? voice : null;
}

const resolveIncomingAttachmentObject$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly file: AttachmentLookup["file"];
      readonly row: AttachmentRecord | undefined;
      readonly counts: ReturnType<typeof attachmentResolutionCounts>;
      readonly publicReads: ReturnType<typeof createPublicArtifactObjectReads>;
    },
    signal: AbortSignal,
  ): Promise<AttachmentObject> => {
    signal.throwIfAborted();
    const { row, file, counts } = args;
    if (row?.storageKey?.startsWith("private-artifacts/")) {
      const owned = privateArtifactFromRow(row);
      if (
        !owned ||
        owned.userId !== args.userId ||
        owned.orgId !== args.orgId
      ) {
        throw new Error(`User-message attachment not found: ${file.fileId}`);
      }
      const record = { id: row.id, storageKey: row.storageKey };
      const completedSize = completedPrivateAttachmentSize(row);
      if (completedSize !== null) {
        counts.completedPrivate += 1;
        return {
          key: owned.key,
          size: completedSize,
          layout: owned.layout,
          owned: record,
        };
      }
      counts.verifiedPrivate += 1;
      const head = await get(
        s3ObjectHead(owned.bucket, owned.key, counts, signal),
      );
      signal.throwIfAborted();
      if (head.kind === "missing") {
        throw new Error(`User-message attachment not found: ${file.fileId}`);
      }
      if (head.contentLength === undefined) {
        throw new Error(
          `Private artifact ${file.fileId} has no content length`,
        );
      }
      return {
        key: owned.key,
        size: head.contentLength,
        layout: owned.layout,
        owned: record,
      };
    }
    counts.public += 1;
    const object = await set(
      resolvedArtifactObject$,
      {
        userId: args.userId,
        id: file.fileId,
        filenameHint: file.filenameSnapshot,
        reads: args.publicReads,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!object) {
      throw new Error(`User-message attachment not found: ${file.fileId}`);
    }
    return { ...object, owned: null };
  },
);
/**
 * Resolve the stored object behind each attached file. The canonical input
 * asset rows recorded with the input need its key and size, and the lookup is
 * also the ownership check for the file ids the client sent.
 */
const resolveIncomingAttachFileMetadata$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly attachmentRecords: IncomingAttachmentRecords | undefined;
      readonly enqueueTiming?: ChatEnqueueTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<ResolvedChatAttachment[]> => {
    const records = args.attachmentRecords;
    if (!records) {
      args.enqueueTiming?.setAttachmentDetails(attachmentResolutionCounts([]));
      return [];
    }
    const { files, counts } = records;
    const resolved = await settleIncludingAbort(async () => {
      const read = await records.rows;
      signal.throwIfAborted();
      if (!read.ok) {
        throw read.error;
      }
      const rows = read.value;
      const publicReads = createPublicArtifactObjectReads(counts, signal);
      const lookups = new Map<string, AttachmentLookup>();
      const references = files.map((file) => {
        // Public-object resolution uses the filename hint. The request fixes
        // storage configuration and sends no variant; content type is a per-
        // reference snapshot, not a lookup argument. Reuse never crosses sends.
        const owned = rows.get(file.fileId.toLowerCase());
        const key = owned?.storageKey?.startsWith("private-artifacts/")
          ? `private:${owned.id}`
          : JSON.stringify([
              args.userId,
              args.orgId,
              file.fileId,
              file.filenameSnapshot,
            ]);
        let lookup = lookups.get(key);
        if (!lookup) {
          lookup = { file };
          lookups.set(key, lookup);
        }
        return { file, lookup };
      });
      counts.unique = lookups.size;
      const pending = lookups.values();
      let failed = false;
      const resolve = async () => {
        for (const lookup of pending) {
          if (failed || signal.aborted) {
            return;
          }
          lookup.result = await settleIncludingAbort(async () => {
            return await set(
              resolveIncomingAttachmentObject$,
              {
                userId: args.userId,
                orgId: args.orgId,
                file: lookup.file,
                row: rows.get(lookup.file.fileId.toLowerCase()),
                counts,
                publicReads,
              },
              signal,
            );
          });
          if (!lookup.result.ok) {
            failed = true;
            return;
          }
        }
      };
      await joinAll(
        Array.from(
          { length: Math.min(ATTACHMENT_METADATA_CONCURRENCY, lookups.size) },
          resolve,
        ),
      );
      // Cancellation wins; otherwise surface the earliest reference's failure,
      // after joining all started reads. Before a slow failure is observed, up
      // to U - 1 other unique lookups may run, but only four can be active.
      signal.throwIfAborted();
      return references.map(({ file, lookup }) => {
        const result = lookup.result;
        if (!result) {
          throw new Error("Attachment metadata resolution is incomplete");
        }
        if (!result.ok) {
          throw result.error;
        }
        const object = result.value;
        return {
          owned: object.owned,
          file: {
            id: file.fileId,
            filename: file.filenameSnapshot,
            contentType: file.contentType,
            size: object.size,
            objectKey: object.key,
            publicBrand: linkLayoutSegment(object.layout),
          },
        };
      });
    }).finally(() => {
      args.enqueueTiming?.setAttachmentDetails(counts);
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      throw resolved.error;
    }
    return resolved.value;
  },
);
/**
 * The thread's requested settings. The input captures its effective model at
 * enqueue; the pick launches that model after its credit admission.
 */
interface ThreadRunSettings {
  readonly selectedModel: string;
  readonly modelSettings: ModelSettings;
  readonly modelSettingsPatch: ModelSettingsPatch | undefined;
  readonly codexServiceTier: CodexServiceTier | null;
}
interface ThreadComputerAccess {
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
}
function requestedThreadRunSettings(
  catalog: ModelCatalog,
  body: NormalSendBody,
  current: {
    readonly selectedModel: string;
    readonly modelSettings: ModelSettings;
    readonly codexServiceTier: CodexServiceTier | null;
  },
): ThreadRunSettings | ReturnType<typeof badRequestMessage> {
  // An explicit null selects Auto; omission keeps the current selection.
  const selectedModel =
    body.model === undefined
      ? current.selectedModel
      : body.model === null || isAutoSelectedModel(body.model)
        ? AUTO_SELECTED_MODEL
        : body.model;
  const effort = resolveChatReasoningEffort({
    catalog,
    selectedModel,
    modelSettings: current.modelSettings,
    requested: body.runOptions?.reasoningEffort,
  });
  if ("status" in effort) {
    return effort;
  }
  const requestedTier = body.runOptions?.codexServiceTier;
  if (
    requestedTier !== undefined &&
    !isCatalogCodexServiceTierSupported(catalog, selectedModel, requestedTier)
  ) {
    return badRequestMessage(
      requestedTier === "fast"
        ? "Codex fast mode is only available for GPT 5.6 runs"
        : "Ultrafast is unavailable for this model route",
    );
  }
  // A model or run-option selection carries its tier; an effort-only change
  // or a send without selections keeps the thread's stored tier.
  const keepsStoredTier =
    requestedTier === undefined &&
    (body.runOptions?.reasoningEffort !== undefined ||
      (body.model === undefined && body.runOptions === undefined));
  const codexServiceTier = keepsStoredTier
    ? current.codexServiceTier
    : (requestedTier ?? null);
  return {
    selectedModel,
    modelSettings: effort.modelSettings,
    modelSettingsPatch: effort.modelSettingsPatch,
    codexServiceTier,
  };
}
/**
 * Apply the send's explicit Computer Use or cloud browser selection. Only an
 * explicitly selected host is looked up: it is written to the thread, so it
 * must belong to the caller. The pick re-checks the thread's host.
 */
const requestedThreadComputerAccess$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly body: NormalSendBody;
      readonly current: ThreadComputerAccess;
    },
    signal: AbortSignal,
  ): Promise<ThreadComputerAccess | ReturnType<typeof notFound>> => {
    const db = set(writeDb$);
    const explicitHost = Object.prototype.hasOwnProperty.call(
      params.body,
      "computerUseHostId",
    );
    const explicitCloudBrowser = Object.prototype.hasOwnProperty.call(
      params.body,
      "cloudBrowserEnabled",
    );
    if (!explicitHost && !explicitCloudBrowser) {
      return {
        computerUseHostId: params.current.computerUseHostId,
        cloudBrowserEnabled: params.current.cloudBrowserEnabled,
      };
    }
    const cloudBrowserEnabled = explicitCloudBrowser
      ? (params.body.cloudBrowserEnabled ?? false)
      : params.current.cloudBrowserEnabled;
    const requestedHostId = explicitHost
      ? (params.body.computerUseHostId ?? null)
      : params.current.computerUseHostId;
    if (explicitCloudBrowser && cloudBrowserEnabled) {
      return { computerUseHostId: null, cloudBrowserEnabled: true };
    }
    if (!requestedHostId) {
      return { computerUseHostId: null, cloudBrowserEnabled };
    }
    if (!explicitHost) {
      return { computerUseHostId: requestedHostId, cloudBrowserEnabled: false };
    }
    const [host] = await db
      .select({ id: computerUseHosts.id })
      .from(computerUseHosts)
      .where(
        and(
          eq(computerUseHosts.id, requestedHostId),
          sql`NOT ${remoteDeviceMode(params)}`,
          eq(computerUseHosts.orgId, params.orgId),
          eq(computerUseHosts.userId, params.userId),
          isNull(computerUseHosts.revokedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!host) {
      return notFound("Computer-use host not found");
    }
    return { computerUseHostId: host.id, cloudBrowserEnabled: false };
  },
);
interface ExistingSendThread {
  readonly kind: "existing";
  readonly threadId: string;
  readonly runSettings: ThreadRunSettings;
  readonly computerAccess: ThreadComputerAccess;
  readonly current: ThreadRunSettings & ThreadComputerAccess;
  /** The replaced model the input's captured successor rewrites. */
  readonly replacedModel?: string;
}
interface NewSendThread {
  readonly kind: "new";
  readonly threadId: string;
  readonly clientThreadId: string | undefined;
  readonly runSettings: ThreadRunSettings;
  readonly computerAccess: ThreadComputerAccess;
}
type SendThread = ExistingSendThread | NewSendThread;

function normalSendInputFacts(
  args: NormalSendArgs,
  chatThreadId: string,
  event: Pick<EnqueuedChatInputFacts, "id" | "userMessage" | "modelSelection">,
  sourceAutonomyBudget: number | null,
): EnqueuedChatInputFacts {
  return {
    orgId: args.orgId,
    chatThreadId,
    userId: args.userId,
    id: event.id,
    userMessage: event.userMessage,
    modelSelection: event.modelSelection,
    requiredOfficialWorkflowIds: args.requiredOfficialWorkflowIds,
    captureNetworkBodies: Boolean(args.body.captureNetworkBodies),
    ...(args.projectReferences?.length
      ? { projectReferences: args.projectReferences }
      : {}),
    ...(sourceAutonomyBudget === null ? {} : { sourceAutonomyBudget }),
    ...(args.requestReceivedAt === undefined
      ? {}
      : { requestReceivedAt: args.requestReceivedAt }),
    ...(args.enqueueTiming
      ? { enqueueObservationId: args.enqueueTiming.observationId }
      : {}),
  };
}
async function readCapturedComputerAccess(
  captured: ReturnType<
    typeof settleIncludingAbort<
      ThreadComputerAccess | ReturnType<typeof notFound>
    >
  >,
  signal: AbortSignal,
) {
  const result = await captured;
  signal.throwIfAborted();
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

const resolveSendThread$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly body: NormalSendBody;
      readonly catalog: ModelCatalog;
      readonly existing?: {
        readonly thread: ExistingSendThreadRow;
      };
      readonly orgPlanCapabilities: ExecutionOrgPlan | null | undefined;
      readonly modelBootstrap: ModelSelectionBootstrap;
      readonly host?: Parameters<typeof readCapturedComputerAccess>[0];
      readonly context: AgentRunContextSignals;
    },
    signal: AbortSignal,
  ): Promise<SendThread | NormalSendFailure> => {
    const member = { orgId: args.orgId, userId: args.userId };
    if (args.existing) {
      const current = {
        ...args.existing.thread,
        modelSettings: modelSettingsSchema.parse(
          args.existing.thread.modelSettings,
        ),
        modelSettingsPatch: undefined,
      };
      const runSettings = requestedThreadRunSettings(
        args.catalog,
        args.body,
        current,
      );
      if ("status" in runSettings) {
        return runSettings;
      }
      const computerAccess = args.host
        ? await readCapturedComputerAccess(args.host, signal)
        : await set(
            requestedThreadComputerAccess$,
            { ...member, body: args.body, current },
            signal,
          );
      if ("status" in computerAccess) {
        return computerAccess;
      }
      return {
        kind: "existing",
        threadId: args.existing.thread.id,
        runSettings,
        computerAccess,
        current,
      };
    }
    if (args.body.revokesEventId !== undefined) {
      return badRequestMessage("Recommended follow-up is no longer available");
    }
    const initialModel =
      args.body.model === undefined
        ? await set(
            resolveDefaultModelFirstPin$,
            {
              ...member,
              orgPlanCapabilities: args.orgPlanCapabilities,
              modelBootstrap: args.modelBootstrap,
            },
            signal,
          )
        : null;
    const memberMetadata = await get(args.context.memberMetadata$);
    signal.throwIfAborted();
    const defaults = {
      modelSettings: modelSettingsSchema.parse(
        memberMetadata.preferences?.modelSettings ?? {},
      ),
      cloudBrowserEnabled:
        memberMetadata.preferences?.cloudBrowserEnabledByDefault ?? true,
    };
    const runSettings = requestedThreadRunSettings(args.catalog, args.body, {
      selectedModel: initialModel?.selectedModel ?? AUTO_SELECTED_MODEL,
      modelSettings: defaults.modelSettings,
      codexServiceTier:
        initialModel?.serviceTier === "priority" ? "fast" : null,
    });
    if ("status" in runSettings) {
      return runSettings;
    }
    const computerAccess = args.host
      ? await readCapturedComputerAccess(args.host, signal)
      : await set(
          requestedThreadComputerAccess$,
          {
            ...member,
            body: args.body,
            current: {
              computerUseHostId: null,
              cloudBrowserEnabled:
                args.body.computerUseHostId === undefined &&
                defaults.cloudBrowserEnabled,
            },
          },
          signal,
        );
    if ("status" in computerAccess) {
      return computerAccess;
    }
    return {
      kind: "new",
      threadId: args.body.clientThreadId ?? args.context.chatThreadId,
      clientThreadId: args.body.clientThreadId,
      runSettings,
      computerAccess,
    };
  },
);
/**
 * A stored or requested selection of a replaced model is written as the
 * successor its input captured, so the thread, its event and the run agree.
 */
function withCapturedModelReplacement(
  catalog: ModelCatalog,
  thread: SendThread,
  modelSelection: ChatInputModelSelection,
): SendThread {
  const { runSettings } = thread;
  const successor = capturedModelReplacement(
    catalog,
    runSettings.selectedModel,
    modelSelection,
  );
  if (successor === null || runSettings.selectedModel === null) {
    return thread;
  }
  const replacedModel = runSettings.selectedModel;
  const patch = runSettings.modelSettingsPatch;
  const modelSettingsPatch =
    patch === undefined ? undefined : { ...patch, model: successor };
  return {
    ...thread,
    ...(thread.kind === "existing" ? { replacedModel } : {}),
    runSettings: {
      selectedModel: successor,
      modelSettings: modelSettingsPatch
        ? withModelReasoningEffort(
            runSettings.modelSettings,
            modelSettingsPatch,
          )
        : runSettings.modelSettings,
      modelSettingsPatch,
      codexServiceTier: modelSelection.codexServiceTier,
    },
  };
}
/**
 * Prepare the send's changed thread selections and their projection events.
 * A send without `model` that rewrites a replaced stored selection writes its
 * model, effort and tier only while the thread still stores the replaced
 * model (`replacement`), so a concurrent model change wins and keeps its own
 * events; the send's other selections are written regardless.
 */
function existingSendThreadUpdatePlan(
  args: NormalSendArgs,
  thread: SendThread,
) {
  if (thread.kind === "new") {
    return null;
  }
  const { runSettings, computerAccess, current } = thread;
  const selectedModel = runSettings.selectedModel;
  const codexServiceTier = runSettings.codexServiceTier;
  const patch = runSettings.modelSettingsPatch;
  const modelChanged =
    selectedModel !== current.selectedModel ||
    (patch !== undefined &&
      current.modelSettings[patch.model]?.effort !== patch.effort);
  const tierChanged = codexServiceTier !== current.codexServiceTier;
  const accessChanged =
    computerAccess.computerUseHostId !== current.computerUseHostId ||
    computerAccess.cloudBrowserEnabled !== current.cloudBrowserEnabled;
  if (!modelChanged && !tierChanged && !accessChanged) {
    return null;
  }
  const updatedAt = nowDate();
  const event = {
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.threadId,
    createdAt: updatedAt,
  };
  const modelEvents: Parameters<typeof chatThreadEventInsertSql>[0][] = [];
  if (modelChanged) {
    modelEvents.push({
      ...event,
      kind: "model_selection_updated",
      selectedModel,
      modelSettingsPatch: runSettings.modelSettingsPatch,
    });
  }
  if (tierChanged) {
    modelEvents.push({
      ...event,
      kind: "service_tier_updated",
      serviceTier: chatThreadServiceTierFromCodex(codexServiceTier),
    });
  }
  const modelValues = {
    ...(modelChanged ? { selectedModel } : {}),
    // Merge the effort into the stored settings rather than writing the
    // snapshot back, so a concurrent send's effort for another model stays.
    ...(patch === undefined
      ? {}
      : {
          modelSettings: sql`${chatThreads.modelSettings} || jsonb_build_object(
            cast(${patch.model} as text),
            COALESCE(${chatThreads.modelSettings} -> cast(${patch.model} as text), '{}'::jsonb)
              || jsonb_build_object('effort', cast(${patch.effort} as text))
          )`,
        }),
    ...(tierChanged ? { codexServiceTier } : {}),
  };
  const accessEvents: Parameters<typeof chatThreadEventInsertSql>[0][] =
    accessChanged
      ? [{ ...event, kind: "computer_use_host_updated", ...computerAccess }]
      : [];
  const replacedModel =
    args.body.model === undefined ? thread.replacedModel : undefined;
  if (replacedModel !== undefined) {
    return {
      replacement: {
        replacedModel,
        values: { ...modelValues, updatedAt },
        events: modelEvents,
      },
      values: accessChanged ? { ...computerAccess, updatedAt } : null,
      events: accessEvents,
    };
  }
  return {
    replacement: null,
    values: {
      ...modelValues,
      ...(accessChanged ? computerAccess : {}),
      updatedAt,
    },
    events: [...modelEvents, ...accessEvents],
  };
}
/** An explicit model selection also becomes the member's default for new chats. */
function userModelPreferencePlan(
  args: NormalSendArgs,
  runSettings: ThreadRunSettings,
) {
  if (args.body.model === undefined) {
    return null;
  }
  // The captured selection: a replaced model is stored as its successor.
  const selectedModel = runSettings.selectedModel;
  // Ultrafast is scoped to this conversation.
  const serviceTier: "priority" | null =
    runSettings.codexServiceTier === "fast" ? "priority" : null;
  const patch = runSettings.modelSettingsPatch;
  const nowValue = nowDate();
  return {
    values: {
      orgId: args.orgId,
      userId: args.userId,
      selectedModel,
      serviceTier,
      ...(patch === undefined
        ? {}
        : { modelSettings: { [patch.model]: { effort: patch.effort } } }),
      createdAt: nowValue,
      updatedAt: nowValue,
    },
    conflict: {
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedModel,
        serviceTier,
        ...(patch === undefined
          ? {}
          : {
              modelSettings: sql`${orgMembersMetadata.modelSettings} || jsonb_build_object(
                cast(${patch.model} as text),
                COALESCE(${orgMembersMetadata.modelSettings} -> cast(${patch.model} as text), '{}'::jsonb)
                  || jsonb_build_object('effort', cast(${patch.effort} as text))
              )`,
            }),
        updatedAt: nowValue,
      },
    },
  };
}
/** Reject a server-owned Official Workflow claim that cannot be authoritative. */
function assertOfficialSourceClaim(
  args: Pick<NormalSendArgs, "auth" | "requiredOfficialWorkflowIds">,
  chatRunSource: ChatRunSourceAnnotation | null,
): void {
  if (args.requiredOfficialWorkflowIds?.length === 0) {
    throw new Error("Official Workflow source claim cannot be empty");
  }
  if (
    args.requiredOfficialWorkflowIds !== undefined &&
    normalSendTriggerSource(args.auth) === "agent" &&
    chatRunSource === null
  ) {
    throw new Error("Official agent queue source is missing its source Run");
  }
}
/**
 * The stored prompt: an agent-sourced send carries its source Run annotation;
 * an MCP send carries its source part.
 */
function normalSendUserMessage(
  args: NormalSendArgs,
  chatRunSource: ChatRunSourceAnnotation | null,
): UserMessageDocument {
  const userMessage = repairUserMessageText(args.body.userMessage);
  if (chatRunSource !== null) {
    return withChatRunSourceAnnotation(userMessage, chatRunSource);
  }
  return args.auth.tokenType !== "oauth"
    ? userMessage
    : withServerSourceAnnotation(userMessage, {
        type: "source",
        kind: "mcp",
        clientId: args.auth.clientId,
      });
}
/**
 * An ordinary input's ID conflict is accepted as a duplicate without a lookup.
 * Follow-ups can also conflict on their revoke edge, so their caller-supplied
 * identities are resolved separately after publication loses a race.
 */
function normalSendEvent(params: {
  readonly modelSelection: ChatInputModelSelection;
  readonly id: string;
  readonly threadId: string;
  readonly userMessage: UserMessageDocument;
  readonly triggerSource: "web" | "agent";
  readonly chatRunSource: ChatRunSourceAnnotation | null;
  readonly requiredOfficialWorkflowIds: readonly string[] | undefined;
}): Extract<
  NewChatEvent,
  {
    readonly eventType: "input.prompt";
  }
> & {
  readonly id: string;
  readonly modelSelection: ChatInputModelSelection;
} {
  return {
    id: params.id,
    chatThreadId: params.threadId,
    eventType: "input.prompt",
    modelSelection: params.modelSelection,
    userMessage: params.userMessage,
    runId: null,
    ...(params.requiredOfficialWorkflowIds === undefined
      ? {}
      : {
          requiredOfficialWorkflowIds: params.requiredOfficialWorkflowIds,
        }),
    ...(params.triggerSource === "web"
      ? {
          contextType: "web",
          contextId: webChatContextId(),
        }
      : {}),
    ...(params.triggerSource === "agent" && params.chatRunSource
      ? params.requiredOfficialWorkflowIds === undefined
        ? {
            agentRunContext: {
              sourceRunId: params.chatRunSource.runId,
              sourceChatThreadId: params.chatRunSource.threadId,
            },
          }
        : {
            contextType: "agent_run",
            contextId: webChatContextId(),
          }
      : {}),
  };
}
/**
 * Rolls back a new thread's enqueue transaction when its row or its first
 * input already exists, so a lost race never leaves an empty thread.
 */
class NewThreadSendCollision extends Error {
  constructor(readonly collision: "thread" | "input") {
    super("A new-thread send collided with an existing thread or input");
  }
}
const resolveNewThreadSendCollision$ = command(
  async (
    { get, set },
    args: NormalSendArgs,
    thread: NewSendThread,
    collision: "thread" | "input",
    signal: AbortSignal,
  ): Promise<CreatedChatEventResponse | NormalSendFailure> => {
    const db = get(db$);
    if (args.body.clientEventId !== undefined) {
      const prior = clientEventIdResolutionResponse(
        await set(
          resolveClientEventId$,
          {
            clientEventId: args.body.clientEventId,
            orgId: args.orgId,
            threadId: thread.threadId,
            userId: args.userId,
          },
          signal,
        ),
        thread.threadId,
      );
      if (prior) {
        return prior;
      }
    }
    if (collision === "input") {
      return duplicateClientEventIdResponse();
    }
    const [existing] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, thread.threadId),
          eq(chatThreads.userId, args.userId),
          chatThreadOrganizationCondition(args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!existing) {
      return notFound("Chat thread not found");
    }
    // A client that retries its first send without a client event id is
    // settled by the thread's first input.
    const [firstInput] = await db
      .select({ id: chatEvents.id, createdAt: chatEvents.createdAt })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, thread.threadId),
          chatEventTypeIn(["input.prompt"]),
          isNull(chatEvents.revokesEventId),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(1);
    signal.throwIfAborted();
    if (!firstInput) {
      return badRequestMessage("Client thread id is already in use");
    }
    return acceptedSendResponse(thread.threadId, firstInput.createdAt, true);
  },
);
/**
 * The enqueue transaction's input write: a new thread's minimal row, the
 * entry-owned context row, the run-less `input.prompt`, the thread and member
 * selections it carries, and its attachment references. Returns null when an
 * existing thread already has this input.
 */
function newSendThreadInsertPlan(args: NormalSendArgs, thread: NewSendThread) {
  return prepareChatThreadInsert({
    orgId: args.orgId,
    id: thread.threadId,
    userId: args.userId,
    title: null,
    projectId: args.projectId,
    selectedModel: thread.runSettings.selectedModel,
    codexServiceTier: thread.runSettings.codexServiceTier,
    modelSettings: thread.runSettings.modelSettings,
    computerUseHostId: thread.computerAccess.computerUseHostId,
    cloudBrowserEnabled: thread.computerAccess.cloudBrowserEnabled,
  });
}

interface NormalSendInput {
  readonly chatRunSource: ChatRunSourceAnnotation | null;
  readonly sourceAutonomyBudget: number | null;
  readonly thread: SendThread;
  readonly event: ReturnType<typeof normalSendEvent>;
  readonly attachFileMetadata: readonly ResolvedChatAttachment[];
  /** The follow-up captured by an existing thread's revocation check. */
  readonly replacementTarget: NormalReplacementTarget | undefined;
}

/** Prepare ordinary write facts without capturing the transaction owner. */
function normalSendInputPlan(args: NormalSendArgs, input: NormalSendInput) {
  const { thread, event } = input;
  const existing = existingSendThreadUpdatePlan(args, thread);
  const threadCondition = and(
    eq(chatThreads.id, thread.threadId),
    eq(chatThreads.userId, args.userId),
  );
  return {
    thread,
    event,
    relationSource:
      args.auth.tokenType === "agent" ? input.chatRunSource : null,
    queueInput: { chatThreadId: thread.threadId, orgId: args.orgId },
    replacementTarget: input.replacementTarget,
    existingPlan: existing && {
      ...existing,
      where: threadCondition,
      replacement: existing.replacement && {
        ...existing.replacement,
        where: and(
          threadCondition,
          eq(chatThreads.selectedModel, existing.replacement.replacedModel),
        ),
      },
    },
    preferencePlan: userModelPreferencePlan(args, thread.runSettings),
    attachments: input.attachFileMetadata,
  };
}

const normalSendPublicationRowSchema = object({
  id: uuid().nullable(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema.nullable(),
  claimId: uuid().nullable(),
  claimExpiresAt: pgTimestampWithoutTimezoneToDateSchema.nullable(),
  queuedAt: pgTimestampWithoutTimezoneToDateSchema.nullable(),
  atomicGuard: literal(0),
});
interface NormalSendPublicationFailure {
  readonly token: string;
  readonly error: unknown;
}
function normalSendFailureToken(suffix: string) {
  return "__TX0091_V1_" + suffix + "__";
}
function normalSendPublicationFailure(
  error: unknown,
  failures: readonly NormalSendPublicationFailure[],
): unknown {
  if (
    !(error instanceof DrizzleQueryError) ||
    !(error.cause instanceof Error) ||
    !("code" in error.cause) ||
    error.cause.code !== "22P02"
  ) {
    return error;
  }
  const match =
    /invalid input syntax for type integer: "(__TX0091_V1_[A-Z0-9_]+__)"$/.exec(
      error.cause.message,
    );
  if (!match) {
    return error;
  }
  if (match[1] === normalSendFailureToken("THREAD")) {
    return new NewThreadSendCollision("thread");
  }
  if (match[1] === normalSendFailureToken("INPUT")) {
    return new NewThreadSendCollision("input");
  }
  const failure = failures.find((entry) => {
    return entry.token === match[1];
  });
  return failure ? failure.error : error;
}

function normalSendThreadPublication(
  input: ReturnType<typeof normalSendInputPlan>,
  after?: string,
) {
  const existing = input.existingPlan;
  if (!existing) {
    return null;
  }
  const { replacement } = existing;
  const lockCondition = existing.values ? existing.where : replacement?.where;
  if (!lockCondition) {
    throw new Error("Normal chat input has no thread update predicate");
  }
  const dialect = new PgDialect();
  const ordinary = existing.values ?? {};
  const conditional = replacement
    ? normalChatInputConditionalValues(
        chatThreads,
        replacement.values,
        sql`(SELECT can_replace FROM normal_send_thread_lock)`,
      )
    : {};
  const values = { ...conditional, ...ordinary };
  const lock = sql`SELECT ${chatThreads.id} AS id,
    ${replacement ? replacement.where : sql`false`} AS can_replace
    FROM ${chatThreads} WHERE ${lockCondition} AND ${normalChatInputWriteGate(after)} FOR UPDATE`;
  const set = normalChatInputUpdateSet(chatThreads, values);
  const write = dialect.buildUpdateQuery({
    table: chatThreads,
    set,
    joins: [],
    where: sql`${chatThreads.id} IN (SELECT id FROM normal_send_thread_lock)`,
    returning: [{ path: ["id"], field: chatThreads.id }],
  });
  return {
    lock,
    write,
    listEvents: [
      ...(replacement?.events ?? []).map((event) => {
        return {
          insertion: chatThreadEventInsertPlan(event).insertion,
          gate: sql`${normalChatInputWriteGate("normal_send_thread_write")} AND EXISTS (SELECT 1 FROM normal_send_thread_lock WHERE can_replace)`,
        };
      }),
      ...existing.events.map((event) => {
        return {
          insertion: chatThreadEventInsertPlan(event).insertion,
          gate: normalChatInputWriteGate("normal_send_thread_write"),
        };
      }),
    ],
  };
}

function normalSendCreatedListEvent(
  args: NormalSendArgs,
  input: ReturnType<typeof normalSendInputPlan>,
) {
  const thread = input.thread;
  if (thread.kind !== "new") {
    return null;
  }
  const plan = newSendThreadInsertPlan(args, thread);
  const values = plan.values;
  if (
    values.modelSettings instanceof SQL ||
    values.cloudBrowserEnabled instanceof SQL
  ) {
    throw new Error(
      "Normal chat input requires explicit prepared thread settings",
    );
  }
  return chatThreadEventInsertPlan({
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.threadId,
    eventId: args.body.chatThreadEventId,
    projectId: args.projectId,
    title: null,
    hidden: values.hidden,
    selectedModel: values.selectedModel,
    modelSettings: modelSettingsSchema.parse(values.modelSettings),
    serviceTier: chatThreadServiceTierFromCodex(values.codexServiceTier),
    computerUseHostId: values.computerUseHostId,
    cloudBrowserEnabled: values.cloudBrowserEnabled,
  });
}

function normalSendPublicAssetWrite(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly file: {
      readonly id: string;
      readonly objectKey: string;
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
    };
  },
  gate: SQL,
) {
  const id = uuid().safeParse(args.file.id).success
    ? args.file.id
    : createHash("sha256")
        .update(
          JSON.stringify(["web-input-v2", args.userId, args.file.objectKey]),
        )
        .digest()
        .subarray(0, 16)
        .toString("hex")
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, "$1-$2-$3-$4-$5");
  return normalChatInputInsertSql(
    filesTable,
    {
      id,
      orgId: args.orgId,
      ownerUserId: args.userId,
      storageKey: args.file.objectKey,
      filename: args.file.filename,
      contentType: args.file.contentType,
      sizeBytes: args.file.size,
      origin: "user",
    },
    gate,
    sql`(id) DO NOTHING`,
  );
}

type NormalInputPlan = ReturnType<typeof normalSendInputPlan>;
type NormalPreparedEvent =
  | { readonly ok: true; readonly value: ReturnType<typeof prepareChatEvent> }
  | { readonly ok: false; readonly error: unknown };
function prepareNormalPublicationEvent(
  event: NormalInputPlan["event"],
  target: readonly zInfer<typeof chatEventReplacementTargetSchema>[] | null,
): NormalPreparedEvent {
  const result = safeSync(() => {
    return target === null
      ? prepareChatEvent(event)
      : prepareChatEventReplacement(
          requireChatEventReplacementTarget(target),
          event,
        );
  });
  return "ok" in result
    ? { ok: true, value: result.ok }
    : { ok: false, error: result.error };
}
function normalSendBasePublication(
  args: NormalSendArgs,
  input: NormalInputPlan,
  target: readonly zInfer<typeof chatEventReplacementTargetSchema>[] | null,
) {
  const { thread, event } = input;
  const prepared = prepareNormalPublicationEvent(event, target);
  const guards: NormalChatInputGuard[] = [];
  const failures: NormalSendPublicationFailure[] = [];
  if (thread.kind === "new") {
    guards.push({
      condition: sql`NOT EXISTS (SELECT 1 FROM normal_send_thread)`,
      token: normalSendFailureToken("THREAD"),
    });
  }
  if (!prepared.ok) {
    const token = normalSendFailureToken("EVENT");
    failures.push({ token, error: prepared.error });
    guards.push({ condition: sql`true`, token });
  }
  if (thread.kind === "new") {
    guards.push({
      condition: sql`NOT (${normalChatInputWritten})`,
      token: normalSendFailureToken("INPUT"),
    });
  }
  const resultToken = normalSendFailureToken("RESULT");
  guards.push({
    condition: sql`EXISTS (SELECT 1 FROM inserted WHERE seq_id > 9007199254740991 OR seq_id < -9007199254740991)`,
    token: resultToken,
  });
  failures.push({
    token: resultToken,
    error: new Error(
      "Normal chat input sequence exceeds the safe integer boundary",
    ),
  });
  const context = normalChatInputContextSql(event, normalChatInputWritten);
  const threadPublication = normalSendThreadPublication(
    input,
    context ? "normal_send_context" : undefined,
  );
  const createdPlan =
    thread.kind === "new" ? newSendThreadInsertPlan(args, thread) : null;
  const createdList = normalSendCreatedListEvent(args, input);
  const listEvents = createdList
    ? [
        {
          insertion: createdList.insertion,
          gate: sql`EXISTS (SELECT 1 FROM normal_send_thread)`,
        },
      ]
    : (threadPublication?.listEvents ?? []);
  let after = context ? "normal_send_context" : undefined;
  if (threadPublication) {
    after = listEvents.length
      ? "normal_send_list_event_" + (listEvents.length - 1)
      : "normal_send_thread_write";
  }
  return {
    prepared,
    guards,
    failures,
    context,
    threadPublication,
    createdPlan,
    listEvents,
    after,
  };
}
function normalSendSelectionWrites(
  args: NormalSendArgs,
  input: NormalInputPlan,
  previous?: string,
) {
  const { thread, event, preferencePlan } = input;
  const writes: NormalChatInputWrite[] = [];
  let after = previous;
  if (args.body.captureNetworkBodies) {
    writes.push({
      name: "normal_send_capture",
      statement: normalChatInputInsertSql(
        chatNetworkBodyCaptures,
        { chatEventId: event.id, chatThreadId: thread.threadId },
        normalChatInputWriteGate(after),
        sql`(chat_event_id) DO NOTHING`,
      ),
    });
    after = "normal_send_capture";
  }
  if (preferencePlan) {
    writes.push({
      name: "normal_send_preference",
      statement: normalChatInputInsertSql(
        orgMembersMetadata,
        preferencePlan.values,
        normalChatInputWriteGate(after),
        normalChatInputConflictSql(
          orgMembersMetadata,
          preferencePlan.conflict.target,
          preferencePlan.conflict.set,
        ),
      ),
    });
    after = "normal_send_preference";
  }
  return { writes, after };
}
function normalSendAssetWrites(
  args: NormalSendArgs,
  input: NormalInputPlan,
  previous?: string,
) {
  const writes: NormalChatInputWrite[] = [];
  const guards: NormalChatInputGuard[] = [];
  const failures: NormalSendPublicationFailure[] = [];
  const seen = new Set<string>();
  let after = previous;
  for (const [index, { file, owned }] of input.attachments.entries()) {
    const id = owned?.id ?? file.id;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const owner = {
      chatThreadId: input.thread.threadId,
      userId: args.userId,
      orgId: args.orgId,
      file,
    };
    const name = "normal_send_asset_" + index;
    const gate = normalChatInputWriteGate(after);
    if (!owned) {
      writes.push({
        name,
        statement: normalSendPublicAssetWrite(owner, gate),
      });
    } else {
      // Only a pending private attachment needs size/content-type completion.
      writes.push({
        name,
        statement: new PgDialect().buildUpdateQuery({
          table: filesTable,
          set: normalChatInputUpdateSet(filesTable, {
            contentType: file.contentType,
            sizeBytes: file.size,
          }),
          joins: [],
          where: and(
            eq(filesTable.id, owned.id),
            eq(filesTable.ownerUserId, owner.userId),
            eq(filesTable.orgId, owner.orgId),
            isNull(filesTable.deletedAt),
            isNull(filesTable.sizeBytes),
            eq(filesTable.storageKey, file.objectKey),
            gate,
          ),
          returning: [{ path: ["id"], field: filesTable.id }],
        }),
      });
    }
    after = name;
  }
  return { writes, guards, failures, after };
}
function normalSendFinalWrites(
  args: NormalSendArgs,
  input: NormalInputPlan,
  claimId: string,
  previous?: string,
) {
  const event = input.event;
  const writes: NormalChatInputWrite[] = [];
  let after = previous;
  if (args.getStartedWorkflowId) {
    writes.push({
      name: "normal_send_workflow_source",
      statement: workflowRewardQueuedEventInsert(
        {
          orgId: args.orgId,
          userId: args.userId,
          workflowId: args.getStartedWorkflowId,
          sourceEventId: event.id,
          occurredAt: nowDate(),
          environment: env("ENV"),
        },
        normalChatInputWriteGate(after),
      ),
    });
    after = "normal_send_workflow_source";
  }
  const queue = queuedChatThreadPublicationPlan({
    ...input.queueInput,
    claimId,
  });
  writes.push({
    name: "normal_send_queue",
    statement: normalChatInputInsertSql(
      queuedChatThreads,
      queue.values,
      normalChatInputWriteGate(after),
      normalChatInputConflictSql(
        queuedChatThreads,
        [queue.conflict.target],
        queue.conflict.set,
      ),
      sql`claim_id, claim_expires_at, queued_at`,
    ),
  });
  return writes;
}
function normalSendPreparedPublication(
  args: NormalSendArgs,
  input: NormalInputPlan,
  target: readonly zInfer<typeof chatEventReplacementTargetSchema>[] | null,
  claimId: string,
) {
  const thread = input.thread;
  const base = normalSendBasePublication(args, input, target);
  const selection = normalSendSelectionWrites(args, input, base.after);
  const assets = normalSendAssetWrites(args, input, selection.after);
  const source = input.relationSource;
  const relation =
    source && source.threadId !== thread.threadId
      ? {
          orgId: args.orgId,
          userId: args.userId,
          threadId: source.threadId,
          runId: source.runId,
          createsThread: thread.kind === "new",
        }
      : undefined;
  return {
    createdPlan: base.createdPlan,
    failures: [...base.failures, ...assets.failures],
    plan: {
      orgId: args.orgId,
      userId: args.userId,
      row: base.prepared.ok ? base.prepared.value.row : undefined,
      conflict: target === null ? ("id" as const) : ("any" as const),
      relation,
      context: base.context ?? undefined,
      threadLock: base.threadPublication?.lock,
      threadWrite: base.threadPublication?.write,
      listEvents: base.listEvents,
      writes: [
        ...selection.writes,
        ...assets.writes,
        ...normalSendFinalWrites(args, input, claimId, assets.after),
      ],
      guards: [...base.guards, ...assets.guards],
    },
  };
}
const appendNormalSendInput$ = command(
  async (
    { set },
    args: NormalSendArgs,
    input: NormalInputPlan,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // An existing thread's follow-up was captured by its revocation check and
    // chat events are immutable, so only a new thread's revocation reads here.
    const target =
      input.replacementTarget === undefined
        ? args.body.revokesEventId
          ? parseRawRows(
              chatEventReplacementTargetSchema,
              await db.execute(
                chatEventReplacementTargetSql(args.body.revokesEventId),
              ),
            )
          : null
        : [input.replacementTarget];
    signal.throwIfAborted();
    const claimId = randomUUID();
    const prepared = normalSendPreparedPublication(
      args,
      input,
      target,
      claimId,
    );
    const created = prepared.createdPlan;
    const query = normalChatInputPublicationSql({
      ...prepared.plan,
      newThread: created
        ? normalChatInputInsertSql(
            chatThreads,
            created.values,
            sql`true`,
            sql`DO NOTHING`,
          )
        : undefined,
    });
    const rows = await (async () => {
      const result = await settle(
        (async () => {
          return parseRawRows(
            normalSendPublicationRowSchema,
            await db.execute(query),
          );
        })(),
      );
      if (!result.ok) {
        throw normalSendPublicationFailure(result.error, prepared.failures);
      }
      return result.value;
    })();
    signal.throwIfAborted();
    const row = rows[0];
    if (!row) {
      throw new Error("Normal chat input publication result is missing");
    }
    if (row.id === null) {
      return null;
    }
    if (row.createdAt === null) {
      throw new Error("Normal chat input publication is incomplete");
    }
    const enqueueCommit = { eventId: row.id, committedAt: now() };
    let publishedLease: PublishedChatThreadLease | undefined;
    if (row.claimId === claimId) {
      if (row.claimExpiresAt === null || row.queuedAt === null) {
        throw new Error("Normal chat publication lease receipt is incomplete");
      }
      publishedLease = {
        ...input.queueInput,
        userId: args.userId,
        claimId: row.claimId,
        claimExpiresAt: row.claimExpiresAt,
        queuedAt: row.queuedAt,
      };
    }
    return {
      createdAt: row.createdAt,
      enqueueCommit,
      publishedLease,
      marketingRewardEventId: args.getStartedWorkflowId
        ? workflowRewardSourceEventId("queued", row.id)
        : null,
    };
  },
);

const normalSendThreadTouch$ = command(
  async (
    { set },
    args: NormalSendArgs,
    thread: SendThread,
    touchedAt: Date,
    signal: AbortSignal,
  ): Promise<void> => {
    if (thread.kind === "new" || args.skipThreadSortTouch) {
      return;
    }
    const startedAt = performance.now();
    const result = await settleIncludingAbort(
      set(
        touchSentChatThreadSort$,
        {
          userId: args.userId,
          orgId: args.orgId,
          threadId: thread.threadId,
          touchedAt,
          eventId: args.body.chatThreadSortEventId,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "thread_touch",
      thread.threadId,
      startedAt,
      result,
    );
  },
);
const publishEnqueuedNormalSend$ = command(
  async (
    { set },
    input: {
      readonly args: NormalSendArgs;
      readonly thread: SendThread;
      readonly touchedAt: Date;
      readonly enqueueCommit?: ChatInputEnqueueCommit;
      readonly publishedLease?: PublishedChatThreadLease;
      readonly context: AgentRunContextSignals;
      readonly requestInput: EnqueuedChatInputFacts;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const {
      args,
      thread,
      touchedAt,
      enqueueCommit,
      publishedLease,
      context,
      requestInput,
    } = input;
    const hostChanged =
      thread.kind === "existing" &&
      thread.computerAccess.computerUseHostId !==
        thread.current.computerUseHostId;
    const picked = await settle(
      set(
        pickEnqueuedChatThread$,
        {
          orgId: args.orgId,
          chatThreadId: thread.threadId,
          ...(enqueueCommit ? { enqueueCommit } : {}),
          ...(publishedLease ? { publishedLease } : {}),
          context,
          requestInput,
          ...(hostChanged
            ? { computerUseHostChangedForUserId: args.userId }
            : {}),
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    // The pick reobserves active Runs after publication. A busy thread returns
    // none so its running Run is notified; a launch consumes the input and an
    // idle thread at full organization capacity leaves it queued.
    const claimed =
      picked.ok &&
      (picked.value.kind === "launched" || picked.value.kind === "org-full");
    if (!claimed) {
      waitUntil(
        set(notifyRunningChatRunOfPendingInput$, thread.threadId, signal),
      );
    }
    await set(normalSendThreadTouch$, args, thread, touchedAt, signal);
    signal.throwIfAborted();
    await set(
      publishChatThreadMessageCreated$,
      {
        userId: args.userId,
        orgId: args.orgId,
        threadId: thread.threadId,
      },
      signal,
    );
    signal.throwIfAborted();
    await publishThreadListChangedSafely({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    if (args.body.clientEventId !== undefined) {
      await bestEffort(
        set(
          notifyBrowserUserActionCallback$,
          {
            userId: args.userId,
            threadId: thread.threadId,
            eventId: args.body.clientEventId,
          },
          signal,
        ),
        signal,
      );
    }
    if (!picked.ok) {
      throw picked.error;
    }
  },
);
const readNormalSendAttachments$ = command(
  (
    { get, set },
    args: Pick<NormalSendArgs, "userId" | "orgId" | "enqueueTiming"> & {
      readonly context: AgentRunContextSignals;
    },
    prefetch:
      | {
          readonly authorize: NormalSendBootstrap["authorize"];
          readonly records: IncomingAttachmentRecords;
        }
      | undefined,
    signal: AbortSignal,
  ) => {
    return settleIncludingAbort(async () => {
      if (prefetch) {
        const authorization = await prefetch.authorize;
        signal.throwIfAborted();
        if (!authorization.ok || "status" in authorization.value) {
          return [];
        }
        // Capture member settings before object I/O can delay the send.
        await get(args.context.memberMetadata$);
        signal.throwIfAborted();
      }
      return measureChatEnqueue(args.enqueueTiming, "attachments", () => {
        return set(
          resolveIncomingAttachFileMetadata$,
          {
            userId: args.userId,
            orgId: args.orgId,
            enqueueTiming: args.enqueueTiming,
            attachmentRecords: prefetch?.records,
          },
          signal,
        );
      });
    });
  },
);
type NormalSendAttachmentRead = ReturnType<
  (typeof readNormalSendAttachments$)["write"]
>;

interface NormalSendAttachmentPreparation {
  readonly result: NormalSendAttachmentRead;
  readonly finish: () => void;
}

const prepareNormalSendInput$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly body: NormalSendBody;
      readonly thread: SendThread;
      readonly catalog: ModelCatalog;
      readonly orgPlanCapabilities: ExecutionOrgPlan | null | undefined;
      readonly modelBootstrap: ModelSelectionBootstrap;
      readonly attachments: NormalSendAttachmentRead;
      readonly enqueueTiming?: ChatEnqueueTimingCollector;
    },
    signal: AbortSignal,
  ) => {
    const model = measureChatEnqueue(
      args.enqueueTiming,
      "model_capture",
      async () => {
        return await set(
          resolveChatInputModelSelection$,
          {
            orgId: args.orgId,
            userId: args.userId,
            ...args.thread.runSettings,
            reasoningEffort: args.body.runOptions?.reasoningEffort,
            orgPlanCapabilities: args.orgPlanCapabilities,
            catalog: args.catalog,
            modelBootstrap: args.modelBootstrap,
          },
          signal,
        );
      },
    );
    const [attachments, modelSelection] = await joinAllInOrder(
      [
        (async () => {
          const attachments = await args.attachments;
          if (!attachments.ok) {
            throw attachments.error;
          }
          return attachments.value;
        })(),
        model,
      ],
      signal,
    );
    signal.throwIfAborted();
    if ("status" in modelSelection) {
      return modelSelection;
    }
    return {
      attachFileMetadata: attachments,
      modelSelection,
      thread: withCapturedModelReplacement(
        args.catalog,
        args.thread,
        modelSelection,
      ),
    };
  },
);
function preparedNormalSendEvent(
  args: NormalSendArgs,
  threadId: string,
  modelSelection: Parameters<typeof normalSendEvent>[0]["modelSelection"],
  chatRunSource: ChatRunSourceAnnotation | null,
  inputId: string,
) {
  return normalSendEvent({
    modelSelection,
    id: inputId,
    threadId: threadId,
    userMessage: normalSendUserMessage(args, chatRunSource),
    triggerSource: normalSendTriggerSource(args.auth),
    chatRunSource,
    requiredOfficialWorkflowIds: args.requiredOfficialWorkflowIds,
  });
}
/**
 * Direct send, shared by the web, the CLI, and MCP: authorize the agent and
 * thread, validate a follow-up revocation, record attachment references, then
 * enqueue the input (creating a new thread's minimal row in the same
 * transaction) and schedule its pick without waiting for it. The model is
 * captured at enqueue. The pick resolves credit admission, the autonomy
 * budget, templates, session, and context and publishes rejections as
 * `input.rejected`. The direct message's sidebar touch runs after the pick.
 */
function settledNormalSendResponse(
  body: NormalSendBody,
  threadId: string,
  createdAt: Date | null,
) {
  if (createdAt === null) {
    // Caller-supplied follow-up IDs resolve their receipt before this fast
    // path. A server-generated ID cannot collide on its ID, so a follow-up
    // conflict here is the revoke edge taken concurrently.
    return body.revokesEventId && body.clientEventId === undefined
      ? conflict("Recommended follow-up has already been used")
      : acceptedSendResponse(threadId, nowDate(), true);
  }
  return acceptedSendResponse(threadId, createdAt, false);
}
function followupRevokerResponse(
  threadId: string,
  clientEventId: string | undefined,
  revoker: { readonly id: string; readonly createdAt: Date },
) {
  // PostgreSQL returns UUIDs in lowercase.
  return revoker.id === clientEventId?.toLowerCase()
    ? acceptedSendResponse(threadId, revoker.createdAt, true)
    : conflict("Recommended follow-up has already been used");
}
const resolveFollowupPublicationConflict$ = command(
  async (
    { get },
    params: {
      readonly threadId: string;
      readonly revokesEventId: string;
      readonly clientEventId: string;
    },
    signal: AbortSignal,
  ) => {
    // The insert may have waited for a concurrent winner. Read the committed
    // revoker in a fresh statement after the conflict has settled.
    const [revoker] = await get(db$)
      .select({ id: chatEvents.id, createdAt: chatEvents.createdAt })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, params.threadId),
          eq(chatEvents.revokesEventId, params.revokesEventId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return revoker
      ? followupRevokerResponse(params.threadId, params.clientEventId, revoker)
      : duplicateClientEventIdResponse();
  },
);
const prepareNormalSendModels$ = command(
  async ({ get }, context: AgentRunContextSignals, signal: AbortSignal) => {
    const [orgModels, memberModels, memberMetadata, featureSwitchContext] =
      await Promise.all([
        get(context.modelFacts$),
        get(context.memberModels$),
        get(context.memberMetadata$),
        get(context.featureSwitches$),
      ]);
    signal.throwIfAborted();
    return {
      orgModels,
      modelBootstrap: {
        org: orgModels,
        member: memberModels,
        memberMetadata,
        featureSwitchContext,
      },
    };
  },
);

function forgedMcpSource(body: NormalSendBody): boolean {
  return body.userMessage.parts.some((part) => {
    return part.type === "source" && part.kind === "mcp";
  });
}

const startNormalSendRevocation$ = command(
  (
    { set },
    args: {
      readonly body: NormalSendBody;
      readonly existingThread: Promise<ExistingSendThreadRow | null>;
      readonly enqueueTiming?: ChatEnqueueTimingCollector;
    },
    signal: AbortSignal,
  ) => {
    return settleIncludingAbort(async () => {
      const existing = await args.existingThread;
      signal.throwIfAborted();
      if (!existing) {
        return undefined;
      }
      return await measureChatEnqueue(
        args.enqueueTiming,
        "followup_validation",
        () => {
          return set(
            validateNormalRevocationTarget$,
            {
              threadId: existing.id,
              revokesEventId: args.body.revokesEventId,
              clientEventId: args.body.clientEventId,
            },
            signal,
          );
        },
      );
    });
  },
);

interface NormalSendBootstrap {
  readonly context: AgentRunContextSignals;
  readonly existingThread: Promise<ExistingSendThreadRow | null> | undefined;
  readonly inputId: string;
  readonly authorize: ReturnType<
    (typeof prepareNormalSendAuthorization$)["write"]
  >;
  readonly attachments?: NormalSendAttachmentPreparation;
  readonly host?: Parameters<typeof readCapturedComputerAccess>[0];
  readonly revocation?: ReturnType<
    (typeof startNormalSendRevocation$)["write"]
  >;
}

const prepareNormalSendAuthorization$ = command(
  (
    _context,
    args: Pick<
      NormalSendArgs,
      "auth" | "body" | "requiredOfficialWorkflowIds"
    > & {
      readonly existingThread:
        Promise<ExistingSendThreadRow | null> | undefined;
      readonly chatRunSource: NormalSendChatRunSourceRead;
      readonly attachmentRecords: IncomingAttachmentRecords | undefined;
    },
    signal: AbortSignal,
  ) => {
    return settleIncludingAbort(async () => {
      const { chatRunSource, attachmentRecords } = args;
      const existing = await args.existingThread;
      signal.throwIfAborted();
      if (args.body.threadId !== undefined && !existing) {
        return notFound("Chat thread not found");
      }
      const resolvedSource = await chatRunSource;
      signal.throwIfAborted();
      if (existing?.isPlatformTaskThread) {
        return forbidden(PLATFORM_TASK_THREAD_READ_ONLY_MESSAGE);
      }
      if (!resolvedSource.ok) {
        throw resolvedSource.error;
      }
      const source = resolvedSource.value;
      if ("response" in source) {
        return source.response;
      }
      assertOfficialSourceClaim(args, source.source);
      const invalidTemplate = invalidGenerationTemplateSelection(
        args.body.userMessage,
      );
      if (invalidTemplate) {
        return invalidTemplate;
      }
      if (attachmentRecords?.voiceIds.length) {
        const voiceError = await validateIncomingVoiceClips(
          args.auth,
          attachmentRecords,
          signal,
        );
        signal.throwIfAborted();
        if (voiceError) {
          return voiceError;
        }
      }
      return {
        chatRunSource: source.source,
        sourceAutonomyBudget: source.sourceAutonomyBudget,
      };
    });
  },
);

const startNormalSendAttachmentPreparation$ = command(
  (
    { set },
    args: Pick<
      NormalSendArgs,
      "auth" | "body" | "requiredOfficialWorkflowIds" | "enqueueTiming"
    > & {
      readonly chatRunSource: NormalSendChatRunSourceRead;
      readonly existingThread:
        Promise<ExistingSendThreadRow | null> | undefined;
      readonly context: AgentRunContextSignals;
    },
    signal: AbortSignal,
  ) => {
    const attachmentRecords = set(
      startIncomingAttachmentRecords$,
      args.body.userMessage,
      args.auth,
      signal,
    );
    const authorize = set(
      prepareNormalSendAuthorization$,
      { ...args, attachmentRecords },
      signal,
    );
    waitUntil(authorize);
    if (!attachmentRecords) {
      return { authorize, attachments: undefined };
    }
    waitUntil(attachmentRecords.rows);
    const stop = new AbortController();
    let finished = false;
    const result = set(
      readNormalSendAttachments$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        context: args.context,
        enqueueTiming: args.enqueueTiming,
      },
      { authorize, records: attachmentRecords },
      AbortSignal.any([signal, stop.signal]),
    ).finally(() => {
      finished = true;
    });
    return {
      authorize,
      attachments: {
        result,
        finish() {
          if (!finished) {
            // An early exit cancels speculative I/O and retains its cleanup.
            stop.abort();
            waitUntil(result);
          }
        },
      },
    };
  },
);

const startNormalSendReads$ = command(
  (
    { get, set },
    args: {
      readonly auth: OrganizationAuthContext;
      readonly body: NormalSendBody;
      readonly requireVisibleThread?: boolean;
      readonly enqueueTiming?: ChatEnqueueTimingCollector;
      readonly requiredOfficialWorkflowIds?: readonly string[];
    },
    signal: AbortSignal,
  ): NormalSendBootstrap => {
    signal.throwIfAborted();
    const { body, auth } = args;
    // Shared input and template reads match PostgreSQL's canonical UUID form.
    const inputId = body.clientEventId?.toLowerCase() ?? randomUUID();
    const templates = projectUserMessage(body.userMessage).templates;
    const presentationIds = selectedUserPresentationTemplateIds(templates);
    const userTemplateIds = selectedUserTemplateIds(templates);
    const graph = createAgentRunContextSignals(
      {
        userId: auth.userId,
        orgId: auth.orgId,
        chatThreadId: body.threadId ?? body.clientThreadId ?? randomUUID(),
      },
      {
        inputId,
        newThread: body.threadId === undefined,
        requireVisibleThread: args.requireVisibleThread,
        presentationIds,
        userTemplateIds,
      },
    );
    const { context } = graph;
    const existingThread =
      body.threadId === undefined ? undefined : get(graph.existingThread$);
    waitUntil(settle(get(context.modelFacts$)));
    waitUntil(settle(get(context.memberMetadata$)));
    waitUntil(settle(get(context.executionPackageSources$)));
    waitUntil(
      settle(
        (async () => {
          if (existingThread && !(await existingThread)) {
            return;
          }
          signal.throwIfAborted();
          await get(context.catalog$);
        })(),
      ),
    );
    if (presentationIds.length || userTemplateIds.length) {
      waitUntil(settle(get(context.requestTemplateSources$)));
    }
    // A forwarded or agent-token send also awaits its source Run. The read is
    // scoped to the caller's user and organization, and its outcome is used
    // only after authorization.
    const chatRunSource = settle(
      set(
        resolveNormalSendChatRunSource$,
        {
          auth,
          userMessage: body.userMessage,
          sourceRunId: body.sourceRunId,
        },
        signal,
      ),
    );
    waitUntil(chatRunSource);
    const attachmentPreparation = set(
      startNormalSendAttachmentPreparation$,
      { ...args, context, existingThread, chatRunSource },
      signal,
    );
    const host =
      body.computerUseHostId && body.cloudBrowserEnabled !== true
        ? settleIncludingAbort(() => {
            return set(
              requestedThreadComputerAccess$,
              {
                orgId: auth.orgId,
                userId: auth.userId,
                body,
                current: {
                  computerUseHostId: null,
                  cloudBrowserEnabled: false,
                },
              },
              signal,
            );
          })
        : undefined;
    if (host) {
      waitUntil(host);
    }
    const revocation =
      existingThread && body.revokesEventId
        ? set(
            startNormalSendRevocation$,
            {
              body,
              existingThread,
              enqueueTiming: args.enqueueTiming,
            },
            signal,
          )
        : undefined;
    if (revocation) {
      waitUntil(revocation);
    }
    return {
      context,
      existingThread,
      inputId,
      ...attachmentPreparation,
      host,
      revocation,
    };
  },
);

export const startNormalSendBootstrap$ = command(
  (
    { set },
    args: {
      readonly auth: OrganizationAuthContext;
      readonly body: SendBody;
      readonly requireVisibleThread?: boolean;
      readonly enqueueTiming?: ChatEnqueueTimingCollector;
    },
    signal: AbortSignal,
  ) => {
    const { body } = args;
    if (
      !isNormalSendBody(body) ||
      isInterruptSendBody(body) ||
      forgedMcpSource(body)
    ) {
      return undefined;
    }
    return set(startNormalSendReads$, { ...args, body }, signal);
  },
);

const prepareNormalSendContext$ = command(
  async (
    { set },
    request: NormalSendRequest,
    bootstrap: NormalSendBootstrap,
    signal: AbortSignal,
  ) => {
    const {
      context,
      existingThread,
      inputId,
      authorize,
      attachments,
      host,
      revocation,
    } = bootstrap;
    const args = request;
    const models = settle(set(prepareNormalSendModels$, context, signal));
    waitUntil(models);
    const existing = await existingThread;
    signal.throwIfAborted();
    if (request.body.threadId === undefined || existing) {
      set(preloadAgentRunContext$, context, signal);
    }
    const authorization = await authorize;
    signal.throwIfAborted();
    if (!authorization.ok) {
      throw authorization.error;
    }
    const prepared = authorization.value;
    if ("status" in prepared) {
      return prepared;
    }
    return {
      ...prepared,
      models,
      args,
      context,
      existing,
      inputId,
      attachments: attachments?.result,
      revocation,
      host,
    };
  },
);
type AuthorizedNormalSendContext = Exclude<
  Awaited<ReturnType<(typeof prepareNormalSendContext$)["write"]>>,
  { readonly status: number }
>;

const captureSendModels$ = command(
  async (
    { get },
    authorized: AuthorizedNormalSendContext,
    attachments: NormalSendAttachmentRead,
    signal: AbortSignal,
  ) => {
    const catalog = (await get(authorized.context.modelFacts$)).catalog;
    signal.throwIfAborted();
    const model = authorized.args.body.model;
    if (
      typeof model === "string" &&
      model !== AUTO_SELECTED_MODEL &&
      resolveRunSelectionModel(catalog, model) === null
    ) {
      return badRequestMessage(`Unknown model "${model}"`);
    }
    const capturedModels = await authorized.models;
    signal.throwIfAborted();
    if (!capturedModels.ok) {
      throw capturedModels.error;
    }
    return { ...authorized, ...capturedModels.value, catalog, attachments };
  },
);

const publishPreparedNormalSend$ = command(
  async (
    { set },
    args: NormalSendArgs,
    publication: {
      readonly input: NormalSendInput;
      readonly context: AgentRunContextSignals;
    },
    signal: AbortSignal,
  ) => {
    const { thread, event } = publication.input;
    const { context } = publication;
    const committed = await set(
      appendNormalSendInput$,
      args,
      normalSendInputPlan(args, publication.input),
      signal,
    );
    if (committed === null) {
      return null;
    }
    const { createdAt, enqueueCommit, publishedLease } = committed;
    args.enqueueTiming?.committed(enqueueCommit.committedAt);
    // Schedule before observing abort; touch, realtime and the running-run
    // notice follow this pick's outcome.
    waitUntil(
      set(
        publishEnqueuedNormalSend$,
        {
          args,
          thread,
          touchedAt: createdAt,
          ...(enqueueCommit ? { enqueueCommit } : {}),
          ...(publishedLease ? { publishedLease } : {}),
          context,
          requestInput: normalSendInputFacts(
            args,
            thread.threadId,
            event,
            event.agentRunContext === undefined
              ? null
              : publication.input.sourceAutonomyBudget,
          ),
        },
        signal,
      ),
    );
    return {
      createdAt,
      marketingRewardEventId: committed.marketingRewardEventId,
    };
  },
);

const resolveFailedNormalSend$ = command(
  async (
    { set },
    args: NormalSendArgs,
    thread: SendThread,
    error: unknown,
    signal: AbortSignal,
  ) => {
    if (thread.kind === "new" && error instanceof NewThreadSendCollision) {
      return await set(
        resolveNewThreadSendCollision$,
        args,
        thread,
        error.collision,
        signal,
      );
    }
    if (
      args.projectId &&
      isForeignKeyViolation(error, "chat_threads_project_owner_fk")
    ) {
      return notFound("Project not found");
    }
    throw error;
  },
);

const prepareNormalSendPublicationInput$ = command(
  async ({ set }, request: NormalSendRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    let bootstrap = request.bootstrap;
    const preparation = settleIncludingAbort(async () => {
      const prepared = await measureChatEnqueue(
        request.enqueueTiming,
        "context_ready",
        async () => {
          if (forgedMcpSource(request.body)) {
            return badRequestMessage(
              "MCP source annotations are server-managed",
            );
          }
          bootstrap ??= set(startNormalSendReads$, request, signal);
          const authorized = await set(
            prepareNormalSendContext$,
            request,
            bootstrap,
            signal,
          );
          signal.throwIfAborted();
          if ("status" in authorized) {
            return authorized;
          }
          const attachments =
            authorized.attachments ??
            set(
              readNormalSendAttachments$,
              {
                orgId: request.orgId,
                userId: request.userId,
                enqueueTiming: request.enqueueTiming,
                context: authorized.context,
              },
              undefined,
              signal,
            );
          return set(captureSendModels$, authorized, attachments, signal);
        },
      );
      signal.throwIfAborted();
      if ("status" in prepared) {
        return prepared;
      }
      const { args, existing, catalog, orgModels, modelBootstrap, context } =
        prepared;
      const resolvedThread = await measureChatEnqueue(
        args.enqueueTiming,
        "thread_selection",
        async () => {
          return await set(
            resolveSendThread$,
            {
              ...args,
              orgPlanCapabilities: orgModels.capabilities,
              catalog,
              modelBootstrap,
              context,
              host: prepared.host,
              existing: existing ? { thread: existing } : undefined,
            },
            signal,
          );
        },
      );
      signal.throwIfAborted();
      if ("status" in resolvedThread) {
        return resolvedThread;
      }
      const checkedRevocation = await prepared.revocation;
      signal.throwIfAborted();
      if (checkedRevocation && !checkedRevocation.ok) {
        throw checkedRevocation.error;
      }
      const revocation = checkedRevocation?.value;
      if (revocation && "status" in revocation) {
        return revocation;
      }
      const input = await set(
        prepareNormalSendInput$,
        {
          ...args,
          thread: resolvedThread,
          orgPlanCapabilities: orgModels.capabilities,
          catalog,
          modelBootstrap,
          attachments: prepared.attachments,
        },
        signal,
      );
      if ("status" in input) {
        return input;
      }
      const { attachFileMetadata, modelSelection, thread } = input;
      const event = preparedNormalSendEvent(
        args,
        thread.threadId,
        modelSelection,
        prepared.chatRunSource,
        prepared.inputId,
      );
      return {
        args,
        thread,
        publication: {
          input: {
            thread,
            event,
            attachFileMetadata,
            chatRunSource: prepared.chatRunSource,
            sourceAutonomyBudget: prepared.sourceAutonomyBudget,
            replacementTarget: revocation?.replacementTarget,
          },
          context,
        },
      };
    });
    const result = await (request.bootstrap
      ? preparation
      : preparation.finally(() => {
          bootstrap?.attachments?.finish();
        }));
    signal.throwIfAborted();
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  },
);

export const sendNormalEvent$ = command(
  async (
    { set },
    request: NormalSendRequest,
    signal: AbortSignal,
  ): Promise<CreatedChatEventResponse | NormalSendFailure> => {
    const prepared = await set(
      prepareNormalSendPublicationInput$,
      request,
      signal,
    );
    signal.throwIfAborted();
    if ("status" in prepared) {
      return prepared;
    }
    const { args, thread, publication } = prepared;
    const enqueued = await settle(
      measureChatEnqueue(args.enqueueTiming, "publication", async () => {
        return await set(publishPreparedNormalSend$, args, publication, signal);
      }),
      signal,
    );
    if (!enqueued.ok) {
      return await set(
        resolveFailedNormalSend$,
        args,
        thread,
        enqueued.error,
        signal,
      );
    }
    const accepted = enqueued.value;
    if (
      accepted === null &&
      args.body.revokesEventId &&
      args.body.clientEventId !== undefined
    ) {
      return await set(
        resolveFollowupPublicationConflict$,
        {
          clientEventId: args.body.clientEventId,
          threadId: thread.threadId,
          revokesEventId: args.body.revokesEventId,
        },
        signal,
      );
    }
    if (accepted) {
      args.onAcceptedDocument?.(publication.input.event.userMessage);
    }
    if (accepted?.marketingRewardEventId) {
      const delivery = {
        jobId: accepted.marketingRewardEventId,
        handlerVersion: 4 as const,
      };
      waitUntil(set(deliverMarketingRewardEvents$, delivery, signal));
    }
    return settledNormalSendResponse(
      args.body,
      thread.threadId,
      accepted?.createdAt ?? null,
    );
  },
);
function recallChatEventValues(params: {
  readonly threadId: string;
  readonly clientEventId: string | undefined;
}): Extract<NewChatEvent, { readonly eventType: "control.revoke" }> {
  return {
    ...(params.clientEventId ? { id: params.clientEventId } : {}),
    chatThreadId: params.threadId,
    eventType: "control.revoke",
    runId: null,
    content: null,
  };
}

const recallRejected = Object.freeze({
  ok: false,
  message: "Only queued user messages can be recalled",
} satisfies Extract<AppendEventResult, { readonly ok: false }>);

function existingRecallEventResult(revoker: {
  readonly eventType: string;
  readonly content: string | null;
  readonly createdAt: Date;
}): AppendEventResult {
  if (revoker.eventType === "control.revoke" && revoker.content === null) {
    return { ok: true, createdAt: revoker.createdAt };
  }
  return recallRejected;
}

export const appendRecallChatEvent$ = command(
  async (
    { set },
    params: {
      readonly threadId: string;
      readonly revokesEventId: string;
      readonly clientEventId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<AppendEventResult> => {
    const db = set(writeDb$);
    const pendingTargetArgs = {
      chatThreadId: params.threadId,
      eventId: params.revokesEventId,
    };
    const pendingTarget = await (async () => {
      const plan = pendingChatQueueEventReadPlan(pendingTargetArgs);
      const [event] = await db
        .select(plan.columns)
        .from(chatEvents)
        .where(plan.condition)
        .limit(1);
      return pendingChatQueueEventFromRow(event);
    })();
    signal.throwIfAborted();
    const wasPending =
      pendingTarget?.eventType === "input.prompt" ||
      pendingTarget?.eventType === "input.automation";
    const [existingRevoker] = await db
      .select({
        eventType: chatEvents.eventType,
        content: canonicalChatEventContent(),
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, params.threadId),
          eq(chatEvents.revokesEventId, params.revokesEventId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (existingRevoker) {
      return existingRecallEventResult(existingRevoker);
    }
    const [target] = await db
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
        eventType: chatEvents.eventType,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
        modelSelection: canonicalChatInputModelSelection(),
        error: canonicalChatEventError(),
        revokesEventId: chatEvents.revokesEventId,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, params.revokesEventId),
          eq(chatEvents.chatThreadId, params.threadId),
          chatEventTypeIn([
            "input.prompt",
            "input.automation",
            "input.rejected",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !target ||
      (!wasPending && target.error !== INSUFFICIENT_CREDITS_MARKER) ||
      (target.revokesEventId !== null &&
        target.error !== INSUFFICIENT_CREDITS_MARKER)
    ) {
      if (wasPending) {
        throw new Error("Queued message is not recallable");
      }
      const [exists] = await db
        .select({ id: chatEvents.id })
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.id, params.revokesEventId),
            eq(chatEvents.chatThreadId, params.threadId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!exists) {
        // Older queue-first recalls deleted the message row, so a repeated
        // request can still find nothing during rollout.
        return { ok: true, createdAt: nowDate() };
      }
      return recallRejected;
    }
    const [inserted] = parseRawRows(
      chatEventCommandResultSchema,
      await db.execute(
        chatEventReplacementInsertSql(target, recallChatEventValues(params)),
      ),
    );
    signal.throwIfAborted();
    if (inserted) {
      return { ok: true, createdAt: inserted.createdAt };
    }
    const [resolved] = await db
      .select({ createdAt: chatEvents.createdAt })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, params.threadId),
          eq(chatEvents.revokesEventId, params.revokesEventId),
          chatEventTypeIn(["control.revoke"]),
          isNull(canonicalChatEventContent()),
          isNull(canonicalChatEventError()),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!resolved) {
      // A concurrent claim or rejection won the revoke edge.
      return recallRejected;
    }
    return { ok: true, createdAt: resolved.createdAt };
  },
);
type NormalReplacementTarget = zInfer<typeof chatEventReplacementTargetSchema>;
/** An unused follow-up, reused by the publication instead of re-read. */
interface NormalRevocationTarget {
  readonly replacementTarget: NormalReplacementTarget;
}
const validateNormalRevocationTarget$ = command(
  async (
    { get },
    params: {
      readonly threadId: string;
      readonly revokesEventId: string | undefined;
      readonly clientEventId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    | NormalSendFailure
    | CreatedChatEventResponse
    | NormalRevocationTarget
    | undefined
  > => {
    const db = get(db$);
    if (!params.revokesEventId) {
      return undefined;
    }
    // One statement reads the follow-up, its replacement projection and any
    // input that already revoked it.
    const revoker = alias(chatEvents, "followup_revoker");
    const existingRevoker = db
      .select({ id: revoker.id, createdAt: revoker.createdAt })
      .from(revoker)
      .where(
        and(
          eq(revoker.chatThreadId, params.threadId),
          eq(revoker.revokesEventId, params.revokesEventId),
        ),
      )
      .limit(1)
      .as("followup_existing_revoker");
    const [target] = await db
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
        eventType: chatEvents.eventType,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
        modelSelection: canonicalChatInputModelSelection(),
        content: canonicalChatEventContent(),
        existingRevoker: {
          id: existingRevoker.id,
          createdAt: existingRevoker.createdAt,
        },
      })
      .from(chatEvents)
      .leftJoinLateral(existingRevoker, sql`true`)
      .where(
        and(
          eq(chatEvents.id, params.revokesEventId),
          eq(chatEvents.chatThreadId, params.threadId),
          chatEventTypeIn(["output.followups"]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!target || resolveChatEventRecommendedFollowups(target).length === 0) {
      return badRequestMessage("Recommended follow-up is no longer available");
    }
    if (target.existingRevoker) {
      return followupRevokerResponse(
        params.threadId,
        params.clientEventId,
        target.existingRevoker,
      );
    }
    // The publication's unique revokes index still guards single use.
    return {
      replacementTarget: {
        id: target.id,
        chatThreadId: target.chatThreadId,
        createdAt: target.createdAt,
        eventType: target.eventType,
        contextType: target.contextType,
        contextId: target.contextId,
        modelSelection: target.modelSelection,
      },
    };
  },
);
export const appendInterruptUserMessage$ = command(
  async (
    { set },
    params: {
      readonly threadId: string;
      readonly interruptsRunId: string;
      readonly clientEventId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<AppendEventResult> => {
    const db = set(writeDb$);
    const [existingInterrupter] = await db
      .select({
        eventType: chatEvents.eventType,
        content: canonicalChatEventContent(),
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, params.threadId),
          eq(chatEvents.runId, params.interruptsRunId),
          chatEventTypeIn(["control.interrupt"]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (existingInterrupter) {
      if (
        existingInterrupter.eventType === "control.interrupt" &&
        existingInterrupter.content === null
      ) {
        return { ok: true, createdAt: existingInterrupter.createdAt };
      }
      return {
        ok: false,
        message: "Only active chat runs can be interrupted",
      };
    }
    const [targetRun] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.interruptsRunId),
          eq(agentRuns.chatThreadId, params.threadId),
          inArray(agentRuns.status, ["pending", "running"]),
          isNotNull(agentRuns.triggerSource),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!targetRun) {
      return {
        ok: false,
        message: "Only active chat runs can be interrupted",
      };
    }
    const inserted =
      parseRawRows(
        chatEventCommandResultSchema,
        await db.execute(
          chatEventInsertSql(
            {
              ...(params.clientEventId ? { id: params.clientEventId } : {}),
              chatThreadId: params.threadId,
              eventType: "control.interrupt",
              content: null,
              interruptsRunId: params.interruptsRunId,
            },
            "any",
          ),
        ),
      )[0] ?? null;
    signal.throwIfAborted();
    if (inserted) {
      return { ok: true, createdAt: inserted.createdAt };
    }
    const [resolved] = await db
      .select({ createdAt: chatEvents.createdAt })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, params.threadId),
          eq(chatEvents.runId, params.interruptsRunId),
          chatEventTypeIn(["control.interrupt"]),
          isNull(canonicalChatEventContent()),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!resolved) {
      return { ok: false, message: "Failed to insert interrupt user message" };
    }
    return { ok: true, createdAt: resolved.createdAt };
  },
);

const assertOwnedThread$ = command(
  async (
    { get, set },
    threadId: string,
    userId: string,
    orgId: string,
    signal: AbortSignal,
  ): Promise<
    ReturnType<typeof notFound> | ReturnType<typeof forbidden> | undefined
  > => {
    const db = get(db$);
    const [thread] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, userId),
          chatThreadOrganizationCondition(orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return notFound("Chat thread not found");
    }
    if (await set(isPlatformTaskThread$, { threadId, orgId, userId }, signal)) {
      return forbidden(PLATFORM_TASK_THREAD_READ_ONLY_MESSAGE);
    }
    return undefined;
  },
);
export const recallChatEvent$ = command(
  async ({ get, set }, body: RecallSendBody, signal: AbortSignal) => {
    const { userId, orgId } = get(organizationAuthContext$);
    const ownership = await set(
      assertOwnedThread$,
      body.threadId,
      userId,
      orgId,
      signal,
    );
    signal.throwIfAborted();
    if (ownership) {
      return ownership;
    }
    const result = await set(
      appendRecallChatEvent$,
      {
        threadId: body.threadId,
        revokesEventId: body.revokesEventId,
        clientEventId: body.clientEventId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      return badRequestMessage(result.message);
    }
    waitUntil(
      set(
        projectCommittedChatThreadSearch$,
        {
          userId,
          orgId,
          threadId: body.threadId,
        },
        signal,
      ),
    );
    await set(
      publishChatThreadMessageCreated$,
      {
        userId,
        orgId,
        threadId: body.threadId,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 201 as const,
      body: {
        threadId: body.threadId,
        createdAt: result.createdAt.toISOString(),
      },
    };
  },
);
const handleInterruptSend$ = command(
  async (
    { set },
    args: {
      readonly body: InterruptSendBody;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const ownership = await set(
      assertOwnedThread$,
      args.body.threadId,
      args.userId,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();
    if (ownership) {
      return ownership;
    }
    const result = await set(
      appendInterruptUserMessage$,
      {
        threadId: args.body.threadId,
        interruptsRunId: args.body.interruptsRunId,
        clientEventId: args.body.clientEventId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      return badRequestMessage(result.message);
    }
    waitUntil(
      set(
        projectCommittedChatThreadSearch$,
        {
          userId: args.userId,
          orgId: args.orgId,
          threadId: args.body.threadId,
        },
        signal,
      ),
    );
    await set(
      publishChatThreadMessageCreated$,
      {
        userId: args.userId,
        orgId: args.orgId,
        threadId: args.body.threadId,
      },
      signal,
    );
    signal.throwIfAborted();
    const cancelResult = await set(
      cancelRun$,
      {
        runId: args.body.interruptsRunId,
        userRequested: true,
        userId: args.userId,
        orgId: args.orgId,
        runnerCancellationMode: "cooperative",
      },
      signal,
    );
    signal.throwIfAborted();
    if (!isCancelResult(cancelResult)) {
      return cancelResult;
    }
    if (shouldDispatchCancelSideEffects(cancelResult)) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        bestEffort(
          set(dispatchCancelSideEffects$, cancelResult, backgroundSignal),
        ),
      );
    }
    return {
      status: 201 as const,
      body: {
        threadId: args.body.threadId,
        createdAt: result.createdAt.toISOString(),
      },
    };
  },
);
export const handleSendChatEvent$ = command(
  async (
    { get, set },
    {
      body,
      projectId,
      projectReferences,
      bootstrap,
      onAcceptedDocument,
    }: {
      readonly body: SendBody;
      readonly projectId?: string;
      readonly bootstrap?: NormalSendBootstrap;
      readonly onAcceptedDocument?: NormalSendRequest["onAcceptedDocument"];
      readonly projectReferences: NonNullable<
        EnqueuedChatInputFacts["projectReferences"]
      >;
    },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    if (isRecallSendBody(body)) {
      return await set(recallChatEvent$, body, signal);
    }
    if (isInterruptSendBody(body)) {
      return await set(
        handleInterruptSend$,
        { body, userId: auth.userId, orgId: auth.orgId },
        signal,
      );
    }
    if (!isNormalSendBody(body)) {
      return badRequestMessage("Prompt is required");
    }
    signal.throwIfAborted();
    const timing = get(chatEnqueueTiming$);
    const result = await set(
      sendNormalEvent$,
      {
        enqueueTiming: timing,
        projectId,
        projectReferences,
        bootstrap,
        onAcceptedDocument,
        body,
        auth,
        userId: auth.userId,
        orgId: auth.orgId,
        requestReceivedAt: get(apiStartTime$),
      },
      signal,
    );
    timing?.setOutcome(
      result.status === 201 && result.replayed ? "replayed" : "accepted",
    );
    return result;
  },
);
