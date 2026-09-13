import {
  modelSettingsSchema,
  type ModelSettings,
  type ModelSettingsPatch,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  resolveChatReasoningEffort,
  resolveReasoningEffortForDispatch,
} from "./chat-reasoning-effort.service";
/** Canonical ChatEvent write commands. */
import { loadIntroVideoTemplateAccess } from "./intro-video-access.service";
import { randomBytes } from "node:crypto";
import { command } from "ccstate";
import type { ChatEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  chatEventsContract,
  resolveChatEventRecommendedFollowups,
  type ChatRunVideoOptionsRequest,
  type ChatThreadServiceTier,
  type CodexServiceTier,
  type GenerationTemplateRequest,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  isBuiltInModelProviderType,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  chatEvents,
  type ChatEventAttachFileMetadata,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { computerUseHosts } from "@okouai/db/schema/computer-use-host";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { agents } from "@okouai/db/schema/agent";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { organizationAuthContext$ } from "../auth/auth-context";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { now, nowDate } from "../../lib/time";
import {
  autonomyBudgetExhausted,
  badRequestMessage,
  conflict,
  insufficientCredits,
  modelProviderUnavailable,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { env } from "../../lib/env";
import type { AuthContext } from "../../types/auth";
import {
  createQueueFirstAgentRun$,
  type AgentRunPreCreateSource,
} from "./agent-runs-create.service";
import { isQueueFirstRunClaimLost } from "./agent-run-create.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { childAutonomyBudget } from "./autonomy-budget.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import { loadPendingChatQueueEvent } from "./chat-event-queue.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
  type CancelRunResult,
} from "./run-cancel.service";
import { scheduleChatThreadTitleGeneration } from "./chat-title.service";
import { generateAndPersistInitialThinkingMessage } from "./chat-initial-thinking.service";
import {
  isCodexFastServiceTierSupported,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  modelProviderWriteTypeForLaunch,
  type ModelFirstPin,
  resolveModelFirstProviderAdmission,
  resolveModelSelectionPin,
} from "./model-selection.service";
import {
  chatThreadModelPinColumns,
  persistedChatThreadModelSnapshotColumns,
  resolvePersistedChatThreadModel,
  type PersistedChatThreadModelResolutionPath,
} from "./chat-thread-model.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import { touchChatThreadLastMessageAt } from "./chat-event-shared.service";
import {
  revokeChatEvent,
  insertChatEvent,
  type NewChatEvent,
  replaceChatEvent,
} from "./chat-event.service";
import {
  officialWorkflowQueueContextId,
  webChatPublicBrandContextId,
} from "./web-chat-public-brand-context.service";
import { chatThreadAdmissionBlocked } from "./chat-active-run.service";
import {
  agentRunSourceTitleSnapshot,
  hasAgentRunSourceAnnotation,
  projectUserMessage,
  userMessagePhysicalFiles,
  withAgentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
} from "./chat-user-message.service";
import { appendQueuedRunAssistantMarker } from "./chat-queue-marker.service";
import {
  discardUnclaimedUserMessage,
  loadNextUnclaimedQueuedUserMessage,
  loadNextUnclaimedQueuedUserMessageId,
  lockUserMessageQueueThread,
} from "./chat-queued-event.service";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
  type ChatThreadEventTransaction,
} from "./chat-thread-event.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { registerCanonicalWebInputAssets } from "./canonical-asset.service";
import { resolveArtifactObject$ } from "./artifact-storage.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import {
  resolveBuiltInModelRuntimeRoute,
  type BuiltInModelRuntimeRoute,
} from "./built-in-model-runtime-route.service";
import {
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "./chat-event-type.service";
import {
  canonicalChatEventContent,
  canonicalChatEventError,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { shouldUsePiExecution } from "./pi-sandbox-config";
import {
  buildWebChatAppendSystemPrompt,
  type WebChatSessionPromptContext,
} from "./web-chat-session-prompt.service";
import { bestEffort } from "../utils";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isCodexFastModeEnabled } from "@okouai/core/model-feature-switch";
import { buildGenerationTemplatePrompt } from "../../lib/generation-template-prompt";
import { buildVideoRunOptionsPrompt } from "@okouai/core/video-run-options-prompt";
import {
  additionalVolumesForRun,
  authorizedUserPresentationTemplateIds,
  selectedUserPresentationTemplateIds,
  userPresentationTemplateVolumes,
  type PresentationTemplateVolume,
} from "./presentation-template-data.service";
import { resolveThreadGenerationTemplatePrompt } from "../../lib/thread-generation-template";
import {
  logTemplateUsage,
  type TemplateUsageLogContext,
} from "../../lib/template-usage-log";
import type { GenerationTemplateIdentity } from "@okouai/core/generation-template-identity";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

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
  readonly modelSelection?: {
    readonly modelProviderId: string;
    readonly selectedModel: string;
  } | null;
  readonly runOptions?: {
    readonly codexServiceTier?: CodexServiceTier;
    readonly reasoningEffort?: ReasoningEffort;
    readonly video?: ChatRunVideoOptionsRequest;
  };
  readonly userMessage: UserMessageDocument;
  readonly hasTextContent: boolean;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly clientEventId?: string;
  readonly realAgentInPreview?: boolean;
  readonly captureNetworkBodies?: boolean;
  readonly revokesEventId?: string;
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

interface AgentForChatSend {
  readonly id: string;
  readonly orgId: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
}

type ThreadModelPin = ModelFirstPin;

interface ResolvedThread {
  readonly threadId: string;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly isNewThread: boolean;
  readonly isClientThreadRetry: boolean;
}

type ModelFirstProviderAdmission = Awaited<
  ReturnType<typeof resolveModelFirstProviderAdmission>
>;

interface ResolvedRunConfiguration {
  readonly reasoningEffort?: ReasoningEffort;
  readonly modelSettings: ModelSettings;
  readonly modelPin: ThreadModelPin;
  readonly providerAdmission: ModelFirstProviderAdmission;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly codexServiceTier: "fast" | undefined;
}

interface ResolvedThreadAndRunConfiguration {
  readonly thread: ResolvedThread;
  readonly runConfiguration: ResolvedRunConfiguration;
  readonly modelResolutionPath?: PersistedChatThreadModelResolutionPath;
}

type IncomingModelSelection = NormalSendBody["modelSelection"];
type OrganizationAuthContext = AuthContext & { readonly orgId: string };

type CanonicalNormalSendBody = NormalSendBody;

interface NormalSendArgs {
  readonly body: CanonicalNormalSendBody;
  readonly auth: OrganizationAuthContext;
  readonly userId: string;
  readonly orgId: string;
  readonly apiStartTime: number;
  readonly publicBrand: PublicBrand;
  readonly preloadedAgent?: AgentForChatSend;
  readonly timing?: ApiDispatchTimingCollector;
  readonly agentRunPreCreateSource?: AgentRunPreCreateSource;
  readonly requiredOfficialWorkflowIds?: readonly string[];
}

interface PreparedNormalSend {
  readonly db: Db;
  readonly agent: AgentForChatSend;
  readonly thread: ResolvedThread;
  readonly body: RuntimeNormalSendBody;
  readonly generationTemplatePrompt: string;
  /**
   * The selections behind that guidance, reported once the run is created.
   * Carried through preparation rather than reported during it: preparation can
   * still fail afterwards, and a queue-first send that stays queued is reported
   * by the claim path instead.
   */
  readonly generationTemplateIdentities: readonly GenerationTemplateIdentity[];
  /**
   * Guidance packages to mount for this run, one per uploaded template the
   * message selected and this caller was authorised for.
   */
  readonly presentationTemplateVolumes: readonly PresentationTemplateVolume[];
  readonly videoRunOptions: ChatRunVideoOptionsRequest | null;
  readonly computerUseHostGrant: ResolvedComputerUseHostGrant | null;
  readonly persistedExplicitSelection: boolean;
  readonly initialThinkingEnabled: boolean;
  readonly attachFileMetadata: ChatEventAttachFileMetadata[] | null;
  readonly runConfiguration: ResolvedRunConfiguration;
  readonly clientEventPrechecked: boolean;
  readonly preflightClientEventConflict:
    | ReturnType<typeof duplicateClientEventIdResponse>
    | undefined;
  readonly triggerSource: "web" | "agent";
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
  readonly piExecution: boolean;
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
  readonly autonomyBudget: number;
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
  return {
    annotation,
    autonomyBudget: source.autonomyBudget,
  };
}

async function resolveChatAgentRunSource(
  db: Db,
  auth: OrganizationAuthContext,
): Promise<{
  readonly annotation: ChatAgentRunSourceAnnotation | null;
  readonly autonomyBudget: number;
} | null> {
  if (auth.tokenType !== "agent") {
    return null;
  }
  return await resolveChatAgentRunSourceById(db, auth, auth.runId);
}

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
      readonly response:
        | ReturnType<typeof badRequestMessage>
        | ReturnType<typeof autonomyBudgetExhausted>;
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
  const resolved = await resolveChatAgentRunSource(params.db, params.auth);
  if (resolved === null) {
    return params.auth.tokenType === "agent"
      ? { response: badRequestMessage("Agent source run not found") }
      : { source: null };
  }
  if (childAutonomyBudget(resolved.autonomyBudget).kind === "exhausted") {
    return { response: autonomyBudgetExhausted() };
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

function normalSendBodyWithAgentRunSource(
  body: CanonicalNormalSendBody,
  source: ChatAgentRunSourceAnnotation | null,
): CanonicalNormalSendBody {
  if (source === null) {
    return body;
  }
  return {
    ...body,
    userMessage: withAgentRunSourceAnnotation(body.userMessage, source),
  };
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

interface NormalSendFeatureSwitches {
  readonly reasoningEffortEnabled: boolean;
  readonly codexFastModeEnabled: boolean;
  readonly introVideoEnabled: boolean;
  /**
   * Carried whole so downstream checks can read it without reloading the
   * switches this request already read.
   */
  readonly featureSwitchContext: FeatureSwitchContext;
}

function initialThinkingForSend(
  args: NormalSendArgs,
  switches: NormalSendFeatureSwitches,
): boolean {
  return (
    args.agentRunPreCreateSource === undefined &&
    !isFeatureEnabled(
      FeatureSwitchKey.ThreadActivitySummary,
      switches.featureSwitchContext,
    )
  );
}

interface RuntimeNormalSendBody extends Omit<
  CanonicalNormalSendBody,
  "userMessage"
> {
  readonly userMessage: UserMessageDocument;
  readonly agentPrompt: string;
  readonly primaryTemplate: GenerationTemplateRequest | undefined;
  readonly templates: readonly GenerationTemplateRequest[];
  readonly hasTextContent: boolean;
}

interface ResolvedComputerUseHostGrant {
  readonly hostId: string;
  readonly displayName: string;
}

type NormalSendFailure =
  | ReturnType<typeof notFound>
  | ReturnType<typeof forbidden>
  | ReturnType<typeof conflict>
  | ReturnType<typeof autonomyBudgetExhausted>
  | ReturnType<typeof insufficientCredits>
  | ReturnType<typeof providerUnavailable>
  | ReturnType<typeof modelProviderUnavailable>
  | ReturnType<typeof badRequestMessage>;

interface CreatedChatEventResponse {
  readonly status: 201;
  readonly body: {
    readonly runId: string | null;
    readonly threadId: string;
    readonly status?: string;
    readonly createdAt: string;
  };
}

type ClientSendResolution =
  | CreatedChatEventResponse
  | ReturnType<typeof conflict>;

type CreateChatThreadResult =
  | {
      readonly id: string;
      readonly clientThreadAlreadyExisted: boolean;
    }
  | ReturnType<typeof notFound>;

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
      readonly kind: "queued";
      readonly createdAt: Date;
      readonly inserted: boolean;
      /** Set only when this call inserted the message (queue-first sends). */
      readonly messageId?: string;
    }
  | {
      readonly kind: "associated";
      readonly runId: string;
      readonly status: string;
      readonly createdAt: Date;
    }
  | {
      readonly kind: "conflict";
    };

interface ExistingClientEventIdRow {
  readonly chatThreadId: string;
  readonly threadUserId: string;
  readonly eventType: ChatEventType;
  readonly content: string | null;
  readonly runId: string | null;
  readonly revokesEventId: string | null;
  readonly error: string | null;
  readonly eventCreatedAt: Date;
  readonly runStatus: string | null;
  readonly runCreatedAt: Date | null;
  readonly replacementEventId: string | null;
  readonly replacementRunId: string | null;
  readonly replacementError: string | null;
  readonly replacementRunStatus: string | null;
  readonly replacementRunCreatedAt: Date | null;
}

const INSUFFICIENT_CREDITS_MARKER = "insufficient_credits";
const replacementChatEvent = alias(chatEvents, "replacement_chat_event");
const replacementAgentRun = alias(agentRuns, "replacement_agent_run");

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function duplicateClientEventIdResponse() {
  return conflict("clientEventId is already in use");
}

function resolveExistingClientEventIdRow(
  row: ExistingClientEventIdRow | undefined,
  params: {
    readonly threadId: string;
    readonly userId: string;
  },
): ClientEventIdResolution {
  if (!row) {
    return { kind: "available" };
  }
  if (
    row.chatThreadId !== params.threadId ||
    row.threadUserId !== params.userId ||
    (row.eventType !== "input.prompt" && row.eventType !== "input.rejected")
  ) {
    return { kind: "conflict" };
  }
  if (
    row.revokesEventId !== null &&
    row.content === null &&
    row.error === null
  ) {
    return { kind: "conflict" };
  }
  if (
    row.eventType === "input.prompt" &&
    row.runId === null &&
    row.replacementEventId === null
  ) {
    return {
      kind: "queued",
      createdAt: row.eventCreatedAt,
      inserted: false,
    };
  }
  if (row.runId !== null && row.runCreatedAt && row.runStatus) {
    return {
      kind: "associated",
      runId: row.runId,
      status: row.runStatus,
      createdAt: row.runCreatedAt,
    };
  }
  if (
    row.replacementRunId !== null &&
    row.replacementRunCreatedAt &&
    row.replacementRunStatus
  ) {
    return {
      kind: "associated",
      runId: row.replacementRunId,
      status: row.replacementRunStatus,
      createdAt: row.replacementRunCreatedAt,
    };
  }
  if (row.replacementError === INSUFFICIENT_CREDITS_MARKER) {
    return {
      kind: "queued",
      createdAt: row.eventCreatedAt,
      inserted: false,
    };
  }
  return { kind: "conflict" };
}

async function resolveClientEventId(
  db: Db,
  params: {
    readonly clientEventId: string;
    readonly orgId: string;
    readonly threadId: string;
    readonly userId: string;
  },
): Promise<ClientEventIdResolution> {
  const [event] = await db
    .select({
      chatThreadId: chatEvents.chatThreadId,
      threadUserId: chatThreads.userId,
      eventType: chatEvents.eventType,
      content: canonicalChatEventContent(),
      runId: chatEvents.runId,
      revokesEventId: chatEvents.revokesEventId,
      error: canonicalChatEventError(),
      eventCreatedAt: chatEvents.createdAt,
      runStatus: agentRuns.status,
      runCreatedAt: agentRuns.createdAt,
      replacementEventId: replacementChatEvent.id,
      replacementRunId: replacementChatEvent.runId,
      replacementError: canonicalChatEventError(replacementChatEvent.payload),
      replacementRunStatus: replacementAgentRun.status,
      replacementRunCreatedAt: replacementAgentRun.createdAt,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .leftJoin(
      agentRuns,
      and(eq(agentRuns.id, chatEvents.runId), runOwnedChatEventCondition()),
    )
    .leftJoin(
      replacementChatEvent,
      eq(replacementChatEvent.revokesEventId, chatEvents.id),
    )
    .leftJoin(
      replacementAgentRun,
      and(
        eq(replacementAgentRun.id, replacementChatEvent.runId),
        ne(replacementChatEvent.eventType, "control.interrupt"),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, params.clientEventId),
        chatThreadOrganizationCondition(db, params.orgId),
      ),
    )
    .limit(1);
  return resolveExistingClientEventIdRow(event, params);
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
  if (resolution.kind === "associated") {
    return {
      status: 201,
      body: {
        runId: resolution.runId,
        threadId,
        status: resolution.status,
        createdAt: resolution.createdAt.toISOString(),
      },
    };
  }
  return {
    status: 201,
    body: {
      runId: null,
      threadId,
      createdAt: resolution.createdAt.toISOString(),
    },
  };
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

function modelFirstSelection(
  selectedModel: string,
): NonNullable<NormalSendBody["modelSelection"]> {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

function canonicalNormalSendBody(
  body: NormalSendBody,
): CanonicalNormalSendBody {
  return {
    ...body,
    ...(body.model === undefined
      ? {}
      : { modelSelection: modelFirstSelection(body.model) }),
  };
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function resolveRuntimeNormalSendBody(
  body: CanonicalNormalSendBody,
): RuntimeNormalSendBody {
  const projection = projectUserMessage(body.userMessage);
  return {
    ...body,
    userMessage: body.userMessage,
    primaryTemplate: projection.primaryTemplate,
    templates: projection.templates,
    agentPrompt: projection.agentPrompt,
    hasTextContent: projection.hasTextContent,
  };
}

type NormalSendAttachmentCountBucket = "0" | "1" | "2_4" | "5_plus";

const NORMAL_SEND_ATTACHMENT_METADATA_CONCURRENCY = 4;

function normalSendAttachmentCountBucket(
  count: number,
): NormalSendAttachmentCountBucket {
  if (count === 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  return "5_plus";
}

function unwrapSettledResult<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

const resolveIncomingAttachFileMetadata$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly userMessage: UserMessageDocument;
      readonly timing?: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<ChatEventAttachFileMetadata[] | null> => {
    const files = userMessagePhysicalFiles(args.userMessage);
    return await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_attachment_metadata",
      "nested",
      async () => {
        if (files.length === 0) {
          return null;
        }
        const metadata: ChatEventAttachFileMetadata[] = [];
        for (
          let offset = 0;
          offset < files.length;
          offset += NORMAL_SEND_ATTACHMENT_METADATA_CONCURRENCY
        ) {
          const wave = files.slice(
            offset,
            offset + NORMAL_SEND_ATTACHMENT_METADATA_CONCURRENCY,
          );
          const results = await Promise.allSettled(
            wave.map(async (file) => {
              const object = await set(
                resolveArtifactObject$,
                {
                  userId: args.userId,
                  id: file.fileId,
                  filenameHint: file.filenameSnapshot,
                },
                signal,
              );
              return { file, object };
            }),
          );
          for (const result of results) {
            const { file, object } = unwrapSettledResult(result);
            signal.throwIfAborted();
            if (!object) {
              throw new Error(
                `User-message attachment not found: ${file.fileId}`,
              );
            }
            metadata.push({
              id: file.fileId,
              filename: file.filenameSnapshot,
              contentType: file.contentType,
              size: object.size,
              objectKey: object.key,
              publicBrand: object.publicBrand,
            });
          }
        }
        return metadata;
      },
      {
        normal_send_attachment_count_bucket: normalSendAttachmentCountBucket(
          files.length,
        ),
      },
    );
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

async function resolveClientEventSend(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly clientEventId: string | undefined;
}): Promise<ClientSendResolution | undefined> {
  if (!params.clientEventId) {
    return undefined;
  }
  const resolution = await resolveClientEventId(params.db, {
    clientEventId: params.clientEventId,
    orgId: params.orgId,
    threadId: params.threadId,
    userId: params.userId,
  });
  return clientEventIdResolutionResponse(resolution, params.threadId);
}

async function resolveClientThreadRetryRun(
  db: Db,
  threadId: string,
): Promise<CreatedChatEventResponse | undefined> {
  const [run] = await db
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, threadId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .orderBy(asc(agentRuns.createdAt))
    .limit(1);
  if (!run) {
    return undefined;
  }

  return {
    status: 201,
    body: {
      runId: run.runId,
      threadId,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
    },
  };
}

function emptyModelFirstThreadPin(): ThreadModelPin {
  return {
    modelProviderId: null,
    modelProviderType: null,
    modelProviderCredentialScope: null,
    selectedModel: null,
  };
}

async function withBuiltInModelRuntimeRoute(
  db: Db,
  configuration: ResolvedRunConfiguration,
): Promise<ResolvedRunConfiguration | NormalSendFailure> {
  if (
    configuration.providerAdmission.error ||
    !isBuiltInModelProviderType(
      configuration.providerAdmission.effectiveModelProvider,
    )
  ) {
    return configuration;
  }
  const selectedModel = configuration.modelPin.selectedModel;
  if (!selectedModel) {
    return providerUnavailable(
      "No model provider configured: no built-in model is selected",
    );
  }
  const builtInModelRuntimeRoute = await resolveBuiltInModelRuntimeRoute(
    db,
    selectedModel,
  );
  return builtInModelRuntimeRoute
    ? { ...configuration, builtInModelRuntimeRoute }
    : modelProviderUnavailable(
        "Every built-in model route for this model is temporarily unavailable",
      );
}

async function resolveExplicitRunConfiguration(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly body: NormalSendBody;
  readonly codexFastModeEnabled: boolean;
  readonly reasoningEffortEnabled: boolean;
  readonly timing?: ApiDispatchTimingCollector;
}): Promise<ResolvedRunConfiguration | NormalSendFailure | undefined> {
  const modelSelection = params.body.modelSelection;
  if (!modelSelection) {
    return undefined;
  }
  const modelPin = await measureApiDispatchTiming(
    params.timing,
    "api_dispatch_pre_create_agent_web_chat_resolve_model_pin",
    "nested",
    () => {
      return resolveModelSelectionPin({
        db: params.db,
        orgId: params.orgId,
        userId: params.userId,
        modelSelection,
      });
    },
  );
  if ("status" in modelPin) {
    return modelPin;
  }
  const modelSettings = await loadNewChatThreadModelSettings(params.db, {
    orgId: params.orgId,
    userId: params.userId,
  });
  const effort = resolveChatReasoningEffort({
    selectedModel: modelPin.selectedModel,
    modelSettings,
    requested: params.body.runOptions?.reasoningEffort,
    enabled: params.reasoningEffortEnabled,
  });
  if ("status" in effort) {
    return effort;
  }
  const providerAdmission = await measureApiDispatchTiming(
    params.timing,
    "api_dispatch_pre_create_agent_web_chat_resolve_provider_admission",
    "nested",
    () => {
      return resolveModelFirstProviderAdmission({
        db: params.db,
        orgId: params.orgId,
        userId: params.userId,
        modelPin,
        requestedModelProvider: undefined,
        externalPlanCapabilities: { kind: "load-current" },
      });
    },
  );
  if (providerAdmission.error && providerAdmission.error.status !== 402) {
    return providerAdmission.error;
  }
  const codexServiceTierError = await measureApiDispatchTiming(
    params.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_validate_codex_service_tier",
    "nested",
    () => {
      return validateCodexServiceTier({
        body: params.body,
        modelPin,
        codexFastModeEnabled: params.codexFastModeEnabled,
      });
    },
  );
  if (codexServiceTierError) {
    return codexServiceTierError;
  }
  return await withBuiltInModelRuntimeRoute(params.db, {
    modelPin,
    providerAdmission,
    reasoningEffort: effort.reasoningEffort,
    modelSettings: effort.modelSettings,
    codexServiceTier: codexServiceTierForRun({
      body: params.body,
      modelPin,
      codexFastModeEnabled: params.codexFastModeEnabled,
    }),
  });
}

async function resolveNormalSendFeatureSwitches(
  db: Db,
  orgId: string,
  userId: string,
  templates: readonly GenerationTemplateRequest[],
): Promise<NormalSendFeatureSwitches> {
  const context = await loadUserFeatureSwitchContext(db, orgId, userId);
  return {
    codexFastModeEnabled: isCodexFastModeEnabled(context),
    reasoningEffortEnabled: isFeatureEnabled(
      FeatureSwitchKey.ChatReasoningEffort,
      context,
    ),
    introVideoEnabled: loadIntroVideoTemplateAccess(templates, context),
    featureSwitchContext: context,
  };
}

/**
 * The two things this message's own selections contribute to its run: the
 * template guidance block and the video options the composer sent with it.
 */
function resolveSelectedTemplateContext(
  runtimeBody: RuntimeNormalSendBody,
  featureSwitches: NormalSendFeatureSwitches,
  mountedUserPresentationTemplateIds: readonly string[],
): {
  readonly generationTemplatePrompt: string;
  readonly generationTemplateIdentities: readonly GenerationTemplateIdentity[];
  readonly videoRunOptions: ChatRunVideoOptionsRequest | null;
} {
  const resolved = resolveThreadGenerationTemplatePrompt({
    introVideoEnabled: featureSwitches.introVideoEnabled,
    explicit: runtimeBody.primaryTemplate,
    explicitTemplates: runtimeBody.templates,
    mountedUserPresentationTemplateIds,
  });
  return {
    generationTemplatePrompt: resolved.prompt,
    generationTemplateIdentities: resolved.identities,
    videoRunOptions: runtimeBody.runOptions?.video ?? null,
  };
}

/**
 * Row ids for the uploaded templates a message selected, in selection order.
 *
 * Authorised here rather than at dispatch: the run mounts one storage volume
 * per id, and a volume the caller may not read must never be assembled at all.
 */
interface AuthorizedGenerationTemplates {
  readonly userPresentationTemplateIds: readonly string[];
}

async function validateGenerationTemplatePrompt(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
  generationTemplates: readonly GenerationTemplateRequest[],
  featureSwitches: NormalSendFeatureSwitches,
): Promise<NormalSendFailure | AuthorizedGenerationTemplates> {
  if (generationTemplates.length === 0) {
    return { userPresentationTemplateIds: [] };
  }
  // Syntax first: every selection this message names is a candidate mount, so
  // the builder can reject a malformed private id before consulting the database.
  const selectedIds = selectedUserPresentationTemplateIds(generationTemplates);
  for (const template of generationTemplates) {
    const validation = buildGenerationTemplatePrompt(template, {
      introVideoEnabled: featureSwitches.introVideoEnabled,
      mountedUserPresentationTemplateIds: selectedIds,
    });
    if (validation.status === "invalid") {
      return badRequestMessage(validation.message);
    }
  }
  const authorizedIds = await authorizedUserPresentationTemplateIds(db, {
    orgId: args.orgId,
    userId: args.userId,
    templateIds: selectedIds,
  });
  if (authorizedIds.length !== selectedIds.length) {
    return badRequestMessage("Presentation template not found");
  }
  return { userPresentationTemplateIds: authorizedIds };
}

async function updateUserModelPreference(
  db: Db,
  params: {
    readonly orgId: string;
    readonly userId: string;
    readonly selectedModel: string;
    readonly serviceTier: ChatThreadServiceTier | null;
    readonly modelSettingsPatch?: ModelSettingsPatch;
  },
): Promise<void> {
  const nowValue = nowDate();
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId: params.orgId,
      userId: params.userId,
      selectedModel: params.selectedModel,
      serviceTier: params.serviceTier,
      ...(params.modelSettingsPatch === undefined
        ? {}
        : {
            modelSettings: {
              [params.modelSettingsPatch.model]: {
                effort: params.modelSettingsPatch.effort,
              },
            },
          }),
      createdAt: nowValue,
      updatedAt: nowValue,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedModel: params.selectedModel,
        serviceTier: params.serviceTier,
        ...(params.modelSettingsPatch === undefined
          ? {}
          : {
              modelSettings: sql`${orgMembersMetadata.modelSettings} || jsonb_build_object(
                cast(${params.modelSettingsPatch.model} as text),
                COALESCE(${orgMembersMetadata.modelSettings} -> cast(${params.modelSettingsPatch.model} as text), '{}'::jsonb)
                  || jsonb_build_object('effort', cast(${params.modelSettingsPatch.effort} as text))
              )`,
            }),
        updatedAt: nowValue,
      },
    });
}

async function maybePersistExplicitModelFirstSelection(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: IncomingModelSelection;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly modelSettingsPatch?: ModelSettingsPatch;
}): Promise<boolean> {
  if (!params.modelSelection) {
    return false;
  }
  if (
    params.modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID
  ) {
    return false;
  }
  await updateUserModelPreference(params.db, {
    orgId: params.orgId,
    userId: params.userId,
    selectedModel: params.modelSelection.selectedModel,
    serviceTier: params.serviceTier,
    modelSettingsPatch: params.modelSettingsPatch,
  });
  return true;
}

async function maybePersistExplicitRunSettings(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly body: NormalSendBody;
  readonly codexServiceTier: CodexServiceTier | undefined;
  readonly modelPin: ThreadModelPin;
}): Promise<void> {
  if (params.body.modelSelection === undefined) {
    return;
  }
  const codexServiceTier = params.codexServiceTier ?? null;
  const reasoningEffort = params.body.runOptions?.reasoningEffort;
  const modelSettingsPatch =
    reasoningEffort !== undefined &&
    isSupportedRunModel(params.modelPin.selectedModel)
      ? { model: params.modelPin.selectedModel, effort: reasoningEffort }
      : undefined;
  await params.db.transaction(async (tx) => {
    const updatedAt = nowDate();
    const [thread] = await tx
      .update(chatThreads)
      .set({
        codexServiceTier,
        ...(modelSettingsPatch === undefined
          ? {}
          : {
              ...chatThreadModelPinColumns(params.modelPin),
              modelSettings: sql`${chatThreads.modelSettings} || jsonb_build_object(
                cast(${modelSettingsPatch.model} as text),
                COALESCE(${chatThreads.modelSettings} -> cast(${modelSettingsPatch.model} as text), '{}'::jsonb)
                  || jsonb_build_object('effort', cast(${modelSettingsPatch.effort} as text))
              )`,
            }),
        updatedAt,
      })
      .where(
        and(
          eq(chatThreads.id, params.threadId),
          eq(chatThreads.userId, params.userId),
          chatThreadOrganizationCondition(tx, params.orgId),
          isNotNull(chatThreads.agentId),
        ),
      )
      .returning({
        id: chatThreads.id,
        agentId: chatThreads.agentId,
        selectedModel: chatThreads.selectedModel,
      });
    if (!thread?.agentId) {
      return;
    }
    if (modelSettingsPatch !== undefined) {
      await appendChatThreadEvent(tx, {
        kind: "model_selection_updated",
        userId: params.userId,
        orgId: params.orgId,
        chatThreadId: thread.id,
        agentId: thread.agentId,
        selectedModel: thread.selectedModel,
        modelSettingsPatch,
        createdAt: updatedAt,
      });
    }
    await appendChatThreadEvent(tx, {
      kind: "service_tier_updated",
      userId: params.userId,
      orgId: params.orgId,
      chatThreadId: thread.id,
      agentId: thread.agentId,
      serviceTier: chatThreadServiceTierFromCodex(codexServiceTier),
      createdAt: updatedAt,
    });
  });
}

