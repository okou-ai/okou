import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { isUnsupportedRunAdmission } from "./run-admission-input";
import { AGENT_EXECUTION_TIMEOUT_SECONDS } from "@okouai/api-contracts/contracts/runners";
import { runCreateBodySchema } from "@okouai/api-contracts/contracts/run-routes";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { ModelProviderCredentialScope } from "@okouai/api-contracts/contracts/model-providers";
import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import type { FirewallPolicies } from "@okouai/connectors/firewall-types";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import type { PiStableContextPromptProjection } from "@okouai/db/jsonb-contracts/pi-stable-context";
import { command } from "ccstate";

import type { Tx } from "../../lib/db-types";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { env } from "../../lib/env";
import { badRequestMessage, notFound, conflict } from "../../lib/error";
import { now } from "../../lib/time";
import { testOverride } from "../../lib/singleton";
import type { AuthContext } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import { joinAllInOrder } from "../utils";
import {
  completeAgentRun$,
  isEmptyRunConnectorScope,
  isQueueFirstRunClaimLost,
  isThreadSessionSnapshotStale,
  prepareAgentRun$,
  recordThreadSessionBindingRetryTelemetry,
  type CreateAgentRunArgs,
  type DispatchFailedRunCallbacks,
  type QueueFirstRunClaimLost,
  type RunConnectorCatalogSelection,
  type AgentRunModelPin,
} from "./agent-run-create.service";
import { buildAgentExecutionConfig } from "./agent-execution-config";
import {
  resolveChatThreadSession,
  type ChatThreadSessionResolution,
  type ChatThreadSessionRoute,
} from "./chat-session-continuity.service";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import {
  ApiDispatchPhaseCollector,
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensions,
  type ApiDispatchTimingDimensionsInput,
} from "./api-dispatch-timing.service";
import type { InternalRunCallbackKind } from "./internal-run-callback";
import {
  loadRunBootstrapSnapshotRows,
  materializeRunBootstrapContext,
  type RunBootstrapContext,
  type RunBootstrapSnapshotRows,
  type UserInfo,
} from "./run-bootstrap-context.service";
import type { RunWorkflowRef } from "./workflow-data.service";
import type { CustomConnectorDefinitionVersion } from "./agent-connector-scope.service";
import { loadConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import { expandConnectorServerFirewallPolicies } from "./connector-server-firewall-catalog.service";
import type { QueueFirstRunAssociation } from "./chat-queued-event.service";
import {
  resolveWebChatSessionPrompt,
  type WebChatSessionPromptContext,
} from "./web-chat-session-prompt.service";
import {
  captureActivePersonalModelProviderAccount,
  isPersonalSubscriptionProviderType,
} from "./model-provider-account.service";
import { piStableContextVariantDigest } from "./pi-stable-context.service";
import { buildAgentIdentityPrompt } from "./agent-identity-prompt.service";
import { buildAgentToolsPrompt } from "./agent-tools-prompt.service";

type AgentRunCreateBody = z.infer<typeof runCreateBodySchema>;
// Emitted as the agent_run_origin observability dimension. The values name what
// started the run, so the fallback is "direct" (not started by an automation)
// rather than a restatement that this is an agent run.
type AgentRunOrigin = "direct" | "workflow_automation";
export type AgentRunPreCreateSource =
  | "chat_callback_auto_send"
  | "workflow_slash_command";

const DISALLOWED_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "AskUserQuestion",
  "Skill(loop)",
  "Skill(loop *)",
] as const;

export interface AgentRunRequestAgent {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
  readonly defaultAgentId: string | null;
  readonly owner: string;
  readonly visibility: "public" | "private";
  readonly displayName: string | null;
  readonly description: string | null;
  readonly sound: string | null;
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
}

type AgentRunRecord = AgentRunRequestAgent;

/**
 * Request-scoped preparation facts from an entry point that already authorized
 * this exact user, organization, and Agent. These observations can remove
 * equivalent preflight reads, but they never authorize the later launch
 * transaction: compute admission still locks and revalidates Agent ownership
 * and erasure state before it claims input or inserts a Run.
 *
 * When this object is present, nullable Agent metadata and feature overrides
 * are authoritative observations. The bootstrap materializer may enrich an
 * omitted email from the same request's user-info row. Absence of the object
 * means those facts were not loaded and every existing database fallback
 * remains.
 */
export interface AuthorizedAgentRunRequestObservation {
  readonly userId: string;
  readonly orgId: string;
  readonly agent: AgentRunRequestAgent;
  readonly featureSwitchContext: FeatureSwitchContext;
}

function optionalAgentSetting(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

interface HttpRunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

interface InternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly payload: unknown;
}

type RunCallback = HttpRunCallback | InternalRunCallback;

interface AgentRunMetadata {
  readonly workflowAutomationId?: string;
  readonly triggerBrief?: string;
  readonly autonomyBudget?: number;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
}

interface CreateAgentRunCommandArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: AgentRunCreateBody;
  readonly apiStartTime: number;
  readonly triggerSource?: TriggerSource;
  readonly appendSystemPrompt?: string;
  readonly userInfoExtras?: Pick<
    UserInfo,
    | "slackDisplayName"
    | "slackUserId"
    | "feishuDisplayName"
    | "feishuOpenId"
    | "teamsUserDisplayName"
    | "teamsUserPrincipalName"
    | "teamsUserId"
    | "telegramDisplayName"
    | "telegramUsername"
    | "telegramUserId"
    | "telegramLanguage"
    | "agentphoneHandle"
  >;
  readonly callbacks?: readonly RunCallback[];
  readonly chatThreadId?: string;
  readonly connectorSourceId?: string;
  readonly threadSessionRoute?: ChatThreadSessionRoute;
  readonly webChatSessionPromptContext?: WebChatSessionPromptContext;
  readonly computerUseHostId?: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: BuiltInModelRuntimeRoute;
  readonly codexServiceTier?: CodexServiceTier;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly agentRunMetadata?: AgentRunMetadata;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly dispatchFailedCallbacks?: DispatchFailedRunCallbacks;
  readonly agentRunModelPin?: AgentRunModelPin;
  /** Immutable Pi eligibility captured by the caller's admission snapshot. */
  readonly piExecution: boolean;
  readonly timing?: ApiDispatchTimingCollector;
  readonly agentRunPreCreateSource?: AgentRunPreCreateSource;
  readonly preloadedFeatureSwitchContext?: FeatureSwitchContext;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
}

