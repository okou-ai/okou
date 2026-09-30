import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import { resolveChatInputModelSelection } from "./chat-input-model.service";
import { resolveRequiredDefaultChatThreadModelPin } from "./chat-thread-model.service";
import { randomUUID } from "node:crypto";
import { linkLayoutSegment } from "@okouai/api-contracts/contracts/link-layout";
import { command, type Computed } from "ccstate";
import {
  chatEventsContract,
  resolveChatEventRecommendedFollowups,
  type CodexServiceTier,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  modelSettingsSchema,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { SupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  chatEvents,
  type ChatEventAttachFileMetadata,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/schema/computer-use-host";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { agents } from "@okouai/db/schema/agent";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { organizationAuthContext$ } from "../auth/auth-context";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { nowDate } from "../../lib/time";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import {
  loadModelCatalog,
  resolveCatalogRunModel,
  type ModelCatalog,
} from "./model-catalog.service";
import type { Tx } from "../../lib/db-types";
import type { AuthContext } from "../../types/auth";
import type {
  AgentRunPreCreateSource,
  AgentRunRequestAgent,
} from "./agent-run-contracts";
import { recordGetStartedWorkflow } from "./get-started-workflow.service";
import { resolveChatReasoningEffort } from "./chat-reasoning-effort.service";
import {
  enqueueChatInput,
  scheduleEnqueuedChatThreadPick$,
} from "./chat-thread-queue-drain.service";
import { loadPendingChatQueueEvent } from "./chat-event-queue.service";
import type { ChatInputEnqueueCommit } from "./chat-input-enqueue-observation";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
  type CancelRunResult,
} from "./run-cancel.service";
import {
  catalogModelOffersUltrafast,
  isCatalogFastServiceTierSupported,
} from "./model-route-capabilities.service";
import { loadNewChatThreadDefaults } from "./chat-thread-defaults.service";
import {
  appendChatThreadCreatedEvent,
  insertChatThread,
} from "./chat-thread-create.service";
import { touchSentChatThreadSort } from "./chat-event-shared.service";
import { attemptChatEventSideEffect } from "./chat-event-write-side-effects.service";
import {
  revokeChatEvent,
  insertChatEvent,
  insertChatEventContext,
  type NewChatEvent,
  replaceChatEvent,
} from "./chat-event.service";
import {
  officialWorkflowQueueContextId,
  webChatContextId,
} from "./web-chat-queue-context.service";
import { buildGenerationTemplatePrompt } from "../../lib/generation-template-prompt";
import { selectedUserPresentationTemplateIds } from "./presentation-template-data.service";
import {
  agentRunSourceTitleSnapshot,
  hasAgentRunSourceAnnotation,
  projectUserMessage,
  userMessagePhysicalFiles,
  withAgentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
} from "./chat-user-message.service";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import {
  organizationPlanCapabilities$,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { registerCanonicalWebInputAssets } from "./canonical-asset.service";
import { uploadedArtifactObject } from "./uploaded-artifact.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import {
  canonicalChatEventContent,
  canonicalChatEventError,
} from "./canonical-chat-event-read.service";
import { bestEffort, settle } from "../utils";
import { recordChatNetworkBodyCapture } from "./chat-network-body-capture.service";

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
  readonly model?: SupportedRunModel;
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

type OrganizationAuthContext = AuthContext & { readonly orgId: string };