function hasComputerUseHostSelection(body: NormalSendBody): boolean {
  return Object.prototype.hasOwnProperty.call(body, "computerUseHostId");
}

function hasCloudBrowserSelection(body: NormalSendBody): boolean {
  return Object.prototype.hasOwnProperty.call(body, "cloudBrowserEnabled");
}

async function updateThreadComputerAccess(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly hostId: string | null;
  readonly cloudBrowserEnabled: boolean;
}): Promise<void> {
  await params.db.transaction(async (tx) => {
    const updatedAt = nowDate();
    const [thread] = await tx
      .update(chatThreads)
      .set({
        computerUseHostId: params.hostId,
        cloudBrowserEnabled: params.cloudBrowserEnabled,
        updatedAt,
      })
      .where(
        and(
          eq(chatThreads.id, params.threadId),
          eq(chatThreads.userId, params.userId),
          chatThreadOrganizationCondition(tx, params.orgId),
          isNotNull(chatThreads.agentId),
        ),
      )
      .returning({
        id: chatThreads.id,
        agentId: chatThreads.agentId,
      });
    if (!thread?.agentId) {
      return;
    }
    await appendChatThreadEvent(tx, {
      kind: "computer_use_host_updated",
      userId: params.userId,
      orgId: params.orgId,
      chatThreadId: thread.id,
      agentId: thread.agentId,
      computerUseHostId: params.hostId,
      cloudBrowserEnabled: params.cloudBrowserEnabled,
      createdAt: updatedAt,
    });
  });
}