interface CreateQueueFirstAgentRunCommandArgs extends Omit<
  CreateAgentRunCommandArgs,
  "chatThreadId" | "agentRunModelPin"
> {
  readonly chatThreadId: string;
  readonly queueFirstAssociation: QueueFirstRunAssociation;
  /** Binds a caller-journaled occurrence inside the launch transaction. */
  readonly bindClaimedQueueFirstRun?: (tx: Tx, runId: string) => Promise<void>;
  readonly agentRunModelPin: AgentRunModelPin;
}

type AnyCreateAgentRunCommandArgs =
  | CreateAgentRunCommandArgs
  | CreateQueueFirstAgentRunCommandArgs;

export interface OfficialWorkflowBootstrapRequirement {
  readonly workflowIds: readonly string[];
  readonly queueFirstKind: QueueFirstRunAssociation["kind"] | null;
  readonly workflowAutomationId: string | null;
}

type OfficialWorkflowBootstrapRequirementHook = (
  requirement: OfficialWorkflowBootstrapRequirement,
) => Promise<void>;

const officialWorkflowBootstrapRequirementHook = testOverride<
  OfficialWorkflowBootstrapRequirementHook | undefined
>(() => {
  return undefined;
});

export function setOfficialWorkflowBootstrapRequirementHookForTest(
  hook: OfficialWorkflowBootstrapRequirementHook,
): void {
  officialWorkflowBootstrapRequirementHook.set(hook);
}

export function clearOfficialWorkflowBootstrapRequirementHookForTest(): void {
  officialWorkflowBootstrapRequirementHook.clear();
}

export interface AgentRunPiExecutionSnapshot {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string | undefined;
  readonly piExecution: boolean;
  readonly threadSessionCliAgentType: string | null | undefined;
}

type AgentRunPiExecutionSnapshotHook = (
  snapshot: AgentRunPiExecutionSnapshot,
) => Promise<void>;

const agentRunPiExecutionSnapshotHook = testOverride<
  AgentRunPiExecutionSnapshotHook | undefined
>(() => {
  return undefined;
});

export function setAgentRunPiExecutionSnapshotHookForTest(
  hook: AgentRunPiExecutionSnapshotHook,
): void {
  agentRunPiExecutionSnapshotHook.set(hook);
}

export function clearAgentRunPiExecutionSnapshotHookForTest(): void {
  agentRunPiExecutionSnapshotHook.clear();
}

function assertThreadBoundAgentRunHasQueueAssociation(
  args: AnyCreateAgentRunCommandArgs,
): void {
  if (!("queueFirstAssociation" in args)) {
    if (args.chatThreadId !== undefined) {
      throw new Error(
        "Thread-bound agent run requires a queue-first association",
      );
    }
    return;
  }
  if (args.queueFirstAssociation.threadId !== args.chatThreadId) {
    throw new Error(
      "Queue-first association must target the run's chat thread",
    );
  }
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: {
      error: {
        message,
        code: "FORBIDDEN",
      },
    },
  };
}

function buildExecutionTimeLimitPrompt(): string {
  const executionHours = AGENT_EXECUTION_TIMEOUT_SECONDS / (60 * 60);
  const executionHourUnit = executionHours === 1 ? "hour" : "hours";
  return [
    "# Execution Time Limit",
    "",
    `A single agent run has a maximum execution time of ${executionHours} ${executionHourUnit}.`,
    "Plan and prioritize the work so you can complete the most important in-scope tasks and provide a final response before the run ends.",
  ].join("\n");
}

function buildCurrentUserPrompt(
  userInfo: UserInfo,
  triggerSource: TriggerSource,
): string {
  const lines = ["# Current User Info"];
  if (userInfo.name) {
    lines.push(`Name: ${userInfo.name}`);
  }
  if (userInfo.email) {
    lines.push(`Email: ${userInfo.email}`);
  }
  lines.push(`Timezone: ${userInfo.timezone ?? "UTC"}`);
  if (userInfo.slackDisplayName) {
    lines.push(`Slack display name: ${userInfo.slackDisplayName}`);
  }
  if (userInfo.slackUserId) {
    lines.push(`Slack user ID: ${userInfo.slackUserId}`);
  }
  if (triggerSource === "feishu" || triggerSource === "lark") {
    const providerName = FEISHU_PLATFORMS[triggerSource].name;
    if (userInfo.feishuDisplayName) {
      lines.push(`${providerName} display name: ${userInfo.feishuDisplayName}`);
    }
    if (userInfo.feishuOpenId) {
      lines.push(`${providerName} open ID: ${userInfo.feishuOpenId}`);
    }
  }
  if (userInfo.teamsUserDisplayName) {
    lines.push(`Teams display name: ${userInfo.teamsUserDisplayName}`);
  }
  if (userInfo.teamsUserPrincipalName) {
    lines.push(`Teams user principal name: ${userInfo.teamsUserPrincipalName}`);
  }
  if (userInfo.teamsUserId) {
    lines.push(`Teams user ID: ${userInfo.teamsUserId}`);
  }
  if (userInfo.telegramDisplayName) {
    lines.push(`Telegram display name: ${userInfo.telegramDisplayName}`);
  }
  if (userInfo.telegramUsername) {
    lines.push(`Telegram username: ${userInfo.telegramUsername}`);
  }
  if (userInfo.telegramUserId) {
    lines.push(`Telegram user ID: ${userInfo.telegramUserId}`);
  }
  if (userInfo.telegramLanguage) {
    lines.push(`Telegram language: ${userInfo.telegramLanguage}`);
  }
  if (userInfo.agentphoneHandle) {
    lines.push(`Text message handle: ${userInfo.agentphoneHandle}`);
  }
  return lines.join("\n");
}

