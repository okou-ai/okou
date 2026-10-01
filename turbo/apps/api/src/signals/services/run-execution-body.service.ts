/**
 * Run body and Agent execution resolution: identity/selection arguments,
 * compose validation, merged variables and the runtime body environment.
 * Moved verbatim out of the legacy execution graph.
 */
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  measureApiDispatchTiming,
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensionsInput,
} from "./api-dispatch-timing.service";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  type SupportedFramework,
  isSupportedFramework,
} from "@okouai/core/frameworks";
import { env } from "../../lib/env";
import { extractAndGroupVariables } from "@okouai/core/variable-expander";
import {
  type StoredExecutionContext,
  AGENT_EXECUTION_TIMEOUT_SECONDS,
} from "@okouai/api-contracts/contracts/runners";
import {
  type AgentExecutionConfig as agentRunCreateAgentExecutionConfig,
  buildAgentExecutionConfig,
} from "./agent-execution-config";
import { z } from "zod";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { FirewallPolicies } from "@okouai/connectors/firewall-types";
import type { ModelCatalog } from "./model-catalog.service";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { PiStableContextPromptProjection } from "@okouai/db/jsonb-contracts/pi-stable-context";
import type { CapturedPersonalSubscriptionAccount } from "./model-provider-account.service";
import type { AgentRunPreCreateSource } from "./agent-run-contracts";
import type {
  ChatThreadSessionResolution,
  ChatThreadExecutionSnapshot,
} from "./chat-session-continuity.service";
import type { RunWorkflowRef } from "./workflow-data.service";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { decryptStoredSecretValue } from "./crypto.utils";
import { logger } from "../../lib/log";
import {
  type CompressedSessionHistoryBlobEncoding,
  normalizeSessionHistoryBlobEncoding,
  isCompressedSessionHistoryBlobEncoding,
} from "./session-history-blobs";
import { isStaffOrg } from "@okouai/core/staff-org";
import type {
  FirewallPermissionGrantAction,
  FirewallPermissionGrant,
} from "@okouai/connectors/firewall-metadata/policy";
import type {
  AgentConnectorScopeSnapshot,
  CustomConnectorDefinitionVersion,
} from "./agent-connector-scope.service";
import { requestPiMemoryStage1DayForAdmittedRun } from "./pi-memory-stage1-schedule.service";
import {
  buildAgentToolsPromptInputs,
  buildAgentToolsPrompt,
} from "./agent-tools-prompt.service";
import { buildAgentIdentityPrompt } from "./agent-identity-prompt.service";
import { piStableContextVariantDigest } from "./pi-stable-context.service";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import {
  AgentExecutionRequestObservation,
  ApiErrorResponse,
  CreateAgentRunArgs,
  CreateRunBody,
  CreateRunErrorResult,
  ProductAgentExecutionPlan,
  ResolvedAgentExecution,
  ResolvedRunExecution,
  TestOnlyDirectRunResolver,
  firstAgent,
} from "./execution-launch-persistence.service";
import {
  AgentRunRecord,
  resolvedSessionStorage,
} from "./execution-storage-manifest.service";
import {
  RunConnectorCatalogSelection,
  effectiveStoredConnectorEnvironment,
  environmentTemplates,
} from "./run-connector-context.service";
import {
  AgentRunCreateBody,
  AgentRunIdentityCommand,
  AnyCreateAgentRunCommandArgs,
  AuthorizedAgentRunRequestObservation,
  CreateAgentRunCommandArgs,
  QueuedRunCommandArgs,
  UserInfo,
  selectedRunModelProviderArgs,
} from "./run-model-provider-environment.service";
import {
  pendingOkouTokenSecrets,
  withoutLegacyAgentRunEnvironmentEntries,
} from "./execution-runner-payload.service";

export const L: ReturnType<typeof logger> = logger("AgentRunCreate");