async function selectedComputerUseHostGrant(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
}): Promise<ResolvedComputerUseHostGrant | "missing"> {
  const [host] = await params.db
    .select({
      id: computerUseHosts.id,
      displayName: computerUseHosts.displayName,
    })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.id, params.hostId),
        eq(computerUseHosts.orgId, params.orgId),
        eq(computerUseHosts.userId, params.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);
  if (!host) {
    return "missing";
  }
  return {
    hostId: host.id,
    displayName: host.displayName,
  };
}

async function resolveComputerAccess(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly body: NormalSendBody;
  readonly thread: ResolvedThread;
}): Promise<
  | {
      readonly computerUseHostGrant: ResolvedComputerUseHostGrant | null;
    }
  | NormalSendFailure
> {
  const explicitHostSelection = hasComputerUseHostSelection(params.body);
  const explicitCloudBrowserSelection = hasCloudBrowserSelection(params.body);
  let requestedHostId = explicitHostSelection
    ? params.body.computerUseHostId
    : params.thread.computerUseHostId;
  let cloudBrowserEnabled = explicitCloudBrowserSelection
    ? (params.body.cloudBrowserEnabled ?? false)
    : params.thread.cloudBrowserEnabled;

  if (explicitCloudBrowserSelection && cloudBrowserEnabled) {
    requestedHostId = null;
  } else if (requestedHostId) {
    cloudBrowserEnabled = false;
  }

  if (!requestedHostId) {
    if (
      requestedHostId !== params.thread.computerUseHostId ||
      cloudBrowserEnabled !== params.thread.cloudBrowserEnabled
    ) {
      await updateThreadComputerAccess({
        db: params.db,
        orgId: params.orgId,
        threadId: params.thread.threadId,
        userId: params.userId,
        hostId: null,
        cloudBrowserEnabled,
      });
    }
    return { computerUseHostGrant: null };
  }

  const hostGrant = await selectedComputerUseHostGrant({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    hostId: requestedHostId,
  });
  if (hostGrant === "missing") {
    if (explicitHostSelection) {
      return notFound("Computer-use host not found");
    }
    await updateThreadComputerAccess({
      db: params.db,
      orgId: params.orgId,
      threadId: params.thread.threadId,
      userId: params.userId,
      hostId: null,
      cloudBrowserEnabled: false,
    });
    return {
      computerUseHostGrant: null,
    };
  }

  if (
    requestedHostId !== params.thread.computerUseHostId ||
    cloudBrowserEnabled !== params.thread.cloudBrowserEnabled
  ) {
    await updateThreadComputerAccess({
      db: params.db,
      orgId: params.orgId,
      threadId: params.thread.threadId,
      userId: params.userId,
      hostId: requestedHostId,
      cloudBrowserEnabled,
    });
  }
  return {
    computerUseHostGrant: hostGrant,
  };
}

async function createChatThread(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly clientThreadId: string | undefined;
    readonly chatThreadEventId: string | undefined;
    readonly pin: ThreadModelPin;
    readonly modelSettings: ModelSettings;
    readonly codexServiceTier: CodexServiceTier | null;
  },
): Promise<CreateChatThreadResult> {
  return await db.transaction(async (tx) => {
    const mediaModels = await loadNewChatThreadMediaModels(tx, {
      orgId: args.orgId,
      userId: args.userId,
    });
    const pinColumns = chatThreadModelPinColumns(args.pin);
    if (args.clientThreadId) {
      const [thread] = await tx
        .insert(chatThreads)
        .values({
          id: args.clientThreadId,
          userId: args.userId,
          agentId: args.agentId,
          title: null,
          modelProviderId: pinColumns.modelProviderId,
          modelProviderType: pinColumns.modelProviderType,
          modelProviderCredentialScope: pinColumns.modelProviderCredentialScope,
          selectedModel: pinColumns.selectedModel,
          codexServiceTier: args.codexServiceTier,
          modelSettings: args.modelSettings,
          selectedVideoModel: mediaModels.selectedVideoModel,
          selectedImageModel: mediaModels.selectedImageModel,
        })
        .onConflictDoNothing({ target: chatThreads.id })
        .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
      if (thread) {
        await appendChatThreadEvent(tx, {
          kind: "created",
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: thread.id,
          agentId: args.agentId,
          eventId: args.chatThreadEventId,
          title: null,
          selectedModel: args.pin.selectedModel,
          modelSettings: args.modelSettings,
          serviceTier: chatThreadServiceTierFromCodex(args.codexServiceTier),
          computerUseHostId: null,
          cloudBrowserEnabled: false,
          ...mediaModels,
          createdAt: thread.createdAt,
        });
        return { id: thread.id, clientThreadAlreadyExisted: false };
      }

      const [existingThread] = await tx
        .select({ id: chatThreads.id })
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
        return notFound("Chat thread not found");
      }
      return { id: existingThread.id, clientThreadAlreadyExisted: true };
    }

    const [thread] = await tx
      .insert(chatThreads)
      .values({
        userId: args.userId,
        agentId: args.agentId,
        title: null,
        modelProviderId: pinColumns.modelProviderId,
        modelProviderType: pinColumns.modelProviderType,
        modelProviderCredentialScope: pinColumns.modelProviderCredentialScope,
        selectedModel: pinColumns.selectedModel,
        codexServiceTier: args.codexServiceTier,
        modelSettings: args.modelSettings,
        selectedVideoModel: mediaModels.selectedVideoModel,
        selectedImageModel: mediaModels.selectedImageModel,
      })
      .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
    if (!thread) {
      throw new Error("Failed to create chat thread");
    }
    await appendChatThreadEvent(tx, {
      kind: "created",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: thread.id,
      agentId: args.agentId,
      eventId: args.chatThreadEventId,
      title: null,
      selectedModel: args.pin.selectedModel,
      modelSettings: args.modelSettings,
      serviceTier: chatThreadServiceTierFromCodex(args.codexServiceTier),
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      ...mediaModels,
      createdAt: thread.createdAt,
    });
    return { id: thread.id, clientThreadAlreadyExisted: false };
  });
}