function buildAppendSystemPrompt(args: {
  readonly stable: PiStableContextPromptProjection;
  readonly userInfo: UserInfo;
  readonly triggerSource: TriggerSource;
}): string {
  return [
    args.stable.agentIdentity,
    args.stable.executionLimit,
    args.stable.tools,
    buildCurrentUserPrompt(args.userInfo, args.triggerSource),
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

type StableAgentPromptBuildHook = () => void;
type StableContextCacheIdentityBuildHook = () => void;

const stableAgentPromptBuildHook = testOverride<
  StableAgentPromptBuildHook | undefined
>(() => {
  return undefined;
});
const stableContextCacheIdentityBuildHook = testOverride<
  StableContextCacheIdentityBuildHook | undefined
>(() => {
  return undefined;
});

export function setStableAgentPromptBuildHookForTest(
  hook: StableAgentPromptBuildHook,
): void {
  stableAgentPromptBuildHook.set(hook);
}

export function clearStableAgentPromptBuildHookForTest(): void {
  stableAgentPromptBuildHook.clear();
}

export function setStableContextCacheIdentityBuildHookForTest(
  hook: StableContextCacheIdentityBuildHook,
): void {
  stableContextCacheIdentityBuildHook.set(hook);
}

export function clearStableContextCacheIdentityBuildHookForTest(): void {
  stableContextCacheIdentityBuildHook.clear();
}

function buildStableAgentPrompt(args: {
  readonly privateArtifactsEnabled: boolean;
  readonly agent: AgentRunRecord;
  readonly triggerSource: TriggerSource;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly bankingEnabled: boolean;
  readonly vncEnabled: boolean;
  readonly larkEnabled: boolean;
  readonly deliveryFormatGuidanceEnabled: boolean;
  readonly presentationConvertEnabled: boolean;
  readonly customConnectorMcpEnabled: boolean;
}): PiStableContextPromptProjection {
  stableAgentPromptBuildHook.get()?.();
  return {
    agentIdentity: buildAgentIdentityPrompt(args.agent) ?? "",
    executionLimit: buildExecutionTimeLimitPrompt(),
    tools: buildAgentToolsPrompt({
      privateArtifactsEnabled: args.privateArtifactsEnabled,
      triggerSource: args.triggerSource,
      cloudBrowserEnabled: args.cloudBrowserEnabled,
      bankingEnabled: args.bankingEnabled,
      vncEnabled: args.vncEnabled,
      larkEnabled: args.larkEnabled,
      deliveryFormatGuidanceEnabled: args.deliveryFormatGuidanceEnabled,
      presentationConvertEnabled: args.presentationConvertEnabled,
    }),
  };
}

async function inferAgentIdFromSession(
  db: Db,
  args: {
    readonly sessionId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<string | null> {
  const [session] = await db
    .select({ agentId: agentSessions.agentId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
      ),
    )
    .limit(1);

  return session?.agentId ?? null;
}

async function loadAgent(
  db: Db,
  agentId: string,
): Promise<AgentRunRecord | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      orgId: agents.orgId,
      defaultAgentId: orgMetadata.defaultAgentId,
      owner: agents.owner,
      visibility: agents.visibility,
      displayName: agents.displayName,
      description: agents.description,
      sound: agents.sound,
      modelProviderId: agents.modelProviderId,
      selectedModel: agents.selectedModel,
    })
    .from(agents)
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
    .where(eq(agents.id, agentId))
    .limit(1);

  return agent ?? null;
}

function buildAgentRunPlatformEnvironment(args: {
  readonly agentId: string;
  readonly triggerSource: TriggerSource;
  readonly chatThreadId: string | undefined;
  readonly codexServiceTier: "fast" | undefined;
  readonly reasoningEffort?: ReasoningEffort | null;
}): Record<string, string> {
  const integrationByTriggerSource: Partial<Record<TriggerSource, string>> = {
    web: "web",
    agent: "web",
    slack: "slack",
    teams: "teams",
    feishu: "feishu",
    lark: "lark",
    telegram: "telegram",
    agentphone: "phone",
    github: "github",
  };
  const currentIntegration = integrationByTriggerSource[args.triggerSource];
  return {
    OKOU_APP_URL: env("APP_URL"),
    OKOU_AGENT_ID: args.agentId,
    ...(currentIntegration
      ? { OKOU_CURRENT_INTEGRATION: currentIntegration }
      : {}),
    ...(args.reasoningEffort !== null && args.reasoningEffort !== undefined
      ? { OKOU_REASONING_EFFORT: args.reasoningEffort }
      : {}),
    // Chat-mode automation (and web) runs carry their thread id so the
    // in-sandbox CLI can bind a newly created automation to it (the create
    // flow reads $OKOU_CHAT_THREAD_ID when no thread is given).
    ...(args.chatThreadId
      ? {
          OKOU_CHAT_THREAD_ID: args.chatThreadId,
        }
      : {}),
    ...(args.codexServiceTier
      ? {
          OKOU_CODEX_SERVICE_TIER: args.codexServiceTier,
        }
      : {}),
  };
}

function agentRunTimingDimensions(args: {
  readonly origin: AgentRunOrigin;
  readonly command: AnyCreateAgentRunCommandArgs;
  readonly source?: AgentRunPreCreateSource;
}): ApiDispatchTimingDimensions {
  const apiStartSource =
    "queueFirstAssociation" in args.command
      ? args.command.queueFirstAssociation.kind
      : "request";
  return {
    agent_run_origin: args.origin,
    api_start_source: apiStartSource,
    ...(args.source ? { agent_run_pre_create_source: args.source } : {}),
  };
}

type BootstrapCountBucket = "0" | "1" | "2_4" | "5_8" | "9_16" | "17_plus";

function bootstrapCountBucket(count: number): BootstrapCountBucket {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

function bootstrapLoadTimingDimensions(
  rows: RunBootstrapSnapshotRows | undefined,
): ApiDispatchTimingDimensions | undefined {
  if (!rows) {
    return undefined;
  }
  return {
    agent_run_bootstrap_total_row_count_bucket: bootstrapCountBucket(
      rows.metadataRows.length + rows.workflowRows.length,
    ),
    agent_run_bootstrap_workflow_candidate_count_bucket: bootstrapCountBucket(
      rows.workflowRows.length,
    ),
  };
}

function bootstrapMaterializeTimingDimensions(
  rows: RunBootstrapSnapshotRows,
  context: RunBootstrapContext | undefined,
): ApiDispatchTimingDimensions {
  return {
    ...bootstrapLoadTimingDimensions(rows),
    ...(context
      ? {
          agent_run_bootstrap_workflow_winner_count_bucket:
            bootstrapCountBucket(context.workflows.length),
        }
      : {}),
  };
}

function agentRunOrigin(args: {
  readonly command: AnyCreateAgentRunCommandArgs;
}): AgentRunOrigin {
  if (args.command.agentRunMetadata?.workflowAutomationId) {
    return "workflow_automation";
  }
  return "direct";
}

function createRunBody(args: {
  readonly body: AgentRunCreateBody;
  readonly agent: AgentRunRecord;
  readonly userInfo: UserInfo;
  readonly stablePrompt: PiStableContextPromptProjection;
  readonly permissionPolicies: FirewallPolicies | null | undefined;
  readonly triggerSource: TriggerSource | undefined;
  readonly appendSystemPrompt: string | undefined;
}) {
  const triggerSource = args.triggerSource ?? "web";
  const baseAppendSystemPrompt = buildAppendSystemPrompt({
    stable: args.stablePrompt,
    userInfo: args.userInfo,
    triggerSource,
  });
  return {
    prompt: args.body.prompt,
    agentId: args.agent.id,
    sessionId: args.body.sessionId,
    conversationId: args.body.conversationId,
    additionalVolumes: args.body.additionalVolumes,
    realAgentInPreview: args.body.realAgentInPreview,
    captureNetworkBodies: args.body.captureNetworkBodies,
    tools: args.body.tools,
    settings: args.body.settings,
    permissionPolicies: args.permissionPolicies ?? undefined,
    triggerSource,
    appendSystemPrompt: [baseAppendSystemPrompt, args.appendSystemPrompt]
      .filter((part): part is string => {
        return Boolean(part);
      })
      .join("\n\n"),
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: {
      OKOU_AGENT_ID: args.agent.id,
    },
  };
}

function measureAgentRunPreCreate<T>(
  timing: ApiDispatchTimingCollector | undefined,
  actionType: ApiDispatchTimingActionType,
  operation: () => T | Promise<T>,
  dimensions?: ApiDispatchTimingDimensionsInput,
): Promise<T> {
  return measureApiDispatchTiming(
    timing,
    actionType,
    "nested",
    operation,
    dimensions,
  );
}

function serviceEntryTiming(args: {
  readonly apiStartTime: number;
  readonly timing?: ApiDispatchTimingCollector;
}): ApiDispatchTimingCollector {
  const timing = args.timing ?? new ApiDispatchTimingCollector();
  if (!args.timing) {
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_entrypoint_gap",
      "nested",
      args.apiStartTime,
    );
  }
  return timing;
}

async function resolveAgentRunAgentId(
  db: Db,
  args: AnyCreateAgentRunCommandArgs,
): Promise<string | null> {
  return (
    args.body.agentId ??
    (args.body.sessionId
      ? await inferAgentIdFromSession(db, {
          sessionId: args.body.sessionId,
          userId: args.auth.userId,
          orgId: args.auth.orgId,
        })
      : null)
  );
}

export type AgentRunPreCreateParallelStage =
  | "subscription-account"
  | "post-authorization-context"
  | "thread-session";

type AgentRunPreCreateParallelHook = (args: {
  readonly stage: AgentRunPreCreateParallelStage;
  readonly userId: string;
  readonly orgId: string;
}) => Promise<void>;

const agentRunPreCreateParallelHook = testOverride<
  AgentRunPreCreateParallelHook | undefined
>(() => {
  return undefined;
});

export function setAgentRunPreCreateParallelHookForTest(
  hook: AgentRunPreCreateParallelHook,
): void {
  agentRunPreCreateParallelHook.set(hook);
}

export function clearAgentRunPreCreateParallelHookForTest(): void {
  agentRunPreCreateParallelHook.clear();
}

function observeAgentRunPreCreateParallelStage(
  stage: AgentRunPreCreateParallelStage,
  input: Pick<AgentRunAfterBootstrap, "command">,
): Promise<void> | undefined {
  return agentRunPreCreateParallelHook.get()?.({
    stage,
    userId: input.command.auth.userId,
    orgId: input.command.auth.orgId,
  });
}

interface AgentRunAfterBootstrap extends RunBootstrapContext {
  readonly agent: AgentRunRecord;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
  readonly timing: ApiDispatchTimingCollector;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly command: AnyCreateAgentRunCommandArgs;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
}

interface AgentRunAfterPreCreate extends AgentRunAfterBootstrap {
  readonly runPermissionPolicies: FirewallPolicies | null | undefined;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
}

async function loadAgentRunBootstrapContext(
  db: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly apiStartTime: number;
    readonly timing: ApiDispatchTimingCollector;
    readonly preloadedFeatureSwitchContext?: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<RunBootstrapContext> {
  let measuredSnapshotRows: RunBootstrapSnapshotRows | undefined;
  const snapshotRows = await measureAgentRunPreCreate(
    args.timing,
    "api_dispatch_pre_create_agent_load_bootstrap_snapshot_rows",
    async () => {
      const loadedRows = await loadRunBootstrapSnapshotRows(
        db,
        {
          userId: args.userId,
          orgId: args.orgId,
          agentId: args.agentId,
          checkedAt: new Date(args.apiStartTime),
        },
        args.preloadedFeatureSwitchContext,
      );
      measuredSnapshotRows = loadedRows;
      return loadedRows;
    },
    () => {
      return {
        ...bootstrapLoadTimingDimensions(measuredSnapshotRows),
        bootstrap_feature_context_source:
          args.preloadedFeatureSwitchContext === undefined
            ? "database"
            : "request_observation",
      };
    },
  );
  signal.throwIfAborted();

  let measuredBootstrapContext: RunBootstrapContext | undefined;
  const bootstrapContext = await measureAgentRunPreCreate(
    args.timing,
    "api_dispatch_pre_create_agent_materialize_bootstrap_context",
    () => {
      const context = materializeRunBootstrapContext(
        snapshotRows,
        {
          userId: args.userId,
          orgId: args.orgId,
        },
        args.preloadedFeatureSwitchContext,
      );
      measuredBootstrapContext = context;
      return context;
    },
    () => {
      return bootstrapMaterializeTimingDimensions(
        snapshotRows,
        measuredBootstrapContext,
      );
    },
  );
  signal.throwIfAborted();
  return bootstrapContext;
}

async function completeAgentRunPostAuthorizationContext(
  db: Db,
  input: AgentRunAfterBootstrap,
  signal: AbortSignal,
): Promise<AgentRunAfterPreCreate> {
  const testHold = observeAgentRunPreCreateParallelStage(
    "post-authorization-context",
    input,
  );
  if (testHold) {
    await testHold;
  }
  const connectorCatalogSelection: RunConnectorCatalogSelection =
    isEmptyRunConnectorScope(input)
      ? { kind: "empty" }
      : {
          kind: "scoped",
          selection: await loadConnectorRuntimeSelection(db, {
            timing: input.timing,
            requestedConnectorSlugs: input.allowedConnectorSlugs,
            metadataConnectorSlugs: input.connectorCatalogMetadataSlugs,
          }),
        };
  signal.throwIfAborted();
  const runPermissionPolicies = await measureAgentRunPreCreate(
    input.timing,
    "api_dispatch_pre_create_agent_resolve_firewall_metadata",
    async () => {
      const storedPermissionPolicies = permissionGrantsToFirewallPolicies(
        input.permissionGrants,
      );
      if (connectorCatalogSelection.kind === "empty") {
        return storedPermissionPolicies;
      }
      return await expandConnectorServerFirewallPolicies({
        catalog: connectorCatalogSelection.selection.serverFirewalls,
        stored: storedPermissionPolicies,
        connectorSlugs: [...input.allowedConnectorSlugs],
      });
    },
  );
  signal.throwIfAborted();

  return {
    ...input,
    connectorCatalogSelection,
    runPermissionPolicies,
  };
}

interface BuildCreateAgentRunArgsInput {
  readonly command: AnyCreateAgentRunCommandArgs;
  readonly agent: AgentRunRecord;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
  readonly userInfo: UserInfo;
  readonly runPermissionPolicies: FirewallPolicies | null | undefined;
  readonly permissionValidityHorizon: string | null;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly workflows: readonly RunWorkflowRef[];
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants: readonly AgentCustomConnectorGrant[];
  readonly customConnectorDefinitions: readonly CustomConnectorDefinitionVersion[];
  readonly timing: ApiDispatchTimingCollector;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
}

function emptyStablePrompt(): PiStableContextPromptProjection {
  return {
    agentIdentity: "",
    executionLimit: "",
    tools: "",
  };
}

function buildStableRunPromptContext(args: BuildCreateAgentRunArgsInput): {
  readonly userInfo: UserInfo;
  readonly initialStablePrompt: PiStableContextPromptProjection;
  readonly piStableContext: NonNullable<CreateAgentRunArgs["piStableContext"]>;
} {
  const promptInputs = {
    privateArtifactsEnabled: isFeatureEnabled(
      FeatureSwitchKey.PrivateArtifacts,
      args.featureSwitchContext,
    ),
    bankingEnabled: isFeatureEnabled(
      FeatureSwitchKey.Banking,
      args.featureSwitchContext,
    ),
    vncEnabled: isFeatureEnabled(
      FeatureSwitchKey.VncAccess,
      args.featureSwitchContext,
    ),
    larkEnabled: isFeatureEnabled(
      FeatureSwitchKey.LarkIntegration,
      args.featureSwitchContext,
    ),
    deliveryFormatGuidanceEnabled: isFeatureEnabled(
      FeatureSwitchKey.DeliveryFormatGuidance,
      args.featureSwitchContext,
    ),
    presentationConvertEnabled: isFeatureEnabled(
      FeatureSwitchKey.PresentationConvert,
      args.featureSwitchContext,
    ),
    customConnectorMcpEnabled: true,
    triggerSource: args.command.triggerSource ?? "web",
    cloudBrowserEnabled: args.cloudBrowserEnabled,
  };
  const userInfo = { ...args.userInfo, ...args.command.userInfoExtras };
  const connectorScope = {
    allowedConnectorSlugs: args.allowedConnectorSlugs,
    allowedCustomConnectorIds: args.allowedCustomConnectorIds,
    customConnectorGrants: args.customConnectorGrants,
    customConnectorDefinitions: args.customConnectorDefinitions,
    workflows: args.workflows,
  };
  let stablePrompt: PiStableContextPromptProjection | undefined;
  const buildPrompt = () => {
    stablePrompt ??= buildStableAgentPrompt({
      ...promptInputs,
      agent: args.agent,
    });
    return stablePrompt;
  };
  let cacheIdentity:
    | ReturnType<
        NonNullable<CreateAgentRunArgs["piStableContext"]>["buildCacheIdentity"]
      >
    | undefined;
  const buildCacheIdentity = () => {
    if (cacheIdentity) {
      return cacheIdentity;
    }
    stableContextCacheIdentityBuildHook.get()?.();
    const agentIdentity = buildAgentIdentityPrompt(args.agent) ?? "";
    cacheIdentity = {
      owner: {
        orgId: args.command.auth.orgId,
        userId: args.command.auth.userId,
        agentId: args.agent.id,
        resourceOwner: {
          orgId: args.agent.orgId,
          userId: args.agent.owner,
        },
      },
      variantDigest: piStableContextVariantDigest({
        triggerSource: promptInputs.triggerSource,
        cloudBrowserEnabled: promptInputs.cloudBrowserEnabled,
        connectorSource: "stored_agent",
      }),
      semantic: { promptInputs, connectorScope },
      source: {
        catalogIdentity:
          args.connectorCatalogSelection.kind === "scoped"
            ? piStableContextVariantDigest(
                args.connectorCatalogSelection.selection.catalogIdentity,
              )
            : null,
        catalogSourceId:
          args.connectorCatalogSelection.kind === "scoped"
            ? args.connectorCatalogSelection.selection.catalogIdentity.sourceId
            : null,
        agentIdentityDigest: piStableContextVariantDigest(agentIdentity),
        featurePromptDigest: piStableContextVariantDigest(promptInputs),
        permissionDigest: piStableContextVariantDigest(
          args.runPermissionPolicies ?? null,
        ),
        connectorScopeDigest: piStableContextVariantDigest(connectorScope),
        validityHorizon: args.permissionValidityHorizon,
        promptSchemaVersion: 1,
        runtimeSchemaVersion: 1,
      },
    };
    return cacheIdentity;
  };
  return {
    userInfo,
    initialStablePrompt: args.command.piExecution
      ? emptyStablePrompt()
      : buildPrompt(),
    piStableContext: {
      buildPrompt,
      buildCacheIdentity,
      dynamicAppendSystemPrompt: [
        buildCurrentUserPrompt(userInfo, promptInputs.triggerSource),
        args.command.appendSystemPrompt,
      ]
        .filter((part): part is string => {
          return Boolean(part);
        })
        .join("\n\n"),
    },
  };
}

function buildCreateAgentRunArgs(
  args: BuildCreateAgentRunArgsInput,
): CreateAgentRunArgs {
  const command = args.command;
  const agentModelProviderId = optionalAgentSetting(args.agent.modelProviderId);
  const agentSelectedModel = optionalAgentSetting(args.agent.selectedModel);
  const { userInfo, initialStablePrompt, piStableContext } =
    buildStableRunPromptContext(args);
  const productAgentExecutionPlan = {
    identity: "agent" as const,
    content: buildAgentExecutionConfig(args.agent.name),
  };
  return {
    userId: command.auth.userId,
    orgId: command.auth.orgId,
    body: createRunBody({
      body: command.body,
      agent: args.agent,
      userInfo,
      stablePrompt: initialStablePrompt,
      permissionPolicies: args.runPermissionPolicies,
      triggerSource: command.triggerSource,
      appendSystemPrompt: command.appendSystemPrompt,
    }),
    apiStartTime: command.apiStartTime,
    piStableContext,
    modelProviderId: command.modelProviderId ?? agentModelProviderId,
    modelProviderCredentialScope: command.modelProviderCredentialScope,
    modelProviderType: command.body.modelProvider,
    selectedModelOverride: command.selectedModelOverride ?? agentSelectedModel,
    ...(command.builtInModelRuntimeRoute
      ? { builtInModelRuntimeRoute: command.builtInModelRuntimeRoute }
      : {}),
    ...(command.codexServiceTier === "fast"
      ? { codexServiceTier: command.codexServiceTier }
      : {}),
    chatThreadId: command.chatThreadId,
    ...(command.connectorSourceId
      ? { connectorSourceId: command.connectorSourceId }
      : {}),
    ...(args.threadSessionResolution
      ? { threadSessionResolution: args.threadSessionResolution }
      : {}),
    platformEnvironment: buildAgentRunPlatformEnvironment({
      agentId: args.agent.id,
      triggerSource: command.triggerSource ?? "web",
      chatThreadId: command.chatThreadId,
      codexServiceTier: command.codexServiceTier,
      reasoningEffort: command.reasoningEffort,
    }),
    callbacks: command.callbacks,
    includeOkouTokenSecret: true,
    productAgentExecutionPlan,
    ...(args.authorizedRequestObservation
      ? {
          preloadedAgentExecutionObservation: {
            requestUserId: args.authorizedRequestObservation.userId,
            requestOrgId: args.authorizedRequestObservation.orgId,
            agentId: args.agent.id,
            ownerUserId: args.agent.owner,
            agentOrgId: args.agent.orgId,
          },
        }
      : {}),
    okouTokenComputerUseHostId: command.computerUseHostId,
    okouTokenCloudBrowserEnabled: args.cloudBrowserEnabled,
    enforceBuiltInCredits: true,
    queueOnConcurrencyLimit: true,
    injectSkillVolumes: { workflows: args.workflows },
    requiredOfficialWorkflowIds: command.requiredOfficialWorkflowIds,
    connectorScope: {
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      allowedCustomConnectorIds: args.allowedCustomConnectorIds,
      customConnectorGrants: args.customConnectorGrants,
      source: "stored_agent",
    },
    validateEnvironmentReferences: false,
    agentRunMetadata: {
      ...command.agentRunMetadata,
      codexServiceTier: command.codexServiceTier,
      reasoningEffort: command.reasoningEffort,
    },
    dispatchFailedCallbacks: command.dispatchFailedCallbacks,
    ...(command.agentRunModelPin
      ? { agentRunModelPin: command.agentRunModelPin }
      : {}),
    piExecution: command.piExecution,
    ...("queueFirstAssociation" in command
      ? { queueFirstAssociation: command.queueFirstAssociation }
      : {}),
    ...("bindClaimedQueueFirstRun" in command &&
    command.bindClaimedQueueFirstRun
      ? { bindClaimedQueueFirstRun: command.bindClaimedQueueFirstRun }
      : {}),
    timing: args.timing,
    timingDimensions: agentRunTimingDimensions({
      origin: agentRunOrigin({
        command,
      }),
      command,
      source: command.agentRunPreCreateSource,
    }),
  };
}

async function captureSubscriptionAccount(
  db: Db,
  input: AgentRunAfterBootstrap,
  signal: AbortSignal,
): Promise<AgentRunAfterBootstrap | ReturnType<typeof conflict>> {
  const { command } = input;
  const pin = command.agentRunModelPin;
  if (
    !pin ||
    !pin.modelProvider ||
    !isPersonalSubscriptionProviderType(pin.modelProvider) ||
    pin.modelProviderCredentialScope === "org"
  ) {
    return input;
  }
  const testHold = observeAgentRunPreCreateParallelStage(
    "subscription-account",
    input,
  );
  if (testHold) {
    await testHold;
  }
  const account = await captureActivePersonalModelProviderAccount(
    {
      type: pin.modelProvider,
      db,
      orgId: command.auth.orgId,
      userId: command.auth.userId,
      modelProviderId: pin.modelProviderId,
      featureSwitchContext: input.featureSwitchContext,
    },
    signal,
  );
  if (!account) {
    return conflict(
      "The selected subscription account is unavailable. Reconnect it before starting another run.",
    );
  }
  return {
    ...input,
    command: {
      ...command,
      modelProviderId: account.id,
      agentRunModelPin: {
        ...pin,
        modelProviderId: account.id,
      },
    },
  };
}

interface AgentRunThreadSessionPreparation {
  readonly body: AgentRunCreateBody;
  readonly appendSystemPrompt: string | undefined;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly cloudBrowserEnabled: boolean | undefined;
}

async function resolveThreadSessionForAgentRun(
  db: Db,
  input: AgentRunAfterBootstrap,
): Promise<AgentRunThreadSessionPreparation> {
  const threadId = input.command.chatThreadId;
  if (!threadId) {
    return {
      body: input.command.body,
      appendSystemPrompt: input.command.appendSystemPrompt,
      threadSessionResolution: input.threadSessionResolution,
      cloudBrowserEnabled: input.cloudBrowserEnabled,
    };
  }
  const testHold = observeAgentRunPreCreateParallelStage(
    "thread-session",
    input,
  );
  if (testHold) {
    await testHold;
  }
  const threadSessionRoute = input.command.threadSessionRoute;
  if (!threadSessionRoute) {
    throw new Error("Thread-bound agent run is missing its model route");
  }
  const resolution = await measureAgentRunPreCreate(
    input.timing,
    "api_dispatch_pre_create_agent_resolve_thread_session",
    () => {
      return resolveChatThreadSession({
        db,
        threadId,
        userId: input.command.auth.userId,
        orgId: input.command.auth.orgId,
        agentId: input.agent.id,
        route: threadSessionRoute,
      });
    },
  );
  const webChatSessionPromptContext = input.command.webChatSessionPromptContext;
  const sessionPrompt = webChatSessionPromptContext
    ? await measureAgentRunPreCreate(
        input.timing,
        "api_dispatch_pre_create_agent_web_chat_resolve_session_prompt_context",
        () => {
          return resolveWebChatSessionPrompt({
            db,
            threadId,
            sessionAction: resolution.action,
            context: webChatSessionPromptContext,
          });
        },
      )
    : input.command.appendSystemPrompt;
  const body: AgentRunCreateBody = { ...input.command.body };
  if (resolution.sessionId) {
    body.sessionId = resolution.sessionId;
  } else {
    delete body.sessionId;
  }
  return {
    body,
    appendSystemPrompt: sessionPrompt,
    threadSessionResolution: resolution,
    cloudBrowserEnabled: resolution.cloudBrowserEnabled,
  };
}

function applyAgentRunThreadSessionPreparation(
  postAuthorization: AgentRunAfterPreCreate,
  threadSession: AgentRunThreadSessionPreparation,
): AgentRunAfterPreCreate {
  return {
    ...postAuthorization,
    command: {
      ...postAuthorization.command,
      body: threadSession.body,
      appendSystemPrompt: threadSession.appendSystemPrompt,
    },
    threadSessionResolution: threadSession.threadSessionResolution,
    cloudBrowserEnabled: threadSession.cloudBrowserEnabled,
  };
}

async function joinAgentRunAttemptPreparation(
  postAuthorization: Promise<AgentRunAfterPreCreate>,
  threadSession: Promise<AgentRunThreadSessionPreparation>,
  signal: AbortSignal,
): Promise<AgentRunAfterPreCreate> {
  // Preserve the historical post-authorization -> session error precedence,
  // but settle both owned branches before surfacing either failure.
  const [postAuthorizationResult, threadSessionResult] = await joinAllInOrder(
    [postAuthorization, threadSession],
    signal,
  );
  return applyAgentRunThreadSessionPreparation(
    postAuthorizationResult,
    threadSessionResult,
  );
}

async function captureAndCompleteAgentRunPostAuthorizationContext(
  db: Db,
  input: AgentRunAfterBootstrap,
  signal: AbortSignal,
): Promise<AgentRunAfterPreCreate | ReturnType<typeof conflict>> {
  const capturedInput = await measureAgentRunPreCreate(
    input.timing,
    "api_dispatch_pre_create_agent_capture_subscription_account",
    () => {
      return captureSubscriptionAccount(db, input, signal);
    },
  );
  signal.throwIfAborted();
  if ("status" in capturedInput) {
    return capturedInput;
  }
  return await completeAgentRunPostAuthorizationContext(
    db,
    capturedInput,
    signal,
  );
}

type InitialAgentRunPreparation =
  | {
      readonly postAuthorization: AgentRunAfterPreCreate;
      readonly attemptInput: AgentRunAfterPreCreate;
    }
  | ReturnType<typeof conflict>;

async function joinInitialAgentRunPreparation(
  captureAndPostAuthorization: Promise<
    AgentRunAfterPreCreate | ReturnType<typeof conflict>
  >,
  threadSession: Promise<AgentRunThreadSessionPreparation>,
  signal: AbortSignal,
): Promise<InitialAgentRunPreparation> {
  // Capture can fulfill with a domain conflict instead of rejecting. Settle
  // both owned branches, then keep the capture dependency authoritative over
  // any speculative thread failure.
  const [postAuthorizationResult, threadSessionResult] =
    await Promise.allSettled([captureAndPostAuthorization, threadSession]);

  if (postAuthorizationResult.status === "rejected") {
    throw postAuthorizationResult.reason;
  }
  if ("status" in postAuthorizationResult.value) {
    signal.throwIfAborted();
    return postAuthorizationResult.value;
  }
  if (threadSessionResult.status === "rejected") {
    throw threadSessionResult.reason;
  }
  signal.throwIfAborted();
  return {
    postAuthorization: postAuthorizationResult.value,
    attemptInput: applyAgentRunThreadSessionPreparation(
      postAuthorizationResult.value,
      threadSessionResult.value,
    ),
  };
}

const THREAD_SESSION_PREPARATION_ATTEMPTS = 3;

const createAgentRunAfterPreCreate$ = command(
  async ({ set }, input: AgentRunAfterBootstrap, signal: AbortSignal) => {
    const db = set(writeDb$);
    const initialPreparation = await joinInitialAgentRunPreparation(
      captureAndCompleteAgentRunPostAuthorizationContext(db, input, signal),
      resolveThreadSessionForAgentRun(db, input),
      signal,
    );
    if ("status" in initialPreparation) {
      return initialPreparation;
    }
    const { postAuthorization } = initialPreparation;
    for (
      let attempt = 0;
      attempt < THREAD_SESSION_PREPARATION_ATTEMPTS;
      attempt += 1
    ) {
      const attemptInput =
        attempt === 0
          ? initialPreparation.attemptInput
          : await joinAgentRunAttemptPreparation(
              Promise.resolve(postAuthorization),
              resolveThreadSessionForAgentRun(db, postAuthorization),
              signal,
            );
      const baseCreateAgentRunArgs = await measureAgentRunPreCreate(
        postAuthorization.timing,
        "api_dispatch_pre_create_agent_build_create_run_args",
        () => {
          return buildCreateAgentRunArgs(attemptInput);
        },
      );
      signal.throwIfAborted();
      const createAgentRunArgs: CreateAgentRunArgs = {
        ...baseCreateAgentRunArgs,
        timingDimensions: {
          ...baseCreateAgentRunArgs.timingDimensions,
          run_preparation_retry_count: String(attempt),
        },
      };
      const phaseTiming = new ApiDispatchPhaseCollector(
        postAuthorization.command.apiStartTime,
      );
      postAuthorization.timing.recordElapsed(
        "api_dispatch_pre_create_agent_run",
        "top_level",
        postAuthorization.command.apiStartTime,
      );
      phaseTiming.checkpoint("api_dispatch_phase_pre_create", now());
      const preparedAgentRun = await set(
        prepareAgentRun$,
        {
          args: createAgentRunArgs,
          timing: postAuthorization.timing,
          phaseTiming,
          checkOrgPlanStatusBeforeContext: false,
          preloadedFeatureSwitchContext: postAuthorization.featureSwitchContext,
          preloadedUserTimezone: postAuthorization.userInfo.timezone,
          ...(attemptInput.connectorCatalogSelection.kind === "scoped"
            ? {
                preloadedConnectorCatalogSnapshot:
                  attemptInput.connectorCatalogSelection.selection,
              }
            : {}),
        },
        signal,
      );
      signal.throwIfAborted();
      if ("status" in preparedAgentRun) {
        return preparedAgentRun;
      }

      const result = await set(
        completeAgentRun$,
        {
          prepared: preparedAgentRun,
          finalAppendSystemPrompt: createAgentRunArgs.body.appendSystemPrompt,
        },
        signal,
      );
      if (!isThreadSessionSnapshotStale(result)) {
        return result;
      }
      recordThreadSessionBindingRetryTelemetry(result);
      signal.throwIfAborted();
    }
    throw new Error("Chat thread session changed during every run preparation");
  },
);

function matchingPreloadedFeatureSwitchContext(
  args: AnyCreateAgentRunCommandArgs,
): FeatureSwitchContext | undefined {
  const context = args.preloadedFeatureSwitchContext;
  return context?.userId === args.auth.userId &&
    context.orgId === args.auth.orgId
    ? context
    : undefined;
}

function matchingAuthorizedRequestObservation(
  args: AnyCreateAgentRunCommandArgs,
  agentId: string,
): AuthorizedAgentRunRequestObservation | undefined {
  const observation = args.authorizedRequestObservation;
  if (
    !observation ||
    observation.userId !== args.auth.userId ||
    observation.orgId !== args.auth.orgId ||
    observation.agent.id !== agentId ||
    observation.agent.orgId !== args.auth.orgId ||
    observation.featureSwitchContext.userId !== args.auth.userId ||
    observation.featureSwitchContext.orgId !== args.auth.orgId
  ) {
    return undefined;
  }
  return observation;
}

const createAgentRunInternal$ = command(
  async ({ set }, args: AnyCreateAgentRunCommandArgs, signal: AbortSignal) => {
    assertThreadBoundAgentRunHasQueueAssociation(args);
    const timing = serviceEntryTiming({
      apiStartTime: args.apiStartTime,
      timing: args.timing,
    });
    const db = set(writeDb$);

    const agentId = await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_resolve_agent_id",
      async () => {
        return await resolveAgentRunAgentId(db, args);
      },
    );
    signal.throwIfAborted();

    if (!agentId) {
      return args.body.sessionId
        ? notFound("Session not found")
        : badRequestMessage("Missing agentId or sessionId");
    }

    const authorizedRequestObservation = matchingAuthorizedRequestObservation(
      args,
      agentId,
    );
    const preloadedFeatureSwitchContext =
      authorizedRequestObservation?.featureSwitchContext ??
      matchingPreloadedFeatureSwitchContext(args);
    const agent = await measureAgentRunPreCreate(
      timing,
      "api_dispatch_pre_create_agent_load_agent",
      async () => {
        return (
          authorizedRequestObservation?.agent ?? (await loadAgent(db, agentId))
        );
      },
      {
        authorized_request_agent_source:
          authorizedRequestObservation === undefined
            ? "database"
            : "request_observation",
      },
    );
    signal.throwIfAborted();
    if (!agent || agent.orgId !== args.auth.orgId) {
      return notFound("Agent not found");
    }

    if (agent.visibility === "private" && agent.owner !== args.auth.userId) {
      return forbidden("Only the private agent owner can run this agent");
    }

    if (args.requiredOfficialWorkflowIds?.length) {
      await officialWorkflowBootstrapRequirementHook.get()?.({
        workflowIds: args.requiredOfficialWorkflowIds,
        queueFirstKind:
          "queueFirstAssociation" in args
            ? args.queueFirstAssociation.kind
            : null,
        workflowAutomationId:
          args.agentRunMetadata?.workflowAutomationId ?? null,
      });
      signal.throwIfAborted();
    }

    await agentRunPiExecutionSnapshotHook.get()?.({
      userId: args.auth.userId,
      orgId: args.auth.orgId,
      chatThreadId: args.chatThreadId,
      piExecution: args.piExecution,
      threadSessionCliAgentType: args.threadSessionRoute?.cliAgentType,
    });
    signal.throwIfAborted();

    const bootstrapContext = await loadAgentRunBootstrapContext(
      db,
      {
        userId: args.auth.userId,
        orgId: args.auth.orgId,
        agentId: agent.id,
        apiStartTime: args.apiStartTime,
        timing,
        ...(preloadedFeatureSwitchContext
          ? { preloadedFeatureSwitchContext }
          : {}),
      },
      signal,
    );

    return await set(
      createAgentRunAfterPreCreate$,
      {
        ...bootstrapContext,
        command: args,
        agent,
        ...(authorizedRequestObservation
          ? { authorizedRequestObservation }
          : {}),
        timing,
        cloudBrowserEnabled: undefined,
      },
      signal,
    );
  },
);

/**
 * Test-fixture adapter for exercising run behavior that has no production
 * entry point. Production run sources must use createQueueFirstAgentRun$.
 */
export const createTestFixtureAgentRun$ = command(
  async ({ set }, args: CreateAgentRunCommandArgs, signal: AbortSignal) => {
    const result = await set(createAgentRunInternal$, args, signal);
    if (isQueueFirstRunClaimLost(result)) {
      throw new Error("Agent run without a queue association lost a claim");
    }
    return result;
  },
);

export const createQueueFirstAgentRun$ = command(
  async (
    { set },
    args: CreateQueueFirstAgentRunCommandArgs,
    signal: AbortSignal,
  ) => {
    if (
      isUnsupportedRunAdmission(args.triggerSource, args.queueFirstAssociation)
    ) {
      return conflict("Unsupported run input");
    }
    const result = await set(createAgentRunInternal$, args, signal);
    if (isQueueFirstRunClaimLost(result)) {
      const lostResult: QueueFirstRunClaimLost = result;
      return lostResult;
    }
    if (result.status !== 201) {
      return result;
    }
    if (!result.queueFirstClaim) {
      throw new Error("Queue-first run committed without claim metadata");
    }
    return { ...result, queueFirstClaim: result.queueFirstClaim };
  },
);
