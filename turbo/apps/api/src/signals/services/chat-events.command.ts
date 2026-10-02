import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { executeRawRows } from "../../lib/db-raw-rows";
import { resolveRunSelectionModel } from "./model-selection.service";
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
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import {
  chatEvents,
  type ChatEventAttachFileMetadata,
} from "@okouai/db/schema/chat-event";
import { computerUseHosts } from "@okouai/db/schema/computer-use-host";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { command } from "ccstate";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { buildGenerationTemplatePrompt } from "../../lib/generation-template-prompt";
import { now, nowDate } from "../../lib/time";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";
import type { AuthContext } from "../../types/auth";
import { organizationAuthContext$ } from "../auth/auth-context";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { bestEffort, settle } from "../utils";
import type {
  AgentRunPreCreateSource,
  AgentRunRequestAgent,
} from "./agent-run-contracts";
import { registerCanonicalWebInputAssets } from "./canonical-asset.service";
import {
  canonicalChatEventContent,
  canonicalChatEventError,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import { loadPendingChatQueueEvent } from "./chat-event-queue.service";
import { touchSentChatThreadSort } from "./chat-event-shared.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { attemptChatEventSideEffect } from "./chat-event-write-side-effects.service";
import {
  type NewChatEvent,
  chatEventContextInsertSql,
  chatEventReplacementInsertSql,
  requireChatEventReplacementTarget,
  chatEventReplacementTargetSql,
  chatEventReplacementTargetSchema,
  chatEventInsertSql,
} from "./chat-event.service";
import type { ChatInputEnqueueCommit } from "./chat-input-enqueue-observation";
import { resolveChatInputModelSelection$ } from "./chat-input-model.service";
import { loadModelCatalog$, type ModelCatalog } from "./model-catalog.service";
import {
  catalogModelOffersUltrafast,
  isCatalogFastServiceTierSupported,
} from "./model-route-capabilities.service";
import { recordChatNetworkBodyCapture } from "./chat-network-body-capture.service";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import {
  chatThreadCreatedEventSql,
  prepareChatThreadInsert,
  createdChatThreadFromRow,
} from "./chat-thread-create.service";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
  chatThreadEventInsertSql,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import { resolveRequiredDefaultChatThreadModelPin$ } from "./chat-thread-model.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import {
  pickEnqueuedChatThread$,
  notifyRunningChatRunOfPendingInput$,
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
import {
  organizationPlanCapabilities$,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { selectedUserPresentationTemplateIds } from "./presentation-template-data.service";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
  type CancelRunResult,
} from "./run-cancel.service";
import { uploadedArtifactObject } from "./uploaded-artifact.service";
import {
  officialWorkflowQueueContextId,
  webChatContextId,
} from "./web-chat-queue-context.service";
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
  readonly model?: string;
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
          chatThreadOrganizationCondition(db, params.orgId),
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
    { get },
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
          const object = await get(
            uploadedArtifactObject({
              userId: args.userId,
              orgId: args.orgId,
              id: file.fileId,
              filenameHint: file.filenameSnapshot,
            }),
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
const loadAgentForChatSend$ = command(
  async (
    { get },
    agentId: string,
    signal: AbortSignal,
  ): Promise<AgentForChatSend | undefined> => {
    const db = get(db$);
    const [agent] = await db
      .select({
        id: agents.id,
        orgId: agents.orgId,
        owner: agents.owner,
        visibility: agents.visibility,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    signal.throwIfAborted();
    return agent;
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
    { set },
    args: NormalSendArgs,
    signal: AbortSignal,
  ): Promise<AgentForChatSend | NormalSendFailure> => {
    return authorizeSendAgent(
      args,
      args.preloadedAgent ??
        (await set(loadAgentForChatSend$, args.body.agentId, signal)),
    );
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
        id: chatThreads.id,
        agentId: chatThreads.agentId,
        selectedModel: chatThreads.selectedModel,
        modelSettings: chatThreads.modelSettings,
        codexServiceTier: chatThreads.codexServiceTier,
        computerUseHostId: chatThreads.computerUseHostId,
        cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
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
    { set },
    args: NormalSendArgs,
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
      args.preloadedAgent ??
        set(loadAgentForChatSend$, args.body.agentId, signal),
    ]);
    signal.throwIfAborted();
    const agent = authorizeSendAgent(args, loadedAgent);
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
  readonly selectedModel: string | null;
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
    readonly selectedModel: string | null;
    readonly modelSettings: ModelSettings;
    readonly codexServiceTier: CodexServiceTier | null;
  },
): ThreadRunSettings | ReturnType<typeof badRequestMessage> {
  const selectedModel = body.model ?? current.selectedModel;
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
  // The catalog route capabilities decide Ultrafast availability, including
  // a stored thread tier kept by this send.
  if (
    codexServiceTier === "ultrafast" &&
    !catalogModelOffersUltrafast(catalog, selectedModel)
  ) {
    return badRequestMessage("Ultrafast is unavailable for this model route");
  }
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
}
interface NewSendThread {
  readonly kind: "new";
  readonly threadId: string;
  readonly clientThreadId: string | undefined;
  readonly runSettings: ThreadRunSettings;
  readonly computerAccess: ThreadComputerAccess;
}
type SendThread = ExistingSendThread | NewSendThread;
const resolveSendThread$ = command(
  async (
    { set },
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
            resolveRequiredDefaultChatThreadModelPin$,
            member,
            args.orgPlanCapabilities,
            signal,
          )
        : null;
    const defaults = await set(loadNewChatThreadDefaults$, member, signal);
    signal.throwIfAborted();
    const runSettings = requestedThreadRunSettings(args.catalog, args.body, {
      selectedModel: initialModel?.selectedModel ?? null,
      modelSettings: defaults.modelSettings,
      codexServiceTier:
        initialModel?.serviceTier === "priority"
          ? "fast"
          : initialModel?.serviceTier === "ultrafast"
            ? "ultrafast"
            : null,
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
/** Prepare the send's changed thread selections and their projection events. */
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
  const events: Parameters<typeof chatThreadEventInsertSql>[0][] = [];
  const event = {
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.threadId,
    agentId: thread.agentId,
    createdAt: updatedAt,
  };
  if (modelChanged) {
    events.push({
      ...event,
      kind: "model_selection_updated",
      selectedModel,
      modelSettingsPatch: runSettings.modelSettingsPatch,
    });
  }
  if (tierChanged) {
    events.push({
      ...event,
      kind: "service_tier_updated",
      serviceTier: chatThreadServiceTierFromCodex(codexServiceTier),
    });
  }
  if (accessChanged) {
    events.push({
      ...event,
      kind: "computer_use_host_updated",
      ...computerAccess,
    });
  }

  return {
    values: {
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
      ...(accessChanged ? computerAccess : {}),
      updatedAt,
    },
    events,
  };
}
/** An explicit model selection also becomes the member's default for new chats. */
function userModelPreferencePlan(
  args: NormalSendArgs,
  runSettings: ThreadRunSettings,
) {
  const selectedModel = args.body.model;
  if (selectedModel === undefined) {
    return null;
  }
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
          contextId:
            params.requiredOfficialWorkflowIds === undefined
              ? webChatContextId()
              : officialWorkflowQueueContextId(),
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
            contextId: officialWorkflowQueueContextId(),
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
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
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

const appendNormalSendInput$ = command(
  async (
    { set },
    args: NormalSendArgs,
    input: {
      readonly thread: SendThread;
      readonly event: ReturnType<typeof normalSendEvent>;
      readonly attachFileMetadata: readonly ChatEventAttachFileMetadata[];
    },
    signal: AbortSignal,
  ) => {
    const { thread, event } = input;
    const existingPlan = existingSendThreadUpdatePlan(args, thread);
    const preferencePlan = userModelPreferencePlan(args, thread.runSettings);
    const inserted = await set(writeDb$).transaction(async (tx) => {
      if (thread.kind === "new") {
        const createdPlan = newSendThreadInsertPlan(args, thread);
        const [createdRow] = await tx
          .with(createdPlan.defaults)
          .insert(chatThreads)
          .values(createdPlan.values)
          .onConflictDoNothing()
          .returning(createdSendThreadSelection);
        if (!createdRow) {
          throw new NewThreadSendCollision("thread");
        }
        await tx.execute(
          chatThreadCreatedEventSql({
            orgId: args.orgId,
            eventId: args.body.chatThreadEventId,
            thread: createdChatThreadFromRow(
              createdRow,
              createdPlan.values.agentId,
            ),
          }),
        );
      }
      const contextInsert = chatEventContextInsertSql(event);
      if (contextInsert) {
        await tx.execute(contextInsert);
      }
      const insert = args.body.revokesEventId
        ? chatEventReplacementInsertSql(
            requireChatEventReplacementTarget(
              await executeRawRows(
                tx,
                chatEventReplacementTargetSql(args.body.revokesEventId),
                chatEventReplacementTargetSchema,
              ),
            ),
            event,
          )
        : chatEventInsertSql(event, "id");
      const [inserted] = await executeRawRows(
        tx,
        insert,
        chatEventCommandResultSchema,
      );
      if (!inserted) {
        if (thread.kind === "new") {
          throw new NewThreadSendCollision("input");
        }
        return null;
      }
      if (existingPlan) {
        await tx
          .update(chatThreads)
          .set(existingPlan.values)
          .where(
            and(
              eq(chatThreads.id, thread.threadId),
              eq(chatThreads.userId, args.userId),
            ),
          );
        for (const event of existingPlan.events) {
          await tx.execute(chatThreadEventInsertSql(event));
        }
      }
      if (args.body.captureNetworkBodies) {
        await recordChatNetworkBodyCapture(tx, {
          chatEventId: inserted.id,
          chatThreadId: thread.threadId,
        });
      }
      if (preferencePlan) {
        await tx
          .insert(orgMembersMetadata)
          .values(preferencePlan.values)
          .onConflictDoUpdate(preferencePlan.conflict);
      }
      await registerCanonicalWebInputAssets(tx, {
        chatThreadId: thread.threadId,
        userId: args.userId,
        orgId: args.orgId,
        files: input.attachFileMetadata,
      });
      if (args.getStartedWorkflowId) {
        await tx.execute(
          recordGetStartedWorkflowSql(
            {
              orgId: args.orgId,
              userId: args.userId,
              workflowId: args.getStartedWorkflowId,
              sourceEventId: inserted.id,
            },
            nowDate(),
          ),
        );
      }
      const plan = queuedChatThreadEnqueuePlan({
        chatThreadId: thread.threadId,
        orgId: args.orgId,
      });
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
    { set },
    args: NormalSendArgs,
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
    const catalog = await set(loadModelCatalog$, signal);
    signal.throwIfAborted();
    if (
      args.body.model !== undefined &&
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
    const db = set(writeDb$);
    if (
      thread.kind === "new" ||
      !shouldTouchThreadSortFromNormalSend(args.agentRunPreCreateSource, false)
    ) {
      return;
    }
    await attemptChatEventSideEffect("thread_touch", thread.threadId, () => {
      return touchSentChatThreadSort(db, {
        userId: args.userId,
        orgId: args.orgId,
        threadId: thread.threadId,
        agentId: thread.agentId,
        touchedAt,
        eventId: args.body.chatThreadSortEventId,
      });
    });
    signal.throwIfAborted();
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
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { args, thread, touchedAt, enqueueCommit } = input;
    const picked = await settle(
      set(
        pickEnqueuedChatThread$,
        {
          orgId: args.orgId,
          chatThreadId: thread.threadId,
          ...(enqueueCommit ? { enqueueCommit } : {}),
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
      readonly runSettings: ThreadRunSettings;
      readonly catalog: ModelCatalog;
      readonly orgPlanCapabilities: OrgPlanCapabilities | null | undefined;
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
        ...args.runSettings,
        reasoningEffort: args.body.runOptions?.reasoningEffort,
        orgPlanCapabilities: args.orgPlanCapabilities,
        catalog: args.catalog,
      },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in modelSelection) {
      return modelSelection;
    }
    return { attachFileMetadata, modelSelection };
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
export const sendNormalEvent$ = command(
  async (
    { set },
    args: NormalSendArgs,
    signal: AbortSignal,
  ): Promise<CreatedChatEventResponse | NormalSendFailure> => {
    const orgPlanCapabilities = args.orgPlanCapabilities;
    signal.throwIfAborted();
    const prepared = await set(prepareNormalSend$, args, signal);
    if ("status" in prepared) {
      return prepared;
    }
    const { authorized, agentRunSource, catalog } = prepared;
    const thread = await set(
      resolveSendThread$,
      {
        ...args,
        orgPlanCapabilities,
        catalog,
        existing:
          "thread" in authorized
            ? { thread: authorized.thread, agentId: authorized.agent.id }
            : undefined,
      },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in thread) {
      return thread;
    }
    const revocation = await set(
      validateSendThreadRevocation$,
      args,
      thread,
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
        runSettings: thread.runSettings,
        orgPlanCapabilities,
        catalog,
      },
      signal,
    );
    if ("status" in input) {
      return input;
    }
    const { attachFileMetadata, modelSelection } = input;
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
          { thread, event, attachFileMetadata },
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
    return settledNormalSendResponse(
      args.body,
      thread.threadId,
      enqueued.value,
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

const appendRecallChatEvent$ = command(
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
    const [inserted] = await executeRawRows(
      db,
      chatEventReplacementInsertSql(target, recallChatEventValues(params)),
      chatEventCommandResultSchema,
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
const appendInterruptUserMessage$ = command(
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
      (
        await executeRawRows(
          db,
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
          chatEventCommandResultSchema,
        )
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
          chatThreadOrganizationCondition(db, orgId),
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
    const orgPlanCapabilities = await get(organizationPlanCapabilities$);
    signal.throwIfAborted();
    return await set(
      sendNormalEvent$,
      {
        body,
        auth,
        userId: auth.userId,
        orgId: auth.orgId,
        orgPlanCapabilities,
      },
      signal,
    );
  },
);