function resolveInitialThreadModelPin(params: {
  readonly existingThreadId: string | undefined;
  readonly explicitRunConfiguration: ResolvedRunConfiguration | undefined;
}): ThreadModelPin | ReturnType<typeof badRequestMessage> {
  if (params.existingThreadId) {
    return emptyModelFirstThreadPin();
  }
  if (!params.explicitRunConfiguration?.modelPin.selectedModel) {
    return badRequestMessage("A model selection is required");
  }
  return params.explicitRunConfiguration.modelPin;
}

function loadTimedExistingThreadSnapshot(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly timing?: ApiDispatchTimingCollector;
}) {
  return measureApiDispatchTiming(
    params.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_existing_thread_load_snapshot",
    "nested",
    () => {
      return params.db
        .select({
          id: chatThreads.id,
          computerUseHostId: chatThreads.computerUseHostId,
          cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
          ...persistedChatThreadModelSnapshotColumns(),
          agentId: agents.id,
        })
        .from(chatThreads)
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .where(
          and(
            eq(chatThreads.id, params.threadId),
            eq(chatThreads.userId, params.userId),
            eq(agents.orgId, params.orgId),
          ),
        )
        .limit(1);
    },
  );
}

function resolveExplicitThreadRunConfiguration(
  configuration: ResolvedRunConfiguration,
  thread: {
    readonly modelSettings: ModelSettings;
    readonly codexServiceTier: CodexServiceTier | null;
  },
  settings: {
    readonly requestedReasoningEffort?: ReasoningEffort;
    readonly requestedCodexServiceTier: CodexServiceTier | undefined;
    readonly reasoningEffortEnabled: boolean;
    readonly codexFastModeEnabled: boolean;
  },
): ResolvedRunConfiguration | NormalSendFailure {
  const effort = resolveChatReasoningEffort({
    selectedModel: configuration.modelPin.selectedModel,
    modelSettings: thread.modelSettings,
    requested: settings.requestedReasoningEffort,
    enabled: settings.reasoningEffortEnabled,
  });
  if ("status" in effort) {
    return effort;
  }
  return {
    ...configuration,
    reasoningEffort: effort.reasoningEffort,
    modelSettings: effort.modelSettings,
    ...(settings.requestedReasoningEffort !== undefined &&
    settings.requestedCodexServiceTier === undefined
      ? {
          codexServiceTier:
            thread.codexServiceTier === "fast" &&
            isCodexFastServiceTierSupported({
              selectedModel: configuration.modelPin.selectedModel,
              codexFastModeEnabled: settings.codexFastModeEnabled,
            })
              ? "fast"
              : undefined,
        }
      : {}),
  };
}

async function resolveThread(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly existingThreadId: string | undefined;
  readonly clientThreadId: string | undefined;
  readonly chatThreadEventId: string | undefined;
  readonly initialPin: ThreadModelPin;
  readonly explicitRunConfiguration: ResolvedRunConfiguration | undefined;
  readonly requestedReasoningEffort?: ReasoningEffort;
  readonly reasoningEffortEnabled: boolean;
  readonly requestedCodexServiceTier: CodexServiceTier | undefined;
  readonly persistRequestedCodexServiceTier: boolean;
  readonly codexFastModeEnabled: boolean;
  readonly timing?: ApiDispatchTimingCollector;
}): Promise<ResolvedThreadAndRunConfiguration | NormalSendFailure> {
  if (!params.existingThreadId) {
    if (!params.explicitRunConfiguration) {
      return badRequestMessage("A model selection is required");
    }
    const thread = await createChatThread(params.db, {
      userId: params.userId,
      orgId: params.orgId,
      agentId: params.agentId,
      clientThreadId: params.clientThreadId,
      chatThreadEventId: params.chatThreadEventId,
      pin: params.initialPin,
      modelSettings: params.explicitRunConfiguration.modelSettings,
      codexServiceTier:
        params.explicitRunConfiguration.codexServiceTier ?? null,
    });
    if ("status" in thread) {
      return thread;
    }
    return {
      thread: {
        threadId: thread.id,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
        isNewThread: !thread.clientThreadAlreadyExisted,
        isClientThreadRetry: thread.clientThreadAlreadyExisted,
      },
      runConfiguration: params.explicitRunConfiguration,
    };
  }

  const [thread] = await loadTimedExistingThreadSnapshot({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    threadId: params.existingThreadId,
    timing: params.timing,
  });
  if (!thread?.agentId) {
    return notFound("Chat thread not found");
  }
  const threadModelSettings = modelSettingsSchema.parse(thread.modelSettings);

  let runConfiguration = params.explicitRunConfiguration;
  let persistedModelResolutionPath:
    | PersistedChatThreadModelResolutionPath
    | undefined;
  if (!runConfiguration) {
    const persisted = await measureApiDispatchTiming(
      params.timing,
      "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_existing_thread_resolve_persisted_model",
      "nested",
      () => {
        return resolvePersistedChatThreadModel({
          db: params.db,
          orgId: params.orgId,
          userId: params.userId,
          threadId: thread.id,
          threadSnapshot: thread,
          requestedReasoningEffort: params.requestedReasoningEffort,
          reasoningEffortEnabled: params.reasoningEffortEnabled,
          requestedCodexServiceTier: params.requestedCodexServiceTier,
          persistRequestedCodexServiceTier:
            params.persistRequestedCodexServiceTier,
          codexFastModeEnabled: params.codexFastModeEnabled,
        });
      },
    );
    if (!persisted) {
      return notFound("Chat thread not found");
    }
    if ("status" in persisted) {
      return persisted;
    }
    const resolvedRunConfiguration = await withBuiltInModelRuntimeRoute(
      params.db,
      {
        modelPin: persisted.pin,
        providerAdmission: persisted.providerAdmission,
        codexServiceTier: persisted.runCodexServiceTier,
        reasoningEffort: persisted.reasoningEffort,
        modelSettings: persisted.modelSettings,
      },
    );
    if ("status" in resolvedRunConfiguration) {
      return resolvedRunConfiguration;
    }
    runConfiguration = resolvedRunConfiguration;
    persistedModelResolutionPath = persisted.resolutionPath;
  } else {
    const explicit = resolveExplicitThreadRunConfiguration(
      runConfiguration,
      { ...thread, modelSettings: threadModelSettings },
      params,
    );
    if ("status" in explicit) {
      return explicit;
    }
    runConfiguration = explicit;
  }

  return {
    thread: {
      threadId: thread.id,
      computerUseHostId: thread.computerUseHostId,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      isNewThread: false,
      isClientThreadRetry: false,
    },
    runConfiguration,
    ...(persistedModelResolutionPath
      ? { modelResolutionPath: persistedModelResolutionPath }
      : {}),
  };
}

interface AppendUnassociatedUserMessageParams {
  readonly db: Db;
  readonly timing?: ApiDispatchTimingCollector;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly attachFileMetadata: ChatEventAttachFileMetadata[] | null;
  readonly clientEventId: string | undefined;
  readonly chatThreadSortEventId: string | undefined;
  readonly touchThreadSort: boolean;
  readonly userMessage: UserMessageDocument;
  readonly revokesEventId: string | undefined;
  readonly triggerSource: "web" | "agent";
  readonly agentRunSource: ChatAgentRunSourceAnnotation | null;
  readonly publicBrand: PublicBrand;
  readonly requiredOfficialWorkflowIds?: readonly string[];
}

async function resolveExistingUnassociatedClientEventId(
  tx: ChatThreadEventTransaction,
  params: AppendUnassociatedUserMessageParams,
  explicitId: string,
): Promise<ClientEventIdResolution> {
  const [existing] = await tx
    .select({
      chatThreadId: chatEvents.chatThreadId,
      threadUserId: chatThreads.userId,
      eventType: chatEvents.eventType,
      content: canonicalChatEventContent(),
      runId: chatEvents.runId,
      revokesEventId: chatEvents.revokesEventId,
      error: canonicalChatEventError(),
      eventCreatedAt: chatEvents.createdAt,
      runStatus: agentRuns.status,
      runCreatedAt: agentRuns.createdAt,
      replacementEventId: replacementChatEvent.id,
      replacementRunId: replacementChatEvent.runId,
      replacementError: canonicalChatEventError(replacementChatEvent.payload),
      replacementRunStatus: replacementAgentRun.status,
      replacementRunCreatedAt: replacementAgentRun.createdAt,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .leftJoin(
      agentRuns,
      and(eq(agentRuns.id, chatEvents.runId), runOwnedChatEventCondition()),
    )
    .leftJoin(
      replacementChatEvent,
      eq(replacementChatEvent.revokesEventId, chatEvents.id),
    )
    .leftJoin(
      replacementAgentRun,
      and(
        eq(replacementAgentRun.id, replacementChatEvent.runId),
        ne(replacementChatEvent.eventType, "control.interrupt"),
      ),
    )
    .where(eq(chatEvents.id, explicitId))
    .limit(1);
  const resolution = resolveExistingClientEventIdRow(existing, {
    threadId: params.threadId,
    userId: params.userId,
  });
  return resolution.kind === "available" ? { kind: "conflict" } : resolution;
}

async function appendUnassociatedUserMessageTransaction(
  tx: ChatThreadEventTransaction,
  params: AppendUnassociatedUserMessageParams,
): Promise<ClientEventIdResolution> {
  await measureApiDispatchTiming(
    params.timing,
    "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_clear_draft",
    "nested",
    () => {
      return tx
        .update(chatThreads)
        .set({
          draftUserMessage: null,
          draftAttachments: null,
        })
        .where(
          and(
            eq(chatThreads.id, params.threadId),
            eq(chatThreads.userId, params.userId),
          ),
        );
    },
  );

  const explicitId = params.clientEventId ?? undefined;
  const fileMetadata = params.attachFileMetadata;
  if (params.requiredOfficialWorkflowIds?.length === 0) {
    throw new Error("Official Workflow source claim cannot be empty");
  }
  if (
    params.requiredOfficialWorkflowIds !== undefined &&
    params.triggerSource === "agent" &&
    params.agentRunSource === null
  ) {
    throw new Error("Official agent queue source is missing its source Run");
  }
  const event: NewChatEvent = {
    ...(explicitId ? { id: explicitId } : {}),
    chatThreadId: params.threadId,
    eventType: "input.prompt",
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
              ? webChatPublicBrandContextId(params.publicBrand)
              : officialWorkflowQueueContextId(params.publicBrand),
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
            contextId: officialWorkflowQueueContextId(params.publicBrand),
          }
      : {}),
  };
  const inserted = await measureApiDispatchTiming(
    params.timing,
    "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_persist_event",
    "nested",
    () => {
      return params.revokesEventId
        ? replaceChatEvent(tx, params.revokesEventId, event)
        : insertChatEvent(tx, event, "id");
    },
  );
  if (inserted) {
    await measureApiDispatchTiming(
      params.timing,
      "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_register_input_assets",
      "nested",
      () => {
        return registerCanonicalWebInputAssets(tx, {
          chatThreadId: params.threadId,
          userId: params.userId,
          orgId: params.orgId,
          files: fileMetadata ?? [],
        });
      },
    );
    if (params.touchThreadSort) {
      await measureApiDispatchTiming(
        params.timing,
        "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_touch_thread_sort",
        "nested",
        () => {
          return touchChatThreadLastMessageAt(
            tx,
            params.threadId,
            inserted.createdAt,
            params.chatThreadSortEventId,
          );
        },
      );
    }
    return {
      kind: "queued",
      createdAt: inserted.createdAt,
      inserted: true,
      messageId: inserted.id,
    };
  }
  if (!explicitId) {
    throw new Error("Failed to insert unassociated user message");
  }
  return await resolveExistingUnassociatedClientEventId(tx, params, explicitId);
}

function appendUnassociatedUserMessage(
  params: AppendUnassociatedUserMessageParams,
): Promise<ClientEventIdResolution> {
  return measureApiDispatchTiming(
    params.timing,
    "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue_transaction",
    "nested",
    () => {
      return params.db.transaction((tx) => {
        return appendUnassociatedUserMessageTransaction(tx, params);
      });
    },
  );
}