interface NormalSendArgs {
  readonly body: NormalSendBody;
  readonly auth: OrganizationAuthContext;
  /** Only the verified /mcp service supplies this; never read it from the send body. */
  readonly mcpSource?: Extract<
    UserMessageDocument["parts"][number],
    { type: "source"; kind: "mcp" }
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
  readonly orgPlanCapabilities$?: Computed<Promise<OrgPlanCapabilities | null>>;
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
  | { readonly kind: "available" }
  | { readonly kind: "accepted"; readonly createdAt: Date }
  | { readonly kind: "conflict" };

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

async function resolveChatAgentRunSourceById(
  db: Db,
  auth: OrganizationAuthContext,
  sourceRunId: string,
): Promise<{
  readonly annotation: ChatAgentRunSourceAnnotation | null;
} | null> {
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
}

/**
 * Resolve the server-owned source annotation this send stores in its input.
 * Only the source's identity is checked here; the child autonomy budget is
 * admitted when the input is picked.
 */
async function resolveNormalSendAgentRunSource(params: {
  readonly db: Db;
  readonly auth: OrganizationAuthContext;
  readonly userMessage: UserMessageDocument;
  readonly sourceRunId: string | undefined;
}): Promise<
  | {
      readonly source: ChatAgentRunSourceAnnotation | null;
    }
  | {
      readonly response: ReturnType<typeof badRequestMessage>;
    }
> {
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
    const resolved = await resolveChatAgentRunSourceById(
      params.db,
      params.auth,
      params.sourceRunId,
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
  const resolved = await resolveChatAgentRunSourceById(
    params.db,
    params.auth,
    params.auth.runId,
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
}

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

/**
 * Settle a send whose client event id already names a stored input. A
 * retried send is accepted again whatever happened to its input since (a
 * run, a rejection, a recall); only a different thread or owner, or a
 * non-prompt event, conflict.
 */
async function resolveClientEventId(
  db: Db,
  params: {
    readonly clientEventId: string;
    readonly orgId: string;
    readonly threadId: string;
    readonly userId: string;
  },
): Promise<ClientEventIdResolution> {
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
}

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

async function loadAgentForChatSend(
  db: Db,
  agentId: string,
): Promise<AgentForChatSend | undefined> {
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
  return agent;
}

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

async function loadAuthorizedAgent(
  db: Db,
  args: NormalSendArgs,
): Promise<AgentForChatSend | NormalSendFailure> {
  return authorizeSendAgent(
    args,
    args.preloadedAgent ?? (await loadAgentForChatSend(db, args.body.agentId)),
  );
}

async function loadExistingSendThreadRow(
  db: Db,
  args: NormalSendArgs,
  threadId: string,
) {
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
  return thread;
}

type ExistingSendThreadRow = NonNullable<
  Awaited<ReturnType<typeof loadExistingSendThreadRow>>
>;

/**
 * Authorize an existing-thread send with two independent primary-key reads:
 * the caller's thread and the requested agent. The thread's organization is
 * its agent's, so a thread whose agent is the authorized agent is in scope.
 */
async function loadAuthorizedExistingSendThread(
  db: Db,
  args: NormalSendArgs,
  threadId: string,
): Promise<
  | { readonly agent: AgentForChatSend; readonly thread: ExistingSendThreadRow }
  | NormalSendFailure
> {
  const [thread, loadedAgent] = await Promise.all([
    loadExistingSendThreadRow(db, args, threadId),
    args.preloadedAgent ?? loadAgentForChatSend(db, args.body.agentId),
  ]);
  const agent = authorizeSendAgent(args, loadedAgent);
  if ("status" in agent) {
    return agent;
  }
  if (!thread || thread.agentId !== agent.id) {
    return notFound("Chat thread not found");
  }
  return { agent, thread };
}

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
  if (
    requestedTier === "ultrafast" &&
    !catalogModelOffersUltrafast(catalog, selectedModel)
  ) {
    return badRequestMessage("Astra Ultrafast is unavailable for this model");
  }
  // A model or run-option selection carries its tier; an effort-only change
  // or a send without selections keeps the thread's stored tier.
  const keepsStoredTier =
    requestedTier === undefined &&
    (body.runOptions?.reasoningEffort !== undefined ||
      (body.model === undefined && body.runOptions === undefined));
  return {
    selectedModel,
    modelSettings: effort.modelSettings,
    modelSettingsPatch: effort.modelSettingsPatch,
    codexServiceTier: keepsStoredTier
      ? current.codexServiceTier
      : (requestedTier ?? null),
  };
}

/**
 * Apply the send's explicit Computer Use or cloud browser selection. Only an
 * explicitly selected host is looked up: it is written to the thread, so it
 * must belong to the caller. The pick re-checks the thread's host.
 */
async function requestedThreadComputerAccess(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly body: NormalSendBody;
  readonly current: ThreadComputerAccess;
}): Promise<ThreadComputerAccess | ReturnType<typeof notFound>> {
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
  const [host] = await params.db
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
  if (!host) {
    return notFound("Computer-use host not found");
  }
  return { computerUseHostId: host.id, cloudBrowserEnabled: false };
}

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

async function resolveExistingSendThread(
  db: Db,
  args: NormalSendArgs,
  thread: ExistingSendThreadRow,
  agentId: string,
): Promise<ExistingSendThread | NormalSendFailure> {
  const current = {
    selectedModel: thread.selectedModel,
    modelSettings: modelSettingsSchema.parse(thread.modelSettings),
    modelSettingsPatch: undefined,
    codexServiceTier: thread.codexServiceTier,
    computerUseHostId: thread.computerUseHostId,
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
  };
  const runSettings = requestedThreadRunSettings(
    await loadModelCatalog(db),
    args.body,
    current,
  );
  if ("status" in runSettings) {
    return runSettings;
  }
  const computerAccess = await requestedThreadComputerAccess({
    db,
    orgId: args.orgId,
    userId: args.userId,
    body: args.body,
    current,
  });
  if ("status" in computerAccess) {
    return computerAccess;
  }
  return {
    kind: "existing",
    threadId: thread.id,
    agentId,
    runSettings,
    computerAccess,
    current,
  };
}

async function resolveNewSendThread(
  db: Db,
  args: NormalSendArgs,
  orgPlanCapabilities: OrgPlanCapabilities | null | undefined,
): Promise<NewSendThread | NormalSendFailure> {
  if (args.body.revokesEventId !== undefined) {
    return badRequestMessage("Recommended follow-up is no longer available");
  }
  const member = { orgId: args.orgId, userId: args.userId };
  const initialModel =
    args.body.model === undefined
      ? await resolveRequiredDefaultChatThreadModelPin(
          db,
          member,
          orgPlanCapabilities,
        )
      : null;
  const defaults = await loadNewChatThreadDefaults(db, member);
  const runSettings = requestedThreadRunSettings(
    await loadModelCatalog(db),
    args.body,
    {
      selectedModel: initialModel?.selectedModel ?? null,
      modelSettings: defaults.modelSettings,
      codexServiceTier:
        initialModel?.serviceTier === "priority"
          ? "fast"
          : initialModel?.serviceTier === "ultrafast"
            ? "ultrafast"
            : null,
    },
  );
  if ("status" in runSettings) {
    return runSettings;
  }
  const computerAccess = await requestedThreadComputerAccess({
    db,
    ...member,
    body: args.body,
    current: {
      computerUseHostId: null,
      cloudBrowserEnabled:
        args.body.computerUseHostId === undefined &&
        defaults.cloudBrowserEnabled,
    },
  });
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
}

/**
 * The minimal new thread row, written in the enqueue transaction with its
 * first input. Returns false when a client thread id already names a thread.
 */
async function insertNewSendThread(
  tx: Tx,
  args: NormalSendArgs,
  thread: NewSendThread,
): Promise<boolean> {
  const created = await insertChatThread(tx, {
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
  if (!created) {
    return false;
  }
  await appendChatThreadCreatedEvent(tx, {
    orgId: args.orgId,
    eventId: args.body.chatThreadEventId,
    thread: created,
  });
  return true;
}

/** Persist the send's selections that differ from the existing thread. */
async function updateExistingSendThread(
  tx: Tx,
  args: NormalSendArgs,
  thread: ExistingSendThread,
): Promise<void> {
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
    return;
  }
  const updatedAt = nowDate();
  await tx
    .update(chatThreads)
    .set({
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
    })
    .where(
      and(
        eq(chatThreads.id, thread.threadId),
        eq(chatThreads.userId, args.userId),
      ),
    );
  const event = {
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.threadId,
    agentId: thread.agentId,
    createdAt: updatedAt,
  };
  if (modelChanged) {
    await appendChatThreadEvent(tx, {
      ...event,
      kind: "model_selection_updated",
      selectedModel,
      modelSettingsPatch: runSettings.modelSettingsPatch,
    });
  }
  if (tierChanged) {
    await appendChatThreadEvent(tx, {
      ...event,
      kind: "service_tier_updated",
      serviceTier: chatThreadServiceTierFromCodex(codexServiceTier),
    });
  }
  if (accessChanged) {
    await appendChatThreadEvent(tx, {
      ...event,
      kind: "computer_use_host_updated",
      ...computerAccess,
    });
  }
}

/** An explicit model selection also becomes the member's default for new chats. */
async function updateUserModelPreference(
  tx: Tx,
  args: NormalSendArgs,
  runSettings: ThreadRunSettings,
): Promise<void> {
  const selectedModel = args.body.model;
  if (selectedModel === undefined) {
    return;
  }
  const serviceTier = chatThreadServiceTierFromCodex(
    runSettings.codexServiceTier,
  );
  const patch = runSettings.modelSettingsPatch;
  const nowValue = nowDate();
  await tx
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      selectedModel,
      serviceTier,
      ...(patch === undefined
        ? {}
        : { modelSettings: { [patch.model]: { effort: patch.effort } } }),
      createdAt: nowValue,
      updatedAt: nowValue,
    })
    .onConflictDoUpdate({
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
    });
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

function normalSendEvent(params: {
  readonly modelSelection: ChatInputModelSelection;
  readonly id: string;
  readonly threadId: string;
  readonly userMessage: UserMessageDocument;
  readonly triggerSource: "web" | "agent";
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
  readonly requiredOfficialWorkflowIds: readonly string[] | undefined;
}): Extract<NewChatEvent, { readonly eventType: "input.prompt" }> & {
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

/**
 * Settle a new-thread send that collided with a committed one: a retry of
 * that send is accepted again, while a client thread id or client event id
 * reused for different input is refused.
 */
async function resolveNewThreadSendCollision(
  db: Db,
  args: NormalSendArgs,
  thread: NewSendThread,
  collision: "thread" | "input",
): Promise<CreatedChatEventResponse | NormalSendFailure> {
  if (args.body.clientEventId !== undefined) {
    const prior = clientEventIdResolutionResponse(
      await resolveClientEventId(db, {
        clientEventId: args.body.clientEventId,
        orgId: args.orgId,
        threadId: thread.threadId,
        userId: args.userId,
      }),
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
  if (!firstInput) {
    return badRequestMessage("Client thread id is already in use");
  }
  return acceptedSendResponse(thread.threadId, firstInput.createdAt, true);
}

/**
 * The enqueue transaction's input write: a new thread's minimal row, the
 * entry-owned context row, the run-less `input.prompt`, the thread and member
 * selections it carries, and its attachment references. Returns null when an
 * existing thread already has this input.
 */
async function appendNormalSendInput(
  tx: Tx,
  args: NormalSendArgs,
  input: {
    readonly thread: SendThread;
    readonly event: ReturnType<typeof normalSendEvent>;
    readonly attachFileMetadata: readonly ChatEventAttachFileMetadata[];
  },
): Promise<{ readonly id: string; readonly createdAt: Date } | null> {
  const { thread, event } = input;
  if (thread.kind === "new" && !(await insertNewSendThread(tx, args, thread))) {
    throw new NewThreadSendCollision("thread");
  }
  await insertChatEventContext(tx, event);
  const inserted = args.body.revokesEventId
    ? await replaceChatEvent(tx, args.body.revokesEventId, event)
    : await insertChatEvent(tx, event, "id");
  if (!inserted) {
    if (thread.kind === "new") {
      throw new NewThreadSendCollision("input");
    }
    return null;
  }
  if (thread.kind === "existing") {
    await updateExistingSendThread(tx, args, thread);
  }
  if (args.body.captureNetworkBodies) {
    await recordChatNetworkBodyCapture(tx, {
      chatEventId: inserted.id,
      chatThreadId: thread.threadId,
    });
  }
  await updateUserModelPreference(tx, args, thread.runSettings);
  await registerCanonicalWebInputAssets(tx, {
    chatThreadId: thread.threadId,
    userId: args.userId,
    orgId: args.orgId,
    files: input.attachFileMetadata,
  });
  if (args.getStartedWorkflowId) {
    await recordGetStartedWorkflow(tx, {
      orgId: args.orgId,
      userId: args.userId,
      workflowId: args.getStartedWorkflowId,
      sourceEventId: inserted.id,
    });
  }
  return inserted;
}

/**
 * Everything a send checks before it enqueues: the agent and the thread (or
 * the new thread's selections), the server-owned source annotation, and a
 * follow-up revocation. A retried client event id is settled by the enqueue's
 * own insert.
 */
async function prepareNormalSend(
  db: Db,
  args: NormalSendArgs,
  orgPlanCapabilities: OrgPlanCapabilities | null | undefined,
  signal: AbortSignal,
): Promise<
  | {
      readonly thread: SendThread;
      readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
    }
  | NormalSendFailure
  | CreatedChatEventResponse
> {
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
      ? await loadAuthorizedAgent(db, args)
      : await loadAuthorizedExistingSendThread(db, args, existingThreadId);
  signal.throwIfAborted();
  if ("status" in authorized) {
    return authorized;
  }
  const source = await resolveNormalSendAgentRunSource({
    db,
    auth: args.auth,
    userMessage: args.body.userMessage,
    sourceRunId: args.body.sourceRunId,
  });
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
  const thread =
    "thread" in authorized
      ? await resolveExistingSendThread(
          db,
          args,
          authorized.thread,
          authorized.agent.id,
        )
      : await resolveNewSendThread(db, args, orgPlanCapabilities);
  signal.throwIfAborted();
  if ("status" in thread) {
    return thread;
  }
  if (thread.kind === "existing") {
    const revocation = await validateNormalRevocationTarget({
      db,
      threadId: thread.threadId,
      revokesEventId: args.body.revokesEventId,
      clientEventId: args.body.clientEventId,
    });
    signal.throwIfAborted();
    if (revocation) {
      return revocation;
    }
  }
  return { thread, agentRunSource: source.source };
}

/** A direct user message moves its thread's sidebar recency after the pick. */
function normalSendThreadTouch(
  db: Db,
  args: NormalSendArgs,
  thread: SendThread,
  touchedAt: Date,
): (() => Promise<void>) | undefined {
  if (
    thread.kind === "new" ||
    !shouldTouchThreadSortFromNormalSend(args.agentRunPreCreateSource, false)
  ) {
    return undefined;
  }
  return async () => {
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
  };
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
export const sendNormalEvent$ = command(
  async (
    { get, set },
    args: NormalSendArgs,
    signal: AbortSignal,
  ): Promise<CreatedChatEventResponse | NormalSendFailure> => {
    const db = set(writeDb$);
    const orgPlanCapabilities =
      args.orgPlanCapabilities$ === undefined
        ? undefined
        : await get(args.orgPlanCapabilities$);
    signal.throwIfAborted();
    // An explicit model the catalog (or this runtime) cannot resolve is an
    // error, never a silent switch to the system default. Stored thread
    // selections keep their existing fallback.
    if (
      args.body.model !== undefined &&
      resolveCatalogRunModel(await loadModelCatalog(db), args.body.model) ===
        null
    ) {
      return badRequestMessage(`Unknown model "${args.body.model}"`);
    }
    signal.throwIfAborted();
    const prepared = await prepareNormalSend(
      db,
      args,
      orgPlanCapabilities,
      signal,
    );
    if ("status" in prepared) {
      return prepared;
    }
    const { thread, agentRunSource } = prepared;
    const attachFileMetadata = await set(
      resolveIncomingAttachFileMetadata$,
      {
        userId: args.userId,
        orgId: args.orgId,
        userMessage: args.body.userMessage,
      },
      signal,
    );
    const modelSelection = await resolveChatInputModelSelection(db, {
      orgId: args.orgId,
      userId: args.userId,
      ...thread.runSettings,
      reasoningEffort: args.body.runOptions?.reasoningEffort,
      orgPlanCapabilities,
    });
    signal.throwIfAborted();
    if ("status" in modelSelection) {
      return modelSelection;
    }
    const event = normalSendEvent({
      modelSelection,
      id: args.body.clientEventId ?? randomUUID(),
      threadId: thread.threadId,
      userMessage:
        agentRunSource !== null
          ? withAgentRunSourceAnnotation(args.body.userMessage, agentRunSource)
          : args.mcpSource === undefined
            ? args.body.userMessage
            : {
                ...args.body.userMessage,
                parts: [...args.body.userMessage.parts, args.mcpSource],
              },
      triggerSource: normalSendTriggerSource(args.auth),
      agentRunSource,
      requiredOfficialWorkflowIds: args.requiredOfficialWorkflowIds,
    });
    const member = { userId: args.userId, orgId: args.orgId };
    const enqueued = await settle(
      (async () => {
        let createdAt: Date | undefined;
        let enqueueCommit: ChatInputEnqueueCommit | undefined;
        const eventId = await enqueueChatInput(db, {
          chatThreadId: thread.threadId,
          orgId: args.orgId,
          onCommitted: (receipt) => {
            enqueueCommit = receipt;
          },
          appendInput: async (tx) => {
            const inserted = await appendNormalSendInput(tx, args, {
              thread,
              event,
              attachFileMetadata,
            });
            createdAt = inserted?.createdAt;
            return inserted?.id ?? null;
          },
        });
        if (eventId === null || createdAt === undefined) {
          return null;
        }
        // Scheduled right after the commit, before the request's abort is
        // observed. The sidebar touch and the UI realtime events go last,
        // after the pick, whatever its outcome.
        set(
          scheduleEnqueuedChatThreadPick$,
          {
            orgId: args.orgId,
            chatThreadId: thread.threadId,
            ...(enqueueCommit ? { enqueueCommit } : {}),
            touch: normalSendThreadTouch(db, args, thread, createdAt),
            publish: async () => {
              await publishChatEventCreated({
                ...member,
                threadId: thread.threadId,
              });
              await publishThreadListChangedSafely(member);
            },
          },
          signal,
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
        return await resolveNewThreadSendCollision(
          db,
          args,
          thread,
          enqueued.error.collision,
        );
      }
      throw enqueued.error;
    }
    if (enqueued.value === null) {
      // A conflict on the insert is accepted as a duplicate without a
      // lookup. Only a follow-up with a server-generated id cannot have
      // collided on its id, so its conflict is the revoke edge taken
      // concurrently.
      return args.body.revokesEventId && args.body.clientEventId === undefined
        ? conflict("Recommended follow-up has already been used")
        : acceptedSendResponse(thread.threadId, nowDate(), true);
    }
    return acceptedSendResponse(thread.threadId, enqueued.value, false);
  },
);

async function appendRecallChatEvent(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly revokesEventId: string;
  readonly clientEventId: string | undefined;
}): Promise<AppendEventResult> {
  const db = params.db;
  const pendingTarget = await loadPendingChatQueueEvent(db, {
    chatThreadId: params.threadId,
    eventId: params.revokesEventId,
  });
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
  if (existingRevoker) {
    if (
      existingRevoker.eventType === "control.revoke" &&
      existingRevoker.content === null
    ) {
      return { ok: true, createdAt: existingRevoker.createdAt };
    }
    return {
      ok: false,
      message: "Only queued user messages can be recalled",
    };
  }

  const [target] = await db
    .select({
      error: canonicalChatEventError(),
      revokesEventId: chatEvents.revokesEventId,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, params.revokesEventId),
        eq(chatEvents.chatThreadId, params.threadId),
        chatEventTypeIn(["input.prompt", "input.automation", "input.rejected"]),
      ),
    )
    .limit(1);
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
    if (!exists) {
      // Older queue-first recalls deleted the message row, so a repeated
      // request can still find nothing during rollout.
      return { ok: true, createdAt: nowDate() };
    }
    return {
      ok: false,
      message: "Only queued user messages can be recalled",
    };
  }

  const inserted = await revokeChatEvent(db, params.revokesEventId, {
    ...(params.clientEventId ? { id: params.clientEventId } : {}),
    chatThreadId: params.threadId,
    eventType: "control.revoke",
    runId: null,
  });
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
  if (!resolved) {
    // A concurrent claim or rejection won the revoke edge.
    return {
      ok: false,
      message: "Only queued user messages can be recalled",
    };
  }
  return { ok: true, createdAt: resolved.createdAt };
}

/**
 * A follow-up revocation must target an available recommendation whose edge
 * is still free. When this client event id already holds the edge, the send
 * is a retry of that follow-up and is accepted again with its stored time.
 */
async function validateNormalRevocationTarget(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly revokesEventId: string | undefined;
  readonly clientEventId: string | undefined;
}): Promise<NormalSendFailure | CreatedChatEventResponse | undefined> {
  if (!params.revokesEventId) {
    return undefined;
  }

  const [target] = await params.db
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
  if (!target || resolveChatEventRecommendedFollowups(target).length === 0) {
    return badRequestMessage("Recommended follow-up is no longer available");
  }

  const [existingRevoker] = await params.db
    .select({ id: chatEvents.id, createdAt: chatEvents.createdAt })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, params.threadId),
        eq(chatEvents.revokesEventId, params.revokesEventId),
      ),
    )
    .limit(1);
  if (existingRevoker) {
    // Postgres returns the uuid lowercase; the request may use any case.
    return existingRevoker.id === params.clientEventId?.toLowerCase()
      ? acceptedSendResponse(params.threadId, existingRevoker.createdAt, true)
      : conflict("Recommended follow-up has already been used");
  }