function withPendingOkouTokenSecret(body: CreateRunBody): CreateRunBody {
  return { ...body, secrets: pendingOkouTokenSecrets(body.secrets) };
}

interface ProductResolutionOptions {
  readonly executionPlan: ProductAgentExecutionPlan;
  readonly timing?: ApiDispatchTimingCollector;
  readonly sessionSnapshot?: ChatThreadExecutionSnapshot;
}

export interface ResolveAgentExecutionOptions {
  readonly agentObservation?: RunAgentObservation;
  readonly productAgentExecutionPlan?: ProductAgentExecutionPlan;
  readonly testOnlyResolveDirectRun?: TestOnlyDirectRunResolver;
  readonly preloadedAgentExecutionObservation?: AgentExecutionRequestObservation;
  readonly timing?: ApiDispatchTimingCollector;
  readonly resetNativeSession?: boolean;
  readonly sessionSnapshot?: ChatThreadExecutionSnapshot;
}

export interface PersistedRunEnvironmentSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly userId: string;
}

export interface PersistedRunEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

export interface PersistedRunEnvironmentSnapshot {
  readonly secrets: readonly PersistedRunEnvironmentSecret[];
  readonly variables: readonly PersistedRunEnvironmentVariable[];
}

function forbidden(message: string): ApiErrorResponse<403, "FORBIDDEN"> {
  return {
    status: 403,
    body: { error: { message, code: "FORBIDDEN" } },
  };
}

export function insufficientCredits(): ApiErrorResponse<
  402,
  "INSUFFICIENT_CREDITS"
> {
  return {
    status: 402,
    body: {
      error: {
        message: "Insufficient credits. Please add credits to continue.",
        code: "INSUFFICIENT_CREDITS",
      },
    },
  };
}

export function isRouteError(value: unknown): value is CreateRunErrorResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof (value as { readonly status: unknown }).status === "number" &&
    (value as { readonly status: number }).status !== 201
  );
}

function resolveFramework(
  content: agentRunCreateAgentExecutionConfig,
): SupportedFramework | null {
  const framework = firstAgent(content)?.framework;
  if (!isSupportedFramework(framework)) {
    return null;
  }
  return framework;
}