async function clearThreadDraft(
  tx: Pick<Db, "update">,
  threadId: string,
  userId: string,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({
      draftUserMessage: null,
      draftAttachments: null,
    })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
}

async function appendAssociatedUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly runId: string;
  readonly attachFileMetadata: ChatEventAttachFileMetadata[] | null;
  readonly clientEventId: string | undefined;
  readonly chatThreadSortEventId: string | undefined;
  readonly touchThreadSort: boolean;
  readonly revokesEventId: string | undefined;
  readonly userMessage: UserMessageDocument;
  readonly appendQueueMarker: boolean;
  readonly triggerSource: "web" | "agent";
  // When false, the thread's in-progress draft is preserved. Automation posts
  // are not user-initiated typing, so they must not clear the user's draft.
  readonly clearDraft: boolean;
}): Promise<boolean> {
  return await params.db.transaction(async (tx) => {
    if (params.clearDraft) {
      await clearThreadDraft(tx, params.threadId, params.userId);
    }
    const explicitId = params.clientEventId ?? undefined;
    const fileMetadata = params.attachFileMetadata;
    const event: NewChatEvent = {
      ...(explicitId ? { id: explicitId } : {}),
      chatThreadId: params.threadId,
      eventType: "input.prompt",
      userMessage: params.userMessage,
      runId: params.runId,
      ...(params.triggerSource === "web" ? { contextType: "web" } : {}),
    };
    const inserted = params.revokesEventId
      ? await replaceChatEvent(tx, params.revokesEventId, event)
      : await insertChatEvent(tx, event, "id");
    if (inserted) {
      await registerCanonicalWebInputAssets(tx, {
        chatThreadId: params.threadId,
        userId: params.userId,
        orgId: params.orgId,
        files: fileMetadata ?? [],
      });
    }
    if (inserted && params.touchThreadSort) {
      await touchChatThreadLastMessageAt(
        tx,
        params.threadId,
        inserted.createdAt,
        params.chatThreadSortEventId,
      );
    }
    if (params.appendQueueMarker) {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: params.threadId,
        runId: params.runId,
        createdAfter: inserted?.createdAt ?? nowDate(),
      });
    }
    return inserted !== null;
  });
}

function appendRecallChatEvent(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly revokesEventId: string;
  readonly clientEventId: string | undefined;
}): Promise<AppendEventResult> {
  return params.db.transaction(async (tx) => {
    await lockUserMessageQueueThread(tx, params.threadId);
    const pendingTarget = await loadPendingChatQueueEvent(tx, {
      chatThreadId: params.threadId,
      eventId: params.revokesEventId,
    });
    const wasPending =
      pendingTarget?.eventType === "input.prompt" ||
      pendingTarget?.eventType === "input.automation";

    const [existingRevoker] = await tx
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

    const [target] = await tx
      .select({
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
    if (
      !target ||
      (!wasPending && target.error !== INSUFFICIENT_CREDITS_MARKER) ||
      (target.revokesEventId !== null &&
        target.error !== INSUFFICIENT_CREDITS_MARKER)
    ) {
      if (wasPending) {
        throw new Error("Queued message is not recallable");
      }
      const [exists] = await tx
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

    const inserted = await revokeChatEvent(tx, params.revokesEventId, {
      ...(params.clientEventId ? { id: params.clientEventId } : {}),
      chatThreadId: params.threadId,
      eventType: "control.revoke",
      runId: null,
    });
    if (inserted) {
      return { ok: true, createdAt: inserted.createdAt };
    }
    const [resolved] = await tx
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
      if (wasPending) {
        throw new Error("Failed to append recall user message");
      }
      return { ok: false, message: "Failed to insert recall user message" };
    }
    return { ok: true, createdAt: resolved.createdAt };
  });
}

async function validateNormalRevocationTarget(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly revokesEventId: string | undefined;
}): Promise<NormalSendFailure | undefined> {
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
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, params.threadId),
        eq(chatEvents.revokesEventId, params.revokesEventId),
      ),
    )
    .limit(1);
  if (existingRevoker) {
    return conflict("Recommended follow-up has already been used");
  }

  return undefined;
}

function appendInterruptUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly interruptsRunId: string;
  readonly clientEventId: string | undefined;
}): Promise<AppendEventResult> {
  return params.db.transaction(async (tx) => {
    const [existingInterrupter] = await tx
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

    const [targetRun] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.interruptsRunId),
          eq(agentRuns.chatThreadId, params.threadId),
          inArray(agentRuns.status, ["queued", "pending", "running"]),
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
      tx,
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
    const [resolved] = await tx
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
  });
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

function loadTimedAuthorizedAgent(
  args: NormalSendArgs,
  db: Db,
  signal: AbortSignal,
): Promise<AgentForChatSend | NormalSendFailure> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_load_and_authorize_agent",
    "nested",
    async () => {
      const agent =
        args.preloadedAgent ??
        (await loadAgentForChatSend(db, args.body.agentId));
      signal.throwIfAborted();
      if (
        !agent ||
        agent.id !== args.body.agentId ||
        agent.orgId !== args.orgId
      ) {
        return notFound("Agent not found");
      }
      if (agent.visibility === "private" && agent.owner !== args.userId) {
        return forbidden("Only the private agent owner can run this agent");
      }
      return agent;
    },
  );
}

function resolveTimedExplicitRunConfiguration(
  args: NormalSendArgs,
  db: Db,
  featureSwitches: NormalSendFeatureSwitches,
): ReturnType<typeof resolveExplicitRunConfiguration> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_validate_model_selection",
    "nested",
    () => {
      return resolveExplicitRunConfiguration({
        db,
        orgId: args.orgId,
        userId: args.userId,
        body: args.body,
        codexFastModeEnabled: featureSwitches.codexFastModeEnabled,
        reasoningEffortEnabled: featureSwitches.reasoningEffortEnabled,
        timing: args.timing,
      });
    },
  );
}

function resolveTimedNormalSendFeatureSwitches(
  args: NormalSendArgs,
  db: Db,
): ReturnType<typeof resolveNormalSendFeatureSwitches> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_feature_switches",
    "nested",
    () => {
      return resolveNormalSendFeatureSwitches(
        db,
        args.orgId,
        args.userId,
        args.body.userMessage.parts.flatMap((part) => {
          return part.type === "template" ? [part.template] : [];
        }),
      );
    },
  );
}

function resolveTimedInitialThreadModelPin(
  args: NormalSendArgs,
  explicitRunConfiguration: ResolvedRunConfiguration | undefined,
): Promise<ReturnType<typeof resolveInitialThreadModelPin>> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_initial_thread_model_pin",
    "nested",
    () => {
      return resolveInitialThreadModelPin({
        existingThreadId: args.body.threadId,
        explicitRunConfiguration,
      });
    },
  );
}

function resolveTimedThread(
  args: NormalSendArgs,
  db: Db,
  initialPin: ThreadModelPin,
  explicitRunConfiguration: ResolvedRunConfiguration | undefined,
  featureSwitches: NormalSendFeatureSwitches,
): ReturnType<typeof resolveThread> {
  let modelResolutionPath: PersistedChatThreadModelResolutionPath | undefined;
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_thread",
    "nested",
    async () => {
      if (
        args.body.runOptions?.reasoningEffort !== undefined &&
        !featureSwitches.reasoningEffortEnabled
      ) {
        return badRequestMessage("Reasoning effort selection is not enabled");
      }
      const resolved = await resolveThread({
        db,
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.body.agentId,
        existingThreadId: args.body.threadId,
        clientThreadId: args.body.clientThreadId,
        chatThreadEventId: args.body.chatThreadEventId,
        initialPin,
        explicitRunConfiguration,
        requestedReasoningEffort: args.body.runOptions?.reasoningEffort,
        reasoningEffortEnabled: featureSwitches.reasoningEffortEnabled,
        requestedCodexServiceTier: args.body.runOptions?.codexServiceTier,
        persistRequestedCodexServiceTier:
          (args.body.modelSelection !== undefined &&
            args.body.runOptions?.reasoningEffort === undefined) ||
          (args.body.runOptions !== undefined &&
            args.body.runOptions.reasoningEffort === undefined) ||
          args.body.runOptions?.codexServiceTier !== undefined,
        codexFastModeEnabled: featureSwitches.codexFastModeEnabled,
        timing: args.timing,
      });
      if ("status" in resolved) {
        return resolved;
      }
      modelResolutionPath = resolved.modelResolutionPath;
      return {
        ...resolved,
        runConfiguration: {
          ...resolved.runConfiguration,
          reasoningEffort: resolveReasoningEffortForDispatch({
            selectedModel: resolved.runConfiguration.modelPin.selectedModel,
            effort: resolved.runConfiguration.reasoningEffort,
            runtimeProviderType:
              resolved.runConfiguration.builtInModelRuntimeRoute
                ?.providerType ??
              resolved.runConfiguration.providerAdmission
                .effectiveModelProvider,
            piExecution: usesPi(
              args,
              resolved.thread,
              resolved.runConfiguration,
              featureSwitches,
            ),
          }),
        },
      };
    },
    () => {
      return modelResolutionPath
        ? { model_resolution_path: modelResolutionPath }
        : undefined;
    },
  );
}

function maybePersistTimedExplicitModelFirstSelection(
  args: NormalSendArgs,
  db: Db,
  codexServiceTier: CodexServiceTier | undefined,
): ReturnType<typeof maybePersistExplicitModelFirstSelection> {
  const requestedEffort = args.body.runOptions?.reasoningEffort;
  const requestedModel = args.body.modelSelection?.selectedModel;
  const modelSettingsPatch =
    requestedEffort !== undefined && isSupportedRunModel(requestedModel)
      ? { model: requestedModel, effort: requestedEffort }
      : undefined;
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_persist_explicit_model_selection",
    "nested",
    () => {
      return maybePersistExplicitModelFirstSelection({
        db,
        orgId: args.orgId,
        userId: args.userId,
        modelSelection: args.body.modelSelection,
        serviceTier: chatThreadServiceTierFromCodex(codexServiceTier ?? null),
        modelSettingsPatch,
      });
    },
  );
}

function maybePersistTimedExplicitRunSettings(
  args: NormalSendArgs,
  db: Db,
  threadId: string,
  runConfiguration: ResolvedRunConfiguration,
): ReturnType<typeof maybePersistExplicitRunSettings> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_persist_explicit_codex_service_tier",
    "nested",
    () => {
      return maybePersistExplicitRunSettings({
        db,
        orgId: args.orgId,
        threadId,
        userId: args.userId,
        body: args.body,
        codexServiceTier: runConfiguration.codexServiceTier,
        modelPin: runConfiguration.modelPin,
      });
    },
  );
}

function resolveTimedComputerAccess(
  args: NormalSendArgs,
  db: Db,
  thread: ResolvedThread,
): ReturnType<typeof resolveComputerAccess> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_computer_use_host_grant",
    "nested",
    () => {
      return resolveComputerAccess({
        db,
        orgId: args.orgId,
        userId: args.userId,
        body: args.body,
        thread,
      });
    },
  );
}

async function resolveTimedPreflightClientEvent(
  args: NormalSendArgs,
  db: Db,
): Promise<{
  readonly prechecked: boolean;
  readonly response: ClientSendResolution | undefined;
}> {
  const threadId = args.body.threadId ?? args.body.clientThreadId;
  const prechecked = Boolean(threadId && args.body.clientEventId);
  const response = threadId
    ? await measureApiDispatchTiming(
        args.timing,
        "api_dispatch_pre_create_agent_web_chat_resolve_client_message",
        "nested",
        () => {
          return resolveClientEventSend({
            db,
            orgId: args.orgId,
            userId: args.userId,
            threadId,
            clientEventId: args.body.clientEventId,
          });
        },
      )
    : undefined;
  return { prechecked, response };
}

function resolveTimedNormalSendAgentRunSource(
  args: NormalSendArgs,
  db: Db,
): ReturnType<typeof resolveNormalSendAgentRunSource> {
  return measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_agent_web_chat_prepare_normal_send_resolve_agent_run_source",
    "nested",
    () => {
      return resolveNormalSendAgentRunSource({
        db,
        auth: args.auth,
        userMessage: args.body.userMessage,
        sourceRunId: args.body.sourceRunId,
      });
    },
    {
      normal_send_agent_run_source_kind:
        args.body.sourceRunId !== undefined
          ? "forward"
          : args.auth.tokenType === "agent"
            ? "agent"
            : "none",
    },
  );
}

