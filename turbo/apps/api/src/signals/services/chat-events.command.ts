import {
  AUTO_SELECTED_MODEL,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import {
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
  parseRawRows,
} from "../../lib/db-raw-rows";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import {
  chatThreadRequestSelection,
  type ChatThreadRequestFacts,
} from "./chat-thread-request-facts";

import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import type {
  CodexServiceTier,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { resolveChatEventRecommendedFollowups } from "@okouai/api-contracts/validators/chat-threads";
import { linkLayoutSegment } from "@okouai/api-contracts/contracts/link-layout";
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
import { command } from "ccstate";
import {
  and,
  asc,
  DrizzleQueryError,
  eq,
  inArray,
  isNotNull,
  isNull,
  SQL,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { literal, object, string, type infer as zInfer } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
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
import { buildGenerationTemplatePrompt } from "../../lib/generation-template-prompt";
import { now, nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { organizationAuthContext$ } from "../auth/auth-context";
import { apiStartTime$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishDesktopShellAuthorizationChangedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { bestEffort, safeSync, settle, settleIncludingAbort } from "../utils";
import {
  createAgentRunContextSignals,
  preloadAgentRunContext$,
  type AgentRunContextSignals,
} from "./agent-run-context.signals";
import type {
  AgentRunPreCreateSource,
  AgentRunRequestAgent,
} from "./agent-run-contracts";
import {
  resolveDefaultModelFirstPin$,
  resolveRunSelectionModel,
  type ModelSelectionBootstrap,
} from "./model-selection.service";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";
import { mcpClientDisplayName } from "./mcp-client-display-name.service";

import {
  cancelRun$,
  type CancelRunResult,
} from "./agent-run-terminal-transition.service";
import {
  canonicalPrivateWebInputPlan,
  canonicalWebInputPlan,
} from "./canonical-asset.service";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import {
  canonicalChatEventContent,
  canonicalChatEventError,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import {
  pendingChatQueueEventFromRow,
  pendingChatQueueEventReadPlan,
} from "./chat-event-queue.service";
import { notifyBrowserUserActionCallback$ } from "./browser-user-action-callback.service";
import { touchSentChatThreadSort$ } from "./chat-event-shared.service";
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
  isOfficialWorkflowThread$,
  officialWorkflowThreadCondition,
  OFFICIAL_WORKFLOW_THREAD_READ_ONLY_MESSAGE,
} from "./official-workflow-policy.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import {
  notifyRunningChatRunOfPendingInput$,
  pickEnqueuedChatThread$,
} from "./chat-thread-queue-drain.service";
import {
  agentRunSourceTitleSnapshot,
  hasAgentRunSourceAnnotation,
  projectUserMessage,
  userMessagePhysicalFiles,
  withAgentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
} from "./chat-user-message.service";
import { recordGetStartedWorkflowSql } from "./get-started-workflow.service";
import type { ModelCatalog } from "./model-catalog.service";
import { isCatalogFastServiceTierSupported } from "./model-route-capabilities.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { selectedUserPresentationTemplateIds } from "./presentation-template-data.service";
import {
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
} from "./run-cancel.service";
import { uploadedArtifactObject$ } from "./uploaded-artifact.service";
import { webChatContextId } from "./web-chat-queue-context.service";
/** Canonical ChatEvent write commands. */
type SendBody = zInfer<typeof chatEventsContract.send.body>;
interface NormalSendBody {
  readonly agentId: string;
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
  readonly agentId: string;
  readonly threadId: string;
  readonly revokesEventId: string;
  readonly clientEventId?: string;
}
interface InterruptSendBody {
  readonly agentId: string;
  readonly threadId: string;
  readonly interruptsRunId: string;
  readonly clientEventId?: string;
}
type AgentForChatSend = Pick<
  AgentRunRequestAgent,
  "id" | "orgId" | "owner" | "visibility"
>;
type OrganizationAuthContext = AuthContext & {
  readonly orgId: string;
};
interface NormalSendArgs {
  readonly body: NormalSendBody;
  readonly auth: OrganizationAuthContext;
  readonly userId: string;
  readonly orgId: string;
  readonly preloadedAgent?: AgentForChatSend;
  readonly agentRunPreCreateSource?: AgentRunPreCreateSource;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly getStartedWorkflowId?: string;
  /**
   * The request-scoped plan of the authenticated organization, supplied by a
   * caller inside an auth route whose `orgId` is that organization, so the
   * send and its model selection share one read.
   */
  readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
  /**
   * Route-entry time of `POST /api/chat/events`. A run picked by this request
   * for this input is measured from it; other callers omit it.
   */
  readonly requestReceivedAt?: number;
}
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
interface CreatedChatEventResponse {
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
const resolveChatAgentRunSourceById$ = command(
  async (
    { get },
    auth: OrganizationAuthContext,
    sourceRunId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly annotation: ChatAgentRunSourceAnnotation | null;
  } | null> => {
    const db = get(db$);
    const [source] = await db
      .select({
        runId: agentRuns.id,
        threadId: chatThreads.id,
        agentId: chatThreads.agentId,
        title: chatThreads.title,
        autonomyBudget: agentRuns.autonomyBudget,
      })
      .from(agentRuns)
      .leftJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
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
      source.threadId === null || source.agentId === null
        ? null
        : {
            runId: source.runId,
            threadId: source.threadId,
            agentId: source.agentId,
            titleSnapshot: agentRunSourceTitleSnapshot(source.title),
          };
    return { annotation };
  },
);
const resolveNormalSendAgentRunSource$ = command(
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
        readonly source: ChatAgentRunSourceAnnotation | null;
      }
    | {
        readonly response: ReturnType<typeof badRequestMessage>;
      }
  > => {
    if (hasAgentRunSourceAnnotation(params.userMessage)) {
      return {
        response: badRequestMessage(
          "Agent source annotations are server-managed",
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
        resolveChatAgentRunSourceById$,
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
      return { source: resolved.annotation };
    }
    if (params.auth.tokenType !== "agent") {
      return { source: null };
    }
    const resolved = await set(
      resolveChatAgentRunSourceById$,
      params.auth,
      params.auth.runId,
      signal,
    );
    if (resolved === null) {
      return { response: badRequestMessage("Agent source run not found") };
    }
    if (resolved.annotation === null) {
      return {
        response: badRequestMessage(
          "Agent source run is not linked to a chat thread",
        ),
      };
    }
    return { source: resolved.annotation };
  },
);
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
function shouldTouchThreadSortFromNormalSend(
  source: AgentRunPreCreateSource | undefined,
  isNewThread: boolean,
): boolean {
  return (
    !isNewThread &&
    source !== "chat_callback_auto_send" &&
    source !== "workflow_slash_command"
  );
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
function isCancelResult(value: unknown): value is CancelRunResult {
  return (
    typeof value === "object" && value !== null && "alreadyCancelled" in value
  );
}
function isRecallSendBody(body: SendBody): body is RecallSendBody {
  return (
    "revokesEventId" in body &&
    body.revokesEventId !== undefined &&
    !("prompt" in body && body.prompt !== undefined)
  );
}
function isInterruptSendBody(body: SendBody): body is InterruptSendBody {
  return "interruptsRunId" in body && body.interruptsRunId !== undefined;
}
function isNormalSendBody(body: SendBody): body is NormalSendBody {
  return "prompt" in body && body.prompt !== undefined;
}
const ATTACHMENT_METADATA_CONCURRENCY = 4;
function unwrapSettledResult<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}
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
      readonly userMessage: UserMessageDocument;
    },
    signal: AbortSignal,
  ): Promise<ChatEventAttachFileMetadata[]> => {
    const files = userMessagePhysicalFiles(args.userMessage);
    const metadata: ChatEventAttachFileMetadata[] = [];
    for (
      let offset = 0;
      offset < files.length;
      offset += ATTACHMENT_METADATA_CONCURRENCY
    ) {
      const wave = files.slice(
        offset,
        offset + ATTACHMENT_METADATA_CONCURRENCY,
      );
      const results = await Promise.allSettled(
        wave.map(async (file) => {
          const object = await set(
            uploadedArtifactObject$,
            {
              userId: args.userId,
              orgId: args.orgId,
              id: file.fileId,
              filenameHint: file.filenameSnapshot,
            },
            signal,
          );
          return { file, object };
        }),
      );
      signal.throwIfAborted();
      for (const result of results) {
        const { file, object } = unwrapSettledResult(result);
        signal.throwIfAborted();
        if (!object) {
          throw new Error(`User-message attachment not found: ${file.fileId}`);
        }
        metadata.push({
          id: file.fileId,
          filename: file.filenameSnapshot,
          contentType: file.contentType,
          size: object.size,
          objectKey: object.key,
          publicBrand: linkLayoutSegment(object.layout),
        });
      }
    }
    return metadata;
  },
);
function authorizeSendAgent(
  args: NormalSendArgs,
  agent: AgentForChatSend | undefined,
): AgentForChatSend | NormalSendFailure {
  if (!agent || agent.id !== args.body.agentId || agent.orgId !== args.orgId) {
    return notFound("Agent not found");
  }
  if (agent.visibility === "private" && agent.owner !== args.userId) {
    return forbidden("Only the private agent owner can run this agent");
  }
  return agent;
}
const loadAuthorizedAgent$ = command(
  async (
    { get },
    args: NormalSendArgs & { readonly context: AgentRunContextSignals },
    signal: AbortSignal,
  ): Promise<AgentForChatSend | NormalSendFailure> => {
    const agent = await get(args.context.agent$);
    signal.throwIfAborted();
    return authorizeSendAgent(args, agent ?? undefined);
  },
);
const loadExistingSendThreadRow$ = command(
  async (
    { get },
    args: NormalSendArgs,
    threadId: string,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [thread] = await db
      .select({
        ...chatThreadRequestSelection(),
        isOfficialWorkflowThread: officialWorkflowThreadCondition({
          threadId,
          orgId: args.orgId,
          userId: args.userId,
        }).mapWith(pgBooleanDecoder),
      })
      .from(chatThreads)
      .where(
        and(eq(chatThreads.id, threadId), eq(chatThreads.userId, args.userId)),
      )
      .limit(1);
    signal.throwIfAborted();
    return thread;
  },
);
type ExistingSendThreadRow = NonNullable<
  Awaited<ReturnType<(typeof loadExistingSendThreadRow$)["write"]>>
>;
const loadAuthorizedExistingSendThread$ = command(
  async (
    { get, set },
    args: NormalSendArgs & { readonly context: AgentRunContextSignals },
    threadId: string,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly agent: AgentForChatSend;
        readonly thread: ExistingSendThreadRow;
      }
    | NormalSendFailure
  > => {
    const [thread, loadedAgent] = await Promise.all([
      set(loadExistingSendThreadRow$, args, threadId, signal),
      get(args.context.agent$),
    ]);
    signal.throwIfAborted();
    const agent = authorizeSendAgent(args, loadedAgent ?? undefined);
    if ("status" in agent) {
      return agent;
    }
    if (!thread || thread.agentId !== agent.id) {
      return notFound("Chat thread not found");
    }
    return { agent, thread };
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
    requestedTier === "fast" &&
    !isCatalogFastServiceTierSupported(catalog, selectedModel)
  ) {
    return badRequestMessage(
      "Codex fast mode is only available for GPT 5.6 runs",
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
  readonly agentId: string;
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

function normalSendRequestFacts(
  args: NormalSendArgs,
  thread: SendThread,
  previousBinding:
    | Pick<
        ChatThreadRequestFacts["thread"],
        "framework" | "frameworkSessionId" | "frameworkSessionRunId"
      >
    | undefined,
  event: Pick<
    ChatThreadRequestFacts["input"],
    "id" | "userMessage" | "modelSelection"
  >,
): ChatThreadRequestFacts {
  return {
    orgId: args.orgId,
    thread: {
      id: thread.threadId,
      userId: args.userId,
      agentId: args.body.agentId,
      ...thread.runSettings,
      ...thread.computerAccess,
      framework: previousBinding?.framework ?? null,
      frameworkSessionId: previousBinding?.frameworkSessionId ?? null,
      frameworkSessionRunId: previousBinding?.frameworkSessionRunId ?? null,
    },
    input: {
      id: event.id,
      userMessage: event.userMessage,
      modelSelection: event.modelSelection,
      requiredOfficialWorkflowIds: args.requiredOfficialWorkflowIds,
      captureNetworkBodies: Boolean(args.body.captureNetworkBodies),
      ...(args.requestReceivedAt === undefined
        ? {}
        : { requestReceivedAt: args.requestReceivedAt }),
    },
  };
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
        readonly agentId: string;
      };
      readonly orgPlanCapabilities: OrgPlanCapabilities | null | undefined;
      readonly modelBootstrap: ModelSelectionBootstrap;
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
      const computerAccess = await set(
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
        agentId: args.existing.agentId,
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
    const computerAccess = await set(
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
      threadId: args.body.clientThreadId ?? randomUUID(),
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
    agentId: thread.agentId,
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
  const serviceTier = chatThreadServiceTierFromCodex(
    runSettings.codexServiceTier,
  );
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
  args: NormalSendArgs,
  agentRunSource: ChatAgentRunSourceAnnotation | null,
): void {
  if (args.requiredOfficialWorkflowIds?.length === 0) {
    throw new Error("Official Workflow source claim cannot be empty");
  }
  if (
    args.requiredOfficialWorkflowIds !== undefined &&
    normalSendTriggerSource(args.auth) === "agent" &&
    agentRunSource === null
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
  agentRunSource: ChatAgentRunSourceAnnotation | null,
): UserMessageDocument {
  if (agentRunSource !== null) {
    return withAgentRunSourceAnnotation(args.body.userMessage, agentRunSource);
  }
  return args.auth.tokenType !== "oauth"
    ? args.body.userMessage
    : {
        ...args.body.userMessage,
        parts: [
          ...args.body.userMessage.parts,
          {
            type: "source",
            kind: "mcp",
            clientId: args.auth.clientId,
            ...(args.auth.clientName === undefined
              ? {}
              : { clientName: args.auth.clientName }),
          },
        ],
      };
}
/**
 * A conflict on the insert is accepted as a duplicate without a lookup. Only
 * a follow-up with a server-generated id cannot have collided on its id, so
 * its conflict is the revoke edge taken concurrently.
 */
function normalSendEvent(params: {
  readonly modelSelection: ChatInputModelSelection;
  readonly id: string;
  readonly threadId: string;
  readonly userMessage: UserMessageDocument;
  readonly triggerSource: "web" | "agent";
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
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
    ...(params.triggerSource === "agent" && params.agentRunSource
      ? params.requiredOfficialWorkflowIds === undefined
        ? {
            agentRunContext: {
              sourceRunId: params.agentRunSource.runId,
              sourceChatThreadId: params.agentRunSource.threadId,
              sourceAgentId: params.agentRunSource.agentId,
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
          eq(chatThreads.agentId, args.body.agentId),
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
    agentId: args.body.agentId,
    title: null,
    selectedModel: thread.runSettings.selectedModel,
    codexServiceTier: thread.runSettings.codexServiceTier,
    modelSettings: thread.runSettings.modelSettings,
    computerUseHostId: thread.computerAccess.computerUseHostId,
    cloudBrowserEnabled: thread.computerAccess.cloudBrowserEnabled,
  });
}

const createdSendThreadSelection = Object.freeze({
  id: chatThreads.id,
  userId: chatThreads.userId,
  title: chatThreads.title,
  selectedModel: chatThreads.selectedModel,
  modelSettings: chatThreads.modelSettings,
  codexServiceTier: chatThreads.codexServiceTier,
  computerUseHostId: chatThreads.computerUseHostId,
  cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
  createdAt: chatThreads.createdAt,
});

interface NormalSendInput {
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
  readonly thread: SendThread;
  readonly event: ReturnType<typeof normalSendEvent>;
  readonly attachFileMetadata: readonly ChatEventAttachFileMetadata[];
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
      args.auth.tokenType === "agent" ? input.agentRunSource : null,
    queueInput: { chatThreadId: thread.threadId, orgId: args.orgId },
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
    attachments: input.attachFileMetadata.map((file) => {
      const owner = {
        chatThreadId: thread.threadId,
        userId: args.userId,
        orgId: args.orgId,
        file,
      };
      return {
        owner,
        plan: file.objectKey.startsWith("private-artifacts/")
          ? null
          : canonicalWebInputPlan(owner),
      };
    }),
  };
}

const normalSendPublicationRowSchema = object({
  id: string().uuid().nullable(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema.nullable(),
  seqId: pgInt8ToSafeIntegerSchema.nullable(),
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
    agentId: args.body.agentId,
    eventId: args.body.chatThreadEventId,
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
  asset: NonNullable<ReturnType<typeof canonicalWebInputPlan>>,
  gate: SQL,
) {
  return normalChatInputInsertSql(
    runUploadedFiles,
    asset.values,
    gate,
    sql`(user_id, idempotency_scope, idempotency_key) WHERE asset_version = 1
      DO UPDATE SET id = ${runUploadedFiles.id} WHERE ${asset.identity}`,
    sql`${runUploadedFiles.id}`,
  );
}

type NormalInputPlan = ReturnType<typeof normalSendInputPlan>;
type NormalInputAsset = NormalInputPlan["attachments"][number];
interface NormalInputAssetSnapshot {
  readonly index: number;
  readonly asset: NormalInputAsset;
  readonly loaded:
    | {
        readonly ok: true;
        readonly value: {
          readonly owned: typeof runUploadedFiles.$inferSelect | undefined;
          readonly plan: ReturnType<typeof canonicalPrivateWebInputPlan>;
        };
      }
    | { readonly ok: false; readonly error: unknown }
    | null;
}
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
/** Register one physical identity once while retaining every private validation. */
function normalSendAssetRepetitions(
  snapshots: readonly NormalInputAssetSnapshot[],
) {
  const seen = new Map<string, NormalInputAssetSnapshot>();
  return snapshots.map((snapshot) => {
    const previous = seen.get(snapshot.asset.owner.file.id);
    if (!previous) {
      seen.set(snapshot.asset.owner.file.id, snapshot);
      return { snapshot, repeated: false, failure: null };
    }
    const loaded = snapshot.loaded;
    const prior = previous.loaded;
    let failure: { readonly error: unknown } | null = null;
    if (loaded && !loaded.ok) {
      failure = { error: loaded.error };
    } else if (
      (snapshot.asset.plan === null) !== (previous.asset.plan === null) ||
      (loaded?.ok &&
        prior?.ok &&
        (snapshot.asset.owner.file.objectKey !==
          previous.asset.owner.file.objectKey ||
          JSON.stringify(loaded.value.owned?.metadata) !==
            JSON.stringify(prior.value.owned?.metadata)))
    ) {
      failure = {
        error: new Error(
          "Chat input attachment storage changed during preparation",
        ),
      };
    }
    return { snapshot, repeated: true, failure };
  });
}
function normalSendAssetWrites(
  snapshots: readonly NormalInputAssetSnapshot[],
  previous?: string,
) {
  const writes: NormalChatInputWrite[] = [];
  const guards: NormalChatInputGuard[] = [];
  const failures: NormalSendPublicationFailure[] = [];
  let after = previous;
  for (const repetition of normalSendAssetRepetitions(snapshots)) {
    const { snapshot, repeated, failure } = repetition;
    const { index, asset } = snapshot;
    const name = "normal_send_asset_" + index;
    const token = normalSendFailureToken("ASSET_" + index);
    if (failure) {
      failures.push({ token, error: failure.error });
      guards.push({ condition: normalChatInputWritten, token });
      continue;
    }
    if (repeated) {
      continue;
    }
    const gate = normalChatInputWriteGate(after);
    if (asset.plan) {
      writes.push({
        name,
        statement: normalSendPublicAssetWrite(asset.plan, gate),
      });
      failures.push({
        token,
        error: new Error("Canonical web input asset conflict is missing"),
      });
    } else {
      const owner = asset.owner;
      const loaded = snapshot.loaded;
      if (!loaded) {
        throw new Error("Private chat input attachment preparation is missing");
      }
      if (!loaded.ok) {
        failures.push({ token, error: loaded.error });
        guards.push({ condition: normalChatInputWritten, token });
        continue;
      }
      const { owned, plan } = loaded.value;
      if (!owned) {
        throw new Error(
          "Private attachment validation did not retain its record",
        );
      }
      if (!plan.where) {
        throw new Error("Private input attachment write predicate is missing");
      }
      const values = normalChatInputConditionalValues(
        runUploadedFiles,
        plan.values,
        plan.where,
      );
      const condition = and(
        eq(runUploadedFiles.id, owner.file.id),
        eq(runUploadedFiles.userId, owner.userId),
        eq(runUploadedFiles.orgId, owner.orgId),
        eq(runUploadedFiles.storageKey, owner.file.objectKey),
        eq(runUploadedFiles.metadata, owned.metadata),
        gate,
      );
      writes.push({
        name,
        statement: new PgDialect().buildUpdateQuery({
          table: runUploadedFiles,
          set: { ...values },
          joins: [],
          where: condition,
          returning: [{ path: ["id"], field: runUploadedFiles.id }],
        }),
      });
      failures.push({
        token,
        error: new Error(
          "Private attachment changed while input was being committed",
        ),
      });
    }
    guards.push({
      condition: sql`${normalChatInputWritten} AND NOT EXISTS (SELECT 1 FROM ${sql.identifier(name)})`,
      token,
    });
    after = name;
  }
  return { writes, guards, failures, after };
}
function normalSendFinalWrites(
  args: NormalSendArgs,
  input: NormalInputPlan,
  previous?: string,
) {
  const event = input.event;
  const writes: NormalChatInputWrite[] = [];
  let after = previous;
  if (args.getStartedWorkflowId) {
    writes.push({
      name: "normal_send_get_started",
      statement: recordGetStartedWorkflowSql(
        {
          orgId: args.orgId,
          userId: args.userId,
          workflowId: args.getStartedWorkflowId,
          sourceEventId: event.id,
        },
        nowDate(),
        normalChatInputWriteGate(after),
      ),
    });
    after = "normal_send_get_started";
  }
  const queue = queuedChatThreadEnqueuePlan(input.queueInput);
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
    ),
  });
  return writes;
}
function normalSendPreparedPublication(
  args: NormalSendArgs,
  input: NormalInputPlan,
  target: readonly zInfer<typeof chatEventReplacementTargetSchema>[] | null,
  snapshots: readonly NormalInputAssetSnapshot[],
) {
  const thread = input.thread;
  const base = normalSendBasePublication(args, input, target);
  const selection = normalSendSelectionWrites(args, input, base.after);
  const assets = normalSendAssetWrites(snapshots, selection.after);
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
        ...normalSendFinalWrites(args, input, assets.after),
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
    const target = args.body.revokesEventId
      ? parseRawRows(
          chatEventReplacementTargetSchema,
          await db.execute(
            chatEventReplacementTargetSql(args.body.revokesEventId),
          ),
        )
      : null;
    signal.throwIfAborted();
    const snapshots: NormalInputAssetSnapshot[] = [];
    for (const [index, asset] of input.attachments.entries()) {
      if (asset.plan) {
        snapshots.push({ index, asset, loaded: null });
        continue;
      }
      const loaded = await settle(
        (async () => {
          const [owned] = await db
            .select()
            .from(runUploadedFiles)
            .where(eq(runUploadedFiles.id, asset.owner.file.id))
            .limit(1);
          return {
            owned,
            plan: canonicalPrivateWebInputPlan({ ...asset.owner, owned }),
          };
        })(),
      );
      signal.throwIfAborted();
      snapshots.push({ index, asset, loaded });
    }
    const prepared = normalSendPreparedPublication(
      args,
      input,
      target,
      snapshots,
    );
    const created = prepared.createdPlan;
    const query = normalChatInputPublicationSql({
      ...prepared.plan,
      newThread: created
        ? db
            .with(...created.defaults)
            .insert(chatThreads)
            .values(created.values)
            .onConflictDoNothing()
            .returning(createdSendThreadSelection)
            .getSQL()
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
    if (row.createdAt === null || row.seqId === null) {
      throw new Error("Normal chat input publication is incomplete");
    }
    return {
      inserted: { id: row.id, createdAt: row.createdAt, seqId: row.seqId },
      enqueueCommit: { eventId: row.id, committedAt: now() },
    };
  },
);

const prepareNormalSend$ = command(
  async (
    { get, set },
    args: NormalSendArgs & { readonly context: AgentRunContextSignals },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly authorized:
          | Awaited<ReturnType<(typeof loadAuthorizedAgent$)["write"]>>
          | Awaited<
              ReturnType<(typeof loadAuthorizedExistingSendThread$)["write"]>
            >;
        readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
        readonly catalog: ModelCatalog;
      }
    | NormalSendFailure
    | CreatedChatEventResponse
  > => {
    // MCP attribution is server-owned. Reject a forged source even on an
    // idempotent retry.
    if (
      args.body.userMessage.parts.some((part) => {
        return part.type === "source" && part.kind === "mcp";
      })
    ) {
      return badRequestMessage("MCP source annotations are server-managed");
    }
    const existingThreadId = args.body.threadId;
    const authorized =
      existingThreadId === undefined
        ? await set(loadAuthorizedAgent$, args, signal)
        : await set(
            loadAuthorizedExistingSendThread$,
            args,
            existingThreadId,
            signal,
          );
    signal.throwIfAborted();
    if ("status" in authorized) {
      return authorized;
    }
    if ("thread" in authorized && authorized.thread.isOfficialWorkflowThread) {
      return forbidden(OFFICIAL_WORKFLOW_THREAD_READ_ONLY_MESSAGE);
    }
    const source = await set(
      resolveNormalSendAgentRunSource$,
      {
        auth: args.auth,
        userMessage: args.body.userMessage,
        sourceRunId: args.body.sourceRunId,
      },
      signal,
    );
    signal.throwIfAborted();
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
    const catalog = (await get(args.context.modelFacts$)).catalog;
    signal.throwIfAborted();
    if (
      typeof args.body.model === "string" &&
      args.body.model !== AUTO_SELECTED_MODEL &&
      resolveRunSelectionModel(catalog, args.body.model) === null
    ) {
      return badRequestMessage(`Unknown model "${args.body.model}"`);
    }
    return { authorized, agentRunSource: source.source, catalog };
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
    if (
      thread.kind === "new" ||
      !shouldTouchThreadSortFromNormalSend(args.agentRunPreCreateSource, false)
    ) {
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
          agentId: thread.agentId,
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
      readonly context: AgentRunContextSignals;
      readonly requestFacts: ChatThreadRequestFacts;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { args, thread, touchedAt, enqueueCommit, context, requestFacts } =
      input;
    if (
      thread.kind === "existing" &&
      thread.computerAccess.computerUseHostId !==
        thread.current.computerUseHostId
    ) {
      await publishDesktopShellAuthorizationChangedSafely(args.userId);
      signal.throwIfAborted();
    }
    const picked = await settle(
      set(
        pickEnqueuedChatThread$,
        {
          orgId: args.orgId,
          chatThreadId: thread.threadId,
          ...(enqueueCommit ? { enqueueCommit } : {}),
          context,
          requestFacts,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    await set(normalSendThreadTouch$, args, thread, touchedAt, signal);
    signal.throwIfAborted();
    await publishChatEventCreated({
      userId: args.userId,
      orgId: args.orgId,
      threadId: thread.threadId,
    });
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
const prepareNormalSendInput$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly body: NormalSendBody;
      readonly thread: SendThread;
      readonly catalog: ModelCatalog;
      readonly orgPlanCapabilities: OrgPlanCapabilities | null | undefined;
      readonly modelBootstrap: ModelSelectionBootstrap;
    },
    signal: AbortSignal,
  ) => {
    const attachFileMetadata = await set(
      resolveIncomingAttachFileMetadata$,
      {
        userId: args.userId,
        orgId: args.orgId,
        userMessage: args.body.userMessage,
      },
      signal,
    );
    const modelSelection = await set(
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
    signal.throwIfAborted();
    if ("status" in modelSelection) {
      return modelSelection;
    }
    return {
      attachFileMetadata,
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
  agentRunSource: ChatAgentRunSourceAnnotation | null,
) {
  return normalSendEvent({
    modelSelection,
    id: args.body.clientEventId ?? randomUUID(),
    threadId: threadId,
    userMessage: normalSendUserMessage(args, agentRunSource),
    triggerSource: normalSendTriggerSource(args.auth),
    agentRunSource,
    requiredOfficialWorkflowIds: args.requiredOfficialWorkflowIds,
  });
}
/**
 * Direct send, shared by the web, the CLI, and MCP: authorize the agent and
 * thread, validate a follow-up revocation, record attachment references, then
 * enqueue the input (creating a new thread's minimal row in the same
 * transaction) and schedule its pick without waiting for it. A retried client
 * event id conflicts on the input's insert and is accepted again without
 * enqueueing anything. The model is captured at enqueue. Credit admission,
 * the autonomy budget, templates, session, and context are resolved by the
 * pick; a rejection appears in the thread as `input.rejected`. A direct
 * message's sidebar touch runs after the pick.
 */
function settledNormalSendResponse(
  body: NormalSendBody,
  threadId: string,
  createdAt: Date | null,
) {
  if (createdAt === null) {
    // A conflict on the insert is accepted as a duplicate without a
    // lookup. Only a follow-up with a server-generated id cannot have
    // collided on its id, so its conflict is the revoke edge taken
    // concurrently.
    return body.revokesEventId && body.clientEventId === undefined
      ? conflict("Recommended follow-up has already been used")
      : acceptedSendResponse(threadId, nowDate(), true);
  }
  return acceptedSendResponse(threadId, createdAt, false);
}
const validateSendThreadRevocation$ = command(
  async (
    { set },
    args: NormalSendArgs,
    thread: SendThread,
    signal: AbortSignal,
  ) => {
    if (thread.kind !== "existing") {
      return null;
    }
    const revocation = await set(
      validateNormalRevocationTarget$,
      {
        threadId: thread.threadId,
        revokesEventId: args.body.revokesEventId,
        clientEventId: args.body.clientEventId,
      },
      signal,
    );
    signal.throwIfAborted();
    return revocation;
  },
);

const prepareNormalSendModels$ = command(
  async ({ get }, context: AgentRunContextSignals, signal: AbortSignal) => {
    const [orgModels, memberModels, memberMetadata] = await Promise.all([
      get(context.modelFacts$),
      get(context.memberModels$),
      get(context.memberMetadata$),
    ]);
    signal.throwIfAborted();
    return {
      orgModels,
      modelBootstrap: {
        org: orgModels,
        member: memberModels,
        memberMetadata,
      },
    };
  },
);

const prepareNormalSendContext$ = command(
  async ({ set }, args: NormalSendArgs, signal: AbortSignal) => {
    const context = createAgentRunContextSignals(
      args.userId,
      args.orgId,
      args.body.agentId,
    );
    // Start authenticated org/member reads immediately; authorization consumes
    // the same promises. Settled waitUntil work stays owned on rejection/abort.
    set(preloadAgentRunContext$, context, signal);
    const prepared = await set(
      prepareNormalSend$,
      { ...args, context },
      signal,
    );
    if ("status" in prepared) {
      return prepared;
    }
    const models = await set(prepareNormalSendModels$, context, signal);
    return { ...prepared, ...models, context };
  },
);

export const sendNormalEvent$ = command(
  async (
    { set },
    args: NormalSendArgs,
    signal: AbortSignal,
  ): Promise<CreatedChatEventResponse | NormalSendFailure> => {
    signal.throwIfAborted();
    const prepared = await set(prepareNormalSendContext$, args, signal);
    if ("status" in prepared) {
      return prepared;
    }
    const { authorized, catalog, orgModels, modelBootstrap, context } =
      prepared;
    const resolvedThread = await set(
      resolveSendThread$,
      {
        ...args,
        orgPlanCapabilities: orgModels.capabilities,
        catalog,
        modelBootstrap,
        context,
        existing:
          "thread" in authorized
            ? { thread: authorized.thread, agentId: authorized.agent.id }
            : undefined,
      },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in resolvedThread) {
      return resolvedThread;
    }
    const revocation = await set(
      validateSendThreadRevocation$,
      args,
      resolvedThread,
      signal,
    );
    signal.throwIfAborted();
    if (revocation) {
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
      prepared.agentRunSource,
    );
    const enqueued = await settle(
      (async () => {
        const committed = await set(
          appendNormalSendInput$,
          args,
          normalSendInputPlan(args, {
            thread,
            event,
            attachFileMetadata,
            agentRunSource: prepared.agentRunSource,
          }),
          signal,
        );
        if (committed === null) {
          return null;
        }
        const {
          inserted: { createdAt },
          enqueueCommit,
        } = committed;
        // Schedule before observing abort; touch/realtime follow this pick's outcome.
        waitUntil(
          set(
            publishEnqueuedNormalSend$,
            {
              args,
              thread,
              touchedAt: createdAt,
              ...(enqueueCommit ? { enqueueCommit } : {}),
              context,
              requestFacts: normalSendRequestFacts(
                args,
                thread,
                "thread" in authorized ? authorized.thread : undefined,
                event,
              ),
            },
            signal,
          ),
        );
        waitUntil(
          set(notifyRunningChatRunOfPendingInput$, thread.threadId, signal),
        );
        return createdAt;
      })(),
      signal,
    );
    if (!enqueued.ok) {
      if (
        thread.kind === "new" &&
        enqueued.error instanceof NewThreadSendCollision
      ) {
        return await set(
          resolveNewThreadSendCollision$,
          args,
          thread,
          enqueued.error.collision,
          signal,
        );
      }
      throw enqueued.error;
    }
    const acceptedAt = enqueued.value;
    return settledNormalSendResponse(args.body, thread.threadId, acceptedAt);
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
const validateNormalRevocationTarget$ = command(
  async (
    { get },
    params: {
      readonly threadId: string;
      readonly revokesEventId: string | undefined;
      readonly clientEventId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<NormalSendFailure | CreatedChatEventResponse | undefined> => {
    const db = get(db$);
    if (!params.revokesEventId) {
      return undefined;
    }
    const [target] = await db
      .select({
        id: chatEvents.id,
        content: canonicalChatEventContent(),
      })
      .from(chatEvents)
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
    const [existingRevoker] = await db
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
    if (existingRevoker) {
      // Postgres returns the uuid lowercase; the request may use any case.
      return existingRevoker.id === params.clientEventId?.toLowerCase()
        ? acceptedSendResponse(params.threadId, existingRevoker.createdAt, true)
        : conflict("Recommended follow-up has already been used");
    }
    return undefined;
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
async function publishChatEventCreated(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
}): Promise<void> {
  await publishChatThreadMessageCreatedSafely(args);
}
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
    if (
      await set(isOfficialWorkflowThread$, { threadId, orgId, userId }, signal)
    ) {
      return forbidden(OFFICIAL_WORKFLOW_THREAD_READ_ONLY_MESSAGE);
    }
    return undefined;
  },
);
const handleRecallSend$ = command(
  async (
    { set },
    args: {
      readonly body: RecallSendBody;
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
      appendRecallChatEvent$,
      {
        threadId: args.body.threadId,
        revokesEventId: args.body.revokesEventId,
        clientEventId: args.body.clientEventId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      return badRequestMessage(result.message);
    }
    await publishChatEventCreated({
      userId: args.userId,
      orgId: args.orgId,
      threadId: args.body.threadId,
    });
    signal.throwIfAborted();
    return {
      status: 201 as const,
      body: {
        threadId: args.body.threadId,
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
    await publishChatEventCreated({
      userId: args.userId,
      orgId: args.orgId,
      threadId: args.body.threadId,
    });
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
  async ({ get, set }, body: SendBody, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (isRecallSendBody(body)) {
      return await set(
        handleRecallSend$,
        { body, userId: auth.userId, orgId: auth.orgId },
        signal,
      );
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
    const clientName =
      auth.tokenType === "oauth"
        ? await mcpClientDisplayName(auth.clientId, signal)
        : undefined;
    signal.throwIfAborted();
    return await set(
      sendNormalEvent$,
      {
        body,
        auth: auth.tokenType === "oauth" ? { ...auth, clientName } : auth,
        userId: auth.userId,
        orgId: auth.orgId,
        requestReceivedAt: get(apiStartTime$),
      },
      signal,
    );
  },
);
