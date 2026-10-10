import {
  AUTO_SELECTED_MODEL,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import { parseRawRows } from "../../lib/db-raw-rows";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import {
  chatThreadRequestSelection,
  type ChatThreadRequestFacts,
} from "./chat-thread-request-facts";

import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import {
  chatEventsContract,
  resolveChatEventRecommendedFollowups,
  type CodexServiceTier,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
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
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { buildGenerationTemplatePrompt } from "../../lib/generation-template-prompt";
import { now, nowDate } from "../../lib/time";
import type { AuthContext } from "../../types/auth";
import { organizationAuthContext$ } from "../auth/auth-context";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { bestEffort, settle, settleIncludingAbort } from "../utils";
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
import { loadPendingChatQueueEvent } from "./chat-event-queue.service";
import { touchSentChatThreadSort$ } from "./chat-event-shared.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { reportChatEventSideEffect } from "./chat-event-write-side-effects.service";
import {
  chatEventContextInsertSql,
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
import {
  chatThreadCreatedEventSql,
  createdChatThreadFromRow,
  prepareChatThreadInsert,
} from "./chat-thread-create.service";
import {
  chatThreadEventInsertSql,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
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
type SendBody = z.infer<typeof chatEventsContract.send.body>;
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
  /** Only the verified /mcp service supplies this; never read it from the send body. */
  readonly mcpSource?: Extract<
    UserMessageDocument["parts"][number],
    {
      type: "source";
      kind: "mcp";
    }
  >;
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
    readonly runId: null;
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
    body: { runId: null, threadId, createdAt: createdAt.toISOString() },
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
      .select(chatThreadRequestSelection())
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
        "agentSessionId" | "agentSessionRunId"
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
      agentSessionId: previousBinding?.agentSessionId ?? null,
      agentSessionRunId: previousBinding?.agentSessionRunId ?? null,
    },
    input: {
      id: event.id,
      userMessage: event.userMessage,
      modelSelection: event.modelSelection,
      requiredOfficialWorkflowIds: args.requiredOfficialWorkflowIds,
      captureNetworkBodies: Boolean(args.body.captureNetworkBodies),
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
  return args.mcpSource === undefined
    ? args.body.userMessage
    : {
        ...args.body.userMessage,
        parts: [...args.body.userMessage.parts, args.mcpSource],
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

function normalSendInputInsertSql(
  event: ReturnType<typeof normalSendEvent>,
  replacementRows:
    Parameters<typeof requireChatEventReplacementTarget>[0] | null,
) {
  return replacementRows === null
    ? chatEventInsertSql(event, "id")
    : chatEventReplacementInsertSql(
        requireChatEventReplacementTarget(replacementRows),
        event,
      );
}

function newSendThreadCreatedEventSql(
  args: NormalSendArgs,
  row: Parameters<typeof createdChatThreadFromRow>[0],
) {
  return chatThreadCreatedEventSql({
    orgId: args.orgId,
    eventId: args.body.chatThreadEventId,
    thread: createdChatThreadFromRow(row, args.body.agentId),
  });
}

function normalSendGetStartedSql(args: NormalSendArgs, sourceEventId: string) {
  return args.getStartedWorkflowId
    ? recordGetStartedWorkflowSql(
        {
          orgId: args.orgId,
          userId: args.userId,
          workflowId: args.getStartedWorkflowId,
          sourceEventId,
        },
        nowDate(),
      )
    : undefined;
}

const appendNormalSendInput$ = command(
  async (
    { set },
    args: NormalSendArgs,
    input: ReturnType<typeof normalSendInputPlan>,
    signal: AbortSignal,
  ) => {
    const { thread, event, existingPlan, preferencePlan } = input;
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0091; new non-billing transactions are prohibited.
    const inserted = await set(writeDb$).transaction(async (tx) => {
      if (thread.kind === "new") {
        const createdPlan = newSendThreadInsertPlan(args, thread);
        const [createdRow] = await tx
          .with(...createdPlan.defaults)
          .insert(chatThreads)
          .values(createdPlan.values)
          .onConflictDoNothing()
          .returning(createdSendThreadSelection);
        if (!createdRow) {
          throw new NewThreadSendCollision("thread");
        }
        await tx.execute(newSendThreadCreatedEventSql(args, createdRow));
      }
      const replacementRows = args.body.revokesEventId
        ? parseRawRows(
            chatEventReplacementTargetSchema,
            await tx.execute(
              chatEventReplacementTargetSql(args.body.revokesEventId),
            ),
          )
        : null;
      const insert = normalSendInputInsertSql(event, replacementRows);
      const [inserted] = parseRawRows(
        chatEventCommandResultSchema,
        await tx.execute(insert),
      );
      if (!inserted) {
        if (thread.kind === "new") {
          throw new NewThreadSendCollision("input");
        }
        return null;
      }
      const contextInsert = chatEventContextInsertSql(event);
      if (contextInsert) {
        await tx.execute(contextInsert);
      }
      if (existingPlan) {
        const { replacement } = existingPlan;
        if (replacement) {
          // A concurrent model change wins; a lost CAS writes no events.
          const [replaced] = await tx
            .update(chatThreads)
            .set(replacement.values)
            .where(replacement.where)
            .returning({ id: chatThreads.id });
          if (replaced) {
            for (const event of replacement.events) {
              await tx.execute(chatThreadEventInsertSql(event));
            }
          }
        }
        if (existingPlan.values) {
          await tx
            .update(chatThreads)
            .set(existingPlan.values)
            .where(existingPlan.where);
        }
        for (const event of existingPlan.events) {
          await tx.execute(chatThreadEventInsertSql(event));
        }
      }
      if (args.body.captureNetworkBodies) {
        await tx
          .insert(chatNetworkBodyCaptures)
          .values({ chatEventId: inserted.id, chatThreadId: thread.threadId })
          .onConflictDoNothing({ target: chatNetworkBodyCaptures.chatEventId });
      }
      if (preferencePlan) {
        await tx
          .insert(orgMembersMetadata)
          .values(preferencePlan.values)
          .onConflictDoUpdate(preferencePlan.conflict);
      }
      // Canonical attachments and their input event commit as one unit.
      for (const { owner, plan } of input.attachments) {
        if (plan === null) {
          const [owned] = await tx
            .select()
            .from(runUploadedFiles)
            .where(eq(runUploadedFiles.id, owner.file.id))
            .limit(1);
          const plan = canonicalPrivateWebInputPlan({ ...owner, owned });
          // Existing generated/integration identity is retained by the update predicate.
          await tx.update(runUploadedFiles).set(plan.values).where(plan.where);
          continue;
        }
        const [registered] = await tx
          .insert(runUploadedFiles)
          .values(plan.values)
          .onConflictDoNothing()
          .returning({ id: runUploadedFiles.id });
        if (registered) {
          continue;
        }
        const [existing] = await tx
          .select({ id: runUploadedFiles.id })
          .from(runUploadedFiles)
          .where(plan.identity)
          .limit(1);
        if (!existing) {
          throw new Error("Canonical web input asset conflict is missing");
        }
      }
      const getStartedInsert = normalSendGetStartedSql(args, inserted.id);
      if (getStartedInsert) {
        await tx.execute(getStartedInsert);
      }
      const plan = queuedChatThreadEnqueuePlan(input.queueInput);
      await tx
        .insert(queuedChatThreads)
        .values(plan.values)
        .onConflictDoUpdate(plan.conflict);
      return inserted;
    });
    signal.throwIfAborted();
    return inserted === null
      ? null
      : {
          inserted,
          enqueueCommit: { eventId: inserted.id, committedAt: now() },
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
    if (
      args.mcpSource !== undefined &&
      (args.auth.tokenType !== "oauth" ||
        !("clientId" in args.auth) ||
        args.auth.clientId !== args.mcpSource.clientId ||
        args.body.userMessage.parts.some((part) => {
          return part.type !== "text";
        }))
    ) {
      return badRequestMessage("MCP source requires a verified OAuth client");
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
    const {
      authorized,
      agentRunSource,
      catalog,
      orgModels,
      modelBootstrap,
      context,
    } = prepared;
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
      agentRunSource,
    );
    const enqueued = await settle(
      (async () => {
        const committed = await set(
          appendNormalSendInput$,
          args,
          normalSendInputPlan(args, { thread, event, attachFileMetadata }),
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
    const pendingTarget = await loadPendingChatQueueEvent(db, {
      chatThreadId: params.threadId,
      eventId: params.revokesEventId,
    });
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
      if (
        existingRevoker.eventType === "control.revoke" &&
        existingRevoker.content === null
      ) {
        return { ok: true, createdAt: existingRevoker.createdAt };
      }
      return recallRejected;
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
    { get },
    threadId: string,
    userId: string,
    orgId: string,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof notFound> | undefined> => {
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
    return thread ? undefined : notFound("Chat thread not found");
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
        runId: null,
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
        runId: null,
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
    return await set(
      sendNormalEvent$,
      {
        body,
        auth,
        userId: auth.userId,
        orgId: auth.orgId,
      },
      signal,
    );
  },
);