function normalSendTemplateUsageContext(
  args: NormalSendArgs,
  thread: PreparedNormalSend["thread"],
): TemplateUsageLogContext {
  return {
    dispatchPath: "normal-send",
    orgId: args.orgId,
    userId: args.userId,
    chatThreadId: thread.threadId,
    triggerSource: normalSendTriggerSource(args.auth),
  };
}

/**
 * Persist the member model preference alongside the thread run settings carried
 * by this send. Queued runs resolve the current thread settings at launch.
 */
async function persistTimedExplicitSelections(
  args: NormalSendArgs,
  db: Db,
  thread: PreparedNormalSend["thread"],
  runConfiguration: PreparedNormalSend["runConfiguration"],
  signal: AbortSignal,
) {
  const persistedExplicitSelection =
    await maybePersistTimedExplicitModelFirstSelection(
      args,
      db,
      runConfiguration.codexServiceTier,
    );
  signal.throwIfAborted();
  await maybePersistTimedExplicitRunSettings(
    args,
    db,
    thread.threadId,
    runConfiguration,
  );
  signal.throwIfAborted();
  return persistedExplicitSelection;
}

function usesPi(
  args: NormalSendArgs,
  thread: PreparedNormalSend["thread"],
  runConfiguration: PreparedNormalSend["runConfiguration"],
  featureSwitches: NormalSendFeatureSwitches,
): boolean {
  return shouldUsePiExecution({
    chatThreadId: thread.threadId,
    modelProviderType:
      runConfiguration.providerAdmission.effectiveModelProvider,
    selectedModel: runConfiguration.modelPin.selectedModel ?? undefined,
    codexServiceTier: runConfiguration.codexServiceTier,
    builtInModelRuntimeRoute: runConfiguration.builtInModelRuntimeRoute,
    featureSwitchContext: featureSwitches.featureSwitchContext,
  });
}

const prepareNormalSend$ = command(
  async (
    { set },
    args: NormalSendArgs,
    signal: AbortSignal,
  ): Promise<
    PreparedNormalSend | NormalSendFailure | CreatedChatEventResponse
  > => {
    const db = set(writeDb$);
    const agent = await loadTimedAuthorizedAgent(args, db, signal);
    if ("status" in agent) {
      return agent;
    }
    const preflight = await resolveTimedPreflightClientEvent(args, db);
    signal.throwIfAborted();
    if (preflight.response?.status === 201) {
      return preflight.response;
    }
    const featureSwitches = await resolveTimedNormalSendFeatureSwitches(
      args,
      db,
    );
    signal.throwIfAborted();
    const agentRunSourceResult = await resolveTimedNormalSendAgentRunSource(
      args,
      db,
    );
    signal.throwIfAborted();
    if ("response" in agentRunSourceResult) {
      return agentRunSourceResult.response;
    }
    const agentRunSource = agentRunSourceResult.source;
    const runtimeBody = resolveRuntimeNormalSendBody(
      normalSendBodyWithAgentRunSource(args.body, agentRunSource),
    );
    const authorizedTemplates = await validateGenerationTemplatePrompt(
      db,
      args,
      runtimeBody.templates,
      featureSwitches,
    );
    signal.throwIfAborted();
    if ("status" in authorizedTemplates) {
      return authorizedTemplates;
    }
    const explicitRunConfiguration = await resolveTimedExplicitRunConfiguration(
      args,
      db,
      featureSwitches,
    );
    signal.throwIfAborted();
    if (explicitRunConfiguration && "status" in explicitRunConfiguration) {
      return explicitRunConfiguration;
    }

    const initialPin = await resolveTimedInitialThreadModelPin(
      args,
      explicitRunConfiguration,
    );
    signal.throwIfAborted();
    if ("status" in initialPin) {
      return initialPin;
    }

    const attachFileMetadataArgs = {
      userId: args.userId,
      userMessage: runtimeBody.userMessage,
      timing: args.timing,
    };
    const attachFileMetadataResultPromise = Promise.allSettled([
      set(resolveIncomingAttachFileMetadata$, attachFileMetadataArgs, signal),
    ]);

    const threadAndRunConfiguration = await resolveTimedThread(
      args,
      db,
      initialPin,
      explicitRunConfiguration,
      featureSwitches,
    );
    signal.throwIfAborted();
    if ("status" in threadAndRunConfiguration) {
      return threadAndRunConfiguration;
    }
    const { thread, runConfiguration } = threadAndRunConfiguration;

    const templateContext = resolveSelectedTemplateContext(
      runtimeBody,
      featureSwitches,
      authorizedTemplates.userPresentationTemplateIds,
    );
    const persistedExplicitSelection = await persistTimedExplicitSelections(
      args,
      db,
      thread,
      runConfiguration,
      signal,
    );
    const computerAccess = await resolveTimedComputerAccess(args, db, thread);
    signal.throwIfAborted();
    if ("status" in computerAccess) {
      return computerAccess;
    }
    const [attachFileMetadataResult] = await attachFileMetadataResultPromise;
    signal.throwIfAborted();
    const attachFileMetadata = unwrapSettledResult(attachFileMetadataResult);
    const piExecution = usesPi(args, thread, runConfiguration, featureSwitches);

    return {
      db,
      agent,
      thread,
      body: runtimeBody,
      generationTemplatePrompt: templateContext.generationTemplatePrompt,
      generationTemplateIdentities:
        templateContext.generationTemplateIdentities,
      presentationTemplateVolumes: userPresentationTemplateVolumes(
        authorizedTemplates.userPresentationTemplateIds,
      ),
      videoRunOptions: templateContext.videoRunOptions,
      computerUseHostGrant: computerAccess.computerUseHostGrant,
      persistedExplicitSelection,
      initialThinkingEnabled: initialThinkingForSend(args, featureSwitches),
      attachFileMetadata,
      runConfiguration,
      clientEventPrechecked: preflight.prechecked,
      preflightClientEventConflict: preflight.response,
      triggerSource: normalSendTriggerSource(args.auth),
      agentRunSource,
      piExecution,
    };
  },
);

async function queueUnassociatedNormalEvent(params: {
  readonly prepared: PreparedNormalSend;
  readonly timing?: ApiDispatchTimingCollector;
  readonly body: RuntimeNormalSendBody;
  readonly userId: string;
  readonly touchThreadSort: boolean;
  readonly orgId: string;
  readonly publicBrand: PublicBrand;
  readonly requiredOfficialWorkflowIds?: readonly string[];
}): Promise<{
  readonly response:
    | CreatedChatEventResponse
    | ReturnType<typeof duplicateClientEventIdResponse>;
  /** Set when this call inserted a queue-first message. */
  readonly queuedEventId: string | undefined;
}> {
  const resolution = await appendUnassociatedUserMessage({
    db: params.prepared.db,
    timing: params.timing,
    threadId: params.prepared.thread.threadId,
    userId: params.userId,
    orgId: params.orgId,
    prompt: params.body.prompt,
    attachFileMetadata: params.prepared.attachFileMetadata,
    clientEventId: params.body.clientEventId,
    chatThreadSortEventId: params.body.chatThreadSortEventId,
    touchThreadSort: params.touchThreadSort,
    userMessage: params.body.userMessage,
    revokesEventId: params.body.revokesEventId,
    triggerSource: params.prepared.triggerSource,
    agentRunSource: params.prepared.agentRunSource,
    publicBrand: params.publicBrand,
    ...(params.requiredOfficialWorkflowIds === undefined
      ? {}
      : {
          requiredOfficialWorkflowIds: params.requiredOfficialWorkflowIds,
        }),
  });
  if (resolution.kind === "queued" && resolution.inserted) {
    await publishThreadListChanged({
      userId: params.userId,
      orgId: params.orgId,
    });
  }
  const response = clientEventIdResolutionResponse(
    resolution,
    params.prepared.thread.threadId,
  );
  const queuedEventId =
    resolution.kind === "queued" && resolution.inserted
      ? resolution.messageId
      : undefined;
  if (!response) {
    return {
      response: duplicateClientEventIdResponse(),
      queuedEventId,
    };
  }
  return { response, queuedEventId };
}

function scheduleChatTitleGeneration(params: {
  readonly db: Db;
  readonly body: RuntimeNormalSendBody;
  readonly thread: ResolvedThread;
  readonly userId: string;
  readonly orgId: string;
}): void {
  if (params.body.hasTextContent === false) {
    return;
  }

  scheduleChatThreadTitleGeneration({
    db: params.db,
    threadId: params.thread.threadId,
    userId: params.userId,
    orgId: params.orgId,
    prompt: params.body.agentPrompt,
    includePriorRounds: !params.thread.isNewThread,
  });
}

function scheduleAssociatedUserMessage(params: {
  readonly db: Db;
  readonly body: RuntimeNormalSendBody;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly appendQueueMarker: boolean;
  readonly appendInitialThinking: boolean;
  readonly touchThreadSort: boolean;
  readonly attachFileMetadata: ChatEventAttachFileMetadata[] | null;
  readonly triggerSource: "web" | "agent";
}): void {
  waitUntil(
    (async () => {
      const inserted = await appendAssociatedUserMessage({
        db: params.db,
        threadId: params.threadId,
        userId: params.userId,
        orgId: params.orgId,
        prompt: params.body.prompt,
        runId: params.runId,
        attachFileMetadata: params.attachFileMetadata,
        clientEventId: params.body.clientEventId,
        chatThreadSortEventId: params.body.chatThreadSortEventId,
        touchThreadSort: params.touchThreadSort,
        revokesEventId: params.body.revokesEventId,
        userMessage: params.body.userMessage,
        appendQueueMarker: params.appendQueueMarker,
        triggerSource: params.triggerSource,
        clearDraft: true,
      });
      if (inserted) {
        await publishChatEventCreated({
          userId: params.userId,
          orgId: params.orgId,
          threadId: params.threadId,
        });
        await publishThreadListChanged({
          userId: params.userId,
          orgId: params.orgId,
        });
      }
      if (params.appendInitialThinking) {
        await bestEffort(
          generateAndPersistInitialThinkingMessage({
            db: params.db,
            threadId: params.threadId,
            userId: params.userId,
            orgId: params.orgId,
            runId: params.runId,
            currentPrompt: params.body.prompt,
          }),
        );
      }
      // Direct user messages move sidebar recency; the terminal callback will
      // publish again when the run-finished marker lands.
    })(),
  );
}

function scheduleCreatedChatRunSideEffects(params: {
  readonly db: Db;
  readonly body: RuntimeNormalSendBody;
  readonly thread: ResolvedThread;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly runStatus: string;
  readonly initialThinkingEnabled: boolean;
  readonly attachFileMetadata: ChatEventAttachFileMetadata[] | null;
  readonly touchThreadSort: boolean;
  readonly triggerSource: "web" | "agent";
  readonly queueFirstClaim:
    | {
        readonly createdAt: Date;
      }
    | undefined;
}): void {
  scheduleChatTitleGeneration({
    db: params.db,
    body: params.body,
    thread: params.thread,
    userId: params.userId,
    orgId: params.orgId,
  });
  const appendInitialThinking =
    params.initialThinkingEnabled &&
    params.runStatus !== "queued" &&
    params.body.hasTextContent !== false &&
    params.body.prompt.trim().length > 0;
  if (params.queueFirstClaim) {
    scheduleClaimedQueueFirstEventSideEffects({
      db: params.db,
      body: params.body,
      threadId: params.thread.threadId,
      userId: params.userId,
      orgId: params.orgId,
      runId: params.runId,
      createdAt: params.queueFirstClaim.createdAt,
      appendQueueMarker: params.runStatus === "queued",
      appendInitialThinking,
    });
    return;
  }
  scheduleAssociatedUserMessage({
    db: params.db,
    body: params.body,
    threadId: params.thread.threadId,
    userId: params.userId,
    orgId: params.orgId,
    runId: params.runId,
    appendQueueMarker: params.runStatus === "queued",
    appendInitialThinking,
    touchThreadSort: params.touchThreadSort,
    attachFileMetadata: params.attachFileMetadata,
    triggerSource: params.triggerSource,
  });
}

/**
 * Queue-first counterpart of `scheduleAssociatedUserMessage`: the launch
 * transaction already appended the run-associated replacement, so only
 * publish the append and add the optional run markers here.
 */