  return undefined;
}

async function appendInterruptUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly interruptsRunId: string;
  readonly clientEventId: string | undefined;
}): Promise<AppendEventResult> {
  const db = params.db;
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
  if (!targetRun) {
    return {
      ok: false,
      message: "Only active chat runs can be interrupted",
    };
  }

  const inserted = await insertChatEvent(
    db,
    {
      ...(params.clientEventId ? { id: params.clientEventId } : {}),
      chatThreadId: params.threadId,
      eventType: "control.interrupt",
      content: null,
      interruptsRunId: params.interruptsRunId,
    },
    "any",
  );
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
  if (!resolved) {
    return { ok: false, message: "Failed to insert interrupt user message" };
  }
  return { ok: true, createdAt: resolved.createdAt };
}

async function publishChatEventCreated(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly threadId: string;
}): Promise<void> {
  await publishChatThreadMessageCreatedSafely(args);
}

async function assertOwnedThread(
  db: Db,
  threadId: string,
  userId: string,
  orgId: string,
): Promise<ReturnType<typeof notFound> | undefined> {
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
  return thread ? undefined : notFound("Chat thread not found");
}

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
    const db = set(writeDb$);
    const ownership = await assertOwnedThread(
      db,
      args.body.threadId,
      args.userId,
      args.orgId,
    );
    signal.throwIfAborted();
    if (ownership) {
      return ownership;
    }

    const result = await appendRecallChatEvent({
      db,
      threadId: args.body.threadId,
      revokesEventId: args.body.revokesEventId,
      clientEventId: args.body.clientEventId,
    });
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
    const db = set(writeDb$);
    const ownership = await assertOwnedThread(
      db,
      args.body.threadId,
      args.userId,
      args.orgId,
    );
    signal.throwIfAborted();
    if (ownership) {
      return ownership;
    }

    const result = await appendInterruptUserMessage({
      db,
      threadId: args.body.threadId,
      interruptsRunId: args.body.interruptsRunId,
      clientEventId: args.body.clientEventId,
    });
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
        orgPlanCapabilities$: organizationPlanCapabilities$,
      },
      signal,
    );
  },
);