function missingEnvironmentReferences(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
  readonly connectorVars: Record<string, string> | undefined;
}): string[] {
  assertStoredConnectorEnvironmentReferences({
    environment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment: args.additionalEnvironment,
      storedConnectorEnvironment: args.storedConnectorEnvironment,
    }),
    vars: args.connectorVars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  const environment = environmentTemplates({
    content: args.content,
    additionalEnvironment: args.additionalEnvironment,
  });
  const environmentMissing = missingReferencesInEnvironment({
    environment,
    vars: args.vars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  return environmentMissing;
}

function missingReferencesInEnvironment(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): string[] {
  if (!args.environment) {
    return [];
  }
  const grouped = extractAndGroupVariables(args.environment);
  const missingVars = grouped.vars
    .filter((ref) => {
      return args.vars?.[ref.name] === undefined;
    })
    .map((ref) => {
      return `vars.${ref.name}`;
    });
  const missingSecrets = grouped.secrets
    .filter((ref) => {
      return (
        args.secrets?.[ref.name] === undefined &&
        args.environmentSecretPlaceholders?.[ref.name] === undefined
      );
    })
    .map((ref) => {
      return `secrets.${ref.name}`;
    });
  return [...missingVars, ...missingSecrets];
}

function assertStoredConnectorEnvironmentReferences(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): void {
  const missing = missingReferencesInEnvironment(args);
  if (missing.length > 0) {
    throw new Error(
      `Stored connector environment is missing required values: ${missing.join(", ")}`,
    );
  }
}

export function buildMergedVariables(args: {
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly runVars: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const orgVars: Record<string, string> = {};
  const userVars: Record<string, string> = {};
  for (const row of args.persistedEnvironment.variables) {
    if (row.userId === ORG_SENTINEL_USER_ID) {
      orgVars[row.name] = row.value;
    } else {
      userVars[row.name] = row.value;
    }
  }

  const merged = { ...orgVars, ...userVars, ...args.runVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function buildReferencedSecrets(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly runSecrets: Record<string, string> | undefined;
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<Record<string, string> | undefined> {
  const environment = firstAgent(args.content)?.environment;
  const referencedNames = environment
    ? extractAndGroupVariables(environment).secrets.map((ref) => {
        return ref.name;
      })
    : [];
  if (referencedNames.length === 0) {
    return args.runSecrets;
  }

  const orgSecrets: Record<string, string> = {};
  const userSecrets: Record<string, string> = {};
  for (const row of args.persistedEnvironment.secrets) {
    const target =
      row.userId === ORG_SENTINEL_USER_ID ? orgSecrets : userSecrets;
    target[row.name] = await decryptStoredSecretValue(
      row.encryptedValue,
      args.featureSwitchContext,
    );
  }

  const merged = { ...orgSecrets, ...userSecrets, ...args.runSecrets };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export interface RunAgentObservation {
  readonly agentId: string;
  readonly agentOrgId: string;
  readonly agentOwner: string;
}

function resolveAgentObservation(
  row: RunAgentObservation | undefined,
  options: ProductResolutionOptions,
): ResolvedAgentExecution | CreateRunErrorResult {
  if (!row) {
    return notFound("Agent not found");
  }
  return {
    agentId: row.agentId,
    ownerUserId: row.agentOwner,
    orgId: row.agentOrgId,
    content: options.executionPlan.content,
    artifacts: [],
  };
}

interface ResumeSessionSnapshot {
  readonly runId: string;
  readonly cliAgentSessionId: string;
  readonly cliAgentSessionHistory: string | null;
  readonly cliAgentSessionHistoryHash: string | null;
  readonly sessionHistoryBlobEncoding: string | null;
}

function resumeSessionFromSnapshot(
  snapshot: ResumeSessionSnapshot,
): StoredExecutionContext["resumeSession"] | undefined {
  const hash = snapshot.cliAgentSessionHistoryHash;
  let encoding: CompressedSessionHistoryBlobEncoding | undefined;
  if (snapshot.sessionHistoryBlobEncoding !== null) {
    const parsedEncoding = normalizeSessionHistoryBlobEncoding(
      snapshot.sessionHistoryBlobEncoding,
    );
    if (isCompressedSessionHistoryBlobEncoding(parsedEncoding)) {
      encoding = parsedEncoding;
    }
  }
  if (hash) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      historyGenerationRunId: snapshot.runId,
      historyRef: {
        kind: "blob",
        hash,
        ...(encoding ? { encoding } : {}),
      },
    };
  }
  if (snapshot.cliAgentSessionHistory) {
    return {
      sessionId: snapshot.cliAgentSessionId,
      sessionHistory: snapshot.cliAgentSessionHistory,
    };
  }
  return undefined;
}

async function resolveSessionExecution(
  snapshot: ChatThreadExecutionSnapshot | undefined,
  options: ProductResolutionOptions,
): Promise<ResolvedAgentExecution | CreateRunErrorResult> {
  if (!snapshot) {
    return notFound("Agent session not found");
  }
  if (!snapshot.agent) {
    return notFound("Agent not found");
  }

  const conversation = snapshot.conversation;
  const resumeSession = conversation
    ? await measureApiDispatchTiming(
        options.timing,
        "api_dispatch_resolve_agent_execution_resolve_session_history",
        "nested",
        (): StoredExecutionContext["resumeSession"] | undefined => {
          return resumeSessionFromSnapshot({
            ...conversation,
            sessionHistoryBlobEncoding: snapshot.historyBlob?.encoding ?? null,
          });
        },
      )
    : undefined;

  return {
    agentId: snapshot.agent.id,
    ownerUserId: snapshot.agent.owner,
    orgId: snapshot.agent.orgId,
    content: options.executionPlan.content,
    ...resolvedSessionStorage(snapshot.session),
    previousRunStorageMounts: snapshot.previousRun?.storageMounts ?? undefined,
    vars:
      (snapshot.previousRun?.vars as Record<string, string> | null) ??
      undefined,
    agentSessionId: snapshot.session.id,
    continuedFromAgentSessionId: snapshot.session.id,
    resumeSession,
    resumeSessionIdentity: {
      selectedModel: snapshot.previousRun?.selectedModel ?? null,
      cliAgentType: conversation?.cliAgentType ?? null,
    },
  };
}

export function requireResolvedAgentIdMatch(
  resolved: ResolvedAgentExecution | CreateRunErrorResult,
  agentId: string | undefined,
): ResolvedAgentExecution | CreateRunErrorResult {
  if (
    !isRouteError(resolved) &&
    agentId !== undefined &&
    resolved.agentId !== agentId
  ) {
    return badRequestMessage("agentId does not match sessionId");
  }
  return resolved;
}

/** Product execution depends only on identity and the captured session/agent. */
export async function resolveProductAgentExecution(
  body: Pick<CreateRunBody, "agentId" | "sessionId">,
  userId: string,
  orgId: string,
  options: Omit<ResolveAgentExecutionOptions, "testOnlyResolveDirectRun">,
): Promise<ResolvedRunExecution | CreateRunErrorResult> {
  const productAgentExecutionPlan = options.productAgentExecutionPlan;
  if (productAgentExecutionPlan === undefined) {
    throw new Error(
      "Product Agent execution plan is required for canonical resolution",
    );
  }
  if (productAgentExecutionPlan.identity === "no-agent") {
    return {
      agentId: null,
      ownerUserId: userId,
      orgId,
      content: productAgentExecutionPlan.content,
      artifacts: [],
    };
  }
  if (body.sessionId) {
    const resolved = await measureApiDispatchTiming(
      options.timing,
      "api_dispatch_resolve_agent_execution_by_session_id",
      "nested",
      async () => {
        return await resolveSessionExecution(options.sessionSnapshot, {
          executionPlan: productAgentExecutionPlan,
          timing: options.timing,
        });
      },
    );
    if (!isRouteError(resolved) && options.resetNativeSession) {
      return {
        ...resolved,
        agentId: body.agentId ?? resolved.agentId,
        resumeSession: undefined,
        resumeSessionIdentity: undefined,
        previousRunStorageMounts: undefined,
        vars: undefined,
      };
    }
    return requireResolvedAgentIdMatch(resolved, body.agentId);
  }
  if (!body.agentId) {
    return badRequestMessage("Missing agentId or sessionId");
  }
  const agentId = body.agentId;
  const preloadedAgent = options.preloadedAgentExecutionObservation;
  if (
    preloadedAgent &&
    preloadedAgent.requestUserId === userId &&
    preloadedAgent.requestOrgId === orgId &&
    preloadedAgent.agentId === agentId &&
    preloadedAgent.agentOrgId === orgId
  ) {
    return {
      agentId,
      ownerUserId: preloadedAgent.ownerUserId,
      orgId: preloadedAgent.agentOrgId,
      content: productAgentExecutionPlan.content,
      artifacts: [],
    };
  }
  return await measureApiDispatchTiming(
    options.timing,
    "api_dispatch_resolve_agent_execution_by_agent_id",
    "nested",
    () => {
      return resolveAgentObservation(options.agentObservation, {
        executionPlan: productAgentExecutionPlan,
        timing: options.timing,
      });
    },
  );
}

export function enforceCaptureNetworkBodiesGate(
  orgId: string,
  captureNetworkBodies: boolean | undefined,
): CreateRunErrorResult | null {
  if (!captureNetworkBodies || env("ENV") !== "production") {
    return null;
  }

  if (!isStaffOrg(orgId)) {
    return forbidden("captureNetworkBodies is restricted to internal accounts");
  }
  return null;
}

export function validateCompose(
  content: agentRunCreateAgentExecutionConfig,
  vars: Record<string, string> | undefined,
  secrets: Record<string, string> | undefined,
  options?: {
    readonly validateEnvironmentReferences?: boolean;
    readonly environmentSecretPlaceholders?: Readonly<Record<string, string>>;
    readonly additionalEnvironment?: Record<string, string>;
    readonly storedConnectorEnvironment?: Record<string, string>;
    readonly connectorVars?: Record<string, string>;
  },
): { readonly framework: SupportedFramework } | CreateRunErrorResult {
  const framework = resolveFramework(content);
  if (!framework) {
    return badRequestMessage(
      "Agent must have a supported framework configured",
    );
  }

  if (options?.validateEnvironmentReferences !== false) {
    const missing = missingEnvironmentReferences({
      content,
      vars,
      secrets,
      environmentSecretPlaceholders: options?.environmentSecretPlaceholders,
      additionalEnvironment: options?.additionalEnvironment,
      storedConnectorEnvironment: options?.storedConnectorEnvironment,
      connectorVars: options?.connectorVars,
    });
    if (missing.length > 0) {
      return badRequestMessage(
        `Missing required values: ${missing.join(", ")}`,
      );
    }
  }

  return { framework };
}

export function initialRunBody(args: CreateAgentRunArgs): CreateRunBody {
  return args.includeOkouTokenSecret
    ? withPendingOkouTokenSecret(args.body)
    : args.body;
}

export async function buildResolvedRunBody(args: {
  readonly initialBody: CreateRunBody;
  readonly resolved: ResolvedRunExecution;
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly canonicalOkouRuntime: boolean;
  readonly resolvedEnvironment?: RunBodyEnvironment;
}): Promise<CreateRunBody> {
  const runVars =
    args.initialBody.vars !== undefined
      ? args.initialBody.vars
      : args.resolved.vars;
  const environment =
    args.resolvedEnvironment ??
    (await resolveRunBodyEnvironment({
      content: args.resolved.content,
      runVars,
      runSecrets: args.initialBody.secrets,
      persistedEnvironment: args.persistedEnvironment,
      featureSwitchContext: args.featureSwitchContext,
      canonicalOkouRuntime: args.canonicalOkouRuntime,
    }));
  return {
    ...args.initialBody,
    ...environment,
    volumeVersions:
      args.initialBody.volumeVersions !== undefined
        ? args.initialBody.volumeVersions
        : args.resolved.volumeVersions,
  };
}

export type RunBodyEnvironment = Pick<CreateRunBody, "vars" | "secrets">;

export async function resolveRunBodyEnvironment(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly runVars: CreateRunBody["vars"];
  readonly runSecrets: CreateRunBody["secrets"];
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly canonicalOkouRuntime: boolean;
}): Promise<RunBodyEnvironment> {
  const mergedVars = buildMergedVariables({
    persistedEnvironment: args.persistedEnvironment,
    runVars: args.runVars,
  });
  const mergedSecrets = await buildReferencedSecrets({
    content: args.content,
    runSecrets: args.runSecrets,
    persistedEnvironment: args.persistedEnvironment,
    featureSwitchContext: args.featureSwitchContext,
  });

  return {
    vars: args.canonicalOkouRuntime
      ? withoutLegacyAgentRunEnvironmentEntries(mergedVars)
      : mergedVars,
    secrets: args.canonicalOkouRuntime
      ? withoutLegacyAgentRunEnvironmentEntries(mergedSecrets)
      : mergedSecrets,
  };
}

// Emitted as the agent_run_origin observability dimension. The values name what
// started the run, so the fallback is "direct" (not started by an automation)
// rather than a restatement that this is an agent run.
type AgentRunOrigin = "direct" | "workflow_automation";

const DISALLOWED_TOOLS = [
  "CronCreate",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "AskUserQuestion",
  "Skill(loop)",
  "Skill(loop *)",
] as const;

export function agentRunsCreateForbidden(
  message: string,
): ApiErrorResponse<403, "FORBIDDEN"> {
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

function buildStableAgentPrompt(args: {
  readonly privateArtifactsEnabled: boolean;
  readonly agent: AgentRunRecord;
  readonly triggerSource: TriggerSource;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly browserNativeInputEnabled: boolean;
  readonly bankingEnabled: boolean;
  readonly vncEnabled: boolean;
  readonly larkEnabled: boolean;
  readonly discordEnabled: boolean;
  readonly deliveryFormatGuidanceEnabled: boolean;
  readonly presentationConvertEnabled: boolean;
  readonly customConnectorMcpEnabled: boolean;
}): PiStableContextPromptProjection {
  return {
    agentIdentity: buildAgentIdentityPrompt(args.agent) ?? "",
    executionLimit: buildExecutionTimeLimitPrompt(),
    tools: buildAgentToolsPrompt({
      privateArtifactsEnabled: args.privateArtifactsEnabled,
      triggerSource: args.triggerSource,
      cloudBrowserEnabled: args.cloudBrowserEnabled,
      browserNativeInputEnabled: args.browserNativeInputEnabled,
      bankingEnabled: args.bankingEnabled,
      vncEnabled: args.vncEnabled,
      larkEnabled: args.larkEnabled,
      discordEnabled: args.discordEnabled,
      deliveryFormatGuidanceEnabled: args.deliveryFormatGuidanceEnabled,
      presentationConvertEnabled: args.presentationConvertEnabled,
    }),
  };
}

function buildAgentRunPlatformEnvironment(args: {
  readonly agentId: string;
  readonly triggerSource: TriggerSource;
  readonly chatThreadId: string | undefined;
  readonly codexServiceTier: "fast" | "ultrafast" | undefined;
  readonly reasoningEffort?: ReasoningEffort | null;
}): Record<string, string> {
  const integrationByTriggerSource: Partial<Record<TriggerSource, string>> = {
    web: "web",
    agent: "web",
    slack: "slack",
    discord: "discord",
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
    "queueFirstAssociation" in args.command ? "queue_event" : "request";
  return {
    agent_run_origin: args.origin,
    api_start_source: apiStartSource,
    ...(args.source ? { agent_run_pre_create_source: args.source } : {}),
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
  readonly standaloneIntegrationNote: string;
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
    appendSystemPrompt: [
      baseAppendSystemPrompt,
      args.appendSystemPrompt,
      args.appendSystemPrompt ? "" : args.standaloneIntegrationNote,
    ]
      .filter((part): part is string => {
        return Boolean(part);
      })
      .join("\n\n"),
    disallowedTools: [...DISALLOWED_TOOLS],
    vars: selectedAgentRunVariables(args.agent.id),
  };
}

export function selectedAgentRunVariables(agentId: string) {
  return { OKOU_AGENT_ID: agentId };
}

export function measureAgentRunPreCreate<T>(
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

interface AgentRunAfterBootstrap extends RunBootstrapContext {
  readonly agent: AgentRunRecord;
  readonly authorizedRequestObservation?: AuthorizedAgentRunRequestObservation;
  readonly timing: ApiDispatchTimingCollector;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly command: AgentRunIdentityCommand;
  readonly threadSessionResolution?: ChatThreadSessionResolution;
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
}

export interface AgentRunAfterPreCreate extends AgentRunAfterBootstrap {
  readonly runPermissionPolicies: FirewallPolicies | null | undefined;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
}

interface BuildCreateAgentRunArgsInput {
  /** One catalog snapshot per run, loaded by the entry point. */
  readonly catalog: ModelCatalog;
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
  readonly capturedPersonalSubscriptionAccount?: CapturedPersonalSubscriptionAccount;
}

function emptyStablePrompt(): PiStableContextPromptProjection {
  return {
    agentIdentity: "",
    executionLimit: "",
    tools: "",
  };
}

/**
 * A run launched straight through the runs API has no conversational surface,
 * so nothing renders `# Current Integration` for the note to follow. Its
 * delivery rules still apply, so they close the caller-supplied prompt
 * instead. A run whose surface supplied an integration prompt already carries
 * the note inside that block.
 */
function standaloneIntegrationNote(args: BuildCreateAgentRunArgsInput): string {
  if (args.command.appendSystemPrompt) {
    return "";
  }
  return resolveIntegrationNotePrompt({
    triggerSource: args.command.triggerSource ?? "web",
    featureSwitchContext: args.featureSwitchContext,
  });
}

function buildStableRunPromptContext(args: BuildCreateAgentRunArgsInput): {
  readonly userInfo: UserInfo;
  readonly initialStablePrompt: PiStableContextPromptProjection;
  readonly piStableContext: NonNullable<CreateAgentRunArgs["piStableContext"]>;
} {
  const promptInputs = buildAgentToolsPromptInputs({
    featureSwitchContext: args.featureSwitchContext,
    triggerSource: args.command.triggerSource ?? "web",
    cloudBrowserEnabled: args.cloudBrowserEnabled,
  });
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
        standaloneIntegrationNote(args),
      ]
        .filter((part): part is string => {
          return Boolean(part);
        })
        .join("\n\n"),
    },
  };
}

/**
 * Explicit run arguments a product entry point (chat/automation) prepares for
 * Thread: exactly the facts this builder sets, no legacy direct-run knobs.
 */
export interface ProductRunArgs {
  readonly catalog: CreateAgentRunArgs["catalog"];
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: CreateAgentRunArgs["modelProviderCredentialScope"];
  readonly modelProviderType?: string;
  readonly capturedPersonalSubscriptionAccount?: CreateAgentRunArgs["capturedPersonalSubscriptionAccount"];
  readonly selectedModelOverride?: string;
  readonly builtInModelRuntimeRoute?: CreateAgentRunArgs["builtInModelRuntimeRoute"];
  readonly piExecution: boolean;
  readonly codexServiceTier?: "fast" | "ultrafast";
  readonly agentRunMetadata?: CreateAgentRunArgs["agentRunMetadata"];
  readonly queueFirstAssociation?: CreateAgentRunArgs["queueFirstAssociation"];
  readonly body: CreateRunBody;
  readonly apiStartTime: number;
  readonly piStableContext?: CreateAgentRunArgs["piStableContext"];
  readonly chatThreadId?: string;
  readonly connectorSourceId?: string;
  readonly threadSessionResolution?: CreateAgentRunArgs["threadSessionResolution"];
  readonly platformEnvironment?: Record<string, string>;
  readonly callbacks?: CreateAgentRunArgs["callbacks"];
  readonly includeOkouTokenSecret?: boolean;
  readonly productAgentExecutionPlan?: CreateAgentRunArgs["productAgentExecutionPlan"];
  readonly preloadedAgentExecutionObservation?: CreateAgentRunArgs["preloadedAgentExecutionObservation"];
  readonly okouTokenComputerUseHostId?: string;
  readonly okouTokenCloudBrowserEnabled?: boolean;
  readonly enforceBuiltInCredits?: boolean;
  readonly injectSkillVolumes?: CreateAgentRunArgs["injectSkillVolumes"];
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly connectorScope: CreateAgentRunArgs["connectorScope"];
  readonly validateEnvironmentReferences?: boolean;
  readonly dispatchFailedCallbacks?: CreateAgentRunArgs["dispatchFailedCallbacks"];
  readonly persistProducerRunBinding?: CreateAgentRunArgs["persistProducerRunBinding"];
  readonly agentRunModelPin?: CreateAgentRunArgs["agentRunModelPin"];
  readonly timing?: CreateAgentRunArgs["timing"];
  readonly timingDimensions?: CreateAgentRunArgs["timingDimensions"];
}

export function buildProductRunArgs(
  args: BuildCreateAgentRunArgsInput,
): ProductRunArgs {
  const command = args.command;
  const { userInfo, initialStablePrompt, piStableContext } =
    buildStableRunPromptContext(args);
  const productAgentExecutionPlan = {
    identity: "agent" as const,
    content: buildAgentExecutionConfig(args.agent.name),
  };
  return {
    ...selectedRunModelProviderArgs(
      command,
      args.agent,
      args.capturedPersonalSubscriptionAccount,
    ),
    catalog: args.catalog,
    body: createRunBody({
      body: command.body,
      agent: args.agent,
      userInfo,
      stablePrompt: initialStablePrompt,
      permissionPolicies: args.runPermissionPolicies,
      triggerSource: command.triggerSource,
      appendSystemPrompt: command.appendSystemPrompt,
      standaloneIntegrationNote: standaloneIntegrationNote(args),
    }),
    apiStartTime: command.apiStartTime,
    piStableContext,
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
    persistProducerRunBinding: async (tx, run) => {
      await command.persistProducerRunBinding?.(tx, run);
      // Pi memory Stage 1 is owned by chat-thread launches, not the run core.
      if (run.status === "pending" && command.chatThreadId) {
        await requestPiMemoryStage1DayForAdmittedRun(tx, run.runId);
      }
    },
    ...(command.agentRunModelPin
      ? { agentRunModelPin: command.agentRunModelPin }
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

export const bootstrapMetadataRowKindSchema = z.enum([
  "user_info",
  "feature_switch",
  "builtin_connector",
  "custom_connector",
  "permission_grant",
]);

type BootstrapMetadataRowKind = z.output<typeof bootstrapMetadataRowKindSchema>;

export interface BootstrapMetadataQueryRow {
  readonly kind: BootstrapMetadataRowKind;
  readonly id: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly featureUserId: string | null;
  readonly switches: Record<string, boolean> | null;
  readonly detail: string | null;
  readonly action: FirewallPermissionGrantAction | null;
  readonly permissionNames: readonly string[] | null;
  readonly permissionBundleRef: string | null;
  readonly storageVersion: number | null;
  readonly skillStorageVersionId: string | null;
  readonly isMcp: boolean | null;
  readonly expiresAt: Date | null;
}

export interface RunBootstrapContext extends AgentConnectorScopeSnapshot {
  readonly userInfo: UserInfo;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly workflows: readonly RunWorkflowRef[];
  readonly permissionGrants: readonly FirewallPermissionGrant[];
  readonly permissionValidityHorizon: string | null;
  readonly connectorCatalogMetadataSlugs: readonly ConnectorSlug[];
}

export function permissionValidityHorizon(
  rows: readonly BootstrapMetadataQueryRow[],
): string | null {
  let horizon: Date | null = null;
  for (const row of rows) {
    if (
      row.kind === "permission_grant" &&
      row.expiresAt !== null &&
      (horizon === null || row.expiresAt.getTime() < horizon.getTime())
    ) {
      horizon = row.expiresAt;
    }
  }
  return horizon?.toISOString() ?? null;
}
export interface AgentRunIdentityInput {
  readonly timing: ApiDispatchTimingCollector;
  readonly auth: CreateAgentRunCommandArgs["auth"];
  readonly agentId: string;
  readonly apiStartTime: number;
  readonly chatThreadId?: string;
  readonly expectedThreadAgentId?: string;
  readonly queueFirstAssociation?: QueuedRunCommandArgs["queueFirstAssociation"];
}
export interface AgentRunGraphInput {
  readonly command: AgentRunIdentityCommand;
  readonly timing: ApiDispatchTimingCollector;
}

export function matchingAuthorizedRequestObservation(
  args: AgentRunIdentityCommand,
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