function scheduleClaimedQueueFirstEventSideEffects(params: {
  readonly db: Db;
  readonly body: RuntimeNormalSendBody;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly createdAt: Date;
  readonly appendQueueMarker: boolean;
  readonly appendInitialThinking: boolean;
}): void {
  waitUntil(
    (async () => {
      if (params.appendQueueMarker) {
        await params.db.transaction(async (tx) => {
          await appendQueuedRunAssistantMarker(tx, {
            chatThreadId: params.threadId,
            runId: params.runId,
            createdAfter: params.createdAt,
          });
        });
      }
      await publishChatEventCreated({
        userId: params.userId,
        orgId: params.orgId,
        threadId: params.threadId,
      });
      if (params.appendInitialThinking) {
        await bestEffort(
          generateAndPersistInitialThinkingMessage({
            db: params.db,
            threadId: params.threadId,
            userId: params.userId,
            orgId: params.orgId,
            runId: params.runId,
            currentPrompt: params.body.prompt,
          }),
        );
      }
    })(),
  );
}

async function buildInsufficientCreditsAssistantMessage(params: {
  readonly db: Db;
  readonly orgId: string;
}): Promise<string> {
  const capabilities = await loadOrgPlanCapabilities(params.db, params.orgId);
  const appUrl = env("APP_URL");
  const usageUrl = `${appUrl}/?settings=usage`;
  const billingUrl = `${appUrl}/?settings=billing&billingView=plans`;
  if (capabilities?.canBuyCredits !== true) {
    return [
      "Insufficient credits. This workspace has no spendable credits right now.",
      "",
      `Upgrade to Pro to get more credits: ${billingUrl}`,
    ].join("\n");
  }
  return [
    "Insufficient credits. This workspace has no spendable credits right now.",
    "",
    `Buy more credits or adjust auto-recharge: ${usageUrl}`,
  ].join("\n");
}

async function appendQueueFirstInsufficientCreditsEvents(params: {
  readonly prepared: PreparedNormalSend;
  readonly userId: string;
  readonly orgId: string;
  readonly eventId: string;
  readonly assistantContent: string;
}): Promise<CreatedChatEventResponse> {
  // The queue-first send already persisted the pending input. Its rejected
  // replacement is the atomic claim that makes it non-runnable.
  const userCreatedAt = nowDate();
  const createdAt = await params.prepared.db.transaction(async (tx) => {
    await lockUserMessageQueueThread(tx, params.prepared.thread.threadId);
    const pending = await loadPendingChatQueueEvent(tx, {
      chatThreadId: params.prepared.thread.threadId,
      eventId: params.eventId,
    });
    if (pending?.eventType !== "input.prompt") {
      throw new Error("Queue-first message is no longer available");
    }
    const [queuedMessage] = await tx
      .select({
        userMessage: canonicalChatEventUserMessage(),
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, params.eventId),
          eq(chatEvents.chatThreadId, params.prepared.thread.threadId),
          chatEventTypeIn(["input.prompt"]),
          isNull(chatEvents.runId),
        ),
      )
      .for("update", { of: chatEvents })
      .limit(1);
    if (!queuedMessage) {
      throw new Error("Queue-first message is no longer available");
    }
    if (!queuedMessage.userMessage) {
      throw new Error("Queue-first message is missing userMessage");
    }
    const rejectedCreatedAt = new Date(
      Math.max(userCreatedAt.getTime(), queuedMessage.createdAt.getTime() + 1),
    );
    const assistantCreatedAt = new Date(rejectedCreatedAt.getTime() + 1);

    const replacement = await replaceChatEvent(tx, params.eventId, {
      chatThreadId: params.prepared.thread.threadId,
      eventType: "input.rejected",
      userMessage: queuedMessage.userMessage,
      runId: null,
      error: INSUFFICIENT_CREDITS_MARKER,
      runEventSequenceNumber: 0,
      createdAt: rejectedCreatedAt,
    });
    if (replacement) {
      await insertChatEvent(tx, {
        chatThreadId: params.prepared.thread.threadId,
        eventType: "output.error",
        content: params.assistantContent,
        error: INSUFFICIENT_CREDITS_MARKER,
        runEventSequenceNumber: 1,
        createdAt: assistantCreatedAt,
        runId: null,
      });
    } else {
      throw new Error("Failed to append insufficient-credits replacement");
    }
    return queuedMessage.createdAt;
  });
  await publishChatEventCreated({
    userId: params.userId,
    orgId: params.orgId,
    threadId: params.prepared.thread.threadId,
  });
  return {
    status: 201,
    body: {
      runId: null,
      threadId: params.prepared.thread.threadId,
      createdAt: createdAt.toISOString(),
    },
  };
}

async function appendInsufficientCreditsEvents(params: {
  readonly prepared: PreparedNormalSend;
  readonly body: RuntimeNormalSendBody;
  readonly userId: string;
  readonly orgId: string;
  readonly touchThreadSort: boolean;
  readonly queueFirstEventId?: string;
}): Promise<CreatedChatEventResponse> {
  const assistantContent = await buildInsufficientCreditsAssistantMessage({
    db: params.prepared.db,
    orgId: params.orgId,
  });
  if (params.queueFirstEventId) {
    return appendQueueFirstInsufficientCreditsEvents({
      prepared: params.prepared,
      userId: params.userId,
      orgId: params.orgId,
      eventId: params.queueFirstEventId,
      assistantContent,
    });
  }
  const userCreatedAt = nowDate();
  const assistantCreatedAt = new Date(userCreatedAt.getTime() + 1);
  const result = await params.prepared.db.transaction(async (tx) => {
    await tx
      .update(chatThreads)
      .set({
        draftUserMessage: null,
        draftAttachments: null,
      })
      .where(
        and(
          eq(chatThreads.id, params.prepared.thread.threadId),
          eq(chatThreads.userId, params.userId),
        ),
      );

    const explicitId = params.body.clientEventId ?? undefined;
    const fileMetadata = params.prepared.attachFileMetadata;
    const userValues: NewChatEvent = {
      ...(explicitId ? { id: explicitId } : {}),
      chatThreadId: params.prepared.thread.threadId,
      eventType: "input.rejected",
      userMessage: params.body.userMessage,
      runId: null,
      error: INSUFFICIENT_CREDITS_MARKER,
      runEventSequenceNumber: 0,
      createdAt: userCreatedAt,
    };
    const userMessage = params.body.revokesEventId
      ? await replaceChatEvent(tx, params.body.revokesEventId, userValues)
      : await insertChatEvent(tx, userValues, "id");

    const createdAt = userMessage?.createdAt ?? userCreatedAt;
    if (userMessage) {
      await registerCanonicalWebInputAssets(tx, {
        chatThreadId: params.prepared.thread.threadId,
        userId: params.userId,
        orgId: params.orgId,
        files: fileMetadata ?? [],
      });
    }
    if (userMessage && params.touchThreadSort) {
      await touchChatThreadLastMessageAt(
        tx,
        params.prepared.thread.threadId,
        createdAt,
        params.body.chatThreadSortEventId,
      );
    }
    await insertChatEvent(tx, {
      chatThreadId: params.prepared.thread.threadId,
      eventType: "output.error",
      content: assistantContent,
      error: INSUFFICIENT_CREDITS_MARKER,
      runEventSequenceNumber: 1,
      createdAt: assistantCreatedAt,
      runId: null,
    });
    return { createdAt, inserted: userMessage !== null };
  });

  await publishChatEventCreated({
    userId: params.userId,
    orgId: params.orgId,
    threadId: params.prepared.thread.threadId,
  });
  if (result.inserted) {
    await publishThreadListChanged({
      userId: params.userId,
      orgId: params.orgId,
    });
  }

  return {
    status: 201,
    body: {
      runId: null,
      threadId: params.prepared.thread.threadId,
      createdAt: result.createdAt.toISOString(),
    },
  };
}

function codexFastServiceTierRequested(body: NormalSendBody): boolean {
  return body.runOptions?.codexServiceTier === "fast";
}

function validateCodexServiceTier(params: {
  readonly body: NormalSendBody;
  readonly modelPin: ThreadModelPin;
  readonly codexFastModeEnabled: boolean;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (!codexFastServiceTierRequested(params.body)) {
    return undefined;
  }
  if (!params.codexFastModeEnabled) {
    return badRequestMessage(
      "Codex fast mode is not enabled for this workspace",
    );
  }
  if (
    isCodexFastServiceTierSupported({
      selectedModel: params.modelPin.selectedModel,
      codexFastModeEnabled: params.codexFastModeEnabled,
    })
  ) {
    return undefined;
  }
  return badRequestMessage(
    "Codex fast mode is only available for GPT 5.6 runs",
  );
}

function codexServiceTierForRun(params: {
  readonly body: NormalSendBody;
  readonly modelPin: ThreadModelPin;
  readonly codexFastModeEnabled: boolean;
}): "fast" | undefined {
  return codexFastServiceTierRequested(params.body) &&
    isCodexFastServiceTierSupported({
      selectedModel: params.modelPin.selectedModel,
      codexFastModeEnabled: params.codexFastModeEnabled,
    })
    ? "fast"
    : undefined;
}

function cliAgentTypeForRun(prepared: PreparedNormalSend) {
  return prepared.piExecution
    ? ("pi" as const)
    : prepared.runConfiguration.providerAdmission.cliAgentType;
}

function requiredOfficialWorkflowRunArgs(
  workflowIds: readonly string[] | undefined,
) {
  return workflowIds === undefined
    ? {}
    : { requiredOfficialWorkflowIds: workflowIds };
}

function buildCreateAgentRunArgs(params: {
  readonly args: NormalSendArgs;
  readonly prepared: PreparedNormalSend;
  readonly realAgentInPreviewEnabled: boolean;
}) {
  const { args, prepared } = params;
  const {
    modelPin,
    providerAdmission,
    builtInModelRuntimeRoute,
    codexServiceTier,
    reasoningEffort,
  } = prepared.runConfiguration;
  const videoRunOptionsPrompt = buildVideoRunOptionsPrompt(
    prepared.videoRunOptions,
  );
  const agentPrompt = videoRunOptionsPrompt
    ? `${videoRunOptionsPrompt}\n\n${prepared.body.agentPrompt}`
    : prepared.body.agentPrompt;
  const webChatSessionPromptContext: WebChatSessionPromptContext = {
    generationTemplatePrompt: prepared.generationTemplatePrompt,
    computerUseHostDisplayName:
      prepared.computerUseHostGrant?.displayName ?? null,
    triggerSource: prepared.triggerSource,
    agentRunSource: prepared.agentRunSource,
  };
  return {
    auth: args.auth,
    apiStartTime: args.apiStartTime,
    chatThreadId: prepared.thread.threadId,
    computerUseHostId: prepared.computerUseHostGrant?.hostId,
    modelProviderId: modelPin.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      modelPin.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: modelPin.selectedModel ?? undefined,
    ...(builtInModelRuntimeRoute ? { builtInModelRuntimeRoute } : {}),
    agentRunModelPin: {
      modelProvider: providerAdmission.effectiveModelProvider ?? null,
      modelProviderId: modelPin.modelProviderId,
      modelProviderCredentialScope: modelPin.modelProviderCredentialScope,
      selectedModel: modelPin.selectedModel,
    },
    piExecution: prepared.piExecution,
    threadSessionRoute: {
      selectedModel: modelPin.selectedModel,
      cliAgentType: cliAgentTypeForRun(prepared),
    },
    codexServiceTier,
    reasoningEffort,
    callbacks: [
      {
        internalKind: "chat" as const,
        secret: generateCallbackSecret(),
        payload: {
          threadId: prepared.thread.threadId,
          agentId: args.body.agentId,
          publicBrand: args.publicBrand,
        },
      },
    ],
    body: {
      prompt: agentPrompt,
      agentId: args.body.agentId,
      ...(providerAdmission.effectiveModelProvider
        ? {
            modelProvider: modelProviderWriteTypeForLaunch(
              providerAdmission.effectiveModelProvider,
            ),
          }
        : {}),
      ...(params.realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
      ...(args.body.captureNetworkBodies ? { captureNetworkBodies: true } : {}),
      ...additionalVolumesForRun(prepared.presentationTemplateVolumes),
    },
    triggerSource: prepared.triggerSource,
    dispatchFailedCallbacks: dispatchFailedRunCallbacks,
    ...(prepared.thread.isNewThread
      ? {
          appendSystemPrompt: buildWebChatAppendSystemPrompt({
            threadId: prepared.thread.threadId,
            incompleteContext: "",
            priorContext: "",
            context: webChatSessionPromptContext,
          }),
        }
      : { webChatSessionPromptContext }),
    ...(args.timing ? { timing: args.timing } : {}),
    ...(args.agentRunPreCreateSource
      ? { agentRunPreCreateSource: args.agentRunPreCreateSource }
      : {}),
    ...requiredOfficialWorkflowRunArgs(args.requiredOfficialWorkflowIds),
  };
}

async function buildTimedCreateAgentRunArgs(params: {
  readonly args: NormalSendArgs;
  readonly prepared: PreparedNormalSend;
  readonly realAgentInPreviewEnabled: boolean;
}): Promise<ReturnType<typeof buildCreateAgentRunArgs>> {
  return await measureApiDispatchTiming(
    params.args.timing,
    "api_dispatch_pre_create_agent_web_chat_build_create_run_args",
    "nested",
    () => {
      return buildCreateAgentRunArgs(params);
    },
  );
}

async function resolveQueueFirstEventAfterLostClaim(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly eventId: string;
}) {
  const resolution = await resolveClientEventId(params.db, {
    clientEventId: params.eventId,
    orgId: params.orgId,
    threadId: params.threadId,
    userId: params.userId,
  });
  return (
    clientEventIdResolutionResponse(resolution, params.threadId) ??
    notFound("Chat thread not found")
  );
}

function createdNormalChatRunResponse(params: {
  readonly runId: string;
  readonly threadId: string;
  readonly status: string;
  readonly createdAt: string | undefined;
}): CreatedChatEventResponse {
  if (!params.createdAt) {
    throw new Error("Created chat run response is missing createdAt");
  }
  return {
    status: 201,
    body: {
      ...params,
      createdAt: params.createdAt,
    },
  };
}

function scheduleNormalChatRunSideEffects(params: {
  readonly args: NormalSendArgs;
  readonly prepared: PreparedNormalSend;
  readonly runId: string;
  readonly runStatus: string;
  readonly queueFirstClaimedAt: Date;
}): void {
  scheduleCreatedChatRunSideEffects({
    db: params.prepared.db,
    body: params.prepared.body,
    thread: params.prepared.thread,
    userId: params.args.userId,
    orgId: params.args.orgId,
    runId: params.runId,
    runStatus: params.runStatus,
    initialThinkingEnabled: params.prepared.initialThinkingEnabled,
    attachFileMetadata: params.prepared.attachFileMetadata,
    touchThreadSort: shouldTouchThreadSortFromNormalSend(
      params.args.agentRunPreCreateSource,
      params.prepared.thread.isNewThread,
    ),
    triggerSource: params.prepared.triggerSource,
    queueFirstClaim: {
      createdAt: params.queueFirstClaimedAt,
    },
  });
}

async function buildNormalChatRunArgs(
  args: NormalSendArgs,
  prepared: PreparedNormalSend,
  signal: AbortSignal,
) {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    prepared.db,
    args.orgId,
    args.userId,
  );
  signal.throwIfAborted();

  const createRunArgs = await buildTimedCreateAgentRunArgs({
    args,
    prepared,
    realAgentInPreviewEnabled: isFeatureEnabled(
      FeatureSwitchKey.RealAgentInPreview,
      featureSwitchContext,
    ),
  });
  signal.throwIfAborted();
  return createRunArgs;
}

const createNormalChatRun$ = command(
  async (
    { set },
    params: {
      readonly args: NormalSendArgs;
      readonly prepared: PreparedNormalSend;
      /** Queue-first sends replace this queued message at dispatch time. */
      readonly queueFirstEventId: string;
    },
    signal: AbortSignal,
  ) => {
    const { args, prepared, queueFirstEventId } = params;
    const createNormalRunStartedAt = now();
    const { modelPin, providerAdmission } = prepared.runConfiguration;
    if (providerAdmission.error) {
      if (providerAdmission.error.status !== 402) {
        return providerAdmission.error;
      }
      return await appendInsufficientCreditsEvents({
        prepared,
        body: prepared.body,
        userId: args.userId,
        orgId: args.orgId,
        touchThreadSort: shouldTouchThreadSortFromNormalSend(
          args.agentRunPreCreateSource,
          prepared.thread.isNewThread,
        ),
        queueFirstEventId,
      });
    }

    const queuedMessage = await loadNextUnclaimedQueuedUserMessage(
      prepared.db,
      prepared.thread.threadId,
    );
    signal.throwIfAborted();
    if (!queuedMessage || queuedMessage.id !== queueFirstEventId) {
      return await resolveQueueFirstEventAfterLostClaim({
        db: prepared.db,
        orgId: args.orgId,
        threadId: prepared.thread.threadId,
        userId: args.userId,
        eventId: queueFirstEventId,
      });
    }
    if (queuedMessage.autonomyBudget.kind !== "ok") {
      await discardUnclaimedUserMessage(prepared.db, {
        threadId: prepared.thread.threadId,
        eventId: queueFirstEventId,
      });
      signal.throwIfAborted();
      return queuedMessage.autonomyBudget.kind === "exhausted"
        ? autonomyBudgetExhausted()
        : badRequestMessage(queuedMessage.autonomyBudget.message);
    }
    const createRunArgs = await buildNormalChatRunArgs(args, prepared, signal);

    if (args.timing) {
      args.timing.recordElapsed(
        "api_dispatch_pre_create_agent_web_chat_create_normal_run",
        "nested",
        createNormalRunStartedAt,
      );
    }
    const runResult = await set(
      createQueueFirstAgentRun$,
      {
        ...createRunArgs,
        apiStartTime: args.apiStartTime,
        agentRunMetadata: {
          autonomyBudget: queuedMessage.autonomyBudget.autonomyBudget,
        },
        queueFirstAssociation: {
          kind: "user_message",
          threadId: prepared.thread.threadId,
          eventId: queueFirstEventId,
          admissionTime: args.apiStartTime,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (isQueueFirstRunClaimLost(runResult)) {
      return await resolveQueueFirstEventAfterLostClaim({
        db: prepared.db,
        orgId: args.orgId,
        threadId: prepared.thread.threadId,
        userId: args.userId,
        eventId: queueFirstEventId,
      });
    }
    if (runResult.status !== 201) {
      return runResult;
    }
    // The run now exists, which is what makes this a use. Reporting any earlier
    // counts sends that never produced one: a lost claim hands the message to
    // another dispatcher that reports it through `queued-claim`, and a non-201
    // result leaves no run at all.
    logTemplateUsage(
      normalSendTemplateUsageContext(args, prepared.thread),
      prepared.generationTemplateIdentities,
    );
    const response = createdNormalChatRunResponse({
      runId: runResult.body.runId,
      threadId: prepared.thread.threadId,
      status: runResult.body.status,
      createdAt: runResult.body.createdAt,
    });
    const queueFirstClaimedAt = runResult.queueFirstClaim.createdAt;

    scheduleNormalChatRunSideEffects({
      args,
      prepared,
      runId: runResult.body.runId,
      runStatus: runResult.body.status,
      queueFirstClaimedAt,
    });

    if (prepared.persistedExplicitSelection && modelPin.selectedModel) {
      const requestedEffort = args.body.runOptions?.reasoningEffort;
      await updateUserModelPreference(prepared.db, {
        orgId: args.orgId,
        userId: args.userId,
        selectedModel: modelPin.selectedModel,
        serviceTier: chatThreadServiceTierFromCodex(
          prepared.runConfiguration.codexServiceTier ?? null,
        ),
        modelSettingsPatch:
          requestedEffort !== undefined &&
          isSupportedRunModel(modelPin.selectedModel)
            ? { model: modelPin.selectedModel, effort: requestedEffort }
            : undefined,
      });
      signal.throwIfAborted();
    }

    return response;
  },
);

export const sendNormalEvent$ = command(
  async ({ set }, args: NormalSendArgs, signal: AbortSignal) => {
    const prepared = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_agent_web_chat_prepare_normal_send",
      "nested",
      async () => {
        return await set(prepareNormalSend$, args, signal);
      },
    );
    signal.throwIfAborted();
    if ("status" in prepared) {
      return prepared;
    }

    const clientEventResolution =
      prepared.preflightClientEventConflict ??
      (!prepared.clientEventPrechecked ||
      args.body.revokesEventId !== undefined ||
      prepared.thread.isClientThreadRetry
        ? await measureApiDispatchTiming(
            args.timing,
            "api_dispatch_pre_create_agent_web_chat_resolve_client_message",
            "nested",
            async () => {
              return await resolveClientEventSend({
                db: prepared.db,
                orgId: args.orgId,
                userId: args.userId,
                threadId: prepared.thread.threadId,
                clientEventId: args.body.clientEventId,
              });
            },
          )
        : undefined);
    signal.throwIfAborted();
    if (clientEventResolution) {
      return clientEventResolution;
    }

    const revocationError = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_agent_web_chat_validate_revocation",
      "nested",
      async () => {
        return await validateNormalRevocationTarget({
          db: prepared.db,
          threadId: prepared.thread.threadId,
          revokesEventId: args.body.revokesEventId,
        });
      },
    );
    signal.throwIfAborted();
    if (revocationError) {
      return revocationError;
    }

    if (prepared.thread.isClientThreadRetry) {
      const existingRun = await resolveClientThreadRetryRun(
        prepared.db,
        prepared.thread.threadId,
      );
      signal.throwIfAborted();
      if (existingRun) {
        return existingRun;
      }
      return badRequestMessage("Client thread id is already in use");
    }

    // Every web chat send persists its input before the inline drain attempts
    // an atomic queue claim, including recommended follow-up replacements.
    return await set(sendQueueFirstNormalEvent$, { args, prepared }, signal);
  },
);

/**
 * Queue-first send: persist the message and its queue item, then inline-drain
 * — create the run and append a replacement message when the thread is idle
 * and this message is the oldest unclaimed one. Response shapes match the
 * legacy path: `runId` when dispatched, `{runId: null}` when left queued.
 */
const sendQueueFirstNormalEvent$ = command(
  async (
    { set },
    params: {
      readonly args: NormalSendArgs;
      readonly prepared: PreparedNormalSend;
    },
    signal: AbortSignal,
  ) => {
    const { args, prepared } = params;
    const threadId = prepared.thread.threadId;
    const { response, queuedEventId } = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_agent_web_chat_queue_first_enqueue",
      "nested",
      async () => {
        return await queueUnassociatedNormalEvent({
          prepared,
          timing: args.timing,
          body: prepared.body,
          userId: args.userId,
          touchThreadSort: shouldTouchThreadSortFromNormalSend(
            args.agentRunPreCreateSource,
            prepared.thread.isNewThread,
          ),
          orgId: args.orgId,
          publicBrand: args.publicBrand,
          ...(args.requiredOfficialWorkflowIds === undefined
            ? {}
            : {
                requiredOfficialWorkflowIds: args.requiredOfficialWorkflowIds,
              }),
        });
      },
    );
    signal.throwIfAborted();
    if (!queuedEventId) {
      // Duplicate clientEventId or an already-existing resolution — the
      // enqueue inserted nothing, so there is nothing to dispatch.
      return response;
    }

    const dispatch = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_agent_web_chat_queue_first_check_dispatchable",
      "nested",
      async (): Promise<"self" | "wait" | "drain"> => {
        if (await chatThreadAdmissionBlocked(prepared.db, { threadId })) {
          return "wait";
        }
        const headEventId = await loadNextUnclaimedQueuedUserMessageId(
          prepared.db,
          threadId,
        );
        return headEventId === queuedEventId ? "self" : "drain";
      },
    );
    signal.throwIfAborted();
    if (dispatch === "wait") {
      await publishChatEventCreated({
        userId: args.userId,
        orgId: args.orgId,
        threadId,
      });
      signal.throwIfAborted();
      await set(
        drainChatThreadQueueForThread$,
        {
          chatThreadId: threadId,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        },
        signal,
      );
      signal.throwIfAborted();
      return response;
    }
    if (dispatch === "drain") {
      // The thread is idle but an older unclaimed message holds the queue
      // head (e.g. left behind by a cancelled run). Dispatch the head so the
      // thread keeps draining; this message stays queued behind it (#21392).
      await publishChatEventCreated({
        userId: args.userId,
        orgId: args.orgId,
        threadId,
      });
      signal.throwIfAborted();
      await set(
        drainChatThreadQueueForThread$,
        {
          chatThreadId: threadId,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        },
        signal,
      );
      signal.throwIfAborted();
      return response;
    }

    const result = await set(
      createNormalChatRun$,
      { args, prepared, queueFirstEventId: queuedEventId },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === 201) {
      return result;
    }
    // Run creation failed validation before it could consume the queue item.
    // Discard the queued message so history matches the legacy direct-send
    // failure.
    await discardUnclaimedUserMessage(prepared.db, {
      threadId,
      eventId: queuedEventId,
    });
    signal.throwIfAborted();
    return result;
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
    const apiStartTime = now();
    const timing = new ApiDispatchTimingCollector();
    return await set(
      sendNormalEvent$,
      {
        body: canonicalNormalSendBody(body),
        auth,
        userId: auth.userId,
        orgId: auth.orgId,
        apiStartTime,
        publicBrand: PUBLIC_BRAND,
        timing,
      },
      signal,
    );
  },
);
