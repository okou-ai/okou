import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import {
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
  piModelConfigV4Schema,
  piNativeInferenceUrl,
} from "@okouai/api-contracts/contracts/pi-native";
import { piNativeFirewall } from "@okouai/api-contracts/contracts/pi-native-firewall";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { chatThreadActivitySummaryRoutes } from "../chat-threads-activity-summary";
import { createHash, randomUUID } from "node:crypto";
import {
  crc32,
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  readGoalQueueStateFixture,
  seedGoalForRunFixture,
  setLegacyGoalRunOriginFixture,
} from "../../../test-fixtures/goal-queue";

import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Header } from "tar";
import { getInstructionsStorageName } from "@okouai/core/storage-names";
import { readCanonicalAgentNameFixture } from "../../../test-fixtures/canonical-agent-authority";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  chatEventsContract,
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
  resolveChatEventRecommendedFollowups,
  type ChatEvent,
  type ChatRunOptionsRequest,
  type ChatThreadEvent,
  type GenerationTemplateRequest,
  type UserMessageDocument,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { cronExtractPiMemoryStage1Contract } from "@okouai/api-contracts/contracts/cron";
import { triggerSourceSchema } from "@okouai/api-contracts/contracts/logs";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS } from "@okouai/api-contracts/contracts/model-price-tiers";
import {
  modelProviderConnectionsByIdContract,
  modelProviderConnectionsMainContract,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import {
  modelProvidersByTypeContract,
  modelProvidersMainContract,
} from "@okouai/api-contracts/contracts/model-provider-routes";
import {
  getModelProviderFirewall,
  getProviderRuntimeModel,
  LIMITED_FREE1_DEFAULT_RUN_MODEL,
  type UpsertModelProviderRequest,
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  type ModelProviderType,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  DEFAULT_PROFILE,
  PI_MEMORY_ROOT,
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  piApiFirstTurnManifestSchema,
} from "@okouai/api-contracts/contracts/runners";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import {
  workflowAutomationsContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_ITEMS,
} from "@okouai/core";
import { avatarTemplateStylePresetId } from "@okouai/core/avatar-template";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_MODEL_ENV,
} from "@okouai/core/image-model-catalog";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import { DEFAULT_VIDEO_MODEL } from "@okouai/core/video-model-catalog";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { v5 as uuidv5 } from "uuid";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { createAppWithRoutes } from "../../../app-factory-core";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import type { AgentEvent } from "../../../lib/event-consumer/verify";
import {
  buildArtifactKeyV2,
  buildArtifactPrefixV2,
} from "../../../lib/file-url";
import {
  clearMockNow,
  mockNow,
  now,
  nowDate,
  withMockNowForTest,
} from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  readRunModelRuntimeRouteFixture,
  readSessionHistoryBlobRefCountFixture,
  setRunLaunchSnapshotFixture,
  setRunPiMemoryAdmissionInputsFixture,
} from "../../../test-fixtures/agent-runs";
import { withBuiltInModelRuntimeRouteCandidateUnavailableForTest } from "../../../test-fixtures/built-in-model-runtime-route";
import {
  acquireBddBuiltInModelKey,
  completeRunWithoutCallbacksFixture,
  deletePiApiFirstTurnUsageEventsFixture,
  holdAgentRunRowLockFixture,
  holdChatEventQueueItemFixture,
  holdChatThreadRowLockFixture,
  holdOrgAdmissionLockFixture,
  holdPiApiFirstTurnLifecycleLockFixture,
  holdRunOutputMaterializationRowFixture,
  holdThreadSessionBindingClearFixture,
  holdThreadSessionConversationChangesFixture,
  holdThreadSessionConversationClearFixture,
  insertPiApiFirstTurnUsageEventsFixture,
  readCanonicalChatEventStorageFixture,
  readRunOutputLegacyPiEventsFixture,
  readRunOutputMaterializationFixture,
  readRunOutputMemoryCitationsFixture,
  readRunUsageEventsFixture,
  releaseBddBuiltInModelKey,
  replacePiSessionHistoryJsonlFixture,
  replaceThreadSessionBindingFixture,
  replayPendingChatInputQueueEventFixture,
  setChatCallbackGitHubDeliveryFixture,
  timeoutRunWithoutCallbacksFixture,
} from "../../../test-fixtures/chat-events";
import { setChatThreadVideoModelFixture } from "../../../test-fixtures/chat-thread-events";
import {
  API_TEST_CONNECTOR_CATALOG,
  apiTestConnectorCatalogValidationAuthority,
  clearApiTestConnectorCatalogExternalReaderIdentityReplacements,
  clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements,
  deleteApiTestConnectorCatalogRuntimeProjectionRow,
  deleteApiTestConnectorCatalogRuntimeProjectionSet,
  installApiTestConnectorCatalog,
  replaceApiTestConnectorCatalogStoredBytes,
  setApiTestConnectorCatalogExternalReaderIdentityReadHook,
  setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook,
} from "../../../test-fixtures/connector-catalog";
import { setOrgModelPolicyProviderTypeFixture } from "../../../test-fixtures/org-model-policies";
import {
  deleteOrgPlanEntitlementFixture,
  upsertOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import {
  commitPiMemoryStage1CandidateFixture,
  deletePiMemoryStorageFixture,
  leasePiMemoryStage1CandidateFixture,
  piMemoryStage1AdmissionPrerequisiteSkipReasonFixture,
  readmitPiMemoryStage1CandidateFixture,
  readPiConversationIdentityFixture,
  readPiMemoryStage1CandidateFixture,
  setSyntheticPiMemoryStage1SelectionFixture,
} from "../../../test-fixtures/pi-memory-stage1-candidates";
import {
  readRunImageModelSnapshotFixture,
  setRetiredChatThreadImageModelFixture,
  setRetiredOrgMemberImageModelFixture,
} from "../../../test-fixtures/run-image-model";
import {
  readRunChatThreadIdFixture,
  readRunVideoModelFixture,
  setOrgMemberVideoModelFixture,
} from "../../../test-fixtures/run-video-model";
import { seededSystemSkillArchive } from "../../../test-fixtures/seeded-system-skill-archive";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import {
  createUnassociatedThreadBoundAgentRunFixture,
  createUnassociatedThreadBoundAgentRunsServiceFixture,
  holdAgentRunPiExecutionSnapshotFixture,
} from "../../../test-fixtures/thread-bound-run-admission";
import {
  createUsagePricingFixture,
  type UsagePricingFixture,
} from "../../../test-fixtures/usage-pricing";
import { verifyOkouToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { cronExtractPiMemoryStage1RoutesForTest } from "../cron-extract-pi-memory-stage1";
import { mailRoutes } from "../mail";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import { modelProvidersRoutes } from "../model-providers";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { readAgentRunState$ } from "./helpers/agent-run-callback";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { cleanupTimedOutRun } from "./helpers/api-bdd-run-timeout";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  readCustomConnectorCredentialStorageParent,
  setCustomConnectorCredentialStorageState,
} from "./helpers/connector-credential-storage-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  commitMemoryVersion,
  seedReadyMemorySummaryProjection,
} from "./helpers/memory";
import { overwriteModelProviderSecretForTests } from "./helpers/model-provider-state";
import { openRouterModelContractError } from "./helpers/openrouter-model-contract";
import { createRouteMocks } from "./helpers/route-test";
import {
  readRunAutonomyBudgetFixture,
  readRunLaunchSnapshotFixture,
  readThreadSessionBinding,
  readThreadSessionConversation,
  resolveBuiltInModelRouteFixture,
  seedBuiltInModelCandidateKeys,
  seedBuiltInModelKey as seedBuiltInModelKeyState,
  setRunAutonomyBudgetFixture,
  steerRunTimeBudgetFixture,
} from "./helpers/runtime-state";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

import { runInIsolatedProcess } from "../../../../../../scripts/run-isolated-test.mjs";

const TEST_APP_ROUTES = Object.freeze([
  ...chatEventsRoutes,
  ...chatThreadRoutes,
  ...mailRoutes,
  ...modelProviderGatewayRoutes,
  ...modelProvidersRoutes,
]);

/**
 * CHAT-02 / RUN-01 / CHAIN-CHAT: the web chat send route end to end.
 *
 * Every Given is constructed through public APIs (Stripe-webhook entitlement,
 * org model provider/policy routes, runner heartbeat/claim, sandbox report
 * webhooks, feature-switch and computer-use host routes) and every Then is a
 * response body, messages page, thread/run read, queue read, claim payload,
 * or captured chat-callback delivery. Storage migration cases also assert the
 * queue-only transport row lifecycle directly.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const connectors = createConnectorBddApi(context);
const github = createGithubBddApi(context);
const cu = createComputerUseBddApi(context);
const misc = createMiscRoutesApi(context);
const authDevice = createAuthDeviceApiActions(context);
const authDeviceSupport = createAuthDeviceSupportApi(context);
const routeMocks = createRouteMocks(context);
const runStateStore = createStore();
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET = "okou web upload-file -f <path>";
const RUN_TIME_BUDGET_STEER_AT_MS = 115 * 60 * 1000;
const API_FIRST_TURN_OWNERSHIP_BUDGET_MS = 45_000;
const API_FIRST_TURN_COORDINATION_BUDGET_MS = 55_000;
const PI_API_FIRST_TURN_USAGE_NAMESPACE =
  "26e1c547-485d-4438-bf6d-4b77959da0cb";
const PI_API_FIRST_TURN_BASE_USAGE_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;
const GPT_PI_BDD_MODELS = [
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
] as const;
type PiGptBddModel = (typeof GPT_PI_BDD_MODELS)[number];
const GPT_API_KEY_BDD_ROUTES = GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
  return [
    {
      name: `OpenAI ${selectedModel}`,
      selectedModel,
      type: "openai-api-key",
      endpoint: "https://api.openai.com/v1/responses",
      baseUrl: "https://api.openai.com/v1",
      secretName: "OPENAI_API_KEY",
      piProvider: "openai",
      runtimeModel: selectedModel,
    },
    {
      name: `OpenRouter ${selectedModel}`,
      selectedModel,
      type: "openrouter-codex",
      endpoint: "https://openrouter.ai/api/v1/responses",
      baseUrl: "https://openrouter.ai/api/v1",
      secretName: "OPENROUTER_API_KEY",
      piProvider: "openrouter",
      runtimeModel: `openai/${selectedModel}`,
    },
    {
      name: `Vercel AI Gateway ${selectedModel}`,
      selectedModel,
      type: "vercel-ai-gateway-codex",
      endpoint: "https://ai-gateway.vercel.sh/v1/responses",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      secretName: "VERCEL_AI_GATEWAY_API_KEY",
      piProvider: "openai",
      catalogModel: selectedModel,
      runtimeModel: `openai/${selectedModel}`,
    },
  ] as const;
});
const USER_OWNED_GPT_FAST_BDD_ROUTES = [
  ...GPT_PI_BDD_MODELS.map((selectedModel) => {
    return {
      name: `subscription ${selectedModel}`,
      selectedModel,
      type: "codex-oauth-token",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      runtimeModel: selectedModel,
      wireTier: "priority",
    } as const;
  }),
  ...GPT_API_KEY_BDD_ROUTES.map((route) => {
    return { ...route, wireTier: "priority" as const };
  }),
] as const;

const GPT_USAGE_PRICING = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
  "tokens.input.long_context",
  "tokens.output.long_context",
  "tokens.cache_read.long_context",
  "tokens.cache_creation.long_context",
  "tokens.input.fast",
  "tokens.output.fast",
  "tokens.cache_read.fast",
  "tokens.cache_creation.fast",
  "tokens.input.long_context.fast",
  "tokens.output.long_context.fast",
  "tokens.cache_read.long_context.fast",
  "tokens.cache_creation.long_context.fast",
].flatMap((category) => {
  return GPT_PI_BDD_MODELS.map((provider) => {
    return {
      kind: "model",
      provider,
      category,
      unitPrice: 1,
      unitSize: 1_000_000,
    };
  });
});
type PiApiFirstTurnUsageProvider =
  | z.infer<typeof piNativeCatalogModelSchema>
  | "deepseek-v4-flash"
  | "deepseek-v4-pro"
  | PiGptBddModel;
const RUN_TIME_BUDGET_MESSAGE = `This runner has a hard maximum runtime of 2 hours. The current run has been active for 115 minutes, leaving approximately 5 minutes before it is terminated.

A normal completion provides a reliable handoff for the next run. The handoff includes completed work, current state, verification performed, remaining work, and blockers.

Use the remaining time to leave the task in a resumable state and finish this turn normally.`;

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${base64UrlEncode(JSON.stringify(payload))}.bdd-signature`;
}

function codexAuthJson(): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: unsignedJwt({ exp: accessExp }),
      refresh_token: "rt_bdd_chat_fast_mode",
      account_id: "ws_acct_bdd_fast_mode",
      id_token: unsignedJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "ws_acct_bdd_fast_mode_id_token",
          chatgpt_plan_type: "plus",
          organization: { title: "BDD Chat Fast Mode" },
        },
        exp: accessExp,
      }),
    },
  });
}

type UserMessage = Extract<
  ChatEvent,
  {
    eventType:
      | "input.prompt"
      | "input.automation"
      | "input.rejected"
      | "control.interrupt"
      | "control.revoke";
  }
>;
type AssistantMessage = Exclude<ChatEvent, UserMessage>;
type PromptMessage = Extract<ChatEvent, { eventType: "input.prompt" }>;
type FailedMessage = Extract<ChatEvent, { eventType: "run.failed" }>;
type OutputMessage = Extract<ChatEvent, { eventType: "output.message" }>;
type FollowupsEvent = Extract<ChatEvent, { eventType: "output.followups" }>;
type RunnerClaim = Awaited<ReturnType<typeof api.claimRunnerJob>>;

interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
}

interface ChatRunSendBody {
  readonly agentId: string;
  readonly prompt: string;
  readonly userMessage?: UserMessageInputDocument;
  readonly threadId?: string;
  readonly clientThreadId?: string;
  readonly clientEventId?: string;
  readonly model?: SupportedRunModel;
  readonly runOptions?: ChatRunOptionsRequest;
  readonly template?: GenerationTemplateRequest;
  readonly computerUseHostId?: string | null;
  readonly revokesEventId?: string;
  readonly captureNetworkBodies?: boolean;
}

/**
 * Template markers render inline, so a client that wants the template on its
 * own line sends the blank line as an explicit text part.
 */
function userMessageWithTemplate(
  prompt: string,
  template: GenerationTemplateRequest,
): UserMessageInputDocument {
  const titleSnapshot = `${template.type[0]?.toUpperCase()}${template.type.slice(1)} template`;
  return {
    version: 1,
    parts: [
      { type: "text", text: prompt },
      { type: "text", text: "\n\n" },
      { type: "template", titleSnapshot, template },
    ],
  };
}

const openRouterBodySchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  max_tokens: z.number().optional(),
  reasoning: z
    .object({ effort: z.enum(["none", "minimal", "low", "medium", "high"]) })
    .optional(),
});

async function entitledChatActor(
  options: ApiTestUserOptions = {},
  tier: "pro" | "team" = "pro",
): Promise<EntitledChatActor> {
  const actor = bdd.user(options);
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor, {
    ...(options.orgId === STAFF_ORG_ID
      ? {
          customerId: "cus_bdd_chat_events_staff",
          subscriptionId: "sub_bdd_chat_events_staff",
        }
      : {}),
    tier,
  });
  const { providerId } = await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD chat messages agent",
    description: "Exercises the web chat send route.",
    visibility: "private",
  });
  return { actor, agentId: agent.agentId, runnerGroup, providerId };
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected entitled chat actor to have an org");
  }
  return actor.orgId;
}

function totalChargedCredits(
  rows: readonly { readonly creditsCharged: number | null }[],
): number {
  return rows.reduce((total, row) => {
    if (row.creditsCharged === null) {
      throw new Error("Expected processed usage to have charged credits");
    }
    return total + row.creditsCharged;
  }, 0);
}

async function expectPiApiFirstTurnUsage(
  runId: string,
  sessionBytes: Buffer,
  provider: PiApiFirstTurnUsageProvider,
): Promise<void> {
  const firstSession = MemoryPiSession.fromJsonl(sessionBytes.toString("utf8"));
  const firstAssistant = [...firstSession.buildSessionContext().messages]
    .reverse()
    .find((message) => {
      return message.role === "assistant";
    });
  expect(
    firstAssistant?.role === "assistant" ? firstAssistant.usage : null,
  ).toMatchObject({
    input: 5,
    output: 3,
    cacheRead: 3,
    cacheWrite: 2,
  });
  await expectPiApiUsage(runId, provider, "", {
    input: 5,
    output: 3,
    cacheRead: 3,
    cacheCreation: 2,
  });
}

function piApiFirstTurnUsageEvents(
  runId: string,
  responseSourceId: string,
): readonly {
  readonly idempotencyKey: string;
  readonly category: string;
  readonly quantity: number;
}[] {
  return [
    { category: "tokens.input", quantity: 5 },
    { category: "tokens.output", quantity: 3 },
    { category: "tokens.cache_read", quantity: 3 },
    { category: "tokens.cache_creation", quantity: 2 },
  ].map((entry) => {
    return {
      ...entry,
      idempotencyKey: uuidv5(
        JSON.stringify([runId, responseSourceId, entry.category]),
        PI_API_FIRST_TURN_USAGE_NAMESPACE,
      ),
    };
  });
}

async function expectPiApiUsage(
  runId: string,
  provider: PiApiFirstTurnUsageProvider,
  suffix: "" | ".fast" | ".long_context" | ".long_context.fast",
  expected: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
  },
): Promise<void> {
  const usageRows = await readRunUsageEventsFixture(runId);
  const expectedRows = [
    ["tokens.cache_creation", expected.cacheCreation],
    ["tokens.cache_read", expected.cacheRead],
    ["tokens.input", expected.input],
    ["tokens.output", expected.output],
  ]
    .filter((entry) => {
      return entry[1] !== 0;
    })
    .map(([category, quantity]) => {
      return expect.objectContaining({
        provider,
        category: `${category}${suffix}`,
        quantity,
        status: "processed",
        billingError: null,
        creditsCharged: expect.any(Number),
      });
    });
  expect(usageRows).toStrictEqual(expectedRows);
  expect(totalChargedCredits(usageRows)).toBeGreaterThan(0);
}

async function expectTerraApiUsage(
  runId: string,
  suffix: "" | ".fast" | ".long_context" | ".long_context.fast",
  expected: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
  },
): Promise<void> {
  await expectPiApiUsage(runId, "gpt-5.6-terra", suffix, expected);
}

async function expectTerraApiFollowUpUsage(
  runId: string,
  suffix: "" | ".fast" = "",
): Promise<void> {
  await expectTerraApiUsage(runId, suffix, {
    input: 5,
    output: 3,
    cacheRead: 0,
    cacheCreation: 0,
  });
}

async function expectNoBuiltInModelUsage(runId: string): Promise<void> {
  // Operational usage rows have no production run-scoped read API. This
  // test-only observation is required to prove the user-owned no-charge
  // invariant rather than infer it from the public run status.
  await expect(readRunUsageEventsFixture(runId)).resolves.toStrictEqual([]);
}

async function createGptUsagePricingResolution(): Promise<
  UsagePricingFixture["resolution"]
> {
  const pricing = await createUsagePricingFixture({
    configured: GPT_USAGE_PRICING,
  });
  onTestFinished(pricing.cleanup);
  return pricing.resolution;
}

async function createPiApiFirstTurnUsagePricingResolution(
  provider: PiApiFirstTurnUsageProvider,
): Promise<UsagePricingFixture["resolution"]> {
  if (
    GPT_PI_BDD_MODELS.some((model) => {
      return model === provider;
    })
  ) {
    return await createGptUsagePricingResolution();
  }
  const pricing = await createUsagePricingFixture({
    configured: PI_API_FIRST_TURN_BASE_USAGE_CATEGORIES.map((category) => {
      return {
        kind: "model",
        provider,
        category,
        unitPrice: 1,
        unitSize: 1_000_000,
      };
    }),
  });
  onTestFinished(pricing.cleanup);
  return pricing.resolution;
}

async function seedBuiltInModelKey(selectedModel: string): Promise<string> {
  const fixture = await seedBuiltInModelKeyState(context, selectedModel);
  return fixture.selectedModel;
}

async function configureBuiltInPiModel(
  actor: ApiTestUser,
  selectedModel: PiApiFirstTurnUsageProvider,
): Promise<void> {
  await seedBuiltInModelKey(selectedModel);
  await api.updateOrgModelPolicies(actor, [
    {
      model: selectedModel,
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
    },
  ]);
}

async function configureApiKeyGptPiModel(
  actor: ApiTestUser,
  route: (typeof GPT_API_KEY_BDD_ROUTES)[number],
  secret: string,
): Promise<string> {
  await authDeviceSupport.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PiLoop]: true,
    [FeatureSwitchKey.CodexFastMode]: true,
  });
  const { providerId } = await upsertOrgModelProvider(actor, {
    type: route.type,
    secret,
  });
  await api.updateOrgModelPolicies(actor, [
    {
      model: route.selectedModel,
      isDefault: true,
      defaultProviderType: route.type,
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  return providerId;
}

async function configureUserOwnedGptPiModel(
  actor: ApiTestUser,
  route: (typeof USER_OWNED_GPT_FAST_BDD_ROUTES)[number],
): Promise<{ readonly secret: string; readonly accountId: string | null }> {
  if (route.type === "codex-oauth-token") {
    const accountId = "subscription-continuity-account";
    const { oauth } = await configureSubscriptionPiModel(
      actor,
      { accountId },
      route.selectedModel,
    );
    return {
      secret: z.string().parse(oauth.oauthTokenResponses[0]?.access_token),
      accountId,
    };
  }
  const secret = `${route.type}-pi-fixture-key`;
  await configureApiKeyGptPiModel(actor, route, secret);
  return { secret, accountId: null };
}

async function configureSubscriptionPiModel(
  actor: ApiTestUser,
  options: Parameters<typeof mockCodexDeviceAuthProvider>[0] = {},
  selectedModel: PiGptBddModel = "gpt-5.6-terra",
) {
  await authDeviceSupport.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    [FeatureSwitchKey.PiLoop]: true,
    [FeatureSwitchKey.CodexFastMode]: true,
  });
  const oauth = mockCodexDeviceAuthProvider({
    tokenScope: "personal",
    ...options,
  });
  const started = await authDevice.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected subscription auth to start");
  }
  const completed = await authDevice.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in completed.body) || completed.body.status !== "complete") {
    throw new Error("Expected subscription auth to complete");
  }
  await chatCallbacks.updateOrgModelPolicies(actor, [
    {
      model: selectedModel,
      isDefault: true,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
    },
  ]);
  return { oauth, accountSourceId: completed.body.provider.id };
}

async function configureBuiltInPiModelOnOpenRouter(
  actor: ApiTestUser,
  selectedModel: PiApiFirstTurnUsageProvider,
): Promise<<T>(work: () => Promise<T>) => Promise<T>> {
  await seedBuiltInModelCandidateKeys(context, selectedModel);
  const primary = await resolveBuiltInModelRouteFixture(context, selectedModel);
  const openRouterType = piNativeCatalogModelSchema.safeParse(selectedModel)
    .success
    ? "openrouter-api-key"
    : "openrouter-codex";
  if (!primary || primary.provider_type === openRouterType) {
    throw new Error(`Expected a primary managed route for ${selectedModel}`);
  }
  const unavailableCandidate = {
    selectedModel,
    providerType: primary.provider_type,
    upstreamModel: primary.upstream_model,
  };
  await withBuiltInModelRuntimeRouteCandidateUnavailableForTest(
    unavailableCandidate,
    async () => {
      const fallback = await resolveBuiltInModelRouteFixture(
        context,
        selectedModel,
      );
      if (!fallback || fallback.provider_type !== openRouterType) {
        throw new Error(`Expected an OpenRouter fallback for ${selectedModel}`);
      }
    },
  );
  await api.updateOrgModelPolicies(actor, [
    {
      model: selectedModel,
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
    },
  ]);
  return async <T>(work: () => Promise<T>): Promise<T> => {
    return await withBuiltInModelRuntimeRouteCandidateUnavailableForTest(
      unavailableCandidate,
      work,
    );
  };
}

async function sendChatRun(
  actor: ApiTestUser,
  body: ChatRunSendBody,
  usagePricingResolution?: UsagePricingFixture["resolution"],
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const { template, ...canonicalBody } = body;
  const requestBody = {
    ...canonicalBody,
    ...(template === undefined
      ? {}
      : { userMessage: userMessageWithTemplate(body.prompt, template) }),
    clientEventId: body.clientEventId ?? randomUUID(),
  };
  const sent = await chat.requestSendEvent(actor, requestBody, [201], {
    usagePricingResolution,
  });
  if (sent.status !== 201) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  let runId: string | null | undefined = sent.body.runId;
  if (runId === null) {
    // A terminal callback may claim the queued row between enqueue and the
    // inline dispatch decision. Recover as a refreshed client does: read the
    // appended replacement instead of retrying the client message id.
    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === requestBody.clientEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    runId = userMessages(messages.events).find((message) => {
      return message.revokesEventId === requestBody.clientEventId;
    })?.runId;
  }
  if (runId === undefined || runId === null) {
    throw new Error("Expected the entitled chat send to create a run");
  }
  return { runId, threadId: sent.body.threadId };
}

async function expectThreadCreatedModelEvent(
  actor: ApiTestUser,
  threadId: string,
  selectedModel: string,
): Promise<void> {
  const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
  expect(threadEvents.status).toBe(200);
  if (threadEvents.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }
  expect(threadEvents.body.events).toContainEqual(
    expect.objectContaining({
      kind: "created",
      chatThreadId: threadId,
      selectedModel,
    }),
  );
}

async function expectNoThreadModelUpdateEvent(
  actor: ApiTestUser,
  threadId: string,
  selectedModel: string,
): Promise<void> {
  const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
  expect(threadEvents.status).toBe(200);
  if (threadEvents.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }
  expect(threadEvents.body.events).not.toContainEqual(
    expect.objectContaining({
      kind: "model_selection_updated",
      chatThreadId: threadId,
      selectedModel,
    }),
  );
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{
  readonly claim: RunnerClaim;
  readonly sandboxHeaders: { readonly authorization: string };
}> {
  await api.heartbeatRunner(runnerGroup);
  const claim = await api.claimRunnerJob(runId);
  const sandboxHeaders = {
    authorization: `Bearer ${claim.sandboxToken}`,
  };
  return {
    claim,
    sandboxHeaders,
  };
}

async function expectRunAppContext(args: {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly claim: RunnerClaim;
  readonly appUrl: string;
}): Promise<void> {
  if (!args.actor.orgId) {
    throw new Error("Expected an organization-scoped chat actor");
  }
  expect(args.claim.platformEnvironment.OKOU_APP_URL).toBe(args.appUrl);
  const token = args.claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the run context to contain an Okou token");
  }
  expect(verifyOkouToken(token)).toMatchObject({
    runId: args.runId,
  });
  const state = await runStateStore.set(
    readAgentRunState$,
    {
      orgId: args.actor.orgId,
      userId: args.actor.userId,
      runId: args.runId,
    },
    context.signal,
  );
  expect(
    state.callbacks.find((callback) => {
      return callback.internalKind === "chat";
    }),
  ).toMatchObject({
    payload: { publicBrand: "okou" },
  });
}

/** Steer one owned run without scanning rows owned by other test files. */
async function steerOwnedRunAtElapsedTime(
  runId: string,
  elapsedMs: number,
): Promise<{ readonly scanned: number; readonly steered: number }> {
  return await steerRunTimeBudgetFixture(context, runId, elapsedMs);
}

function claimEnvironment(claim: RunnerClaim): Record<string, string> {
  return {
    ...claim.environment,
    ...claim.platformEnvironment,
  };
}

/** Sandbox-scoped Okou token issued through the trusted claim environment. */
function okouTokenFromClaim(claim: RunnerClaim): string {
  const token = claimEnvironment(claim).OKOU_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error(
      "Expected the claim platform environment to carry an OKOU_TOKEN",
    );
  }
  return token;
}

async function waitForThreadMessages(
  actor: ApiTestUser,
  threadId: string,
  predicate: (messages: readonly ChatEvent[]) => boolean,
) {
  let page: Awaited<ReturnType<typeof chat.listThreadEvents>> | undefined;
  await expect
    .poll(async () => {
      page = await chat.listThreadEvents(actor, threadId);
      return predicate(page.events);
    })
    .toBe(true);
  if (!page) {
    throw new Error(`Expected chat thread ${threadId} messages to be readable`);
  }
  return page;
}

async function waitForRunUserMessage(
  actor: ApiTestUser,
  threadId: string,
  runId: string,
  content: string,
): Promise<void> {
  await waitForThreadMessages(actor, threadId, (items) => {
    return userMessages(items).some((message) => {
      return (
        message.runId === runId && chatEventDisplayText(message) === content
      );
    });
  });
}

async function waitForRunStatus(
  actor: ApiTestUser,
  runId: string,
  status:
    | "cancelled"
    | "completed"
    | "failed"
    | "pending"
    | "queued"
    | "running"
    | "timeout",
  timeout = 1000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const run = await api.readRun(actor, runId);
        return run.status;
      },
      { timeout },
    )
    .toBe(status);
}

async function waitForThreadTitle(
  actor: ApiTestUser,
  threadId: string,
  title: string | null,
): Promise<void> {
  await expect
    .poll(async () => {
      return await readThreadTitleFromEvents(actor, threadId);
    })
    .toBe(title);
}

async function readThreadTitleFromEvents(
  actor: ApiTestUser,
  threadId: string,
): Promise<string | null> {
  const events = await chat.requestThreadEvents(actor, {}, [200]);
  if (events.status !== 200) {
    throw new Error("Expected chat thread events to load");
  }

  let latestTitleEvent:
    | { readonly title: string | null; readonly createdAt: string }
    | undefined;
  for (const event of events.body.events) {
    if (
      event.chatThreadId !== threadId ||
      (event.kind !== "created" && event.kind !== "renamed")
    ) {
      continue;
    }
    if (
      latestTitleEvent === undefined ||
      Date.parse(event.createdAt) >= Date.parse(latestTitleEvent.createdAt)
    ) {
      latestTitleEvent = event;
    }
  }

  return latestTitleEvent?.title ?? null;
}

/**
 * Checkpoint + exitCode-0 complete (completing without a checkpoint fails the
 * run).
 */
interface ChatRunCompletionOptions {
  readonly activeInputDeliveryIds?: readonly string[];
  readonly cliAgentSessionId?: string;
  readonly cliAgentType?: "claude-code" | "codex" | "pi";
  readonly lastEventSequence?: number;
  readonly sessionHistory?: string;
  readonly usagePricingResolution?: UsagePricingFixture["resolution"];
}

function frameworkMatchingCompletionOptions(
  threadId: string,
  cliAgentType: "claude-code" | "codex" | "pi",
): ChatRunCompletionOptions {
  if (cliAgentType !== "pi") {
    return { cliAgentType };
  }
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: threadId,
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "BDD Pi completion checkpoint" }],
    api: "openai-responses",
    provider: "openai",
    model: "bdd-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  });
  return {
    cliAgentType,
    cliAgentSessionId: threadId,
    sessionHistory: session.toJsonl(),
  };
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  options: ChatRunCompletionOptions = {},
): Promise<void> {
  const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
  if (stagedOutputEvents.length > 0) {
    await webhooks.requestAgentEvents(
      { runId, events: stagedOutputEvents },
      sandboxHeaders,
      [200],
    );
  }
  const history = options.sessionHistory ?? `bdd chat session history ${runId}`;
  const historyHash = createHash("sha256").update(history).digest("hex");
  if (options.sessionHistory !== undefined) {
    const historyBytes = Buffer.from(history, "utf8");
    context.sessionHistoryBlobs.set(historyHash, historyBytes);
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId,
        hash: historyHash,
        rawSize: historyBytes.byteLength,
        encodedSize: historyBytes.byteLength,
        encoding: "identity",
      },
      sandboxHeaders,
      [200],
    );
  }
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: options.cliAgentType ?? "claude-code",
        cliAgentSessionId: options.cliAgentSessionId ?? `bdd-cli-${runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      ...(options.activeInputDeliveryIds === undefined
        ? {}
        : { activeInputDeliveryIds: [...options.activeInputDeliveryIds] }),
      ...(options.lastEventSequence === undefined
        ? stagedOutputEvents.length === 0
          ? {}
          : {
              lastEventSequence: Math.max(
                ...stagedOutputEvents.map((event) => {
                  return event.sequenceNumber;
                }),
              ),
            }
        : { lastEventSequence: options.lastEventSequence }),
    },
    sandboxHeaders,
    [200],
    undefined,
    options.usagePricingResolution,
  );
}

async function failChatRun(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  error: string,
): Promise<void> {
  await webhooks.requestAgentComplete(
    { runId, exitCode: 1, error },
    sandboxHeaders,
    [200],
  );
}

async function cancelChatRun(
  actor: ApiTestUser,
  runId: string,
  sandboxHeaders?: { readonly authorization: string },
): Promise<void> {
  await api.requestCancelRun(actor, runId, [200]);
  await waitForRunStatus(actor, runId, "cancelled");
  if (sandboxHeaders) {
    await failChatRun(runId, sandboxHeaders, "Run cancelled");
    await flushWaitUntilForTest();
  }
}

function assistantMessages(messages: readonly ChatEvent[]): AssistantMessage[] {
  return messages.filter((message): message is AssistantMessage => {
    return !isUserMessage(message);
  });
}

function userMessages(messages: readonly ChatEvent[]): UserMessage[] {
  return messages.filter(isUserMessage);
}

function isUserMessage(message: ChatEvent): message is UserMessage {
  switch (message.eventType) {
    case "input.prompt":
    case "input.automation":
    case "input.rejected":
    case "control.interrupt":
    case "control.revoke": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function eventBackedContents(
  messages: readonly ChatEvent[],
  runId: string,
): OutputMessage[] {
  return messages.filter((message): message is OutputMessage => {
    return message.eventType === "output.message" && message.runId === runId;
  });
}

function recommendedFollowupEvents(
  messages: readonly ChatEvent[],
  runId: string,
): FollowupsEvent[] {
  return messages.filter((message): message is FollowupsEvent => {
    return (
      message.eventType === "output.followups" &&
      message.runId === runId &&
      resolveChatEventRecommendedFollowups(message).length > 0
    );
  });
}

function assistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    eventType: "assistant",
    sequenceNumber,
    eventData: { message: { content: [{ type: "text", text }] } },
  };
}

function modelProviderSecretPlaceholder(
  type: ModelProviderType,
  secretName: string,
): string {
  const placeholder =
    getModelProviderFirewall(type)?.placeholders?.[secretName];
  if (!placeholder) {
    throw new Error(`Missing model provider placeholder for ${secretName}`);
  }
  return placeholder;
}

function modelProvidersClient() {
  return setupApp({ context, routes: modelProvidersRoutes })(
    modelProvidersMainContract,
  );
}

function modelProviderConnectionsClient() {
  return setupApp({ context, routes: modelProviderGatewayRoutes })(
    modelProviderConnectionsMainContract,
  );
}

async function configureCustomPiModel(
  actor: ApiTestUser,
  selectedModel: SupportedRunModel,
  upstreamModel = `company-${selectedModel}-production`,
) {
  const secret = "custom-pi-gateway-secret";
  const surface = {
    protocol: "openai-responses" as const,
    apiBaseUrl: "https://pi-custom-gateway.example.com/openai/v1",
    authHeaderName: "x-api-key",
    authHeaderTemplate: "Key {{secret}}",
    modelMappings: { [selectedModel]: upstreamModel },
  };
  const created = await accept(
    modelProviderConnectionsClient().create({
      headers: sessionHeaders(actor),
      body: {
        displayName: `Pi custom gateway for ${selectedModel}`,
        secret,
        surfaces: [surface],
      },
    }),
    [201],
  );
  const surfaceId = created.body.surfaces[0]?.id;
  if (!surfaceId) {
    throw new Error("Expected the custom Pi gateway to have a surface");
  }
  await api.updateOrgModelPolicies(actor, [
    {
      model: selectedModel,
      isDefault: true,
      defaultProviderType: "custom-openai-responses",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
    },
  ]);
  await authDeviceSupport.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PiLoop]: true,
    [FeatureSwitchKey.CodexFastMode]: true,
  });
  return {
    connection: created.body,
    surfaceId,
    surface,
    secret,
    upstreamModel,
    endpoint: `${surface.apiBaseUrl}/responses`,
  };
}

function chatEventsClient(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return setupApp({
    context,
    routes: chatEventsRoutes,
    usagePricingResolution,
  })(chatEventsContract);
}

function chatThreadsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

async function expectPiActivitySummaryBeforeGuestReplay(
  actor: ApiTestUser,
  run: { readonly threadId: string; readonly runId: string },
  activityEnabled: boolean,
): Promise<void> {
  const orgId = requireOrgId(actor);
  // The API-first projection must capture tools before any guest replay/result.
  await flushWaitUntilForTest();
  mockOptionalEnv("OPENROUTER_API_KEY", "activity-summary-key");
  let activityInput = "";
  server.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }) => {
        const body = openRouterBodySchema.parse(await request.json());
        activityInput = body.messages
          .map((message) => {
            return message.content;
          })
          .join("\n");
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Checking the CLI and preparing the note" },
            },
          ],
        });
      },
    ),
  );
  if (!activityEnabled) {
    await accept(
      setupApp({ context, routes: chatThreadActivitySummaryRoutes })(
        chatThreadActivitySummaryContract,
      ).summarize({
        headers: sessionHeaders(actor),
        params: { id: run.threadId },
        body: { runId: run.runId },
      }),
      [403],
    );
    expect(activityInput).toBe("");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.ThreadActivitySummary]: true },
    );
  }
  const activity = await accept(
    setupApp({ context, routes: chatThreadActivitySummaryRoutes })(
      chatThreadActivitySummaryContract,
    ).summarize({
      headers: sessionHeaders(actor),
      params: { id: run.threadId },
      body: { runId: run.runId },
    }),
    [200],
  );
  expect(activity.body).toMatchObject({
    status: "available",
    messages: [
      {
        id: "Checking the CLI and preparing the note",
        text: "Checking the CLI and preparing the note",
      },
    ],
  });
  if (activityEnabled) {
    expect(activityInput).toContain("okou --help");
    expect(activityInput).toContain("add_ad_hoc_note");
  }
  expect(activityInput).not.toContain(
    "API-first reasoning preserved for Sandbox resume",
  );
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
}

describe("CHAT-02: thread run admission invariant", () => {
  it("rejects thread-bound run creation without a queue association at both service boundaries", async () => {
    await expect(
      createUnassociatedThreadBoundAgentRunsServiceFixture(),
    ).rejects.toThrow(
      "Thread-bound agent run requires a queue-first association",
    );

    await expect(
      createUnassociatedThreadBoundAgentRunFixture(),
    ).rejects.toThrow("Thread-bound run requires a queue-first association");

    await expect(
      createUnassociatedThreadBoundAgentRunsServiceFixture(""),
    ).rejects.toThrow(
      "Thread-bound agent run requires a queue-first association",
    );

    await expect(
      createUnassociatedThreadBoundAgentRunFixture(""),
    ).rejects.toThrow("Thread-bound run requires a queue-first association");
  });
});

interface SelectedThreadConnectorFixture extends EntitledChatActor {
  readonly connectionId: string;
  readonly threadId: string;
}

async function selectedThreadConnectorFixture(
  title: string,
): Promise<SelectedThreadConnectorFixture> {
  // A unique version still shares the active source with other test files.
  // Own the source so their catalog setup cannot invalidate this projection.
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `test-thread-runtime-context-${randomUUID()}`,
  );
  await installApiTestConnectorCatalog({
    catalogVersion: `api-test-thread-runtime-overlap-${randomUUID()}`,
    runtimeProjection: true,
  });
  const entitled = await entitledChatActor();
  const connection = await connectors.connectManualGrant(
    entitled.actor,
    "openai",
    "api-token",
    { apiKey: `thread-runtime-overlap-${randomUUID()}` },
    entitled.agentId,
  );
  const thread = await chat.createThread(entitled.actor, {
    agentId: entitled.agentId,
    title,
  });
  await accept(
    chatThreadConnectorSelectionsClient().update({
      headers: sessionHeaders(entitled.actor),
      params: { id: thread.id },
      body: {
        connectionId: connection.id,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    }),
    [200],
  );
  return {
    ...entitled,
    connectionId: connection.id,
    threadId: thread.id,
  };
}

async function configureRuntimeContextGateway(
  actor: ApiTestUser,
): Promise<void> {
  const gateway = await accept(
    modelProviderConnectionsClient().create({
      headers: sessionHeaders(actor),
      body: {
        displayName: "Runtime context priority gateway",
        secret: "runtime-context-priority-secret",
        surfaces: [
          {
            protocol: "anthropic-messages",
            apiBaseUrl:
              "https://runtime-context-priority.example.com/anthropic",
            authHeaderName: "Authorization",
            authHeaderTemplate: "Bearer {{secret}}",
            modelMappings: {
              "claude-sonnet-5": "anthropic/claude-sonnet-4.6",
            },
          },
        ],
      },
    }),
    [201],
  );
  const surfaceId = gateway.body.surfaces[0]?.id;
  if (!surfaceId) {
    throw new Error("Expected the runtime context gateway to have a surface");
  }
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
    },
  ]);
}

function setThreadConnectorCatalogReadHook(hook: () => Promise<void>): void {
  // Admission first reads the run scope's projection and passes that result
  // into preparation. Inject the failure/barrier only on the subsequent
  // current-authority read for the stored thread account.
  let admissionRead = true;
  setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook(() => {
    if (admissionRead) {
      admissionRead = false;
      return Promise.resolve();
    }
    return hook();
  });
}

describe("CHAT-02: thread connector account selection", () => {
  it.each(["missing", "incomplete"] as const)(
    "reads the selected account when the catalog projection is %s",
    async (projectionState) => {
      const fixture = await selectedThreadConnectorFixture(
        "Thread catalog projection fallback",
      );
      // Advance authority so setup's cached selection cannot hide a missing row.
      await installApiTestConnectorCatalog({
        catalogVersion: `api-test-thread-fallback-${randomUUID()}`,
        runtimeProjection: true,
      });
      // Model an older/incomplete persisted projection through the external
      // database fixture; public APIs cannot create these rollout states.
      if (projectionState === "missing") {
        await deleteApiTestConnectorCatalogRuntimeProjectionSet();
      } else {
        await deleteApiTestConnectorCatalogRuntimeProjectionRow("openai");
      }
      const selections = await accept(
        chatThreadConnectorSelectionsClient().get({
          headers: sessionHeaders(fixture.actor),
          params: { id: fixture.threadId },
        }),
        [200],
      );
      expect(selections.body.selectedConnections).toMatchObject([
        {
          id: fixture.connectionId,
          target: { kind: "builtin", connectorSlug: "openai" },
          connectionStatus: "connected",
        },
      ]);
    },
  );

  it("uses a selected builtin account without reading the full catalog", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Scoped thread catalog selection",
    );
    onTestFinished(() => {
      clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
    });
    // Reject the external full-snapshot read while leaving real scoped
    // PostgreSQL projections available to this API request.
    setApiTestConnectorCatalogExternalReaderIdentityReadHook(() => {
      return Promise.reject(new Error("Full catalog read is unavailable"));
    });

    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(fixture.actor),
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: fixture.connectionId,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    ]);
    const run = await sendChatRun(fixture.actor, {
      agentId: fixture.agentId,
      threadId: fixture.threadId,
      prompt: "Use the selected account from its current projection",
    });
    const claimed = await claimChatRun(fixture.runnerGroup, run.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: fixture.connectionId });
    await cancelChatRun(fixture.actor, run.runId, claimed.sandboxHeaders);
  });

  it("preserves an out-of-scope choice without requiring its catalog", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Out-of-scope thread catalog selection",
    );
    await api.enableAgentConnectors(fixture.actor, fixture.agentId, []);
    onTestFinished(() => {
      clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const rejectCatalogRead = () => {
      return Promise.reject(new Error("Connector catalog is unavailable"));
    };
    setApiTestConnectorCatalogExternalReaderIdentityReadHook(rejectCatalogRead);
    setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook(
      rejectCatalogRead,
    );
    const run = await sendChatRun(fixture.actor, {
      agentId: fixture.agentId,
      threadId: fixture.threadId,
      prompt: "Do not use the connector removed from the agent scope",
    });
    const claimed = await claimChatRun(fixture.runnerGroup, run.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toBeUndefined();
    await cancelChatRun(fixture.actor, run.runId, claimed.sandboxHeaders);

    clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
    clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    await api.enableAgentConnectors(fixture.actor, fixture.agentId, ["openai"]);
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(fixture.actor),
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: fixture.connectionId,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    ]);
    const reauthorized = await sendChatRun(fixture.actor, {
      agentId: fixture.agentId,
      threadId: fixture.threadId,
      prompt: "Use the preserved account after reauthorization",
    });
    const reauthorizedClaim = await claimChatRun(
      fixture.runnerGroup,
      reauthorized.runId,
    );
    expect(
      reauthorizedClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: fixture.connectionId });
    await cancelChatRun(
      fixture.actor,
      reauthorized.runId,
      reauthorizedClaim.sandboxHeaders,
    );
  });

  it("overlaps stored thread selection with model-provider resolution", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Runtime context overlap thread",
    );
    await configureRuntimeContextGateway(fixture.actor);
    onTestFinished(() => {
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const threadCatalogReadStarted = createDeferredPromise<void>(
      context.signal,
    );
    onTestFinished(() => {
      if (!threadCatalogReadStarted.settled()) {
        threadCatalogReadStarted.resolve(undefined);
      }
    });
    setThreadConnectorCatalogReadHook(() => {
      if (!threadCatalogReadStarted.settled()) {
        threadCatalogReadStarted.resolve(undefined);
      }
      return Promise.resolve();
    });
    const kms = useSecretKmsProbe(undefined, async () => {
      await threadCatalogReadStarted.promise;
      return Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    });

    const run = await sendChatRun(fixture.actor, {
      agentId: fixture.agentId,
      threadId: fixture.threadId,
      prompt: "Overlap stored thread selection with runtime context",
    });
    expect(threadCatalogReadStarted.settled()).toBeTruthy();
    clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    const claimed = await claimChatRun(fixture.runnerGroup, run.runId);
    expect(kms.decryptCalls).toBeGreaterThan(0);
    expect(claimed.claim.environment).toMatchObject({
      ANTHROPIC_BASE_URL:
        "https://runtime-context-priority.example.com/anthropic",
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4.6",
    });
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: fixture.connectionId });
    await cancelChatRun(fixture.actor, run.runId, claimed.sandboxHeaders);
  });

  it("keeps abort priority over a concurrent thread-selection failure", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Runtime context abort priority thread",
    );
    onTestFinished(() => {
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const abortError = new Error("runtime context priority abort");
    abortError.name = "AbortError";
    const abortThreadError = new Error("thread selection below abort");
    const abortController = new AbortController();
    setThreadConnectorCatalogReadHook(() => {
      abortController.abort(abortError);
      return Promise.reject(abortThreadError);
    });
    context.mocks.sentry.captureException.mockClear();
    await expect(
      chat.requestSendEvent(
        fixture.actor,
        {
          agentId: fixture.agentId,
          threadId: fixture.threadId,
          prompt: "Prefer abort over a thread-selection failure",
          clientEventId: randomUUID(),
        },
        [201],
        {},
        abortController.signal,
      ),
    ).rejects.toThrow("Unknown response status 500");
    expect(abortController.signal.reason).toBe(abortError);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("keeps thread-selection failure priority over a concurrent provider failure", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Runtime context thread priority thread",
    );
    await configureRuntimeContextGateway(fixture.actor);
    onTestFinished(() => {
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const providerFailureStarted = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!providerFailureStarted.settled()) {
        providerFailureStarted.resolve(undefined);
      }
    });
    const threadError = new Error("runtime thread selection priority failure");
    const providerError = new Error("model provider below thread failure");
    setThreadConnectorCatalogReadHook(async () => {
      await providerFailureStarted.promise;
      throw threadError;
    });
    const kms = useSecretKmsProbe(undefined, () => {
      if (!providerFailureStarted.settled()) {
        providerFailureStarted.resolve(undefined);
      }
      return Promise.reject(providerError);
    });
    context.mocks.sentry.captureException.mockClear();
    await expect(
      chat.requestSendEvent(
        fixture.actor,
        {
          agentId: fixture.agentId,
          threadId: fixture.threadId,
          prompt: "Prefer thread selection over provider failure",
          clientEventId: randomUUID(),
        },
        [201],
      ),
    ).rejects.toThrow("Unknown response status 500");
    expect(providerFailureStarted.settled()).toBeTruthy();
    expect(kms.decryptCalls).toBeGreaterThan(0);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      threadError,
    );
  });

  it.each(["revocation", "reauthorization"] as const)(
    "uses the default connector account across %s without an override",
    async (transition) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      if (!actor.orgId) {
        throw new Error("Expected an organization-scoped chat actor");
      }
      const connection = await connectors.connectManualGrant(
        actor,
        "openai",
        "api-token",
        { apiKey: "thread-selected-openai-key" },
        agentId,
      );

      let threadId: string;
      if (transition === "revocation") {
        context.mocks.ably.publish.mockClear();
        const authorized = await sendChatRun(actor, {
          agentId,
          prompt: "Use my OpenAI connector account",
        });
        const { claim, sandboxHeaders } = await claimChatRun(
          runnerGroup,
          authorized.runId,
        );
        expect(claim.secretConnectorMetadataMap?.OPENAI_TOKEN).toMatchObject({
          sourceId: connection.id,
        });

        const selections = await accept(
          chatThreadConnectorSelectionsClient().get({
            headers: sessionHeaders(actor),
            params: { id: authorized.threadId },
          }),
          [200],
        );
        expect(selections.body.selections).toStrictEqual([]);
        expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
          `chatThreadDetailChanged:${authorized.threadId}`,
          null,
        );

        await completeChatRunOk(authorized.runId, sandboxHeaders);
        await flushWaitUntilForTest();
        threadId = authorized.threadId;
      } else {
        const thread = await chat.createThread(actor, {
          agentId,
          title: "Connector reauthorization",
        });
        threadId = thread.id;
      }

      await api.enableAgentConnectors(actor, agentId, []);
      const unauthorizedResponse = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId,
          prompt: "Continue while OpenAI is unauthorized",
        },
        [201],
      );
      if (unauthorizedResponse.status !== 201) {
        throw new Error("Expected the unauthorized-connector send to succeed");
      }
      if (!unauthorizedResponse.body.runId) {
        throw new Error("Expected the unauthorized-connector run to start");
      }
      const unauthorized = {
        runId: unauthorizedResponse.body.runId,
        threadId: unauthorizedResponse.body.threadId,
      };
      const unauthorizedClaim = await claimChatRun(
        runnerGroup,
        unauthorized.runId,
      );
      expect(
        unauthorizedClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toBeUndefined();
      await completeChatRunOk(
        unauthorized.runId,
        unauthorizedClaim.sandboxHeaders,
      );
      await flushWaitUntilForTest();

      if (transition === "revocation") {
        return;
      }

      await api.enableAgentConnectors(actor, agentId, ["openai"]);
      const reauthorized = await sendChatRun(actor, {
        agentId,
        threadId,
        prompt: "Continue after OpenAI is authorized again",
      });
      const reauthorizedClaim = await claimChatRun(
        runnerGroup,
        reauthorized.runId,
      );
      expect(
        reauthorizedClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toMatchObject({ sourceId: connection.id });
      await cancelChatRun(actor, reauthorized.runId);
    },
  );

  it("does not persist connector overrides during concurrent first sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "concurrent-thread-selected-openai-key" },
      agentId,
    );
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Concurrent connector selection thread",
    });
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });

    const clientEventIds = [randomUUID(), randomUUID()] as const;
    const sends = clientEventIds.map((clientEventId, index) => {
      return chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: `Concurrent connector selection send ${index + 1}`,
          clientEventId,
        },
        [201],
      );
    });
    await expect.poll(threadLock.blockedWaiterCount).toBeGreaterThanOrEqual(2);
    threadLock.release();
    await threadLock.done;

    const responses = await Promise.all(sends);
    const responseBodies = responses.map((response) => {
      if (response.status !== 201) {
        throw new Error("Expected both concurrent sends to be accepted");
      }
      return response.body;
    });
    const activeIndexes = responseBodies.flatMap((body, index) => {
      return body.runId === null ? [] : [index];
    });
    expect(activeIndexes).toHaveLength(1);
    const activeIndex = activeIndexes[0];
    if (activeIndex === undefined) {
      throw new Error("Expected one concurrent send to start a run");
    }
    const activeRunId = responseBodies[activeIndex]?.runId;
    if (!activeRunId) {
      throw new Error("Expected the active concurrent send to have a run id");
    }
    const queuedEventId = clientEventIds.find((_, index) => {
      return index !== activeIndex;
    });
    if (!queuedEventId) {
      throw new Error("Expected one concurrent send to remain queued");
    }

    const claimed = await claimChatRun(runnerGroup, activeRunId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: connection.id });
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        revokesEventId: queuedEventId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected the queued concurrent send to be recalled");
    }
    expect(recalled.body.runId).toBeNull();
    await cancelChatRun(actor, activeRunId, claimed.sandboxHeaders);
  });

  it("uses default custom HTTP and MCP accounts without persisting overrides", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId },
      {
        [FeatureSwitchKey.CustomConnectorMcp]: true,
      },
    );
    const httpConnector = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        slug: `_thread-http-runtime-${randomUUID()}`,
        displayName: "Thread HTTP runtime connector",
        prefixTemplates: ["https://thread-http-runtime.example.test/v1/"],
      }),
    );
    const mcpConnector = await connectors.createCustomConnector(actor, {
      kind: "mcp",
      slug: `_thread-mcp-runtime-${randomUUID()}`,
      displayName: "Thread MCP runtime connector",
      endpoint: "https://thread-mcp-runtime.example.test/server",
      transport: "streamable-http",
      fields: [
        {
          key: "secret",
          label: "API token",
          kind: "secret",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.secret}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });
    await connectors.setCustomConnectorSecret(
      actor,
      httpConnector.id,
      "thread-http-runtime-secret",
    );
    await connectors.setCustomConnectorSecret(
      actor,
      mcpConnector.id,
      "thread-mcp-runtime-secret",
    );
    await connectors.updateAgentCustomConnectors(actor, agentId, [
      httpConnector.id,
      mcpConnector.id,
    ]);
    const httpConnection = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId,
        userId: actor.userId,
        customConnectorId: httpConnector.id,
      },
    );
    const mcpConnection = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId,
        userId: actor.userId,
        customConnectorId: mcpConnector.id,
      },
    );
    const httpConnectorId = httpConnection.connector?.id;
    const mcpConnectorId = mcpConnection.connector?.id;
    if (!httpConnectorId || !mcpConnectorId) {
      throw new Error("Expected custom HTTP and MCP connector accounts");
    }

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Use my selected HTTP and MCP connector accounts",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.connectorRuntimeTargets).toContainEqual({
      kind: "custom",
      customConnectorId: httpConnector.id,
      baseUrlVars: {},
      sourceId: httpConnectorId,
    });
    expect(claimed.claim.connectorRuntimeTargets).toContainEqual({
      kind: "custom",
      customConnectorId: mcpConnector.id,
      baseUrlVars: {},
      sourceId: mcpConnectorId,
    });
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: run.threadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  });

  it("starts the run when a selected custom connector becomes unavailable", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const customConnector = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        slug: `_thread-runtime-${randomUUID()}`,
        displayName: "Thread runtime connector",
        prefixTemplates: ["https://thread-runtime.example.test/v1/"],
      }),
    );
    await connectors.setCustomConnectorSecret(
      actor,
      customConnector.id,
      "thread-runtime-secret",
    );
    await connectors.updateAgentCustomConnectors(actor, agentId, [
      customConnector.id,
    ]);
    const connection = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId,
        userId: actor.userId,
        customConnectorId: customConnector.id,
      },
    );
    const connectorId = connection.connector?.id;
    const storageVersion = connection.connector?.storage_version;
    if (!connectorId || storageVersion === undefined) {
      throw new Error("Expected a custom connector account");
    }

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "Use my default custom connector account",
    });
    onTestFinished(() => {
      clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const rejectBuiltinCatalogRead = () => {
      return Promise.reject(new Error("Builtin catalog is unavailable"));
    };
    setApiTestConnectorCatalogExternalReaderIdentityReadHook(
      rejectBuiltinCatalogRead,
    );
    setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook(
      rejectBuiltinCatalogRead,
    );
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: first.threadId },
        body: {
          connectionId: connectorId,
          target: {
            kind: "custom",
            customConnectorId: customConnector.id,
          },
        },
      }),
      [200],
    );
    const availableSelection = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: first.threadId },
      }),
      [200],
    );
    expect(availableSelection.body.selectedConnections).toMatchObject([
      {
        id: connectorId,
        target: { kind: "custom", customConnectorId: customConnector.id },
        connectionStatus: "connected",
      },
    ]);
    clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
    clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    await cancelChatRun(actor, first.runId);
    await setCustomConnectorCredentialStorageState(context, {
      orgId,
      userId: actor.userId,
      customConnectorId: customConnector.id,
      authMethod: "manual",
      storageVersion,
      needsReconnect: true,
    });

    const fallback = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "Continue despite the unavailable connector account",
    });
    const claimed = await claimChatRun(runnerGroup, fallback.runId);
    expect(claimed.claim.connectorRuntimeTargets).not.toContainEqual(
      expect.objectContaining({ customConnectorId: customConnector.id }),
    );
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: first.threadId },
      }),
      [200],
    );
    expect(selections.body.selections).toContainEqual({
      connectionId: connectorId,
      target: { kind: "custom", customConnectorId: customConnector.id },
    });
    await cancelChatRun(actor, fallback.runId, claimed.sandboxHeaders);
  });

  it("starts the run when the runtime catalog no longer contains the selected built-in", async () => {
    // Catalog rows are global by source, so isolate mutations from parallel test files.
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `test-chat-retired-catalog-connector-${randomUUID()}`,
    );
    await installApiTestConnectorCatalog({ runtimeProjection: true });
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "retired-thread-openai-key" },
      agentId,
    );
    const runtimeConnection = await connectors.connectManualGrant(
      actor,
      "runtime",
      "api-token",
      { apiKey: "retired-thread-runtime-key" },
      agentId,
    );
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Retired catalog connector thread",
    });
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: runtimeConnection.id,
          target: { kind: "builtin", connectorSlug: "runtime" },
        },
      }),
      [200],
    );

    const catalogVersion = `api-test-without-openai-${randomUUID()}`;
    const catalogWithoutOpenAi = {
      ...API_TEST_CONNECTOR_CATALOG,
      catalogVersion,
      connectors: API_TEST_CONNECTOR_CATALOG.connectors.filter((connector) => {
        return connector.slug !== "openai";
      }),
    };
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion,
      rawBytes: Buffer.from(`${JSON.stringify(catalogWithoutOpenAi)}\n`),
      catalogValidationAuthority: apiTestConnectorCatalogValidationAuthority(),
    });

    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Continue after the selected connector leaves the catalog",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toBeUndefined();

    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: runtimeConnection.id,
        target: { kind: "builtin", connectorSlug: "runtime" },
      },
    ]);
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [400],
    );
    await accept(
      chatThreadsClient().create({
        headers: sessionHeaders(actor),
        body: {
          agentId,
          model: "claude-sonnet-5",
          connectorSelections: [
            {
              connectionId: connection.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [400],
    );
    await accept(
      chatThreadConnectorSelectionsClient().clear({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: { kind: "builtin", connectorSlug: "openai" },
      }),
      [204],
    );
    await installApiTestConnectorCatalog();
    const restoredSelections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
      }),
      [200],
    );
    expect(restoredSelections.body.selections).toStrictEqual(
      selections.body.selections,
    );
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  });
});

function sessionHeaders(actor: ApiTestUser): {
  readonly authorization: string;
} {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

/** Org-admin model provider upsert through the public route. */
async function upsertOrgModelProvider(
  actor: ApiTestUser,
  body: UpsertModelProviderRequest,
): Promise<{ readonly providerId: string; readonly created: boolean }> {
  const response = await accept(
    modelProvidersClient().upsert({
      headers: sessionHeaders(actor),
      body,
    }),
    [200, 201],
  );
  return {
    providerId: response.body.provider.id,
    created: response.body.created,
  };
}

async function readThreadComputerUseHostId(
  actor: ApiTestUser,
  threadId: string,
): Promise<string | null> {
  return (await readThreadProjection(actor, threadId)).computerUseHostId;
}

async function readThreadProjection(actor: ApiTestUser, threadId: string) {
  const snapshot = await chat.getThreadSnapshot(actor);
  const events: ChatThreadEvent[] = [];
  let cursor = snapshot.latestSeqId;

  for (let page = 0; page < 20; page++) {
    const response = await chat.requestThreadEvents(
      actor,
      cursor ? { sinceSeqId: cursor } : {},
      [200],
    );
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }

    const sequencedEvents = response.body.events.map((event) => {
      if (event.seqId === undefined) {
        throw new Error("Expected chat thread event sequence ID");
      }
      return { ...event, seqId: event.seqId };
    });
    events.push(...sequencedEvents);
    if (!response.body.hasMore) {
      break;
    }

    const lastEvent = sequencedEvents.at(-1);
    if (!lastEvent) {
      throw new Error("Expected paginated chat thread events");
    }
    cursor = lastEvent.seqId;
  }

  const thread = replayChatThreadEvents(snapshot.chatThreads, events).find(
    (candidate) => {
      return candidate.id === threadId;
    },
  );
  if (!thread) {
    throw new Error("Expected chat thread event projection");
  }
  return thread;
}

/**
 * Raw chat send through the Hono app, for statuses the typed contract does
 * not model (precedent: requestListAutomationsRaw in api-bdd-runs).
 */
async function requestSendEventRaw(
  actor: ApiTestUser,
  body: ChatRunSendBody & {
    readonly userMessage: UserMessageInputDocument;
    readonly hasTextContent: boolean;
  },
  signal: AbortSignal = context.signal,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers = sessionHeaders(actor);
  const app = createApp({ signal, routes: TEST_APP_ROUTES });
  const response = await app.request("/api/chat/events", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody: unknown = await response.json();
  return { status: response.status, body: responseBody };
}

/** Chat send authenticated by a run-scoped sandbox bearer token. */
async function requestSendEventWithBearer(
  token: string,
  body: {
    readonly agentId: string;
    readonly clientEventId?: string;
    readonly prompt: string;
    readonly threadId?: string;
    readonly model?: SupportedRunModel;
    readonly runOptions?: ChatRunOptionsRequest;
    readonly userMessage?: UserMessageInputDocument;
  },
  statuses: readonly (201 | 400 | 401 | 403 | 404 | 409)[],
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return await accept(
    chatEventsClient(usagePricingResolution).send({
      headers: { authorization: `Bearer ${token}` },
      body: {
        ...body,
        hasTextContent: true,
        userMessage:
          body.userMessage ??
          ({
            version: 1,
            parts: [{ type: "text", text: body.prompt }],
          } satisfies UserMessageInputDocument),
      },
    }),
    statuses,
  );
}

async function expectAgentTokenThreadOwnershipBoundaries(args: {
  readonly agentId: string;
  readonly orgId: string;
  readonly sourceToken: string;
}): Promise<void> {
  const crossUser = bdd.user({ orgId: args.orgId });
  const crossUserThread = await chat.createThread(crossUser, {
    agentId: args.agentId,
  });
  const crossUserSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: args.agentId,
      threadId: crossUserThread.id,
      prompt: "reject cross-user delegated memory admission",
    },
    [404],
  );
  expect(crossUserSend.status).toBe(404);

  const crossOrg = await entitledChatActor();
  const crossOrgThread = await chat.createThread(crossOrg.actor, {
    agentId: crossOrg.agentId,
  });
  const crossOrgSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: crossOrg.agentId,
      threadId: crossOrgThread.id,
      prompt: "reject cross-org delegated memory admission",
    },
    [404],
  );
  expect(crossOrgSend.status).toBe(404);

  const unownedThreadSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: args.agentId,
      threadId: randomUUID(),
      prompt: "reject unowned-thread delegated memory admission",
    },
    [404],
  );
  expect(unownedThreadSend.status).toBe(404);
}

async function expectAgentChatProvenance(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly delegatedEventId: string;
  readonly delegatedRunId: string;
  readonly orgId: string;
  readonly source: { readonly runId: string; readonly threadId: string };
  readonly targetThreadId: string;
}): Promise<void> {
  const delegatedState = await runStateStore.set(
    readAgentRunState$,
    {
      orgId: args.orgId,
      userId: args.actor.userId,
      runId: args.delegatedRunId,
    },
    context.signal,
  );
  expect(delegatedState.agent_run).toMatchObject({ triggerSource: "agent" });
  const delegatedMessages = await waitForThreadMessages(
    args.actor,
    args.targetThreadId,
    (events) => {
      return userMessages(events).some((event) => {
        return event.id === args.delegatedEventId;
      });
    },
  );
  const delegatedInput = userMessages(delegatedMessages.events).find(
    (event): event is PromptMessage => {
      return (
        event.eventType === "input.prompt" && event.id === args.delegatedEventId
      );
    },
  );
  expect(delegatedInput?.userMessage.parts).toContainEqual({
    type: "source",
    kind: "agent",
    runId: args.source.runId,
    threadId: args.source.threadId,
    agentId: args.agentId,
    titleSnapshot: "New thread",
    href: `/chats/${args.source.threadId}#run-${args.source.runId}`,
  });
}

async function expectExactPrivatePiMemoryAdmission(args: {
  readonly orgId: string;
  readonly runId: string;
  readonly userId: string;
}): Promise<void> {
  // Stage 1 candidates intentionally have no production read API. After the
  // real send and completion paths run, this focused fixture proves the exact
  // private admission identity without controlling the behavior under test.
  const conversation = await readPiConversationIdentityFixture(args.runId);
  const candidate = await readPiMemoryStage1CandidateFixture({
    orgId: args.orgId,
    userId: args.userId,
  });
  if (!candidate) {
    throw new Error("Expected delegated Pi history to create a candidate");
  }
  expect(candidate).toMatchObject({
    orgId: args.orgId,
    userId: args.userId,
    memoryStorageName: "memory",
    piSessionId: conversation.piSessionId,
    sourceRunId: args.runId,
    sourceHistoryHash: conversation.sourceHistoryHash,
    status: "pending",
  });
  expect(
    candidate.eligibleAt.getTime() - candidate.sourceCompletedAt.getTime(),
  ).toBe(60_000);
  await expect(
    readmitPiMemoryStage1CandidateFixture(args.runId),
  ).resolves.toMatchObject({ outcome: "exact_retry" });
  // Admission has no public endpoint. A mismatched captured identity must not
  // create or replace learning, even when the run has valid native history.
  for (const ownership of [
    { userId: `other-${args.userId}` },
    { orgId: `other-${args.orgId}` },
    { chatThreadId: randomUUID() },
  ]) {
    await expect(
      readmitPiMemoryStage1CandidateFixture(args.runId, ownership),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "not_owned_chat_thread",
    });
  }
}

async function extractOwnedThreadPiMemory(actor: ApiTestUser, runId: string) {
  const scope = { orgId: requireOrgId(actor), userId: actor.userId };
  const candidate = await readPiMemoryStage1CandidateFixture(scope);
  if (!candidate) {
    throw new Error("Expected completed source admission");
  }
  await seedBuiltInModelKey("gpt-5.6-terra");
  const requests: unknown[] = [];
  server.use(
    http.post(
      "https://api.openai.com/v1/responses",
      async ({ request }) => {
        requests.push(await request.json());
        return new HttpResponse(
          piResponsesTextSse(
            JSON.stringify({
              raw_memory: "The owner prefers concise progress reports.",
              rollout_summary: "Learned the owner's reporting preference.",
              rollout_slug: "owned-reporting-preference",
            }),
            100,
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { once: true },
    ),
  );
  mockNow(candidate.eligibleAt.getTime() + 1000);
  const extracted = await accept(
    setupApp({
      context,
      // Scope the existing cron worker to this source; no production API
      // exposes internal candidate extraction or its private output.
      routes: cronExtractPiMemoryStage1RoutesForTest({
        memoryStorageId: candidate.memoryStorageId,
        piSessionId: candidate.piSessionId,
      }),
    })(cronExtractPiMemoryStage1Contract).extract({
      headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
    }),
    [200],
  );
  expect(extracted.body).toMatchObject({ claimed: 1, succeeded: 1 });
  expect(requests).toHaveLength(1);
  await expect(
    readPiMemoryStage1CandidateFixture(scope),
  ).resolves.toMatchObject({
    sourceRunId: runId,
    piSessionId: candidate.piSessionId,
    sourceHistoryHash: candidate.sourceHistoryHash,
    status: "succeeded",
    rawMemory: "The owner prefers concise progress reports.",
  });
}

function threadPiAutomationsClient(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return setupApp({
    context,
    routes: workflowAutomationsRoutes,
    usagePricingResolution,
  })(workflowAutomationsContract);
}

async function postThreadPiAutomationEvent(args: {
  readonly webhookUrl: string;
  readonly webhookSecret: string;
  readonly payload: string;
  readonly timestamp: number;
  readonly usagePricingResolution: UsagePricingFixture["resolution"];
}) {
  const rawBody = JSON.stringify({ event: args.payload });
  const timestamp = args.timestamp;
  const response = await createAppWithRoutes({
    signal: context.signal,
    routes: webhooksWorkflowAutomationsRoutes,
    usagePricingResolution: args.usagePricingResolution,
  }).request(new URL(args.webhookUrl).pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Okou-Timestamp": String(timestamp),
      "X-Okou-Signature": computeHmacSignature(
        rawBody,
        args.webhookSecret,
        timestamp,
      ),
    },
    body: rawBody,
  });
  expect(response.status).toBe(200);
  return z
    .object({ success: z.literal(true), duplicate: z.boolean() })
    .parse(await response.json());
}

async function lastThreadPiAutomationRun(actor: ApiTestUser, threadId: string) {
  const page = await chat.listThreadEvents(actor, threadId);
  const event = [...page.events].reverse().find((item) => {
    return (
      item.eventType === "input.prompt" &&
      item.userMessage.parts.some((part) => {
        return part.type === "automation";
      })
    );
  });
  if (event?.eventType !== "input.prompt" || !event.runId) {
    throw new Error("Expected an admitted Automation run");
  }
  return event.runId;
}

async function expectThreadPiTerminal(
  actor: ApiTestUser,
  threadId: string,
  runId: string,
) {
  await waitForRunStatus(actor, runId, "completed", 10_000);
  await flushWaitUntilForTest();
  await expect(
    readRunLaunchSnapshotFixture(context, runId),
  ).resolves.toMatchObject({
    launch_snapshot: { schemaVersion: 3, framework: "pi" },
  });
  const page = await chat.listThreadEvents(actor, threadId);
  expect(
    page.events
      .filter((event) => {
        return (
          event.runId === runId && isChatRunTerminalEventType(event.eventType)
        );
      })
      .map((event) => {
        return event.eventType;
      }),
  ).toStrictEqual(["run.completed"]);
}

describe("thread-bound Pi Automation and Goal execution", () => {
  it.each(["schedule", "event"] as const)(
    "rotates the %s Automation session into Pi and shares owned learning with user turns",
    async (source) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor(
        {},
        source === "event" ? "team" : "pro",
      );
      const orgId = requireOrgId(actor);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const workflows = createWorkflowsBddApi(context);
      const workflowId = await workflows.createWorkflow(actor, {
        agentId,
        name: `pi-source-${source}`,
      });
      if (source === "schedule") {
        await configureBuiltInPiModel(actor, "gpt-5.6-terra");
      }
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: false,
        },
      );
      const created = await accept(
        threadPiAutomationsClient().create({
          headers: sessionHeaders(actor),
          params: { workflowId },
          body:
            source === "schedule"
              ? { schedule: { type: "loop", intervalSeconds: 3600 } }
              : { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      );
      const automation = created.body;
      const eventRoute =
        automation.kind === "event" &&
        automation.eventType === "webhook-received" &&
        automation.webhookUrl &&
        automation.webhookSecret
          ? {
              webhookUrl: automation.webhookUrl,
              webhookSecret: automation.webhookSecret,
            }
          : null;
      let threadId: string;
      if (eventRoute) {
        await postThreadPiAutomationEvent({
          ...eventRoute,
          payload: "legacy",
          timestamp: Math.floor(now() / 1000),
          usagePricingResolution,
        });
        if (!automation.chatThreadId) {
          throw new Error("Expected the event thread");
        }
        threadId = automation.chatThreadId;
      } else {
        const started = await accept(
          threadPiAutomationsClient().run({
            headers: sessionHeaders(actor),
            params: { id: automation.id },
          }),
          [201],
        );
        threadId = started.body.chatThreadId;
      }
      const legacyRunId = await lastThreadPiAutomationRun(actor, threadId);
      const legacyClaim = await claimChatRun(runnerGroup, legacyRunId);
      const legacyFramework = source === "schedule" ? "codex" : "claude-code";
      await completeChatRunOk(legacyRunId, legacyClaim.sandboxHeaders, {
        cliAgentType: legacyFramework,
      });
      await flushWaitUntilForTest();
      const legacyBinding = await readThreadSessionBinding(context, threadId);
      await expect(
        readRunLaunchSnapshotFixture(context, legacyRunId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: legacyFramework },
      });
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toBeNull();

      await configureBuiltInPiModel(actor, "gpt-5.6-terra");
      await chat.updateThreadModelSelection(actor, threadId, "gpt-5.6-terra");
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
        },
      );
      mockEnv("PI_MEMORY_STAGE1_IDLE_DELAY_MS", 60_000);
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            requests.push(await request.json());
            return new HttpResponse(
              piResponsesTextSse(
                `owned ${source} answer ${requests.length}`,
                requests.length,
              ),
              {
                headers: { "content-type": "text/event-stream" },
              },
            );
          },
        ),
      );
      if (eventRoute) {
        const event = {
          ...eventRoute,
          payload: "pi-event",
          timestamp: Math.floor(now() / 1000),
          usagePricingResolution,
        };
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          {
            duplicate: false,
          },
        );
        // A retry keeps the original signed envelope across clock seconds.
        mockNow(now() + 1000);
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          {
            duplicate: true,
          },
        );
      } else {
        const scheduled = await workflows.readAutomation(automation.id);
        if (!scheduled.nextRunAt) {
          throw new Error("Expected preserved recurrence");
        }
        mockNow(Date.parse(scheduled.nextRunAt) + 1000);
        await accept(
          setupApp({
            context,
            routes: testWorkflowAutomationExecutionRoutes,
            usagePricingResolution,
          })(testWorkflowAutomationExecutionContract).execute({
            body: { automation_id: automation.id },
          }),
          [200],
        );
      }
      const piRunId = await lastThreadPiAutomationRun(actor, threadId);
      expect(piRunId).not.toBe(legacyRunId);
      // Workflow slash input intentionally enters native AgentSession in the
      // Sandbox. Exercise the real runner claim/checkpoint/completion protocol.
      await flushWaitUntilForTest();
      const piClaim = await claimChatRun(runnerGroup, piRunId);
      expect(piClaim.claim).toMatchObject({
        piModelConfig: { model: "gpt-5.6-terra" },
      });
      const sandboxUsage = {
        idempotencyKey: randomUUID(),
        kind: "model" as const,
        provider: "gpt-5.6-terra",
        category: "tokens.output",
        quantity: 3,
      };
      for (const _receipt of [1, 2]) {
        await webhooks.requestAgentUsageEvent(
          { runId: piRunId, events: [sandboxUsage] },
          piClaim.sandboxHeaders,
          [200],
          usagePricingResolution,
        );
      }
      await completeSandboxFirstPiRun({
        actor,
        run: { runId: piRunId, threadId },
        claim: piClaim,
        checkpointObjects,
        prompt: piClaim.claim.prompt,
        answer: `owned ${source} answer`,
        outputTokens: 3,
        usagePricingResolution,
      });
      await expectThreadPiTerminal(actor, threadId, piRunId);
      const piBinding = await readThreadSessionBinding(context, threadId);
      expect(piBinding.agent_session_id).not.toBe(
        legacyBinding.agent_session_id,
      );
      const piHistory = await readPiConversationIdentityFixture(piRunId);
      await expectExactPrivatePiMemoryAdmission({
        orgId,
        userId: actor.userId,
        runId: piRunId,
      });
      const runState = await runStateStore.set(
        readAgentRunState$,
        { orgId, userId: actor.userId, runId: piRunId },
        context.signal,
      );
      expect(runState.agent_run).toMatchObject({
        triggerSource: `automation-${source}`,
      });
      await expectPiApiUsage(piRunId, "gpt-5.6-terra", "", {
        input: 0,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      await accept(
        setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
          testWorkflowAutomationExecutionContract,
        ).dispatchCallbacks({
          body: { run_id: piRunId, status: "completed", dispatch_count: 2 },
        }),
        [200],
      );
      await expectThreadPiTerminal(actor, threadId, piRunId);
      expect(requests).toHaveLength(0);
      await extractOwnedThreadPiMemory(actor, piRunId);

      mockNow(now() + 1000);
      const user = await sendChatRun(
        actor,
        { agentId, threadId, prompt: "continue this Automation conversation" },
        usagePricingResolution,
      );
      await expectThreadPiTerminal(actor, threadId, user.runId);
      expect(
        (await readThreadSessionBinding(context, threadId)).agent_session_id,
      ).toBe(piBinding.agent_session_id);
      const userHistory = await readPiConversationIdentityFixture(user.runId);
      expect(userHistory.piSessionId).toBe(piHistory.piSessionId);
      expect(userHistory.sourceHistoryHash).not.toBe(
        piHistory.sourceHistoryHash,
      );
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toMatchObject({
        piSessionId: piHistory.piSessionId,
        sourceRunId: user.runId,
        sourceHistoryHash: userHistory.sourceHistoryHash,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ model: "gpt-5.6-terra" });
      await expectPiApiUsage(user.runId, "gpt-5.6-terra", "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      clearMockNow();
    },
    90_000,
  );
});

describe("CHAT-02: web chat send and client ids", () => {
  it("creates a web chat run with client-provided ids", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const clientThreadId = randomUUID();
    const clientEventId = randomUUID();
    const prompt = "hello from bdd web chat";
    const model = await chat.getDefaultCreateThreadModel(actor);
    const first = await accept(
      chatEventsClient().send({
        headers: sessionHeaders(actor),
        body: {
          agentId,
          prompt,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
          hasTextContent: true,
          clientThreadId,
          clientEventId,
          model,
        },
      }),
      [201],
    );
    if (first.status !== 201 || first.body.runId === null) {
      throw new Error("Expected the first chat send to create a run");
    }
    expect(first.body.threadId).toBe(clientThreadId);
    expect(first.body.status).toBe("pending");
    const runId = first.body.runId;
    const pendingBinding = await readThreadSessionBinding(
      context,
      clientThreadId,
    );
    expect(pendingBinding.agent_session_run_id).toBe(runId);
    expect(pendingBinding.agent_session_id).toMatch(/[0-9a-f-]{36}/);
    expect(pendingBinding.run_session_id).toBe(pendingBinding.agent_session_id);

    const run = await api.readRun(actor, runId);
    expect(run.prompt).toBe(prompt);
    expect(run.appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    expect(run.appendSystemPrompt).not.toContain("# Artifact Template Context");

    const messages = await waitForThreadMessages(
      actor,
      clientThreadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === clientEventId && message.runId === runId
          );
        });
      },
    );
    const userRows = userMessages(messages.events);
    expect(userRows).toHaveLength(2);
    expect(userRows).toContainEqual(
      expect.objectContaining({
        id: clientEventId,
        content: null,
      }),
    );
    expect(userRows).toContainEqual(
      expect.objectContaining({
        content: null,
        runId,
        revokesEventId: clientEventId,
      }),
    );
    const original = userRows.find((message) => {
      return message.id === clientEventId;
    });
    expect(original).toMatchObject({
      id: clientEventId,
      threadId: clientThreadId,
      eventType: "input.prompt",
      content: null,
    });
    expect(original?.runId).toBeUndefined();
    expect(original).not.toHaveProperty("revokesEventId");

    await expect(chat.readThread(actor, clientThreadId)).resolves.toStrictEqual(
      {
        lastReadAt: null,
        cancellationRecoveryPending: false,
      },
    );

    // A pre-created client thread with no runs cannot be sent into.
    const emptyClientThreadId = randomUUID();
    const created = await chat.createThread(actor, {
      agentId,
      title: "Pre-created client thread",
      clientThreadId: emptyClientThreadId,
    });
    expect(created.id).toBe(emptyClientThreadId);
    const emptyThreadSend = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "send into the pre-created thread",
        clientThreadId: emptyClientThreadId,
      },
      [400],
    );
    expectApiError(emptyThreadSend.body);
    expect(emptyThreadSend.body.error.message).toBe(
      "Client thread id is already in use",
    );
  }, 90_000);

  it("rejects unauthenticated, unknown-agent, and foreign private-agent sends", async () => {
    const unauthenticated = await chat.requestSendEvent(
      null,
      { agentId: randomUUID(), prompt: "hello" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Private chat-send guard agent",
      visibility: "private",
    });

    const unknownAgent = await chat.requestSendEvent(
      actor,
      { agentId: randomUUID(), prompt: "hello" },
      [404],
    );
    expectApiError(unknownAgent.body);
    expect(unknownAgent.body.error.code).toBe("NOT_FOUND");

    const peer = bdd.user({ orgId: actor.orgId });
    const forbidden = await chat.requestSendEvent(
      peer,
      { agentId: agent.agentId, prompt: "hello" },
      [403],
    );
    expectApiError(forbidden.body);
    expect(forbidden.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  }, 30_000);

  it("passes request-scoped network body capture into the runner claim", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const captured = await sendChatRun(actor, {
      agentId,
      prompt: "capture this run's network bodies",
      captureNetworkBodies: true,
    });
    const capturedClaim = await claimChatRun(runnerGroup, captured.runId);
    expect(capturedClaim.claim.captureNetworkBodies).toBeTruthy();
    await cancelChatRun(actor, captured.runId);

    const ordinary = await sendChatRun(actor, {
      agentId,
      prompt: "keep ordinary network logging metadata-only",
    });
    const ordinaryClaim = await claimChatRun(runnerGroup, ordinary.runId);
    expect(ordinaryClaim.claim.captureNetworkBodies).toBeUndefined();
    await cancelChatRun(actor, ordinary.runId);
  });
});

describe("CHAT-02: interrupting active chat runs", () => {
  it("interrupts an active run, guards interrupt ids, and feeds cancelled rounds into the next run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "long task to interrupt",
    });
    await api.heartbeatRunner(runnerGroup);
    const firstClaim = await api.claimRunnerJob(first.runId);
    context.mocks.ably.publish.mockClear();

    const interruptId = randomUUID();
    const interrupted = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientEventId: interruptId,
      },
      [201],
    );
    if (interrupted.status !== 201) {
      throw new Error("Expected the interrupt send to be accepted");
    }
    expect(interrupted.body.runId).toBeNull();
    await waitForRunStatus(actor, first.runId, "cancelled");
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: first.runId,
      mode: "cooperative",
    });
    await webhooks.requestAgentComplete(
      { runId: first.runId, exitCode: 1 },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return (
          userMessages(items).some((message) => {
            return (
              message.eventType === "control.interrupt" &&
              message.interruptsRunId === first.runId
            );
          }) &&
          assistantMessages(items).some((message) => {
            return (
              message.eventType === "run.cancelled" &&
              message.runId === first.runId &&
              message.runLifecycleEvent === "cancelled"
            );
          })
        );
      },
    );
    const interruptRows = userMessages(messages.events).filter((message) => {
      return (
        message.eventType === "control.interrupt" &&
        message.interruptsRunId === first.runId
      );
    });
    expect(interruptRows).toHaveLength(1);
    expect(interruptRows[0]).toMatchObject({ id: interruptId, content: null });
    expect(interruptRows[0]).not.toHaveProperty("runId");
    const [storedInterrupt] = await readCanonicalChatEventStorageFixture([
      interruptId,
    ]);
    expect(storedInterrupt).toMatchObject({
      payload: null,
      runId: first.runId,
    });
    expect(
      assistantMessages(messages.events).filter((message) => {
        return (
          message.eventType === "run.cancelled" &&
          message.runId === first.runId &&
          message.runLifecycleEvent === "cancelled"
        );
      }),
    ).toHaveLength(1);
    expect(
      assistantMessages(messages.events).filter((message) => {
        return (
          message.runId === first.runId &&
          isChatRunTerminalEventType(message.eventType)
        );
      }),
    ).toHaveLength(1);

    // Replaying the interrupt (same or fresh client id) stays idempotent.
    const replayedInterrupt = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientEventId: interruptId,
      },
      [201],
    );
    expect(replayedInterrupt.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: first.runId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    const afterReplays = await chat.listThreadEvents(actor, first.threadId);
    expect(
      userMessages(afterReplays.events).filter((message) => {
        return (
          message.eventType === "control.interrupt" &&
          message.interruptsRunId === first.runId
        );
      }),
    ).toHaveLength(1);

    // A run that went terminal without an interrupt row cannot be interrupted.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "cancelled through the cancel api",
    });
    await cancelChatRun(actor, second.runId);
    const lateInterrupt = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        interruptsRunId: second.runId,
        clientEventId: randomUUID(),
      },
      [400],
    );
    expectApiError(lateInterrupt.body);
    expect(lateInterrupt.body.error.message).toBe(
      "Only active chat runs can be interrupted",
    );

    // The interrupt's client message id is burned for normal sends.
    const reusedInterruptId = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "reuse the interrupt client id",
        clientEventId: interruptId,
      },
      [409],
    );
    expectApiError(reusedInterruptId.body);
    expect(reusedInterruptId.body.error.message).toBe(
      "clientEventId is already in use",
    );

    // Neither cancelled round saved native history, so the next run replays
    // both rounds in a fresh session.
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "resume after interruptions",
    });
    const thirdRun = await api.readRun(actor, third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain("RUN_STATUS: cancelled");
    expect(appended).toContain("User: long task to interrupt");
    expect(appended).toContain("User: cancelled through the cancel api");
    expect(appended).not.toContain("# Incomplete Rounds Context");
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT effort: thread configuration", () => {
  it("applies requested and saved native effort through the existing claim protocol", async () => {
    const { actor, agentId, providerId, runnerGroup } =
      await entitledChatActor();
    await api.updateOrgModelPolicies(
      actor,
      (["claude-sonnet-5", "claude-opus-4-8"] as const).map((model) => {
        return {
          model,
          isDefault: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        };
      }),
    );
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Saved effort",
    });
    await chat.updateThreadModelSelection(actor, thread.id, "claude-sonnet-5", {
      reasoningEffort: "high",
    });
    const saved = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Use saved effort",
    });
    const savedClaim = await claimChatRun(runnerGroup, saved.runId);
    expect(savedClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "high",
    );
    await cancelChatRun(actor, saved.runId, savedClaim.sandboxHeaders);

    const explicit = await sendChatRun(actor, {
      agentId,
      prompt: "New explicit effort",
      runOptions: { reasoningEffort: "extra" },
    });
    const explicitClaim = await claimChatRun(runnerGroup, explicit.runId);
    // Storage and dispatch retain the user's Claude name. The guest maps it.
    expect(explicitClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "extra",
    );
    await expect(
      chat.readThreadMetadata(actor, explicit.threadId),
    ).resolves.toMatchObject({
      modelSettings: { "claude-sonnet-5": { effort: "extra" } },
    });
    await cancelChatRun(actor, explicit.runId, explicitClaim.sandboxHeaders);

    const override = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Use another model's native default",
      model: "claude-opus-4-8",
    });
    const overrideClaim = await claimChatRun(runnerGroup, override.runId);
    expect(overrideClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "high",
    );
    // A run-level model override uses Opus's default without rewriting the
    // thread's persisted Sonnet selection or its saved effort.
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      selectedModel: "claude-sonnet-5",
      modelSettings: { "claude-sonnet-5": { effort: "high" } },
    });
    await cancelChatRun(actor, override.runId, overrideClaim.sandboxHeaders);
  }, 90_000);

  it("merges concurrent explicit effort writes without dropping another model", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    await api.updateOrgModelPolicies(
      actor,
      (["claude-sonnet-5", "claude-opus-4-8"] as const).map((model) => {
        return {
          model,
          isDefault: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key" as const,
          credentialScope: "org" as const,
          modelProviderId: providerId,
        };
      }),
    );
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Concurrent effort patches",
    });
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });

    const requests = [
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "Save Sonnet effort",
          model: "claude-sonnet-5",
          runOptions: { reasoningEffort: "extra" },
        },
        [201],
      ),
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "Save Opus effort",
          model: "claude-opus-4-8",
          runOptions: { reasoningEffort: "low" },
        },
        [201],
      ),
    ] as const;
    await expect.poll(threadLock.blockedWaiterCount).toBeGreaterThanOrEqual(2);
    threadLock.release();
    await threadLock.done;
    const responses = await Promise.all(requests);

    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      modelSettings: {
        "claude-sonnet-5": { effort: "extra" },
        "claude-opus-4-8": { effort: "low" },
      },
    });
    for (const response of responses) {
      if (response.status !== 201) {
        throw new Error("Expected both effort updates to be accepted");
      }
      if (response.body.runId) {
        await cancelChatRun(actor, response.body.runId);
      }
    }
  }, 90_000);

  it.each([
    {
      model: "gpt-5.6-sol",
      effort: "ultra",
      pi: true,
      providerType: "openai-api-key",
      effectiveEffort: "max",
    },
    {
      model: "deepseek-v4-flash",
      effort: "low",
      pi: true,
      providerType: "openrouter-codex",
      effectiveEffort: "high",
    },
    {
      model: "deepseek-v4-pro",
      effort: "max",
      pi: true,
      providerType: "openrouter-codex",
      effectiveEffort: "high",
    },
    {
      model: "claude-sonnet-5",
      effort: "ultracode",
      pi: false,
      providerType: "anthropic-api-key",
      effectiveEffort: "high",
    },
  ] as const)(
    "falls back from unavailable $model $effort without deleting the preference",
    async ({ model, effort, pi, providerType, effectiveEffort }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: providerType,
        secret: "test-native-effort-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: providerType,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.ChatReasoningEffort]: true,
        [FeatureSwitchKey.PiLoop]: pi,
      });
      if (pi) {
        mockPiCheckpointObjectStore();
      }
      const thread = await chat.createThread(actor, {
        agentId,
        title: "Unsupported effort route",
        model,
      });
      for (const saved of [false, true]) {
        if (saved) {
          await chat.updateThreadModelSelection(actor, thread.id, model, {
            reasoningEffort: effort,
          });
        }
        const sent = await sendChatRun(actor, {
          agentId,
          threadId: thread.id,
          prompt: pi
            ? "/unknown-command use the route fallback"
            : "Use the route fallback",
          ...(saved ? {} : { runOptions: { reasoningEffort: effort } }),
        });
        if (pi) {
          await flushWaitUntilForTest();
        }
        const claimed = await claimChatRun(runnerGroup, sent.runId);
        expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
          effectiveEffort,
        );
        if (pi) {
          expect(claimed.claim.piModelConfig).toMatchObject({
            thinkingLevel: effectiveEffort,
          });
        }
        await expect(
          chat.readThreadMetadata(actor, thread.id),
        ).resolves.toMatchObject({
          modelSettings: { [model]: { effort } },
        });
        await cancelChatRun(actor, sent.runId, claimed.sandboxHeaders);
      }
    },
    90_000,
  );

  it.each([
    {
      enabled: true,
      requestedEffort: "high",
      effectiveEffort: "high",
      pi: false,
    },
    {
      enabled: true,
      requestedEffort: "high",
      effectiveEffort: "high",
      pi: true,
    },
    {
      enabled: true,
      requestedEffort: "ultra",
      effectiveEffort: "max",
      pi: true,
    },
    {
      enabled: false,
      requestedEffort: "high",
      effectiveEffort: undefined,
      pi: false,
    },
    {
      enabled: true,
      requestedEffort: "ultracode",
      effectiveEffort: "high",
      pi: false,
    },
  ] as const)(
    "uses current thread settings when a queued message starts with rollout $enabled, Pi $pi and $requestedEffort effort",
    async ({ enabled, requestedEffort, effectiveEffort, pi }) => {
      const { actor, agentId, providerId, runnerGroup } =
        await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.ChatReasoningEffort]: true,
        [FeatureSwitchKey.PiLoop]: false,
      });
      const selectedModel = pi ? "gpt-5.6-sol" : "claude-opus-4-8";
      const targetProviderId = pi
        ? (
            await upsertOrgModelProvider(actor, {
              type: "openai-api-key",
              secret: "queued-pi-effort-key",
            })
          ).providerId
        : providerId;
      await api.updateOrgModelPolicies(actor, [
        {
          model: "claude-sonnet-5",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
        {
          model: selectedModel,
          isDefault: false,
          defaultProviderType: pi ? "openai-api-key" : "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: targetProviderId,
        },
      ]);
      const active = await sendChatRun(actor, {
        agentId,
        prompt: "Active task",
      });
      const activeClaim = await claimChatRun(runnerGroup, active.runId);
      await chat.updateThreadModelSelection(
        actor,
        active.threadId,
        "claude-sonnet-5",
        { reasoningEffort: "extra" },
      );
      const clientEventId = randomUUID();
      const prompt = pi
        ? "/unknown-command read the current thread settings at launch"
        : "Read the current thread settings at launch";
      const queued = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: active.threadId,
          prompt,
          clientEventId,
        },
        [201],
      );
      expect(queued.body).toMatchObject({ runId: null });
      await chat.updateThreadModelSelection(
        actor,
        active.threadId,
        selectedModel,
        { reasoningEffort: requestedEffort },
      );
      const retry = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: active.threadId,
          prompt,
          clientEventId,
          runOptions: { reasoningEffort: requestedEffort },
        },
        [201],
      );
      expect(retry.body).toStrictEqual(queued.body);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.ChatReasoningEffort]: enabled,
        [FeatureSwitchKey.PiLoop]: pi,
      });
      if (pi) {
        mockPiCheckpointObjectStore();
      }
      await cancelChatRun(actor, active.runId, activeClaim.sandboxHeaders);
      const messages = await waitForThreadMessages(
        actor,
        active.threadId,
        (items) => {
          return userMessages(items).some((message) => {
            return (
              message.revokesEventId === clientEventId &&
              typeof message.runId === "string"
            );
          });
        },
      );
      const promoted = userMessages(messages.events).find((message) => {
        return message.revokesEventId === clientEventId;
      });
      if (!promoted?.runId || promoted.eventType !== "input.prompt") {
        throw new Error("Expected queued input to launch");
      }
      expect(promoted.userMessage.parts).toContainEqual({
        type: "model",
        selectedModel,
      });
      if (pi) {
        await flushWaitUntilForTest();
      }
      const claimed = await claimChatRun(runnerGroup, promoted.runId);
      if (pi) {
        expect(claimed.claim.piModelConfig).toMatchObject({
          thinkingLevel: effectiveEffort,
        });
      }
      expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        effectiveEffort,
      );
      await expect(
        chat.readThreadMetadata(actor, active.threadId),
      ).resolves.toMatchObject({
        selectedModel,
        modelSettings: {
          "claude-sonnet-5": { effort: "extra" },
          [selectedModel]: { effort: requestedEffort },
        },
      });
      await cancelChatRun(actor, promoted.runId, claimed.sandboxHeaders);
    },
    90_000,
  );

  it("ignores saved effort while disabled without erasing it on normal or explicit-model sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Dormant effort preference",
    });
    await chat.updateThreadModelSelection(actor, thread.id, "claude-sonnet-5", {
      reasoningEffort: "high",
    });
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatReasoningEffort]: false,
    });
    for (const model of [undefined, "claude-sonnet-5"] as const) {
      const sent = await sendChatRun(actor, {
        agentId,
        threadId: thread.id,
        prompt: "Use native defaults while rollout is disabled",
        model,
      });
      const claimed = await claimChatRun(runnerGroup, sent.runId);
      expect(claimed.claim.platformEnvironment).not.toHaveProperty(
        "OKOU_REASONING_EFFORT",
      );
      await expect(
        chat.readThreadMetadata(actor, thread.id),
      ).resolves.toMatchObject({
        modelSettings: { "claude-sonnet-5": { effort: "high" } },
      });
      await cancelChatRun(actor, sent.runId, claimed.sandboxHeaders);
    }
    const disabledReset = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "Do not accept gated fields",
        runOptions: { reasoningEffort: "low" },
      },
      [400],
    );
    expect(disabledReset.body).toMatchObject({
      error: { message: "Reasoning effort selection is not enabled" },
    });
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    });
    const enabled = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Saved effort is active again",
    });
    const enabledClaim = await claimChatRun(runnerGroup, enabled.runId);
    expect(enabledClaim.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "high",
    );
    await cancelChatRun(actor, enabled.runId, enabledClaim.sandboxHeaders);
  }, 90_000);

  it("preserves Fast when changing effort", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
      [FeatureSwitchKey.CodexFastMode]: true,
    });
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openai-api-key",
      secret: "test-effort-openai-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-sol",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Independent Fast",
      model: "gpt-5.6-sol",
    });
    await chat.updateThreadModelSelection(actor, thread.id, "gpt-5.6-sol", {
      reasoningEffort: "low",
      codexServiceTier: "fast",
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      serviceTier: "priority",
    });
    const sent = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Fast with saved effort",
    });
    const claimed = await claimChatRun(runnerGroup, sent.runId);
    expect(claimed.claim.platformEnvironment.OKOU_CODEX_SERVICE_TIER).toBe(
      "fast",
    );
    expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe("low");
    await cancelChatRun(actor, sent.runId, claimed.sandboxHeaders);
    const explicit = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Change effort and retain Fast",
      runOptions: { reasoningEffort: "ultra" },
    });
    const explicitClaim = await claimChatRun(runnerGroup, explicit.runId);
    expect(explicitClaim.claim.platformEnvironment).toMatchObject({
      OKOU_CODEX_SERVICE_TIER: "fast",
      OKOU_REASONING_EFFORT: "ultra",
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      modelSettings: { "gpt-5.6-sol": { effort: "ultra" } },
      serviceTier: "priority",
    });
    await cancelChatRun(actor, explicit.runId, explicitClaim.sandboxHeaders);
  }, 90_000);
});

describe("CHAT effort: automation launches", () => {
  async function startAutomation() {
    const scenario = await entitledChatActor({}, "pro");
    const { actor, agentId, runnerGroup } = scenario;
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.ChatReasoningEffort]: true,
      [FeatureSwitchKey.PiLoop]: false,
    });
    const workflowId = await createWorkflowsBddApi(context).createWorkflow(
      actor,
      { agentId, name: "native-effort" },
    );
    const created = await accept(
      threadPiAutomationsClient().create({
        headers: sessionHeaders(actor),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    const started = await accept(
      threadPiAutomationsClient().run({
        headers: sessionHeaders(actor),
        params: { id: created.body.id },
      }),
      [201],
    );
    const threadId = started.body.chatThreadId;
    const runId = await lastThreadPiAutomationRun(actor, threadId);
    const claimed = await claimChatRun(runnerGroup, runId);
    expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
      "high",
    );
    return {
      ...scenario,
      threadId,
      runId,
      claimed,
      automationId: created.body.id,
    };
  }

  it.each([true, false])(
    "uses the latest thread effort and rollout state for a queued automation (enabled=%s)",
    async (enabled) => {
      const { actor, runnerGroup, threadId, runId, claimed, automationId } =
        await startAutomation();
      await chat.updateThreadModelSelection(
        actor,
        threadId,
        "claude-sonnet-5",
        {
          reasoningEffort: "extra",
        },
      );
      const queued = await accept(
        threadPiAutomationsClient().run({
          headers: sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      expect(queued.body.runId).toBeNull();
      await chat.updateThreadModelSelection(
        actor,
        threadId,
        "claude-sonnet-5",
        {
          reasoningEffort: "high",
        },
      );
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.ChatReasoningEffort]: enabled,
      });
      await completeChatRunOk(runId, claimed.sandboxHeaders, {
        cliAgentType: "claude-code",
      });
      await flushWaitUntilForTest();
      const nextRunId = await lastThreadPiAutomationRun(actor, threadId);
      expect(nextRunId).not.toBe(runId);
      const next = await claimChatRun(runnerGroup, nextRunId);
      expect(next.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        enabled ? "high" : undefined,
      );
      await expect(
        chat.readThreadMetadata(actor, threadId),
      ).resolves.toMatchObject({
        modelSettings: { "claude-sonnet-5": { effort: "high" } },
      });
      await cancelChatRun(actor, nextRunId, next.sandboxHeaders);
    },
    90_000,
  );

  it("uses route defaults for unsupported effort at automation launch", async () => {
    const { actor, runnerGroup, threadId, runId, claimed, automationId } =
      await startAutomation();
    await completeChatRunOk(runId, claimed.sandboxHeaders, {
      cliAgentType: "claude-code",
    });
    await flushWaitUntilForTest();
    for (const route of [
      {
        model: "claude-sonnet-5",
        effort: "ultracode",
        pi: false,
        providerType: "anthropic-api-key",
        effectiveEffort: "high",
      },
      {
        model: "gpt-5.6-sol",
        effort: "high",
        pi: true,
        providerType: "openai-api-key",
        effectiveEffort: "high",
      },
    ] as const) {
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: route.providerType,
        secret: "test-workflow-effort-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model: route.model,
          isDefault: true,
          defaultProviderType: route.providerType,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: route.pi,
      });
      await chat.updateThreadModelSelection(actor, threadId, route.model, {
        reasoningEffort: route.effort,
      });
      if (route.pi) {
        mockPiCheckpointObjectStore();
      }
      const started = await accept(
        threadPiAutomationsClient().run({
          headers: sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      if (!started.body.runId) {
        throw new Error("Expected an automation run");
      }
      if (route.pi) {
        await flushWaitUntilForTest();
      }
      const next = await claimChatRun(runnerGroup, started.body.runId);
      expect(next.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        route.effectiveEffort,
      );
      if (route.pi) {
        expect(next.claim.piModelConfig).toMatchObject({
          thinkingLevel: route.effectiveEffort,
        });
      }
      await expect(
        chat.readThreadMetadata(actor, threadId),
      ).resolves.toMatchObject({
        modelSettings: { [route.model]: { effort: route.effort } },
      });
      await cancelChatRun(actor, started.body.runId, next.sandboxHeaders);
    }
  }, 90_000);
});

describe("CHAT-02: queueing and recalling messages", () => {
  it("returns an empty active-input poll without waiting for the thread row", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "keep the empty active-input poll observational",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: active.threadId,
      signal: context.signal,
    });
    let reserveSettled = false;
    const reserveOutcome = api
      .reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId)
      .then(
        (value) => {
          reserveSettled = true;
          return { ok: true as const, value };
        },
        (error: unknown) => {
          reserveSettled = true;
          return { ok: false as const, error };
        },
      );
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
      await reserveOutcome;
    });

    await expect
      .poll(() => {
        return reserveSettled;
      })
      .toBeTruthy();
    const outcome = await reserveOutcome;
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(outcome.value).toStrictEqual({ outcome: "empty" });
    await expect(threadLock.blockedWaiterCount()).resolves.toBe(0);

    threadLock.release();
    await threadLock.done;
    await cancelChatRun(actor, active.runId);
  }, 30_000);

  it("reserves rich inputs one at a time and settles concurrent receipts once", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "anchor durable active input delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const firstEventId = randomUUID();
    const secondEventId = randomUUID();
    const fileId = randomUUID();
    chat.mockCompletedUploadObject(actor, fileId, "delivery-notes.txt", 23);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "first durable steer",
        clientEventId: firstEventId,
      },
      [201],
    );
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "second durable steer",
        clientEventId: secondEventId,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "additional_info",
              text: "Create a video.\nDuration: 6s.",
            },
            {
              type: "file",
              fileId,
              filenameSnapshot: "delivery-notes.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "second durable steer" },
          ],
        },
      },
      [201],
    );

    const reservations = await Promise.all([
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ]);
    const [firstReservation, concurrentReservation] = reservations;
    if (
      firstReservation.outcome !== "reserved" ||
      concurrentReservation.outcome !== "reserved"
    ) {
      throw new Error("Expected both concurrent reservations to succeed");
    }
    expect(concurrentReservation).toStrictEqual(firstReservation);
    expect(firstReservation.eventIds).toStrictEqual([firstEventId]);
    expect(firstReservation.prompt).toBe("first durable steer");

    // Model a lost first response: retry must retrieve the same durable delivery.
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual(firstReservation);

    context.mocks.ably.publish.mockClear();
    const receipts = await Promise.all([
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
    ]);
    expect(receipts).toStrictEqual([
      { outcome: "delivered" },
      { outcome: "delivered" },
    ]);
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("active-input", {
      runId: active.runId,
    });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === "active-input";
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        firstReservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(1);

    const secondReservation = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (secondReservation.outcome !== "reserved") {
      throw new Error("Expected the second input to be reserved");
    }
    expect(secondReservation.deliveryId).not.toBe(firstReservation.deliveryId);
    expect(secondReservation.eventIds).toStrictEqual([secondEventId]);
    expect(secondReservation.prompt).toBe(
      [
        "Create a video.\nDuration: 6s.",
        `[Web file] delivery-notes.txt (text/plain)\n   [ID] ${fileId}`,
        "second durable steer",
      ].join("\n\n"),
    );
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        secondReservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    expect(
      context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === `chatThreadMessageCreated:${active.threadId}`;
      }),
    ).toHaveLength(2);
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ outcome: "empty" });
    const events = await chat.listThreadEvents(actor, active.threadId);
    const replacements = events.events.filter((event) => {
      return (
        event.runId === active.runId &&
        (event.revokesEventId === firstEventId ||
          event.revokesEventId === secondEventId)
      );
    });
    expect(
      replacements.map((event) => {
        return event.revokesEventId;
      }),
    ).toStrictEqual([firstEventId, secondEventId]);
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("finalizes delivered input from completion receipts exactly once", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "complete a durable delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "accepted before completion",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected completion input to be reserved");
    }

    const history = `bdd chat session history ${active.runId}`;
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const completion = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 0,
        activeInputDeliveryIds: [reserved.deliveryId],
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-cli-${active.runId}`,
          cliAgentSessionHistoryHash: createHash("sha256")
            .update(history)
            .digest("hex"),
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completion).toMatchObject({
      body: { success: true, status: "completed" },
    });
    await flushWaitUntilForTest();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const duplicate = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "late fallback completion",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(duplicate.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await flushWaitUntilForTest();

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
  }, 90_000);

  it("settles delivered input with the terminal run transition", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "complete with a durable delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "settle with the terminal transition",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected terminal input to be reserved");
    }

    const history = `bdd combined delivery history ${active.runId}`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const completed = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 0,
        activeInputDeliveryIds: [reserved.deliveryId],
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-combined-delivery-${active.runId}`,
          cliAgentSessionHistoryHash: historyHash,
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completed.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await flushWaitUntilForTest();

    expect((await api.readRun(actor, active.runId)).status).toBe("completed");
    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
  }, 90_000);

  it("finalizes a late receipt without replaying terminal callbacks", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "leave a terminal delivery open",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const pendingEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "finalize after the terminal transition",
        clientEventId: pendingEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected late completion input to be reserved");
    }
    await completeRunWithoutCallbacksFixture({ runId: active.runId });

    const completed = await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "duplicate fallback",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completed.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await flushWaitUntilForTest();

    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.revokesEventId === pendingEventId &&
          event.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
  }, 90_000);

  it("releases prompts and expires budget input before draining in FIFO order", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "finalize an unconfirmed delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const releasedEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "released queue head",
        clientEventId: releasedEventId,
      },
      [201],
    );
    await steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS);
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected the released prompt to be reserved");
    }
    expect(reserved.eventIds).toStrictEqual([releasedEventId]);
    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "later queue input",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected later input to remain queued");
    }
    expect(later.body.runId).toBeNull();

    await completeChatRunOk(active.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "rejected" });

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === releasedEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === releasedEventId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the released queue head to be promoted");
    }
    expect(
      messages.events.filter((event) => {
        return (
          event.eventType === "control.revoke" &&
          event.runId === active.runId &&
          event.revokesEventId !== releasedEventId
        );
      }),
    ).toHaveLength(1);
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);

    const successorClaim = await claimChatRun(runnerGroup, promoted.runId);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: laterEventId,
      },
      [201],
    );
    await cancelChatRun(actor, promoted.runId, successorClaim.sandboxHeaders);
  }, 90_000);

  it("keeps cancelled deliveries as barriers after recovery expiry", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "cancel with a held delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "accepted before cancellation",
        clientEventId: heldEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected cancelled input to be reserved");
    }
    await api.requestCancelRun(actor, active.runId, [200]);
    await waitForRunStatus(actor, active.runId, "cancelled");

    mockNow(now() + CANCELLATION_RECOVERY_STALE_AFTER_MS + 1);
    onTestFinished(() => {
      clearMockNow();
    });
    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "wait behind stale cancellation recovery",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected post-cancellation input to remain queued");
    }
    expect(later.body.runId).toBeNull();
    const beforeCompletion = await chat.listThreadEvents(
      actor,
      active.threadId,
    );
    expect(
      userMessages(beforeCompletion.events).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);

    await webhooks.requestAgentComplete(
      {
        runId: active.runId,
        exitCode: 1,
        error: "Run cancelled",
        activeInputDeliveryIds: [reserved.deliveryId],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    clearMockNow();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === laterEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const successor = userMessages(messages.events).find((message) => {
      return message.revokesEventId === laterEventId;
    })?.runId;
    if (!successor) {
      throw new Error("Expected the post-cancellation input to start a run");
    }
    expect(
      userMessages(messages.events).filter((message) => {
        return (
          message.revokesEventId === heldEventId &&
          message.runId === active.runId
        );
      }),
    ).toHaveLength(1);
    const successorClaim = await claimChatRun(runnerGroup, successor);
    await cancelChatRun(actor, successor, successorClaim.sandboxHeaders);
  }, 90_000);

  it("settles timed-out delivery input when stopping the Runner fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped chat actor");
    }

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "time out with an uncertain delivery",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "release only after teardown completion",
        clientEventId: heldEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected timeout input to be reserved");
    }
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValueOnce(
      new DOMException("timeout cancel unavailable", "AbortError"),
    );
    mockNow(now() + 3 * 60 * 1000);
    onTestFinished(() => {
      clearMockNow();
    });
    const cleanup = await cleanupTimedOutRun(context, {
      runId: active.runId,
      chatThreadId: active.threadId,
      orgId: actor.orgId,
    });
    expect(cleanup.body).toMatchObject({ cleaned: 1, errors: 0 });
    await waitForRunStatus(actor, active.runId, "timeout");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: active.runId,
      mode: "hard",
    });
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "rejected" });

    const messages = await waitForThreadMessages(
      actor,
      active.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === heldEventId &&
            typeof message.runId === "string" &&
            message.runId !== active.runId
          );
        });
      },
    );
    const successor = userMessages(messages.events).find((message) => {
      return message.revokesEventId === heldEventId;
    })?.runId;
    if (!successor) {
      throw new Error("Expected timed-out delivery input to be released");
    }

    const laterEventId = randomUUID();
    const later = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "wait behind the timeout successor",
        clientEventId: laterEventId,
      },
      [201],
    );
    if (later.status !== 201) {
      throw new Error("Expected post-timeout input to remain queued");
    }
    expect(later.body.runId).toBeNull();
    expect(
      userMessages(
        (await chat.listThreadEvents(actor, active.threadId)).events,
      ).filter((message) => {
        return message.revokesEventId === laterEventId;
      }),
    ).toHaveLength(0);
    const successorClaim = await claimChatRun(runnerGroup, successor);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: laterEventId,
      },
      [201],
    );
    await cancelChatRun(actor, successor, successorClaim.sandboxHeaders);
  }, 90_000);

  it("cascades delivery state when its thread is deleted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "delete a thread with reserved input",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "delete this reserved input",
        clientEventId: randomUUID(),
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected deleted thread input to be reserved");
    }

    await chat.deleteThread(actor, active.threadId);
    const missingDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${claimed.claim.sandboxToken}`,
      active.runId,
      reserved.deliveryId,
      [403],
    );
    expectApiError(missingDelivery.body);
    expect(missingDelivery.body.error.code).toBe("FORBIDDEN");
    await failChatRun(
      active.runId,
      claimed.sandboxHeaders,
      "Thread deleted during execution",
    );
    await flushWaitUntilForTest();

    const unrelated = await sendChatRun(actor, {
      agentId,
      prompt: "run after deleting another delivery thread",
    });
    const unrelatedClaim = await claimChatRun(runnerGroup, unrelated.runId);
    await cancelChatRun(actor, unrelated.runId, unrelatedClaim.sandboxHeaders);
  }, 90_000);

  it("classifies delivery lifecycle and authorization without route-level 404", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const emptyRun = await sendChatRun(actor, {
      agentId,
      prompt: "empty durable delivery",
    });
    const preclaimSandboxToken = api.sandboxTokenForRun(actor, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(preclaimSandboxToken, emptyRun.runId),
    ).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "run_not_running",
    });
    const emptyClaim = await claimChatRun(runnerGroup, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        emptyClaim.claim.sandboxToken,
        emptyRun.runId,
      ),
    ).resolves.toStrictEqual({ outcome: "empty" });
    const missingAuth = await api.requestReserveRunnerActiveInputsAs(
      undefined,
      emptyRun.runId,
      [401],
    );
    expectApiError(missingAuth.body);
    const cli = await api.createCliToken(actor);
    const wrongCredential = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${cli.token}`,
      emptyRun.runId,
      [403],
    );
    expectApiError(wrongCredential.body);

    const peer = bdd.user();
    const wrongTenantToken = api.sandboxTokenForRun(peer, emptyRun.runId);
    const wrongTenant = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${wrongTenantToken}`,
      emptyRun.runId,
      [403],
    );
    expectApiError(wrongTenant.body);
    const randomDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      emptyRun.runId,
      randomUUID(),
      [403],
    );
    expectApiError(randomDelivery.body);

    await cancelChatRun(actor, emptyRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        emptyClaim.claim.sandboxToken,
        emptyRun.runId,
      ),
    ).resolves.toStrictEqual({ outcome: "terminal" });

    const heldRun = await sendChatRun(actor, {
      agentId,
      prompt: "hold durable delivery after termination",
    });
    const heldClaim = await claimChatRun(runnerGroup, heldRun.runId);
    const heldEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: heldRun.threadId,
        prompt: "remain held",
        clientEventId: heldEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      heldClaim.claim.sandboxToken,
      heldRun.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected an active-input delivery reservation");
    }
    const wrongRun = await api.requestReserveRunnerActiveInputsAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      heldRun.runId,
      [403],
    );
    expectApiError(wrongRun.body);
    const crossDelivery = await api.requestRecordRunnerActiveInputDeliveryAs(
      `Bearer ${emptyClaim.claim.sandboxToken}`,
      emptyRun.runId,
      reserved.deliveryId,
      [403],
    );
    expectApiError(crossDelivery.body);

    await cancelChatRun(actor, heldRun.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        heldClaim.claim.sandboxToken,
        heldRun.runId,
      ),
    ).resolves.toStrictEqual({
      outcome: "held",
      deliveryId: reserved.deliveryId,
      eventIds: [heldEventId],
    });
  }, 90_000);

  it("applies the delivery-aware payload limit without consuming rejection", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "validate durable delivery payload limit",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const emptyDeliveryPayloadBytes = Buffer.byteLength(
      JSON.stringify({
        type: "active-input",
        deliveryId: randomUUID(),
        text: "",
      }),
      "utf8",
    );
    const exactEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "x".repeat(
          ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - emptyDeliveryPayloadBytes,
        ),
        clientEventId: exactEventId,
      },
      [201],
    );
    const exact = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (exact.outcome !== "reserved") {
      throw new Error("Expected exact-limit delivery to be reserved");
    }
    expect(
      Buffer.byteLength(
        JSON.stringify({
          type: "active-input",
          deliveryId: exact.deliveryId,
          text: exact.prompt,
        }),
        "utf8",
      ),
    ).toBe(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES);
    await api.recordRunnerActiveInputDelivery(
      claimed.claim.sandboxToken,
      active.runId,
      exact.deliveryId,
    );

    const oversizedEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        prompt: "x".repeat(
          ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES -
            emptyDeliveryPayloadBytes +
            1,
        ),
        clientEventId: oversizedEventId,
      },
      [201],
    );
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "payload_too_large",
    });
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: active.threadId,
        revokesEventId: oversizedEventId,
      },
      [201],
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("reserves and settles a run-scoped budget input", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "reserve the time budget warning",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 1 });
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected the budget input to be reserved");
    }
    expect(reserved.prompt).toBe(RUN_TIME_BUDGET_MESSAGE);
    expect(reserved.eventIds).toHaveLength(1);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ outcome: "empty" });
    const events = await chat.listThreadEvents(actor, active.threadId);
    expect(events.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.budget",
        runId: active.runId,
        revokesEventId: reserved.eventIds[0],
      }),
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("steers a run once when it reaches its time budget", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const active = await sendChatRun(actor, {
      agentId,
      prompt: "run until the time budget warning",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);

    await expect(
      steerOwnedRunAtElapsedTime(
        active.runId,
        RUN_TIME_BUDGET_STEER_AT_MS - 60_000,
      ),
    ).resolves.toStrictEqual({ scanned: 0, steered: 0 });
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ outcome: "empty" });

    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 1 });
    const budgetReservation = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      active.runId,
    );
    if (budgetReservation.outcome !== "reserved") {
      throw new Error("Expected the run time budget input to be reserved");
    }
    expect(budgetReservation.eventIds).toHaveLength(1);
    expect(budgetReservation.prompt).toBe(RUN_TIME_BUDGET_MESSAGE);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        active.runId,
        budgetReservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const publicEvents = await chat.listThreadEvents(actor, active.threadId);
    const budgetEvent = publicEvents.events.find((event) => {
      return (
        event.eventType === "input.budget" &&
        event.runId === active.runId &&
        chatEventDisplayText(event) === RUN_TIME_BUDGET_MESSAGE
      );
    });
    if (!budgetEvent || budgetEvent.eventType !== "input.budget") {
      throw new Error("Expected the run time budget input to be claimed");
    }
    expect(
      budgetEvent.userMessage.parts.some((part) => {
        return part.type === "model";
      }),
    ).toBeFalsy();

    await expect(
      steerOwnedRunAtElapsedTime(active.runId, RUN_TIME_BUDGET_STEER_AT_MS),
    ).resolves.toStrictEqual({ scanned: 1, steered: 0 });
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({ outcome: "empty" });

    await cancelChatRun(actor, active.runId);
  }, 90_000);

  it("does not carry an undelivered time budget input into a later run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "leave the budget input unclaimed",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await steerOwnedRunAtElapsedTime(first.runId, RUN_TIME_BUDGET_STEER_AT_MS);
    const firstBudget = await api.reserveRunnerActiveInputs(
      firstClaim.claim.sandboxToken,
      first.runId,
    );
    expect(firstBudget).toMatchObject({
      outcome: "reserved",
      prompt: RUN_TIME_BUDGET_MESSAGE,
    });

    await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "start a later run",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    await expect(
      api.reserveRunnerActiveInputs(
        secondClaim.claim.sandboxToken,
        second.runId,
      ),
    ).resolves.toStrictEqual({ outcome: "empty" });
    await cancelChatRun(actor, second.runId, secondClaim.sandboxHeaders);
  }, 90_000);

  it("queues, retries, and recalls messages behind an active run", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "anchor active run",
    });

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientEventId: queuedId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued send to be accepted");
    }
    expect(queued.body.runId).toBeNull();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const queuedRetry = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "queued behind the active run",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queuedRetry.body).toStrictEqual(queued.body);
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-opus-4-8",
    );

    // Another user's send cannot claim the queued message's client id.
    const { actor: stranger, agentId: strangerAgentId } =
      await entitledChatActor();
    const strangerThread = await chat.createThread(stranger, {
      agentId: strangerAgentId,
      title: "Cross-user conflict thread",
    });
    const crossUser = await chat.requestSendEvent(
      stranger,
      {
        agentId: strangerAgentId,
        threadId: strangerThread.id,
        prompt: "cross-user retry",
        clientEventId: queuedId,
      },
      [409],
    );
    expectApiError(crossUser.body);
    expect(crossUser.body.error.message).toBe(
      "clientEventId is already in use",
    );
    const strangerMessages = await chat.listThreadEvents(
      stranger,
      strangerThread.id,
    );
    expect(strangerMessages.events).toStrictEqual([]);

    const strangerRun = await sendChatRun(stranger, {
      agentId: strangerAgentId,
      threadId: strangerThread.id,
      prompt: "first accepted event after the rejected id",
    });
    await cancelChatRun(stranger, strangerRun.runId);

    const beforeRecall = await chat.listThreadEvents(actor, first.threadId);
    expect(
      userMessages(beforeRecall.events).filter((message) => {
        return message.id === queuedId;
      }),
    ).toHaveLength(1);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: queuedId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected the recall send to be accepted");
    }
    expect(recalled.body.runId).toBeNull();

    const repeatedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: queuedId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({
      runId: null,
      threadId: first.threadId,
    });
    const afterRepeated = await chat.listThreadEvents(actor, first.threadId);

    // Run-associated messages cannot be recalled.
    const associated = userMessages(afterRepeated.events).find((message) => {
      return message.runId === first.runId;
    });
    if (!associated) {
      throw new Error("Expected the active run's user message to be listed");
    }
    const rejectedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        revokesEventId: associated.id,
        clientEventId: randomUUID(),
      },
      [400],
    );
    expectApiError(rejectedRecall.body);
    expect(rejectedRecall.body.error.message).toBe(
      "Only queued user messages can be recalled",
    );

    await cancelChatRun(actor, first.runId);
    expect((await api.readRun(actor, first.runId)).status).toBe("cancelled");
  }, 90_000);

  it("keeps a gap after concurrent idempotent sends reserve the same event", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Concurrent idempotent send thread",
    });
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });

    const clientEventId = randomUUID();
    const sendEvent = () => {
      return chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "send once through two concurrent requests",
          clientEventId,
        },
        [201],
      );
    };
    const sends = [sendEvent(), sendEvent()];
    await expect.poll(threadLock.blockedWaiterCount).toBeGreaterThanOrEqual(2);
    threadLock.release();
    await threadLock.done;

    const responses = await Promise.all(sends);
    const runIds = new Set<string>();
    for (const response of responses) {
      if (response.status !== 201) {
        throw new Error("Expected both concurrent sends to be accepted");
      }
      if (response.body.runId !== null) {
        runIds.add(response.body.runId);
      }
    }
    expect(runIds.size).toBe(1);

    const messages = await chat.listThreadEvents(actor, thread.id);
    const seqIds = messages.events.map((event) => {
      return event.seqId;
    });
    expect(
      seqIds.some((seqId, index) => {
        const previousSeqId = seqIds[index - 1];
        return previousSeqId !== undefined && seqId > previousSeqId + 1;
      }),
    ).toBeTruthy();

    for (const runId of runIds) {
      await cancelChatRun(actor, runId);
    }
  }, 90_000);

  it("keeps a queued message when recall targets another owned thread", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "cross-thread recall anchor",
    });
    const queuedMessageId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "must remain queued in the original thread",
        clientEventId: queuedMessageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const otherThread = await chat.createThread(actor, {
      agentId,
      title: "Cross-thread recall target",
    });
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: otherThread.id,
        revokesEventId: queuedMessageId,
        clientEventId: randomUUID(),
      },
      [201, 400],
    );

    await cancelChatRun(actor, anchor.runId);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the original queued message to create a run");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe(
      "must remain queued in the original thread",
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});

describe("CHAT-02: org queue markers", () => {
  it("marks queued chat runs and revokes the marker on dequeue", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const blocker = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "occupy org concurrency" },
      [201],
    );
    if (blocker.status !== 201 || blocker.body.runId === null) {
      throw new Error("Expected the blocking send to create a run");
    }
    expect(blocker.body.status).toBe("pending");

    const queuedRun = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "wait behind the active run" },
      [201],
    );
    if (queuedRun.status !== 201 || queuedRun.body.runId === null) {
      throw new Error("Expected the second send to create a queued run");
    }
    expect(queuedRun.body.status).toBe("queued");
    const queuedBinding = await readThreadSessionBinding(
      context,
      queuedRun.body.threadId,
    );
    expect(queuedBinding.agent_session_run_id).toBe(queuedRun.body.runId);
    expect(queuedBinding.agent_session_id).toMatch(/[0-9a-f-]{36}/);
    expect(queuedBinding.run_session_id).toBe(queuedBinding.agent_session_id);

    const queuedThread = queuedRun.body.threadId;
    const beforeDequeue = await waitForThreadMessages(
      actor,
      queuedThread,
      (items) => {
        return (
          userMessages(items).some((message) => {
            return message.runId === queuedRun.body.runId;
          }) &&
          assistantMessages(items).some((message) => {
            return message.runEventId === "queue:queued";
          })
        );
      },
    );
    const queuedRunUserRows = userMessages(beforeDequeue.events);
    expect(queuedRunUserRows).toHaveLength(2);
    const queuedRunMessage = queuedRunUserRows.find((message) => {
      return message.runId === queuedRun.body.runId;
    });
    expect(queuedRunMessage).toMatchObject({
      content: null,
      runId: queuedRun.body.runId,
    });
    expect(chatEventDisplayText(queuedRunMessage!)).toBe(
      "wait behind the active run",
    );
    expect(queuedRunMessage?.revokesEventId).toBeDefined();
    const queuedRunOriginal = queuedRunUserRows.find((message) => {
      return message.id === queuedRunMessage?.revokesEventId;
    });
    expect(queuedRunOriginal?.content).toBeNull();
    expect(chatEventDisplayText(queuedRunOriginal!)).toBe(
      "wait behind the active run",
    );
    expect(queuedRunOriginal?.runId).toBeUndefined();
    const marker = assistantMessages(beforeDequeue.events).find((message) => {
      return message.runEventId === "queue:queued";
    });
    if (!marker) {
      throw new Error("Expected an assistant queue marker");
    }
    expect(marker).toMatchObject({
      content: "Waiting in queue...",
      runId: queuedRun.body.runId,
    });

    // The queued run still counts as the thread's active run, so a presentation
    // runbook selection queues as an unassociated message carrying that
    // selection.
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "presentation",
      selection: {
        templateId: template.templateId,
      },
    };
    const templateMessageId = randomUUID();
    const queuedTemplate = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: queuedThread,
        prompt: "template queued deck",
        userMessage: userMessageWithTemplate(
          "template queued deck",
          generationTemplate,
        ),
        clientEventId: templateMessageId,
      },
      [201],
    );
    expect(queuedTemplate.body).toMatchObject({ runId: null });
    const withTemplate = await chat.listThreadEvents(actor, queuedThread);
    const templateMessage = userMessages(withTemplate.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.id === templateMessageId
        );
      },
    );
    expect(templateMessage?.userMessage?.parts).toContainEqual(
      expect.objectContaining({
        type: "template",
        template: generationTemplate,
      }),
    );

    const queueBefore = await api.readRunQueue(actor);
    expect(queueBefore.body.queue).toHaveLength(1);
    expect(queueBefore.body.queue[0]).toMatchObject({
      runId: queuedRun.body.runId,
    });

    // Recall the queued template message so the dequeue does not auto-send it.
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: queuedThread,
        revokesEventId: templateMessageId,
        clientEventId: randomUUID(),
      },
      [201],
    );

    // Interrupting the blocking run drains the org queue and revokes the
    // queue marker on the dequeued run's thread.
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: blocker.body.threadId,
        interruptsRunId: blocker.body.runId,
        clientEventId: randomUUID(),
      },
      [201],
    );

    await waitForRunStatus(actor, blocker.body.runId, "cancelled");
    await waitForRunStatus(actor, queuedRun.body.runId, "pending");
    const afterDequeue = await waitForThreadMessages(
      actor,
      queuedThread,
      (items) => {
        return assistantMessages(items).some((message) => {
          return message.runEventId === "queue:dequeued";
        });
      },
    );
    const revoker = assistantMessages(afterDequeue.events).find((message) => {
      return message.runEventId === "queue:dequeued";
    });
    if (!revoker) {
      throw new Error("Expected an assistant queue-dequeued revoker");
    }
    expect(revoker).toMatchObject({
      content: null,
      runId: queuedRun.body.runId,
      revokesEventId: marker.id,
    });
    const queueAfter = await api.readRunQueue(actor);
    expect(queueAfter.body.queue).toHaveLength(0);

    await cancelChatRun(actor, queuedRun.body.runId);
    expect((await api.readRun(actor, queuedRun.body.runId)).status).toBe(
      "cancelled",
    );
  }, 90_000);
});

describe("CHAT-02: dispatch failure", () => {
  it("fails the run and delivers the terminal chat callback when dispatch cannot start", async () => {
    const { actor, agentId } = await entitledChatActor();
    const routeRequests = chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
    const messageId = randomUUID();

    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "fail before worker start",
        clientEventId: messageId,
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the failed dispatch to still create a run");
    }
    expect(sent.body.status).toBe("failed");
    await flushWaitUntilForTest();

    const run = await api.readRun(actor, sent.body.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("RUNNER_DEFAULT_GROUP");
    await expect(
      readThreadSessionBinding(context, sent.body.threadId),
    ).resolves.toMatchObject({
      agent_session_id: null,
      agent_session_run_id: null,
      run_session_id: null,
    });

    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return assistantMessages(items).some((message) => {
          return (
            message.eventType === "run.failed" &&
            message.runId === sent.body.runId &&
            message.runLifecycleEvent === "failed"
          );
        });
      },
    );
    const failedMarker = assistantMessages(messages.events).find(
      (message): message is FailedMessage => {
        return (
          message.eventType === "run.failed" &&
          message.runId === sent.body.runId &&
          message.runLifecycleEvent === "failed"
        );
      },
    );
    if (!failedMarker) {
      throw new Error("Expected a failed lifecycle marker");
    }
    expect(failedMarker.error).toStrictEqual(expect.any(String));
    expect(userMessages(messages.events)).toContainEqual(
      expect.objectContaining({
        content: null,
        revokesEventId: messageId,
        runId: sent.body.runId,
      }),
    );
    expect(
      userMessages(messages.events).some((message) => {
        return (
          message.revokesEventId === messageId &&
          chatEventDisplayText(message) === "fail before worker start"
        );
      }),
    ).toBeTruthy();
    const replay = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "fail before worker start",
        clientEventId: messageId,
      },
      [201],
    );
    expect(replay.body).toMatchObject({
      runId: sent.body.runId,
      threadId: sent.body.threadId,
      status: "failed",
    });
    await flushWaitUntilForTest();
    const queue = await api.readRunQueue(actor);
    expect(queue.body.queue).not.toContainEqual(
      expect.objectContaining({ runId: sent.body.runId }),
    );
    await api.requestClaimRunnerJob(true, sent.body.runId, [404]);
    expect(routeRequests()).toBe(0);
  }, 60_000);
});

describe("CHAT-02: admission without spendable credits", () => {
  it("blocks admission with request-branded guidance through visible chat messages", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const completed = await bdd.completeOnboarding(actor);
    expect(completed.status).toBe(200);
    const agent = await bdd.createAgent(actor, {
      displayName: "Pro-suspend chat agent",
    });
    if (!actor.orgId) {
      throw new Error("Expected pro-suspend chat actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "suspended",
      canBuyCredits: true,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const clientEventId = randomUUID();
    const sendBody: ChatRunSendBody = {
      agentId: agent.agentId,
      prompt: "blocked by suspended plan",
      model: "claude-sonnet-5",
      clientEventId,
    };
    const sent = await chat.requestSendEvent(actor, sendBody, [201]);
    if (sent.status !== 201) {
      throw new Error("Expected the blocked send to return 201 without a run");
    }
    expect(sent.body.runId).toBeNull();

    const messages = await chat.listThreadEvents(actor, sent.body.threadId);
    const blockedUsers = userMessages(messages.events);
    expect(blockedUsers).toHaveLength(2);
    const queuedUser = blockedUsers.find((message) => {
      return (
        message.eventType === "input.prompt" && message.id === clientEventId
      );
    });
    if (!queuedUser) {
      throw new Error("Expected the original queued user message");
    }
    expect(queuedUser).toMatchObject({
      content: null,
    });
    expect(chatEventDisplayText(queuedUser)).toBe("blocked by suspended plan");
    expect(queuedUser.runId).toBeUndefined();
    const blockedUser = blockedUsers.find((message) => {
      return (
        message.eventType === "input.rejected" &&
        message.revokesEventId === clientEventId
      );
    });
    if (!blockedUser) {
      throw new Error("Expected an insufficient-credits replacement message");
    }
    expect(blockedUser).toMatchObject({
      content: null,
      error: "insufficient_credits",
      revokesEventId: clientEventId,
    });
    expect(chatEventDisplayText(blockedUser)).toBe("blocked by suspended plan");
    expect(blockedUser.runId).toBeUndefined();
    const guidance = assistantMessages(messages.events).find((message) => {
      return message.eventType === "output.error";
    });
    if (!guidance) {
      throw new Error("Expected insufficient-credits assistant guidance");
    }
    expect(guidance.content).toContain("Buy more credits");
    expect(guidance.content).toContain("https://app.okou.ai/?settings=usage");
    expect(guidance.error).toBe("insufficient_credits");

    const appended = await chat.listThreadEvents(actor, sent.body.threadId, {
      sinceEventId: queuedUser.id,
      sinceSeqId: queuedUser.seqId,
    });
    expect(appended.events).toStrictEqual([
      expect.objectContaining({
        id: blockedUser.id,
        revokesEventId: clientEventId,
        error: "insufficient_credits",
      }),
      expect.objectContaining({
        id: guidance.id,
        error: "insufficient_credits",
      }),
    ]);

    const queue = await api.readRunQueue(actor);
    expect(queue.body.queue).toHaveLength(0);
    expect(queue.body.concurrency.active).toBe(0);

    const retry = await chat.requestSendEvent(
      actor,
      { ...sendBody, threadId: sent.body.threadId },
      [201],
    );
    expect(retry.body).toStrictEqual(sent.body);
    const afterRetry = await chat.listThreadEvents(actor, sent.body.threadId);
    expect(afterRetry.events).toHaveLength(3);
  }, 60_000);
});

describe("CHAT-02: Okou Mail link delivery", () => {
  it("delivers a linked Gmail draft exactly once through the agent reply", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockGmailConnectorOAuth({
      accessToken: "gmail-agent-reply-token",
      email: "sender@example.com",
    });
    const oauth = await connectors.startOauth(actor, "gmail", "oauth");
    const oauthState = new URL(oauth.authorizationUrl).searchParams.get(
      "state",
    );
    if (!oauthState) {
      throw new Error("Expected Gmail OAuth state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "gmail-agent-reply-code",
      state: oauthState,
    });
    await api.enableAgentConnectors(actor, agentId, ["gmail"]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Create a Gmail draft and let me review it",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const gmailDraftId = "r-agent-reply-draft";
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/:draftId",
        ({ params, request }) => {
          expect(params.draftId).toBe(gmailDraftId);
          expect(request.headers.get("authorization")).toBe(
            "Bearer gmail-agent-reply-token",
          );
          expect(new URL(request.url).searchParams.get("format")).toBe("full");
          return HttpResponse.json({
            id: gmailDraftId,
            message: {
              id: "gmail-agent-reply-message",
              threadId: "gmail-agent-reply-thread",
              payload: {
                partId: "",
                mimeType: "text/plain",
                filename: "",
                headers: [
                  { name: "From", value: "Sender <sender@example.com>" },
                  { name: "To", value: "recipient@example.com" },
                  { name: "Subject", value: "Review this draft" },
                ],
                body: { size: 9, data: "TWFpbCBib2R5" },
              },
            },
          });
        },
      ),
    );

    const linked = await accept(
      setupApp({ context, routes: mailRoutes })(mailContract).linkDraft({
        headers: {
          authorization: `Bearer ${okouTokenFromClaim(claim)}`,
        },
        body: {
          threadId: run.threadId,
          agentId,
          gmailDraftId,
        },
      }),
      [200],
    );
    const beforeReply = await chat.listThreadEvents(actor, run.threadId);
    expect(
      assistantMessages(beforeReply.events).filter((message) => {
        return message.content?.includes(linked.body.mailDraftUrl);
      }),
    ).toHaveLength(0);

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, linked.body.mailDraftUrl),
    ]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      lastEventSequence: 0,
    });
    const completed = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return assistantMessages(messages).some((message) => {
          return message.content === linked.body.mailDraftUrl;
        });
      },
    );
    expect(
      assistantMessages(completed.events).filter((message) => {
        return message.content?.includes(linked.body.mailDraftUrl);
      }),
    ).toStrictEqual([
      expect.objectContaining({
        content: linked.body.mailDraftUrl,
        runId: run.runId,
      }),
    ]);
  });
});

/** S3 reads issued so far, used to prove the API never downloads an archive. */
function s3GetObjectCommandCalls(): readonly unknown[] {
  return context.mocks.s3.send.mock.calls.filter(([command]) => {
    return (
      (command as { readonly constructor?: { readonly name?: string } })
        .constructor?.name === "GetObjectCommand"
    );
  });
}

function piResponsesTextSse(
  text: string,
  sequence: number,
  usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
    readonly input_tokens_details?: {
      readonly cached_tokens?: number;
      readonly cache_write_tokens?: number;
    };
  } = { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  observedServiceTier?: string | null,
): string {
  const responseId = `resp_pi_api_${sequence.toString()}`;
  const messageId = `msg_pi_api_${sequence.toString()}`;
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: messageId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        ...(observedServiceTier === undefined
          ? {}
          : { service_tier: observedServiceTier }),
        usage,
      },
    },
  ]
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

type PiResponsesSemanticBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "toolCall";
      readonly callId: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    };

function piResponsesContentSse(args: {
  readonly blocks: readonly PiResponsesSemanticBlock[];
  readonly sequence: number;
  readonly includeReasoning?: boolean;
  readonly observedServiceTier?: string | null;
  readonly incomplete?: boolean;
  readonly usage?: Parameters<typeof piResponsesTextSse>[2];
}): string {
  const responseId = `resp_pi_content_${args.sequence.toString()}`;
  const output: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
  ];
  if (args.includeReasoning) {
    const reasoningText = "API-first reasoning preserved for Sandbox resume";
    const reasoningItem = {
      type: "reasoning",
      id: `rs_pi_content_${args.sequence.toString()}`,
      content: [{ type: "reasoning_text", text: reasoningText }],
      summary: [],
    };
    output.push(reasoningItem);
    events.push(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...reasoningItem, content: [] },
      },
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        content_index: 0,
        delta: reasoningText,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: reasoningItem,
      },
    );
  }
  const outputIndexOffset = output.length;
  for (const [blockIndex, block] of args.blocks.entries()) {
    const outputIndex = outputIndexOffset + blockIndex;
    if (block.type === "text") {
      const item = {
        type: "message",
        id: `msg_pi_content_${args.sequence.toString()}_${blockIndex.toString()}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      };
      output.push(item);
      events.push(
        {
          type: "response.output_item.added",
          output_index: outputIndex,
          item: { ...item, status: "in_progress", content: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: outputIndex,
          content_index: 0,
          delta: block.text,
        },
        { type: "response.output_item.done", output_index: outputIndex, item },
      );
      continue;
    }
    const functionArguments = JSON.stringify(block.arguments);
    const itemId = `fc_pi_content_${args.sequence.toString()}_${blockIndex.toString()}`;
    const item = {
      type: "function_call",
      id: itemId,
      call_id: block.callId,
      name: block.name,
      arguments: functionArguments,
      status: "completed",
    };
    output.push(item);
    events.push(
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: outputIndex,
        item_id: itemId,
        delta: functionArguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: outputIndex,
        item_id: itemId,
        arguments: functionArguments,
      },
      { type: "response.output_item.done", output_index: outputIndex, item },
    );
  }
  events.push({
    type: args.incomplete ? "response.incomplete" : "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: args.incomplete ? "incomplete" : "completed",
      ...(args.incomplete
        ? { incomplete_details: { reason: "max_output_tokens" } }
        : {}),
      output,
      ...(args.observedServiceTier === undefined
        ? {}
        : { service_tier: args.observedServiceTier }),
      usage: args.usage ?? {
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
      },
    },
  });
  return events
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function piResponsesToolSse(args: {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly sequence: number;
  readonly observedServiceTier?: string | null;
}): string {
  const responseId = `resp_pi_tool_${args.sequence.toString()}`;
  const reasoningId = `rs_pi_tool_${args.sequence.toString()}`;
  const itemId = `fc_pi_tool_${args.sequence.toString()}`;
  const functionArguments = JSON.stringify(args.arguments);
  const reasoningText = "API-first reasoning preserved for Sandbox resume";
  const reasoningItem = {
    type: "reasoning",
    id: reasoningId,
    content: [{ type: "reasoning_text", text: reasoningText }],
    summary: [],
  };
  const item = {
    type: "function_call",
    id: itemId,
    call_id: args.callId,
    name: args.name,
    arguments: functionArguments,
    status: "completed",
  };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...reasoningItem, content: [] },
    },
    {
      type: "response.reasoning_text.delta",
      output_index: 0,
      content_index: 0,
      delta: reasoningText,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: reasoningItem,
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: itemId,
      delta: functionArguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 1,
      item_id: itemId,
      arguments: functionArguments,
    },
    { type: "response.output_item.done", output_index: 1, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [reasoningItem, item],
        ...(args.observedServiceTier === undefined
          ? {}
          : { service_tier: args.observedServiceTier }),
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ]
    .map((event) => {
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function expectApiKeyGptRequest(
  request: unknown,
  route: (typeof GPT_API_KEY_BDD_ROUTES)[number],
  secret: string,
  tier: "fast" | undefined,
): void {
  expect(request).toMatchObject({
    authorization: `Bearer ${secret}`,
    body: {
      model: route.runtimeModel,
      stream: true,
      store: false,
      reasoning: { effort: "max" },
    },
  });
  const { body } = z
    .object({ body: z.record(z.string(), z.unknown()) })
    .parse(request);
  expect(body.service_tier).toBe(tier === "fast" ? "priority" : undefined);
  expect(body).not.toHaveProperty("previous_response_id");
}

async function claimGptPiSandbox(
  actor: ApiTestUser,
  runId: string,
  tier: "fast" | undefined,
) {
  if (tier === "fast") {
    const oldClaim = await api.requestClaimRunnerJob(true, runId, [404], {
      capabilities: { piModelConfigGenerations: [1, 2] },
    });
    expectApiError(oldClaim.body);
    await expect(api.readRun(actor, runId)).resolves.toMatchObject({
      status: "pending",
    });
  }
  return await api.claimRunnerJob(runId, {
    capabilities: {
      piModelConfigGenerations: tier === "fast" ? [1, 2, 3] : [1, 2],
    },
  });
}

function expectApiKeyGptSandboxCarrier(
  claim: Awaited<ReturnType<typeof api.claimRunnerJob>>,
  route: (typeof GPT_API_KEY_BDD_ROUTES)[number],
  tier: "fast" | undefined,
): void {
  expect(claim.piModelConfig).toStrictEqual({
    schemaVersion: tier === undefined ? 2 : 3,
    ...(tier === undefined ? {} : { serviceTier: "priority" }),
    dialect: "openai-responses",
    transport: "sse",
    provider: route.piProvider,
    baseUrl: route.baseUrl,
    model: route.runtimeModel,
    ...(route.type === "vercel-ai-gateway-codex"
      ? { catalogModel: route.catalogModel }
      : {}),
    thinkingLevel: "max",
    credentialBindings: [
      {
        kind: "api-key",
        environment: "OPENAI_API_KEY",
        secretName: route.secretName,
      },
    ],
  });
  expect(claimEnvironment(claim)).toMatchObject({
    OPENAI_API_KEY: modelProviderSecretPlaceholder(
      route.type,
      route.secretName,
    ),
    OPENAI_MODEL: route.runtimeModel,
  });
  expect(claim.billableFirewalls).toStrictEqual([]);
  expect(claim.secretConnectorMap?.[route.secretName]).toBe(route.type);
  expect(claim.secretConnectorMetadataMap?.[route.secretName]).toStrictEqual({
    sourceType: "model-provider",
    sourceUserId: "__org__",
    metadataKey: route.type,
  });
}

function expectNativeSubscriptionRequest(
  request: unknown,
  accessToken: string,
  tier: "fast" | undefined,
  selectedModel: PiGptBddModel = "gpt-5.6-terra",
): void {
  expect(request).toMatchObject({
    accountMatches: true,
    authorization: `Bearer ${accessToken}`,
    body: {
      model: selectedModel,
      stream: true,
      store: false,
      reasoning: { effort: "max" },
    },
  });
  const { body } = z
    .object({ body: z.record(z.string(), z.unknown()) })
    .parse(request);
  expect(body.service_tier).toBe(tier === undefined ? undefined : "priority");
  expect(body).not.toHaveProperty("previous_response_id");
}

async function cancelBeforeLatePiResult(
  actor: ApiTestUser,
  runId: string,
  releaseProvider: () => void,
  usagePricingResolution?: UsagePricingFixture["resolution"],
): Promise<void> {
  // No public API holds the lifecycle transaction open; this scoped lock
  // makes cancellation commit before a completed provider result publishes.
  const lock = await holdPiApiFirstTurnLifecycleLockFixture({
    runId,
    signal: context.signal,
  });
  onTestFinished(async () => {
    lock.release();
    await lock.done;
  });
  const cancellation = api.requestCancelRun(
    actor,
    runId,
    [200],
    usagePricingResolution,
  );
  await expect.poll(lock.waiterCount).toBe(1);
  releaseProvider();
  await expect.poll(lock.waiterCount).toBe(2);
  lock.release();
  await lock.done;
  await cancellation;
}

function settledSubscriptionToolHistory(h1: string): string {
  const h2Session = MemoryPiSession.fromJsonl(h1);
  const pendingAssistant = [...h2Session.buildSessionContext().messages]
    .reverse()
    .find((message) => {
      return message.role === "assistant";
    });
  const pendingTool =
    pendingAssistant?.role === "assistant"
      ? pendingAssistant.content.find((content) => {
          return content.type === "toolCall";
        })
      : undefined;
  if (
    pendingAssistant?.role !== "assistant" ||
    !pendingTool ||
    pendingTool.type !== "toolCall"
  ) {
    throw new Error("Expected native Codex tool call in H1");
  }
  h2Session.appendMessage({
    role: "toolResult",
    toolCallId: pendingTool.id,
    toolName: pendingTool.name,
    content: [{ type: "text", text: "Okou CLI help output" }],
    details: {},
    isError: false,
    timestamp: 2,
  });
  h2Session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Subscription Sandbox complete" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: pendingAssistant.model,
    usage: {
      input: 5,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: 3,
  });
  return h2Session.toJsonl();
}

function nativeCodexSseResponse(body: string): Response {
  return new HttpResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function readCodexRequestJson(request: Request): Promise<unknown> {
  const bytes = Buffer.from(await request.arrayBuffer());
  const body =
    request.headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(bytes)
      : bytes;
  return JSON.parse(body.toString("utf8")) as unknown;
}

interface PiCheckpointS3Command {
  readonly constructor?: { readonly name?: string };
  readonly input?: {
    readonly Body?: unknown;
    readonly Bucket?: unknown;
    readonly Delete?: {
      readonly Objects?: readonly { readonly Key?: unknown }[];
    };
    readonly Key?: unknown;
  };
}

function piS3ObjectKey(candidate: PiCheckpointS3Command): string | undefined {
  const bucket = candidate.input?.Bucket;
  const key = candidate.input?.Key;
  return typeof bucket === "string" && typeof key === "string"
    ? `${bucket}/${key}`
    : undefined;
}

function mockPiPutObject(
  objects: Map<string, Buffer>,
  candidate: PiCheckpointS3Command,
): Promise<unknown> | undefined {
  const objectKey = piS3ObjectKey(candidate);
  if (candidate.constructor?.name !== "PutObjectCommand" || !objectKey) {
    return undefined;
  }
  const body = candidate.input?.Body;
  if (typeof body === "string") {
    objects.set(objectKey, Buffer.from(body, "utf8"));
  } else if (body instanceof Uint8Array) {
    objects.set(objectKey, Buffer.from(body));
  } else {
    throw new Error("Expected Pi S3 writes to use string or byte bodies");
  }
  return Promise.resolve({});
}

function mockPiGetObject(
  objects: Map<string, Buffer>,
  candidate: PiCheckpointS3Command,
): Promise<unknown> | undefined {
  const objectKey = piS3ObjectKey(candidate);
  if (candidate.constructor?.name !== "GetObjectCommand" || !objectKey) {
    return undefined;
  }
  const bytes = objects.get(objectKey);
  return bytes
    ? Promise.resolve({
        ContentLength: bytes.length,
        Body: (async function* () {
          yield bytes;
        })(),
      })
    : undefined;
}

function mockPiDeleteObjects(
  objects: Map<string, Buffer>,
  candidate: PiCheckpointS3Command,
): Promise<unknown> | undefined {
  const bucket = candidate.input?.Bucket;
  if (
    candidate.constructor?.name !== "DeleteObjectsCommand" ||
    typeof bucket !== "string"
  ) {
    return undefined;
  }
  for (const object of candidate.input?.Delete?.Objects ?? []) {
    if (typeof object.Key === "string") {
      objects.delete(`${bucket}/${object.Key}`);
    }
  }
  return Promise.resolve({});
}

function mockPiCheckpointObjectStore(): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const candidate = command as PiCheckpointS3Command;
    return (
      mockPiPutObject(objects, candidate) ??
      mockPiGetObject(objects, candidate) ??
      mockPiDeleteObjects(objects, candidate) ??
      fallback?.(command) ??
      Promise.resolve({})
    );
  });
  return objects;
}

function expectNoPiApiFirstTurnArtifacts(
  runId: string,
  objects: ReadonlyMap<string, Buffer>,
): void {
  const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${runId}/`;
  const artifactKeys = [`${prefix}session.jsonl`, `${prefix}manifest.json`];
  for (const key of artifactKeys) {
    expect(objects.has(key)).toBeFalsy();
  }
  // Terminal cleanup deletes temporary objects. Inspect the external writes
  // too, so a briefly published H1 or manifest cannot pass this assertion.
  const writes = context.mocks.s3.send.mock.calls.flatMap(([command]) => {
    const candidate = command as PiCheckpointS3Command;
    const key = piS3ObjectKey(candidate);
    return candidate.constructor?.name === "PutObjectCommand" &&
      key !== undefined &&
      artifactKeys.includes(key)
      ? [key]
      : [];
  });
  expect(writes).toStrictEqual([]);
}

async function expectPiApiFirstTurnTerminalWithoutOutput(
  actor: ApiTestUser,
  run: { readonly runId: string; readonly threadId: string },
  status: "failed" | "cancelled",
  failureMessage = "[PI_API_MODEL_OUTPUT_INCOMPLETE] Pi API first-turn model output is incomplete",
): Promise<void> {
  const terminal = await api.readRun(actor, run.runId);
  expect(terminal).toMatchObject({
    status,
    ...(status === "failed"
      ? {
          error: failureMessage,
        }
      : {}),
  });
  expect(terminal.result).toBeFalsy();
  const events = (await chat.listThreadEvents(actor, run.threadId)).events;
  expect(eventBackedContents(events, run.runId)).toStrictEqual([]);
  expect(
    events
      .filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      })
      .map((event) => {
        return event.eventType;
      }),
  ).toStrictEqual([`run.${status}`]);
}

const PI_RESOURCE_ARCHIVE_DOWNLOAD_URL =
  "https://r2.example.com/storage/archive.tar.gz";

function uploadedPiS3Object(objectKey: string): Buffer | undefined {
  for (const [command] of [...context.mocks.s3.send.mock.calls].reverse()) {
    const candidate = command as PiCheckpointS3Command;
    if (
      candidate.constructor?.name === "PutObjectCommand" &&
      piS3ObjectKey(candidate) === objectKey
    ) {
      if (typeof candidate.input?.Body === "string") {
        return Buffer.from(candidate.input.Body, "utf8");
      }
      if (!(candidate.input?.Body instanceof Uint8Array)) {
        throw new Error(
          `Expected uploaded Pi S3 object bytes for ${objectKey}`,
        );
      }
      return Buffer.from(candidate.input.Body);
    }
  }
  return undefined;
}

function piS3Object(objectKey: string): Buffer {
  const uploaded = uploadedPiS3Object(objectKey);
  if (uploaded) {
    return uploaded;
  }
  const bucketPrefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/`;
  const seeded = objectKey.startsWith(bucketPrefix)
    ? seededSystemSkillArchive(objectKey.slice(bucketPrefix.length))
    : undefined;
  if (seeded) {
    return seeded;
  }
  throw new Error(`Expected Pi S3 object ${objectKey}`);
}

// A generic Storage commit keeps this test-owned instruction version pending.
// Shared official skill versions may already be indexed by another test.
async function publishPendingPiInstructions(
  actor: ApiTestUser,
  agentId: string,
): Promise<string> {
  const storageName = getInstructionsStorageName(
    await readCanonicalAgentNameFixture(agentId),
  );
  const content = `Pending resource fixture ${randomUUID()}`;
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  new Header({
    path: "AGENTS.md",
    size: bytes.length,
    type: "File",
    mode: 0o644,
  }).encode(header);
  const archive = gzipSync(
    Buffer.concat([
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
  const storages = createStoragesBddApi(context);
  const files = [storageTextFile("AGENTS.md", content)];
  const prepared = await storages.prepareStorage(actor, {
    storageName,
    storageOwner: "organization",
    files,
  });
  let upload: { Bucket: string; Key: string } | undefined;
  const original = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((request: unknown) => {
    if (request instanceof HeadObjectCommand) {
      if (
        request.input.Bucket &&
        request.input.Key?.endsWith("/archive.tar.gz")
      ) {
        upload = { Bucket: request.input.Bucket, Key: request.input.Key };
      }
      return Promise.resolve({ ContentLength: archive.length });
    }
    if (!original) {
      throw new Error("Expected the test object store");
    }
    return original(request);
  });
  await storages
    .commitStorage(actor, {
      storageName,
      storageOwner: "organization",
      files,
      versionId: prepared.versionId,
    })
    .finally(() => {
      if (original) {
        context.mocks.s3.send.mockImplementation(original);
      }
    });
  if (!upload) {
    throw new Error("Expected the instruction fixture archive to be verified");
  }
  await context.mocks.s3.send(
    new PutObjectCommand({ ...upload, Body: archive }),
  );
  return content;
}

function mockPiResourceArchiveDownloads(unavailable = false): void {
  server.use(
    http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
      if (unavailable) {
        return HttpResponse.json(
          { error: "archive unavailable" },
          { status: 503 },
        );
      }
      const objectKey = new URL(request.url).searchParams.get("object");
      if (!objectKey) {
        throw new Error("Expected Pi resource archive object identity");
      }
      return new HttpResponse(piS3Object(objectKey), {
        headers: { "content-type": "application/gzip" },
      });
    }),
  );
}

async function completeSandboxFirstPiRun(args: {
  readonly actor: ApiTestUser;
  readonly answer: string;
  readonly outputTokens?: number;
  readonly nativeModel?: z.infer<typeof piNativeCatalogModelSchema>;
  readonly checkpointObjects: Map<string, Buffer>;
  readonly claim: Awaited<ReturnType<typeof claimChatRun>>;
  readonly prompt: string;
  readonly run: { readonly runId: string; readonly threadId: string };
  readonly usagePricingResolution: UsagePricingFixture["resolution"];
}): Promise<void> {
  const sessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${args.run.runId}/session.jsonl`;
  const h0 = args.checkpointObjects.get(sessionKey);
  if (!h0) {
    throw new Error("Expected authoritative sandbox-first H0");
  }
  const session = MemoryPiSession.fromJsonl(h0.toString("utf8"));
  session.appendMessage({
    role: "user",
    content: args.prompt,
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: args.answer }],
    api: args.nativeModel ? "anthropic-messages" : "openai-responses",
    provider: args.nativeModel ? "anthropic" : "openai",
    model: args.nativeModel ?? "gpt-5.6-terra",
    usage: {
      input: 0,
      output: args.outputTokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: args.outputTokens ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const h2 = session.toJsonl();
  const h2Hash = createHash("sha256").update(h2).digest("hex");
  await webhooks.requestAgentCheckpointPrepareHistory(
    {
      runId: args.run.runId,
      hash: h2Hash,
      rawSize: Buffer.byteLength(h2),
      encodedSize: Buffer.byteLength(h2),
      encoding: "identity",
    },
    args.claim.sandboxHeaders,
    [200],
  );
  args.checkpointObjects.set(
    `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
    Buffer.from(h2, "utf8"),
  );
  await webhooks.requestAgentEvents(
    {
      runId: args.run.runId,
      events: [
        {
          type: "assistant",
          sequenceNumber: 1,
          message: { content: [{ type: "text", text: args.answer }] },
        },
        { type: "result", sequenceNumber: 2, result: args.answer },
      ],
    },
    args.claim.sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: args.run.runId,
      exitCode: 0,
      lastEventSequence: 2,
      checkpoint: {
        cliAgentType: "pi",
        cliAgentSessionId: args.run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
    },
    args.claim.sandboxHeaders,
    [200],
    undefined,
    args.usagePricingResolution,
  );
  await waitForRunStatus(args.actor, args.run.runId, "completed", 5000);
  await flushWaitUntilForTest();
}

async function queueCapabilityProvenPiRun(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly prompt: string;
  readonly codexServiceTier?: "fast";
  readonly gptRoute?: "openai" | "openrouter";
  readonly selectedModel?: PiApiFirstTurnUsageProvider;
}): Promise<{
  readonly anchor: { readonly runId: string; readonly threadId: string };
  readonly anchorClaim: Awaited<ReturnType<typeof claimChatRun>>;
  readonly run: { readonly runId: string; readonly threadId: string };
  readonly usagePricingResolution: UsagePricingFixture["resolution"];
}> {
  if (!args.actor.orgId) {
    throw new Error("Expected entitled chat actor to have an org");
  }
  mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
  await api.heartbeatRunner(args.runnerGroup);
  const anchor = await sendChatRun(args.actor, {
    agentId: args.agentId,
    prompt: "hold capacity for a capability-proven Pi launch",
    model: "claude-sonnet-5",
  });
  await flushWaitUntilForTest();
  const anchorState = await api.readRun(args.actor, anchor.runId);
  if (anchorState.status !== "pending") {
    throw new Error(
      `Expected pending capability anchor: ${JSON.stringify(anchorState)}`,
    );
  }
  const anchorClaim = await claimChatRun(args.runnerGroup, anchor.runId);
  const selectedModel = args.selectedModel ?? "gpt-5.6-terra";
  let withModelRoute = async <T>(work: () => Promise<T>): Promise<T> => {
    return await work();
  };
  if (args.gptRoute === "openrouter") {
    withModelRoute = await configureBuiltInPiModelOnOpenRouter(
      args.actor,
      selectedModel,
    );
  } else {
    await configureBuiltInPiModel(args.actor, selectedModel);
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...args.actor, orgId: args.actor.orgId },
    {
      [FeatureSwitchKey.PiLoop]: true,
      ...(args.codexServiceTier === "fast"
        ? { [FeatureSwitchKey.CodexFastMode]: true }
        : {}),
    },
  );
  const usagePricingResolution =
    await createPiApiFirstTurnUsagePricingResolution(selectedModel);
  const run = await withModelRoute(async () => {
    return await sendChatRun(
      args.actor,
      {
        agentId: args.agentId,
        prompt: args.prompt,
        model: selectedModel,
        ...(args.codexServiceTier === undefined
          ? {}
          : { runOptions: { codexServiceTier: args.codexServiceTier } }),
      },
      usagePricingResolution,
    );
  });
  await waitForRunStatus(args.actor, run.runId, "queued");
  return { anchor, anchorClaim, run, usagePricingResolution };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function piResponsesDeveloperPrompt(rawBody: string | undefined): string {
  if (rawBody === undefined) {
    throw new Error("Expected a Pi Responses request body");
  }
  const body = JSON.parse(rawBody) as unknown;
  if (
    typeof body !== "object" ||
    body === null ||
    !("input" in body) ||
    !Array.isArray(body.input)
  ) {
    throw new Error("Expected a Pi Responses input array");
  }
  const developer = body.input.find((item) => {
    return (
      typeof item === "object" &&
      item !== null &&
      "role" in item &&
      item.role === "developer"
    );
  });
  if (
    typeof developer !== "object" ||
    developer === null ||
    !("content" in developer) ||
    typeof developer.content !== "string"
  ) {
    throw new Error("Expected a Pi Responses developer prompt");
  }
  return developer.content;
}

describe("thread-bound Pi terminal failures", () => {
  it.each([
    { source: "automation", status: "failed" },
    { source: "automation", status: "cancelled" },
    { source: "goal", status: "failed" },
    { source: "goal", status: "cancelled" },
  ] as const)(
    "settles $source $status once without learning or Built-in fallback",
    async ({ source, status }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      await configureSubscriptionPiModel(
        actor,
        { accountId: "terminal-owner" },
        "gpt-5.6-luna",
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const requests: string[] = [];
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/codex/responses",
          async ({ request }) => {
            requests.push(request.url);
            expect(request.headers.get("chatgpt-account-id")).toBe(
              "terminal-owner",
            );
            entered.resolve(undefined);
            await release.promise;
            return HttpResponse.json(
              {
                error: {
                  code: "invalid_api_key",
                  message: "subscription rejected",
                },
              },
              { status: 401 },
            );
          },
        ),
        http.post("https://api.openai.com/v1/responses", ({ request }) => {
          requests.push(request.url);
          return HttpResponse.json(
            { error: "unexpected Built-in fallback" },
            { status: 400 },
          );
        }),
      );
      let run: { readonly runId: string; readonly threadId: string };
      {
        const workflowId = await createWorkflowsBddApi(context).createWorkflow(
          actor,
          { agentId, name: "pi-terminal" },
        );
        const created = await accept(
          threadPiAutomationsClient().create({
            headers: sessionHeaders(actor),
            params: { workflowId },
            body: { schedule: { type: "loop", intervalSeconds: 3600 } },
          }),
          [201],
        );
        const started = await accept(
          threadPiAutomationsClient().run({
            headers: sessionHeaders(actor),
            params: { id: created.body.id },
          }),
          [201],
        );
        const threadId = started.body.chatThreadId;
        const runId = await lastThreadPiAutomationRun(actor, threadId);
        run = { runId, threadId };
        await flushWaitUntilForTest();
        await api.heartbeatRunner(runnerGroup);
        const claim = await claimGptPiSandbox(actor, runId, undefined);
        const claimed = {
          claim,
          sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
        };
        expect(claimed.claim.piModelConfig).toMatchObject({
          model: "gpt-5.6-luna",
        });
        if (source === "goal") {
          const goal = await seedGoalForRunFixture(runId, "in-flight Pi Goal");
          await setLegacyGoalRunOriginFixture(runId, goal.id);
        }
        if (status === "cancelled") {
          await cancelChatRun(actor, runId, claimed.sandboxHeaders);
        } else {
          await failChatRun(
            runId,
            claimed.sandboxHeaders,
            "subscription rejected",
          );
        }
        await failChatRun(
          runId,
          claimed.sandboxHeaders,
          "duplicate terminal delivery",
        );
      }
      await flushWaitUntilForTest();
      await accept(
        setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
          testWorkflowAutomationExecutionContract,
        ).dispatchCallbacks({
          body: {
            run_id: run.runId,
            status: "failed",
            error:
              status === "cancelled"
                ? "Run cancelled"
                : "subscription rejected",
            dispatch_count: 2,
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      await expect(
        readRunLaunchSnapshotFixture(context, run.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { schemaVersion: 3, framework: "pi" },
      });
      await expectNoBuiltInModelUsage(run.runId);
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toBeNull();
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events
          .filter((event) => {
            return (
              event.runId === run.runId &&
              isChatRunTerminalEventType(event.eventType)
            );
          })
          .map((event) => {
            return event.eventType;
          }),
      ).toStrictEqual([`run.${status}`]);
      expect(requests).toHaveLength(0);
      if (source === "goal") {
        expect(
          (await readGoalQueueStateFixture(run.threadId)).runIds,
        ).toStrictEqual([run.runId]);
        expect(
          (await readGoalQueueStateFixture(run.threadId)).eventIds,
        ).toStrictEqual([]);
      }
    },
    90_000,
  );
});

describe("CHAT-02: model-first provider policies", () => {
  it("adds Codex image upload guidance for web chat Codex sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const prompt =
      "generate an image in web chat using the aurora-21210 color palette";

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-luna",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt,
      model: "gpt-5.6-luna",
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(claim.cliAgentType).toBe("codex");
    expect(appendSystemPrompt).toContain(
      "You are currently running inside: Web",
    );
    expect(appendSystemPrompt).toContain("okou web upload-file -h");
    expect(appendSystemPrompt).toContain("okou mail link <gmail-draft-id>");
    expect(appendSystemPrompt).toContain(
      "GET /gmail/v1/users/me/settings/sendAs",
    );
    expect(appendSystemPrompt).toContain(
      "Include a `multipart/alternative` body",
    );
    expect(appendSystemPrompt).toContain(
      "Keep each plain-text paragraph on one logical line",
    );
    expect(appendSystemPrompt).toContain(
      "use HTML paragraph elements so Gmail wraps the message naturally",
    );
    expect(appendSystemPrompt).toContain("append that signature exactly once");
    expect(appendSystemPrompt).toContain(
      "return the link from the command to the user",
    );
    expect(appendSystemPrompt).toContain("Do not add a mail callback prompt");
    expect(appendSystemPrompt).toContain(
      "confirm the send against Gmail before reporting it",
    );
    expect(appendSystemPrompt).toContain(
      "`okou workflow automation list <workflow>` shows one workflow's triggers",
    );
    expect(appendSystemPrompt).toContain(
      "Never send a reply automatically; the user always sends",
    );
    expect(appendSystemPrompt).toContain(CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET);
    expect(appendSystemPrompt).not.toContain("When running in Codex");
    let previousSectionIndex = -1;
    for (const section of [
      "# Agent Identity",
      "# Execution Time Limit",
      "# Agent Tools",
      "# Current User Info",
      "# Current Integration",
      CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
    ]) {
      const sectionIndex = appendSystemPrompt.indexOf(section);
      expect(sectionIndex).toBeGreaterThan(previousSectionIndex);
      previousSectionIndex = sectionIndex;
    }
    await cancelChatRun(actor, run.runId);
  });

  it("routes model policy providers into the runner claim", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = requireOrgId(actor);
    // External model admission depends on plan capabilities, not built-in
    // model credit admission.
    await seedOrgMetadata({ orgId, tier: "pro", credits: 0 });
    const { providerId: deepseekId } = await upsertOrgModelProvider(actor, {
      type: "deepseek",
      secret: "selected-deepseek-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: deepseekId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected DeepSeek provider",
      model: "deepseek-v4-flash",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(environment.OPENAI_BASE_URL).toBe("https://api.deepseek.com/");
    expect(environment.OPENAI_MODEL).toBe("deepseek-v4-flash");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();

    // The new thread's initial model is recorded on the created event. The
    // send route does not emit a model_selection_updated event.
    const thread = await chat.readThread(actor, run.threadId);
    expect(thread).not.toHaveProperty("selectedModel");
    expect(thread).not.toHaveProperty("modelProviderId");
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: run.threadId,
        selectedModel: "deepseek-v4-flash",
      }),
    );
    expect(threadEvents.body.events).not.toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: run.threadId,
        selectedModel: "deepseek-v4-flash",
      }),
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders);
    expect((await api.readRun(actor, run.runId)).status).toBe("completed");

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "follow up without a send-time model override",
    });
    const { claim: followUpClaim } = await claimChatRun(
      runnerGroup,
      followUp.runId,
    );
    const followUpEnvironment = claimEnvironment(followUpClaim);
    expect(followUpEnvironment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(followUpEnvironment.OPENAI_BASE_URL).toBe(
      "https://api.deepseek.com/",
    );
    expect(followUpEnvironment.OPENAI_MODEL).toBe("deepseek-v4-flash");
    await cancelChatRun(actor, followUp.runId);

    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    const insufficientBuiltIn = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "reject built-in admission without spendable credits",
        model: "claude-sonnet-5",
      },
      [201],
    );
    if (insufficientBuiltIn.status !== 201) {
      throw new Error("Expected insufficient-credit send to return 201");
    }
    expect(insufficientBuiltIn.body.runId).toBeNull();

    // Restore spendable credits before exercising the built-in branch.
    await seedOrgMetadata({ orgId, tier: "pro", credits: 1_000_000 });

    // A built-in provider pin in an entitled org passes the spendable-credits
    // admission. The outcome past admission is race-dependent on the shared
    // database: 503 when no built-in model key exists (no public provisioning
    // surface), 201 when another suite's alive legacy test has seeded a
    // global built-in model key. Both prove the credits-ok admission arm.
    await setOrgModelPolicyProviderTypeFixture({
      orgId,
      model: "claude-sonnet-5",
      defaultProviderType: "built-in",
    });
    const builtInPrompt = "built-in admission with spendable credits";
    const builtInSend = await requestSendEventRaw(actor, {
      agentId,
      prompt: builtInPrompt,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: builtInPrompt }],
      },
      model: "claude-sonnet-5",
      hasTextContent: true,
    });
    expect([201, 503]).toContain(builtInSend.status);
    type BuiltInAdmissionObservation =
      | {
          readonly outcome: "route-unavailable";
          readonly response: {
            readonly status: 503;
            readonly errorMessage: string;
          };
          readonly cleanup: null;
        }
      | {
          readonly outcome: "run-created";
          readonly response: {
            readonly status: 201;
            readonly runId: string | null;
          };
          readonly cleanup: { readonly status: number } | null;
        };
    let builtInObservation: BuiltInAdmissionObservation;
    let expectedBuiltInObservation: BuiltInAdmissionObservation;
    if (builtInSend.status === 503) {
      expectApiError(builtInSend.body);
      builtInObservation = {
        outcome: "route-unavailable",
        response: {
          status: 503,
          errorMessage: builtInSend.body.error.message,
        },
        cleanup: null,
      };
      expectedBuiltInObservation = {
        outcome: "route-unavailable",
        response: {
          status: 503,
          errorMessage:
            "Every built-in model route for this model is temporarily unavailable",
        },
        cleanup: null,
      };
    } else {
      if (builtInSend.status !== 201) {
        throw new Error("Expected a legal built-in admission outcome");
      }
      if (
        typeof builtInSend.body !== "object" ||
        builtInSend.body === null ||
        !("runId" in builtInSend.body) ||
        (builtInSend.body.runId !== null &&
          typeof builtInSend.body.runId !== "string")
      ) {
        throw new Error("Expected a built-in admission response body");
      }
      const runId = builtInSend.body.runId;
      const cancellation =
        runId === null ? null : await api.requestCancelRun(actor, runId, [200]);
      builtInObservation = {
        outcome: "run-created",
        response: { status: 201, runId },
        cleanup: cancellation === null ? null : { status: cancellation.status },
      };
      expectedBuiltInObservation = {
        outcome: "run-created",
        response: { status: 201, runId },
        cleanup: runId === null ? null : { status: 200 },
      };
    }
    expect(builtInObservation).toStrictEqual(expectedBuiltInObservation);
  }, 90_000);

  it("preserves persisted external model plan-state outcomes", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = requireOrgId(actor);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const initial = await sendChatRun(actor, {
      agentId,
      prompt: "establish external plan capability admission",
      model: "claude-sonnet-5",
    });
    const initialClaim = await claimChatRun(runnerGroup, initial.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(initial.runId, initialClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const activeFollowUp = await sendChatRun(actor, {
      agentId,
      threadId: initial.threadId,
      prompt: "continue with active plan capabilities",
    });
    await cancelChatRun(actor, activeFollowUp.runId);

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "suspended",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    const suspendedEventId = randomUUID();
    const suspended = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        prompt: "reject suspended persisted admission",
        clientEventId: suspendedEventId,
      },
      [201],
    );
    if (suspended.status !== 201) {
      throw new Error("Expected suspended-plan send to return 201");
    }
    expect(suspended.body.runId).toBeNull();
    const suspendedMessages = await chat.listThreadEvents(
      actor,
      initial.threadId,
    );
    expect(userMessages(suspendedMessages.events)).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: suspendedEventId,
        error: "insufficient_credits",
      }),
    );

    await deleteOrgPlanEntitlementFixture(orgId);
    const missing = await requestSendEventRaw(actor, {
      agentId,
      threadId: initial.threadId,
      prompt: "reject missing persisted plan authority",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "reject missing persisted plan authority" },
        ],
      },
      hasTextContent: true,
    });
    expect(missing.status).toBe(500);

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: false,
      restrictedBuiltInModels: false,
    });
    await seedBuiltInModelKey(LIMITED_FREE1_DEFAULT_RUN_MODEL);
    const byokDisabled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        prompt: "fall back from a BYOK-disabled persisted route",
      },
      [201],
    );
    if (byokDisabled.status !== 201) {
      throw new Error("Expected BYOK-disabled send to return 201");
    }
    if (!byokDisabled.body.runId) {
      throw new Error("Expected BYOK-disabled policy fallback to create a run");
    }
    const byokDisabledPolicies = await misc.listModelPolicies(actor);
    expect(byokDisabledPolicies.policies).toContainEqual(
      expect.objectContaining({
        model: LIMITED_FREE1_DEFAULT_RUN_MODEL,
        isDefault: true,
        defaultProviderType: "built-in",
        modelProviderId: null,
      }),
    );
    await cancelChatRun(actor, byokDisabled.body.runId);

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "active",
      supportByok: true,
      restrictedBuiltInModels: true,
    });
    const restricted = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        prompt: "fall back from a restricted persisted model",
      },
      [201],
    );
    if (restricted.status !== 201) {
      throw new Error("Expected restricted-model send to return 201");
    }
    if (!restricted.body.runId) {
      throw new Error(
        "Expected restricted-model policy fallback to create a run",
      );
    }
    const restrictedPolicies = await misc.listModelPolicies(actor);
    expect(restrictedPolicies.policies).toContainEqual(
      expect.objectContaining({
        model: LIMITED_FREE1_DEFAULT_RUN_MODEL,
        isDefault: true,
        defaultProviderType: "built-in",
        modelProviderId: null,
      }),
    );
    await cancelChatRun(actor, restricted.body.runId);
  }, 90_000);

  it("reloads external plan capabilities at final admission", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = requireOrgId(actor);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const initial = await sendChatRun(actor, {
      agentId,
      prompt: "establish final plan admission freshness",
      model: "claude-sonnet-5",
    });
    const initialClaim = await claimChatRun(runnerGroup, initial.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(initial.runId, initialClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const threadLock = await holdChatThreadRowLockFixture({
      threadId: initial.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });
    const prompt = "reject plan changed after persisted preflight";
    const followUp = chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: initial.threadId,
        prompt,
      },
      [402],
    );
    await expect.poll(threadLock.blockedWaiterCount).toBe(1);

    await upsertOrgPlanEntitlementFixture({
      orgId,
      status: "suspended",
      supportByok: true,
      restrictedBuiltInModels: false,
    });
    threadLock.release();
    const rejected = await followUp;
    await threadLock.done;
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.filter((run) => {
        return run.prompt === prompt;
      }),
    ).toHaveLength(0);
  }, 90_000);

  it.each(GPT_PI_BDD_MODELS)(
    "keeps captured Pi admission after PiLoop turns off for %s",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const orgId = requireOrgId(actor);
      await configureBuiltInPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads(true);
      mockPiCheckpointObjectStore();
      await api.heartbeatRunner(runnerGroup);

      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: false },
      );
      const baseline = await sendChatRun(actor, {
        agentId,
        prompt: "establish the captured Codex session family",
        model: selectedModel,
      });
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, baseline.runId)).resolves.toMatchObject({
        status: "pending",
      });
      await expect(
        readRunLaunchSnapshotFixture(context, baseline.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "codex" },
      });
      const baselineClaim = await claimChatRun(runnerGroup, baseline.runId);
      expect(baselineClaim.claim.cliAgentType).toBe("codex");
      expect(baselineClaim.claim.piLaunchConfig).toBeUndefined();
      const baselineBinding = await readThreadSessionBinding(
        context,
        baseline.threadId,
      );
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(baseline.runId, baselineClaim.sandboxHeaders, {
        cliAgentType: "codex",
      });
      await flushWaitUntilForTest();

      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      const enabledGate = holdAgentRunPiExecutionSnapshotFixture({
        userId: actor.userId,
        orgId,
        signal: context.signal,
      });
      onTestFinished(enabledGate.release);
      const enabledSend = sendChatRun(actor, {
        agentId,
        threadId: baseline.threadId,
        prompt: "keep Pi after the switch turns off",
        model: selectedModel,
      });
      const enabledSnapshot = await enabledGate.arrival;
      expect(enabledSnapshot).toMatchObject({
        chatThreadId: baseline.threadId,
        piExecution: true,
        threadSessionCliAgentType: "pi",
      });
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: false },
      );
      enabledGate.release();
      const enabled = await enabledSend;
      await flushWaitUntilForTest();
      const enabledClaim = await claimChatRun(runnerGroup, enabled.runId);
      expect(enabledClaim.claim.cliAgentType).toBe("pi");
      expect(enabledClaim.claim.piLaunchConfig).toBeDefined();
      await expect(
        readRunLaunchSnapshotFixture(context, enabled.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "pi" },
      });
      const enabledBinding = await readThreadSessionBinding(
        context,
        enabled.threadId,
      );
      expect(enabledBinding.agent_session_id).not.toBe(
        baselineBinding.agent_session_id,
      );
      await cancelChatRun(actor, enabled.runId, enabledClaim.sandboxHeaders);
    },
    90_000,
  );

  it("pins recall-enabled Pi memory through API completion and Sandbox handoff", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const frozenSummary =
      "# Pi memory summary\n\nUse the exact pinned version for this session.";
    const initialMemory = await commitMemoryVersion(context, actor, [
      {
        path: "MEMORY.md",
        content: "Pi memory version pinned before the API-first completion.",
      },
      { path: "memory_summary.md", content: frozenSummary },
    ]);
    await seedReadyMemorySummaryProjection(
      context,
      actor,
      initialMemory,
      frozenSummary,
    );
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    let modelCalls = 0;
    const modelRequestBodies: string[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        modelCalls += 1;
        modelRequestBodies.push(await request.text());
        return new HttpResponse(
          modelCalls === 1
            ? piResponsesTextSse("API-first memory checkpoint", modelCalls)
            : piResponsesToolSse({
                callId: "call_pi_memory_handoff",
                name: "read",
                arguments: { path: "/home/user/workspace/AGENTS.md" },
                sequence: modelCalls,
              }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "complete through the Pi API-first slot",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(modelCalls).toBe(1);
    await expect(
      readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      }),
    ).resolves.toMatchObject({
      sourceRunId: first.runId,
      status: "pending",
    });
    const firstDeveloperPrompt = piResponsesDeveloperPrompt(
      modelRequestBodies[0],
    );
    expect(occurrences(firstDeveloperPrompt, frozenSummary)).toBe(1);
    expect(firstDeveloperPrompt).toContain(
      `${PI_MEMORY_ROOT}/memory_summary.md`,
    );

    const newerMemory = await commitMemoryVersion(context, actor, [
      {
        path: "MEMORY.md",
        content: "A newer HEAD must not replace the session-pinned version.",
      },
    ]);
    expect(newerMemory.versionId).not.toBe(initialMemory.versionId);

    const second = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "handoff with the pinned Pi memory mount",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(manifestKey);
      })
      .toBe(true);
    expect(modelCalls).toBe(2);
    expect(
      occurrences(
        piResponsesDeveloperPrompt(modelRequestBodies[1]),
        frozenSummary,
      ),
    ).toBe(1);
    const manifestBytes = checkpointObjects.get(manifestKey);
    if (!manifestBytes) {
      throw new Error("Expected the Pi memory ownership-transfer manifest");
    }
    expect(
      piApiFirstTurnManifestSchema.parse(
        JSON.parse(manifestBytes.toString("utf8")),
      ),
    ).toMatchObject({
      outcome: "ownership-transfer",
      mode: "pending-tool-continuation",
    });
    const claimed = await claimChatRun(runnerGroup, second.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: initialMemory.storageId,
        storageVersionId: initialMemory.versionId,
        content: frozenSummary,
        sourceHash: createHash("sha256").update(frozenSummary).digest("hex"),
        sourceSize: Buffer.byteLength(frozenSummary),
      },
    });
    expect(claimed.claim.appendSystemPrompt).not.toMatch(/auto.?memory/iu);
    const storageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!storageManifest) {
      throw new Error("Expected recall-enabled Pi Storage mounts");
    }
    const memorySlotMounts = storageManifest.storageMounts.filter((mount) => {
      return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
    });
    expect(memorySlotMounts).toHaveLength(1);
    expect(memorySlotMounts[0]).toMatchObject({
      name: "memory",
      versionId: initialMemory.versionId,
      mountPath: PI_MEMORY_ROOT,
      missingRootPolicy: "preserveParentVersion",
      writeback: true,
      archiveUrl: expect.any(String),
    });
    expect(memorySlotMounts[0]).not.toHaveProperty("generatedBy");
    expect(storageManifest.storageMounts).not.toContainEqual(
      expect.objectContaining({
        mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
      }),
    );

    await cancelChatRun(actor, second.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("keeps an empty recall-enabled Pi memory mount valid", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const orgId = requireOrgId(actor);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    mockPiResourceArchiveDownloads(true);
    mockPiCheckpointObjectStore();
    await api.heartbeatRunner(runnerGroup);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "launch Pi with an absent memory Storage",
      model: "gpt-5.6-terra",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const storageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!storageManifest) {
      throw new Error("Expected empty recall-enabled Pi Storage mounts");
    }
    const memorySlotMounts = storageManifest.storageMounts.filter((mount) => {
      return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
    });
    expect(memorySlotMounts).toHaveLength(1);
    expect(memorySlotMounts[0]).toMatchObject({
      name: "memory",
      versionId: expect.any(String),
      mountPath: PI_MEMORY_ROOT,
      missingRootPolicy: "preserveParentVersion",
      writeback: true,
      empty: true,
    });
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memorySlotMounts[0]?.storageId,
        storageVersionId: memorySlotMounts[0]?.versionId,
      },
    });
    expect(memorySlotMounts[0]).not.toHaveProperty("archiveUrl");
    expect(memorySlotMounts[0]).not.toHaveProperty("generatedBy");

    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("keeps a frozen projection miss no-content after the projection becomes ready", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const summary =
      "# Delayed summary\n\nOnly a new Pi session may capture this.";
    const memory = await commitMemoryVersion(context, actor, [
      { path: "memory_summary.md", content: summary },
    ]);
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const requestBodies: string[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requestBodies.push(await request.text());
        return new HttpResponse(
          piResponsesToolSse({
            callId: `call_projection_epoch_${requestBodies.length}`,
            name: "read",
            arguments: { path: "/home/user/workspace/AGENTS.md" },
            sequence: requestBodies.length,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const frozenMiss = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "freeze the projection miss",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    const frozenMissManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${frozenMiss.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(frozenMissManifestKey);
      })
      .toBe(true);
    expect(piResponsesDeveloperPrompt(requestBodies[0])).not.toContain(summary);

    await seedReadyMemorySummaryProjection(context, actor, memory, summary);
    const frozenMissClaim = await claimChatRun(runnerGroup, frozenMiss.runId);
    expect(frozenMissClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
      },
    });

    const newSession = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture the now-ready projection in a new session",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    const newSessionManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${newSession.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(newSessionManifestKey);
      })
      .toBe(true);
    expect(
      occurrences(piResponsesDeveloperPrompt(requestBodies[1]), summary),
    ).toBe(1);
    const newSessionClaim = await claimChatRun(runnerGroup, newSession.runId);
    expect(newSessionClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
        content: summary,
      },
    });

    await Promise.all([
      cancelChatRun(actor, frozenMiss.runId, frozenMissClaim.sandboxHeaders),
      cancelChatRun(actor, newSession.runId, newSessionClaim.sandboxHeaders),
    ]);
  }, 90_000);

  it.each(GPT_PI_BDD_MODELS)(
    "keeps captured Codex admission after PiLoop turns on for %s",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution = await createGptUsagePricingResolution();
      await configureBuiltInPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          return new HttpResponse(piResponsesTextSse("baseline Pi answer", 0), {
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      const baseline = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "establish the captured Pi session family",
          model: selectedModel,
        },
        usagePricingResolution,
      );
      await waitForRunStatus(actor, baseline.runId, "completed", 10_000);
      await flushWaitUntilForTest();
      await expect(
        readRunLaunchSnapshotFixture(context, baseline.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "pi" },
      });
      const baselineBinding = await readThreadSessionBinding(
        context,
        baseline.threadId,
      );

      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: false },
      );
      const disabledGate = holdAgentRunPiExecutionSnapshotFixture({
        userId: actor.userId,
        orgId,
        signal: context.signal,
      });
      onTestFinished(disabledGate.release);
      const disabledSend = sendChatRun(actor, {
        agentId,
        threadId: baseline.threadId,
        prompt: "keep Codex after the switch turns on",
        model: selectedModel,
      });
      const disabledSnapshot = await disabledGate.arrival;
      expect(disabledSnapshot).toMatchObject({
        chatThreadId: baseline.threadId,
        piExecution: false,
        threadSessionCliAgentType: "codex",
      });
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      disabledGate.release();
      const disabled = await disabledSend;
      await flushWaitUntilForTest();
      const disabledClaim = await claimChatRun(runnerGroup, disabled.runId);
      expect(disabledClaim.claim.cliAgentType).toBe("codex");
      expect(disabledClaim.claim.piLaunchConfig).toBeUndefined();
      expect(
        expectCanonicalStorageManifest(
          disabledClaim.claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return mount.name === "memory";
        }),
      ).toStrictEqual([
        expect.objectContaining({
          mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
          missingRootPolicy: "preserveParentVersion",
        }),
      ]);
      await expect(
        readRunLaunchSnapshotFixture(context, disabled.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "codex" },
      });
      const disabledBinding = await readThreadSessionBinding(
        context,
        disabled.threadId,
      );
      expect(disabledBinding.agent_session_id).not.toBe(
        baselineBinding.agent_session_id,
      );
      await cancelChatRun(actor, disabled.runId, disabledClaim.sandboxHeaders);
    },
    90_000,
  );

  it("decodes persisted launch snapshots at webhook completion before Stage 1 admission", async () => {
    mockEnv("PI_MEMORY_STAGE1_IDLE_DELAY_MS", 60_000);
    const rejectedSnapshots = [
      ["historical null", null],
      [
        "V1 Pi",
        { schemaVersion: 1, framework: "pi", runnerProfile: DEFAULT_PROFILE },
      ],
      [
        "V2 Pi disabled with PiLoop enabled",
        {
          schemaVersion: 2,
          framework: "pi",
          runnerProfile: DEFAULT_PROFILE,
          piMemoryGenerationEnabled: false,
        },
      ],
      ...(["codex", "claude-code"] as const).flatMap((framework) => {
        return [true, false].map((piMemoryGenerationEnabled) => {
          return [
            `V2 ${framework} ${piMemoryGenerationEnabled ? "enabled" : "disabled"}`,
            {
              schemaVersion: 2 as const,
              framework,
              runnerProfile: DEFAULT_PROFILE,
              piMemoryGenerationEnabled,
            },
          ] as const;
        });
      }),
      ...(["codex", "claude-code"] as const).map((framework) => {
        return [
          `V3 ${framework}`,
          {
            schemaVersion: 3 as const,
            framework,
            runnerProfile: DEFAULT_PROFILE,
          },
        ] as const;
      }),
    ] as const;
    const admittedSnapshots = [
      [
        "V2 Pi enabled",
        {
          schemaVersion: 2,
          framework: "pi",
          runnerProfile: DEFAULT_PROFILE,
          piMemoryGenerationEnabled: true,
        },
      ],
      [
        "V3 Pi",
        { schemaVersion: 3, framework: "pi", runnerProfile: DEFAULT_PROFILE },
      ],
    ] as const;

    for (const [name, snapshot] of rejectedSnapshots) {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const run = await sendChatRun(actor, {
        agentId,
        prompt: `decode ${name} through the completion webhook`,
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      // Decode historical carriers with the current cohort enabled at completion.
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      await setRunLaunchSnapshotFixture(run.runId, snapshot);
      const completionOptions = frameworkMatchingCompletionOptions(
        run.threadId,
        snapshot?.framework ?? "claude-code",
      );
      await completeChatRunOk(
        run.runId,
        claimed.sandboxHeaders,
        completionOptions,
      );
      await flushWaitUntilForTest();
      const candidate = await readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      });
      expect({ name, candidate }).toStrictEqual({ name, candidate: null });
    }

    for (const [name, snapshot] of admittedSnapshots) {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const run = await sendChatRun(actor, {
        agentId,
        prompt: `decode ${name} through the completion webhook`,
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      // Decode historical carriers with the current cohort enabled at completion.
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      await setRunLaunchSnapshotFixture(run.runId, snapshot);
      const completionOptions = frameworkMatchingCompletionOptions(
        run.threadId,
        snapshot.framework,
      );
      await completeChatRunOk(
        run.runId,
        claimed.sandboxHeaders,
        completionOptions,
      );
      await flushWaitUntilForTest();
      const candidate = await readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      });
      if (!candidate) {
        throw new Error(`Expected ${name} to create a Stage 1 candidate`);
      }
      const expectedHistoryHash = createHash("sha256")
        .update(
          completionOptions.sessionHistory ??
            `bdd chat session history ${run.runId}`,
        )
        .digest("hex");
      expect({
        name,
        sourceRunId: candidate.sourceRunId,
        sourceHistoryHash: candidate.sourceHistoryHash,
        eligibilityDelayMs:
          candidate.eligibleAt.getTime() -
          candidate.sourceCompletedAt.getTime(),
      }).toStrictEqual({
        name,
        sourceRunId: run.runId,
        sourceHistoryHash: expectedHistoryHash,
        eligibilityDelayMs: 60_000,
      });

      await completeChatRunOk(
        run.runId,
        claimed.sandboxHeaders,
        completionOptions,
      );
      await flushWaitUntilForTest();
      const repeatedCandidate = await readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      });
      expect({
        name,
        sourceRunId: repeatedCandidate?.sourceRunId,
        sourceHistoryHash: repeatedCandidate?.sourceHistoryHash,
      }).toStrictEqual({
        name,
        sourceRunId: run.runId,
        sourceHistoryHash: candidate.sourceHistoryHash,
      });
    }
  }, 90_000);

  it("keeps failed and synthetic completions out of shared Pi learning", async () => {
    const cases = [
      ["failed status", {}, true],
      ["synthetic run", { triggerSource: "test" as const }, false],
    ] as const;
    for (const [name, inputs, fails] of cases) {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const run = await sendChatRun(actor, {
        agentId,
        prompt: `preserve ${name} completion exclusion`,
        model: "claude-sonnet-5",
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      await setRunLaunchSnapshotFixture(run.runId, {
        schemaVersion: 3,
        framework: "pi",
        runnerProfile: DEFAULT_PROFILE,
      });
      await setRunPiMemoryAdmissionInputsFixture(run.runId, inputs);
      if (fails) {
        await failChatRun(
          run.runId,
          claimed.sandboxHeaders,
          "expected failure",
        );
      } else {
        await completeChatRunOk(
          run.runId,
          claimed.sandboxHeaders,
          frameworkMatchingCompletionOptions(run.threadId, "pi"),
        );
      }
      await flushWaitUntilForTest();
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toBeNull();
    }
  }, 90_000);

  it("admits an exact Pi history from an agent-authenticated same-owner chat send", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await bdd.updateAgentMetadata(actor, agentId, { visibility: "public" });
    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate an eligible Pi memory turn",
      model: "claude-sonnet-5",
    });
    const sourceClaim = await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim.claim);
    const targetThread = await chat.createThread(actor, { agentId });

    const usagePricingResolution = await createGptUsagePricingResolution();
    mockEnv("PI_MEMORY_STAGE1_IDLE_DELAY_MS", 60_000);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        return new HttpResponse(
          piResponsesTextSse("delegated memory admission answer", 0, {
            input_tokens: 10,
            output_tokens: 3,
            total_tokens: 13,
            input_tokens_details: {
              cached_tokens: 3,
              cache_write_tokens: 2,
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const delegatedEventId = randomUUID();
    const delegated = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: delegatedEventId,
        threadId: targetThread.id,
        prompt: "learn this stable preference from delegated work",
        model: "gpt-5.6-terra",
      },
      [201],
      usagePricingResolution,
    );
    expect(delegated.status).toBe(201);
    if (delegated.status !== 201 || delegated.body.runId === null) {
      throw new Error("Expected the delegated Pi prompt to launch a run");
    }
    const delegatedRunId = delegated.body.runId;
    await waitForRunStatus(actor, delegatedRunId, "completed", 10_000);
    await flushWaitUntilForTest();
    await expectAgentChatProvenance({
      actor,
      agentId,
      delegatedEventId,
      delegatedRunId,
      orgId,
      source,
      targetThreadId: targetThread.id,
    });
    await expectExactPrivatePiMemoryAdmission({
      orgId,
      userId: actor.userId,
      runId: delegatedRunId,
    });
    await expectAgentTokenThreadOwnershipBoundaries({
      agentId,
      orgId,
      sourceToken,
    });

    await cancelChatRun(actor, source.runId, sourceClaim.sandboxHeaders);
  }, 90_000);

  it("admits exact owned Pi histories with immutable launch policy and stale-lease fencing", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    expect(piMemoryStage1AdmissionPrerequisiteSkipReasonFixture()).toBeNull();
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        status: "failed",
      }),
    ).toBe("not_completed");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        framework: "codex",
      }),
    ).toBe("not_pi");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        generationEnabled: false,
      }),
    ).toBe("generation_disabled");
    // Every product source must still own a Chat Thread. The actual
    // threadless Phase 2 maintenance route is covered by the boundary test.
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        chatThreadId: null,
      }),
    ).toBe("missing_chat_thread");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: "agent",
      }),
    ).toBeNull();
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: "agent",
        chatThreadId: null,
      }),
    ).toBe("missing_chat_thread");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: null,
      }),
    ).toBe("invalid_source");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: "unknown",
      }),
    ).toBe("invalid_source");
    for (const triggerSource of triggerSourceSchema.options) {
      expect(
        piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({ triggerSource }),
      ).toBe(triggerSource === "test" ? "synthetic_source" : null);
    }
    const usagePricingResolution = await createGptUsagePricingResolution();
    mockEnv("PI_MEMORY_STAGE1_IDLE_DELAY_MS", 60_000);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const answers = [
      "first memory admission answer",
      "replacement memory admission answer",
      "selection watermark replacement answer",
      "generation-disabled answer",
    ] as const;
    let modelCalls = 0;
    const firstProviderEntered = createDeferredPromise<void>(context.signal);
    const releaseFirstProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseFirstProvider.settled()) {
        releaseFirstProvider.resolve(undefined);
      }
    });
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        const answer = answers[modelCalls];
        if (!answer) {
          return HttpResponse.json(
            { error: "unexpected duplicate Pi memory model request" },
            { status: 500 },
          );
        }
        if (modelCalls === 0) {
          firstProviderEntered.resolve(undefined);
          await releaseFirstProvider.promise;
        }
        const response = new HttpResponse(
          piResponsesTextSse(answer, modelCalls, {
            input_tokens: 10,
            output_tokens: 3,
            total_tokens: 13,
            input_tokens_details: {
              cached_tokens: 3,
              cache_write_tokens: 2,
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
        modelCalls += 1;
        return response;
      }),
    );

    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture memory generation at launch",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    await firstProviderEntered.promise;
    await expect(
      readRunLaunchSnapshotFixture(context, first.runId),
    ).resolves.toMatchObject({
      launch_snapshot: {
        schemaVersion: 3,
        framework: "pi",
      },
    });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    releaseFirstProvider.resolve(undefined);
    await waitForRunStatus(actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    await expect(
      readRunLaunchSnapshotFixture(context, first.runId),
    ).resolves.toMatchObject({
      launch_snapshot: {
        schemaVersion: 3,
        framework: "pi",
      },
    });

    const firstConversation = await readPiConversationIdentityFixture(
      first.runId,
    );
    const firstCandidate = await readPiMemoryStage1CandidateFixture({
      orgId,
      userId: actor.userId,
    });
    if (!firstCandidate) {
      throw new Error("Expected first Pi memory candidate");
    }
    expect(firstCandidate).toMatchObject({
      memoryStorageName: "memory",
      piSessionId: firstConversation.piSessionId,
      sourceRunId: first.runId,
      sourceHistoryHash: firstConversation.sourceHistoryHash,
      status: "pending",
      retryCount: 0,
      usageCount: 0,
    });
    expect(firstCandidate.memoryStorageS3Prefix).toBe(
      `${orgId}/${firstCandidate.memoryStorageId}`,
    );
    expect(
      firstCandidate.eligibleAt.getTime() -
        firstCandidate.sourceCompletedAt.getTime(),
    ).toBe(60_000);
    await expect(
      readSessionHistoryBlobRefCountFixture(firstCandidate.sourceHistoryHash),
    ).resolves.toBe(2);

    const staleLeaseToken = randomUUID();
    await leasePiMemoryStage1CandidateFixture({
      memoryStorageId: firstCandidate.memoryStorageId,
      piSessionId: firstCandidate.piSessionId,
      sourceHistoryHash: firstCandidate.sourceHistoryHash,
      leaseToken: staleLeaseToken,
      leaseExpiresAt: new Date(now() + 60_000),
    });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    const second = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "replace the leased candidate with a newer exact history",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, second.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    const secondConversation = await readPiConversationIdentityFixture(
      second.runId,
    );
    const replacedCandidate = await readPiMemoryStage1CandidateFixture({
      orgId,
      userId: actor.userId,
    });
    if (!replacedCandidate) {
      throw new Error("Expected replacement Pi memory candidate");
    }
    expect(replacedCandidate).toMatchObject({
      memoryStorageId: firstCandidate.memoryStorageId,
      piSessionId: firstCandidate.piSessionId,
      sourceRunId: second.runId,
      sourceHistoryHash: secondConversation.sourceHistoryHash,
      status: "pending",
      leaseToken: null,
      leaseExpiresAt: null,
      retryCount: 0,
      rawMemory: null,
      rolloutSummary: null,
      generatedAt: null,
      usageCount: 0,
    });
    expect(replacedCandidate.sourceHistoryHash).not.toBe(
      firstCandidate.sourceHistoryHash,
    );
    await expect(
      readSessionHistoryBlobRefCountFixture(firstCandidate.sourceHistoryHash),
    ).resolves.toBe(1);
    await expect(
      readSessionHistoryBlobRefCountFixture(
        replacedCandidate.sourceHistoryHash,
      ),
    ).resolves.toBe(2);

    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: firstCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: firstCandidate.piSessionId,
        sourceHistoryHash: firstCandidate.sourceHistoryHash,
        leaseToken: staleLeaseToken,
        committedAt: nowDate(),
        result: { kind: "succeeded_no_output" },
      }),
    ).resolves.toBeFalsy();
    await expect(
      readmitPiMemoryStage1CandidateFixture(second.runId),
    ).resolves.toMatchObject({ outcome: "exact_retry" });
    const afterExactRetry = await readPiMemoryStage1CandidateFixture({
      orgId,
      userId: actor.userId,
    });
    expect(afterExactRetry?.updatedAt).toStrictEqual(
      replacedCandidate.updatedAt,
    );

    const currentLeaseToken = randomUUID();
    const currentLeaseExpiresAt = new Date(now() + 60_000);
    await leasePiMemoryStage1CandidateFixture({
      memoryStorageId: replacedCandidate.memoryStorageId,
      piSessionId: replacedCandidate.piSessionId,
      sourceHistoryHash: replacedCandidate.sourceHistoryHash,
      leaseToken: currentLeaseToken,
      leaseExpiresAt: currentLeaseExpiresAt,
    });
    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: replacedCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: replacedCandidate.piSessionId,
        sourceHistoryHash: replacedCandidate.sourceHistoryHash,
        leaseToken: currentLeaseToken,
        committedAt: currentLeaseExpiresAt,
        result: { kind: "succeeded_no_output" },
      }),
    ).resolves.toBeFalsy();
    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: replacedCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: replacedCandidate.piSessionId,
        sourceHistoryHash: replacedCandidate.sourceHistoryHash,
        leaseToken: currentLeaseToken,
        committedAt: nowDate(),
        result: { kind: "succeeded_no_output" },
      }),
    ).resolves.toBeTruthy();
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toMatchObject({
      status: "succeeded_no_output",
      rawMemory: null,
      rolloutSummary: null,
      lastSelectedSourceHistoryHash: null,
    });

    await setSyntheticPiMemoryStage1SelectionFixture({
      memoryStorageId: replacedCandidate.memoryStorageId,
      piSessionId: replacedCandidate.piSessionId,
      sourceHistoryHash: replacedCandidate.sourceHistoryHash,
    });
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toMatchObject({
      lastSelectedSourceHistoryHash: replacedCandidate.sourceHistoryHash,
    });

    const third = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "replace the synthetic Phase 2 selection watermark",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, third.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    const thirdConversation = await readPiConversationIdentityFixture(
      third.runId,
    );
    const thirdCandidate = await readPiMemoryStage1CandidateFixture({
      orgId,
      userId: actor.userId,
    });
    if (!thirdCandidate) {
      throw new Error("Expected third Pi memory candidate generation");
    }
    expect(thirdCandidate).toMatchObject({
      memoryStorageId: replacedCandidate.memoryStorageId,
      piSessionId: replacedCandidate.piSessionId,
      sourceRunId: third.runId,
      sourceHistoryHash: thirdConversation.sourceHistoryHash,
      status: "pending",
      rawMemory: null,
      rolloutSummary: null,
      generatedAt: null,
      lastSelectedSourceHistoryHash: null,
    });
    expect(thirdCandidate.sourceHistoryHash).not.toBe(
      replacedCandidate.sourceHistoryHash,
    );
    await expect(
      readSessionHistoryBlobRefCountFixture(
        replacedCandidate.sourceHistoryHash,
      ),
    ).resolves.toBe(1);
    await expect(
      readSessionHistoryBlobRefCountFixture(thirdCandidate.sourceHistoryHash),
    ).resolves.toBe(2);

    const thirdLeaseToken = randomUUID();
    await leasePiMemoryStage1CandidateFixture({
      memoryStorageId: thirdCandidate.memoryStorageId,
      piSessionId: thirdCandidate.piSessionId,
      sourceHistoryHash: thirdCandidate.sourceHistoryHash,
      leaseToken: thirdLeaseToken,
      leaseExpiresAt: new Date(now() + 60_000),
    });
    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: thirdCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: thirdCandidate.piSessionId,
        sourceHistoryHash: thirdCandidate.sourceHistoryHash,
        leaseToken: currentLeaseToken,
        committedAt: nowDate(),
        result: { kind: "succeeded_no_output" },
      }),
    ).resolves.toBeFalsy();
    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: thirdCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: thirdCandidate.piSessionId,
        sourceHistoryHash: thirdCandidate.sourceHistoryHash,
        leaseToken: thirdLeaseToken,
        committedAt: nowDate(),
        result: {
          kind: "succeeded",
          rawMemory: "bounded raw memory",
          rolloutSummary: "bounded rollout summary",
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toMatchObject({
      status: "succeeded",
      rawMemory: "bounded raw memory",
      rolloutSummary: "bounded rollout summary",
      lastSelectedSourceHistoryHash: null,
    });

    await deletePiMemoryStorageFixture(thirdCandidate.memoryStorageId);
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toBeNull();
    await expect(
      readSessionHistoryBlobRefCountFixture(thirdCandidate.sourceHistoryHash),
    ).resolves.toBe(1);
  }, 90_000);

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return (["openai", "openrouter"] as const).map((provider) => {
        return {
          selectedModel,
          provider,
        };
      });
    }),
  )(
    "bills built-in $selectedModel on $provider at both canonical input boundaries and tiers",
    async ({ selectedModel, provider }) => {
      const { actor, agentId } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      const threshold =
        MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[selectedModel];
      if (threshold === undefined) {
        throw new Error(
          `Expected a long-context threshold for ${selectedModel}`,
        );
      }
      let withRoute = async <T>(work: () => Promise<T>): Promise<T> => {
        return await work();
      };
      if (provider === "openrouter") {
        withRoute = await configureBuiltInPiModelOnOpenRouter(
          actor,
          selectedModel,
        );
      } else {
        await configureBuiltInPiModel(actor, selectedModel);
      }
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.CodexFastMode]: true,
      });
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const endpoint =
        provider === "openai"
          ? "https://api.openai.com/v1/responses"
          : "https://openrouter.ai/api/v1/responses";
      const upstreamModel =
        provider === "openai" ? selectedModel : `openai/${selectedModel}`;
      const requests: unknown[] = [];
      for (const tier of [undefined, "fast"] as const) {
        for (const totalInput of [threshold - 1, threshold]) {
          server.use(
            http.post(endpoint, async ({ request }) => {
              requests.push(await request.json());
              return nativeCodexSseResponse(
                piResponsesTextSse(
                  "accounted response",
                  requests.length,
                  {
                    input_tokens: totalInput,
                    output_tokens: 3,
                    total_tokens: totalInput + 3,
                    input_tokens_details: {
                      cached_tokens: 3,
                      cache_write_tokens: 2,
                    },
                  },
                  tier === "fast" ? "priority" : "default",
                ),
              );
            }),
          );
          const run = await withRoute(async () => {
            return await sendChatRun(
              actor,
              {
                agentId,
                prompt: `bill ${selectedModel} at ${totalInput} total input`,
                model: selectedModel,
                runOptions: { codexServiceTier: tier },
              },
              usagePricingResolution,
            );
          });
          await waitForRunStatus(actor, run.runId, "completed");
          await flushWaitUntilForTest();
          const longContext = totalInput === threshold;
          const suffix = longContext
            ? tier === "fast"
              ? ".long_context.fast"
              : ".long_context"
            : tier === "fast"
              ? ".fast"
              : "";
          await expectPiApiUsage(run.runId, selectedModel, suffix, {
            input: totalInput - 5,
            output: 3,
            cacheRead: 3,
            cacheCreation: 2,
          });
          expect(requests.at(-1)).toMatchObject({
            model: upstreamModel,
            reasoning: { effort: "max" },
            store: false,
          });
          if (tier === undefined) {
            expect(requests.at(-1)).not.toHaveProperty("service_tier");
          } else {
            expect(requests.at(-1)).toMatchObject({ service_tier: "priority" });
          }
          await expect(
            readRunLaunchSnapshotFixture(context, run.runId),
          ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
        }
      }
      expect(requests).toHaveLength(4);
    },
    90_000,
  );

  it.each([
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    ...GPT_PI_BDD_MODELS,
  ] as const)(
    "runs the Pi API first turn once for %s and resumes canonical JSONL",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      const orgId = actor.orgId;
      if (!orgId) {
        throw new Error("Expected entitled chat actor to have an org");
      }
      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.ChatReasoningEffort]: true,
        },
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const modelRequests: {
        readonly body: unknown;
      }[] = [];
      const modelAnswers = [
        `first API answer for ${selectedModel}`,
        `second API answer for ${selectedModel}`,
      ];
      const providerUrl = selectedModel.startsWith("gpt-")
        ? "https://api.openai.com/v1/responses"
        : "https://api.deepseek.com/responses";
      server.use(
        http.post(providerUrl, async ({ request }) => {
          const sequence = modelRequests.length;
          modelRequests.push({
            body: await request.json(),
          });
          const answer = modelAnswers[sequence];
          if (!answer) {
            return HttpResponse.json(
              { error: "unexpected duplicate Pi model request" },
              { status: 500 },
            );
          }
          const usage =
            sequence === 0
              ? {
                  input_tokens: 10,
                  output_tokens: 3,
                  total_tokens: 13,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                }
              : undefined;
          return new HttpResponse(
            usage
              ? piResponsesTextSse(answer, sequence, usage)
              : piResponsesTextSse(answer, sequence),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        }),
      );
      const firstPrompt = "persist this turn in the native Pi session";
      const first = await sendChatRun(
        actor,
        {
          agentId,
          prompt: firstPrompt,
          model: selectedModel,
          runOptions: { reasoningEffort: "max" },
        },
        usagePricingResolution,
      );
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      await expect(
        readRunLaunchSnapshotFixture(context, first.runId),
      ).resolves.toStrictEqual({
        exists: true,
        launch_snapshot: {
          schemaVersion: 3,
          framework: "pi",
          runnerProfile: DEFAULT_PROFILE,
        },
      });
      expect(modelRequests).toHaveLength(1);
      expect(modelRequests[0]?.body).toMatchObject({
        reasoning: { effort: "max" },
      });
      const firstModelInput = JSON.stringify(modelRequests[0]?.body);
      expect(occurrences(firstModelInput, firstPrompt)).toBe(1);
      expect(occurrences(firstModelInput, modelAnswers[0] ?? "")).toBe(0);
      // The first GET validates the just-written native H1 before canonical
      // checkpoint promotion; there is no H0 to download on a new thread.
      expect(s3GetObjectCommandCalls()).toHaveLength(1);
      const firstManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${first.runId}/manifest.json`;
      const firstSessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${first.runId}/session.jsonl`;
      const firstSessionEntry = [...checkpointObjects.entries()].find(
        ([key]) => {
          return key.includes("/blobs/");
        },
      );
      const firstSessionBytes = firstSessionEntry?.[1];
      expect(checkpointObjects.has(firstManifestKey)).toBeFalsy();
      expect(checkpointObjects.has(firstSessionKey)).toBeFalsy();
      if (!firstSessionBytes) {
        throw new Error("Expected the first Pi run to persist native H1");
      }
      await expectPiApiFirstTurnUsage(
        first.runId,
        firstSessionBytes,
        selectedModel,
      );
      expect(firstSessionBytes.toString("utf8")).toContain(first.threadId);
      expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
        `runner-group:${runnerGroup}`,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
        runId: first.runId,
        mode: "hard",
      });
      const firstClaim = await api.requestClaimRunnerJob(
        true,
        first.runId,
        [404],
      );
      expect(firstClaim.status).toBe(404);

      await chat.updateThreadModelSelection(
        actor,
        first.threadId,
        selectedModel,
        { reasoningEffort: "high" },
      );
      const secondPrompt = "continue the same Pi session";
      const second = await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: secondPrompt,
        },
        usagePricingResolution,
      );
      await waitForRunStatus(actor, second.runId, "completed");
      await flushWaitUntilForTest();
      expect(modelRequests).toHaveLength(2);
      expect(modelRequests[1]?.body).toMatchObject({
        reasoning: { effort: "high" },
      });
      await expect(
        chat.readThreadMetadata(actor, first.threadId),
      ).resolves.toMatchObject({
        modelSettings: { [selectedModel]: { effort: "high" } },
      });
      await expectPiApiUsage(second.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const secondModelInput = JSON.stringify(modelRequests[1]?.body);
      expect(occurrences(secondModelInput, firstPrompt)).toBe(1);
      expect(occurrences(secondModelInput, modelAnswers[0] ?? "")).toBe(1);
      expect(occurrences(secondModelInput, secondPrompt)).toBe(1);
      expect(occurrences(secondModelInput, modelAnswers[1] ?? "")).toBe(0);
      // Follow-up adds one H0 restore and one strict H1 promotion check.
      expect(s3GetObjectCommandCalls()).toHaveLength(3);
      const secondManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`;
      expect(checkpointObjects.has(secondManifestKey)).toBeFalsy();
      expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
        runId: second.runId,
        mode: "hard",
      });
      const secondClaim = await api.requestClaimRunnerJob(
        true,
        second.runId,
        [404],
      );
      expect(secondClaim.status).toBe(404);
    },
    90_000,
  );

  it.each([
    {
      selectedModel: "deepseek-v4-flash",
      upstreamModel: "company-deepseek-flash-production",
    },
    {
      selectedModel: "deepseek-v4-pro",
      upstreamModel: "company-deepseek-pro-production",
    },
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return {
        selectedModel,
        upstreamModel: `company-${selectedModel}-production`,
      };
    }),
  ] as const)(
    "runs custom Responses gateway $selectedModel through Pi without built-in model billing",
    async ({ selectedModel, upstreamModel }) => {
      const { actor, agentId } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      await configureCustomPiModel(actor, selectedModel, upstreamModel);
      if (selectedModel === "deepseek-v4-pro") {
        // Snapshot availability must not block an admitted Pi provider request.
        context.mocks.axiom.ingest.mockImplementation((dataset) => {
          if (dataset === "run-context") {
            throw new Error("run-context ingest failed");
          }
          return true;
        });
      }
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const modelRequests: {
        readonly body: unknown;
        readonly authorization: string | null;
        readonly apiKey: string | null;
      }[] = [];
      server.use(
        http.post(
          "https://pi-custom-gateway.example.com/openai/v1/responses",
          async ({ request }) => {
            modelRequests.push({
              body: await request.json(),
              authorization: request.headers.get("authorization"),
              apiKey: request.headers.get("x-api-key"),
            });
            return new HttpResponse(
              piResponsesTextSse(
                `custom gateway answer for ${selectedModel}`,
                modelRequests.length - 1,
                {
                  input_tokens: 10,
                  output_tokens: 3,
                  total_tokens: 13,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                },
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: `route ${selectedModel} through the custom Pi gateway`,
          model: selectedModel,
        },
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      await waitForRunStatus(actor, run.runId, "completed");

      await expect(
        readRunLaunchSnapshotFixture(context, run.runId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "pi" },
      });
      expect(modelRequests).toStrictEqual([
        {
          body: expect.objectContaining({
            model: upstreamModel,
            ...(selectedModel.startsWith("gpt-")
              ? { reasoning: expect.objectContaining({ effort: "max" }) }
              : {}),
          }),
          authorization: null,
          apiKey: "Key custom-pi-gateway-secret",
        },
      ]);
      expect(modelRequests[0]?.body).not.toHaveProperty("service_tier");
      await expectNoBuiltInModelUsage(run.runId);
      if (selectedModel.startsWith("gpt-")) {
        const firstSession = await readThreadSessionConversation(
          context,
          run.threadId,
        );
        for (const tier of ["fast", undefined] as const) {
          await chat.updateThreadModelSelection(
            actor,
            run.threadId,
            selectedModel,
            {
              codexServiceTier: tier ?? null,
            },
          );
          const continuation = await sendChatRun(
            actor,
            {
              agentId,
              threadId: run.threadId,
              model: selectedModel,
              prompt: `continue the custom session with ${tier ?? "standard"}`,
              runOptions: { codexServiceTier: tier },
            },
            usagePricingResolution,
          );
          await flushWaitUntilForTest();
          await waitForRunStatus(actor, continuation.runId, "completed");
          expect(modelRequests.at(-1)).toMatchObject({
            body: {
              model: upstreamModel,
              reasoning: { effort: "max" },
              store: false,
            },
            authorization: null,
            apiKey: "Key custom-pi-gateway-secret",
          });
          if (tier === "fast") {
            expect(modelRequests.at(-1)?.body).toMatchObject({
              service_tier: "priority",
            });
          } else {
            expect(modelRequests.at(-1)?.body).not.toHaveProperty(
              "service_tier",
            );
          }
          expect(JSON.stringify(modelRequests.at(-1)?.body)).toContain(
            `custom gateway answer for ${selectedModel}`,
          );
          await expect(
            readThreadSessionConversation(context, run.threadId),
          ).resolves.toMatchObject({
            agent_session_id: firstSession.agent_session_id,
            conversation_run_id: continuation.runId,
          });
          await expectNoBuiltInModelUsage(continuation.runId);
          const claim = await api.requestClaimRunnerJob(
            true,
            continuation.runId,
            [404],
          );
          expectApiError(claim.body);
        }
        expect(modelRequests).toHaveLength(3);
      }
    },
    90_000,
  );

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return [
        { selectedModel, tier: undefined, outcome: "completed" },
        { selectedModel, tier: "fast", outcome: "completed" },
        { selectedModel, tier: "fast", outcome: "failed" },
        { selectedModel, tier: "fast", outcome: "cancelled" },
      ] as const;
    }),
  )(
    "keeps custom $selectedModel $tier legacy handoff, captured policy, and $outcome settlement unbilled",
    async ({ selectedModel, tier, outcome }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const firewall = createFirewallApi(context);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        body: unknown;
        authorization: string | null;
        apiKey: string | null;
      }[] = [];
      server.use(
        http.post(gateway.endpoint, async ({ request }) => {
          requests.push({
            body: await request.json(),
            authorization: request.headers.get("authorization"),
            apiKey: request.headers.get("x-api-key"),
          });
          return nativeCodexSseResponse(
            piResponsesContentSse({
              blocks: [
                {
                  type: "toolCall",
                  callId: "call_custom",
                  name: "read",
                  arguments: { path: "/home/user/workspace/AGENTS.md" },
                },
              ],
              sequence: requests.length,
            }),
          );
        }),
      );
      const run = await sendChatRun(
        actor,
        {
          agentId,
          model: selectedModel,
          prompt: "hand off custom gateway tools exactly once",
          runOptions: { codexServiceTier: tier },
        },
        usagePricingResolution,
      );
      const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}`;
      await expect
        .poll(() => {
          return objects.has(`${prefix}/manifest.json`);
        })
        .toBe(true);
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: null,
        apiKey: `Key ${gateway.secret}`,
        body: {
          model: gateway.upstreamModel,
          reasoning: { effort: "max" },
          store: false,
        },
      });
      if (tier === "fast") {
        expect(requests[0]?.body).toMatchObject({ service_tier: "priority" });
      } else {
        expect(requests[0]?.body).not.toHaveProperty("service_tier");
      }
      await expectNoBuiltInModelUsage(run.runId);

      await accept(
        setupApp({ context, routes: modelProviderGatewayRoutes })(
          modelProviderConnectionsByIdContract,
        ).update({
          headers: sessionHeaders(actor),
          params: { id: gateway.connection.id },
          body: {
            displayName: gateway.connection.displayName,
            secret: "custom-pi-gateway-rotated-secret",
            surfaces: [
              {
                ...gateway.surface,
                apiBaseUrl: "https://rotated-pi-custom-gateway.example.com/v2",
                authHeaderName: "Authorization",
                authHeaderTemplate: "Bearer {{secret}}",
                modelMappings: { [selectedModel]: "rotated-upstream-alias" },
              },
            ],
          },
        }),
        [200],
      );
      // Mutating current settings after API ownership cannot rewrite the captured claim.
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: false,
        [FeatureSwitchKey.CodexFastMode]: false,
      });
      await chat.updateThreadModelSelection(
        actor,
        run.threadId,
        selectedModel,
        { codexServiceTier: null },
      );
      await configureBuiltInPiModel(actor, selectedModel);
      await api.heartbeatRunner(runnerGroup);
      // The existing custom legacy carrier also works for claimants without generation capabilities.
      const claimResponse = await api.requestClaimRunnerJob(
        true,
        run.runId,
        [200],
      );
      if (claimResponse.status !== 200) {
        throw new Error("Expected the custom legacy claim");
      }
      const claim = claimResponse.body;
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piSessionId).toBe(run.threadId);
      expect(claim.piModelConfig).toStrictEqual({
        provider: "openai",
        baseUrl: gateway.surface.apiBaseUrl,
        model: gateway.upstreamModel,
        catalogModel: selectedModel,
        thinkingLevel: "max",
        ...(tier === undefined ? {} : { serviceTier: "priority" }),
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OKOU_MODEL_PROVIDER_API_KEY",
        credentialHeader: {
          name: "x-api-key",
          valueTemplate: "Key {{secret}}",
        },
      });
      expect(claim.billableFirewalls).toStrictEqual([]);
      expect(claim.firewalls).toContainEqual({
        kind: "inline",
        firewall: expect.objectContaining({
          name: `model-provider-surface:${gateway.surfaceId}`,
          apis: [
            expect.objectContaining({
              base: gateway.endpoint,
              auth: {
                headers: {
                  "x-api-key": `Key ${secretTemplate("OKOU_MODEL_PROVIDER_API_KEY")}`,
                },
              },
            }),
          ],
        }),
      });
      expect(claimEnvironment(claim)).toMatchObject({
        OPENAI_BASE_URL: gateway.surface.apiBaseUrl,
        OPENAI_MODEL: gateway.upstreamModel,
        OPENAI_API_KEY: MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
      });
      expect(JSON.stringify(claim)).not.toContain(gateway.secret);
      if (!claim.encryptedSecrets) {
        throw new Error("Expected captured custom credentials");
      }
      const resolved = await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            "x-api-key": `Key ${secretTemplate("OKOU_MODEL_PROVIDER_API_KEY")}`,
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      expect(resolved.body).toMatchObject({
        headers: { "x-api-key": `Key ${gateway.secret}` },
        resolvedSecrets: ["OKOU_MODEL_PROVIDER_API_KEY"],
      });
      expect(resolved.body).not.toHaveProperty("headers.Authorization");

      const h1 = objects.get(`${prefix}/session.jsonl`);
      const manifestBytes = objects.get(`${prefix}/manifest.json`);
      if (!h1 || !manifestBytes) {
        throw new Error("Expected custom handoff artifacts");
      }
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(manifestBytes.toString("utf8")),
      );
      const history = MemoryPiSession.fromJsonl(h1.toString("utf8"));
      const assistant = history.buildSessionContext().messages.at(-1);
      if (assistant?.role !== "assistant") {
        throw new Error("Expected pending custom assistant");
      }
      const tool = assistant.content.find((block) => {
        return block.type === "toolCall";
      });
      if (tool?.type !== "toolCall") {
        throw new Error("Expected pending custom tool");
      }
      history.appendMessage({
        role: "toolResult",
        toolCallId: tool.id,
        toolName: tool.name,
        content: [{ type: "text", text: "custom tool output" }],
        isError: false,
        timestamp: 2,
      });
      history.appendMessage({
        ...assistant,
        content: [{ type: "text", text: "custom Sandbox completion" }],
        stopReason: "stop",
        timestamp: 3,
      });
      const h2 = history.toJsonl();
      const h2Hash = createHash("sha256").update(h2).digest("hex");
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: h2Hash,
          rawSize: Buffer.byteLength(h2),
          encodedSize: Buffer.byteLength(h2),
          encoding: "identity",
        },
        sandboxHeaders,
        [200],
      );
      objects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
        Buffer.from(h2, "utf8"),
      );
      const sequence = manifest.sandboxEventSequenceStart;
      await webhooks.requestAgentEvents(
        {
          runId: run.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: sequence,
              message: {
                content: [{ type: "text", text: "custom Sandbox completion" }],
              },
            },
            {
              type: "result",
              sequenceNumber: sequence + 1,
              result: "custom Sandbox completion",
            },
          ],
        },
        sandboxHeaders,
        [200],
      );
      if (outcome === "cancelled") {
        await cancelChatRun(actor, run.runId);
      }
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: outcome === "failed" ? 1 : 0,
          ...(outcome === "failed" ? { error: "custom Sandbox failed" } : {}),
          lastEventSequence: sequence + 1,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryHash: h2Hash,
          },
        },
        sandboxHeaders,
        outcome === "cancelled" ? [400] : [200],
        undefined,
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, outcome);
      await flushWaitUntilForTest();
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
        undefined,
        usagePricingResolution,
      );
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: outcome,
      });
      expect(requests).toHaveLength(1);
      await expectNoBuiltInModelUsage(run.runId);
      expect(h2).not.toMatch(/serviceTier|service_tier/);
      expect(
        JSON.stringify({
          h2,
          events: (await chat.listThreadEvents(actor, run.threadId)).events,
        }),
      ).not.toContain(gateway.secret);
    },
    90_000,
  );

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return [400, 401].map((status) => {
        return { selectedModel, status };
      });
    }),
  )(
    "preserves custom $selectedModel Fast rejection $status without downgrade or an API retry",
    async ({ selectedModel, status }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        url: string;
        body: unknown;
        apiKey: string | null;
        authorization: string | null;
      }[] = [];
      server.use(
        ...[
          gateway.endpoint,
          ...new Set(
            USER_OWNED_GPT_FAST_BDD_ROUTES.map((route) => {
              return route.endpoint;
            }),
          ),
        ].map((endpoint) => {
          return http.post(endpoint, async ({ request }) => {
            requests.push({
              url: request.url,
              body: await readCodexRequestJson(request),
              apiKey: request.headers.get("x-api-key"),
              authorization: request.headers.get("authorization"),
            });
            return HttpResponse.json(
              {
                error: {
                  code:
                    status === 400
                      ? "unsupported_service_tier"
                      : "invalid_api_key",
                  message: `gateway rejected priority: ${gateway.secret}`,
                },
              },
              { status },
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: selectedModel,
        prompt: "surface the custom Fast rejection",
        runOptions: { codexServiceTier: "fast" },
      });
      if (status === 400) {
        await flushWaitUntilForTest();
        const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
        const manifest = piApiFirstTurnManifestSchema.parse(
          JSON.parse(objects.get(manifestKey)?.toString("utf8") ?? "{}"),
        );
        expect(manifest).toMatchObject({
          outcome: "ownership-transfer",
          mode: "sandbox-first",
        });
        const claimed = await api.claimRunnerJob(run.runId, {
          capabilities: { piModelConfigGenerations: [1, 2, 3] },
        });
        expect(claimed.piModelConfig).toMatchObject({
          serviceTier: "priority",
          model: gateway.upstreamModel,
        });
        await failChatRun(
          run.runId,
          { authorization: `Bearer ${claimed.sandboxToken}` },
          "Sandbox rejected priority",
        );
      }
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(requests).toStrictEqual([
        {
          url: gateway.endpoint,
          apiKey: `Key ${gateway.secret}`,
          authorization: null,
          body: expect.objectContaining({
            model: gateway.upstreamModel,
            service_tier: "priority",
            reasoning: expect.objectContaining({ effort: "max" }),
          }),
        },
      ]);
      const failed = await api.readRun(actor, run.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining(
          status === 401
            ? "[PI_API_MODEL_FAILED]"
            : "Sandbox rejected priority",
        ),
      });
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expectApiError(claim.body);
      await expectNoBuiltInModelUsage(run.runId);
      if (status === 401) {
        expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      }
      expect(
        JSON.stringify({
          failed,
          events: (await chat.listThreadEvents(actor, run.threadId)).events,
        }),
      ).not.toContain(gateway.secret);
    },
    90_000,
  );

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return ["mapping", "connection"].map((removed) => {
        return { selectedModel, removed };
      });
    }),
  )(
    "fails custom $selectedModel Fast when its $removed disappears before credential capture",
    async ({ selectedModel, removed }) => {
      const { actor, agentId } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      const gate = holdAgentRunPiExecutionSnapshotFixture({
        userId: actor.userId,
        orgId: requireOrgId(actor),
        signal: context.signal,
      });
      onTestFinished(gate.release);
      const requests: string[] = [];
      server.use(
        ...[
          gateway.endpoint,
          ...new Set(
            USER_OWNED_GPT_FAST_BDD_ROUTES.map((route) => {
              return route.endpoint;
            }),
          ),
        ].map((endpoint) => {
          return http.post(endpoint, ({ request }) => {
            requests.push(request.url);
            return nativeCodexSseResponse(
              piResponsesTextSse("unexpected substituted request", 0),
            );
          });
        }),
      );
      const sent = chat.requestSendEvent(
        actor,
        {
          agentId,
          clientEventId: randomUUID(),
          model: selectedModel,
          prompt: "fail the unavailable custom route before any model call",
          runOptions: { codexServiceTier: "fast" },
        },
        [503],
      );
      await expect(gate.arrival).resolves.toMatchObject({ piExecution: true });
      const connection = setupApp({
        context,
        routes: modelProviderGatewayRoutes,
      })(modelProviderConnectionsByIdContract);
      if (removed === "connection") {
        await accept(
          connection.delete({
            headers: sessionHeaders(actor),
            params: { id: gateway.connection.id },
          }),
          [204],
        );
      } else {
        await accept(
          connection.update({
            headers: sessionHeaders(actor),
            params: { id: gateway.connection.id },
            body: {
              displayName: gateway.connection.displayName,
              surfaces: [
                {
                  ...gateway.surface,
                  modelMappings: { "gpt-6-astra": "unrelated-upstream-alias" },
                },
              ],
            },
          }),
          [200],
        );
      }
      gate.release();
      const rejected = await sent;
      await flushWaitUntilForTest();
      expect(rejected.body).toMatchObject({
        error: { code: "PROVIDER_UNAVAILABLE" },
      });
      expect(requests).toStrictEqual([]);
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "preserves captured custom %s Fast credentials after gateway removal without substitution",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const gateway = await configureCustomPiModel(actor, selectedModel);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        url: string;
        body: unknown;
        apiKey: string | null;
        authorization: string | null;
      }[] = [];
      server.use(
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          const objectKey = new URL(request.url).searchParams.get("object");
          if (!objectKey) {
            throw new Error("Expected Pi archive identity");
          }
          return new HttpResponse(piS3Object(objectKey), {
            headers: { "content-type": "application/gzip" },
          });
        }),
        ...[
          gateway.endpoint,
          ...new Set(
            USER_OWNED_GPT_FAST_BDD_ROUTES.map((route) => {
              return route.endpoint;
            }),
          ),
        ].map((endpoint) => {
          return http.post(endpoint, async ({ request }) => {
            requests.push({
              url: request.url,
              body: await readCodexRequestJson(request),
              apiKey: request.headers.get("x-api-key"),
              authorization: request.headers.get("authorization"),
            });
            return nativeCodexSseResponse(
              piResponsesTextSse("captured custom credential", requests.length),
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: selectedModel,
        prompt: "retain the captured custom credential authority",
        runOptions: { codexServiceTier: "fast" },
      });
      await entered.promise;
      await accept(
        setupApp({ context, routes: modelProviderGatewayRoutes })(
          modelProviderConnectionsByIdContract,
        ).delete({
          headers: sessionHeaders(actor),
          params: { id: gateway.connection.id },
        }),
        [204],
      );
      release.resolve(undefined);
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "completed",
      });
      expect(requests).toStrictEqual([
        {
          url: gateway.endpoint,
          body: expect.objectContaining({
            model: gateway.upstreamModel,
            service_tier: "priority",
          }),
          apiKey: `Key ${gateway.secret}`,
          authorization: null,
        },
      ]);
      await expectNoBuiltInModelUsage(run.runId);
      for (const bytes of objects.values()) {
        expect(bytes.toString("utf8")).not.toContain(gateway.secret);
      }
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expectApiError(claim.body);
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "promotes queued custom %s Fast with the admitted tier and switch snapshot",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the target thread",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      const gateway = await configureCustomPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(gateway.endpoint, async ({ request }) => {
          expect(request.headers.get("x-api-key")).toBe(
            `Key ${gateway.secret}`,
          );
          expect(request.headers.get("authorization")).toBeNull();
          requests.push(await request.json());
          return nativeCodexSseResponse(
            piResponsesTextSse("queued custom answer", requests.length),
          );
        }),
      );
      const queuedId = randomUUID();
      const queued = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          clientEventId: queuedId,
          model: selectedModel,
          prompt: "queued custom Fast",
          runOptions: { codexServiceTier: "fast" },
        },
        [201],
      );
      if (queued.status !== 201) {
        throw new Error("Expected a queued custom send");
      }
      expect(queued.body.runId).toBeNull();
      const gate = holdAgentRunPiExecutionSnapshotFixture({
        userId: actor.userId,
        orgId: requireOrgId(actor),
        signal: context.signal,
      });
      onTestFinished(gate.release);
      chatCallbacks.mockChatOutputEvents([]);
      const completion = completeChatRunOk(
        anchor.runId,
        anchorClaim.sandboxHeaders,
      );
      const snapshot = await gate.arrival;
      expect(snapshot).toMatchObject({
        chatThreadId: anchor.threadId,
        piExecution: true,
        threadSessionCliAgentType: "pi",
      });
      // Promotion reads the current thread selection, then owns that snapshot.
      await chat.updateThreadModelSelection(
        actor,
        anchor.threadId,
        selectedModel,
        { codexServiceTier: null },
      );
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: false,
        [FeatureSwitchKey.CodexFastMode]: false,
      });
      gate.release();
      await completion;
      const messages = await waitForThreadMessages(
        actor,
        anchor.threadId,
        (events) => {
          return userMessages(events).some((event) => {
            return (
              event.revokesEventId === queuedId && event.runId !== undefined
            );
          });
        },
      );
      const promoted = userMessages(messages.events).find((event) => {
        return event.revokesEventId === queuedId;
      });
      if (!promoted?.runId) {
        throw new Error("Expected a promoted custom run");
      }
      await waitForRunStatus(actor, promoted.runId, "completed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: gateway.upstreamModel,
        service_tier: "priority",
        reasoning: { effort: "max" },
      });
      expect(
        occurrences(JSON.stringify(requests[0]), "queued custom Fast"),
      ).toBe(1);
      await expectNoBuiltInModelUsage(promoted.runId);
      await expect(
        readRunLaunchSnapshotFixture(context, promoted.runId),
      ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
      const claim = await api.requestClaimRunnerJob(
        true,
        promoted.runId,
        [404],
      );
      expectApiError(claim.body);
    },
    90_000,
  );

  it.each(
    GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return ["in-flight", "late-result"].map((phase) => {
        return { selectedModel, phase };
      });
    }),
  )(
    "keeps cancelled custom $selectedModel Fast $phase unbilled and unreplayed",
    async ({ selectedModel, phase }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const requests: unknown[] = [];
      server.use(
        http.post(gateway.endpoint, async ({ request }) => {
          expect(request.headers.get("x-api-key")).toBe(
            `Key ${gateway.secret}`,
          );
          expect(request.headers.get("authorization")).toBeNull();
          requests.push(await request.json());
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          return nativeCodexSseResponse(
            piResponsesTextSse("discarded custom answer", requests.length),
          );
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: selectedModel,
        prompt: "cancel custom Fast ownership",
        runOptions: { codexServiceTier: "fast" },
      });
      await entered.promise;
      if (phase === "late-result") {
        await cancelBeforeLatePiResult(actor, run.runId, () => {
          release.resolve(undefined);
        });
      } else {
        await cancelChatRun(actor, run.runId);
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: gateway.upstreamModel,
        service_tier: "priority",
      });
      await expectNoBuiltInModelUsage(run.runId);
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          run.runId,
        ),
      ).toHaveLength(0);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expectApiError(claim.body);
    },
    90_000,
  );

  it.each([
    { selectedModel: "gpt-6-astra", tier: undefined, piLoop: true },
    { selectedModel: "gpt-6-astra", tier: "fast", piLoop: true },
    { selectedModel: "gpt-5.5", tier: undefined, piLoop: true },
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return { selectedModel, tier: "fast", piLoop: false } as const;
    }),
  ] as const)(
    "keeps custom $selectedModel $tier with PiLoop=$piLoop inside its existing runtime boundary",
    async ({ selectedModel, tier, piLoop }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const gateway = await configureCustomPiModel(actor, selectedModel);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: piLoop,
      });
      const run = await sendChatRun(actor, {
        agentId,
        model: selectedModel,
        prompt: "respect custom Pi admission boundaries",
        runOptions: { codexServiceTier: tier },
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.cliAgentType).toBe("codex");
      expect(claimed.claim.piModelConfig).toBeUndefined();
      expect(claimEnvironment(claimed.claim)).toMatchObject({
        OPENAI_MODEL: gateway.upstreamModel,
      });
      await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
      await expectNoBuiltInModelUsage(run.runId);
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "rejects custom %s Fast admission when the existing Fast gate is disabled",
    async (selectedModel) => {
      const { actor, agentId } = await entitledChatActor();
      await configureCustomPiModel(actor, selectedModel);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CodexFastMode]: false,
      });
      const clientThreadId = randomUUID();
      const rejected = await chat.requestSendEvent(
        actor,
        {
          agentId,
          clientEventId: randomUUID(),
          clientThreadId,
          model: selectedModel,
          prompt: "respect the custom Fast feature gate",
          runOptions: { codexServiceTier: "fast" },
        },
        [400],
      );
      expect(rejected.body).toMatchObject({
        error: {
          message: "Codex fast mode is not enabled for this workspace",
        },
      });
      await chat.requestReadThread(actor, clientThreadId, [404]);
    },
    90_000,
  );

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"] as const)(
    "runs built-in %s OpenRouter fallback through Responses without widening admission",
    async (selectedModel) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
        actor,
        selectedModel,
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const modelRequests: unknown[] = [];
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/responses",
          async ({ request }) => {
            modelRequests.push(await request.json());
            return new HttpResponse(
              piResponsesTextSse(
                `${selectedModel} OpenRouter Responses answer`,
                modelRequests.length,
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      const run = await withOpenRouterRoute(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            prompt: `run ${selectedModel} on its managed fallback`,
            model: selectedModel,
          },
          usagePricingResolution,
        );
      });
      await waitForRunStatus(actor, run.runId, "completed", 10_000);
      await flushWaitUntilForTest();

      expect(modelRequests).toStrictEqual([
        expect.objectContaining({
          model: `deepseek/${selectedModel}`,
          store: false,
        }),
      ]);
      expect(modelRequests[0]).not.toHaveProperty("previous_response_id");
      await expect(
        readRunLaunchSnapshotFixture(context, run.runId),
      ).resolves.toMatchObject({ launch_snapshot: { framework: "pi" } });
      await expectPiApiUsage(run.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expect(claim.status).toBe(404);
    },
    90_000,
  );

  it.each([
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return {
        name: selectedModel,
        selectedModel,
        providerUrl: "https://api.openai.com/v1/responses",
      };
    }),
    {
      name: "DeepSeek Flash",
      selectedModel: "deepseek-v4-flash",
      providerUrl: "https://api.deepseek.com/responses",
    },
  ] as const)(
    "keeps $name first-turn billing idempotent for matching usage identities",
    async ({ selectedModel, providerUrl }) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();

      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!releaseProvider.settled()) {
          releaseProvider.resolve(undefined);
        }
      });
      let modelCalls = 0;
      server.use(
        http.post(providerUrl, async () => {
          modelCalls += 1;
          if (!providerEntered.settled()) {
            providerEntered.resolve(undefined);
          }
          await releaseProvider.promise;
          return new HttpResponse(
            piResponsesTextSse(`idempotent ${selectedModel} billing`, 0, {
              input_tokens: 10,
              output_tokens: 3,
              total_tokens: 13,
              input_tokens_details: {
                cached_tokens: 3,
                cache_write_tokens: 2,
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: `reuse matching ${selectedModel} billing identities`,
          model: selectedModel,
        },
        usagePricingResolution,
      );
      await providerEntered.promise;
      const usageEvents = piApiFirstTurnUsageEvents(run.runId, "resp_pi_api_0");
      const idempotencyKeys = usageEvents.map((event) => {
        return event.idempotencyKey;
      });
      onTestFinished(async () => {
        await deletePiApiFirstTurnUsageEventsFixture(idempotencyKeys);
      });
      // No production API can preseed first-turn billing identities before the
      // provider responds. This run-owned fixture creates the otherwise
      // unreachable retry state while the public chat API remains under test.
      await insertPiApiFirstTurnUsageEventsFixture({
        runId: run.runId,
        orgId,
        userId: actor.userId,
        provider: selectedModel,
        events: usageEvents,
      });

      releaseProvider.resolve(undefined);
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      await expectPiApiUsage(run.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 3,
        cacheCreation: 2,
      });
    },
    90_000,
  );

  it.each([
    ...GPT_PI_BDD_MODELS.map((selectedModel) => {
      return {
        name: selectedModel,
        selectedModel,
        providerUrl: "https://api.openai.com/v1/responses",
      };
    }),
    {
      name: "DeepSeek Pro",
      selectedModel: "deepseek-v4-pro",
      providerUrl: "https://api.deepseek.com/responses",
    },
  ] as const)(
    "fails $name first-turn billing on a conflicting usage identity",
    async ({ selectedModel, providerUrl }) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();

      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!releaseProvider.settled()) {
          releaseProvider.resolve(undefined);
        }
      });
      let modelCalls = 0;
      server.use(
        http.post(providerUrl, async () => {
          modelCalls += 1;
          if (!providerEntered.settled()) {
            providerEntered.resolve(undefined);
          }
          await releaseProvider.promise;
          return new HttpResponse(
            piResponsesTextSse(`conflicting ${selectedModel} billing`, 0, {
              input_tokens: 10,
              output_tokens: 3,
              total_tokens: 13,
              input_tokens_details: {
                cached_tokens: 3,
                cache_write_tokens: 2,
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: `reject a conflicting ${selectedModel} billing identity`,
          model: selectedModel,
        },
        usagePricingResolution,
      );
      await providerEntered.promise;
      const usageEvents = piApiFirstTurnUsageEvents(run.runId, "resp_pi_api_0");
      const [expectedEvent] = usageEvents;
      if (!expectedEvent) {
        throw new Error(`Expected a ${selectedModel} billing identity fixture`);
      }
      onTestFinished(async () => {
        await deletePiApiFirstTurnUsageEventsFixture(
          usageEvents.map((event) => {
            return event.idempotencyKey;
          }),
        );
      });
      // No production API can preseed a conflicting first-turn billing identity
      // before the provider responds. This run-owned fixture creates that
      // otherwise unreachable state while the public chat API remains under test.
      await insertPiApiFirstTurnUsageEventsFixture({
        runId: run.runId,
        orgId,
        userId: actor.userId,
        provider: selectedModel,
        events: [{ ...expectedEvent, quantity: expectedEvent.quantity + 1 }],
      });

      releaseProvider.resolve(undefined);
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining("[PI_API_MODEL_FAILED]"),
      });
      // Public usage summaries omit unprocessed rows. Inspect this run's unique
      // rows only to prove the failed transaction added no partial billing data.
      await expect(readRunUsageEventsFixture(run.runId)).resolves.toStrictEqual(
        [
          expect.objectContaining({
            category: expectedEvent.category,
            provider: selectedModel,
            quantity: expectedEvent.quantity + 1,
          }),
        ],
      );
    },
    90_000,
  );

  it("resumes pre-migration OpenRouter Chat JSONL through API-first Responses", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const usagePricingResolution = await createGptUsagePricingResolution();
    const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
      actor,
      "gpt-5.6-terra",
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const modelRequests: unknown[] = [];
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/responses",
        async ({ request }) => {
          const requestIndex = modelRequests.length;
          modelRequests.push(await request.json());
          return new HttpResponse(
            piResponsesTextSse(
              requestIndex === 0
                ? "seed answer replaced by migration fixture"
                : "post-migration API answer",
              requestIndex,
              undefined,
              "default",
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
    const first = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          prompt: "seed the canonical Pi binding",
          model: "gpt-5.6-terra",
        },
        usagePricingResolution,
      );
    });
    await waitForRunStatus(actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    const legacy = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: first.threadId,
    });
    legacy.appendMessage({
      role: "user",
      content: "legacy API user context",
      timestamp: 1,
    });
    legacy.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "legacy API reasoning context" },
        { type: "text", text: "legacy API assistant context" },
        {
          type: "toolCall",
          id: "legacy_api_tool_call",
          name: "read",
          arguments: { path: "/home/user/workspace/AGENTS.md" },
        },
      ],
      api: "openai-completions",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    legacy.appendMessage({
      role: "toolResult",
      toolCallId: "legacy_api_tool_call",
      toolName: "read",
      content: [{ type: "text", text: "legacy API tool output" }],
      isError: false,
      timestamp: 3,
    });
    legacy.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "legacy API tool conclusion" }],
      api: "openai-completions",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    const legacyJsonl = legacy.toJsonl();
    const legacyHash = await replacePiSessionHistoryJsonlFixture({
      runId: first.runId,
      jsonl: legacyJsonl,
    });
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${legacyHash}.blob`,
      Buffer.from(legacyJsonl, "utf8"),
    );

    const prompt = "continue the migrated OpenRouter session";
    const second = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt,
          model: "gpt-5.6-terra",
        },
        usagePricingResolution,
      );
    });
    await waitForRunStatus(actor, second.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(modelRequests).toHaveLength(2);
    const resumedRequest = modelRequests[1];
    expect(resumedRequest).toMatchObject({ store: false });
    expect(resumedRequest).not.toHaveProperty("previous_response_id");
    const resumedInput = JSON.stringify(resumedRequest);
    for (const marker of [
      "legacy API user context",
      "legacy API reasoning context",
      "legacy API assistant context",
      "legacy API tool output",
      "legacy API tool conclusion",
      prompt,
    ]) {
      expect(occurrences(resumedInput, marker)).toBe(1);
    }
    const resumedSession = [...checkpointObjects.values()].find((bytes) => {
      return bytes.toString("utf8").includes("post-migration API answer");
    });
    if (!resumedSession) {
      throw new Error("Expected the migrated Responses H1 checkpoint");
    }
    const resumedJsonl = resumedSession.toString("utf8");
    for (const marker of [
      "legacy API reasoning context",
      "legacy API tool output",
      prompt,
      "post-migration API answer",
    ]) {
      expect(occurrences(resumedJsonl, marker)).toBe(1);
    }
    expect(
      MemoryPiSession.fromJsonl(resumedJsonl).hasPendingToolCalls(),
    ).toBeFalsy();
  }, 90_000);

  it.each(GPT_PI_BDD_MODELS)(
    "reuses one OpenRouter Responses Pi session across standard, fast, and long-context turns for %s",
    async (selectedModel) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const longContextInputTokens =
        MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[selectedModel];
      if (longContextInputTokens === undefined) {
        throw new Error("Expected the Terra long-context pricing threshold");
      }
      const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
        actor,
        selectedModel,
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.CodexFastMode]: true,
        },
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const prompts = [
        "start standard Terra in the canonical Pi session",
        "continue fast Terra in the same Pi session",
        "continue long-context Terra in the same Pi session",
      ] as const;
      const answers = [
        "first standard Terra answer",
        "fast Terra answer",
        "long-context Terra answer",
      ] as const;
      const modelRequests: unknown[] = [];
      const observedTiers = ["default", "priority", "flex"] as const;
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/responses",
          async ({ request }) => {
            const requestIndex = modelRequests.length;
            modelRequests.push(await request.json());
            const answer = answers[requestIndex];
            if (!answer) {
              return HttpResponse.json(
                { error: "unexpected duplicate Terra request" },
                { status: 500 },
              );
            }
            return new HttpResponse(
              piResponsesTextSse(
                answer,
                requestIndex,
                requestIndex === 2
                  ? {
                      input_tokens: longContextInputTokens,
                      output_tokens: 3,
                      total_tokens: longContextInputTokens + 3,
                    }
                  : {
                      input_tokens: 10,
                      output_tokens: 3,
                      total_tokens: 13,
                      input_tokens_details: {
                        cached_tokens: 3,
                        cache_write_tokens: 2,
                      },
                    },
                observedTiers[requestIndex],
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      const first = await withOpenRouterRoute(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            prompt: prompts[0],
            model: selectedModel,
          },
          usagePricingResolution,
        );
      });
      await waitForRunStatus(actor, first.runId, "completed", 10_000);
      await flushWaitUntilForTest();
      const firstBinding = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      if (!firstBinding.agent_session_id) {
        throw new Error(
          "Expected standard Terra to bind a canonical Pi session",
        );
      }

      const fast = await withOpenRouterRoute(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            threadId: first.threadId,
            prompt: prompts[1],
            model: selectedModel,
            runOptions: { codexServiceTier: "fast" },
          },
          usagePricingResolution,
        );
      });
      await waitForRunStatus(actor, fast.runId, "completed", 10_000);
      await flushWaitUntilForTest();
      const fastBinding = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      expect(fastBinding.agent_session_id).toBe(firstBinding.agent_session_id);

      await chat.updateThreadModelSelection(
        actor,
        first.threadId,
        selectedModel,
        { codexServiceTier: null },
      );
      const returned = await withOpenRouterRoute(async () => {
        return await sendChatRun(
          actor,
          {
            agentId,
            threadId: first.threadId,
            prompt: prompts[2],
            model: selectedModel,
          },
          usagePricingResolution,
        );
      });
      await waitForRunStatus(actor, returned.runId, "completed", 10_000);
      await flushWaitUntilForTest();
      const returnedBinding = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      expect(returnedBinding.agent_session_id).toBe(
        firstBinding.agent_session_id,
      );
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstBinding.agent_session_id,
        conversation_run_id: returned.runId,
      });

      expect(modelRequests).toHaveLength(3);
      const requestTiers = modelRequests.map((body) => {
        return z
          .object({ service_tier: z.literal("priority").optional() })
          .passthrough()
          .parse(body).service_tier;
      });
      expect(requestTiers).toStrictEqual([undefined, "priority", undefined]);
      for (const body of modelRequests) {
        expect(body).toMatchObject({
          model: `openai/${selectedModel}`,
          reasoning: { effort: "max" },
          store: false,
        });
        expect(body).not.toHaveProperty("previous_response_id");
      }
      for (const [requestIndex, expectedTurns] of [
        [0, [prompts[0]]],
        [1, [prompts[0], answers[0], prompts[1]]],
        [2, [prompts[0], answers[0], prompts[1], answers[1], prompts[2]]],
      ] as const) {
        const input = JSON.stringify(modelRequests[requestIndex]);
        for (const turn of expectedTurns) {
          expect(occurrences(input, turn)).toBe(1);
        }
        expect(occurrences(input, answers[requestIndex])).toBe(0);
      }

      for (const run of [first, fast, returned]) {
        await expect(
          readRunLaunchSnapshotFixture(context, run.runId),
        ).resolves.toMatchObject({
          launch_snapshot: { framework: "pi" },
        });
        const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
        expect(claim.status).toBe(404);
      }
      for (const runId of [fast.runId, returned.runId]) {
        const run = await api.readRun(actor, runId);
        const appendSystemPrompt = run.appendSystemPrompt ?? "";
        expect(appendSystemPrompt).not.toContain("# Web Chat Run Context");
        for (const turn of [...prompts, ...answers]) {
          expect(appendSystemPrompt).not.toContain(turn);
        }
      }

      await expectPiApiUsage(first.runId, selectedModel, "", {
        input: 5,
        output: 3,
        cacheRead: 3,
        cacheCreation: 2,
      });
      await expectPiApiUsage(fast.runId, selectedModel, ".fast", {
        input: 5,
        output: 3,
        cacheRead: 3,
        cacheCreation: 2,
      });
      await expectPiApiUsage(returned.runId, selectedModel, ".long_context", {
        input: longContextInputTokens,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });

      const visibleTurns = [
        { runId: first.runId, prompt: prompts[0], answer: answers[0] },
        { runId: fast.runId, prompt: prompts[1], answer: answers[1] },
        { runId: returned.runId, prompt: prompts[2], answer: answers[2] },
      ];
      const finalEvents = await waitForThreadMessages(
        actor,
        first.threadId,
        (events) => {
          return eventBackedContents(events, returned.runId).some((event) => {
            return event.content === answers[2];
          });
        },
      );
      const runIds = new Set(
        visibleTurns.map((turn) => {
          return turn.runId;
        }),
      );
      expect(
        finalEvents.events
          .filter((event) => {
            return (
              event.runId !== undefined &&
              event.runId !== null &&
              runIds.has(event.runId) &&
              (event.eventType === "input.prompt" ||
                event.eventType === "output.message")
            );
          })
          .map((event) => {
            return {
              runId: event.runId,
              eventType: event.eventType,
              content: chatEventDisplayText(event),
            };
          }),
      ).toStrictEqual(
        visibleTurns.flatMap((turn) => {
          return [
            {
              runId: turn.runId,
              eventType: "input.prompt",
              content: turn.prompt,
            },
            {
              runId: turn.runId,
              eventType: "output.message",
              content: turn.answer,
            },
          ];
        }),
      );
      const sessionBlobs = [...checkpointObjects.entries()].filter(([key]) => {
        return key.includes("/blobs/");
      });
      expect(sessionBlobs.length).toBeGreaterThan(0);
      for (const [, bytes] of sessionBlobs) {
        expect(bytes.toString("utf8")).not.toContain("serviceTier");
      }
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "bills managed OpenRouter priority only from the observed terminal Responses tier %s",
    async (selectedModel) => {
      const { actor, agentId } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
        actor,
        selectedModel,
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.CodexFastMode]: true,
        },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const cases = [
        { observed: "priority", expectedSuffix: ".fast" },
        { observed: "fast", expectedSuffix: ".fast" },
        { observed: "default", expectedSuffix: "" },
        { observed: "flex", expectedSuffix: "" },
        { observed: null, expectedSuffix: "" },
        { observed: undefined, expectedSuffix: "" },
        { observed: "future-tier", expectedSuffix: "" },
      ] as const;
      const modelRequests: unknown[] = [];
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/responses",
          async ({ request }) => {
            const requestIndex = modelRequests.length;
            modelRequests.push(await request.json());
            const testCase = cases[requestIndex];
            if (!testCase) {
              return HttpResponse.json(
                { error: "unexpected duplicate OpenRouter request" },
                { status: 500 },
              );
            }
            return new HttpResponse(
              piResponsesTextSse(
                `OpenRouter tier answer ${requestIndex.toString()}`,
                requestIndex,
                undefined,
                testCase.observed,
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      for (const [index, testCase] of cases.entries()) {
        const run = await withOpenRouterRoute(async () => {
          return await sendChatRun(
            actor,
            {
              agentId,
              prompt: `observe OpenRouter tier case ${index.toString()}`,
              model: selectedModel,
              runOptions: { codexServiceTier: "fast" },
            },
            usagePricingResolution,
          );
        });
        await waitForRunStatus(actor, run.runId, "completed", 10_000);
        await flushWaitUntilForTest();
        await expectPiApiUsage(
          run.runId,
          selectedModel,
          testCase.expectedSuffix,
          { input: 5, output: 3, cacheRead: 0, cacheCreation: 0 },
        );
      }

      expect(modelRequests).toHaveLength(cases.length);
      for (const body of modelRequests) {
        expect(body).toMatchObject({
          model: `openai/${selectedModel}`,
          reasoning: { effort: "max" },
          service_tier: "priority",
          store: false,
        });
        expect(body).not.toHaveProperty("previous_response_id");
      }
    },
    90_000,
  );

  it.each(GPT_PI_BDD_MODELS)(
    "promotes queued fast %s through Pi API-first with priority",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const usagePricingResolution = await createGptUsagePricingResolution();
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the thread before queued fast Terra",
        model: "claude-sonnet-5",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.CodexFastMode]: true,
        },
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const modelRequests: unknown[] = [];
      const prompt = "promote queued fast Terra through the callback";
      const answer = "queued fast Terra API-first answer";
      server.use(
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            modelRequests.push(await request.json());
            return new HttpResponse(piResponsesTextSse(answer, 0), {
              headers: { "content-type": "text/event-stream" },
            });
          },
        ),
      );

      const queuedId = randomUUID();
      const queued = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          prompt,
          clientEventId: queuedId,
          model: selectedModel,
          runOptions: { codexServiceTier: "fast" },
        },
        [201],
        { usagePricingResolution },
      );
      if (queued.status !== 201) {
        throw new Error("Expected queued fast Terra to enter the chat queue");
      }
      expect(queued.body.runId).toBeNull();

      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      const messages = await waitForThreadMessages(
        actor,
        anchor.threadId,
        (events) => {
          return userMessages(events).some((event) => {
            return (
              event.revokesEventId === queuedId &&
              typeof event.runId === "string"
            );
          });
        },
      );
      const promoted = userMessages(messages.events).find((event) => {
        return event.revokesEventId === queuedId;
      });
      if (!promoted?.runId) {
        throw new Error("Expected queued fast Terra to create a run");
      }
      const promotedRunId = promoted.runId;
      await waitForRunStatus(actor, promotedRunId, "completed", 10_000);
      await flushWaitUntilForTest();

      expect(modelRequests).toHaveLength(1);
      const request = z
        .object({ service_tier: z.literal("priority") })
        .passthrough()
        .parse(modelRequests[0]);
      expect(request.service_tier).toBe("priority");
      expect(request).toMatchObject({
        model: selectedModel,
        reasoning: { effort: "max" },
      });
      expect(occurrences(JSON.stringify(request), prompt)).toBe(1);
      await expect(
        readRunLaunchSnapshotFixture(context, promotedRunId),
      ).resolves.toMatchObject({
        launch_snapshot: { framework: "pi" },
      });
      const claim = await api.requestClaimRunnerJob(true, promotedRunId, [404]);
      expect(claim.status).toBe(404);
      await expectPiApiUsage(promotedRunId, selectedModel, ".fast", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const finalEvents = await waitForThreadMessages(
        actor,
        anchor.threadId,
        (events) => {
          return eventBackedContents(events, promotedRunId).some((event) => {
            return event.content === answer;
          });
        },
      );
      expect(
        eventBackedContents(finalEvents.events, promotedRunId).filter(
          (event) => {
            return event.content === answer;
          },
        ),
      ).toHaveLength(1);
    },
    90_000,
  );

  it("preserves one Pi session while selecting Terra, Sol, Luna, and Terra again", async () => {
    const { actor, agentId } = await entitledChatActor();
    for (const model of GPT_PI_BDD_MODELS) {
      await seedBuiltInModelKey(model);
    }
    await api.updateOrgModelPolicies(
      actor,
      GPT_PI_BDD_MODELS.map((model) => {
        return {
          model,
          isDefault: model === "gpt-5.6-terra",
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        };
      }),
    );
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    const usagePricingResolution = await createGptUsagePricingResolution();
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const requests: unknown[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.json());
        return nativeCodexSseResponse(
          piResponsesTextSse(`answer ${requests.length}`, requests.length),
        );
      }),
    );
    let threadId: string | undefined;
    let sessionId: string | null | undefined;
    for (const model of [...GPT_PI_BDD_MODELS, "gpt-5.6-terra"] as const) {
      const run = await sendChatRun(
        actor,
        { agentId, threadId, model, prompt: `continue with ${model}` },
        usagePricingResolution,
      );
      threadId = run.threadId;
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();
      const session = await readThreadSessionConversation(context, threadId);
      if (sessionId === undefined) {
        sessionId = session.agent_session_id;
        expect(sessionId).toStrictEqual(expect.any(String));
      }
      expect(session.agent_session_id).toBe(sessionId);
      expect(requests.at(-1)).toMatchObject({
        model,
        reasoning: { effort: "max" },
      });
      expect(requests.at(-1)).not.toHaveProperty("service_tier");
      await expectPiApiUsage(run.runId, model, "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
    }
    expect(requests).toHaveLength(4);
    for (const answer of ["answer 1", "answer 2", "answer 3"]) {
      expect(occurrences(JSON.stringify(requests.at(-1)), answer)).toBe(1);
    }
  }, 90_000);

  it("preserves generations across Terra Pi and fast Astra Codex boundaries", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const piModel = "gpt-5.6-terra";
    await seedBuiltInModelKey(piModel);
    await seedBuiltInModelKey("gpt-6-astra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: piModel,
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "gpt-6-astra",
        isDefault: false,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.CodexFastMode]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const firstPiAnswer = "first Pi generation answer";
    const returnedPiAnswer = "returned Pi generation answer";
    const interruptedPiAnswer = "Pi follow-up before Sandbox handoff";
    const repeatedPiAnswer = "repeated Pi generation answer";
    const modelRequests: unknown[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        const requestIndex = modelRequests.length;
        modelRequests.push(await request.json());
        const body =
          requestIndex === 2
            ? piResponsesContentSse({
                blocks: [
                  { type: "text", text: interruptedPiAnswer },
                  {
                    type: "toolCall",
                    callId: "call_generation_boundary",
                    name: "read",
                    arguments: { path: "/home/user/workspace/AGENTS.md" },
                  },
                ],
                sequence: requestIndex,
              })
            : piResponsesTextSse(
                [firstPiAnswer, returnedPiAnswer, undefined, repeatedPiAnswer][
                  requestIndex
                ] ?? "unexpected duplicate Pi model request",
                requestIndex,
              );
        return new HttpResponse(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const firstPiPrompt = "start the first Pi generation";
    const firstPi = await sendChatRun(actor, {
      agentId,
      prompt: firstPiPrompt,
      model: piModel,
    });
    await waitForRunStatus(actor, firstPi.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(modelRequests).toHaveLength(1);
    const firstPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    if (!firstPiBinding.agent_session_id) {
      throw new Error("Expected the first Pi run to bind a canonical session");
    }
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({ conversation_run_id: firstPi.runId });

    const firstCodexPrompt = "continue through Codex between Pi generations";
    const firstCodexAnswer = "Codex answer between Pi generations";
    const firstCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: firstCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const firstCodexBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(firstCodexBinding.agent_session_id).not.toBe(
      firstPiBinding.agent_session_id,
    );
    const firstCodexRun = await api.readRun(actor, firstCodex.runId);
    expect(firstCodexRun.appendSystemPrompt).toContain(
      "# Web Chat Run Context",
    );
    expect(firstCodexRun.appendSystemPrompt).toContain(firstPiPrompt);
    expect(firstCodexRun.appendSystemPrompt).toContain(firstPiAnswer);
    const firstCodexClaim = await claimChatRun(runnerGroup, firstCodex.runId);
    expect(firstCodexClaim.claim.cliAgentType).toBe("codex");
    expect(
      claimEnvironment(firstCodexClaim.claim).OKOU_CODEX_SERVICE_TIER,
    ).toBe("fast");
    expect(firstCodexClaim.claim.piLaunchConfig).toBeUndefined();
    expect(firstCodexClaim.claim.resumeSession).toBeNull();
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, firstCodexAnswer)]);
    await completeChatRunOk(firstCodex.runId, firstCodexClaim.sandboxHeaders, {
      cliAgentType: "codex",
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const returnedPiPrompt = "return to Pi with every visible prior turn";
    await chat.updateThreadModelSelection(actor, firstPi.threadId, piModel, {
      codexServiceTier: null,
    });
    const returnedPi = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: returnedPiPrompt,
      model: piModel,
    });
    await waitForRunStatus(actor, returnedPi.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(modelRequests).toHaveLength(2);
    const returnedPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    if (!returnedPiBinding.agent_session_id) {
      throw new Error("Expected the returned Pi run to bind a new session");
    }
    expect(returnedPiBinding.agent_session_id).not.toBe(
      firstCodexBinding.agent_session_id,
    );
    expect(returnedPiBinding.agent_session_id).not.toBe(
      firstPiBinding.agent_session_id,
    );
    const returnedPiRun = await api.readRun(actor, returnedPi.runId);
    const returnedPiAppend = returnedPiRun.appendSystemPrompt ?? "";
    expect(returnedPiAppend).toContain("# Web Chat Run Context");
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
    ]) {
      expect(occurrences(returnedPiAppend, prior)).toBe(1);
    }
    const returnedPiInput = JSON.stringify(modelRequests[1]);
    for (const turn of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
    ]) {
      expect(occurrences(returnedPiInput, turn)).toBe(1);
    }
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({
      agent_session_id: returnedPiBinding.agent_session_id,
      conversation_run_id: returnedPi.runId,
    });

    const piFollowUpPrompt = "resume the returned Pi generation once";
    const piFollowUp = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: piFollowUpPrompt,
      model: piModel,
    });
    const piFollowUpManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${piFollowUp.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(piFollowUpManifestKey);
      })
      .toBe(true);
    expect(modelRequests).toHaveLength(3);
    const piFollowUpRun = await api.readRun(actor, piFollowUp.runId);
    const piFollowUpAppend = piFollowUpRun.appendSystemPrompt ?? "";
    expect(piFollowUpAppend).not.toContain("# Web Chat Run Context");
    expect(piFollowUpAppend).not.toContain(firstPiPrompt);
    expect(piFollowUpAppend).not.toContain(firstCodexPrompt);
    const piFollowUpInput = JSON.stringify(modelRequests[2]);
    expect(occurrences(piFollowUpInput, returnedPiPrompt)).toBe(1);
    expect(occurrences(piFollowUpInput, returnedPiAnswer)).toBe(1);
    expect(occurrences(piFollowUpInput, piFollowUpPrompt)).toBe(1);
    expect(piFollowUpInput).not.toContain(firstPiPrompt);
    expect(piFollowUpInput).not.toContain(firstCodexPrompt);
    const piFollowUpBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(piFollowUpBinding.agent_session_id).toBe(
      returnedPiBinding.agent_session_id,
    );
    const piFollowUpClaim = await claimChatRun(runnerGroup, piFollowUp.runId);
    const resumedPiSession = piFollowUpClaim.claim.resumeSession;
    if (!resumedPiSession || !("historyRef" in resumedPiSession)) {
      throw new Error("Expected the Pi follow-up to resume a blob checkpoint");
    }
    expect(resumedPiSession).toMatchObject({
      sessionId: firstPi.threadId,
      historyRef: {
        kind: "blob",
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(piFollowUpClaim.claim.piSessionId).toBe(firstPi.threadId);
    expect(piFollowUpClaim.claim.piLaunchConfig).toMatchObject({
      apiFirstTurn: {
        baseSession: {
          sessionId: firstPi.threadId,
          sha256: resumedPiSession.historyRef.hash,
        },
      },
    });
    const piFollowUpManifest = JSON.parse(
      checkpointObjects.get(piFollowUpManifestKey)?.toString("utf8") ?? "{}",
    ) as {
      readonly baseSession?: {
        readonly sessionId?: unknown;
        readonly sha256?: unknown;
      };
    };
    expect(piFollowUpManifest.baseSession).toStrictEqual({
      sessionId: firstPi.threadId,
      sha256: resumedPiSession.historyRef.hash,
    });
    await cancelChatRun(
      actor,
      piFollowUp.runId,
      piFollowUpClaim.sandboxHeaders,
    );
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({ conversation_run_id: returnedPi.runId });

    const repeatedCodexPrompt = "cross Codex before returning to Pi again";
    const repeatedCodexAnswer = "second intervening Codex answer";
    const repeatedCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: repeatedCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const repeatedCodexBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(repeatedCodexBinding.agent_session_id).not.toBe(
      returnedPiBinding.agent_session_id,
    );
    const repeatedCodexClaim = await claimChatRun(
      runnerGroup,
      repeatedCodex.runId,
    );
    expect(repeatedCodexClaim.claim.cliAgentType).toBe("codex");
    expect(
      claimEnvironment(repeatedCodexClaim.claim).OKOU_CODEX_SERVICE_TIER,
    ).toBe("fast");
    expect(repeatedCodexClaim.claim.piLaunchConfig).toBeUndefined();
    expect(repeatedCodexClaim.claim.resumeSession).toBeNull();
    const repeatedCodexRun = await api.readRun(actor, repeatedCodex.runId);
    expect(repeatedCodexRun.appendSystemPrompt).toContain(piFollowUpPrompt);
    expect(repeatedCodexRun.appendSystemPrompt).toContain("Run cancelled");
    expect(repeatedCodexRun.appendSystemPrompt).not.toContain(
      interruptedPiAnswer,
    );
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, repeatedCodexAnswer),
    ]);
    await completeChatRunOk(
      repeatedCodex.runId,
      repeatedCodexClaim.sandboxHeaders,
      { cliAgentType: "codex", lastEventSequence: 0 },
    );
    await flushWaitUntilForTest();

    const repeatedPiPrompt = "return to a third Pi generation";
    await chat.updateThreadModelSelection(actor, firstPi.threadId, piModel, {
      codexServiceTier: null,
    });
    const repeatedPi = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: repeatedPiPrompt,
      model: piModel,
    });
    await waitForRunStatus(actor, repeatedPi.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(modelRequests).toHaveLength(4);
    const repeatedPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(repeatedPiBinding.agent_session_id).not.toBe(
      repeatedCodexBinding.agent_session_id,
    );
    expect(repeatedPiBinding.agent_session_id).not.toBe(
      returnedPiBinding.agent_session_id,
    );
    const repeatedPiRun = await api.readRun(actor, repeatedPi.runId);
    const repeatedPiAppend = repeatedPiRun.appendSystemPrompt ?? "";
    expect(repeatedPiAppend).toContain("# Web Chat Run Context");
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
      returnedPiAnswer,
      piFollowUpPrompt,
      "Run cancelled",
      repeatedCodexPrompt,
      repeatedCodexAnswer,
    ]) {
      expect(occurrences(repeatedPiAppend, prior)).toBe(1);
    }
    expect(repeatedPiAppend).not.toContain(interruptedPiAnswer);
    const repeatedPiInput = JSON.stringify(modelRequests[3]);
    for (const turn of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
      returnedPiAnswer,
      piFollowUpPrompt,
      "Run cancelled",
      repeatedCodexPrompt,
      repeatedCodexAnswer,
      repeatedPiPrompt,
    ]) {
      expect(occurrences(repeatedPiInput, turn)).toBe(1);
    }
    expect(repeatedPiInput).not.toContain(interruptedPiAnswer);
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({
      agent_session_id: repeatedPiBinding.agent_session_id,
      conversation_run_id: repeatedPi.runId,
    });

    const visibleTurns = [
      { runId: firstPi.runId, prompt: firstPiPrompt, answer: firstPiAnswer },
      {
        runId: firstCodex.runId,
        prompt: firstCodexPrompt,
        answer: firstCodexAnswer,
      },
      {
        runId: returnedPi.runId,
        prompt: returnedPiPrompt,
        answer: returnedPiAnswer,
      },
      {
        runId: piFollowUp.runId,
        prompt: piFollowUpPrompt,
        answer: interruptedPiAnswer,
      },
      {
        runId: repeatedCodex.runId,
        prompt: repeatedCodexPrompt,
        answer: repeatedCodexAnswer,
      },
      {
        runId: repeatedPi.runId,
        prompt: repeatedPiPrompt,
        answer: repeatedPiAnswer,
      },
    ];
    const finalEvents = await waitForThreadMessages(
      actor,
      firstPi.threadId,
      (events) => {
        return eventBackedContents(events, repeatedPi.runId).some((event) => {
          return event.content === repeatedPiAnswer;
        });
      },
    );
    const allRunIds = new Set(
      visibleTurns.map((turn) => {
        return turn.runId;
      }),
    );
    expect(
      finalEvents.events
        .filter((event) => {
          return (
            event.runId !== undefined &&
            event.runId !== null &&
            allRunIds.has(event.runId) &&
            (event.eventType === "input.prompt" ||
              event.eventType === "output.message")
          );
        })
        .map((event) => {
          return {
            runId: event.runId,
            eventType: event.eventType,
            content: chatEventDisplayText(event),
          };
        }),
    ).toStrictEqual(
      visibleTurns.flatMap((turn) => {
        return [
          {
            runId: turn.runId,
            eventType: "input.prompt",
            content: turn.prompt,
          },
          {
            runId: turn.runId,
            eventType: "output.message",
            content: turn.answer,
          },
        ];
      }),
    );
    await expect(api.readRun(actor, firstPi.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, firstCodex.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, returnedPi.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, piFollowUp.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
  }, 90_000);

  it("projects citation-free API-first blocks and durable private provenance", async () => {
    const { actor, agentId } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads();
    // A real assistant can copy the entire immutable archive notice. Its run
    // provenance must still keep citation transport private.
    const copiedArchiveNotice =
      "Okou Goal retired.\nGoal ID: 00000000-0000-4000-8000-000000000001\nOriginal recorded status: complete\nThe recorded status is preserved; retirement does not mark the objective complete.\n\nFull original objective:\nalpha";
    const consumedAgentEvents: Record<string, unknown>[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        async ({ request }) => {
          const events: unknown = await request.json();
          if (!Array.isArray(events)) {
            throw new Error("Expected an Axiom event array");
          }
          consumedAgentEvents.push(
            ...events.filter((event): event is Record<string, unknown> => {
              return (
                typeof event === "object" &&
                event !== null &&
                !Array.isArray(event)
              );
            }),
          );
          return HttpResponse.json({
            ingested: events.length,
            failed: 0,
            processedBytes: 123,
          });
        },
      ),
      http.post("https://api.openai.com/v1/responses", () => {
        const hidden =
          "<oai-mem-citation><citation_entries>memory.md:2-3|note=[used]</citation_entries><rollout_ids>019c6e27-e55b-73d1-87d8-4e01f1f75043</rollout_ids></oai-mem-citation>";
        return new HttpResponse(
          piResponsesContentSse({
            blocks: [
              {
                type: "text",
                text: `${copiedArchiveNotice}${hidden.slice(0, 17)}`,
              },
              { type: "text", text: `${hidden.slice(17)}beta` },
              { type: "text", text: "gamma" },
              { type: "text", text: "delta" },
            ],
            sequence: 1,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    mockPiCheckpointObjectStore();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "preserve each complete API-first text block",
      model: "gpt-5.6-terra",
    });
    await waitForRunStatus(actor, run.runId, "completed");
    await flushWaitUntilForTest();

    const serializedAxiomEvents = JSON.stringify(consumedAgentEvents);
    expect(serializedAxiomEvents).not.toContain("oai-mem-citation");
    expect(serializedAxiomEvents).not.toContain("memory.md");
    // Private provenance intentionally has no user-facing API; this exact
    // event association is the only assertion that crosses the route boundary.
    await expect(
      readRunOutputMemoryCitationsFixture(run.runId),
    ).resolves.toStrictEqual([
      {
        sequenceNumber: 3,
        citation: {
          entries: [
            {
              path: "memory.md",
              lineStart: 2,
              lineEnd: 3,
              note: "used",
            },
          ],
          rolloutIds: ["019c6e27-e55b-73d1-87d8-4e01f1f75043"],
        },
      },
    ]);

    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(
      consumedAgentEvents
        .filter((event) => {
          return event.runId === run.runId;
        })
        .map((event) => {
          return {
            sequenceNumber: event.sequenceNumber,
            eventType: event.eventType,
          };
        }),
    ).toStrictEqual([
      { sequenceNumber: 0, eventType: "assistant" },
      { sequenceNumber: 1, eventType: "assistant" },
      { sequenceNumber: 2, eventType: "assistant" },
      { sequenceNumber: 3, eventType: "assistant" },
      { sequenceNumber: 4, eventType: "result" },
    ]);
    const thread = await chat.listThreadEvents(actor, run.threadId);
    expect(
      eventBackedContents(thread.events, run.runId).map((message) => {
        return {
          content: message.content,
          sequenceNumber: message.sequenceNumber,
          runEventId: message.runEventId,
        };
      }),
    ).toStrictEqual([
      {
        content: copiedArchiveNotice,
        sequenceNumber: 0,
        runEventId: "event:0",
      },
      { content: "beta", sequenceNumber: 1, runEventId: "event:1" },
      { content: "gamma", sequenceNumber: 2, runEventId: "event:2" },
      { content: "delta", sequenceNumber: 3, runEventId: "event:3" },
    ]);
  }, 90_000);

  it("uses newly published Pi instruction indexes with resource archives unavailable", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiCheckpointObjectStore();
    mockPiResourceArchiveDownloads();
    const requests: string[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.text());
        return nativeCodexSseResponse(
          piResponsesTextSse("indexed response", requests.length),
        );
      }),
    );
    await bdd.updateAgentInstructions(
      actor,
      agentId,
      "Initial indexed instruction",
    );
    const queued = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "warm exact resource versions",
    });
    await completeChatRunOk(
      queued.anchor.runId,
      queued.anchorClaim.sandboxHeaders,
      { usagePricingResolution: queued.usagePricingResolution },
    );
    await waitForRunStatus(actor, queued.run.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    // A new instruction version forces a new full-snapshot key. Its synchronous
    // index and the warmed shared versions must suffice without archive access.
    await bdd.updateAgentInstructions(
      actor,
      agentId,
      "Updated instruction available immediately",
    );
    mockPiResourceArchiveDownloads(true);
    const next = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "use the newly saved instructions",
        model: "gpt-5.6-terra",
      },
      queued.usagePricingResolution,
    );
    await waitForRunStatus(actor, next.runId, "completed", 10_000);
    const events = (await chat.listThreadEvents(actor, next.threadId)).events;
    expect(eventBackedContents(events, next.runId)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "indexed response" }),
      ]),
    );
    expect(piResponsesDeveloperPrompt(requests.at(-1))).toContain(
      "Updated instruction available immediately",
    );
    await flushWaitUntilForTest();
    const pendingInstructions = await publishPendingPiInstructions(
      actor,
      agentId,
    );
    let archiveReads = 0;
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
        archiveReads++;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected a resource archive identity");
        }
        return new HttpResponse(piS3Object(objectKey));
      }),
    );
    const pending = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "load the one pending resource version",
        model: "gpt-5.6-terra",
      },
      queued.usagePricingResolution,
    );
    await waitForRunStatus(actor, pending.runId, "completed", 10_000);
    expect(archiveReads).toBe(1);
    expect(piResponsesDeveloperPrompt(requests.at(-1))).toContain(
      pendingInstructions,
    );
  }, 30_000);

  it.each(["created", "copied"] as const)(
    "discovers a newly %s Workflow without reading its archive",
    async (publication) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiCheckpointObjectStore();
      mockPiResourceArchiveDownloads();
      const requests: string[] = [];
      server.use(
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            requests.push(await request.text());
            return nativeCodexSseResponse(
              piResponsesTextSse("workflow indexed", requests.length),
            );
          },
        ),
      );
      const queued = await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "warm shared resource versions",
      });
      await completeChatRunOk(
        queued.anchor.runId,
        queued.anchorClaim.sandboxHeaders,
        { usagePricingResolution: queued.usagePricingResolution },
      );
      await waitForRunStatus(actor, queued.run.runId, "completed", 10_000);
      await flushWaitUntilForTest();

      const sourceAgentId =
        publication === "created"
          ? agentId
          : (await bdd.createAgent(actor, { displayName: "Workflow source" }))
              .agentId;
      const name = `indexed-${randomUUID().slice(0, 8)}`;
      const workflow = await createMiscRoutesApi(context).createWorkflow(
        actor,
        sourceAgentId,
        name,
        { content: "Produce the indexed workflow report." },
        [201],
      );
      if (workflow.status !== 201) {
        throw new Error("Expected the workflow to be published");
      }
      if (publication === "copied") {
        routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
        await accept(
          setupApp({ context, routes: workflowsRoutes })(
            workflowsDetailContract,
          ).copy({
            headers: { authorization: "Bearer clerk-session" },
            params: { workflowId: workflow.body.id },
            body: { toAgentId: agentId },
          }),
          [201],
        );
      }
      mockPiResourceArchiveDownloads(true);
      const next = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "discover the new workflow",
          model: "gpt-5.6-terra",
        },
        queued.usagePricingResolution,
      );
      await waitForRunStatus(actor, next.runId, "completed", 10_000);
      expect(piResponsesDeveloperPrompt(requests.at(-1))).toContain(name);
      const events = (await chat.listThreadEvents(actor, next.threadId)).events;
      expect(eventBackedContents(events, next.runId)).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: "workflow indexed" }),
        ]),
      );
    },
    30_000,
  );

  it("classifies old Pi citations across real request caps, retries, replay, and ordering", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const resourceEntered = createDeferredPromise<void>(context.signal);
    const releaseResource = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseResource.settled()) {
        releaseResource.resolve(undefined);
      }
    });
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
        if (!resourceEntered.settled()) {
          resourceEntered.resolve(undefined);
        }
        await releaseResource.promise;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive object identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return new HttpResponse(
          piResponsesTextSse("unexpected API-owned answer", modelCalls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const consumedAgentEvents: Record<string, unknown>[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        async ({ request }) => {
          const events: unknown = await request.json();
          if (!Array.isArray(events)) {
            throw new Error("Expected an Axiom event array");
          }
          consumedAgentEvents.push(
            ...events.filter((event): event is Record<string, unknown> => {
              return typeof event === "object" && event !== null;
            }),
          );
          return HttpResponse.json({
            ingested: events.length,
            failed: 0,
            processedBytes: 123,
          });
        },
      ),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "classify one old Pi Guest stream across requests",
      });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await resourceEntered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "transfer this in-flight turn to the old Sandbox Guest",
        clientEventId: randomUUID(),
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected one active input to transfer Pi ownership");
    }
    releaseResource.resolve(undefined);
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest.mode).toBe("sandbox-first");
    expect(modelCalls).toBe(0);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const rolloutId = "019c6e27-e55b-73d1-87d8-4e01f1f75043";
    const privateValues = new Set<string>([rolloutId]);
    const citation = (path: string, note: string): string => {
      privateValues.add(path);
      privateValues.add(note);
      return `<oai-mem-citation><citation_entries>${path}:1-2|note=[${note}]</citation_entries><rollout_ids>${rolloutId}</rollout_ids></oai-mem-citation>`;
    };
    const assistant = (sequenceNumber: number, id: string, text: string) => {
      return {
        type: "assistant" as const,
        sequenceNumber,
        message: {
          id,
          content: [{ type: "text" as const, text }],
        },
      };
    };
    const separator = (sequenceNumber: number) => {
      return {
        type: "user" as const,
        sequenceNumber,
        message: { content: [] },
      };
    };
    const result = (sequenceNumber: number, text: string) => {
      return {
        type: "result" as const,
        sequenceNumber,
        subtype: "success",
        is_error: false,
        result: text,
      };
    };
    const sendOldGuestRequest = async (
      events: readonly AgentEvent[],
      statuses: readonly (200 | 503)[] = [200],
    ) => {
      return await webhooks.requestAgentEvents(
        { runId: run.runId, events: [...events] },
        claimed.sandboxHeaders,
        statuses,
      );
    };
    const runAxiomEvents = () => {
      return consumedAgentEvents.filter((event) => {
        return event.runId === run.runId;
      });
    };
    const expectNoPrivatePublicOutput = async (): Promise<void> => {
      const publicOutput = JSON.stringify({
        axiom: runAxiomEvents(),
        chat: eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          run.runId,
        ),
      });
      expect(publicOutput).not.toContain("oai-mem-citation");
      for (const privateValue of privateValues) {
        expect(publicOutput).not.toContain(privateValue);
      }
    };
    let sequence = manifest.sandboxEventSequenceStart;

    const openerMarkup = citation(
      "memory/request-opener.md",
      "request opener split",
    );
    const openerBoundary = openerMarkup.indexOf("citation>");
    const openerEvents = [
      assistant(
        sequence,
        "request-opener",
        `opener-before${openerMarkup.slice(0, openerBoundary)}`,
      ),
      assistant(
        sequence + 1,
        "request-opener",
        `${openerMarkup.slice(openerBoundary)}opener-after`,
      ),
      separator(sequence + 2),
    ];
    await sendOldGuestRequest([openerEvents[0]!]);
    await sendOldGuestRequest([openerEvents[1]!]);
    expect(
      (await readRunOutputLegacyPiEventsFixture(run.runId)).map((row) => {
        return row.sequenceNumber;
      }),
    ).toStrictEqual([sequence, sequence + 1]);
    expect(runAxiomEvents()).toHaveLength(0);
    await sendOldGuestRequest([openerEvents[2]!]);
    await flushWaitUntilForTest();
    await expect(
      readRunOutputLegacyPiEventsFixture(run.runId),
    ).resolves.toStrictEqual([]);
    const axiomCountBeforeReplay = runAxiomEvents().length;
    await sendOldGuestRequest(openerEvents);
    await flushWaitUntilForTest();
    expect(runAxiomEvents()).toHaveLength(axiomCountBeforeReplay);
    sequence += 3;

    const bodyMarkup = citation("memory/request-body.md", "request body split");
    const bodyBoundary = bodyMarkup.indexOf("body split") + 4;
    await sendOldGuestRequest([
      assistant(
        sequence,
        "request-body",
        `body-before${bodyMarkup.slice(0, bodyBoundary)}`,
      ),
    ]);
    await sendOldGuestRequest([
      assistant(
        sequence + 1,
        "request-body",
        `${bodyMarkup.slice(bodyBoundary)}body-after`,
      ),
    ]);
    await sendOldGuestRequest([separator(sequence + 2)]);
    sequence += 3;

    const closerMarkup = citation(
      "memory/request-closer.md",
      "request closer split",
    );
    const closerBoundary = closerMarkup.indexOf("</oai-mem-citation>") + 10;
    await sendOldGuestRequest([
      assistant(
        sequence,
        "request-closer",
        `closer-before${closerMarkup.slice(0, closerBoundary)}`,
      ),
    ]);
    await sendOldGuestRequest([
      assistant(
        sequence + 1,
        "request-closer",
        `${closerMarkup.slice(closerBoundary)}closer-after`,
      ),
    ]);
    await sendOldGuestRequest([separator(sequence + 2)]);
    sequence += 3;

    const orderedMarkup = citation(
      "memory/request-order.md",
      "out of order split",
    );
    const orderedBoundary = Math.floor(orderedMarkup.length / 2);
    const orderedFirst = assistant(
      sequence,
      "request-order",
      `order-before${orderedMarkup.slice(0, orderedBoundary)}`,
    );
    const orderedSecond = assistant(
      sequence + 1,
      "request-order",
      `${orderedMarkup.slice(orderedBoundary)}order-after`,
    );
    await sendOldGuestRequest([orderedSecond]);
    const axiomCountBeforeGapCompletion = runAxiomEvents().length;
    const gapCompletion = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        lastEventSequence: sequence + 1,
      },
      claimed.sandboxHeaders,
      [503],
    );
    expect(gapCompletion.body).toMatchObject({
      error: { code: "EVENT_DELIVERY_UNAVAILABLE" },
    });
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    expect(runAxiomEvents()).toHaveLength(axiomCountBeforeGapCompletion);
    expect(
      (await readRunOutputLegacyPiEventsFixture(run.runId)).map((row) => {
        return row.sequenceNumber;
      }),
    ).toStrictEqual([sequence + 1]);
    await sendOldGuestRequest([orderedFirst, orderedFirst]);
    await sendOldGuestRequest([orderedFirst]);
    const lockedMaterialization = await holdRunOutputMaterializationRowFixture({
      runId: run.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      lockedMaterialization.release();
      await lockedMaterialization.done;
    });
    await sendOldGuestRequest([separator(sequence + 2)], [503]);
    lockedMaterialization.release();
    await lockedMaterialization.done;
    expect(
      (await readRunOutputLegacyPiEventsFixture(run.runId)).map((row) => {
        return row.sequenceNumber;
      }),
    ).toStrictEqual([sequence, sequence + 1]);
    await sendOldGuestRequest([separator(sequence + 2)]);
    sequence += 3;

    const countMarkup = citation(
      "memory/request-count.md",
      "thirty two event split",
    );
    const countBoundary = Math.floor(countMarkup.length / 2);
    const countBatch: AgentEvent[] = Array.from({ length: 31 }, (_, index) => {
      return {
        type: "system" as const,
        sequenceNumber: sequence + index,
        subtype: "request-count-padding",
      };
    });
    countBatch.push(
      assistant(
        sequence + 31,
        "request-count",
        `count-before${countMarkup.slice(0, countBoundary)}`,
      ),
    );
    expect(countBatch).toHaveLength(32);
    await sendOldGuestRequest(countBatch);
    await flushWaitUntilForTest();
    expect(
      (await readRunOutputLegacyPiEventsFixture(run.runId)).map((row) => {
        return row.sequenceNumber;
      }),
    ).toStrictEqual([sequence + 31]);
    await sendOldGuestRequest([
      assistant(
        sequence + 32,
        "request-count",
        `${countMarkup.slice(countBoundary)}count-after`,
      ),
      separator(sequence + 33),
    ]);
    sequence += 34;

    const byteMarkup = citation(
      "memory/request-bytes.md",
      "four MiB request split",
    );
    const byteBoundary = Math.floor(byteMarkup.length / 2);
    const largeSystemEvent = {
      type: "system" as const,
      sequenceNumber: sequence,
      subtype: "request-byte-padding",
      padding: "",
    };
    const byteFirst = assistant(
      sequence + 1,
      "request-bytes",
      `bytes-before${byteMarkup.slice(0, byteBoundary)}`,
    );
    const byteSecond = assistant(
      sequence + 2,
      "request-bytes",
      `${byteMarkup.slice(byteBoundary)}bytes-after`,
    );
    const requestCap = 4 * 1024 * 1024;
    const singletonBytes = (event: object): number => {
      return Buffer.byteLength(
        JSON.stringify({ runId: run.runId, events: [event] }),
      );
    };
    largeSystemEvent.padding = "x".repeat(
      requestCap -
        64 -
        singletonBytes(largeSystemEvent) -
        singletonBytes(byteFirst),
    );
    const atByteCap =
      singletonBytes(largeSystemEvent) + singletonBytes(byteFirst);
    expect(atByteCap).toBeLessThanOrEqual(requestCap);
    expect(atByteCap + singletonBytes(byteSecond)).toBeGreaterThan(requestCap);
    await sendOldGuestRequest([largeSystemEvent, byteFirst]);
    await flushWaitUntilForTest();
    expect(
      (await readRunOutputLegacyPiEventsFixture(run.runId)).map((row) => {
        return row.sequenceNumber;
      }),
    ).toStrictEqual([sequence + 1]);
    await sendOldGuestRequest([byteSecond, separator(sequence + 3)]);
    sequence += 4;

    const citationOnlyMarkup = citation(
      "memory/request-citation-only.md",
      "citation only request",
    );
    await sendOldGuestRequest([
      assistant(sequence, "request-citation-only", citationOnlyMarkup),
    ]);
    await sendOldGuestRequest([
      result(sequence + 1, `callback-safe${citationOnlyMarkup}`),
    ]);
    sequence += 2;

    const finalMarkup = citation(
      "memory/request-completion.md",
      "completion flush",
    );
    const finalBoundary = Math.floor(finalMarkup.length / 2);
    await sendOldGuestRequest([
      assistant(
        sequence,
        "request-completion",
        `completion-before${finalMarkup.slice(0, finalBoundary)}`,
      ),
    ]);
    await sendOldGuestRequest([
      assistant(
        sequence + 1,
        "request-completion",
        `${finalMarkup.slice(finalBoundary)}completion-after`,
      ),
    ]);
    expect(
      (await readRunOutputLegacyPiEventsFixture(run.runId)).map((row) => {
        return row.sequenceNumber;
      }),
    ).toStrictEqual([sequence, sequence + 1]);
    await expectNoPrivatePublicOutput();

    await completeChatRunOk(run.runId, claimed.sandboxHeaders, {
      ...frameworkMatchingCompletionOptions(run.threadId, "pi"),
      activeInputDeliveryIds: [reserved.deliveryId],
      lastEventSequence: sequence + 1,
      usagePricingResolution,
    });
    await waitForRunStatus(actor, run.runId, "completed", 5000);
    await flushWaitUntilForTest();

    await expect(
      readRunOutputLegacyPiEventsFixture(run.runId),
    ).resolves.toStrictEqual([]);
    await expect(
      readRunOutputMaterializationFixture(run.runId),
    ).resolves.toMatchObject({
      processedThroughSequence: sequence + 1,
      pendingSequenceNumbers: [],
      latestResultText: "callback-safe",
      latestOutputText: "callback-safe",
    });
    const persistedCitations = await readRunOutputMemoryCitationsFixture(
      run.runId,
    );
    expect(
      persistedCitations.map((item) => {
        return item.sequenceNumber;
      }),
    ).toStrictEqual([
      sequence - 51,
      sequence - 48,
      sequence - 45,
      sequence - 42,
      sequence - 8,
      sequence - 4,
      sequence - 2,
      sequence + 1,
    ]);
    const serializedCitations = JSON.stringify(persistedCitations);
    for (const privateValue of privateValues) {
      expect(serializedCitations).toContain(privateValue);
    }
    const visibleOutput = eventBackedContents(
      (await chat.listThreadEvents(actor, run.threadId)).events,
      run.runId,
    )
      .map((event) => {
        return event.content;
      })
      .join("|");
    for (const visible of [
      "opener-before",
      "opener-after",
      "body-before",
      "body-after",
      "closer-before",
      "closer-after",
      "order-before",
      "order-after",
      "count-before",
      "count-after",
      "bytes-before",
      "bytes-after",
      "completion-before",
      "completion-after",
    ]) {
      expect(visibleOutput).toContain(visible);
    }
    await expectNoPrivatePublicOutput();
  }, 90_000);

  it("transfers authoritative H0 when API ownership expires before provider transport", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const resourceEntered = createDeferredPromise<void>(context.signal);
    const releaseResource = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
        if (!resourceEntered.settled()) {
          resourceEntered.resolve(undefined);
        }
        await releaseResource.promise;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive object identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return nativeCodexSseResponse(
          piResponsesTextSse("must not become H1", modelCalls),
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const prompt = "replay the original pre-provider prompt in Sandbox";
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt,
      });
    const apiStartedAt = now();
    mockNow(apiStartedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await resourceEntered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const activeInputEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "deliver this input once after deadline transfer",
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected deadline-bound active input to be reserved");
    }

    mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS);
    releaseResource.resolve(undefined);
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);

    expect(modelCalls).toBe(0);
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: run.threadId, sha256: null },
      sandboxEventSequenceStart: 1,
    });
    const h0 = checkpointObjects.get(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
    );
    if (!h0) {
      throw new Error("Expected pre-provider deadline H0");
    }
    expect(
      MemoryPiSession.fromJsonl(h0.toString("utf8")).buildSessionContext()
        .messages,
    ).toHaveLength(0);
    expect(claimed.claim.prompt).toBe(prompt);
    expect(claimed.claim.piLaunchConfig?.apiFirstTurn.deadlineAt).toBe(
      apiStartedAt + API_FIRST_TURN_COORDINATION_BUDGET_MS,
    );
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, run.runId),
    ).resolves.toStrictEqual(reserved);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const activeInputEvents = await chat.listThreadEvents(actor, run.threadId);
    expect(
      activeInputEvents.events.filter((event) => {
        return event.revokesEventId === activeInputEventId;
      }),
    ).toHaveLength(1);
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("discards a late API success and completes once from sandbox-first H0", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    const lateApiAnswer = "late API answer must remain usage-only";
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        providerEntered.resolve(undefined);
        await releaseProvider.promise;
        return nativeCodexSseResponse(
          piResponsesTextSse(lateApiAnswer, modelCalls),
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const prompt = "complete the timed-out prompt once in Sandbox";
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt,
      });
    const apiStartedAt = now();
    mockNow(apiStartedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await providerEntered.promise;

    mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 2000);
    releaseProvider.resolve(undefined);
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);

    expect(modelCalls).toBe(1);
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: run.threadId, sha256: null },
      sandboxEventSequenceStart: 1,
    });
    const beforeSandbox = eventBackedContents(
      (await chat.listThreadEvents(actor, run.threadId)).events,
      run.runId,
    );
    expect(beforeSandbox).toStrictEqual([]);
    await flushWaitUntilForTest();
    // Pending late-attempt usage is intentionally absent from public usage
    // summaries, so inspect this run's uniquely owned ledger rows directly.
    await expect(readRunUsageEventsFixture(run.runId)).resolves.toMatchObject([
      { category: "tokens.input", quantity: 5, status: "pending" },
      { category: "tokens.output", quantity: 3, status: "pending" },
    ]);

    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.prompt).toBe(prompt);
    const sandboxAnswer = "Sandbox owns the only visible answer";
    await completeSandboxFirstPiRun({
      actor,
      answer: sandboxAnswer,
      checkpointObjects,
      claim: claimed,
      prompt,
      run,
      usagePricingResolution,
    });
    await expectTerraApiFollowUpUsage(run.runId);

    const completedEvents = (await chat.listThreadEvents(actor, run.threadId))
      .events;
    expect(
      eventBackedContents(completedEvents, run.runId).filter((message) => {
        return message.content === sandboxAnswer;
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(completedEvents)).not.toContain(lateApiAnswer);
    expect(
      completedEvents.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toMatchObject([{ eventType: "run.completed" }]);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "completed",
    });
  }, 90_000);

  it("lets canonical cancellation win the deadline ownership boundary", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        providerEntered.resolve(undefined);
        await releaseProvider.promise;
        return nativeCodexSseResponse(
          piResponsesTextSse("cancelled late API result", modelCalls),
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "cancel at the timeout transfer boundary",
      });
    const apiStartedAt = now();
    mockNow(apiStartedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await providerEntered.promise;

    mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 2000);
    await cancelBeforeLatePiResult(
      actor,
      run.runId,
      () => {
        releaseProvider.resolve(undefined);
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();

    expect(modelCalls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ),
    ).toStrictEqual([]);
    await expectTerraApiFollowUpUsage(run.runId);
    await api.requestClaimRunnerJob(true, run.runId, [404], {
      capabilities: { piModelConfigGenerations: [1, 2, 3] },
    });
  }, 90_000);

  it.each(["deadline", "model failure"] as const)(
    "fails once when deadline handoff cannot settle by the coordination cap after %s",
    async (trigger) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", async () => {
          modelCalls += 1;
          providerEntered.resolve(undefined);
          await releaseProvider.promise;
          if (trigger === "model failure") {
            return HttpResponse.json(
              { error: "private-model-failure-sentinel" },
              { status: 525 },
            );
          }
          return nativeCodexSseResponse(
            piResponsesTextSse("late result before handoff expiry", modelCalls),
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "expire the bounded handoff publication",
        });
      const apiStartedAt = now();
      mockNow(apiStartedAt);
      onTestFinished(() => {
        clearMockNow();
      });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await providerEntered.promise;
      // No public API can deterministically hold this lifecycle transaction
      // across the coordination cap; this run-owned fixture isolates that race.
      const lifecycleLock = await holdPiApiFirstTurnLifecycleLockFixture({
        runId: run.runId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        lifecycleLock.release();
        await lifecycleLock.done;
      });

      if (trigger === "deadline") {
        mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 2000);
      }
      releaseProvider.resolve(undefined);
      await expect.poll(lifecycleLock.waiterCount).toBe(1);
      mockNow(apiStartedAt + API_FIRST_TURN_COORDINATION_BUDGET_MS);
      lifecycleLock.release();
      await lifecycleLock.done;
      await waitForRunStatus(actor, run.runId, "failed", 5000);
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      if (trigger === "deadline") {
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toMatchObject([{ eventType: "run.failed" }]);
    },
    90_000,
  );

  it.each(["deadline", "model failure"] as const)(
    "emits one canonical warning when the sandbox retry fails after %s",
    async (trigger) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", async () => {
          modelCalls += 1;
          providerEntered.resolve(undefined);
          await releaseProvider.promise;
          if (trigger === "model failure") {
            return HttpResponse.json(
              { error: "private-model-failure-sentinel" },
              { status: 525 },
            );
          }
          return nativeCodexSseResponse(
            piResponsesTextSse("discarded before Sandbox failure", modelCalls),
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "let the single Sandbox recovery fail",
        });
      const apiStartedAt = now();
      mockNow(apiStartedAt);
      onTestFinished(() => {
        clearMockNow();
      });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await providerEntered.promise;
      if (trigger === "deadline") {
        mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 2000);
      }
      releaseProvider.resolve(undefined);
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      await expect
        .poll(() => {
          return checkpointObjects.get(manifestKey);
        })
        .toBeInstanceOf(Buffer);
      const claimed = await claimChatRun(runnerGroup, run.runId);

      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "Sandbox retry failed",
        },
        claimed.sandboxHeaders,
        [200],
        undefined,
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, "failed", 5000);
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      if (trigger === "deadline") {
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toMatchObject([{ eventType: "run.failed" }]);
    },
    90_000,
  );

  it("transfers pre-provider active input through one stable sandbox-first delivery", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const resourceEntered = createDeferredPromise<void>(context.signal);
    const releaseResource = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
        if (!resourceEntered.settled()) {
          resourceEntered.resolve(undefined);
        }
        await releaseResource.promise;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive object identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return new HttpResponse(piResponsesTextSse("unexpected", modelCalls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const prompt = "execute the original prompt once in Sandbox";
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt,
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await resourceEntered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    await waitForRunStatus(actor, run.runId, "running", 5000);
    const activeInput = "apply this accepted steer once";
    const activeInputEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: activeInput,
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const sandboxToken = claimed.claim.sandboxToken;
    const reserved = await api.reserveRunnerActiveInputs(
      sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected pre-provider active input to be reserved");
    }
    await expect(
      api.reserveRunnerActiveInputs(sandboxToken, run.runId),
    ).resolves.toStrictEqual(reserved);

    releaseResource.resolve(undefined);
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    expect(modelCalls).toBe(0);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: run.threadId, sha256: null },
      sandboxEventSequenceStart: 1,
    });
    const h0 =
      checkpointObjects
        .get(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        )
        ?.toString("utf8") ?? "";
    expect(
      MemoryPiSession.fromJsonl(h0).buildSessionContext().messages,
    ).toHaveLength(0);
    expect(claimed.claim.prompt).toBe(prompt);
    const receipts = await Promise.all([
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ]);
    expect(receipts).toStrictEqual([
      { outcome: "delivered" },
      { outcome: "delivered" },
    ]);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(
      events.events.filter((event) => {
        return (
          event.runId === run.runId &&
          event.revokesEventId === activeInputEventId
        );
      }),
    ).toHaveLength(1);
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("publishes text H1 once and continues one in-flight active input as a new prompt", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    const apiAnswer = "API H1 settled before the accepted input";
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(piResponsesTextSse(apiAnswer, modelCalls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const originalPrompt = "settle this original API prompt once";
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: originalPrompt,
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await providerEntered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const activeInput = "continue H1 with exactly one new prompt";
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: activeInput,
        clientEventId: randomUUID(),
      },
      [201],
    );
    const sandboxToken = claimed.claim.sandboxToken;
    const reserved = await api.reserveRunnerActiveInputs(
      sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected in-flight active input to be reserved");
    }
    releaseProvider.resolve(undefined);

    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    expect(modelCalls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "settled-session-continuation",
      sandboxEventSequenceStart: 1,
    });
    const apiMessages = eventBackedContents(
      (await chat.listThreadEvents(actor, run.threadId)).events,
      run.runId,
    );
    expect(
      apiMessages.filter((message) => {
        return message.content === apiAnswer;
      }),
    ).toHaveLength(1);

    const h1 =
      checkpointObjects
        .get(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        )
        ?.toString("utf8") ?? "";
    expect(occurrences(h1, originalPrompt)).toBe(1);
    expect(occurrences(h1, apiAnswer)).toBe(1);
    expect(occurrences(h1, activeInput)).toBe(0);
    const h2Session = MemoryPiSession.fromJsonl(h1);
    h2Session.appendMessage({
      role: "user",
      content: activeInput,
      timestamp: 3,
    });
    const sandboxAnswer = "Sandbox answered the accepted prompt once";
    const hiddenCitation =
      "<oai-mem-citation><citation_entries>memory.md:5-8|note=[sandbox used]</citation_entries><rollout_ids>019c6e27-e55b-73d1-87d8-4e01f1f75043</rollout_ids></oai-mem-citation>";
    const sandboxRawAnswer = `${sandboxAnswer}${hiddenCitation}`;
    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: sandboxRawAnswer }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-terra",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    const h2 = h2Session.toJsonl();
    expect(occurrences(h2, originalPrompt)).toBe(1);
    expect(occurrences(h2, activeInput)).toBe(1);
    expect(occurrences(h2, hiddenCitation)).toBe(1);
    const h2Hash = createHash("sha256").update(h2).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: h2Hash,
        rawSize: Buffer.byteLength(h2),
        encodedSize: Buffer.byteLength(h2),
        encoding: "identity",
      },
      claimed.sandboxHeaders,
      [200],
    );
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
      Buffer.from(h2, "utf8"),
    );
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const sandboxCitation = {
      entries: [
        {
          path: "memory.md",
          note: "sandbox used",
          lineStart: 5,
          lineEnd: 8,
        },
      ],
      rolloutIds: ["019c6e27-e55b-73d1-87d8-4e01f1f75043"],
    };
    const sandboxEvents = [
      {
        type: "assistant" as const,
        sequenceNumber: 1,
        message: {
          id: "new-guest-visible-answer",
          content: [{ type: "text" as const, text: sandboxAnswer }],
        },
      },
      {
        type: "result" as const,
        sequenceNumber: 2,
        result: sandboxAnswer,
      },
    ];
    const sandboxEventBody = {
      runId: run.runId,
      events: sandboxEvents,
      piMemoryCitationTransport: {
        schemaVersion: 1 as const,
        citations: [{ sequenceNumber: 1, citation: sandboxCitation }],
      },
    };
    await webhooks.requestAgentEvents(
      sandboxEventBody,
      claimed.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentEvents(
      sandboxEventBody,
      claimed.sandboxHeaders,
      [200],
    );
    const completion = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        lastEventSequence: 2,
        activeInputDeliveryIds: [reserved.deliveryId],
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(completion.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await waitForRunStatus(actor, run.runId, "completed", 5000);
    expect(modelCalls).toBe(1);
    const completedMessages = eventBackedContents(
      (await chat.listThreadEvents(actor, run.threadId)).events,
      run.runId,
    );
    expect(
      completedMessages.filter((message) => {
        return message.content === sandboxAnswer;
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(completedMessages)).not.toContain("oai-mem-citation");
    expect(JSON.stringify(completedMessages)).not.toContain("memory.md");
    // Private provenance intentionally has no user-facing API; this exact
    // event association is the only assertion that crosses the route boundary.
    await expect(
      readRunOutputMemoryCitationsFixture(run.runId),
    ).resolves.toStrictEqual([
      {
        sequenceNumber: 1,
        citation: {
          entries: sandboxCitation.entries,
          rolloutIds: sandboxCitation.rolloutIds,
        },
      },
    ]);
  }, 90_000);

  it("retains pending-tool continuation while one accepted input remains a steer", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesToolSse({
            callId: "call_active_input_tool",
            name: "read",
            arguments: { path: "/home/user/workspace/***/pending.txt" },
            sequence: modelCalls,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const originalPrompt = "start one provider request with a pending tool";
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: originalPrompt,
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await providerEntered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const activeInput = "steer once after the pending tool boundary";
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: activeInput,
        clientEventId: randomUUID(),
      },
      [201],
    );
    const sandboxToken = claimed.claim.sandboxToken;
    const reserved = await api.reserveRunnerActiveInputs(
      sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected pending-tool active input to be reserved");
    }
    releaseProvider.resolve(undefined);

    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "pending-tool-continuation",
      sandboxEventSequenceStart: 1,
    });
    expect(modelCalls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "running",
    });
    const h1 =
      checkpointObjects
        .get(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        )
        ?.toString("utf8") ?? "";
    const h2Session = MemoryPiSession.fromJsonl(h1);
    expect(h2Session.hasPendingToolCalls()).toBeTruthy();
    expect(occurrences(h1, originalPrompt)).toBe(1);
    expect(occurrences(h1, activeInput)).toBe(0);
    const pendingTool = [...h2Session.buildSessionContext().messages]
      .reverse()
      .find((message) => {
        return message.role === "assistant";
      });
    const toolCall =
      pendingTool?.role === "assistant"
        ? pendingTool.content.find((content) => {
            return content.type === "toolCall";
          })
        : undefined;
    if (toolCall?.type !== "toolCall") {
      throw new Error("Expected one pending Pi tool call");
    }
    h2Session.appendMessage({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Sandbox resumed the pending tool" }],
      details: {},
      isError: false,
      timestamp: 3,
    });
    h2Session.appendMessage({
      role: "user",
      content: activeInput,
      timestamp: 4,
    });
    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Sandbox applied the steer once" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-terra",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 5,
    });
    const h2 = h2Session.toJsonl();
    expect(occurrences(h2, originalPrompt)).toBe(1);
    expect(occurrences(h2, activeInput)).toBe(1);
    expect(MemoryPiSession.fromJsonl(h2).hasPendingToolCalls()).toBeFalsy();
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    expect(modelCalls).toBe(1);
  }, 90_000);

  it("lets canonical cancellation win before provider ownership without API artifacts", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const resourceEntered = createDeferredPromise<void>(context.signal);
    const releaseResource = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
        if (!resourceEntered.settled()) {
          resourceEntered.resolve(undefined);
        }
        await releaseResource.promise;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive object identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return new HttpResponse(piResponsesTextSse("late", modelCalls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "cancel before the provider boundary",
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await resourceEntered.promise;
    await cancelChatRun(actor, run.runId);
    releaseResource.resolve(undefined);
    await flushWaitUntilForTest();

    expect(modelCalls).toBe(0);
    await expect(readRunUsageEventsFixture(run.runId)).resolves.toStrictEqual(
      [],
    );
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
      ),
    ).toBeFalsy();
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
      ),
    ).toBeFalsy();
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ),
    ).toHaveLength(0);
    const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expect(claim.status).toBe(404);
  }, 90_000);

  it("does not fabricate usage when cancellation aborts an in-flight provider response", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("discard this late provider result", modelCalls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "cancel one in-flight API-first request",
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await providerEntered.promise;
    await cancelChatRun(actor, run.runId);
    expect(modelCalls).toBe(1);
    releaseProvider.resolve(undefined);
    await flushWaitUntilForTest();

    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(modelCalls).toBe(1);
    await expect(readRunUsageEventsFixture(run.runId)).resolves.toStrictEqual(
      [],
    );
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
      ),
    ).toBeFalsy();
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
      ),
    ).toBeFalsy();
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ),
    ).toHaveLength(0);
    const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expect(claim.status).toBe(404);
  }, 90_000);

  it.each([
    ...GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return (["openai", "openrouter"] as const).map((gptRoute) => {
        return {
          name: `${gptRoute} ${selectedModel}`,
          selectedModel,
          providerUrl:
            gptRoute === "openai"
              ? "https://api.openai.com/v1/responses"
              : "https://openrouter.ai/api/v1/responses",
          observedServiceTier: "default",
          codexServiceTier: "fast" as const,
          gptRoute,
          inputTokens: 10,
          expectedInput: 5,
        };
      });
    }),
    {
      name: "built-in DeepSeek Flash",
      selectedModel: "deepseek-v4-flash",
      providerUrl: "https://api.deepseek.com/responses",
      observedServiceTier: "priority",
      codexServiceTier: undefined,
      gptRoute: undefined,
      inputTokens: 300_000,
      expectedInput: 299_995,
    },
  ] as const)(
    "bills one late $name result exactly once after cancellation wins",
    async ({
      selectedModel,
      providerUrl,
      observedServiceTier,
      codexServiceTier,
      gptRoute,
      inputTokens,
      expectedInput,
    }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      let modelCalls = 0;
      const modelRequests: unknown[] = [];
      server.use(
        http.post(providerUrl, async ({ request }) => {
          modelCalls += 1;
          modelRequests.push(await request.json());
          if (!providerEntered.settled()) {
            providerEntered.resolve(undefined);
          }
          await releaseProvider.promise;
          return new HttpResponse(
            piResponsesTextSse(
              "result blocked before publication",
              modelCalls,
              {
                input_tokens: inputTokens,
                output_tokens: 3,
                total_tokens: inputTokens + 3,
                input_tokens_details: {
                  cached_tokens: 3,
                  cache_write_tokens: 2,
                },
              },
              observedServiceTier,
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "let cancellation commit before API publication",
          ...(codexServiceTier === undefined ? {} : { codexServiceTier }),
          ...(gptRoute === undefined ? {} : { gptRoute }),
          selectedModel,
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
      await providerEntered.promise;
      const lifecycleLock = await holdPiApiFirstTurnLifecycleLockFixture({
        runId: run.runId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        lifecycleLock.release();
        await lifecycleLock.done;
      });

      const cancellation = api.requestCancelRun(
        actor,
        run.runId,
        [200],
        usagePricingResolution,
      );
      await expect.poll(lifecycleLock.waiterCount).toBe(1);
      releaseProvider.resolve(undefined);
      await expect.poll(lifecycleLock.waiterCount).toBe(2);
      lifecycleLock.release();
      await lifecycleLock.done;
      await cancellation;
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      if (codexServiceTier === "fast") {
        expect(
          z
            .object({ service_tier: z.literal("priority") })
            .passthrough()
            .parse(modelRequests[0]).service_tier,
        ).toBe("priority");
      } else {
        expect(modelRequests[0]).not.toHaveProperty("service_tier");
      }
      await expectPiApiUsage(
        run.runId,
        selectedModel,
        gptRoute === "openai" ? ".fast" : "",
        {
          input: expectedInput,
          output: 3,
          cacheRead: 3,
          cacheCreation: 2,
        },
      );
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        ),
      ).toBeFalsy();
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          run.runId,
        ),
      ).toHaveLength(0);
    },
    90_000,
  );

  it("keeps API completion terminal when it wins the lifecycle lock before cancellation", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    const answer = "completion committed before cancellation";
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(piResponsesTextSse(answer, modelCalls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "let API completion commit first",
    });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await providerEntered.promise;
    const lifecycleLock = await holdPiApiFirstTurnLifecycleLockFixture({
      runId: run.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      lifecycleLock.release();
      await lifecycleLock.done;
    });

    releaseProvider.resolve(undefined);
    await expect.poll(lifecycleLock.waiterCount).toBe(1);
    const cancellation = api.requestCancelRun(actor, run.runId, [400]);
    await expect.poll(lifecycleLock.waiterCount).toBe(2);
    lifecycleLock.release();
    await lifecycleLock.done;
    const cancelResponse = await cancellation;
    expectApiError(cancelResponse.body);
    expect(cancelResponse.body.error.message).toContain(
      "Run cannot be cancelled",
    );
    await waitForRunStatus(actor, run.runId, "completed", 5000);
    await flushWaitUntilForTest();

    expect(modelCalls).toBe(1);
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ).filter((message) => {
        return message.content === answer;
      }),
    ).toHaveLength(1);
  }, 90_000);

  it.each([
    { name: "text below cap", content: "text", atCap: false },
    { name: "text at cap", content: "text", atCap: true },
    { name: "empty", content: "empty", atCap: false },
    { name: "thinking-only", content: "thinking", atCap: false },
  ] as const)(
    "fails incomplete Pi $name output once after recording consumed Built-in usage",
    async ({ content, atCap }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      await configureBuiltInPiModel(actor, "gpt-5.6-terra");
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const consumedAgentEvents: { runId: string; eventType: string }[] = [];
      const requests: unknown[] = [];
      let outputTokens = 0;
      const partialText = `private-incomplete-answer-${randomUUID()}`;
      server.use(
        http.post(
          "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
          async ({ request }) => {
            const events = z
              .array(z.object({ runId: z.string(), eventType: z.string() }))
              .parse(await request.json());
            consumedAgentEvents.push(...events);
            return HttpResponse.json({
              ingested: events.length,
              failed: 0,
              processedBytes: 123,
            });
          },
        ),
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            const body = await request.json();
            requests.push(body);
            const { max_output_tokens: cap } = z
              .object({ max_output_tokens: z.number().int().positive() })
              .parse(body);
            expect(cap).toBeGreaterThan(3);
            outputTokens = atCap ? cap : 3;
            return nativeCodexSseResponse(
              piResponsesContentSse({
                sequence: requests.length,
                blocks:
                  content === "text"
                    ? [{ type: "text", text: partialText }]
                    : [],
                includeReasoning: content === "thinking",
                incomplete: true,
                usage: {
                  input_tokens: 10,
                  output_tokens: outputTokens,
                  total_tokens: 10 + outputTokens,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                },
              }),
            );
          },
        ),
      );
      const run = await sendChatRun(
        actor,
        {
          agentId,
          model: "gpt-5.6-terra",
          prompt: "finish one API-first answer",
        },
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "failed");
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      expect(
        [...objects.keys()].filter((key) => {
          return key.includes("/blobs/");
        }),
      ).toStrictEqual([]);
      expect(requests).toHaveLength(1);
      // The existing run-scoped usage observation is the only billing ledger
      // surface; public usage summaries cannot prove per-category exactness.
      await expectTerraApiUsage(run.runId, "", {
        input: 5,
        output: outputTokens,
        cacheRead: 3,
        cacheCreation: 2,
      });
      expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
        `runner-group:${runnerGroup}`,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
        runId: run.runId,
        mode: "hard",
      });
      await api.heartbeatRunner(runnerGroup);
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      const sandboxHeaders = {
        authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
      };
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "failed");
      await expectTerraApiUsage(run.runId, "", {
        input: 5,
        output: outputTokens,
        cacheRead: 3,
        cacheCreation: 2,
      });
      expect(requests).toHaveLength(1);
      expect(
        consumedAgentEvents.filter((event) => {
          return event.runId === run.runId;
        }),
      ).toStrictEqual([]);
    },
    90_000,
  );

  it.each(USER_OWNED_GPT_FAST_BDD_ROUTES)(
    "fails incomplete Pi $name Fast output without Built-in billing or provider substitution",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await configureUserOwnedGptPiModel(actor, route);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: string[] = [];
      server.use(
        ...USER_OWNED_GPT_FAST_BDD_ROUTES.map((candidate) => {
          return http.post(candidate.endpoint, ({ request }) => {
            requests.push(request.url);
            return nativeCodexSseResponse(
              piResponsesContentSse({
                sequence: requests.length,
                blocks: [
                  { type: "text", text: "incomplete user-owned answer" },
                ],
                incomplete: true,
              }),
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "finish the user-owned turn",
        runOptions: { codexServiceTier: "fast" },
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "failed");
      await expectNoBuiltInModelUsage(run.runId);
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      expect(
        [...objects.keys()].filter((key) => {
          return key.includes("/blobs/");
        }),
      ).toStrictEqual([]);
      await api.heartbeatRunner(runnerGroup);
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expect(requests).toStrictEqual([route.endpoint]);
    },
    90_000,
  );

  it.each(["in-flight", "late-result"] as const)(
    "keeps canonical cancellation ahead of incomplete Pi output at the %s boundary",
    async (phase) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let requests = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", async () => {
          requests += 1;
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          return nativeCodexSseResponse(
            piResponsesContentSse({
              sequence: requests,
              blocks: [{ type: "text", text: "incomplete cancelled answer" }],
              incomplete: true,
            }),
          );
        }),
      );
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "cancel an incomplete API-first turn",
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await entered.promise;
      if (phase === "late-result") {
        await cancelBeforeLatePiResult(
          actor,
          run.runId,
          () => {
            release.resolve(undefined);
          },
          usagePricingResolution,
        );
      } else {
        await api.requestCancelRun(
          actor,
          run.runId,
          [200],
          usagePricingResolution,
        );
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "cancelled");
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      if (phase === "late-result") {
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expect(requests).toBe(1);
    },
    90_000,
  );

  it("fails incomplete Pi output while preserving undelivered active-input ownership", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const objects = mockPiCheckpointObjectStore();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const requests: unknown[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.json());
        if (!entered.settled()) {
          entered.resolve(undefined);
        }
        await release.promise;
        return nativeCodexSseResponse(
          piResponsesContentSse({
            sequence: requests.length,
            blocks: [
              {
                type: "text",
                text:
                  requests.length === 1
                    ? "incomplete before accepted steer"
                    : "completed the separately queued input",
              },
            ],
            incomplete: requests.length === 1,
          }),
        );
      }),
    );
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "hold the incomplete API-first turn",
      });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await entered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const activeInputEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "keep this accepted input",
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected in-flight active input to be reserved");
    }
    expect(reserved.prompt).toContain("keep this accepted input");
    release.resolve(undefined);
    await waitForRunStatus(actor, run.runId, "failed");
    await flushWaitUntilForTest();
    await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "failed");
    expectNoPiApiFirstTurnArtifacts(run.runId, objects);
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, run.runId),
    ).resolves.toStrictEqual({ outcome: "terminal" });
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toMatchObject({ outcome: "rejected" });
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return event.id === activeInputEventId;
      }),
    ).toHaveLength(1);
    const replacements = events.filter((event) => {
      return event.revokesEventId === activeInputEventId;
    });
    expect(replacements).toHaveLength(1);
    const successor = replacements[0];
    if (!successor?.runId) {
      throw new Error("Expected undelivered input to retain queue ownership");
    }
    expect(successor.runId).not.toBe(run.runId);
    // Terminal failure releases the accepted input into its own queued run.
    // That explicit input owns the second request; the failed turn is not retried.
    await waitForRunStatus(actor, successor.runId, "completed");
    expect(eventBackedContents(events, successor.runId)).toMatchObject([
      { content: "completed the separately queued input" },
    ]);
    expect(JSON.stringify(requests[1])).toContain("keep this accepted input");
    expect(JSON.stringify(requests[1])).not.toContain(
      "incomplete before accepted steer",
    );
    await expectTerraApiFollowUpUsage(run.runId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: run.runId,
      mode: "hard",
    });
    expect(requests).toHaveLength(2);
  }, 90_000);

  it("preserves ordinary Pi stop checkpoints and length with pending tools after incomplete output fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    mockPiResourceArchiveDownloads();
    const objects = mockPiCheckpointObjectStore();
    const requests: unknown[] = [];
    const answer = "the last complete canonical answer";
    const incompleteAnswer = "discarded incomplete canonical answer";
    const callId = `call_length_${randomUUID()}`;
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.json());
        return nativeCodexSseResponse(
          piResponsesContentSse({
            sequence: requests.length,
            incomplete: requests.length !== 1,
            blocks:
              requests.length === 3
                ? [
                    {
                      type: "toolCall",
                      callId,
                      name: "bash",
                      arguments: {
                        command: "printf incomplete-tool-must-not-run",
                      },
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: requests.length === 1 ? answer : incompleteAnswer,
                    },
                  ],
          }),
        );
      }),
    );
    const first = await sendChatRun(
      actor,
      {
        agentId,
        model: "gpt-5.6-terra",
        prompt: "create the last complete checkpoint",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();
    expect(requests).toHaveLength(1);
    const firstEvents = (await chat.listThreadEvents(actor, first.threadId))
      .events;
    expect(eventBackedContents(firstEvents, first.runId)).toMatchObject([
      { content: answer },
    ]);
    expect(
      firstEvents.filter((event) => {
        return (
          event.runId === first.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toMatchObject([{ eventType: "run.completed" }]);
    await expectTerraApiFollowUpUsage(first.runId);
    const blobEntries = [...objects.entries()].filter(([key]) => {
      return key.includes("/blobs/");
    });
    expect(blobEntries).toHaveLength(1);
    const h0 = blobEntries[0]?.[1];
    if (!h0) {
      throw new Error("Expected the ordinary stop checkpoint");
    }
    const h0Hash = createHash("sha256").update(h0).digest("hex");

    const failed = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "produce incomplete output on the existing session",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, failed.runId, "failed");
    await flushWaitUntilForTest();
    await expectPiApiFirstTurnTerminalWithoutOutput(actor, failed, "failed");
    expectNoPiApiFirstTurnArtifacts(failed.runId, objects);
    expect(
      [...objects.entries()].filter(([key]) => {
        return key.includes("/blobs/");
      }),
    ).toStrictEqual(blobEntries);
    expect(requests).toHaveLength(2);

    // Only this explicit user request continues the last successful H0. The
    // failed turn cannot publish a new canonical checkpoint or start a retry.
    const next = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "continue the preserved canonical session with tools",
      },
      usagePricingResolution,
    );
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${next.runId}/manifest.json`;
    await expect
      .poll(() => {
        return objects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    await flushWaitUntilForTest();
    const manifestBytes = objects.get(manifestKey);
    if (!manifestBytes) {
      throw new Error("Expected pending-tool ownership transfer");
    }
    expect(
      piApiFirstTurnManifestSchema.parse(
        JSON.parse(manifestBytes.toString("utf8")),
      ),
    ).toMatchObject({
      outcome: "ownership-transfer",
      mode: "pending-tool-continuation",
      baseSession: { sessionId: first.threadId, sha256: h0Hash },
    });
    const claimed = await claimChatRun(runnerGroup, next.runId);
    expect(claimed.claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { hash: h0Hash },
    });
    const h1 = objects.get(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${next.runId}/session.jsonl`,
    );
    if (!h1) {
      throw new Error("Expected length plus pending-tool H1");
    }
    const pending = MemoryPiSession.fromJsonl(h1.toString("utf8"))
      .buildSessionContext()
      .messages.at(-1);
    expect(pending).toMatchObject({
      role: "assistant",
      stopReason: "length",
      content: [expect.objectContaining({ type: "toolCall", name: "bash" })],
    });
    expect(occurrences(JSON.stringify(requests[2]), answer)).toBe(1);
    expect(JSON.stringify(requests[2])).not.toContain(incompleteAnswer);
    expect(
      [...objects.entries()].filter(([key]) => {
        return key.includes("/blobs/");
      }),
    ).toStrictEqual(blobEntries);
    const events = (await chat.listThreadEvents(actor, next.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === next.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toStrictEqual([]);
    await cancelChatRun(actor, next.runId, claimed.sandboxHeaders);
    expect(requests).toHaveLength(3);
  }, 90_000);

  it.each([
    { name: "HTTP 522", status: 522, category: "http_error" },
    { name: "HTTP 525", status: 525, category: "http_error" },
    { name: "unknown model failure", status: 200, category: "unknown" },
    { name: "terminated stream", status: 200, category: "stream_terminated" },
    { name: "failed result with usage", status: 200, category: "unknown" },
  ])(
    "hands $name directly to Sandbox and completes the same run once",
    async (scenario) => {
      mockOptionalEnv("OKOU_DEBUG", "pi-api-first-turn");
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const privateMarker = "private-provider-sentinel-32751";
      const partial = "partial assistant output must not become H1";
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          if (scenario.status !== 200) {
            return HttpResponse.json(
              {
                error: {
                  message: `${privateMarker} https://private.example/?token=secret ${"x".repeat(10_000)}`,
                },
              },
              { status: scenario.status },
            );
          }
          const body = piResponsesTextSse(partial, 1);
          if (scenario.name === "failed result with usage") {
            return nativeCodexSseResponse(
              body
                .replace(
                  '"type":"response.completed"',
                  '"type":"response.incomplete"',
                )
                .replace(
                  '"status":"completed","output"',
                  '"status":"incomplete","output"',
                ),
            );
          }
          const prefix = body.slice(0, body.lastIndexOf("data: "));
          if (scenario.name === "terminated stream") {
            let emitted = false;
            return new HttpResponse(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (!emitted) {
                    emitted = true;
                    controller.enqueue(new TextEncoder().encode(prefix));
                  } else {
                    controller.error(new TypeError("terminated"));
                  }
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return nativeCodexSseResponse(
            `${prefix}data: ${JSON.stringify({ type: "error", code: "unknown", message: privateMarker })}\n\n`,
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const prompt = "keep the original input for one Sandbox handoff";
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt,
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await flushWaitUntilForTest();
      const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/`;
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(
          checkpointObjects.get(`${prefix}manifest.json`)?.toString("utf8") ??
            "{}",
        ),
      );
      expect(manifest).toMatchObject({
        schemaVersion: 3,
        outcome: "ownership-transfer",
        mode: "sandbox-first",
        baseSession: { sessionId: run.threadId, sha256: null },
        sandboxEventSequenceStart: 1,
      });
      const h0 = checkpointObjects.get(`${prefix}session.jsonl`);
      if (!h0) {
        throw new Error("Expected original H0 after model failure");
      }
      expect(
        MemoryPiSession.fromJsonl(h0.toString("utf8")).buildSessionContext()
          .messages,
      ).toStrictEqual([]);
      expect(manifest.session).toMatchObject({
        sessionId: run.threadId,
        rawSize: h0.length,
        sha256: createHash("sha256").update(h0).digest("hex"),
      });
      expect(modelCalls).toBe(1);
      const before = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(eventBackedContents(before, run.runId)).toStrictEqual([]);
      expect(
        before.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toStrictEqual([]);
      expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
        "cancel",
        expect.objectContaining({ runId: run.runId }),
      );
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.prompt).toBe(prompt);
      const answer = "Sandbox recovered the failed model turn";
      await completeSandboxFirstPiRun({
        actor,
        answer,
        checkpointObjects,
        claim: claimed,
        prompt,
        run,
        usagePricingResolution,
      });
      if (scenario.name === "failed result with usage") {
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toMatchObject([{ eventType: "run.completed" }]);
      expect(
        eventBackedContents(events, run.runId).filter((event) => {
          return event.content === answer;
        }),
      ).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(partial);
      expect(modelCalls).toBe(1);
    },
    90_000,
  );

  it("preserves subscription H0 and active input after a failed resumed model turn", async () => {
    mockOptionalEnv("OKOU_DEBUG", "pi-api-first-turn");
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await configureSubscriptionPiModel(actor, {
      accountId: "model-handoff-account",
    });
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://chatgpt.com/backend-api/codex/responses", async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return nativeCodexSseResponse(
            piResponsesTextSse("previous settled subscription answer", 0),
          );
        }
        entered.resolve(undefined);
        await release.promise;
        return HttpResponse.json(
          { error: "private subscription provider failure" },
          { status: 525 },
        );
      }),
    );
    const first = await sendChatRun(actor, {
      agentId,
      model: "gpt-5.6-terra",
      prompt: "establish original subscription history",
    });
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();
    const prompt = "resume from the settled subscription H0";
    const run = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      model: "gpt-5.6-terra",
      prompt,
    });
    await entered.promise;
    await api.heartbeatRunner(runnerGroup);
    const claim = await claimGptPiSandbox(actor, run.runId, undefined);
    const activeInputEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "preserve this in-flight active input",
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claim.sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected one reserved active input");
    }
    release.resolve(undefined);
    await flushWaitUntilForTest();
    const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/`;
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(
        checkpointObjects.get(`${prefix}manifest.json`)?.toString("utf8") ??
          "{}",
      ),
    );
    expect(manifest).toMatchObject({
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      sandboxEventSequenceStart: 1,
      baseSession: { sessionId: first.threadId, sha256: expect.any(String) },
    });
    expect(claim.prompt).toBe(prompt);
    expect(claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { hash: manifest.baseSession.sha256 },
    });
    const h0 = checkpointObjects.get(`${prefix}session.jsonl`);
    expect(h0).toStrictEqual(
      checkpointObjects.get(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${manifest.baseSession.sha256}.blob`,
      ),
    );
    expect(h0?.toString("utf8")).toContain(
      "previous settled subscription answer",
    );
    expect(h0?.toString("utf8")).not.toContain(prompt);
    await expect(
      api.reserveRunnerActiveInputs(claim.sandboxToken, run.runId),
    ).resolves.toStrictEqual(reserved);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return event.revokesEventId === activeInputEventId;
      }),
    ).toHaveLength(1);
    expect(
      events.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toStrictEqual([]);
    expect(modelCalls).toBe(2);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    await expectNoBuiltInModelUsage(run.runId);
    await cancelChatRun(actor, run.runId, {
      authorization: `Bearer ${claim.sandboxToken}`,
    });
  }, 90_000);

  it("keeps a raw API usage failure terminal before aborting its private attempt", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return nativeCodexSseResponse(
          piResponsesTextSse(
            "invalid usage must not authorize H0 replay",
            modelCalls,
            {
              input_tokens: 1.5,
              output_tokens: 3,
              total_tokens: 4.5,
            },
          ),
        );
      }),
    );
    const objects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "reject invalid provider usage without retrying the prompt",
      });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await waitForRunStatus(actor, run.runId, "failed");
    await flushWaitUntilForTest();
    expect(modelCalls).toBe(1);
    expectNoPiApiFirstTurnArtifacts(run.runId, objects);
    await expectPiApiFirstTurnTerminalWithoutOutput(
      actor,
      run,
      "failed",
      "[PI_API_MODEL_FAILED] Pi API first turn failed",
    );
    await expectNoBuiltInModelUsage(run.runId);
  }, 90_000);

  it.each(["H1 commit", "H1 deadline", "handoff publication"] as const)(
    "keeps a genuine %s failure terminal without replaying H0",
    async (stage) => {
      mockOptionalEnv("OKOU_DEBUG", "pi-api-first-turn");
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return stage !== "handoff publication"
            ? nativeCodexSseResponse(
                piResponsesTextSse("uncommitted API answer", 1),
              )
            : HttpResponse.json(
                { error: "private model sentinel" },
                { status: 522 },
              );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "surface the real publication failure",
        });
      const deadline = new AbortController();
      onTestFinished(() => {
        deadline.abort();
      });
      if (stage === "H1 deadline") {
        // The public API cannot expire an OS timer at the H1 write boundary.
        // Keep real AbortSignal propagation with this test-owned deadline.
        context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
          return milliseconds > API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 1000 &&
            milliseconds <= API_FIRST_TURN_OWNERSHIP_BUDGET_MS
            ? deadline.signal
            : undefined;
        });
      }
      const store = context.mocks.s3.send.getMockImplementation();
      const sessionWrites: Buffer[] = [];
      let manifestWrites = 0;
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const candidate = command as PiCheckpointS3Command;
        const key = piS3ObjectKey(candidate);
        if (
          candidate.constructor?.name === "PutObjectCommand" &&
          key?.includes(`/pi-api-first-turn/${run.runId}/`)
        ) {
          if (key.endsWith("session.jsonl")) {
            if (!(candidate.input?.Body instanceof Uint8Array)) {
              throw new Error("Expected session bytes");
            }
            sessionWrites.push(Buffer.from(candidate.input.Body));
            if (stage === "H1 deadline") {
              deadline.abort(
                new DOMException(
                  "API ownership expired during H1 write",
                  "TimeoutError",
                ),
              );
              return Promise.reject(deadline.signal.reason);
            }
            if (stage !== "handoff publication") {
              return Promise.reject(new Error("private storage sentinel"));
            }
          }
          if (key.endsWith("manifest.json")) {
            manifestWrites += 1;
            return Promise.reject(new Error("private storage sentinel"));
          }
        }
        return store?.(command) ?? Promise.resolve({});
      });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(1);
      expect(sessionWrites).toHaveLength(1);
      expect(manifestWrites).toBe(stage !== "handoff publication" ? 0 : 1);
      if (stage !== "handoff publication") {
        expect(sessionWrites[0]?.toString("utf8")).toContain(
          "uncommitted API answer",
        );
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        expect(
          MemoryPiSession.fromJsonl(
            sessionWrites[0]?.toString("utf8") ?? "",
          ).buildSessionContext().messages,
        ).toStrictEqual([]);
      }
      const errorCode =
        stage === "H1 deadline"
          ? "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
          : stage === "H1 commit"
            ? "PI_API_COMMIT_FAILED"
            : "PI_API_SANDBOX_FALLBACK_FAILED";
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining(`[${errorCode}]`),
      });
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(eventBackedContents(events, run.runId)).toStrictEqual([]);
      expect(
        events.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toMatchObject([{ eventType: "run.failed" }]);
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      await api.requestClaimRunnerJob(true, run.runId, [404]);
    },
    90_000,
  );

  it("lets canonical cancellation win a failed model handoff", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        entered.resolve(undefined);
        await release.promise;
        return HttpResponse.json(
          { error: "private cancelled model failure" },
          { status: 522 },
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "cancel instead of reviving the run",
      });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await entered.promise;
    await cancelBeforeLatePiResult(
      actor,
      run.runId,
      () => {
        return release.resolve(undefined);
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
    expect(modelCalls).toBe(1);
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toMatchObject([{ eventType: "run.cancelled" }]);
    await api.requestClaimRunnerJob(true, run.runId, [404]);
  }, 90_000);

  it.each([401, 403])(
    "keeps an explicit HTTP %s credential failure terminal",
    async (status) => {
      mockOptionalEnv("OKOU_DEBUG", "pi-api-first-turn");
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return HttpResponse.json(
            {
              error: {
                code: "invalid_api_key",
                message: "private-credential-sentinel",
              },
            },
            { status },
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "preserve explicit credential failure",
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      expect(modelCalls).toBe(1);
      const failed = await api.readRun(actor, run.runId);
      expect(failed.error).toContain("[PI_API_MODEL_FAILED]");
      expect(JSON.stringify(failed)).not.toContain(
        "private-credential-sentinel",
      );
      await api.requestClaimRunnerJob(true, run.runId, [404]);
    },
    90_000,
  );

  it.each([
    { encoding: "identity", responseLost: false },
    { encoding: "gzip", responseLost: false },
    { encoding: "zstd", responseLost: false },
    { encoding: "identity", responseLost: true },
  ] as const)(
    "saves large Pi $encoding history without API history or resource IO (publication response lost: $responseLost)",
    async ({ encoding, responseLost }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      let resourceDownloads = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return nativeCodexSseResponse(
            piResponsesTextSse("unexpected API answer", modelCalls),
          );
        }),
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
          resourceDownloads += 1;
          return HttpResponse.json(
            { error: "API resources unavailable" },
            { status: 503 },
          );
        }),
      );
      const queued = await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "/skill:long-session finish in sandbox",
      });
      await completeChatRunOk(
        queued.anchor.runId,
        queued.anchorClaim.sandboxHeaders,
        { usagePricingResolution: queued.usagePricingResolution },
      );
      await flushWaitUntilForTest();
      const { run } = queued;
      const claimed = await claimChatRun(runnerGroup, run.runId);
      const session = MemoryPiSession.create({
        cwd: "/home/user/workspace",
        id: run.threadId,
      });
      session.appendMessage({
        role: "user",
        content: "preserve the complete native history",
        timestamp: 1,
      });
      session.appendMessage({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "x".repeat(PI_API_FIRST_TURN_SESSION_MAX_BYTES),
          },
        ],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-terra",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      const raw = Buffer.from(session.toJsonl());
      const encoded =
        encoding === "gzip"
          ? gzipSync(raw)
          : encoding === "zstd"
            ? zstdCompressSync(raw)
            : raw;
      const hash = createHash("sha256").update(raw).digest("hex");
      expect(raw.length).toBeGreaterThan(PI_API_FIRST_TURN_SESSION_MAX_BYTES);
      const invalidHash = createHash("sha256")
        .update(randomUUID())
        .digest("hex");
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: invalidHash,
          rawSize: encoding === "identity" ? raw.length : 1,
          encodedSize: encoded.length,
          encoding,
        },
        claimed.sandboxHeaders,
        [200],
      );
      const invalidSuffix =
        encoding === "identity"
          ? "blob"
          : encoding === "gzip"
            ? "blob.gz"
            : "blob.zst";
      checkpointObjects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${invalidHash}.${invalidSuffix}`,
        encoded,
      );
      const invalidCheckpoint = await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryHash: invalidHash,
          },
        },
        claimed.sandboxHeaders,
        [400],
        undefined,
        queued.usagePricingResolution,
      );
      expect(JSON.stringify(invalidCheckpoint.body)).toContain(
        encoding === "identity"
          ? "[PI_H2_HASH_MISMATCH]"
          : "[PI_H2_DECOMPRESSION_FAILED]",
      );
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "running",
      });
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash,
          rawSize: raw.length,
          encodedSize: encoded.length,
          encoding,
        },
        claimed.sandboxHeaders,
        [200],
      );
      const suffix =
        encoding === "identity"
          ? "blob"
          : encoding === "gzip"
            ? "blob.gz"
            : "blob.zst";
      const blobKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${hash}.${suffix}`;
      checkpointObjects.set(blobKey, encoded);
      const completed = await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryHash: hash,
          },
        },
        claimed.sandboxHeaders,
        [200],
        undefined,
        queued.usagePricingResolution,
      );
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "completed",
      });
      if (responseLost) {
        const deadline = new AbortController();
        onTestFinished(() => {
          deadline.abort();
        });
        // An object-store response can be lost after the manifest is visible.
        // Expire the real attempt signal exactly at that external boundary.
        context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
          return milliseconds > API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 1000 &&
            milliseconds <= API_FIRST_TURN_OWNERSHIP_BUDGET_MS
            ? deadline.signal
            : undefined;
        });
        const send = context.mocks.s3.send.getMockImplementation();
        if (!send) {
          throw new Error("Expected the checkpoint object store");
        }
        context.mocks.s3.send.mockImplementation(async (command: unknown) => {
          const candidate = command as PiCheckpointS3Command;
          const stored = await send(command);
          if (
            candidate.constructor?.name === "PutObjectCommand" &&
            piS3ObjectKey(candidate)?.endsWith("/manifest.json")
          ) {
            expect(
              checkpointObjects.has(piS3ObjectKey(candidate) ?? ""),
            ).toBeTruthy();
            deadline.abort(
              new DOMException(
                "Manifest response lost at ownership deadline",
                "TimeoutError",
              ),
            );
            throw deadline.signal.reason;
          }
          return stored;
        });
      }
      const callsBeforeResume = context.mocks.s3.send.mock.calls.length;
      const resumed = await sendChatRun(
        actor,
        {
          agentId,
          threadId: run.threadId,
          prompt: "continue the long session",
          model: "gpt-5.6-terra",
        },
        queued.usagePricingResolution,
      );
      await flushWaitUntilForTest();
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${resumed.runId}/manifest.json`;
      // Terminal cleanup removes the failed run's object. The captured write
      // still proves that ownership publication happened before its response
      // was lost; the normal transfer retains its currently readable object.
      const publishedManifest = responseLost
        ? uploadedPiS3Object(manifestKey)
        : checkpointObjects.get(manifestKey);
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(publishedManifest?.toString("utf8") ?? "{}"),
      );
      expect(manifest).toMatchObject({
        schemaVersion: 4,
        mode: "sandbox-first",
        outcome: "ownership-transfer",
        baseSession: { sessionId: run.threadId, sha256: hash },
        session: { sessionId: run.threadId, sha256: hash, rawSize: raw.length },
        history: {
          encoding,
          encodedSize: encoded.length,
          url: expect.any(String),
        },
        sandboxEventSequenceStart: 1,
      });
      if (manifest.schemaVersion !== 4) {
        throw new Error("Expected a referenced sandbox checkpoint");
      }
      expect(new URL(manifest.history.url).searchParams.get("object")).toBe(
        blobKey,
      );
      expect(modelCalls).toBe(0);
      expect(resourceDownloads).toBe(0);
      expect(
        context.mocks.s3.send.mock.calls
          .slice(callsBeforeResume)
          .some(([command]) => {
            const candidate = command as PiCheckpointS3Command;
            return (
              candidate.constructor?.name === "GetObjectCommand" &&
              piS3ObjectKey(candidate) === blobKey
            );
          }),
      ).toBeFalsy();
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${resumed.runId}/session.jsonl`,
        ),
      ).toBeFalsy();
      if (responseLost) {
        await waitForRunStatus(actor, resumed.runId, "failed");
        await expectPiApiFirstTurnTerminalWithoutOutput(
          actor,
          resumed,
          "failed",
          "[PI_API_FIRST_TURN_DEADLINE_EXCEEDED] Pi API first-turn deadline elapsed",
        );
        expect(
          context.mocks.s3.send.mock.calls
            .slice(callsBeforeResume)
            .filter(([command]) => {
              const candidate = command as PiCheckpointS3Command;
              return (
                candidate.constructor?.name === "PutObjectCommand" &&
                piS3ObjectKey(candidate) === manifestKey
              );
            }),
        ).toHaveLength(1);
        await api.requestClaimRunnerJob(true, resumed.runId, [404]);
        return;
      }
      const resumedClaim = await claimChatRun(runnerGroup, resumed.runId);
      expect(resumedClaim.claim.resumeSession).toMatchObject({
        sessionId: run.threadId,
        historyRef: { hash, encoding, rawSize: raw.length },
      });
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: resumed.runId,
          hash: "f".repeat(64),
          rawSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
          encodedSize: 1,
          encoding,
        },
        resumedClaim.sandboxHeaders,
        [400],
      );
      await cancelChatRun(actor, resumed.runId, resumedClaim.sandboxHeaders);
    },
    30_000,
  );

  it.each([
    "/skill:handoff-skill first  argument\nsecond line",
    " \n\t/skill:handoff-skill first  argument\nsecond line",
    "/unknown-command first  argument\nsecond line",
    "/home/user/workspace/report.txt first  argument\nsecond line",
  ])(
    "hands native input %j to Sandbox with exact fresh and resumed H0",
    async (prompt) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      let resourceDownloads = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return nativeCodexSseResponse(
            piResponsesTextSse("ordinary API answer", modelCalls),
          );
        }),
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
          resourceDownloads += 1;
          return HttpResponse.json(
            { error: "API resources unavailable" },
            { status: 503 },
          );
        }),
      );
      const queued = await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt,
      });
      await completeChatRunOk(
        queued.anchor.runId,
        queued.anchorClaim.sandboxHeaders,
        {
          usagePricingResolution: queued.usagePricingResolution,
        },
      );
      let run = queued.run;
      let expectedH0: Buffer | undefined;
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      for (const turn of [1, 2]) {
        const originalPrompt = turn === 1 ? prompt : `${prompt}\nresume once`;
        if (turn === 2) {
          run = await sendChatRun(
            actor,
            {
              agentId,
              threadId: run.threadId,
              prompt: originalPrompt,
              model: "gpt-5.6-terra",
            },
            queued.usagePricingResolution,
          );
        }
        await flushWaitUntilForTest();
        const manifestKey = `${bucket}/pi-api-first-turn/${run.runId}/manifest.json`;
        const sessionKey = `${bucket}/pi-api-first-turn/${run.runId}/session.jsonl`;
        const manifestBytes = checkpointObjects.get(manifestKey);
        const h0 = checkpointObjects.get(sessionKey);
        if (!manifestBytes || !h0) {
          throw new Error("Expected native-input Sandbox manifest and H0");
        }
        const manifest = piApiFirstTurnManifestSchema.parse(
          JSON.parse(manifestBytes.toString("utf8")),
        );
        expect(manifest).toMatchObject({
          schemaVersion: 3,
          outcome: "ownership-transfer",
          mode: "sandbox-first",
          baseSession: {
            sessionId: run.threadId,
            sha256: expectedH0
              ? createHash("sha256").update(expectedH0).digest("hex")
              : null,
          },
          session: {
            sessionId: run.threadId,
            sha256: createHash("sha256").update(h0).digest("hex"),
            rawSize: h0.length,
          },
          sandboxEventSequenceStart: 1,
        });
        if (expectedH0) {
          expect(h0).toStrictEqual(expectedH0);
        }
        const session = MemoryPiSession.fromJsonl(h0.toString("utf8"));
        expect(session.getSessionId()).toBe(run.threadId);
        expect(session.buildSessionContext().messages).toHaveLength(
          (turn - 1) * 2,
        );
        const writes = context.mocks.s3.send.mock.calls.flatMap(([command]) => {
          const candidate = command as PiCheckpointS3Command;
          const key = piS3ObjectKey(candidate);
          return candidate.constructor?.name === "PutObjectCommand" &&
            (key === sessionKey || key === manifestKey)
            ? [key]
            : [];
        });
        expect(writes).toStrictEqual([sessionKey, manifestKey]);
        expect(modelCalls).toBe(0);
        expect(resourceDownloads).toBe(0);
        // Public usage summaries omit pending usage, so inspect this run's
        // uniquely owned ledger to rule out duplicate API billing ownership.
        await expect(
          readRunUsageEventsFixture(run.runId),
        ).resolves.toStrictEqual([]);
        const claim = await claimChatRun(runnerGroup, run.runId);
        expect(claim.claim).toMatchObject({
          cliAgentType: "pi",
          piSessionId: run.threadId,
          prompt: originalPrompt,
          piLaunchConfig: { apiFirstTurn: { sandboxEventSequenceStart: 1 } },
        });

        const sandboxUsage = {
          idempotencyKey: randomUUID(),
          kind: "model" as const,
          provider: "gpt-5.6-terra",
          category: "tokens.output",
          quantity: 2,
        };
        for (const _receipt of [1, 2]) {
          await webhooks.requestAgentUsageEvent(
            { runId: run.runId, events: [sandboxUsage] },
            claim.sandboxHeaders,
            [200],
            queued.usagePricingResolution,
          );
        }

        const answer = `native Sandbox answer ${turn}`;
        // This exercises the external Sandbox checkpoint/completion boundary.
        // pi-agent-loop.test.ts separately runs the real official RPC/AgentSession
        // with a mounted skill and checks its actual expanded provider input.
        await completeSandboxFirstPiRun({
          actor,
          answer,
          checkpointObjects,
          claim,
          prompt: originalPrompt,
          run,
          usagePricingResolution: queued.usagePricingResolution,
        });
        const events = (await chat.listThreadEvents(actor, run.threadId))
          .events;
        expect(
          events
            .filter((event) => {
              return (
                event.runId === run.runId &&
                isChatRunTerminalEventType(event.eventType)
              );
            })
            .map((event) => {
              return event.eventType;
            }),
        ).toStrictEqual(["run.completed"]);
        expect(
          eventBackedContents(events, run.runId).filter((message) => {
            return message.content === answer;
          }),
        ).toHaveLength(1);
        await expect(
          readRunUsageEventsFixture(run.runId),
        ).resolves.toStrictEqual([
          expect.objectContaining({
            provider: "gpt-5.6-terra",
            category: "tokens.output",
            quantity: 2,
            status: "processed",
            billingError: null,
          }),
        ]);
        await expect(
          readThreadSessionConversation(context, run.threadId),
        ).resolves.toMatchObject({ conversation_run_id: run.runId });
        const blob = [...checkpointObjects.entries()]
          .filter(([key]) => {
            return key.startsWith(`${bucket}/blobs/`);
          })
          .at(-1);
        if (!blob) {
          throw new Error("Expected the Sandbox's settled checkpoint");
        }
        expectedH0 = blob[1];
        const settled = MemoryPiSession.fromJsonl(expectedH0.toString("utf8"));
        expect(settled.getSessionId()).toBe(run.threadId);
        expect(settled.isSettledCheckpoint()).toBeTruthy();
        expect(settled.buildSessionContext().messages).toHaveLength(turn * 2);
      }

      mockPiResourceArchiveDownloads();
      const ordinary = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "ordinary prose with /skill:handoff-skill later in the text",
          model: "gpt-5.6-terra",
        },
        queued.usagePricingResolution,
      );
      await flushWaitUntilForTest();
      await waitForRunStatus(actor, ordinary.runId, "completed");
      expect(modelCalls).toBe(1);
    },
    90_000,
  );

  it.each(["readback mismatch", "coordination deadline"] as const)(
    "fails native-input publication safely on %s",
    async (failure) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return nativeCodexSseResponse(
            piResponsesTextSse("unsafe API turn", modelCalls),
          );
        }),
      );
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "/skill:handoff-skill preserve  arguments",
        });
      const sessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`;
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      const send = context.mocks.s3.send.getMockImplementation();
      if (!send) {
        throw new Error("Expected the checkpoint object-store boundary");
      }
      const apiStartedAt = now();
      mockNow(apiStartedAt);
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const candidate = command as PiCheckpointS3Command;
        if (
          candidate.constructor?.name === "GetObjectCommand" &&
          piS3ObjectKey(candidate) === sessionKey
        ) {
          if (failure === "coordination deadline") {
            mockNow(apiStartedAt + API_FIRST_TURN_COORDINATION_BUDGET_MS);
          } else {
            const bytes = checkpointObjects.get(sessionKey);
            if (!bytes) {
              throw new Error("Expected uploaded H0 before readback");
            }
            const corrupted = Buffer.from(bytes);
            corrupted[0] = 0;
            checkpointObjects.set(sessionKey, corrupted);
          }
        }
        return send(command);
      });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(0);
      expect(uploadedPiS3Object(manifestKey)).toBeUndefined();
      await api.requestClaimRunnerJob(true, run.runId, [404]);
      expect((await api.readRun(actor, run.runId)).error).toContain(
        failure === "coordination deadline"
          ? "[PI_API_FIRST_TURN_DEADLINE_EXCEEDED]"
          : "[PI_API_SANDBOX_FALLBACK_FAILED]",
      );
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events
          .filter((event) => {
            return (
              event.runId === run.runId &&
              isChatRunTerminalEventType(event.eventType)
            );
          })
          .map((event) => {
            return event.eventType;
          }),
      ).toStrictEqual(["run.failed"]);
      expect(eventBackedContents(events, run.runId)).toStrictEqual([]);
    },
    90_000,
  );

  it.each(["cancelled", "failed"] as const)(
    "does not publish native-input H0 after lifecycle ownership becomes %s",
    async (status) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return nativeCodexSseResponse(
            piResponsesTextSse("unsafe API turn", modelCalls),
          );
        }),
      );
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "/skill:handoff-skill preserve  arguments",
        });
      // Only this run-owned fixture can hold publication at the lifecycle
      // boundary while a real cancellation or Sandbox failure wins ownership.
      const lock = await holdPiApiFirstTurnLifecycleLockFixture({
        runId: run.runId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        lock.release();
        await lock.done;
      });
      if (status === "cancelled") {
        const cancellation = api.requestCancelRun(
          actor,
          run.runId,
          [200],
          usagePricingResolution,
        );
        await expect.poll(lock.waiterCount).toBe(1);
        await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
          usagePricingResolution,
        });
        await expect.poll(lock.waiterCount).toBe(2);
        lock.release();
        await lock.done;
        await cancellation;
      } else {
        await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
          usagePricingResolution,
        });
        await expect.poll(lock.waiterCount).toBe(1);
        const claim = await claimChatRun(runnerGroup, run.runId);
        await failChatRun(
          run.runId,
          claim.sandboxHeaders,
          "Sandbox startup failed before takeover",
        );
        lock.release();
        await lock.done;
      }
      await waitForRunStatus(actor, run.runId, status);
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(0);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events
          .filter((event) => {
            return (
              event.runId === run.runId &&
              isChatRunTerminalEventType(event.eventType)
            );
          })
          .map((event) => {
            return event.eventType;
          }),
      ).toStrictEqual([`run.${status}`]);
      expect(eventBackedContents(events, run.runId)).toStrictEqual([]);
      await api.requestClaimRunnerJob(true, run.runId, [404]);
    },
    90_000,
  );

  it("hands a Terra resource failure to Sandbox without replaying a later credential failure", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    if (!actor.orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    await api.heartbeatRunner(runnerGroup);
    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "hold the thread while the future Pi launch is queued",
      model: "claude-sonnet-5",
    });
    await flushWaitUntilForTest();
    const anchorState = await api.readRun(actor, anchor.runId);
    if (anchorState.status !== "pending") {
      throw new Error(
        `Expected pending anchor before claim: ${JSON.stringify(anchorState)}`,
      );
    }
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
    expect(anchorClaim.claim.cliAgentType).toBe("claude-code");

    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads(true);
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return HttpResponse.json(
          {
            error: { code: "invalid_api_key", message: "credential rejected" },
          },
          { status: 401 },
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const fallbackPrompt = "execute this fallback prompt exactly once";
    const fallback = await sendChatRun(actor, {
      agentId,
      prompt: fallbackPrompt,
      model: "gpt-5.6-terra",
    });
    await waitForRunStatus(actor, fallback.runId, "queued");

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const fallbackManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${fallback.runId}/manifest.json`;
    expect(checkpointObjects.get(fallbackManifestKey)).toBeInstanceOf(Buffer);
    expect(modelCalls).toBe(0);

    const fallbackManifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(
        checkpointObjects.get(fallbackManifestKey)?.toString("utf8") ?? "{}",
      ),
    );
    expect(fallbackManifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: fallback.threadId, sha256: null },
      session: {
        sessionId: fallback.threadId,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        rawSize: expect.any(Number),
      },
      sandboxEventSequenceStart: 1,
    });
    const fallbackSessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${fallback.runId}/session.jsonl`;
    const fallbackH0 =
      checkpointObjects.get(fallbackSessionKey)?.toString("utf8") ?? "";
    expect(Buffer.byteLength(fallbackH0)).toBe(
      fallbackManifest.session.rawSize,
    );
    expect(createHash("sha256").update(fallbackH0).digest("hex")).toBe(
      fallbackManifest.session.sha256,
    );
    const sandboxSession = MemoryPiSession.fromJsonl(fallbackH0);
    expect(sandboxSession.getSessionId()).toBe(fallback.threadId);
    expect(sandboxSession.buildSessionContext().messages).toHaveLength(0);

    const fallbackClaim = await claimChatRun(runnerGroup, fallback.runId);
    expect(fallbackClaim.claim).toMatchObject({
      cliAgentType: "pi",
      piSessionId: fallback.threadId,
      prompt: fallbackPrompt,
      piLaunchConfig: {
        apiFirstTurn: {
          sandboxEventSequenceStart: 1,
        },
      },
    });
    const postProviderPrompt =
      "fail a credential rejection after one provider request";
    const postProvider = await sendChatRun(actor, {
      agentId,
      prompt: postProviderPrompt,
      model: "gpt-5.6-terra",
    });
    await waitForRunStatus(actor, postProvider.runId, "queued");

    mockPiResourceArchiveDownloads();
    sandboxSession.appendMessage({
      role: "user",
      content: fallbackPrompt,
      timestamp: 1,
    });
    const fallbackAnswer = "Sandbox completed the fallback exactly once";
    sandboxSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: fallbackAnswer }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-terra",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const fallbackH2 = sandboxSession.toJsonl();
    expect(occurrences(fallbackH2, fallbackPrompt)).toBe(1);
    expect(
      MemoryPiSession.fromJsonl(fallbackH2).isSettledCheckpoint(),
    ).toBeTruthy();
    const fallbackH2Hash = createHash("sha256")
      .update(fallbackH2)
      .digest("hex");
    const preparedH2 = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: fallback.runId,
        hash: fallbackH2Hash,
        rawSize: Buffer.byteLength(fallbackH2),
        encodedSize: Buffer.byteLength(fallbackH2),
        encoding: "identity",
      },
      fallbackClaim.sandboxHeaders,
      [200],
    );
    expect(preparedH2.body).toMatchObject({
      existing: false,
      encoding: "identity",
    });
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${fallbackH2Hash}.blob`,
      Buffer.from(fallbackH2, "utf8"),
    );
    await webhooks.requestAgentEvents(
      {
        runId: fallback.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [{ type: "text", text: fallbackAnswer }],
            },
          },
          {
            type: "result",
            sequenceNumber: 2,
            result: fallbackAnswer,
          },
        ],
      },
      fallbackClaim.sandboxHeaders,
      [200],
    );
    const completedFallback = await webhooks.requestAgentComplete(
      {
        runId: fallback.runId,
        exitCode: 0,
        lastEventSequence: 2,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: fallback.threadId,
          cliAgentSessionHistoryHash: fallbackH2Hash,
        },
      },
      fallbackClaim.sandboxHeaders,
      [200],
    );
    expect(completedFallback.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await waitForRunStatus(actor, fallback.runId, "completed", 5000);
    await waitForRunStatus(actor, postProvider.runId, "failed", 5000);
    await flushWaitUntilForTest();

    expect(modelCalls).toBe(1);
    expect((await api.readRun(actor, postProvider.runId)).error).toContain(
      "[PI_API_MODEL_FAILED]",
    );
    const postProviderManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${postProvider.runId}/manifest.json`;
    expect(checkpointObjects.has(postProviderManifestKey)).toBeFalsy();
    const postProviderClaim = await api.requestClaimRunnerJob(
      true,
      postProvider.runId,
      [404],
    );
    expect(postProviderClaim.status).toBe(404);
    const finalThread = await waitForThreadMessages(
      actor,
      fallback.threadId,
      (messages) => {
        return eventBackedContents(messages, fallback.runId).some((message) => {
          return message.content === fallbackAnswer;
        });
      },
    );
    expect(
      eventBackedContents(finalThread.events, fallback.runId).filter(
        (message) => {
          return message.content === fallbackAnswer;
        },
      ),
    ).toHaveLength(1);
    await expect(
      readThreadSessionConversation(context, fallback.threadId),
    ).resolves.toMatchObject({ conversation_run_id: fallback.runId });
  }, 90_000);

  it("transfers compaction-required OpenRouter H0 before provider transport", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const usagePricingResolution = await createGptUsagePricingResolution();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 1,
    };
    await api.requestHeartbeatRunner(true, [200], {
      runnerId: runnerIdentity.runnerId,
      group: runnerGroup,
    });
    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "hold capacity for the compaction transfer",
      model: "claude-sonnet-5",
    });
    await flushWaitUntilForTest();
    const anchorState = await api.readRun(actor, anchor.runId);
    if (anchorState.status !== "pending") {
      throw new Error(
        `Expected pending compaction anchor: ${JSON.stringify(anchorState)}`,
      );
    }
    const anchorClaim = await api.claimRunnerJob(anchor.runId, {
      runnerIdentity,
    });
    const anchorSandboxHeaders = {
      authorization: `Bearer ${anchorClaim.sandboxToken}`,
    };
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");

    const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
      actor,
      "gpt-5.6-terra",
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.CodexFastMode]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    let modelCalls = 0;
    const modelRequests: unknown[] = [];
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/responses",
        async ({ request }) => {
          modelCalls += 1;
          modelRequests.push(await request.json());
          return new HttpResponse(
            piResponsesTextSse(
              "seed the compaction checkpoint",
              modelCalls,
              {
                input_tokens: 1_033_617,
                output_tokens: 0,
                total_tokens: 1_033_617,
              },
              "priority",
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const first = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          prompt: "create a settled Pi checkpoint",
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: "fast" },
        },
        usagePricingResolution,
      );
    });
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();
    expect(modelCalls).toBe(1);
    expect(
      z
        .object({ service_tier: z.literal("priority") })
        .passthrough()
        .parse(modelRequests[0]).service_tier,
    ).toBe("priority");
    await expect(readRunUsageEventsFixture(first.runId)).resolves.toStrictEqual(
      [
        expect.objectContaining({
          provider: "gpt-5.6-terra",
          category: "tokens.input.long_context.fast",
          quantity: 1_033_617,
          status: "processed",
          billingError: null,
          creditsCharged: expect.any(Number),
        }),
      ],
    );

    const blobPrefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/`;
    const persistedBlobs = [...checkpointObjects.entries()].filter(([key]) => {
      return key.startsWith(blobPrefix) && key.endsWith(".blob");
    });
    expect(persistedBlobs).toHaveLength(1);
    const persistedBlob = persistedBlobs[0];
    if (!persistedBlob) {
      throw new Error("Expected the first Pi run to persist native H1");
    }
    const [h0ObjectKey, firstSessionBytes] = persistedBlob;
    const h0Hash = h0ObjectKey.slice(blobPrefix.length, -".blob".length);
    const compactionH0 = firstSessionBytes.toString("utf8");

    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const prompt = "preserve this original prompt for official compaction";
    const second = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt,
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: "fast" },
        },
        usagePricingResolution,
      );
    });
    await waitForRunStatus(actor, second.runId, "queued");
    await completeChatRunOk(anchor.runId, anchorSandboxHeaders);

    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    expect(modelCalls).toBe(1);
    await expect(
      readRunUsageEventsFixture(second.runId),
    ).resolves.toStrictEqual([]);
    const manifestBytes = checkpointObjects.get(manifestKey);
    if (!manifestBytes) {
      throw new Error("Expected compaction ownership-transfer manifest");
    }
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: first.threadId, sha256: h0Hash },
      session: {
        sessionId: first.threadId,
        sha256: h0Hash,
        rawSize: Buffer.byteLength(compactionH0),
      },
      sandboxEventSequenceStart: 1,
    });
    const transferredH0Bytes = checkpointObjects.get(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/session.jsonl`,
    );
    if (!transferredH0Bytes) {
      throw new Error("Expected compaction ownership-transfer session");
    }
    const transferredH0 = transferredH0Bytes.toString("utf8");
    expect(transferredH0).toBe(compactionH0);
    const claim = await api.claimRunnerJob(second.runId, { runnerIdentity });
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };
    expect(claim).toMatchObject({
      cliAgentType: "pi",
      piSessionId: first.threadId,
      prompt,
      piModelConfig: {
        provider: "openrouter",
        serviceTier: "priority",
      },
    });
    expect(transferredH0).not.toContain("serviceTier");
    await cancelChatRun(actor, second.runId, sandboxHeaders);
  }, 90_000);

  it.each([
    {
      damage: "corrupt",
      prompt: "must not reach the model",
      code: "PI_H0_JSONL_INVALID",
    },
    {
      damage: "corrupt",
      prompt: "/skill:handoff-skill must not execute",
      code: "PI_H0_JSONL_INVALID",
    },
    {
      damage: "mismatched",
      prompt: "/skill:handoff-skill must not execute",
      code: "PI_H0_SESSION_MISMATCH",
    },
  ])(
    "fails $damage Pi H0 for $prompt before a second model call and preserves H0",
    async ({ damage, prompt, code }) => {
      const { actor, agentId } = await entitledChatActor();
      if (!actor.orgId) {
        throw new Error("Expected entitled chat actor to have an org");
      }
      await configureBuiltInPiModel(actor, "deepseek-v4-flash");
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: actor.orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      mockPiResourceArchiveDownloads();
      let modelCalls = 0;
      server.use(
        http.post("https://api.deepseek.com/responses", () => {
          modelCalls += 1;
          return new HttpResponse(
            piResponsesTextSse("canonical H0 answer", modelCalls),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "create canonical Pi H0",
        model: "deepseek-v4-flash",
      });
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(1);
      const bindingBeforeFailure = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      const firstSessionBytes = checkpointObjects.get(
        [...checkpointObjects.keys()].find((key) => {
          return key.includes("/blobs/");
        }) ?? "missing-canonical-pi-blob",
      );
      if (!firstSessionBytes) {
        throw new Error("Expected the first Pi run to persist native H1");
      }
      // A public caller cannot corrupt an authoritative checkpoint. Inject the
      // run-owned stored object to exercise the handoff's integrity boundary.
      const malformedH0 =
        damage === "corrupt"
          ? `${firstSessionBytes.toString("utf8")}{malformed\n`
          : firstSessionBytes
              .toString("utf8")
              .replace(first.threadId, randomUUID());
      const h0Hash = await replacePiSessionHistoryJsonlFixture({
        runId: first.runId,
        jsonl: malformedH0,
      });
      checkpointObjects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h0Hash}.blob`,
        Buffer.from(malformedH0, "utf8"),
      );

      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt,
      });
      await waitForRunStatus(actor, second.runId, "failed");
      await flushWaitUntilForTest();
      expect((await api.readRun(actor, second.runId)).error).toContain(
        `[${code}]`,
      );
      expect(modelCalls).toBe(1);
      await expect(
        readThreadSessionBinding(context, first.threadId),
      ).resolves.toStrictEqual({
        ...bindingBeforeFailure,
        agent_session_run_id: second.runId,
      });
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      const claim = await api.requestClaimRunnerJob(true, second.runId, [404]);
      expect(claim.status).toBe(404);
    },
    90_000,
  );

  it("rejects cyclic Pi H0 before provider or fallback and resumes valid history later", async () => {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
    const { actor, agentId } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    await configureBuiltInPiModel(actor, "deepseek-v4-flash");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads();
    let modelCalls = 0;
    server.use(
      http.post("https://api.deepseek.com/responses", () => {
        modelCalls += 1;
        return new HttpResponse(
          piResponsesTextSse("canonical H0 answer", modelCalls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "create canonical Pi H0",
      model: "deepseek-v4-flash",
    });
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();
    expect(modelCalls).toBe(1);
    const bindingBeforeFailure = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    const firstSessionBytes = checkpointObjects.get(
      [...checkpointObjects.keys()].find((key) => {
        return key.includes("/blobs/");
      }) ?? "missing-canonical-pi-blob",
    );
    if (!firstSessionBytes) {
      throw new Error("Expected the first Pi run to persist native H1");
    }
    const cyclicH0 = `${firstSessionBytes.toString("utf8")}${JSON.stringify({ type: "model_change", id: "cycle", parentId: "cycle", timestamp: "2026-09-05T00:00:00.000Z", provider: "openai", modelId: "gpt-5.6-terra" })}\n`;
    // A cyclic canonical H0 cannot be written through today's validated
    // checkpoint API; seed this historical corruption at the existing fixture.
    const h0Hash = await replacePiSessionHistoryJsonlFixture({
      runId: first.runId,
      jsonl: cyclicH0,
    });
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h0Hash}.blob`,
      Buffer.from(cyclicH0, "utf8"),
    );

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "must not reach the model",
    });
    await waitForRunStatus(actor, second.runId, "failed");
    await flushWaitUntilForTest();
    expect((await api.readRun(actor, second.runId)).error).toContain(
      "[PI_H0_JSONL_INVALID]",
    );
    expect(modelCalls).toBe(1);
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toStrictEqual({
      ...bindingBeforeFailure,
      agent_session_run_id: second.runId,
    });
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`,
      ),
    ).toBeFalsy();
    const claim = await api.requestClaimRunnerJob(true, second.runId, [404]);
    expect(claim.status).toBe(404);
    await replacePiSessionHistoryJsonlFixture({
      runId: first.runId,
      jsonl: firstSessionBytes.toString("utf8"),
    });
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "resume valid history",
    });
    await waitForRunStatus(actor, third.runId, "completed");
    await flushWaitUntilForTest();
    expect(modelCalls).toBe(2);
  }, 150_000);

  it.each(["deepseek-v4-flash", ...GPT_PI_BDD_MODELS] as const)(
    "keeps %s API-first and Sandbox usage as separate billable rows",
    async (selectedModel) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const isDeepSeek = selectedModel === "deepseek-v4-flash";
      const usagePricingResolution =
        await createPiApiFirstTurnUsagePricingResolution(selectedModel);
      await configureBuiltInPiModel(actor, selectedModel);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      server.use(
        http.post(
          isDeepSeek
            ? "https://api.deepseek.com/responses"
            : "https://api.openai.com/v1/responses",
          () => {
            modelCalls += 1;
            return new HttpResponse(
              piResponsesContentSse({
                blocks: [
                  {
                    type: "toolCall",
                    callId: "call_deepseek_sandbox",
                    name: "bash",
                    arguments: { command: "true" },
                  },
                ],
                sequence: modelCalls,
                usage: {
                  input_tokens: 10,
                  output_tokens: 3,
                  total_tokens: 13,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "hand a built-in DeepSeek tool response to Sandbox",
          model: selectedModel,
        },
        usagePricingResolution,
      );
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      await expect
        .poll(() => {
          return checkpointObjects.has(manifestKey);
        })
        .toBe(true);
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(1);

      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.piModelConfig).toMatchObject({
        provider: isDeepSeek ? "deepseek" : "openai",
        model: selectedModel,
      });
      expect(claimed.claim.piModelConfig).not.toHaveProperty("api");
      expect(claimed.claim.piModelConfig).not.toHaveProperty("serviceTier");
      const sandboxUsageEvent = {
        idempotencyKey: randomUUID(),
        kind: "model" as const,
        provider: selectedModel,
        category: "tokens.output",
        quantity: 2,
      };
      const sandboxUsageReceipts = await Promise.all([
        webhooks.requestAgentUsageEvent(
          { runId: run.runId, events: [sandboxUsageEvent] },
          claimed.sandboxHeaders,
          [200],
          usagePricingResolution,
        ),
        webhooks.requestAgentUsageEvent(
          { runId: run.runId, events: [sandboxUsageEvent] },
          claimed.sandboxHeaders,
          [200],
          usagePricingResolution,
        ),
      ]);
      expect(
        sandboxUsageReceipts.map((receipt) => {
          return receipt.body;
        }),
      ).toStrictEqual([{ success: true }, { success: true }]);
      await api.requestCancelRun(
        actor,
        run.runId,
        [200],
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, "cancelled");
      await failChatRun(run.runId, claimed.sandboxHeaders, "Run cancelled");
      await flushWaitUntilForTest();
      const combinedUsage = await readRunUsageEventsFixture(run.runId);
      expect(
        combinedUsage.filter((row) => {
          return row.category === "tokens.output" && row.quantity === 3;
        }),
      ).toHaveLength(1);
      expect(
        combinedUsage.filter((row) => {
          return row.category === "tokens.output" && row.quantity === 2;
        }),
      ).toHaveLength(1);
      expect(combinedUsage).toHaveLength(5);
      expect(
        combinedUsage.every((row) => {
          return (
            row.provider === selectedModel &&
            row.status === "processed" &&
            row.billingError === null &&
            !row.category.includes(".fast") &&
            !row.category.includes(".long_context")
          );
        }),
      ).toBeTruthy();
      expect(totalChargedCredits(combinedUsage)).toBeGreaterThan(0);
    },
    90_000,
  );

  async function piActivityScenario(enabled: boolean): Promise<void> {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const usagePricingResolution = await createGptUsagePricingResolution();
    const withOpenRouterRoute = await configureBuiltInPiModelOnOpenRouter(
      actor,
      "gpt-5.6-terra",
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.ThreadActivitySummary]: enabled,
        [FeatureSwitchKey.CodexFastMode]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const okouCliCommand = `npx --yes --package="\${CLI_PKG_URL}" okou --help`;
    const adHocNoteFilename = "2026-09-05T16-15-00-api-first-checkpoint.md";
    const adHocNote =
      "# API-first checkpoint\n\nPersist this staged sandbox note.\n";
    let modelCalls = 0;
    const terraModelRequests: unknown[] = [];
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/responses",
        async ({ request }) => {
          modelCalls += 1;
          terraModelRequests.push(await request.json());
          return new HttpResponse(
            modelCalls === 1
              ? piResponsesContentSse({
                  blocks: [
                    { type: "text", text: "before parallel tools" },
                    {
                      type: "toolCall",
                      callId: "call_pi_read",
                      name: "bash",
                      arguments: {
                        command: okouCliCommand,
                      },
                    },
                    {
                      type: "toolCall",
                      callId: "call_pi_write",
                      name: "add_ad_hoc_note",
                      arguments: {
                        filename: adHocNoteFilename,
                        note: adHocNote,
                      },
                    },
                    { type: "text", text: "after parallel tools" },
                  ],
                  sequence: modelCalls,
                  includeReasoning: true,
                  observedServiceTier: "priority",
                })
              : piResponsesToolSse({
                  callId: "call_pi_read",
                  name: "bash",
                  arguments: {
                    command: okouCliCommand,
                  },
                  sequence: modelCalls,
                  observedServiceTier: "priority",
                }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const prompt = "use the Okou CLI through the Sandbox handoff";
    const run = await withOpenRouterRoute(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          prompt,
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: "fast" },
        },
        usagePricingResolution,
      );
    });
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(manifestKey);
      })
      .toBe(true);
    expect(modelCalls).toBe(1);
    const terraTools = z
      .object({
        tools: z.array(z.object({ name: z.string() }).passthrough()),
        service_tier: z.literal("priority"),
      })
      .passthrough()
      .parse(terraModelRequests[0])
      .tools.map((tool) => {
        return tool.name;
      });
    expect(terraTools).toStrictEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "add_ad_hoc_note",
      ]),
    );
    const manifestBytes = checkpointObjects.get(manifestKey);
    if (!manifestBytes) {
      throw new Error("Expected pending-tool ownership-transfer manifest");
    }
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "pending-tool-continuation",
      baseSession: { sessionId: run.threadId, sha256: null },
      session: {
        sessionId: run.threadId,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        rawSize: expect.any(Number),
      },
      sandboxEventSequenceStart: 4,
    });
    const projected = await waitForThreadMessages(
      actor,
      run.threadId,
      (messages) => {
        return eventBackedContents(messages, run.runId).length === 2;
      },
    );
    expect(
      eventBackedContents(projected.events, run.runId).map((message) => {
        return {
          content: message.content,
          sequenceNumber: message.sequenceNumber,
        };
      }),
    ).toStrictEqual([
      { content: "before parallel tools", sequenceNumber: 0 },
      { content: "after parallel tools", sequenceNumber: 3 },
    ]);
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.piSessionId).toBe(run.threadId);
    expect(claimed.claim.piModelConfig).toMatchObject({
      provider: "openrouter",
      serviceTier: "priority",
    });
    expect(claimed.claim.piModelConfig).not.toHaveProperty("api");
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
      apiFirstTurn: {
        schemaVersion: 1,
        baseSession: { sessionId: run.threadId, sha256: null },
        sandboxEventSequenceStart: 1,
      },
    });
    const terraEnvironment = claimEnvironment(claimed.claim);
    expect(terraEnvironment.OKOU_TOKEN).toBeTruthy();
    expect(terraEnvironment.CLI_PKG_URL).toBeTruthy();
    const terraInstructions = claimed.claim.appendSystemPrompt;
    if (!terraInstructions) {
      throw new Error("Expected Terra Web instructions");
    }
    expect(terraInstructions).toContain(
      "You are currently running inside: Web",
    );
    expect(terraInstructions).toContain("okou web download-file -h");
    expect(terraInstructions).not.toMatch(/auto.?memory/iu);
    const terraStorageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!terraStorageManifest) {
      throw new Error("Expected Terra storage manifest");
    }
    const terraMounts = terraStorageManifest.storageMounts;
    const terraMemoryMount = terraMounts.find((mount) => {
      return mount.name === "memory" && mount.mountPath === PI_MEMORY_ROOT;
    });
    if (!terraMemoryMount) {
      throw new Error("Expected the Pi memory mount");
    }
    expect(claimed.claim.prompt).toBe(prompt);
    const sandboxUsageEvent = {
      idempotencyKey: randomUUID(),
      kind: "model" as const,
      provider: "gpt-5.6-terra",
      category: "tokens.output.fast",
      quantity: 2,
    };
    const sandboxUsageReceipts = await Promise.all([
      webhooks.requestAgentUsageEvent(
        { runId: run.runId, events: [sandboxUsageEvent] },
        claimed.sandboxHeaders,
        [200],
        usagePricingResolution,
      ),
      webhooks.requestAgentUsageEvent(
        { runId: run.runId, events: [sandboxUsageEvent] },
        claimed.sandboxHeaders,
        [200],
        usagePricingResolution,
      ),
    ]);
    expect(
      sandboxUsageReceipts.map((receipt) => {
        return receipt.body;
      }),
    ).toStrictEqual([{ success: true }, { success: true }]);
    const h1Bytes = checkpointObjects.get(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
    );
    if (!h1Bytes) {
      throw new Error("Expected pending-tool ownership-transfer session");
    }
    const h1 = h1Bytes.toString("utf8");
    expect(h1).toContain('"type":"thinking_level_change"');
    expect(h1).toContain('"thinkingLevel":"max"');
    expect(h1).not.toContain("serviceTier");
    const h2Session = MemoryPiSession.fromJsonl(h1);
    const h1Assistant = [...h2Session.buildSessionContext().messages]
      .reverse()
      .find((message) => {
        return message.role === "assistant";
      });
    const h1Thinking =
      h1Assistant?.role === "assistant"
        ? h1Assistant.content.find((content) => {
            return content.type === "thinking";
          })
        : undefined;
    expect(h1Thinking?.type).toBe("thinking");
    expect(
      h1Thinking?.type === "thinking"
        ? JSON.parse(h1Thinking.thinkingSignature ?? "{}")
        : {},
    ).toMatchObject({
      type: "reasoning",
      content: [
        {
          type: "reasoning_text",
          text: "API-first reasoning preserved for Sandbox resume",
        },
      ],
    });
    expect(
      h1Assistant?.role === "assistant"
        ? h1Assistant.content
            .filter((content) => {
              return content.type !== "thinking";
            })
            .map((content) => {
              return content.type === "text"
                ? { type: content.type, text: content.text }
                : {
                    type: content.type,
                    id: content.id,
                    name: content.name,
                  };
            })
        : [],
    ).toStrictEqual([
      { type: "text", text: "before parallel tools" },
      {
        type: "toolCall",
        id: "call_pi_read|fc_pi_content_1_1",
        name: "bash",
      },
      {
        type: "toolCall",
        id: "call_pi_write|fc_pi_content_1_2",
        name: "add_ad_hoc_note",
      },
      { type: "text", text: "after parallel tools" },
    ]);
    await expectPiActivitySummaryBeforeGuestReplay(actor, run, enabled);

    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [{ type: "text", text: "before parallel tools" }],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 1,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "call_pi_read|fc_pi_content_1_1",
                  name: "bash",
                  input: {
                    command: okouCliCommand,
                  },
                },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 2,
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "call_pi_write|fc_pi_content_1_2",
                  name: "add_ad_hoc_note",
                  input: {
                    filename: adHocNoteFilename,
                    note: adHocNote,
                  },
                },
              ],
            },
          },
          {
            type: "assistant",
            sequenceNumber: 3,
            message: {
              content: [{ type: "text", text: "after parallel tools" }],
            },
          },
        ],
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ).map((message) => {
        return {
          content: message.content,
          sequenceNumber: message.sequenceNumber,
        };
      }),
    ).toStrictEqual([
      { content: "before parallel tools", sequenceNumber: 0 },
      { content: "after parallel tools", sequenceNumber: 3 },
    ]);
    h2Session.appendMessage({
      role: "toolResult",
      toolCallId: "call_pi_read|fc_pi_content_1_1",
      toolName: "bash",
      content: [{ type: "text", text: "Okou CLI help output" }],
      details: {},
      isError: false,
      timestamp: 2,
    });
    h2Session.appendMessage({
      role: "toolResult",
      toolCallId: "call_pi_write|fc_pi_content_1_2",
      toolName: "add_ad_hoc_note",
      content: [
        {
          type: "text",
          text: `{"status":"staged","path":"extensions/ad_hoc/notes/${adHocNoteFilename}"}`,
        },
      ],
      details: {},
      isError: false,
      timestamp: 3,
    });
    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Sandbox H2 complete" }],
      api: "openai-responses",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    const h2 = h2Session.toJsonl();
    const h2Hash = createHash("sha256").update(h2).digest("hex");
    const preparedH2 = await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: h2Hash,
        rawSize: Buffer.byteLength(h2),
        encodedSize: Buffer.byteLength(h2),
        encoding: "identity",
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(preparedH2.body).toMatchObject({
      existing: false,
      encoding: "identity",
    });
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
      Buffer.from(h2, "utf8"),
    );
    const checkpointedMemory = await commitMemoryVersion(context, actor, [
      {
        path: `extensions/ad_hoc/notes/${adHocNoteFilename}`,
        content: adHocNote,
      },
    ]);
    expect(checkpointedMemory.storageId).toBe(terraMemoryMount.storageId);
    const memoryArtifactSnapshots = [
      {
        name: terraMemoryMount.name,
        version: checkpointedMemory.versionId,
        mountPath: terraMemoryMount.mountPath,
        ...(terraMemoryMount.missingRootPolicy === undefined
          ? {}
          : {
              missingRootPolicy: terraMemoryMount.missingRootPolicy,
            }),
      },
    ];
    const combinedH2 = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
          artifactSnapshots: memoryArtifactSnapshots,
        },
      },
      claimed.sandboxHeaders,
      [200],
      undefined,
      usagePricingResolution,
    );
    expect(combinedH2.body).toStrictEqual({
      success: true,
      status: "completed",
    });
    await waitForRunStatus(actor, run.runId, "completed");
    await flushWaitUntilForTest();
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      result: {
        artifact: { memory: checkpointedMemory.versionId },
      },
    });
    const combinedUsage = await readRunUsageEventsFixture(run.runId);
    expect(
      combinedUsage.filter((row) => {
        return row.category === "tokens.input.fast" && row.quantity === 5;
      }),
    ).toHaveLength(1);
    expect(
      combinedUsage.filter((row) => {
        return row.category === "tokens.output.fast" && row.quantity === 3;
      }),
    ).toHaveLength(1);
    expect(
      combinedUsage.filter((row) => {
        return row.category === "tokens.output.fast" && row.quantity === 2;
      }),
    ).toHaveLength(1);
    expect(combinedUsage).toHaveLength(3);
    expect(
      combinedUsage.every((row) => {
        return (
          row.provider === "gpt-5.6-terra" &&
          row.status === "processed" &&
          row.billingError === null &&
          row.category.endsWith(".fast")
        );
      }),
    ).toBeTruthy();
    const committedH2 = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
        artifactSnapshots: memoryArtifactSnapshots,
      },
      claimed.sandboxHeaders,
      [200],
    );
    const committedH2Body = committedH2.body;
    if ("error" in committedH2Body) {
      throw new Error(
        `Expected H2 checkpoint success: ${committedH2Body.error.message}`,
      );
    }
    expect(modelCalls).toBe(1);
    expect(checkpointObjects.has(manifestKey)).toBeFalsy();
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
      ),
    ).toBeFalsy();
    const canonicalConversation = await readThreadSessionConversation(
      context,
      run.threadId,
    );
    expect(canonicalConversation).toMatchObject({
      conversation_run_id: run.runId,
    });
    const sandboxConversation = await readPiConversationIdentityFixture(
      run.runId,
    );
    await expect(
      readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      }),
    ).resolves.toMatchObject({
      piSessionId: sandboxConversation.piSessionId,
      sourceRunId: run.runId,
      sourceHistoryHash: sandboxConversation.sourceHistoryHash,
      status: "pending",
    });

    const idempotentH2 = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
        artifactSnapshots: memoryArtifactSnapshots,
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(idempotentH2.body).toMatchObject({
      checkpointId: committedH2Body.checkpointId,
      conversationId: committedH2Body.conversationId,
    });

    h2Session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "late replacement H2" }],
      api: "openai-responses",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    const replacementH2 = h2Session.toJsonl();
    expect(
      MemoryPiSession.fromJsonl(replacementH2).isSettledCheckpoint(),
    ).toBeTruthy();
    const replacementH2Hash = createHash("sha256")
      .update(replacementH2)
      .digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: run.runId,
        hash: replacementH2Hash,
        rawSize: Buffer.byteLength(replacementH2),
        encodedSize: Buffer.byteLength(replacementH2),
        encoding: "identity",
      },
      claimed.sandboxHeaders,
      [200],
    );
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${replacementH2Hash}.blob`,
      Buffer.from(replacementH2, "utf8"),
    );
    const replacementCheckpoint = await webhooks.requestAgentCheckpoint(
      {
        runId: run.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: replacementH2Hash,
      },
      claimed.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(replacementCheckpoint.body)).toContain(
      "[PI_H2_ALREADY_COMMITTED]",
    );
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(1);

    const failedHandoff = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "reject a non-native Sandbox H2",
      });
    });
    const failedManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${failedHandoff.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(failedManifestKey);
      })
      .toBe(true);
    const failedClaim = await claimChatRun(runnerGroup, failedHandoff.runId);
    const cyclicH2 = Buffer.from(
      `${h2}${JSON.stringify({ type: "model_change", id: "cycle", parentId: "cycle", timestamp: "2026-09-05T00:00:00.000Z", provider: "openai", modelId: "gpt-5.6-terra" })}\n`,
      "utf8",
    );
    const cyclicH2Hash = createHash("sha256").update(cyclicH2).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: failedHandoff.runId,
        hash: cyclicH2Hash,
        rawSize: cyclicH2.length,
        encodedSize: cyclicH2.length,
        encoding: "identity",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${cyclicH2Hash}.blob`,
      cyclicH2,
    );
    const cyclicCheckpoint = await webhooks.requestAgentComplete(
      {
        runId: failedHandoff.runId,
        exitCode: 1,
        error: "reject cyclic native checkpoint",
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: cyclicH2Hash,
        },
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(cyclicCheckpoint.body)).toContain(
      "[PI_H2_JSONL_INVALID]",
    );
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(2);
    const invalidH2 = Buffer.from(`${h2}{malformed\n`, "utf8");
    const invalidH2Hash = createHash("sha256").update(invalidH2).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: failedHandoff.runId,
        hash: invalidH2Hash,
        rawSize: invalidH2.length,
        encodedSize: invalidH2.length,
        encoding: "identity",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    checkpointObjects.set(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${invalidH2Hash}.blob`,
      invalidH2,
    );
    const invalidCheckpoint = await webhooks.requestAgentComplete(
      {
        runId: failedHandoff.runId,
        exitCode: 1,
        error: "reject invalid native checkpoint",
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: invalidH2Hash,
        },
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(invalidCheckpoint.body)).toContain(
      "[PI_H2_JSONL_INVALID]",
    );
    await webhooks.requestAgentComplete(
      {
        runId: failedHandoff.runId,
        exitCode: 1,
        error: "[PI_H2_JSONL_INVALID] rejected native checkpoint",
      },
      failedClaim.sandboxHeaders,
      [200],
    );
    await waitForRunStatus(actor, failedHandoff.runId, "failed");
    await flushWaitUntilForTest();
    expect(modelCalls).toBe(2);
    expect(checkpointObjects.has(failedManifestKey)).toBeFalsy();
    const lateFailedH2 = await webhooks.requestAgentComplete(
      {
        runId: failedHandoff.runId,
        exitCode: 1,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
        },
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(lateFailedH2.body)).toContain("[PI_H2_RUN_TERMINAL]");
    const spoofedFailedH2 = await webhooks.requestAgentCheckpoint(
      {
        runId: failedHandoff.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
      failedClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(spoofedFailedH2.body)).toContain(
      "[PI_H2_TYPE_MISMATCH]",
    );
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(2);

    if (!canonicalConversation.agent_session_id) {
      throw new Error("Expected the completed Pi run to own an AgentSession");
    }
    const explicitResume = await api.createRun(actor, {
      agentId,
      sessionId: canonicalConversation.agent_session_id,
      prompt: "keep an incompatible direct run off the Pi checkpoint",
    });
    const explicitResumeClaim = await api.claimRunnerJob(explicitResume.runId);
    expect(explicitResumeClaim.cliAgentType).toBe("claude-code");
    expect(explicitResumeClaim.resumeSession).toBeNull();
    expect(modelCalls).toBe(2);
    await api.requestCancelRun(actor, explicitResume.runId, [200]);
    await waitForRunStatus(actor, explicitResume.runId, "cancelled");

    const cancelledHandoff = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "reject H2 after an explicit Pi handoff is cancelled",
      });
    });
    const cancelledManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${cancelledHandoff.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(cancelledManifestKey);
      })
      .toBe(true);
    const cancelledClaim = await claimChatRun(
      runnerGroup,
      cancelledHandoff.runId,
    );
    await cancelChatRun(
      actor,
      cancelledHandoff.runId,
      cancelledClaim.sandboxHeaders,
    );
    const lateCancelledH2 = await webhooks.requestAgentComplete(
      {
        runId: cancelledHandoff.runId,
        exitCode: 1,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
        },
      },
      cancelledClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(lateCancelledH2.body)).toContain(
      "[PI_H2_RUN_TERMINAL]",
    );
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(3);

    const racedHandoff = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "reject standalone H2 during an early successful completion",
      });
    });
    const racedManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${racedHandoff.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(racedManifestKey);
      })
      .toBe(true);
    const racedClaim = await claimChatRun(runnerGroup, racedHandoff.runId);
    const lifecycleGate = await holdAgentRunRowLockFixture({
      runId: racedHandoff.runId,
      signal: context.signal,
    });
    const ownedRequests: Promise<unknown>[] = [];
    onTestFinished(async () => {
      lifecycleGate.release();
      await Promise.all(ownedRequests);
      await lifecycleGate.done;
    });
    const racedCompletion = webhooks.requestAgentComplete(
      { runId: racedHandoff.runId, exitCode: 0 },
      racedClaim.sandboxHeaders,
      [200],
    );
    ownedRequests.push(Promise.allSettled([racedCompletion]));
    await expect.poll(lifecycleGate.waiterCount).toBe(1);
    const racedCheckpoint = webhooks.requestAgentCheckpoint(
      {
        runId: racedHandoff.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
      racedClaim.sandboxHeaders,
      [400],
    );
    ownedRequests.push(Promise.allSettled([racedCheckpoint]));
    const racedCheckpointResult = await racedCheckpoint;
    expect(JSON.stringify(racedCheckpointResult.body)).toContain(
      "[CHECKPOINT_RUN_NOT_SETTLED]",
    );
    lifecycleGate.release();
    const [, racedCompletionResult] = await Promise.all([
      lifecycleGate.done,
      racedCompletion,
    ] as const);
    expect(racedCompletionResult).toMatchObject({
      body: { success: true, status: "failed" },
    });
    await waitForRunStatus(actor, racedHandoff.runId, "failed");
    await flushWaitUntilForTest();
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(4);

    const retry = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "resume only the last completed Pi checkpoint",
      });
    });
    const retryManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${retry.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(retryManifestKey);
      })
      .toBe(true);
    const retryManifest = JSON.parse(
      checkpointObjects.get(retryManifestKey)?.toString("utf8") ?? "{}",
    ) as {
      readonly baseSession?: {
        readonly sessionId?: unknown;
        readonly sha256?: unknown;
      };
    };
    expect(retryManifest.baseSession).toStrictEqual({
      sessionId: run.threadId,
      sha256: h2Hash,
    });
    expect(modelCalls).toBe(5);
    const timedOutClaim = await claimChatRun(runnerGroup, retry.runId);
    await timeoutRunWithoutCallbacksFixture({ runId: retry.runId });
    await waitForRunStatus(actor, retry.runId, "timeout");
    const lateTimedOutH2 = await webhooks.requestAgentCheckpoint(
      {
        runId: retry.runId,
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
      timedOutClaim.sandboxHeaders,
      [400],
    );
    expect(JSON.stringify(lateTimedOutH2.body)).toContain(
      "[PI_H2_RUN_TERMINAL]",
    );
    const timedOutCompletion = await webhooks.requestAgentComplete(
      { runId: retry.runId, exitCode: 0 },
      timedOutClaim.sandboxHeaders,
      [200],
    );
    expect(timedOutCompletion.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    await waitForRunStatus(actor, retry.runId, "timeout");
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(5);

    const reportedFailureHandoff = await withOpenRouterRoute(async () => {
      return await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "retry one atomically reported Pi failure",
      });
    });
    const reportedFailureManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${reportedFailureHandoff.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(reportedFailureManifestKey);
      })
      .toBe(true);
    const reportedFailureClaim = await claimChatRun(
      runnerGroup,
      reportedFailureHandoff.runId,
    );
    const reportedFailureBody = {
      runId: reportedFailureHandoff.runId,
      exitCode: 1,
      error: "guest reported Pi failure",
      checkpoint: {
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: h2Hash,
      },
    } as const;
    const reportedFailure = await webhooks.requestAgentComplete(
      reportedFailureBody,
      reportedFailureClaim.sandboxHeaders,
      [200],
    );
    expect(reportedFailure.body).toStrictEqual({
      success: true,
      status: "failed",
    });
    await waitForRunStatus(actor, reportedFailureHandoff.runId, "failed");
    await flushWaitUntilForTest();
    const repeatedReportedFailure = await webhooks.requestAgentComplete(
      reportedFailureBody,
      reportedFailureClaim.sandboxHeaders,
      [200],
    );
    expect(repeatedReportedFailure.body).toStrictEqual(reportedFailure.body);
    await expect(
      readThreadSessionConversation(context, run.threadId),
    ).resolves.toStrictEqual(canonicalConversation);
    expect(modelCalls).toBe(6);

    const conversationClear = await holdThreadSessionConversationClearFixture({
      threadId: run.threadId,
      signal: context.signal,
    });
    conversationClear.release();
    await conversationClear.done;
    const repeatedCombinedH2 = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryHash: h2Hash,
          artifactSnapshots: memoryArtifactSnapshots,
        },
      },
      claimed.sandboxHeaders,
      [200],
    );
    expect(repeatedCombinedH2.body).toStrictEqual(combinedH2.body);
  }

  it.each([false, true])(
    "publishes OpenRouter Responses blocks, hands tools to H2, and checkpoints Pi memory notes (activity: %s)",
    piActivityScenario,
    150_000,
  );

  it("routes DeepSeek V4 Flash through the native Responses adapter", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "deepseek",
      secret: "selected-deepseek-responses-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with DeepSeek Responses",
      model: "deepseek-v4-flash",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);

    expect(claim.cliAgentType).toBe("codex");
    expect(environment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(environment.OPENAI_BASE_URL).toBe("https://api.deepseek.com/");
    expect(environment.OPENAI_MODEL).toBe("deepseek-v4-flash");
    expect(environment.ANTHROPIC_MODEL).toBeUndefined();
    expect(claim.codexRuntimeConfig).toMatchObject({
      providerId: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/",
      envKey: "OPENAI_API_KEY",
      requiresOpenaiAuth: false,
      wireApi: "responses",
      supportsWebsockets: false,
      modelCatalog: {
        models: expect.arrayContaining([
          expect.objectContaining({
            slug: "deepseek-v4-flash",
            default_reasoning_level: "high",
          }),
          expect.objectContaining({
            slug: "deepseek-v4-pro",
            default_reasoning_level: "high",
          }),
        ]),
      },
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(run.runId, sandboxHeaders, {
      cliAgentType: "codex",
    });

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "continue with DeepSeek Responses",
    });
    const { claim: followUpClaim } = await claimChatRun(
      runnerGroup,
      followUp.runId,
    );
    const followUpEnvironment = claimEnvironment(followUpClaim);
    expect(followUpClaim.cliAgentType).toBe("codex");
    expect(followUpClaim.resumeSession?.sessionId).toBe(`bdd-cli-${run.runId}`);
    expect(followUpClaim.codexRuntimeConfig?.providerId).toBe("deepseek");
    expect(followUpEnvironment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("deepseek", "DEEPSEEK_API_KEY"),
    );
    expect(followUpEnvironment.OPENAI_BASE_URL).toBe(
      "https://api.deepseek.com/",
    );
    expect(followUpEnvironment.OPENAI_MODEL).toBe("deepseek-v4-flash");

    await cancelChatRun(actor, followUp.runId);
  });

  it.each([
    {
      name: "DeepSeek",
      model: "deepseek-v4-flash",
      providerType: "deepseek",
    },
  ] as const)(
    "keeps direct $name BYOK on Codex while PiLoop is disabled",
    async ({ model, providerType }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const orgId = requireOrgId(actor);
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        { [FeatureSwitchKey.PiLoop]: false },
      );
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: providerType,
        secret: `selected-${model}-pi-disabled-key`,
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: providerType,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);

      const run = await sendChatRun(actor, {
        agentId,
        prompt: `keep direct ${model} on the standard runtime`,
        model,
      });
      await flushWaitUntilForTest();
      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.cliAgentType).toBe("codex");
      expect(claimed.claim.piLaunchConfig).toBeUndefined();
      await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    },
    30_000,
  );

  it.each(
    GPT_API_KEY_BDD_ROUTES.flatMap((route) => {
      return [
        { ...route, tier: undefined, generation: 2, outcome: "completed" },
        { ...route, tier: "fast", generation: 3, outcome: "completed" },
        { ...route, tier: "fast", generation: 3, outcome: "failed" },
        { ...route, tier: "fast", generation: 3, outcome: "cancelled" },
      ] as const;
    }),
  )(
    "runs $name API-key $tier through API-first and generation-$generation Sandbox with $outcome and credential rotation",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const firewall = createFirewallApi(context);
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const initialSecret = `${route.type}-initial-secret`;
      const providerId = await configureApiKeyGptPiModel(
        actor,
        route,
        initialSecret,
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const providerRequests: {
        readonly authorization: string | null;
        readonly body: unknown;
      }[] = [];
      server.use(
        http.post(route.endpoint, async ({ request }) => {
          const sequence = providerRequests.length;
          providerRequests.push({
            authorization: request.headers.get("authorization"),
            body: await request.json(),
          });
          const responseBody = piResponsesContentSse({
            blocks:
              sequence === 0
                ? [
                    {
                      type: "toolCall",
                      callId: `call_${route.type.replaceAll("-", "_")}`,
                      name: "bash",
                      arguments: { command: "okou --help" },
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: `${route.name} API answer ${sequence}`,
                    },
                  ],
            sequence,
          });
          return new HttpResponse(responseBody, {
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );

      const firstPrompt = `use ${route.name} Terra and hand off one tool`;
      const first = await sendChatRun(actor, {
        agentId,
        prompt: firstPrompt,
        model: route.selectedModel,
        runOptions: { codexServiceTier: route.tier },
      });
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${first.runId}/manifest.json`;
      const sessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${first.runId}/session.jsonl`;
      await expect
        .poll(() => {
          return checkpointObjects.has(manifestKey);
        })
        .toBe(true);
      await flushWaitUntilForTest();
      expect(providerRequests).toStrictEqual([
        {
          authorization: `Bearer ${initialSecret}`,
          body: expect.objectContaining({
            model: route.runtimeModel,
            store: false,
            stream: true,
          }),
        },
      ]);
      expect(providerRequests[0]?.body).not.toHaveProperty(
        "previous_response_id",
      );
      await expectNoBuiltInModelUsage(first.runId);

      await api.heartbeatRunner(runnerGroup);
      const claim = await claimGptPiSandbox(actor, first.runId, route.tier);
      const sandboxHeaders = {
        authorization: `Bearer ${claim.sandboxToken}`,
      };
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piSessionId).toBe(first.threadId);
      expectApiKeyGptSandboxCarrier(claim, route, route.tier);
      expect(JSON.stringify(claim)).not.toContain(initialSecret);
      if (!claim.encryptedSecrets) {
        throw new Error("Expected API-key Terra claim credentials");
      }
      const sandboxCredential = await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate(route.secretName)}`,
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (sandboxCredential.status !== 200) {
        throw new Error("Expected exact API-key Terra firewall credential");
      }
      expect(sandboxCredential.body.headers.Authorization).toBe(
        `Bearer ${initialSecret}`,
      );
      expect(sandboxCredential.body.resolvedSecrets).toStrictEqual([
        route.secretName,
      ]);

      const manifestBytes = checkpointObjects.get(manifestKey);
      const h1Bytes = checkpointObjects.get(sessionKey);
      if (!manifestBytes || !h1Bytes) {
        throw new Error("Expected API-key Terra ownership-transfer artifacts");
      }
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(manifestBytes.toString("utf8")),
      );
      const h2Session = MemoryPiSession.fromJsonl(h1Bytes.toString("utf8"));
      const pendingAssistant = [...h2Session.buildSessionContext().messages]
        .reverse()
        .find((message) => {
          return message.role === "assistant";
        });
      const pendingTool =
        pendingAssistant?.role === "assistant"
          ? pendingAssistant.content.find((content) => {
              return content.type === "toolCall";
            })
          : undefined;
      if (!pendingTool || pendingTool.type !== "toolCall") {
        throw new Error("Expected API-key Terra tool call in H1");
      }
      const sandboxToolResult = `${route.name} sandbox tool output`;
      const sandboxAnswer = `${route.name} Sandbox completion`;
      h2Session.appendMessage({
        role: "toolResult",
        toolCallId: pendingTool.id,
        toolName: pendingTool.name,
        content: [{ type: "text", text: sandboxToolResult }],
        details: {},
        isError: false,
        timestamp: 2,
      });
      h2Session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: sandboxAnswer }],
        api: "openai-responses",
        provider: route.piProvider,
        model: route.runtimeModel,
        usage: {
          input: 5,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 8,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 3,
      });
      expect(h1Bytes.toString("utf8")).not.toMatch(/serviceTier|service_tier/);
      expect(h1Bytes.toString("utf8")).not.toContain(initialSecret);
      const h2 = h2Session.toJsonl();
      expect(h2).not.toMatch(/serviceTier|service_tier/);
      const h2Hash = createHash("sha256").update(h2).digest("hex");
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: first.runId,
          hash: h2Hash,
          rawSize: Buffer.byteLength(h2),
          encodedSize: Buffer.byteLength(h2),
          encoding: "identity",
        },
        sandboxHeaders,
        [200],
      );
      checkpointObjects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
        Buffer.from(h2, "utf8"),
      );
      const sandboxEventSequenceStart = manifest.sandboxEventSequenceStart;
      await webhooks.requestAgentEvents(
        {
          runId: first.runId,
          events: [
            {
              type: "assistant",
              sequenceNumber: sandboxEventSequenceStart,
              message: {
                content: [{ type: "text", text: sandboxAnswer }],
              },
            },
            {
              type: "result",
              sequenceNumber: sandboxEventSequenceStart + 1,
              result: sandboxAnswer,
            },
          ],
        },
        sandboxHeaders,
        [200],
      );
      if (route.outcome === "cancelled") {
        await cancelChatRun(actor, first.runId);
      }
      await webhooks.requestAgentComplete(
        {
          runId: first.runId,
          exitCode: route.outcome === "failed" ? 1 : 0,
          ...(route.outcome === "failed"
            ? { error: "API-key Sandbox failed" }
            : {}),
          lastEventSequence: sandboxEventSequenceStart + 1,
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: first.threadId,
            cliAgentSessionHistoryHash: h2Hash,
          },
        },
        sandboxHeaders,
        route.outcome === "cancelled" ? [400] : [200],
      );
      await waitForRunStatus(actor, first.runId, route.outcome);
      await flushWaitUntilForTest();
      await webhooks.requestAgentComplete(
        { runId: first.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(1);
      expectApiKeyGptRequest(
        providerRequests[0],
        route,
        initialSecret,
        route.tier,
      );
      await expectNoBuiltInModelUsage(first.runId);
      const terminal = await api.readRun(actor, first.runId);
      expect(terminal).toMatchObject({ status: route.outcome });
      expect(
        JSON.stringify({
          terminal,
          events: (await chat.listThreadEvents(actor, first.threadId)).events,
          h2,
        }),
      ).not.toContain(initialSecret);
      if (route.outcome !== "completed") {
        return;
      }
      const firstSession = await readThreadSessionConversation(
        context,
        first.threadId,
      );

      const followUpPrompt = `continue the same ${route.name} credential`;
      const followUp = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: followUpPrompt,
        model: route.selectedModel,
        runOptions: { codexServiceTier: route.tier },
      });
      await waitForRunStatus(actor, followUp.runId, "completed");
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(2);
      expectApiKeyGptRequest(
        providerRequests[1],
        route,
        initialSecret,
        route.tier,
      );
      expect(providerRequests[1]).toMatchObject({
        authorization: `Bearer ${initialSecret}`,
        body: {
          model: route.runtimeModel,
          store: false,
          stream: true,
        },
      });
      expect(JSON.stringify(providerRequests[1]?.body)).toContain(
        sandboxToolResult,
      );
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await expectNoBuiltInModelUsage(followUp.runId);

      const rotatedSecret = `${route.type}-rotated-secret`;
      const rotatedAt = now() + 1000;
      const rotated = await withMockNowForTest(rotatedAt, async () => {
        const updated = await upsertOrgModelProvider(actor, {
          type: route.type,
          secret: rotatedSecret,
        });
        expect(updated.providerId).toBe(providerId);
        return await sendChatRun(actor, {
          agentId,
          threadId: first.threadId,
          prompt: `continue after rotating the ${route.name} credential`,
          model: route.selectedModel,
          runOptions: { codexServiceTier: route.tier },
        });
      });
      await waitForRunStatus(actor, rotated.runId, "completed");
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(3);
      expectApiKeyGptRequest(
        providerRequests[2],
        route,
        rotatedSecret,
        route.tier,
      );
      expect(providerRequests[2]).toMatchObject({
        authorization: `Bearer ${rotatedSecret}`,
        body: {
          model: route.runtimeModel,
          store: false,
          stream: true,
        },
      });
      const rotatedBody = JSON.stringify(providerRequests[2]?.body);
      expect(occurrences(rotatedBody, firstPrompt)).toBe(1);
      expect(occurrences(rotatedBody, sandboxAnswer)).toBe(1);
      expect(occurrences(rotatedBody, followUpPrompt)).toBe(1);
      expect(rotatedBody).toContain(sandboxToolResult);
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await expectNoBuiltInModelUsage(rotated.runId);
      const publicState = JSON.stringify({
        run: await api.readRun(actor, rotated.runId),
        events: (await chat.listThreadEvents(actor, first.threadId)).events,
      });
      expect(publicState).not.toContain(initialSecret);
      expect(publicState).not.toContain(rotatedSecret);
      const histories = [...checkpointObjects].filter(([key]) => {
        return key.endsWith(".blob") || key.endsWith(".jsonl");
      });
      expect(histories).not.toHaveLength(0);
      for (const [, value] of histories) {
        const jsonl = value.toString("utf8");
        expect(jsonl).not.toMatch(/serviceTier|service_tier/);
        expect(jsonl).not.toContain(initialSecret);
        expect(jsonl).not.toContain(rotatedSecret);
      }
    },
    90_000,
  );

  it.each(GPT_API_KEY_BDD_ROUTES)(
    "fails closed when the admitted $name Fast credential disappears before provider ownership",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await publishPendingPiInstructions(actor, agentId);
      const secret = `${route.type}-deleted-secret`;
      await configureApiKeyGptPiModel(actor, route, secret);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const objects = mockPiCheckpointObjectStore();
      const providerRequests: string[] = [];
      server.use(
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          const objectKey = new URL(request.url).searchParams.get("object");
          if (!objectKey) {
            throw new Error("Expected Pi resource archive identity");
          }
          return new HttpResponse(piS3Object(objectKey), {
            headers: { "content-type": "application/gzip" },
          });
        }),
        ...USER_OWNED_GPT_FAST_BDD_ROUTES.map((candidate) => {
          return http.post(candidate.endpoint, ({ request }) => {
            providerRequests.push(request.url);
            return new HttpResponse(
              piResponsesTextSse(
                "unexpected provider owner",
                providerRequests.length,
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "keep captured Fast credentials authoritative",
        runOptions: { codexServiceTier: "fast" },
      });
      await entered.promise;
      await accept(
        setupApp({ context, routes: modelProvidersRoutes })(
          modelProvidersByTypeContract,
        ).delete({
          headers: sessionHeaders(actor),
          params: { type: route.type },
        }),
        [204],
      );
      release.resolve(undefined);
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      const failed = await api.readRun(actor, run.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining("[PI_API_MODEL_CREDENTIAL_INVALID]"),
      });
      expect(providerRequests).toStrictEqual([]);
      await expectNoBuiltInModelUsage(run.runId);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expectApiError(claim.body);
      const publicState = JSON.stringify({
        failed,
        events: (await chat.listThreadEvents(actor, run.threadId)).events,
        histories: [...objects.values()].map((value) => {
          return value.toString("utf8");
        }),
      });
      expect(publicState).not.toContain(secret);
      expect(
        objects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
    },
    90_000,
  );

  it.each(GPT_API_KEY_BDD_ROUTES)(
    "keeps rejected $name API-key Fast single-owner, redacted, and unbilled",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const secret = `${route.type}-rejected-secret`;
      const privateDiagnostic = "private-provider-rejection-details";
      await configureApiKeyGptPiModel(actor, route, secret);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        url: string;
        authorization: string | null;
        body: unknown;
      }[] = [];
      server.use(
        ...USER_OWNED_GPT_FAST_BDD_ROUTES.map((candidate) => {
          return http.post(candidate.endpoint, async ({ request }) => {
            requests.push({
              url: request.url,
              authorization: request.headers.get("authorization"),
              body: await readCodexRequestJson(request),
            });
            return HttpResponse.json(
              {
                error: {
                  code: "invalid_api_key",
                  message: `${privateDiagnostic} ${secret}`,
                },
              },
              { status: 401 },
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "fail the captured API-key Fast request once",
        runOptions: { codexServiceTier: "fast" },
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(route.endpoint);
      expectApiKeyGptRequest(requests[0], route, secret, "fast");
      const failed = await api.readRun(actor, run.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining("[PI_API_MODEL_FAILED]"),
      });
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      const publicState = JSON.stringify({
        failed,
        events,
        histories: [...objects.values()].map((value) => {
          return value.toString("utf8");
        }),
      });
      expect(publicState).not.toContain(secret);
      expect(publicState).not.toContain(privateDiagnostic);
      await expectNoBuiltInModelUsage(run.runId);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expectApiError(claim.body);
      expect(requests).toHaveLength(1);
    },
    90_000,
  );

  it("reuses a Codex session across DeepSeek V4 model switches", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "deepseek",
      secret: "deepseek-family-session-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "deepseek-v4-pro",
        isDefault: false,
        defaultProviderType: "deepseek",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start the DeepSeek V4 family session",
      model: "deepseek-v4-flash",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.cliAgentType).toBe("codex");
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue with DeepSeek V4 Pro",
      model: "deepseek-v4-pro",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.cliAgentType).toBe("codex");
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).OPENAI_MODEL).toBe(
      "deepseek-v4-pro",
    );
    expect(
      secondClaim.claim.codexRuntimeConfig?.modelCatalog?.models,
    ).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "deepseek-v4-pro" }),
      ]),
    );
    await cancelChatRun(actor, second.runId);
  });

  it("recovers a removed thread model through the current workspace route", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start before the thread model is removed",
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim.cliAgentType).toBe("claude-code");
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    await seedBuiltInModelKey("gpt-5.6-terra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const threadLock = await holdChatThreadRowLockFixture({
      threadId: first.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });
    const [recovered] = await Promise.all([
      sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue through the current workspace default",
      }),
      (async () => {
        await expect
          .poll(threadLock.firstBlockedStatementKind)
          .toBe("select_for_update");
        threadLock.release();
        await threadLock.done;
      })(),
    ]);
    const recoveredClaim = await claimChatRun(runnerGroup, recovered.runId);
    expect(recoveredClaim.claim.cliAgentType).toBe("codex");
    expect(recoveredClaim.claim.resumeSession).toBeNull();
    const recoveredEnvironment = claimEnvironment(recoveredClaim.claim);
    expect(recoveredEnvironment.OPENAI_MODEL).toBe("gpt-5.6-terra");
    expect(recoveredEnvironment.ANTHROPIC_MODEL).toBeUndefined();

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      threadEvents.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === first.threadId &&
          event.selectedModel === "gpt-5.6-terra"
        );
      }),
    ).toHaveLength(1);

    await cancelChatRun(actor, recovered.runId);
  }, 90_000);

  it("resolves a NULL legacy thread from current defaults without replaying its first run", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-opus-4-8",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the historical thread model",
      model: "claude-sonnet-5",
    });
    const queuedEventId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "continue after canonical default resolution",
        clientEventId: queuedEventId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the legacy-thread follow-up to queue");
    }
    expect(queued.body.runId).toBeNull();

    const historicalMessages = await chat.listThreadEvents(
      actor,
      first.threadId,
    );
    expect(userMessages(historicalMessages.events)).toContainEqual(
      expect.objectContaining({ runId: first.runId }),
    );

    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    await chat.updateUserModelPreference(actor, "claude-opus-4-8");
    await chat.updateThreadModelSelection(actor, first.threadId, null);
    expect(
      (await chat.readThreadMetadata(actor, first.threadId)).selectedModel,
    ).toBeNull();

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const promotedMessages = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesEventId === queuedEventId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promotedRunId = userMessages(promotedMessages.events).find(
      (message) => {
        return message.revokesEventId === queuedEventId;
      },
    )?.runId;
    if (!promotedRunId) {
      throw new Error("Expected the queued legacy-thread message to run");
    }

    const promotedClaim = await claimChatRun(runnerGroup, promotedRunId);
    expect(promotedClaim.claim.cliAgentType).toBe("claude-code");
    expect(claimEnvironment(promotedClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-8",
    );
    expect(
      (await chat.readThreadMetadata(actor, first.threadId)).selectedModel,
    ).toBe("claude-opus-4-8");

    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: first.threadId,
        selectedModel: "claude-opus-4-8",
      }),
    );

    await cancelChatRun(actor, promotedRunId, promotedClaim.sandboxHeaders);
  }, 90_000);

  it("does not overwrite a concurrent explicit thread model selection", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const [sent, updated] = await Promise.all([
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "send while choosing a new sticky model",
        },
        [201],
      ),
      chat.requestUpdateThreadModelSelection(
        actor,
        thread.id,
        "claude-sonnet-5",
        [204],
      ),
    ]);
    expect(updated.status).toBe(204);
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the concurrent send to create a run");
    }
    const racedClaim = await claimChatRun(runnerGroup, sent.body.runId);
    expect(["claude-opus-4-8", "claude-sonnet-5"]).toContain(
      claimEnvironment(racedClaim.claim).ANTHROPIC_MODEL,
    );
    await cancelChatRun(actor, sent.body.runId, racedClaim.sandboxHeaders);

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "continue on the explicit sticky model",
    });
    const followUpClaim = await claimChatRun(runnerGroup, followUp.runId);
    expect(claimEnvironment(followUpClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      events.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === thread.id &&
          event.selectedModel === "claude-sonnet-5"
        );
      }),
    ).toHaveLength(1);
    expect(
      events.body.events.filter((event) => {
        return (
          event.kind === "model_selection_updated" &&
          event.chatThreadId === thread.id &&
          event.selectedModel === "claude-opus-4-8"
        );
      }).length,
    ).toBeLessThanOrEqual(1);
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it("passes Codex fast mode only for feature-enabled GPT 5.6 sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const actorWithOrg = { ...actor, orgId };
    await seedBuiltInModelKey("gpt-5.6-sol");

    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-sol",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "gpt-5.6-luna",
        isDefault: false,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const switchOffThreadId = randomUUID();
    const switchOff = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "run codex fast with switch off",
        clientThreadId: switchOffThreadId,
        model: "gpt-5.6-sol",
        runOptions: { codexServiceTier: "fast" },
      },
      [400],
    );
    expectApiError(switchOff.body);
    expect(switchOff.body.error.message).toBe(
      "Codex fast mode is not enabled for this workspace",
    );
    await chat.requestReadThread(actor, switchOffThreadId, [404]);

    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.CodexFastMode]: true,
    });

    const fast = await sendChatRun(actor, {
      agentId,
      prompt: "run codex fast",
      model: "gpt-5.6-sol",
      runOptions: { codexServiceTier: "fast" },
    });
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );
    const fastMessages = await waitForThreadMessages(
      actor,
      fast.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return event.runId === fast.runId;
        });
      },
    );
    const fastUserMessage = userMessages(fastMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.runId === fast.runId;
      },
    )?.userMessage;
    expect(
      fastUserMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual({
      type: "model",
      selectedModel: "gpt-5.6-sol",
      serviceTier: "priority",
    });
    const fastClaim = await claimChatRun(runnerGroup, fast.runId);
    const environment = claimEnvironment(fastClaim.claim);
    expect(fastClaim.claim.cliAgentType).toBe("codex");
    expect(environment.OPENAI_MODEL).toBe("gpt-5.6-sol");
    expect(environment.OKOU_CODEX_SERVICE_TIER).toBe("fast");
    expect(environment.OPENAI_API_KEY).toBeTruthy();
    expect(environment.CHATGPT_ACCESS_TOKEN).toBeUndefined();
    await cancelChatRun(actor, fast.runId, fastClaim.sandboxHeaders);
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    const invalidFastPatch = await chat.requestUpdateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5",
      [400],
      { codexServiceTier: "fast" },
    );
    expectApiError(invalidFastPatch.body);
    expect(invalidFastPatch.body.error.message).toBe(
      "Codex fast mode is only available for GPT 5.6 runs",
    );
    expect((await readThreadProjection(actor, fast.threadId)).serviceTier).toBe(
      "priority",
    );

    await chat.updateThreadModelSelection(
      actor,
      fast.threadId,
      "claude-sonnet-5",
      {
        codexServiceTier: null,
      },
    );
    expect(
      (await readThreadProjection(actor, fast.threadId)).serviceTier,
    ).toBeNull();
    const updatedFastThreadEvents = await chat.requestThreadEvents(
      actor,
      {},
      [200],
    );
    expect(updatedFastThreadEvents.status).toBe(200);
    if (updatedFastThreadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "model_selection_updated",
        chatThreadId: fast.threadId,
        selectedModel: "claude-sonnet-5",
      }),
    );
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: fast.threadId,
        serviceTier: "priority",
      }),
    );
    expect(updatedFastThreadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "service_tier_updated",
        chatThreadId: fast.threadId,
        serviceTier: null,
      }),
    );

    const standard = await sendChatRun(actor, {
      agentId,
      threadId: fast.threadId,
      prompt: "run codex standard",
      model: "gpt-5.6-luna",
    });
    expect(
      (await readThreadProjection(actor, standard.threadId)).serviceTier,
    ).toBeNull();
    const standardMessages = await waitForThreadMessages(
      actor,
      standard.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return event.runId === standard.runId;
        });
      },
    );
    const standardUserMessage = userMessages(standardMessages.events).find(
      (event): event is PromptMessage => {
        return (
          event.eventType === "input.prompt" && event.runId === standard.runId
        );
      },
    )?.userMessage;
    expect(
      standardUserMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual({
      type: "model",
      selectedModel: "gpt-5.6-luna",
    });
    const { claim: standardClaim } = await claimChatRun(
      runnerGroup,
      standard.runId,
    );
    const standardEnvironment = claimEnvironment(standardClaim);
    expect(standardEnvironment.OPENAI_MODEL).toBe("gpt-5.6-luna");
    expect(standardEnvironment.OKOU_CODEX_SERVICE_TIER).toBeUndefined();
    await cancelChatRun(actor, standard.runId);

    const rejectedThreadId = randomUUID();
    const rejected = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "Claude cannot use Codex fast mode",
        clientThreadId: rejectedThreadId,
        model: "claude-sonnet-5",
        runOptions: { codexServiceTier: "fast" },
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "Codex fast mode is only available for GPT 5.6 runs",
    );
    await chat.requestReadThread(actor, rejectedThreadId, [404]);
  }, 90_000);

  it("preserves persisted fast mode after the current provider route changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: codexAuthJson() },
      },
      [200, 201],
    );
    const { providerId: openAiProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "rerouted-openai-key",
      },
    );
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.CodexFastMode]: true },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-luna",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start fast before the provider route changes",
      model: "gpt-5.6-luna",
      runOptions: { codexServiceTier: "fast" },
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });

    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-luna",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: openAiProviderId,
      },
    ]);
    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue from a client that still has fast cached",
      runOptions: { codexServiceTier: "fast" },
    });
    const followUpClaim = await claimChatRun(runnerGroup, followUp.runId);
    const environment = claimEnvironment(followUpClaim.claim);
    expect(environment.OPENAI_API_KEY).toBe(
      modelProviderSecretPlaceholder("openai-api-key", "OPENAI_API_KEY"),
    );
    expect(environment.OPENAI_MODEL).toBe("gpt-5.6-luna");
    expect(environment.OKOU_CODEX_SERVICE_TIER).toBe("fast");
    expect(
      (await readThreadProjection(actor, first.threadId)).serviceTier,
    ).toBe("priority");
    await expectNoThreadModelUpdateEvent(actor, first.threadId, "gpt-5.6-luna");
    await cancelChatRun(actor, followUp.runId);
  }, 90_000);

  it("routes OpenRouter provider pins through runtime model aliases and firewall auth", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected openrouter provider",
      model: "claude-opus-4-8",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "openrouter-api-key",
        "OPENROUTER_API_KEY",
      ),
    );
    expect(environment.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(environment.ANTHROPIC_API_KEY).toBe("");
    expect(environment.ANTHROPIC_MODEL).toBe("anthropic/claude-opus-4.8");
    expect(environment.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
      "anthropic/claude-opus-4.8",
    );
    expect(environment.CLAUDE_CODE_SUBAGENT_MODEL).toBe(
      "anthropic/claude-opus-4.8",
    );
    expect(environment.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBeUndefined();

    if (!claim.encryptedSecrets) {
      throw new Error("Expected OpenRouter claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected OpenRouter firewall auth to resolve");
    }
    expect(resolved.body.headers.Authorization).toBe(
      "Bearer test-openrouter-key",
    );
    expect(resolved.body.resolvedSecrets).toStrictEqual(["OPENROUTER_API_KEY"]);

    const thread = await chat.readThread(actor, run.threadId);
    expect(thread).not.toHaveProperty("selectedModel");
    expect(thread).not.toHaveProperty("modelProviderId");
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    expect(threadEvents.status).toBe(200);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(threadEvents.body.events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        chatThreadId: run.threadId,
        selectedModel: "claude-opus-4-8",
      }),
    );

    await api.requestCancelRun(actor, run.runId, [200]);
  }, 90_000);

  it("runs built-in DeepSeek through the native Pi API credential", async () => {
    const { actor, agentId } = await entitledChatActor();
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution("deepseek-v4-flash");
    const keyFixtureId = randomUUID();
    const requestedApiKey = `built-in-key-bdd-dev-seed-${keyFixtureId}`;

    // Keep a second DeepSeek fixture owner alive to cover vendor-unique row
    // arbitration instead of relying on another test file's scheduling.
    await seedBuiltInModelKey("deepseek-v4-flash");
    const selectedApiKey = await acquireBddBuiltInModelKey({
      fixtureId: keyFixtureId,
      vendor: "deepseek",
      apiKey: requestedApiKey,
    });

    let runId: string | null = null;
    const cancelRunIfCreated = async () => {
      if (runId) {
        const status = (await api.readRun(actor, runId)).status;
        if (status === "pending" || status === "running") {
          await api.requestCancelRun(actor, runId, [200]);
        }
      }
    };
    const releaseBuiltInDeepSeekKey = async () => {
      await releaseBddBuiltInModelKey({ fixtureId: keyFixtureId });
    };
    const cleanupRunAndKeys = async () => {
      await Promise.all([releaseBuiltInDeepSeekKey(), cancelRunIfCreated()]);
    };

    await (async () => {
      if (!actor.orgId) {
        throw new Error("Expected an organization-scoped chat actor");
      }
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: actor.orgId },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      await api.updateOrgModelPolicies(actor, [
        {
          model: "deepseek-v4-flash",
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const modelRequests: {
        readonly authorizationMatches: boolean;
        readonly body: unknown;
      }[] = [];
      server.use(
        http.post("https://api.deepseek.com/responses", async ({ request }) => {
          modelRequests.push({
            authorizationMatches:
              request.headers.get("authorization") ===
              `Bearer ${selectedApiKey}`,
            body: await request.json(),
          });
          return new HttpResponse(
            piResponsesTextSse(
              "built-in Pi API response",
              modelRequests.length,
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );

      const run = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "run with the selected built-in DeepSeek provider",
          model: "deepseek-v4-flash",
        },
        usagePricingResolution,
      );
      runId = run.runId;
      await waitForRunStatus(actor, run.runId, "completed");
      await flushWaitUntilForTest();
      expect(modelRequests).toHaveLength(1);
      expect(modelRequests[0]?.authorizationMatches).toBeTruthy();
      expect(modelRequests[0]?.body).toMatchObject({
        model: "deepseek-v4-flash",
        stream: true,
      });
      await expectPiApiUsage(run.runId, "deepseek-v4-flash", "", {
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheCreation: 0,
      });
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expect(claim.status).toBe(404);
      runId = null;
    })().then(cleanupRunAndKeys, async (error: unknown) => {
      await cleanupRunAndKeys();
      throw error;
    });
  }, 90_000);

  it("selects a built-in model key from a canonical policy without switching the run writer", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const keyFixtureId = randomUUID();
    const requestedApiKey = `built-in-key-bdd-dev-seed-${keyFixtureId}`;
    await seedBuiltInModelKey("claude-opus-4-8");

    let runId: string | null = null;

    onTestFinished(async () => {
      await Promise.all([
        releaseBddBuiltInModelKey({ fixtureId: keyFixtureId }),
        ...(runId ? [api.requestCancelRun(actor, runId, [200])] : []),
      ]);
    });

    const acquiredApiKey = await acquireBddBuiltInModelKey({
      fixtureId: keyFixtureId,
      vendor: "anthropic",
      apiKey: requestedApiKey,
    });
    expect(acquiredApiKey === requestedApiKey).toBeFalsy();

    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    if (!actor.orgId) {
      throw new Error("Expected the built-in model actor to have an org");
    }
    await setOrgModelPolicyProviderTypeFixture({
      orgId: actor.orgId,
      model: "claude-opus-4-8",
      defaultProviderType: "built-in",
    });

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with the selected built-in provider",
      model: "claude-opus-4-8",
    });
    runId = run.runId;
    await expect(
      readRunModelRuntimeRouteFixture(run.runId),
    ).resolves.toMatchObject({
      modelProvider: "built-in",
      selectedModel: "claude-opus-4-8",
    });

    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const environment = claimEnvironment(claim);
    expect(environment.ANTHROPIC_API_KEY).toBe(
      modelProviderSecretPlaceholder("anthropic-api-key", "ANTHROPIC_API_KEY"),
    );
    expect(environment.ANTHROPIC_MODEL).toBe("claude-opus-4-8");

    if (!claim.encryptedSecrets) {
      throw new Error("Expected the built-in claim to carry encrypted secrets");
    }
    const resolved = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("ANTHROPIC_API_KEY")}`,
        },
      },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected built-in firewall auth to resolve");
    }
    const authorization = resolved.body.headers.Authorization;
    expect(authorization?.startsWith("Bearer ")).toBeTruthy();
    expect(authorization?.length ?? 0).toBeGreaterThan("Bearer ".length);
    expect(authorization === `Bearer ${acquiredApiKey}`).toBeTruthy();
  }, 90_000);
  it("rejects legacy blank OpenRouter provider secrets during firewall auth", async () => {
    const fw = createFirewallApi(context);
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openrouter-api-key",
      secret: "test-openrouter-key",
    });
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    await overwriteModelProviderSecretForTests(context.signal, {
      providerId,
      secretName: "OPENROUTER_API_KEY",
      secret: "   ",
    });

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run with a legacy blank openrouter provider",
      model: "claude-opus-4-8",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    if (!claim.encryptedSecrets) {
      throw new Error("Expected OpenRouter claim to carry encrypted secrets");
    }

    const rejected = await fw.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [424],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");

    await api.requestCancelRun(actor, run.runId, [200]);
  }, 60_000);
});

describe("CHAT-02: run-level model overrides", () => {
  it("describes raw chat history sync by default", async () => {
    const { actor, agentId } = await entitledChatActor();

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "inspect raw thread history",
    });
    const stored = await api.readRun(actor, run.runId);
    const appended = stored.appendSystemPrompt ?? "";
    expect(appended).toContain(
      `okou chat messages --thread-id ${run.threadId} --output-dir threads`,
    );
    expect(appended).toContain(
      `rg -n '"seqId":<SEQ_ID>' threads/${run.threadId}/`,
    );
    expect(appended).not.toContain(
      "`okou chat messages` prints this thread's user and assistant messages",
    );

    await api.requestCancelRun(actor, run.runId, [200]);
  }, 60_000);

  it("uses send model overrides without mutating the thread model while preserving same-family sessions", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const firstPrompt = "first turn on the default opus policy";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-opus-4-8",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-8",
    );
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "opus answer")]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "opus answer";
      });
    });
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-opus-4-8",
    );
    expect(
      (await api.readRun(actor, first.runId)).result?.agentSessionId,
    ).toMatch(/[0-9a-f-]{36}/);

    // A run-level override of another model in the same family resumes the CLI
    // session, which already carries the prior web round, so the prompt does
    // not replay it.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "switch to sonnet",
      model: "claude-sonnet-5",
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain("Assistant: opus answer");
    expect(appended).toContain("# This Chat Thread");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    expect(appended).toContain("`okou chat messages`");
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    // Follow-ups without a send model override go back to the thread's stored
    // model. Both models remain in the Claude family, so session continuity is
    // preserved.
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on the thread model",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    expect(claimEnvironment(thirdClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-8",
    );
    await cancelChatRun(actor, third.runId);
  }, 90_000);

  it.each(
    (
      [
        {
          name: "standard",
          tier: undefined,
          generation: 2,
          outcome: "completed",
        },
        { name: "Fast", tier: "fast", generation: 3, outcome: "completed" },
        { name: "Fast", tier: "fast", generation: 3, outcome: "failed" },
        { name: "Fast", tier: "fast", generation: 3, outcome: "cancelled" },
      ] as const
    ).flatMap((scenario) => {
      return GPT_PI_BDD_MODELS.map((selectedModel) => {
        return {
          ...scenario,
          selectedModel,
        };
      });
    }),
  )(
    "hands native $name subscription $selectedModel tools to a generation-$generation Sandbox with $outcome outcome and no built-in billing",
    async ({ tier, generation, outcome, selectedModel }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const firewall = createFirewallApi(context);
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const externalAccountId = "chat-codex-pi-subscription-account";
      const refreshToken = "rt_pi_subscription_fixture_high_entropy";
      const { oauth, accountSourceId } = await configureSubscriptionPiModel(
        actor,
        {
          accountId: externalAccountId,
          refreshToken,
          accessTokenExpiresAt: Math.floor(now() / 1000) - 60,
          refreshedAccessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
          workspaceName: "Pi Subscription Account",
        },
        selectedModel,
      );
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PersonalModelProviderAccounts]: false,
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.CodexFastMode]: true,
      });

      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const providerRequests: {
        readonly accountMatches: boolean;
        readonly authorization: string | null;
        readonly body: unknown;
      }[] = [];
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/codex/responses",
          async ({ request }) => {
            const authorization = request.headers.get("authorization");
            const body = await readCodexRequestJson(request);
            providerRequests.push({
              accountMatches:
                request.headers.get("chatgpt-account-id") === externalAccountId,
              authorization,
              body,
            });
            const responseBody = piResponsesContentSse({
              blocks:
                providerRequests.length === 1
                  ? [
                      {
                        type: "toolCall",
                        callId: "call_subscription_tool",
                        name: "bash",
                        arguments: {
                          command: `npx --yes --package="\${CLI_PKG_URL}" okou --help`,
                        },
                      },
                    ]
                  : [
                      {
                        type: "text",
                        text: "Subscription API-first continuation complete",
                      },
                    ],
              sequence: providerRequests.length,
            });
            return nativeCodexSseResponse(responseBody);
          },
        ),
      );

      const run = await sendChatRun(actor, {
        agentId,
        prompt: "use the Okou CLI through native subscription Terra",
        model: selectedModel,
        runOptions: { codexServiceTier: tier },
      });
      await expect
        .poll(() => {
          return providerRequests.length;
        })
        .toBe(1);
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      const sessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`;
      await expect
        .poll(() => {
          return checkpointObjects.has(manifestKey);
        })
        .toBe(true);
      await flushWaitUntilForTest();

      expect(providerRequests).toHaveLength(1);
      const refreshedAccessToken = z
        .string()
        .parse(oauth.oauthTokenResponses[1]?.access_token);
      expectNativeSubscriptionRequest(
        providerRequests[0],
        refreshedAccessToken,
        tier,
        selectedModel,
      );
      expect(oauth.oauthToken).toHaveLength(2);
      expect(oauth.oauthToken[1]?.get("grant_type")).toBe("refresh_token");
      await expectNoBuiltInModelUsage(run.runId);

      await api.heartbeatRunner(runnerGroup);
      if (tier === "fast") {
        const oldClaim = await api.requestClaimRunnerJob(
          true,
          run.runId,
          [404],
          { capabilities: { piModelConfigGenerations: [1, 2] } },
        );
        expectApiError(oldClaim.body);
        await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
          status: "pending",
        });
      }
      const claim = await api.claimRunnerJob(run.runId, {
        capabilities: {
          piModelConfigGenerations: tier === "fast" ? [1, 2, 3] : [1, 2],
        },
      });
      const sandboxHeaders = {
        authorization: `Bearer ${claim.sandboxToken}`,
      };
      expect(claim).toMatchObject({
        cliAgentType: "pi",
        piSessionId: run.threadId,
        piModelConfig: {
          schemaVersion: generation,
          ...(tier === undefined ? {} : { serviceTier: tier }),
          dialect: "openai-codex-responses",
          transport: "sse",
          provider: "openai-codex",
          baseUrl: "https://chatgpt.com/backend-api",
          model: selectedModel,
          thinkingLevel: "max",
          credentialBindings: [
            {
              kind: "access-token",
              environment: "CHATGPT_ACCESS_TOKEN",
              secretName: "CHATGPT_ACCESS_TOKEN",
            },
            {
              kind: "account-id",
              environment: "CHATGPT_ACCOUNT_ID",
              secretName: "CHATGPT_ACCOUNT_ID",
            },
          ],
        },
      });
      expect(claimEnvironment(claim)).toMatchObject({
        CHATGPT_ACCESS_TOKEN:
          MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
        CHATGPT_ACCOUNT_ID: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID,
      });
      expect(claim.billableFirewalls).toStrictEqual([]);
      expect(
        claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
      ).toMatchObject({ sourceId: accountSourceId });
      expect(
        claim.secretConnectorMetadataMap?.CHATGPT_ACCOUNT_ID,
      ).toMatchObject({
        sourceId: accountSourceId,
      });
      expect(JSON.stringify(claim)).not.toContain(externalAccountId);
      expect(JSON.stringify(claim)).not.toContain(refreshToken);

      const encryptedSecrets = z.string().parse(claim.encryptedSecrets);
      const sandboxCredential = await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets,
          authHeaders: {
            Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
            "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (sandboxCredential.status !== 200) {
        throw new Error("Expected exact subscription firewall credentials");
      }
      expect(sandboxCredential.body.headers["ChatGPT-Account-ID"]).toBe(
        externalAccountId,
      );
      expect(sandboxCredential.body.headers.Authorization).toBe(
        `Bearer ${refreshedAccessToken}`,
      );
      expect(oauth.oauthToken).toHaveLength(2);

      const h1 = z
        .instanceof(Buffer)
        .parse(checkpointObjects.get(sessionKey))
        .toString("utf8");
      expect(h1).not.toMatch(/serviceTier|service_tier/);
      expect(h1).not.toContain(externalAccountId);
      expect(h1).not.toContain(refreshToken);
      expect(h1).not.toContain(
        MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
      );
      const h2 = settledSubscriptionToolHistory(h1);
      expect(h2).not.toMatch(/serviceTier|service_tier/);
      const h2Hash = createHash("sha256").update(h2).digest("hex");
      await webhooks.requestAgentCheckpointPrepareHistory(
        {
          runId: run.runId,
          hash: h2Hash,
          rawSize: Buffer.byteLength(h2),
          encodedSize: Buffer.byteLength(h2),
          encoding: "identity",
        },
        sandboxHeaders,
        [200],
      );
      checkpointObjects.set(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h2Hash}.blob`,
        Buffer.from(h2, "utf8"),
      );
      if (outcome === "cancelled") {
        await cancelChatRun(actor, run.runId);
      }
      const completion = await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: outcome === "failed" ? 1 : 0,
          ...(outcome === "failed"
            ? { error: "Subscription Sandbox failed" }
            : {}),
          checkpoint: {
            cliAgentType: "pi",
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryHash: h2Hash,
          },
        },
        sandboxHeaders,
        outcome === "cancelled" ? [400] : [200],
      );
      expect(completion.status).toBe(outcome === "cancelled" ? 400 : 200);
      await waitForRunStatus(actor, run.runId, outcome);
      await flushWaitUntilForTest();
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(1);
      await expectNoBuiltInModelUsage(run.runId);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: outcome,
      });
      if (outcome !== "completed") {
        return;
      }

      const firstSession = await readThreadSessionConversation(
        context,
        run.threadId,
      );
      const continued = await sendChatRun(actor, {
        agentId,
        threadId: run.threadId,
        prompt: "continue on the same subscription account",
        model: selectedModel,
        runOptions: { codexServiceTier: tier },
      });
      await waitForRunStatus(actor, continued.runId, "completed");
      await flushWaitUntilForTest();
      expect(providerRequests).toHaveLength(2);
      expectNativeSubscriptionRequest(
        providerRequests[1],
        refreshedAccessToken,
        tier,
        selectedModel,
      );
      expect(JSON.stringify(providerRequests[1]?.body)).toContain(
        "Okou CLI help output",
      );
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          continued.runId,
        ),
      ).toContainEqual(
        expect.objectContaining({
          content: "Subscription API-first continuation complete",
        }),
      );
      await expect(
        readThreadSessionConversation(context, run.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await expectNoBuiltInModelUsage(continued.runId);
    },
    90_000,
  );

  it.each(
    [
      ...[
        "refresh_token_reused",
        "refresh_token_expired",
        "refresh_token_invalidated",
      ].map((refreshErrorCode) => {
        return {
          name: refreshErrorCode,
          failureReason: "reconnect_required" as const,
          errorCode: "PI_API_MODEL_CREDENTIAL_INVALID",
          refreshErrorCode,
          expectedReconnect: true,
          expired: true,
          providerCalls: 0,
        };
      }),
      {
        name: "unknown refresh failure",
        failureReason: "reconnect_required" as const,
        errorCode: "PI_API_MODEL_CREDENTIAL_INVALID",
        refreshErrorCode: "new_provider_error",
        expectedReconnect: false,
        expired: true,
        providerCalls: 0,
      },
      {
        name: "transient refresh failure",
        failureReason: undefined,
        errorCode: "PI_API_MODEL_CREDENTIAL_INVALID",
        refreshErrorCode: null,
        expectedReconnect: false,
        expired: true,
        providerCalls: 0,
      },
      {
        name: "subscription usage limit",
        failureReason: "usage_limit" as const,
        errorCode: "PI_API_MODEL_FAILED",
        refreshErrorCode: null,
        expectedReconnect: false,
        expired: false,
        providerCalls: 1,
      },
    ].flatMap((scenario) => {
      return ([undefined, "fast"] as const).map((tier) => {
        return { ...scenario, tier };
      });
    }),
  )(
    "classifies a $name with tier $tier without replay, billing, or private diagnostics",
    async (scenario) => {
      mockOptionalEnv("OKOU_DEBUG", "webhook:firewall-auth,pi-api-first-turn");
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const privateMarker = `private-${scenario.failureReason}-diagnostic`;
      const externalAccountId = `chat-${scenario.failureReason}-account`;
      const refreshToken = `rt_${scenario.failureReason}_high_entropy`;
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.CodexFastMode]: true,
      });
      const oauth = mockCodexDeviceAuthProvider({
        tokenScope: "personal",
        accountId: externalAccountId,
        refreshToken,
        accessTokenExpiresAt: scenario.expired
          ? Math.floor(now() / 1000) - 60
          : Math.floor(now() / 1000) + 7200,
        workspaceName: "Pi Failure Account",
      });
      const started = await authDevice.requestCodexStart(
        actor,
        "personal",
        [200],
        { mode: "add" },
      );
      if (started.status !== 200) {
        throw new Error("Expected subscription auth to start");
      }
      const completed = await authDevice.requestCodexComplete(
        actor,
        started.body.sessionToken,
        [200],
      );
      if (
        !("status" in completed.body) ||
        completed.body.status !== "complete"
      ) {
        throw new Error("Expected subscription auth to complete");
      }
      let refreshAttempts = 0;
      if (scenario.expired) {
        server.use(
          http.post("https://auth.openai.com/oauth/token", () => {
            refreshAttempts += 1;
            return HttpResponse.json(
              {
                error: {
                  code: scenario.refreshErrorCode ?? "server_error",
                  message: privateMarker,
                },
              },
              { status: scenario.refreshErrorCode === null ? 503 : 401 },
            );
          }),
        );
      }

      await chatCallbacks.updateOrgModelPolicies(actor, [
        {
          model: "gpt-5.6-terra",
          isDefault: true,
          defaultProviderType: "codex-oauth-token",
          credentialScope: "member",
          modelProviderId: null,
        },
      ]);
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      let modelCalls = 0;
      server.use(
        http.post("https://chatgpt.com/backend-api/codex/responses", () => {
          modelCalls += 1;
          return HttpResponse.json(
            {
              error: {
                code: "usage_limit_reached",
                message: privateMarker,
              },
            },
            { status: 429 },
          );
        }),
      );

      const run = await sendChatRun(actor, {
        agentId,
        prompt: `classify ${scenario.failureReason}`,
        model: "gpt-5.6-terra",
        runOptions: { codexServiceTier: scenario.tier },
      });
      await waitForRunStatus(actor, run.runId, "failed", 10_000);
      await flushWaitUntilForTest();

      const failed = await api.readRun(actor, run.runId);
      expect(failed).toMatchObject({
        status: "failed",
        error: expect.stringContaining(`[${scenario.errorCode}]`),
      });
      expect(modelCalls).toBe(scenario.providerCalls);
      expect(refreshAttempts).toBe(scenario.expired ? 1 : 0);
      expect(oauth.oauthToken).toHaveLength(1);
      if (scenario.expectedReconnect) {
        expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
      }
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      const failureEvent = events.find((event) => {
        return event.eventType === "run.failed" && event.runId === run.runId;
      });
      if (failureEvent?.eventType !== "run.failed") {
        throw new Error("Expected the subscription run failure event");
      }
      expect(failureEvent.failureReason).toBe(scenario.failureReason);
      const publicState = JSON.stringify({
        failed,
        events,
        checkpointObjects: [...checkpointObjects.entries()].map(
          ([key, value]) => {
            return [key, value.toString("utf8")];
          },
        ),
      });
      expect(publicState).not.toContain(privateMarker);
      expect(publicState).not.toContain(externalAccountId);
      expect(publicState).not.toContain(refreshToken);
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      await expectNoBuiltInModelUsage(run.runId);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expectApiError(claim.body);
      if (scenario.expectedReconnect) {
        const repeated = await sendChatRun(actor, {
          agentId,
          prompt: "retry the terminal subscription account",
          model: "gpt-5.6-terra",
          runOptions: { codexServiceTier: scenario.tier },
        });
        await waitForRunStatus(actor, repeated.runId, "failed", 10_000);
        await flushWaitUntilForTest();
        expect(refreshAttempts).toBe(1);
        expect(modelCalls).toBe(0);
        expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
        expect(
          (await chat.listThreadEvents(actor, repeated.threadId)).events,
        ).toContainEqual(
          expect.objectContaining({
            eventType: "run.failed",
            runId: repeated.runId,
            failureReason: "reconnect_required",
          }),
        );
      }
    },
    90_000,
  );

  it("refreshes the captured subscription Fast account while another account becomes active", async () => {
    const { actor, agentId } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const other = await configureSubscriptionPiModel(actor, {
      accountId: "other-active-account",
    });
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const refreshToken = "rt_captured_subscription_fast_account";
    const captured = await configureSubscriptionPiModel(actor, {
      accountId: "captured-subscription-account",
      refreshToken,
      accessTokenExpiresAt: Math.floor(now() / 1000) - 60,
      refreshedAccessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
    });
    await authDeviceSupport.activatePersonalModelProviderAccount(
      actor,
      captured.accountSourceId,
    );
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
        if (!entered.settled()) {
          entered.resolve(undefined);
        }
        await release.promise;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    mockPiCheckpointObjectStore();
    const requests: {
      body: unknown;
      authorization: string | null;
      accountId: string | null;
    }[] = [];
    server.use(
      http.post(
        "https://chatgpt.com/backend-api/codex/responses",
        async ({ request }) => {
          requests.push({
            body: await readCodexRequestJson(request),
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("chatgpt-account-id"),
          });
          return nativeCodexSseResponse(
            piResponsesTextSse("captured subscription answer", 1),
          );
        },
      ),
    );
    const run = await sendChatRun(actor, {
      agentId,
      model: "gpt-5.6-terra",
      prompt: "retain captured subscription Fast credentials",
      runOptions: { codexServiceTier: "fast" },
    });
    await entered.promise;
    expect(requests).toHaveLength(0);
    expect(captured.oauth.oauthToken).toHaveLength(1);
    await authDeviceSupport.activatePersonalModelProviderAccount(
      actor,
      other.accountSourceId,
    );
    release.resolve(undefined);
    await waitForRunStatus(actor, run.runId, "completed");
    await flushWaitUntilForTest();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: `Bearer ${captured.oauth.oauthTokenResponses[1]?.access_token}`,
      accountId: "captured-subscription-account",
      body: {
        model: "gpt-5.6-terra",
        service_tier: "priority",
        stream: true,
        store: false,
      },
    });
    expect(requests[0]?.body).not.toHaveProperty("previous_response_id");
    expect(captured.oauth.oauthToken).toHaveLength(2);
    expect(captured.oauth.oauthToken[1]?.get("refresh_token")).toBe(
      refreshToken,
    );
    expect(other.oauth.oauthToken).toHaveLength(1);
    await expectNoBuiltInModelUsage(run.runId);
  }, 90_000);

  it.each(USER_OWNED_GPT_FAST_BDD_ROUTES)(
    "reuses one $name Pi session across standard, Fast, and standard requests",
    async (route) => {
      const { actor, agentId } = await entitledChatActor();
      const { secret, accountId } = await configureUserOwnedGptPiModel(
        actor,
        route,
      );
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        body: unknown;
        authorization: string | null;
        accountId: string | null;
      }[] = [];
      server.use(
        http.post(route.endpoint, async ({ request }) => {
          requests.push({
            body: await readCodexRequestJson(request),
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("chatgpt-account-id"),
          });
          return nativeCodexSseResponse(
            piResponsesTextSse(
              `Terra answer ${requests.length}`,
              requests.length,
            ),
          );
        }),
      );

      const first = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "Terra standard start",
      });
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      const firstSession = await readThreadSessionConversation(
        context,
        first.threadId,
      );
      const fast = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        model: route.selectedModel,
        prompt: "Terra Fast continuation",
        runOptions: { codexServiceTier: "fast" },
      });
      await waitForRunStatus(actor, fast.runId, "completed");
      await flushWaitUntilForTest();
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await chat.updateThreadModelSelection(
        actor,
        first.threadId,
        route.selectedModel,
        { codexServiceTier: null },
      );
      const standard = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        model: route.selectedModel,
        prompt: "Terra standard return",
      });
      await waitForRunStatus(actor, standard.runId, "completed");
      await flushWaitUntilForTest();
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
        conversation_run_id: standard.runId,
      });

      expect(requests).toHaveLength(3);
      expect(
        requests.map(({ body }) => {
          return z
            .object({ service_tier: z.literal("priority").optional() })
            .parse(body).service_tier;
        }),
      ).toStrictEqual([undefined, route.wireTier, undefined]);
      for (const request of requests) {
        expect(request).toMatchObject({
          authorization: `Bearer ${secret}`,
          accountId,
          body: {
            model: route.runtimeModel,
            stream: true,
            store: false,
            reasoning: { effort: "max" },
          },
        });
        expect(request.body).not.toHaveProperty("previous_response_id");
      }
      expect(JSON.stringify(requests[1]?.body)).toContain("Terra answer 1");
      expect(JSON.stringify(requests[2]?.body)).toContain("Terra answer 2");
      const histories = [...objects.entries()].filter(([key]) => {
        return key.endsWith(".blob");
      });
      expect(histories).toHaveLength(3);
      for (const [, value] of histories) {
        expect(
          MemoryPiSession.fromJsonl(value.toString("utf8")).getSessionId(),
        ).toBe(first.threadId);
        expect(value.toString("utf8")).not.toMatch(/serviceTier|service_tier/);
        expect(value.toString("utf8")).not.toContain(secret);
      }
      for (const run of [first, fast, standard]) {
        await expectNoBuiltInModelUsage(run.runId);
      }
    },
    90_000,
  );

  it.each(
    USER_OWNED_GPT_FAST_BDD_ROUTES.flatMap((route) => {
      return (["web", "agent"] as const).map((origin) => {
        return {
          route,
          name: route.name,
          origin,
        };
      });
    }),
  )(
    "promotes queued and immediate $name Fast from $origin through API-first",
    async ({ route, origin }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const source = await sendChatRun(actor, {
        agentId,
        prompt: "source run for Terra handoff",
      });
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the Terra target thread",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      const token = api.okouTokenForRunWithCapabilities(actor, source.runId, [
        "chat-thread:read",
        "chat-thread:write",
        "chat-event:read",
        "chat-event:write",
      ]);
      const { secret, accountId } = await configureUserOwnedGptPiModel(
        actor,
        route,
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(route.endpoint, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
          expect(request.headers.get("chatgpt-account-id")).toBe(accountId);
          requests.push(await readCodexRequestJson(request));
          return nativeCodexSseResponse(
            piResponsesTextSse("queued Terra answer", requests.length),
          );
        }),
      );
      const queuedId = randomUUID();
      const body = {
        agentId,
        threadId: anchor.threadId,
        clientEventId: queuedId,
        prompt: "queued Terra Fast",
        model: route.selectedModel,
        runOptions: { codexServiceTier: "fast" as const },
      };
      const queued =
        origin === "agent"
          ? await requestSendEventWithBearer(token, body, [201])
          : await chat.requestSendEvent(actor, body, [201]);
      if (queued.status !== 201) {
        throw new Error("Expected queued subscription send");
      }
      expect(queued.body.runId).toBeNull();
      expect(requests).toHaveLength(0);
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
      const messages = await waitForThreadMessages(
        actor,
        anchor.threadId,
        (events) => {
          return userMessages(events).some((event) => {
            return (
              event.revokesEventId === queuedId && event.runId !== undefined
            );
          });
        },
      );
      const promoted = userMessages(messages.events).find((event) => {
        return event.revokesEventId === queuedId;
      });
      if (!promoted?.runId) {
        throw new Error("Expected queued subscription promotion");
      }
      await waitForRunStatus(actor, promoted.runId, "completed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: route.runtimeModel,
        service_tier: route.wireTier,
        stream: true,
        store: false,
      });
      expect(requests[0]).not.toHaveProperty("previous_response_id");
      expect(occurrences(JSON.stringify(requests[0]), body.prompt)).toBe(1);
      await expectNoBuiltInModelUsage(promoted.runId);
      const claim = await api.requestClaimRunnerJob(
        true,
        promoted.runId,
        [404],
        { capabilities: { piModelConfigGenerations: [1, 2, 3] } },
      );
      expectApiError(claim.body);

      const immediateBody = {
        agentId,
        prompt: "immediate Terra Fast",
        model: route.selectedModel,
        runOptions: { codexServiceTier: "fast" as const },
      };
      const immediate =
        origin === "agent"
          ? await requestSendEventWithBearer(token, immediateBody, [201])
          : await chat.requestSendEvent(actor, immediateBody, [201]);
      if (immediate.status !== 201 || !immediate.body.runId) {
        throw new Error("Expected immediate subscription run");
      }
      await waitForRunStatus(actor, immediate.body.runId, "completed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ service_tier: route.wireTier });
      await expectNoBuiltInModelUsage(immediate.body.runId);
      await cancelChatRun(actor, source.runId);
    },
    90_000,
  );

  it.each(
    USER_OWNED_GPT_FAST_BDD_ROUTES.flatMap((route) => {
      return (["in-flight", "late-result"] as const).map((phase) => {
        return {
          route,
          name: route.name,
          phase,
        };
      });
    }),
  )(
    "keeps cancelled $name Fast $phase results unbilled and unreplayed",
    async ({ route, phase }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const { secret, accountId } = await configureUserOwnedGptPiModel(
        actor,
        route,
      );
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const requests: unknown[] = [];
      server.use(
        http.post(route.endpoint, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
          expect(request.headers.get("chatgpt-account-id")).toBe(accountId);
          requests.push(await readCodexRequestJson(request));
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          return nativeCodexSseResponse(
            piResponsesTextSse("discarded Terra answer", requests.length),
          );
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "cancel Terra Fast ownership",
        runOptions: { codexServiceTier: "fast" },
      });
      await entered.promise;
      if (phase === "late-result") {
        await cancelBeforeLatePiResult(actor, run.runId, () => {
          release.resolve(undefined);
        });
      } else {
        await cancelChatRun(actor, run.runId);
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        service_tier: route.wireTier,
        stream: true,
        store: false,
      });
      await expectNoBuiltInModelUsage(run.runId);
      expect(
        objects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      expect(
        objects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        ),
      ).toBeFalsy();
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          run.runId,
        ),
      ).toHaveLength(0);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expectApiError(claim.body);
    },
    90_000,
  );

  it("reuses Codex sessions across account switches with the newly captured account", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    const firewall = createFirewallApi(context);
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "chat-codex-account-a",
      workspaceName: "Chat Account A",
    });
    const startedA = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedA.status !== 200) {
      throw new Error("Expected Codex account A auth to start");
    }
    const completedA = await authDevice.requestCodexComplete(
      actor,
      startedA.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedA.body) ||
      completedA.body.status !== "complete"
    ) {
      throw new Error("Expected Codex account A auth to complete");
    }
    const accountAId = completedA.body.provider.id;

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "chat-codex-account-b",
      workspaceName: "Chat Account B",
    });
    const startedB = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedB.status !== 200) {
      throw new Error("Expected Codex account B auth to start");
    }
    const completedB = await authDevice.requestCodexComplete(
      actor,
      startedB.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedB.body) ||
      completedB.body.status !== "complete"
    ) {
      throw new Error("Expected Codex account B auth to complete");
    }
    const accountBId = completedB.body.provider.id;

    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-luna",
        isDefault: false,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start with account A",
      model: "gpt-5.6-luna",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(
      firstClaim.claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({ sourceId: accountAId });

    await authDeviceSupport.activatePersonalModelProviderAccount(
      actor,
      accountBId,
    );
    if (!firstClaim.claim.encryptedSecrets) {
      throw new Error("Expected account A run to carry encrypted secrets");
    }
    const firstResolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${firstClaim.claim.sandboxToken}` },
      {
        encryptedSecrets: firstClaim.claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
          "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
        },
        secretConnectorMap: firstClaim.claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          firstClaim.claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (firstResolved.status !== 200) {
      throw new Error("Expected account A firewall auth to resolve");
    }
    expect(firstResolved.body.headers["ChatGPT-Account-ID"]).toBe(
      "chat-codex-account-a",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue with account B",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(
      secondClaim.claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({ sourceId: accountBId });
    if (!secondClaim.claim.encryptedSecrets) {
      throw new Error("Expected account B run to carry encrypted secrets");
    }
    const secondResolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${secondClaim.claim.sandboxToken}` },
      {
        encryptedSecrets: secondClaim.claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
          "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
        },
        secretConnectorMap: secondClaim.claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          secondClaim.claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (secondResolved.status !== 200) {
      throw new Error("Expected account B firewall auth to resolve");
    }
    expect(secondResolved.body.headers["ChatGPT-Account-ID"]).toBe(
      "chat-codex-account-b",
    );
    expect(secondResolved.body.headers.Authorization).not.toBe(
      firstResolved.body.headers.Authorization,
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });
    await flushWaitUntilForTest();

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue again with account B",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    expect(
      thirdClaim.claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({ sourceId: accountBId });

    await cancelChatRun(actor, third.runId);
    await authDeviceSupport.deletePersonalModelProvider(
      actor,
      "codex-oauth-token",
      [204],
    );
  }, 90_000);

  it("resumes the CLI session across same-family model switches", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start on opus before switching within Claude",
      model: "claude-opus-4-8",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on sonnet in the same session",
      model: "claude-sonnet-5",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it.each([
    {
      from: "gpt-5.6-sol",
      to: "gpt-6-astra",
      runtime: "codex",
      reuse: true,
    },
    {
      from: "claude-opus-4-8",
      to: "claude-sonnet-5",
      runtime: "claude-code",
      reuse: true,
    },
    {
      from: "deepseek-v4-flash",
      to: "deepseek-v4-pro",
      runtime: "codex",
      reuse: true,
    },
    {
      from: "gpt-6-astra",
      to: "deepseek-v4-flash",
      runtime: "codex",
      reuse: false,
    },
  ] as const)(
    "applies family compatibility when switching built-in $from to $to on $runtime",
    async ({ from, to, runtime, reuse }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        { [FeatureSwitchKey.PiLoop]: false },
      );
      await seedBuiltInModelKey(from);
      await seedBuiltInModelKey(to);
      await api.updateOrgModelPolicies(actor, [
        {
          model: from,
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
        {
          model: to,
          isDefault: false,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "establish native history before switching models",
        model: from,
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.cliAgentType).toBe(runtime);
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
        cliAgentType: runtime,
      });
      await flushWaitUntilForTest();
      const firstRun = await api.readRun(actor, first.runId);
      expect(firstRun).toMatchObject({
        status: "completed",
        result: { agentSessionId: expect.any(String) },
      });

      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with the selected model",
        model: to,
      });
      const secondClaim = await claimChatRun(runnerGroup, second.runId);
      expect(secondClaim.claim.cliAgentType).toBe(runtime);
      const environment = claimEnvironment(secondClaim.claim);
      expect(
        runtime === "codex"
          ? environment.OPENAI_MODEL
          : environment.ANTHROPIC_MODEL,
      ).toBe(to);
      expect(secondClaim.claim.resumeSession?.sessionId ?? null).toBe(
        reuse ? `bdd-cli-${first.runId}` : null,
      );
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
        cliAgentType: runtime,
      });
      await flushWaitUntilForTest();
      const secondRun = await api.readRun(actor, second.runId);
      expect(secondRun).toMatchObject({
        status: "completed",
        result: { agentSessionId: expect.any(String) },
      });
      expect(
        secondRun.result?.agentSessionId === firstRun.result?.agentSessionId,
      ).toBe(reuse);
    },
    90_000,
  );

  it("refuses a canonical session owned by another user and organization", async () => {
    const primary = await entitledChatActor();
    const foreign = await entitledChatActor();
    const runnerGroup = api.configureRunnerGroup();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const primaryFirst = await sendChatRun(primary.actor, {
      agentId: primary.agentId,
      prompt: "establish the correctly owned canonical session",
    });
    const primaryClaim = await claimChatRun(runnerGroup, primaryFirst.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(primaryFirst.runId, primaryClaim.sandboxHeaders);

    const foreignFirst = await sendChatRun(foreign.actor, {
      agentId: foreign.agentId,
      prompt: "establish a foreign canonical session",
    });
    const foreignClaim = await claimChatRun(runnerGroup, foreignFirst.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(foreignFirst.runId, foreignClaim.sandboxHeaders);

    const primaryBinding = await readThreadSessionBinding(
      context,
      primaryFirst.threadId,
    );
    const foreignBinding = await readThreadSessionBinding(
      context,
      foreignFirst.threadId,
    );
    if (!primaryBinding.agent_session_id || !foreignBinding.agent_session_id) {
      throw new Error("Expected both threads to establish canonical sessions");
    }
    await replaceThreadSessionBindingFixture({
      threadId: primaryFirst.threadId,
      sessionId: foreignBinding.agent_session_id,
      runId: foreignFirst.runId,
    });

    const primarySecond = await sendChatRun(primary.actor, {
      agentId: primary.agentId,
      threadId: primaryFirst.threadId,
      prompt: "continue without reusing the foreign session",
    });
    const repairedBinding = await readThreadSessionBinding(
      context,
      primaryFirst.threadId,
    );
    expect(repairedBinding).toMatchObject({
      agent_session_id: expect.any(String),
      agent_session_run_id: primarySecond.runId,
      run_session_id: repairedBinding.agent_session_id,
    });
    expect(repairedBinding.agent_session_id).not.toBe(
      foreignBinding.agent_session_id,
    );
    expect(repairedBinding.agent_session_id).not.toBe(
      primaryBinding.agent_session_id,
    );
    const primarySecondClaim = await claimChatRun(
      runnerGroup,
      primarySecond.runId,
    );
    expect(primarySecondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(primary.actor, primarySecond.runId);
  }, 90_000);

  it("does not repeat preparation after a competing run changes the binding", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for binding admission");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const established = await sendChatRun(actor, {
      agentId,
      prompt: "establish the binding before competing sends",
    });
    const establishedClaim = await claimChatRun(runnerGroup, established.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(established.runId, establishedClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    const firstEventId = randomUUID();
    const secondEventId = randomUUID();
    const firstRequest = {
      eventId: firstEventId,
      prompt: "first competing binding send",
      response: chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: established.threadId,
          prompt: "first competing binding send",
          clientEventId: firstEventId,
        },
        [201],
      ),
    } as const;
    // Make the queue head the first admission-lock waiter so the second
    // prepared request observes the binding committed by the first.
    await expect.poll(admissionLock.waiterCount).toBe(1);

    const secondRequest = {
      eventId: secondEventId,
      prompt: "second competing binding send",
      response: chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: established.threadId,
          prompt: "second competing binding send",
          clientEventId: secondEventId,
        },
        [201],
      ),
    } as const;
    const requests = [firstRequest, secondRequest] as const;

    await expect
      .poll(async () => {
        const messages = await chat.listThreadEvents(
          actor,
          established.threadId,
        );
        return requests.every(({ eventId }) => {
          return messages.events.some((event) => {
            return event.id === eventId;
          });
        });
      })
      .toBe(true);
    await expect.poll(admissionLock.waiterCount).toBe(2);

    admissionLock.release();
    const responses = await Promise.all(
      requests.map(({ response }) => {
        return response;
      }),
    );
    await admissionLock.done;

    const winners = responses.flatMap((response, index) => {
      if (response.status !== 201 || response.body.runId === null) {
        return [];
      }
      return [
        {
          eventId: requests[index]!.eventId,
          runId: response.body.runId,
        },
      ];
    });
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner) {
      throw new Error("Expected one competing send to create a run");
    }
    const loser = requests.find(({ eventId }) => {
      return eventId !== winner.eventId;
    });
    if (!loser) {
      throw new Error("Expected one competing send to lose admission");
    }
    expect(
      responses.filter((response) => {
        return response.status === 201 && response.body.runId === null;
      }),
    ).toHaveLength(1);

    const messages = await chat.listThreadEvents(actor, established.threadId);
    expect(
      userMessages(messages.events).filter((message) => {
        return (
          message.revokesEventId === winner.eventId &&
          message.runId === winner.runId
        );
      }),
    ).toHaveLength(1);
    expect(
      userMessages(messages.events).filter((message) => {
        return (
          message.revokesEventId === loser.eventId &&
          message.runId !== undefined
        );
      }),
    ).toHaveLength(0);
    const queuedLoser = userMessages(messages.events).find((message) => {
      return message.id === loser.eventId;
    });
    if (!queuedLoser) {
      throw new Error("Expected the losing message to remain queued");
    }
    expect(queuedLoser.runId).toBeUndefined();
    expect(chatEventDisplayText(queuedLoser)).toBe(loser.prompt);
    await expect(
      readThreadSessionBinding(context, established.threadId),
    ).resolves.toMatchObject({
      agent_session_run_id: winner.runId,
    });

    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: established.threadId,
        revokesEventId: loser.eventId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    await cancelChatRun(actor, winner.runId);
  }, 90_000);

  it("retries preparation when the canonical binding changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for binding validation");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the binding snapshot",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the first run to establish a session");
    }

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });
    const messageId = randomUUID();
    const secondPromise = sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after the binding changes",
      clientEventId: messageId,
    });
    // The queue-first insert must complete before a fixture owns the parent
    // thread row; otherwise its FK check would block before session resolution.
    await expect
      .poll(async () => {
        const messages = await chat.listThreadEvents(actor, first.threadId);
        return messages.events.some((message) => {
          return message.id === messageId;
        });
      })
      .toBe(true);

    const bindingClear = await holdThreadSessionBindingClearFixture({
      threadId: first.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      bindingClear.release();
      await bindingClear.done;
    });
    admissionLock.release();
    await admissionLock.done;
    // Unlike the shared org advisory key, this row lock can only be reached
    // after the target preparation has captured its binding snapshot.
    await expect
      .poll(bindingClear.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);
    bindingClear.release();
    await bindingClear.done;
    const second = await secondPromise;

    const secondBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(secondBinding).toMatchObject({
      agent_session_id: expect.any(String),
      agent_session_run_id: second.runId,
      run_session_id: secondBinding.agent_session_id,
    });
    expect(secondBinding.agent_session_id).not.toBe(
      firstBinding.agent_session_id,
    );
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    await expect(
      readRunLaunchSnapshotFixture(context, second.runId),
    ).resolves.toStrictEqual({
      exists: true,
      launch_snapshot: {
        schemaVersion: 3,
        framework: secondClaim.claim.cliAgentType,
        runnerProfile: DEFAULT_PROFILE,
      },
    });
    expect(secondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("replays only each prior run's final answer when a model family rotates the session", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId: codexProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "prior-round-trim-openai-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-terra",
        isDefault: false,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: codexProviderId,
      },
    ]);

    const firstPrompt = "plan the migration in several steps";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "narration: reading the first file"),
      assistantEvent(1, "narration: reading the second file"),
      assistantEvent(2, "final answer with the migration plan"),
    ]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 2,
    });
    await flushWaitUntilForTest();
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "final answer with the migration plan";
      });
    });

    // Switching model family rotates the CLI session, so the prior round is
    // replayed. An agentic run emits one chat message per step; only its final
    // answer carries information the next run needs.
    await chat.updateThreadModelSelection(
      actor,
      first.threadId,
      "gpt-5.6-terra",
    );
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue after the family switch",
    });
    const appended = (await api.readRun(actor, second.runId))
      .appendSystemPrompt;
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${first.runId}`);
    expect(appended).toContain(
      `- AGENT_SESSION_COMMAND: okou search "${first.runId}" --source agent-session`,
    );
    expect(appended).toContain("Use the AGENT_SESSION_COMMAND for a run");
    expect(appended).not.toContain("LOG_COMMAND");
    expect(appended).toContain(`User: ${firstPrompt}`);
    expect(appended).toContain(
      "Assistant: final answer with the migration plan",
    );
    expect(appended).not.toContain("narration: reading the first file");
    expect(appended).not.toContain("narration: reading the second file");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("rotates a canonical thread after an oversized history is discarded", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const firstPrompt = "finish work before native history becomes oversized";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    const firstAnswer = "completed work preserved outside native history";
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, firstAnswer)]);
    const outputEvents = chatCallbacks.consumeMockChatOutputEvents();
    await webhooks.requestAgentEvents(
      { runId: first.runId, events: outputEvents },
      firstClaim.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: first.runId,
        exitCode: 0,
        lastEventSequence: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `discarded-cli-${first.runId}`,
          cliAgentSessionHistoryDisposition: "discarded_oversized",
        },
      },
      firstClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    await waitForRunStatus(actor, first.runId, "completed");

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue in a fresh native session",
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(firstPrompt);
    expect(appended).toContain(firstAnswer);

    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, second.runId, secondClaim.sandboxHeaders);
  }, 90_000);

  it("retries preparation when the canonical conversation snapshot changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the checkpoint snapshot",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the first run to establish a session");
    }

    const conversationClear = await holdThreadSessionConversationClearFixture({
      threadId: first.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      conversationClear.release();
      await conversationClear.done;
    });
    const secondPromise = sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after the checkpoint changes",
    });
    // The staged clear is still uncommitted, so the run resolves the pre-clear
    // snapshot and only blocks once its commit re-reads the session row.
    await expect
      .poll(conversationClear.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);

    conversationClear.release();
    await conversationClear.done;
    const second = await secondPromise;

    const secondBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(secondBinding).toMatchObject({
      agent_session_id: expect.any(String),
      agent_session_run_id: second.runId,
      run_session_id: secondBinding.agent_session_id,
    });
    expect(secondBinding.agent_session_id).not.toBe(
      firstBinding.agent_session_id,
    );
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("fails after every canonical session preparation snapshot changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the snapshot before retry exhaustion",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the first run to establish a session");
    }

    const preparationAttempts = 3;
    const conversationChanges =
      await holdThreadSessionConversationChangesFixture({
        threadId: first.threadId,
        changeCount: preparationAttempts,
        signal: context.signal,
      });
    onTestFinished(async () => {
      conversationChanges.releaseAll();
      await conversationChanges.done;
    });
    const retryPrompt = "exhaust every session preparation attempt";
    const failedPromise = requestSendEventRaw(actor, {
      agentId,
      threadId: first.threadId,
      clientEventId: randomUUID(),
      prompt: retryPrompt,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: retryPrompt }],
      },
      hasTextContent: true,
    });

    const intermediateAttempts = preparationAttempts - 1;
    for (let attempt = 0; attempt < intermediateAttempts; attempt += 1) {
      await expect
        .poll(conversationChanges.blockedWaiterCount)
        .toBeGreaterThanOrEqual(1);
      conversationChanges.queueNextChange();
      await expect.poll(conversationChanges.queuedChangeIsBlocked).toBe(true);
      conversationChanges.release();
      await expect
        .poll(conversationChanges.stagedChangeCount)
        .toBe(attempt + 2);
    }
    await expect
      .poll(conversationChanges.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);
    conversationChanges.release();
    await conversationChanges.done;
    const failed = await failedPromise;
    expect(failed).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });

    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toStrictEqual(firstBinding);
  }, 90_000);

  it("re-resolves a sticky model through the current provider policy", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "pin sonnet model-first",
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    const originalBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the original route to bind a session");
    }
    const pinned = await chat.readThread(actor, first.threadId);
    expect(pinned).not.toHaveProperty("selectedModel");
    expect(pinned).not.toHaveProperty("modelProviderId");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "rerouted-claude-oauth-token",
      },
      [200, 201],
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after the provider policy reroute",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    const environment = claimEnvironment(secondClaim.claim);
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "claude-code-oauth-token",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ),
    );
    expect(environment.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    const after = await chat.readThread(actor, first.threadId);
    expect(after).not.toHaveProperty("selectedModel");
    expect(after).not.toHaveProperty("modelProviderId");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);

    const { providerId: openRouterProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openrouter-api-key",
        secret: "rerouted-openrouter-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: openRouterProviderId,
      },
    ]);

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after the upstream provider changes",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(claimEnvironment(thirdClaim.claim).ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "openrouter-api-key",
        "OPENROUTER_API_KEY",
      ),
    );
    expect(thirdClaim.claim.cliAgentType).toBe("claude-code");
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    await completeChatRunOk(third.runId, thirdClaim.sandboxHeaders);
    const reusedBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(reusedBinding.agent_session_id).toBe(
      originalBinding.agent_session_id,
    );
    expect(reusedBinding).toMatchObject({
      agent_session_run_id: third.runId,
      run_session_id: reusedBinding.agent_session_id,
    });
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );

    const fourth = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on the same canonical session",
    });
    const fourthBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(fourthBinding).toMatchObject({
      agent_session_id: reusedBinding.agent_session_id,
      agent_session_run_id: fourth.runId,
      run_session_id: reusedBinding.agent_session_id,
    });
    const fourthClaim = await claimChatRun(runnerGroup, fourth.runId);
    expect(fourthClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${third.runId}`,
    );
    await cancelChatRun(actor, fourth.runId);
  }, 90_000);

  it("rejects invalid model selections without creating visible state", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Invalid model selection agent",
    });

    // Chat send only accepts supported run models.
    const invalidModelThreadId = randomUUID();
    const invalidModel = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unsupported model",
        clientThreadId: invalidModelThreadId,
        model: "codex" as never,
      },
      [400],
    );
    expectApiError(invalidModel.body);
    expect(invalidModel.body.error.message).toBe("Invalid input");
    await chat.requestReadThread(actor, invalidModelThreadId, [404]);

    const unavailableThreadId = randomUUID();
    const unavailable = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a supported model outside workspace policy",
        clientThreadId: unavailableThreadId,
        model: "gpt-5.6-terra",
      },
      [400],
    );
    expectApiError(unavailable.body);
    expect(unavailable.body.error.message).toBe(
      "The selected model is not available in this workspace",
    );
    await chat.requestReadThread(actor, unavailableThreadId, [404]);

    // Removed sentinel models fail contract validation.
    for (const selectedModel of [
      "claude-haiku-4-5",
      "anthropic/claude-haiku-4.5",
    ]) {
      const removedThreadId = randomUUID();
      const removed = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: `removed ${selectedModel}`,
          clientThreadId: removedThreadId,
          model: selectedModel as never,
        },
        [400],
      );
      expectApiError(removed.body);
      expect(removed.body.error).toMatchObject({
        code: "BAD_REQUEST",
        message: "Invalid input",
      });
      await chat.requestReadThread(actor, removedThreadId, [404]);
    }

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    expect(events.status).toBe(200);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
  }, 60_000);
});

describe("CHAT-02: incomplete-round context", () => {
  it("injects incomplete rounds and truncates old content chronologically", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "establish native session history",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);

    const first = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "first incomplete",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await failChatRun(first.runId, firstClaim.sandboxHeaders, "boom one");
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the failed run to retain its session binding");
    }

    const longPrompt = `second ${"x".repeat(4100)}`;
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: longPrompt,
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    await failChatRun(second.runId, secondClaim.sandboxHeaders, "boom two");
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: second.runId,
      run_session_id: firstBinding.agent_session_id,
    });

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after two failures",
    });
    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toMatchObject({
      agent_session_id: firstBinding.agent_session_id,
      agent_session_run_id: third.runId,
      run_session_id: firstBinding.agent_session_id,
    });
    const thirdRun = await api.readRun(actor, third.runId);
    const appended = thirdRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended.split("RUN_STATUS: failed")).toHaveLength(3);
    expect(appended).toContain("User: first incomplete");
    expect(appended.indexOf("User: first incomplete")).toBeLessThan(
      appended.indexOf("User: second"),
    );
    expect(appended).toContain("...[truncated]");
    expect(appended).not.toContain("retry after two failures");
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${anchor.runId}`,
    );
    await cancelChatRun(actor, third.runId);
  }, 90_000);
});

describe("CHAT-02: initial thinking indicator", () => {
  // Provider text is untrusted and must never reach the thread.
  const privateProviderDetail = "private_prompt_history_authorization_canary";

  it.each([
    { enabled: false, existingThread: false },
    { enabled: true, existingThread: false },
    { enabled: false, existingThread: true },
    { enabled: true, existingThread: true },
  ])(
    "hands opening copy to visible demand only when enabled=$enabled (existing thread=$existingThread)",
    async ({ enabled, existingThread }) => {
      const { actor, agentId } = await entitledChatActor();
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        { [FeatureSwitchKey.ThreadActivitySummary]: enabled },
      );
      const thread = existingThread
        ? await chat.createThread(actor, { agentId })
        : null;
      mockOptionalEnv("OPENROUTER_API_KEY", "thinking-handover-key");
      const indicatorCalls: string[] = [];
      let titleCalls = 0;
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/chat/completions",
          async ({ request }) => {
            const payload = openRouterBodySchema.parse(await request.json());
            const system = payload.messages[0]?.content ?? "";
            const isInitial = system.includes(
              "Write user-visible progress copy",
            );
            const isSummary = system.includes("Write three short");
            if (isInitial || isSummary) {
              indicatorCalls.push(isInitial ? "initial" : "summary");
            } else if (system.includes("Generate a short, descriptive title")) {
              titleCalls++;
            }
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: isInitial
                      ? "Preparing the original checklist"
                      : isSummary
                        ? "Preparing the visible checklist"
                        : "Launch Checklist",
                  },
                },
              ],
            });
          },
        ),
      );
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Prepare the launch checklist",
        ...(thread ? { threadId: thread.id } : {}),
      });
      await flushWaitUntilForTest();
      const beforeDemand = await chat.listThreadEvents(actor, run.threadId);
      const initial = beforeDemand.events.filter((event) => {
        return event.runEventId === "thinking:initial";
      });
      expect(indicatorCalls).toStrictEqual(enabled ? [] : ["initial"]);
      expect(initial).toHaveLength(enabled ? 0 : 1);
      if (!enabled) {
        expect(initial[0]).toMatchObject({
          eventType: "output.thinking",
          thinking: "Preparing the original checklist",
          runId: run.runId,
        });
      }
      expect(titleCalls).toBeGreaterThan(0);
      expect((await api.readRun(actor, run.runId)).status).toBe("pending");

      const requested = await accept(
        setupApp({ context, routes: chatThreadActivitySummaryRoutes })(
          chatThreadActivitySummaryContract,
        ).summarize({
          headers: sessionHeaders(actor),
          params: { id: run.threadId },
          body: { runId: run.runId },
        }),
        [200, 403],
      );
      if (enabled) {
        expect(requested.status).toBe(200);
        expect(requested.body).toMatchObject({
          messages: [
            {
              id: "Preparing the visible checklist",
              text: "Preparing the visible checklist",
            },
          ],
          status: "available",
          runId: run.runId,
        });
        expect(indicatorCalls).toStrictEqual(["summary"]);
      } else {
        expect(requested.status).toBe(403);
        expect(indicatorCalls).toStrictEqual(["initial"]);
      }
      const afterDemand = await chat.listThreadEvents(actor, run.threadId);
      expect(afterDemand.events).toStrictEqual(beforeDemand.events);
      await cancelChatRun(actor, run.runId);
    },
  );

  const providerDetail = "private-provider-detail";

  // One shape per externally distinguishable outcome. Which gateway code or
  // transport fault the provider classification separates further reaches the
  // thread identically, so those are not enumerated again.
  it.each([
    {
      name: "a provider rate limit",
      thinkingResponse: () => {
        return new HttpResponse(providerDetail, { status: 429 });
      },
    },
    {
      name: "a rejected request",
      thinkingResponse: () => {
        return new HttpResponse(providerDetail, { status: 400 });
      },
    },
    {
      name: "broken credentials",
      thinkingResponse: () => {
        return new HttpResponse(providerDetail, { status: 401 });
      },
    },
    // Shortened copy is unusable for this caller, so the marker stays absent.
    {
      name: "an exhausted token budget",
      thinkingResponse: () => {
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "length",
              native_finish_reason: "MAX_TOKENS",
              message: { content: providerDetail },
            },
          ],
        });
      },
    },
    {
      // Non-empty for the provider, yet nothing survives sanitization.
      name: "output that sanitizes to nothing",
      thinkingResponse: () => {
        return HttpResponse.json({
          choices: [{ finish_reason: "stop", message: { content: '"""' } }],
        });
      },
    },
  ])("omits opening copy after $name", async ({ thinkingResponse }) => {
    const { actor, agentId } = await entitledChatActor();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-classification-key");
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const system = payload.messages[0]?.content ?? "";
          return system.includes("Write user-visible progress copy")
            ? thinkingResponse()
            : HttpResponse.json({
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: "Launch Checklist" },
                  },
                ],
              });
        },
      ),
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Prepare the launch checklist",
    });
    await flushWaitUntilForTest();

    // The optional generation is isolated: no marker, the run proceeds, and
    // nothing the provider sent reaches the thread.
    const events = await chat.listThreadEvents(actor, run.threadId);
    expect(
      events.events.filter((event) => {
        return event.runEventId === "thinking:initial";
      }),
    ).toStrictEqual([]);
    expect(JSON.stringify(events.events)).not.toContain(providerDetail);
    expect((await api.readRun(actor, run.runId)).status).toBe("pending");
    await cancelChatRun(actor, run.runId);
  });

  it("persists a fast assistant thinking marker with paragraphs for active web chat runs", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");

    let thinkingAuthorization: string | null = null;
    let thinkingPromptPayload = "";
    let thinkingRequestBody: z.infer<typeof openRouterBodySchema> | undefined;
    const titleResponse = "Launch Checklist";
    const thinkingResponse =
      "Reviewing the launch request and recent context.\nIdentifying the checklist's major sections.\nChecking where owners and timing matter.\nPreparing a clear order for the response.";
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const contractError = openRouterModelContractError(payload);
          if (contractError) {
            return contractError;
          }
          const systemContent = payload.messages[0]?.content ?? "";
          let responseContent = "Unrelated completion";
          if (systemContent.includes("Generate a short, descriptive title")) {
            responseContent = titleResponse;
          }
          if (systemContent.includes("Write user-visible progress copy")) {
            thinkingAuthorization = request.headers.get("authorization");
            thinkingRequestBody = payload;
            thinkingPromptPayload = payload.messages
              .map((message) => {
                return message.content;
              })
              .join("\n\n");
            responseContent = thinkingResponse;
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: responseContent },
              },
            ],
          });
        },
      ),
    );

    const clientEventId = randomUUID();
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Draft a launch checklist",
      clientEventId,
    });

    const page = await waitForThreadMessages(actor, run.threadId, (items) => {
      return assistantMessages(items).some((message) => {
        return (
          message.eventType === "output.thinking" &&
          message.runId === run.runId &&
          message.content === null &&
          message.thinking === thinkingResponse
        );
      });
    });
    await waitForThreadTitle(actor, run.threadId, titleResponse);
    const marker = assistantMessages(page.events).find((message) => {
      return (
        message.eventType === "output.thinking" &&
        message.runId === run.runId &&
        message.thinking === thinkingResponse
      );
    });
    expect(marker).toMatchObject({
      eventType: "output.thinking",
      content: null,
      runId: run.runId,
      runEventId: "thinking:initial",
      thinking: thinkingResponse,
    });
    expect(thinkingAuthorization).toBe("Bearer thinking-key");
    expect(thinkingRequestBody).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 1024,
      reasoning: { effort: "low" },
    });
    expect(thinkingPromptPayload).toContain("one paragraph at a time");
    expect(thinkingPromptPayload).toContain(
      "about 30 characters, excluding punctuation",
    );
    expect(thinkingPromptPayload).toContain("around four short paragraphs");
    expect(thinkingPromptPayload).toContain("Do not answer the user");
    expect(thinkingPromptPayload).toContain("Do not reveal hidden reasoning");
    expect(thinkingPromptPayload).toContain(
      "Match the current user's language",
    );
    expect(thinkingPromptPayload).toContain("Draft a launch checklist");
    await flushWaitUntilForTest();

    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "Draft a launch checklist",
        clientEventId,
      },
      [201],
    );
    await flushWaitUntilForTest();
    const replayed = await chat.listThreadEvents(actor, run.threadId);
    expect(
      replayed.events.filter((event) => {
        return event.runEventId === "thinking:initial";
      }),
    ).toStrictEqual([marker]);

    await cancelChatRun(actor, run.runId);
  });

  it("discards token-limited progress copy instead of persisting a truncated marker", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");

    let thinkingRequests = 0;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          if (systemContent.includes("Write user-visible progress copy")) {
            thinkingRequests += 1;
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "length",
                  native_finish_reason: "MAX_TOKENS",
                  message: {
                    content: "Incomplete progress copy that must not persist",
                  },
                },
              ],
            });
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Token Limit Title" },
              },
            ],
          });
        },
      ),
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Draft a concise migration update",
    });
    await flushWaitUntilForTest();

    const page = await chat.listThreadEvents(actor, run.threadId);
    expect(thinkingRequests).toBe(1);
    expect(
      assistantMessages(page.events).some((message) => {
        return (
          message.runId === run.runId &&
          message.runEventId === "thinking:initial"
        );
      }),
    ).toBeFalsy();

    await cancelChatRun(actor, run.runId);
  });

  it("caps complete progress copy at 600 characters while preserving paragraph sanitization", async () => {
    const { actor, agentId } = await entitledChatActor();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
    chatCallbacks.mockOpenRouterCompletions((body) => {
      return body.messages[0]?.content.includes(
        "Write user-visible progress copy",
      )
        ? `"  Preparing\t the update.\r\n\r\n\r\n${"界".repeat(700)}"`
        : "Update";
    });
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Prepare an update",
    });
    await flushWaitUntilForTest();
    const page = await chat.listThreadEvents(actor, run.threadId);
    const marker = page.events.find((event) => {
      return event.runEventId === "thinking:initial";
    });
    expect(marker).toMatchObject({
      thinking: `Preparing the update.\n\n${"界".repeat(577)}`,
    });
    await cancelChatRun(actor, run.runId);
  });

  it("does not request opening copy while a run waits for org capacity", async () => {
    const { actor, agentId } = await entitledChatActor();
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "Occupy capacity",
    });
    await flushWaitUntilForTest();
    mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
    let thinkingRequests = 0;
    chatCallbacks.mockOpenRouterCompletions((body) => {
      if (
        body.messages[0]?.content.includes("Write user-visible progress copy")
      ) {
        thinkingRequests += 1;
      }
      return "Update";
    });
    const queued = await sendChatRun(actor, {
      agentId,
      prompt: "Prepare a later update",
    });
    await flushWaitUntilForTest();
    const [queuedRun, page] = await Promise.all([
      api.readRun(actor, queued.runId),
      chat.listThreadEvents(actor, queued.threadId),
    ]);
    expect(queuedRun.status).toBe("queued");
    expect(page.events).toContainEqual(
      expect.objectContaining({ runEventId: "queue:queued" }),
    );
    expect(
      page.events.some((event) => {
        return event.runEventId === "thinking:initial";
      }),
    ).toBeFalsy();
    expect(thinkingRequests).toBe(0);
    await cancelChatRun(actor, queued.runId);
    await cancelChatRun(actor, blocker.runId);
  });

  it.each([400, 429, 503])(
    "keeps the main run usable after an auxiliary HTTP %i",
    async (status) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/chat/completions",
          async ({ request }) => {
            const body = openRouterBodySchema.parse(await request.json());
            if (
              body.messages[0]?.content.includes(
                "Write user-visible progress copy",
              )
            ) {
              return HttpResponse.json({ error: { code: status } }, { status });
            }
            return HttpResponse.json({
              choices: [
                { finish_reason: "stop", message: { content: "Update" } },
              ],
            });
          },
        ),
      );
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Prepare an update",
      });
      await flushWaitUntilForTest();
      const claim = await claimChatRun(runnerGroup, run.runId);
      chatCallbacks.mockChatOutputEvents([
        assistantEvent(0, "The main response is ready."),
      ]);
      await completeChatRunOk(run.runId, claim.sandboxHeaders);
      await flushWaitUntilForTest();
      expect((await api.readRun(actor, run.runId)).status).toBe("completed");
      const page = await chat.listThreadEvents(actor, run.threadId);
      expect(page.events).toContainEqual(
        expect.objectContaining({ content: "The main response is ready." }),
      );
      expect(
        page.events.some((event) => {
          return event.runEventId === "thinking:initial";
        }),
      ).toBeFalsy();
    },
  );

  it.each([
    {
      name: "empty",
      responseBody: {
        choices: [{ finish_reason: "stop", message: { content: "  " } }],
      },
    },
    {
      name: "non-text",
      responseBody: {
        choices: [{ finish_reason: "stop", message: { content: null } }],
      },
    },
    {
      name: "unknown finish reason",
      responseBody: {
        choices: [
          {
            finish_reason: privateProviderDetail,
            native_finish_reason: privateProviderDetail,
            message: { content: "Incomplete" },
          },
        ],
      },
    },
    {
      name: "malformed JSON",
      responseBody: `${privateProviderDetail}: invalid JSON`,
    },
  ])(
    "discards $name output without failing the run or leaking provider data",
    async ({ responseBody }) => {
      const { actor, agentId } = await entitledChatActor();
      mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
      server.use(
        http.post(
          "https://openrouter.ai/api/v1/chat/completions",
          async ({ request }) => {
            const body = openRouterBodySchema.parse(await request.json());
            if (
              body.messages[0]?.content.includes(
                "Write user-visible progress copy",
              )
            ) {
              return typeof responseBody === "string"
                ? HttpResponse.text(responseBody)
                : HttpResponse.json(responseBody);
            }
            return HttpResponse.json({
              choices: [
                { finish_reason: "stop", message: { content: "Update" } },
              ],
            });
          },
        ),
      );
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Prepare an update",
      });
      await flushWaitUntilForTest();
      expect((await api.readRun(actor, run.runId)).status).toBe("pending");
      const page = await chat.listThreadEvents(actor, run.threadId);
      expect(
        page.events.some((event) => {
          return event.runEventId === "thinking:initial";
        }),
      ).toBeFalsy();
      expect(JSON.stringify(page.events)).not.toContain(privateProviderDetail);
      await cancelChatRun(actor, run.runId);
    },
  );

  it.each(["answer", "completed", "cancelled"] as const)(
    "suppresses late progress copy after %s while the provider remains pending",
    async (outcome) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockOptionalEnv("OPENROUTER_API_KEY", "thinking-key");
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      chatCallbacks.mockOpenRouterCompletions(async (body) => {
        if (
          body.messages[0]?.content.includes("Write user-visible progress copy")
        ) {
          entered.resolve();
          await release.promise;
          return "This progress copy arrived too late.";
        }
        return "Update";
      });
      // The send and main-run lifecycle must proceed before auxiliary generation resolves.
      const run = await sendChatRun(actor, {
        agentId,
        prompt: "Prepare an update",
      });
      await entered.promise;
      const claim = await claimChatRun(runnerGroup, run.runId);
      if (outcome === "answer") {
        chatCallbacks.mockChatOutputEvents([assistantEvent(0, "Main answer")]);
        await webhooks.requestAgentEvents(
          {
            runId: run.runId,
            events: chatCallbacks.consumeMockChatOutputEvents(),
          },
          claim.sandboxHeaders,
          [200],
        );
      } else if (outcome === "completed") {
        await completeChatRunOk(run.runId, claim.sandboxHeaders);
      } else {
        await api.requestCancelRun(actor, run.runId, [200]);
      }
      release.resolve();
      await flushWaitUntilForTest();
      const page = await chat.listThreadEvents(actor, run.threadId);
      expect(
        page.events.some((event) => {
          return event.runEventId === "thinking:initial";
        }),
      ).toBeFalsy();
      expect((await api.readRun(actor, run.runId)).status).toBe(
        outcome === "answer" ? "running" : outcome,
      );
      if (outcome === "answer") {
        await cancelChatRun(actor, run.runId, claim.sandboxHeaders);
      }
    },
  );
});

describe("CHAT-02: prior rounds and thread titles", () => {
  it("leaves prior completed rounds to the session, generates the thread title, and accepts immutable follow-up revokes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "title-key");
    let upstreamAuthorization: string | null = null;
    let titleRequests = 0;
    let titleRequestBody: z.infer<typeof openRouterBodySchema> | undefined;
    let followupRequestBody: z.infer<typeof openRouterBodySchema> | undefined;
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          upstreamAuthorization = request.headers.get("authorization");
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          if (systemContent.includes("recommended follow-up messages")) {
            followupRequestBody = payload;
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    content: JSON.stringify([
                      { prompt: "Summarize the migration steps", kind: "talk" },
                    ]),
                  },
                },
              ],
            });
          }
          if (systemContent.includes("Generate a short, descriptive title")) {
            titleRequests += 1;
            titleRequestBody = payload;
            return HttpResponse.json({
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: "**Migration Plan**" },
                },
              ],
            });
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "Generated summary" },
              },
            ],
          });
        },
      ),
    );

    const firstPrompt = "plan the API migration";
    const first = await sendChatRun(actor, { agentId, prompt: firstPrompt });
    await waitForThreadTitle(actor, first.threadId, "Migration Plan");
    expect(titleRequests).toBe(1);
    expect(upstreamAuthorization).toBe("Bearer title-key");
    expect(titleRequestBody).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 2048,
      reasoning: { effort: "low" },
    });

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "Assistant migration answer"),
    ]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });

    const afterFirst = await waitForThreadMessages(
      actor,
      first.threadId,
      (items) => {
        return recommendedFollowupEvents(items, first.runId).some((message) => {
          return resolveChatEventRecommendedFollowups(message).length > 0;
        });
      },
    );
    const recommender = recommendedFollowupEvents(
      afterFirst.events,
      first.runId,
    ).find((message) => {
      return resolveChatEventRecommendedFollowups(message).length > 0;
    });
    if (!recommender) {
      throw new Error("Expected a recommended follow-ups message");
    }
    expect(recommender.eventType).toBe("output.followups");
    expect(followupRequestBody).toMatchObject({
      model: "google/gemini-3.8-flash",
      max_tokens: 2048,
      reasoning: { effort: "low" },
    });
    const futureFollowups = resolveChatEventRecommendedFollowups(recommender);
    expect(futureFollowups.length).toBeGreaterThan(0);
    const futureFollowupContent = recommender.content;
    expect(futureFollowupContent).not.toBeNull();

    const futureEvents = await chat.listThreadEvents(actor, first.threadId);
    expect(futureEvents.events).toContainEqual(
      expect.objectContaining({
        id: recommender.id,
        eventType: "output.followups",
        content: futureFollowupContent,
      }),
    );
    expect(
      futureEvents.events.find((event) => {
        return event.id === recommender.id;
      }),
    ).not.toHaveProperty("recommendedFollowups");

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow-up question",
    });
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Migration Plan");
    expect(titleRequests).toBe(1);
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    // The reused CLI session already holds the completed round, so the prompt
    // only points at the thread instead of replaying it.
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain("Assistant: Assistant migration answer");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    expect(appended).not.toContain(futureFollowupContent);
    for (const followup of futureFollowups) {
      expect(appended).not.toContain(followup.prompt);
    }

    await cancelChatRun(actor, second.runId);

    await chat.renameThread(actor, first.threadId, "Manual Migration Title");
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "manual title should stay",
    });
    await expect(
      readThreadTitleFromEvents(actor, first.threadId),
    ).resolves.toBe("Manual Migration Title");
    expect(titleRequests).toBe(1);
    await cancelChatRun(actor, third.runId);

    const recommendedFollowupQueueEventId = randomUUID();
    const normalFollowup = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "use the recommended follow-up",
        revokesEventId: recommender.id,
        clientEventId: recommendedFollowupQueueEventId,
      },
      [201],
    );
    if (normalFollowup.status !== 201) {
      throw new Error("Expected recommended follow-up send to succeed");
    }
    const normalFollowupRunId = normalFollowup.body.runId;
    if (normalFollowupRunId === null) {
      throw new Error("Expected recommended follow-up send to create a run");
    }
    const afterFollowup = await waitForThreadMessages(
      actor,
      first.threadId,
      (messages) => {
        return userMessages(messages).some((message) => {
          return (
            message.revokesEventId === recommendedFollowupQueueEventId &&
            message.runId === normalFollowupRunId
          );
        });
      },
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        id: recommendedFollowupQueueEventId,
        eventType: "input.prompt",
        revokesEventId: recommender.id,
      }),
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        revokesEventId: recommendedFollowupQueueEventId,
        runId: normalFollowupRunId,
      }),
    );
    await cancelChatRun(actor, normalFollowupRunId);
  }, 90_000);

  it("steers an active-run recommended follow-up", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    mockOptionalEnv("OPENROUTER_API_KEY", "followup-steer-key");
    server.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          const payload = openRouterBodySchema.parse(await request.json());
          const systemContent = payload.messages[0]?.content ?? "";
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: systemContent.includes(
                    "recommended follow-up messages",
                  )
                    ? JSON.stringify([
                        {
                          prompt: "Use the recommended follow-up",
                          kind: "talk",
                        },
                      ])
                    : "Follow-up steer",
                },
              },
            ],
          });
        },
      ),
    );

    const completed = await sendChatRun(actor, {
      agentId,
      prompt: "prepare a recommended follow-up",
    });
    const completedClaim = await claimChatRun(runnerGroup, completed.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "A completed answer with follow-ups"),
    ]);
    await completeChatRunOk(completed.runId, completedClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    const completedEvents = await waitForThreadMessages(
      actor,
      completed.threadId,
      (events) => {
        return recommendedFollowupEvents(events, completed.runId).some(
          (event) => {
            return resolveChatEventRecommendedFollowups(event).length > 0;
          },
        );
      },
    );
    const recommender = recommendedFollowupEvents(
      completedEvents.events,
      completed.runId,
    ).find((event) => {
      return resolveChatEventRecommendedFollowups(event).length > 0;
    });
    if (!recommender) {
      throw new Error("Expected a recommended follow-ups event");
    }

    const active = await sendChatRun(actor, {
      agentId,
      threadId: completed.threadId,
      prompt: "keep working while the follow-up is steered",
    });
    const activeClaim = await claimChatRun(runnerGroup, active.runId);
    const eventId = randomUUID();
    const followup = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: completed.threadId,
        prompt: "steer the recommended follow-up",
        revokesEventId: recommender.id,
        clientEventId: eventId,
      },
      [201],
    );
    if (followup.status !== 201) {
      throw new Error("Expected the recommended follow-up to succeed");
    }
    expect(followup.body.runId).toBeNull();
    const reservation = await api.reserveRunnerActiveInputs(
      activeClaim.claim.sandboxToken,
      active.runId,
    );
    if (reservation.outcome !== "reserved") {
      throw new Error("Expected the recommended follow-up to be reserved");
    }
    expect(reservation.eventIds).toStrictEqual([eventId]);
    expect(reservation.prompt).toBe("steer the recommended follow-up");
    await expect(
      api.recordRunnerActiveInputDelivery(
        activeClaim.claim.sandboxToken,
        active.runId,
        reservation.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });

    const afterFollowup = await waitForThreadMessages(
      actor,
      completed.threadId,
      (events) => {
        return userMessages(events).some((event) => {
          return (
            event.revokesEventId === eventId && event.runId === active.runId
          );
        });
      },
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        id: eventId,
        eventType: "input.prompt",
        revokesEventId: recommender.id,
      }),
    );
    expect(afterFollowup.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        revokesEventId: eventId,
        runId: active.runId,
      }),
    );
    await cancelChatRun(actor, active.runId);
  }, 90_000);
});

describe("CHAT-02: generation templates and attachments", () => {
  const introVideoTemplate: GenerationTemplateRequest = {
    type: "video",
    selection: {
      stylePresetId: "explainer-video",
      explainerOptions: {
        style: {
          kind: "catalog",
          style: {
            id: "minimalism",
            name: "Minimalism",
            tags: ["iconic-artist"],
            aspectRatio: "16:9",
          },
        },
        avatar: { kind: "none" },
        voice: { kind: "none" },
      },
    },
  };

  it("gates intro video template sends with the rollout override while preserving ordinary video", async () => {
    const { actor, agentId } = await entitledChatActor();
    const scopedActor = { ...actor, orgId: requireOrgId(actor) };
    await updateFeatureSwitchesForUser(context, scopedActor, {
      [FeatureSwitchKey.IntroVideo]: false,
    });
    const ordinary = VIDEO_TEMPLATE_ITEMS[0]!;
    const ordinaryTemplate: GenerationTemplateRequest = {
      type: "video",
      selection: { stylePresetId: ordinary.id },
    };
    for (const templates of [
      [introVideoTemplate],
      [ordinaryTemplate, introVideoTemplate],
    ]) {
      const rejected = await chat.requestSendEvent(
        actor,
        {
          agentId,
          prompt: "Explain the product",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Explain the product" },
              ...templates.map((template) => {
                return {
                  type: "template" as const,
                  titleSnapshot: "Selected video",
                  template,
                };
              }),
            ],
          },
        },
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error.message).toBe("Intro video is not available");
    }
    const events = await chat.requestThreadEvents(actor, {}, [200]);
    if (events.status !== 200) {
      throw new Error("Expected thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
    const video = await sendChatRun(actor, {
      agentId,
      prompt: "Make a creative scene",
      template: ordinaryTemplate,
    });
    expect(
      (await api.readRun(actor, video.runId)).appendSystemPrompt,
    ).toContain(ordinary.id);
    await cancelChatRun(actor, video.runId);

    await updateFeatureSwitchesForUser(context, scopedActor, {
      [FeatureSwitchKey.IntroVideo]: true,
    });

    const malformed = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "Explain it",
        userMessage: userMessageWithTemplate("Explain it", {
          type: "video",
          selection: { stylePresetId: "explainer-video" },
        }),
      },
      [400],
    );
    expectApiError(malformed.body);
    expect(malformed.body.error.message).toBe(
      "Intro video settings are missing",
    );
    const explained = await sendChatRun(actor, {
      agentId,
      prompt: "Explain the product",
      template: introVideoTemplate,
    });
    const prompt = (await api.readRun(actor, explained.runId))
      .appendSystemPrompt;
    expect(prompt).toContain("Use the $intro-video skill");
    expect(prompt).toContain("- HeyGen style: Minimalism (minimalism)");
    expect(prompt).toContain("- HeyGen style preview aspect ratio: 16:9");
    expect(prompt).toContain("- Avatar: No avatar");
    expect(prompt).toContain("- Voice: No voiceover");
    await cancelChatRun(actor, explained.runId);
  }, 90_000);

  it.each(["queued dispatch", "active input"] as const)(
    "rechecks intro video access before %s",
    async (delivery) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const scopedActor = { ...actor, orgId: requireOrgId(actor) };
      await updateFeatureSwitchesForUser(context, scopedActor, {
        [FeatureSwitchKey.IntroVideo]: true,
      });
      const active = await sendChatRun(actor, {
        agentId,
        prompt: "Start the conversation",
      });
      const claimed = await claimChatRun(runnerGroup, active.runId);
      const eventId = randomUUID();
      await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: active.threadId,
          clientEventId: eventId,
          prompt: "Explain the product",
          userMessage: userMessageWithTemplate(
            "Explain the product",
            introVideoTemplate,
          ),
        },
        [201],
      );
      await updateFeatureSwitchesForUser(context, scopedActor, {
        [FeatureSwitchKey.IntroVideo]: false,
      });
      context.mocks.axiom.ingest.mockClear();
      if (delivery === "active input") {
        const reserved = await api.reserveRunnerActiveInputs(
          claimed.claim.sandboxToken,
          active.runId,
        );
        if (reserved.outcome !== "reserved") {
          throw new Error("Expected the active input to be reserved");
        }
        expect(reserved.prompt).toContain("Explain the product");
        expect(reserved.prompt).not.toContain("Use the $intro-video skill");
        await cancelChatRun(actor, active.runId);
        return;
      }
      await completeChatRunOk(active.runId, claimed.sandboxHeaders);
      await flushWaitUntilForTest();
      const messages = await waitForThreadMessages(
        actor,
        active.threadId,
        (items) => {
          return userMessages(items).some((message) => {
            return (
              message.revokesEventId === eventId &&
              typeof message.runId === "string"
            );
          });
        },
      );
      const next = userMessages(messages.events).find((message) => {
        return (
          message.revokesEventId === eventId &&
          typeof message.runId === "string"
        );
      });
      if (!next?.runId) {
        throw new Error("Expected the queued input to dispatch");
      }
      const run = await api.readRun(actor, next.runId);
      expect(run.prompt).toContain("Explain the product");
      expect(run.appendSystemPrompt).not.toContain(
        "Use the $intro-video skill",
      );
      await cancelChatRun(actor, next.runId);
    },
    90_000,
  );

  it("uses the userMessage document for the runtime prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const fileId = randomUUID();
    const referencedThreadId = randomUUID();
    const mailDraftId = randomUUID();
    const feedbackPrompt =
      `Feedback on 2 parts of an email draft (mail draft ID: ${mailDraftId}):\n\n` +
      "> First quote\n\nClarify this point\n\n---\n\n" +
      `> Second quote\n\nAdd supporting evidence from [Roadmap](/chats/${referencedThreadId})`;
    const prompt =
      `Review [Roadmap](/chats/${referencedThreadId}) now\n\n` + feedbackPrompt;
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "template",
          titleSnapshot: style.title,
          template: generationTemplate,
        },
        {
          type: "file",
          fileId,
          filenameSnapshot: "brief.pdf",
          contentType: "application/pdf",
        },
        { type: "text", text: "Review " },
        {
          type: "chat_thread",
          threadId: referencedThreadId,
          titleSnapshot: "Roadmap",
        },
        { type: "text", text: " now" },
        {
          type: "feedback",
          quote: "First quote",
          note: [{ type: "text", text: "Clarify this point" }],
          eventId: "assistant-event-first-quote",
          range: { start: 0, end: 11 },
          source: {
            type: "mail",
            id: mailDraftId,
            status: "draft",
          },
        },
        {
          type: "feedback",
          quote: "Second quote",
          note: [
            { type: "text", text: "Add supporting evidence from " },
            {
              type: "chat_thread",
              threadId: referencedThreadId,
              titleSnapshot: "Roadmap",
            },
          ],
          source: {
            type: "mail",
            id: mailDraftId,
            status: "draft",
          },
        },
        {
          type: "source",
          kind: "slack",
          href: "https://vm0.slack.com/archives/C123/p456",
        },
      ],
    };
    chat.mockCompletedUploadObject(actor, fileId, "brief.pdf", 42);

    const sent = await sendChatRun(actor, {
      agentId,
      prompt,
      userMessage,
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      [
        `[Template #1: ${style.title} (illustration)]`,
        `[Web file] brief.pdf (application/pdf)\n   [ID] ${fileId}`,
        prompt,
      ].join("\n\n"),
    );
    expect(run.appendSystemPrompt).toContain("# Inline Templates");
    expect(run.appendSystemPrompt).toContain(style.illustrationStyleId);

    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    const message = userMessages(messages.events).find(
      (item): item is PromptMessage => {
        return item.eventType === "input.prompt" && item.runId === sent.runId;
      },
    );
    expect(message).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts,
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });

    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("projects referenced passages without requiring every feedback note", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "feedback",
          quote: "First quote",
          note: [{ type: "text", text: "Clarify the owner" }],
        },
        {
          type: "feedback",
          quote: "Second quote",
          note: [],
        },
      ],
    };
    const prompt =
      "The user referenced 2 parts of your reply:\n\n" +
      "> First quote\n\nClarify the owner\n\n---\n\n" +
      "> Second quote";

    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "legacy fallback",
      userMessage,
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(prompt);

    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    const message = userMessages(messages.events).find(
      (item): item is PromptMessage => {
        return item.eventType === "input.prompt" && item.runId === sent.runId;
      },
    );
    expect(message?.userMessage?.parts.slice(0, 2)).toStrictEqual(
      userMessage.parts,
    );

    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("projects multiple inline templates into one ordered prompt and one shared context", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    const workflow = WORKFLOW_TEMPLATE_ITEMS[0];
    if (!style || !workflow) {
      throw new Error("Expected registered inline templates");
    }
    const illustrationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const workflowTemplate: GenerationTemplateRequest = {
      type: "workflow",
      selection: { workflowTemplateId: workflow.id },
    };
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        { type: "text", text: "Use " },
        {
          type: "template",
          titleSnapshot: style.title,
          template: illustrationTemplate,
        },
        { type: "text", text: " for the dog, then " },
        {
          type: "template",
          titleSnapshot: workflow.title,
          template: workflowTemplate,
        },
        { type: "text", text: " for the follow-up" },
        {
          type: "feedback",
          quote: "Earlier answer",
          note: [
            { type: "text", text: "Restyle with " },
            {
              type: "template",
              titleSnapshot: style.title,
              template: illustrationTemplate,
            },
          ],
        },
      ],
    };

    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "legacy fallback",
      userMessage,
    });
    const run = await api.readRun(actor, sent.runId);
    const firstMarker = `[Template #1: ${style.title} (illustration)]`;
    const secondMarker = `[Template #2: ${workflow.title} (workflow)]`;
    const feedbackMarker = `[Template #3: ${style.title} (illustration)]`;
    expect(run.prompt).toContain(
      `Use ${firstMarker} for the dog, then ${secondMarker} for the follow-up`,
    );
    expect(run.prompt).toContain(`Restyle with ${feedbackMarker}`);
    expect(run.prompt.indexOf(firstMarker)).toBeLessThan(
      run.prompt.indexOf(secondMarker),
    );

    const systemPrompt = run.appendSystemPrompt ?? "";
    expect(systemPrompt.match(/^# Inline Templates$/gm)).toHaveLength(1);
    expect(systemPrompt).not.toContain("# Artifact Template Context");
    expect(systemPrompt).not.toContain("# Workflow Template Context");
    expect(systemPrompt).toContain("## Template #1 (illustration)");
    expect(systemPrompt).toContain("## Template #2 (workflow)");
    expect(systemPrompt).toContain("## Template #3 (illustration)");
    expect(systemPrompt).toContain(style.illustrationStyleId);
    expect(systemPrompt).toContain(workflow.id);

    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    const message = userMessages(messages.events).find(
      (item): item is PromptMessage => {
        return item.eventType === "input.prompt" && item.runId === sent.runId;
      },
    );
    expect(message).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts,
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it("preserves the attachment userMessage order in the runtime prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const fileId = randomUUID();
    chat.mockCompletedUploadObject(actor, fileId, "api-input.txt", 12);
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "plain API attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: "api-input.txt",
            contentType: "text/plain",
          },
          { type: "text", text: "plain API attachment" },
        ],
      },
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      [
        `[Web file] api-input.txt (text/plain)\n   [ID] ${fileId}`,
        "plain API attachment",
      ].join("\n\n"),
    );
    const messages = await waitForThreadMessages(
      actor,
      sent.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return message.runId === sent.runId;
        });
      },
    );
    expect(
      userMessages(messages.events).find((message) => {
        return message.runId === sent.runId;
      }),
    ).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: "api-input.txt",
            contentType: "text/plain",
          },
          { type: "text", text: "plain API attachment" },
          { type: "model", selectedModel: "claude-sonnet-5" },
        ],
      },
    });
    expect(
      chatEventDisplayText(
        userMessages(messages.events).find((message) => {
          return message.runId === sent.runId;
        })!,
      ),
    ).toBe("plain API attachment");
    await cancelChatRun(actor, sent.runId);
  }, 60_000);

  it("uses only the canonical template part", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const generationTemplate: GenerationTemplateRequest = {
      type: "illustration",
      selection: { illustrationStyleId: style.illustrationStyleId },
    };
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "draw a dog",
      template: generationTemplate,
    });

    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toBe(
      "draw a dog\n\n[Template #1: Illustration template (illustration)]",
    );
    const systemPrompt = run.appendSystemPrompt ?? "";
    expect(systemPrompt).toContain("# Inline Templates");
    expect(systemPrompt).toContain(style.illustrationStyleId);
    const messages = await chat.listThreadEvents(actor, sent.threadId);
    const message = userMessages(messages.events).find((event) => {
      return event.eventType === "input.prompt" && event.runId === sent.runId;
    });
    expect(message).toMatchObject({
      userMessage: {
        version: 1,
        parts: expect.arrayContaining([
          {
            type: "template",
            titleSnapshot: "Illustration template",
            template: generationTemplate,
          },
        ]),
      },
    });
    await cancelChatRun(actor, sent.runId);
  }, 90_000);

  it.each([
    "Create a presentation.\nNumber of slides: 10.",
    "Create a video.\nDuration: 6s.\nAudio: off.",
    "Create an image.\nAspect ratio: 1:1.",
  ])(
    "preserves client-authored additional info in the agent prompt: %s",
    async (additionalInfo) => {
      const { actor, agentId } = await entitledChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const prompt = "Our launch brief";
      const userMessage: UserMessageInputDocument = {
        version: 1,
        parts: [
          { type: "additional_info", text: additionalInfo },
          { type: "text", text: prompt },
        ],
      };
      const sent = await sendChatRun(actor, { agentId, prompt, userMessage });
      const run = await api.readRun(actor, sent.runId);
      expect(run.prompt).toBe(`${additionalInfo}\n\n${prompt}`);
      const messages = await chat.listThreadEvents(actor, sent.threadId);
      const message = userMessages(messages.events).find((event) => {
        return event.eventType === "input.prompt" && event.runId === sent.runId;
      });
      if (!message) {
        throw new Error("Expected the sent message to be persisted");
      }
      expect(message).toMatchObject({
        userMessage: { parts: expect.arrayContaining(userMessage.parts) },
      });
      expect(chatEventDisplayText(message)).toBe(prompt);
      await cancelChatRun(actor, sent.runId);
    },
    90_000,
  );

  it("renders generation template guidance into the run system prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }
    const colorSystemId = template.colorSystemId;
    if (!colorSystemId) {
      throw new Error(
        "Expected the presentation template to have a color system",
      );
    }

    const presentation = await sendChatRun(actor, {
      agentId,
      prompt: "make a launch deck",
      template: {
        type: "presentation",
        selection: {
          colorSystemId,
          templateId: template.templateId,
        },
      },
    });
    const presentationRun = await api.readRun(actor, presentation.runId);
    expect(presentationRun.prompt).toBe(
      "make a launch deck\n\n[Template #1: Presentation template (presentation)]",
    );
    const presentationPrompt = presentationRun.appendSystemPrompt ?? "";
    expect(presentationPrompt).toContain("# Inline Templates");
    expect(presentationPrompt).toContain(
      "Selected presentation template: Playful Launch Presentation (template:html-ppt-playful-launch)",
    );
    expect(presentationPrompt).not.toContain("Selected design system");
    expect(presentationPrompt).toContain(
      `okou resource pull ${template.templateId}-runbook --dir ./generated/resources`,
    );
    const colorToken = colorSystemId
      .replace("color-system:", "")
      .replaceAll("-", "_");
    expect(presentationPrompt).toContain(`Color system token: ${colorToken}`);
    expect(presentationPrompt).toContain(
      "./generated/resources/playful-launch/SKILL.md",
    );
    expect(presentationPrompt).toContain(
      "Keep all slides and visible content in index.html; render the first slide without JavaScript",
    );
    expect(presentationPrompt).toContain("--artifact-kind presentation-html");
    expect(presentationPrompt).not.toContain(
      "okou generate presentation --design-system",
    );
    expect(presentationPrompt).not.toContain("- Artifact type: presentation");
    await cancelChatRun(actor, presentation.runId);

    const videoTemplate = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.id === "video-template:epic-grandeur";
    });
    if (!videoTemplate) {
      throw new Error("Expected the epic-grandeur video template");
    }
    const video = await sendChatRun(actor, {
      agentId,
      prompt: "make a product video",
      template: {
        type: "video",
        selection: { stylePresetId: videoTemplate.id },
      },
    });
    const videoRun = await api.readRun(actor, video.runId);
    const videoPrompt = videoRun.appendSystemPrompt ?? "";
    expect(videoPrompt).toContain("# Inline Templates");
    expect(videoPrompt).toContain(
      `Template: ${videoTemplate.title} (${videoTemplate.id})`,
    );
    expect(videoPrompt).toContain(
      `okou generate video --provider built-in --template ${videoTemplate.id}`,
    );
    await cancelChatRun(actor, video.runId);

    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }

    // Run options are the composer's channel for video parameters now. They
    // ride one message, reach no table, and only enter the agent prompt when the
    // user moved a value off the effective model's default -- and they enter
    // it as defaults this run's message can override, not as instructions.
    const videoRunOptions = await sendChatRun(actor, {
      agentId,
      prompt: "make a clip from this brief",
      runOptions: {
        video: {
          aspectRatio: "9:16",
          duration: "6s",
          resolution: "480p",
          generateAudio: false,
        },
      },
    });
    const videoRunOptionsRun = await api.readRun(actor, videoRunOptions.runId);
    const videoRunOptionsPrompt = videoRunOptionsRun.prompt;
    expect(videoRunOptionsPrompt).toContain("# Video Generation Defaults");
    expect(videoRunOptionsPrompt).toContain("- Aspect ratio: 9:16");
    expect(videoRunOptionsPrompt).toContain("- Duration: 6s");
    expect(videoRunOptionsPrompt).toContain("- Resolution: 480p");
    expect(videoRunOptionsPrompt).toContain("- Audio: off");
    // Stated as defaults the message outranks, not as requirements: the chip
    // was set before the message was written, so "make it square" has to win.
    expect(videoRunOptionsPrompt).toContain(
      "the message wins, for that parameter only",
    );
    expect(videoRunOptionsPrompt).toMatch(/\n\nmake a clip from this brief$/);
    // Values only. A pre-assembled flag string is a ready-made answer that
    // stops being correct as soon as the message overrides one value.
    expect(videoRunOptionsPrompt).not.toContain("--aspect-ratio");
    expect(videoRunOptionsPrompt).not.toContain("--no-audio");
    expect(videoRunOptionsRun.appendSystemPrompt ?? "").not.toContain(
      "# Video Generation Defaults",
    );
    await cancelChatRun(actor, videoRunOptions.runId);

    // Most runs never generate a video, so a send that set nothing carries no
    // trace of the block at all.
    const withoutVideoRunOptions = await sendChatRun(actor, {
      agentId,
      prompt: "answer a plain question",
    });
    expect(
      (await api.readRun(actor, withoutVideoRunOptions.runId)).prompt,
    ).not.toContain("# Video Generation Defaults");
    await cancelChatRun(actor, withoutVideoRunOptions.runId);

    const avatarId = 81;
    const avatarVoiceId = "en-US-ChristopherNeural";
    const avatar = await sendChatRun(actor, {
      agentId,
      prompt: "make a presenter video",
      template: {
        type: "video",
        selection: {
          stylePresetId: avatarTemplateStylePresetId(avatarId),
          titleSnapshot: "Do not inject this avatar name",
          previewUrl: "https://example.com/untrusted-avatar.jpg",
          voiceId: avatarVoiceId,
          aspectRatio: "landscape",
        },
      },
    });
    const avatarRun = await api.readRun(actor, avatar.runId);
    const avatarPrompt = avatarRun.appendSystemPrompt ?? "";
    expect(avatarPrompt).toContain("# Inline Templates");
    expect(avatarPrompt).toContain(`Public JoggAI avatar ID: ${avatarId}`);
    expect(avatarPrompt).toContain(`Public JoggAI voice ID: ${avatarVoiceId}`);
    expect(avatarPrompt).toContain("Aspect ratio: landscape");
    expect(avatarPrompt).not.toContain("--list-voices");
    expect(avatarPrompt).toContain(
      `okou generate avatar-video --provider built-in --avatar-id ${avatarId} --voice-id ${avatarVoiceId} --aspect-ratio landscape`,
    );
    expect(avatarPrompt).not.toContain("Do not inject this avatar name");
    expect(avatarPrompt).not.toContain("untrusted-avatar.jpg");
    await cancelChatRun(actor, avatar.runId);

    const websiteTemplate = WEBSITE_TEMPLATE_ITEMS[0];
    if (!websiteTemplate) {
      throw new Error("Expected a registered website template");
    }
    const website = await sendChatRun(actor, {
      agentId,
      prompt: "make a campaign landing page",
      template: {
        type: "website",
        selection: { websiteTemplateId: websiteTemplate.id },
      },
    });
    const websiteRun = await api.readRun(actor, website.runId);
    const websitePrompt = websiteRun.appendSystemPrompt ?? "";
    expect(websitePrompt).toContain("# Inline Templates");
    expect(websitePrompt).toContain(
      `Template: ${websiteTemplate.title} (${websiteTemplate.id})`,
    );
    expect(websitePrompt).toContain(
      "okou resource pull template:black-slabs --dir ./generated/resources",
    );
    expect(websitePrompt).toContain(
      "Image workflow: use supplied images first;",
    );
    expect(websitePrompt).toMatch(
      /npx --yes --package="\$\{CLI_PKG_URL\}" okou generate image-batch start <manifest\.tsv> <state-dir>/,
    );
    expect(websitePrompt).toMatch(
      /npx --yes --package="\$\{CLI_PKG_URL\}" okou generate image-batch wait <state-dir>/,
    );
    expect(websitePrompt).not.toContain("tools/generate-images.mjs");
    expect(websitePrompt).not.toContain("resolve-images.mjs");
    expect(websitePrompt).not.toContain("render.mjs");
    await cancelChatRun(actor, website.runId);
  }, 90_000);

  it("uses R2 for archive-backed styles", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.illustrationStyleId === "image-style:ink-storefront";
    });
    if (!style) {
      throw new Error("Expected the ink-storefront illustration style");
    }

    const defaultR2Run = await sendChatRun(actor, {
      agentId,
      prompt: "draw a flower shop from the default R2 source",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const defaultR2Prompt =
      (await api.readRun(actor, defaultR2Run.runId)).appendSystemPrompt ?? "";
    expect(defaultR2Prompt).toContain(
      "Style source: private R2 registry resource image-style:ink-storefront",
    );
    expect(defaultR2Prompt).toContain("--compile --style-source r2");
    await cancelChatRun(actor, defaultR2Run.runId);
  }, 90_000);

  it("is one-shot: a follow-up without re-attaching the style gets no template context", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }

    // Turn 1: the user explicitly attaches the style — the live block is present.
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "draw a fox",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const firstPrompt = (await api.readRun(actor, first.runId))
      .appendSystemPrompt;
    expect(firstPrompt).toContain("# Inline Templates");
    expect(firstPrompt).toContain(
      `okou generate image --provider built-in --style ${style.illustrationStyleId} --prompt "<user request>" --compile`,
    );
    expect(firstPrompt).toContain("Follow the returned packet completely");
    expect(firstPrompt).toContain(
      "If the R2 source is unavailable, stop without generating; do not fall back to GitHub.",
    );
    expect(firstPrompt).toContain("--compiled-prompt");
    expect(firstPrompt).toContain(style.illustrationStyleId);

    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, "here is a fox")]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "here is a fox";
      });
    });

    // Turn 2: a follow-up without re-attaching the style gets no template
    // context.
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "another one",
    });
    const secondPrompt = (await api.readRun(actor, second.runId))
      .appendSystemPrompt;
    expect(secondPrompt).not.toContain("# Inline Templates");
    expect(secondPrompt).toContain("# This Chat Thread");
    expect(secondPrompt).not.toContain("Selected a template");
    expect(secondPrompt).not.toContain(style.illustrationStyleId);
    await waitForRunUserMessage(
      actor,
      first.threadId,
      second.runId,
      "another one",
    );
    await cancelChatRun(actor, second.runId);

    // Turn 3: attaching a video preset now only resolves the video template live
    // — templates no longer merge across turns or types.
    const videoTemplate = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.id === "video-template:epic-grandeur";
    });
    if (!videoTemplate) {
      throw new Error("Expected the epic-grandeur video template");
    }
    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "now make a video",
      template: {
        type: "video",
        selection: { stylePresetId: videoTemplate.id },
      },
    });
    const thirdPrompt = (await api.readRun(actor, third.runId))
      .appendSystemPrompt;
    expect(thirdPrompt).toContain(
      `Template: ${videoTemplate.title} (${videoTemplate.id})`,
    );
    expect(thirdPrompt).toContain(
      `okou generate video --provider built-in --template ${videoTemplate.id}`,
    );
    expect(thirdPrompt).toContain("# Incomplete Rounds Context");
    expect(thirdPrompt).not.toContain("# Web Chat Run Context");
    // The illustration style is gone entirely for this turn: it's not attached
    // to this message, and prior/incomplete context no longer repeats template
    // selections.
    expect(thirdPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, third.runId);

    // A brand-new thread starts clean: neither template carries over.
    const fresh = await sendChatRun(actor, { agentId, prompt: "draw a cat" });
    const freshPrompt = (await api.readRun(actor, fresh.runId))
      .appendSystemPrompt;
    expect(freshPrompt).not.toContain("# Inline Templates");
    expect(freshPrompt).not.toContain(
      "okou generate image --provider built-in --style",
    );
    expect(freshPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, fresh.runId);
  }, 120_000);

  it("injects workflow templates as one-shot context without prior template selections", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    const workflowTemplate = WORKFLOW_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    if (!workflowTemplate) {
      throw new Error("Expected a registered workflow template");
    }

    const illustration = await sendChatRun(actor, {
      agentId,
      prompt: "draw a labeled inbox",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: style.illustrationStyleId },
      },
    });
    const illustrationPrompt = (await api.readRun(actor, illustration.runId))
      .appendSystemPrompt;
    expect(illustrationPrompt).toContain("# Inline Templates");
    expect(illustrationPrompt).toContain(style.illustrationStyleId);
    await cancelChatRun(actor, illustration.runId);

    const workflow = await sendChatRun(actor, {
      agentId,
      threadId: illustration.threadId,
      prompt: "create the workflow version",
      template: {
        type: "workflow",
        selection: { workflowTemplateId: workflowTemplate.id },
      },
    });
    const workflowPrompt = (await api.readRun(actor, workflow.runId))
      .appendSystemPrompt;
    expect(workflowPrompt).toContain("# Inline Templates");
    expect(workflowPrompt).toContain(
      `Auto-inbox label (${workflowTemplate.id})`,
    );
    expect(workflowPrompt).toContain("Use the workflow-setup skill");
    expect(workflowPrompt).toContain(
      "Save the reusable workflow draft as soon as the template behavior is clear.",
    );
    expect(workflowPrompt).not.toContain("Before creating anything");
    expect(workflowPrompt).toContain("Gmail label-applied automation");
    // The illustration run saved no native history, so its message text is
    // replayed in the new session without the style id.
    expect(workflowPrompt).toContain("# Web Chat Run Context");
    expect(workflowPrompt).toContain("User: draw a labeled inbox");
    expect(workflowPrompt).not.toContain("# Incomplete Rounds Context");
    expect(workflowPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, workflow.runId);

    const followUp = await sendChatRun(actor, {
      agentId,
      threadId: illustration.threadId,
      prompt: "continue the thread",
    });
    const followUpPrompt = (await api.readRun(actor, followUp.runId))
      .appendSystemPrompt;
    // Neither cancelled run saved native history. Replay their message text
    // without carrying either prior template selection into the new session.
    expect(followUpPrompt).not.toContain("# Inline Templates");
    expect(followUpPrompt).not.toContain(workflowTemplate.id);
    expect(followUpPrompt).toContain("# Web Chat Run Context");
    expect(followUpPrompt).toContain("User: draw a labeled inbox");
    expect(followUpPrompt).toContain("User: create the workflow version");
    expect(followUpPrompt).not.toContain("# Incomplete Rounds Context");
    expect(followUpPrompt).not.toContain("Selected a template");
    expect(followUpPrompt).not.toContain(style.illustrationStyleId);
    await cancelChatRun(actor, followUp.runId);
  }, 120_000);

  it("rejects a private presentation template the caller cannot read", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Private template agent",
    });
    // Well formed and syntactically a row id, but no such row exists for this
    // owner. A deleted template and someone else's template are the same
    // answer on purpose: neither may be distinguished from the outside.
    const templateId = formatUserPresentationTemplateId(randomUUID());
    const selection: GenerationTemplateRequest = {
      type: "presentation",
      selection: { templateId },
    };

    const rejected = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use my own deck",
        userMessage: userMessageWithTemplate("use my own deck", selection),
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe("Presentation template not found");

    // Rejected before dispatch: no event is persisted and no run starts.
    const events = await chat.requestThreadEvents(actor, {}, [200]);
    expect(events.status).toBe(200);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
  }, 60_000);

  it("rejects unknown generation template selections", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Invalid template agent",
    });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
    if (!template) {
      throw new Error("Expected a registered presentation runbook item");
    }

    const arms: readonly {
      readonly template: GenerationTemplateRequest;
      readonly message: string;
    }[] = [
      {
        template: {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-missing",
          },
        },
        message: "Unknown generation template",
      },
      {
        // A runbook with an unknown color system is still rejected by the
        // runbook flow.
        template: {
          type: "presentation",
          selection: {
            colorSystemId: "color-system:missing",
            templateId: template.templateId,
          },
        },
        message: "Unknown generation template color system",
      },
      {
        // A runbook id without a package is unknown; presentations are
        // runbook-only, so there is no separate "wrong target type" path.
        template: {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-missing",
          },
        },
        message: "Unknown generation template",
      },
      {
        template: {
          type: "video",
          selection: { stylePresetId: "video-style:missing" },
        },
        message: "Unknown video template",
      },
      {
        template: {
          type: "workflow",
          selection: { workflowTemplateId: "workflow-template:missing" },
        },
        message: "Unknown workflow template",
      },
      {
        template: {
          type: "website",
          selection: { websiteTemplateId: "website-template:missing" },
        },
        message: "Unknown website template",
      },
    ];
    for (const arm of arms) {
      const rejected = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: "make something from a bad template",
          userMessage: userMessageWithTemplate(
            "make something from a bad template",
            arm.template,
          ),
        },
        [400],
      );
      expectApiError(rejected.body);
      expect(rejected.body.error.message).toBe(arm.message);
    }

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    expect(events.status).toBe(200);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
  }, 60_000);

  it("overlaps attachment metadata with thread model reconciliation", async () => {
    const { actor, agentId, providerId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
    const thread = await chat.createThread(actor, {
      agentId,
      model: "claude-sonnet-5",
    });

    await seedBuiltInModelKey("gpt-5.6-terra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const files = Array.from({ length: 2 }, (_, index) => {
      return {
        id: randomUUID(),
        filename: `overlap-${index + 1}.txt`,
        contentType: "text/plain",
        size: 40 + index,
      };
    });
    const objectsByKey = new Map(
      files.map((file) => {
        return [buildArtifactKeyV2(file.id, file.filename), file];
      }),
    );
    const releaseHeads = createDeferredPromise<void>(context.signal);
    let startedHeads = 0;
    let activeHeads = 0;
    context.mocks.s3.send.mockImplementation(
      async (command: unknown): Promise<unknown> => {
        if (command instanceof HeadObjectCommand) {
          const key = command.input.Key;
          const file =
            typeof key === "string" ? objectsByKey.get(key) : undefined;
          if (!file) {
            return {};
          }
          startedHeads += 1;
          activeHeads += 1;
          await releaseHeads.promise;
          activeHeads -= 1;
          return {
            ContentLength: file.size,
            ContentType: file.contentType,
            LastModified: new Date("2026-09-03T00:00:00.000Z"),
            Metadata: {
              "artifact-id": file.id,
              filename: encodeURIComponent(file.filename),
              "user-id": encodeURIComponent(actor.userId),
            },
          };
        }
        return { Contents: [] };
      },
    );

    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    const prompt = "read attachments during model recovery";
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt,
        userMessage: {
          version: 1,
          parts: [
            ...files.map((file) => {
              return {
                type: "file" as const,
                fileId: file.id,
                filenameSnapshot: file.filename,
                contentType: file.contentType,
              };
            }),
            { type: "text", text: prompt },
          ],
        },
      },
      [201],
    );
    onTestFinished(async () => {
      if (!releaseHeads.settled()) {
        releaseHeads.resolve(undefined);
      }
      threadLock.release();
      await threadLock.done;
      const response = await send;
      if (response.status === 201 && response.body.runId) {
        await cancelChatRun(actor, response.body.runId);
      }
    });

    await expect
      .poll(threadLock.firstBlockedStatementKind)
      .toBe("select_for_update");
    await expect
      .poll(() => {
        return startedHeads;
      })
      .toBe(files.length);
    expect(activeHeads).toBe(files.length);

    releaseHeads.resolve(undefined);
    threadLock.release();
    await threadLock.done;
    const sent = await send;
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected attachment overlap send to create a run");
    }
    const run = await api.readRun(actor, sent.body.runId);
    const promptPositions = files.map((file) => {
      return run.prompt.indexOf(`[ID] ${file.id}`);
    });
    expect(
      promptPositions.every((position) => {
        return position >= 0;
      }),
    ).toBeTruthy();
    expect(promptPositions).toStrictEqual(
      [...promptPositions].sort((a, b) => {
        return a - b;
      }),
    );
  }, 90_000);

  it("preserves a later thread failure when attachment lookup rejects", async () => {
    const { actor, agentId } = await entitledChatActor();
    const fileId = randomUUID();
    const filename = "speculative-rejection.txt";
    const exactKey = buildArtifactKeyV2(fileId, filename);
    const releaseHead = createDeferredPromise<void>(context.signal);
    let startedHeads = 0;
    let rejectedHeads = 0;
    context.mocks.s3.send.mockImplementation(
      async (command: unknown): Promise<unknown> => {
        if (
          command instanceof HeadObjectCommand &&
          command.input.Key === exactKey
        ) {
          startedHeads += 1;
          await releaseHead.promise;
          rejectedHeads += 1;
          throw new Error("speculative attachment lookup failed");
        }
        return { Contents: [] };
      },
    );

    let responseSettled = false;
    const responsePromise = chat
      .requestSendEvent(
        actor,
        {
          agentId,
          threadId: randomUUID(),
          prompt: "preserve the missing thread failure",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "file",
                fileId,
                filenameSnapshot: filename,
                contentType: "text/plain",
              },
              { type: "text", text: "preserve the missing thread failure" },
            ],
          },
        },
        [404],
      )
      .then((response) => {
        responseSettled = true;
        return response;
      });
    onTestFinished(async () => {
      if (!releaseHead.settled()) {
        releaseHead.resolve(undefined);
      }
      await responsePromise;
    });

    await expect
      .poll(() => {
        return startedHeads;
      })
      .toBe(1);
    await expect
      .poll(() => {
        return responseSettled;
      })
      .toBeTruthy();
    const response = await responsePromise;
    expectApiError(response.body);
    expect(response.body.error.message).toBe("Chat thread not found");

    releaseHead.resolve(undefined);
    await expect
      .poll(() => {
        return rejectedHeads;
      })
      .toBe(1);
  }, 30_000);

  it("resolves attachment metadata in ordered waves of four", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const files = Array.from({ length: 5 }, (_, index) => {
      return {
        id: randomUUID(),
        filename: `bounded-${index + 1}.txt`,
        contentType: `text/x-bounded-${index + 1}`,
        size: 100 + index,
      };
    });
    const objects = files.map((file) => {
      return {
        ...file,
        key: buildArtifactKeyV2(file.id, file.filename),
        prefix: buildArtifactPrefixV2(file.id),
      };
    });
    const objectsByPrefix = new Map(
      objects.map((object) => {
        return [object.prefix, object];
      }),
    );
    const objectsByKey = new Map(
      objects.map((object) => {
        return [object.key, object];
      }),
    );
    const firstWaveStarted = createDeferredPromise<void>(context.signal);
    const releaseFirstWave = createDeferredPromise<void>(context.signal);
    let matchingListRequests = 0;
    let startedHeads = 0;
    let activeHeads = 0;
    let peakActiveHeads = 0;
    context.mocks.s3.send.mockImplementation(
      async (command: unknown): Promise<unknown> => {
        if (command instanceof ListObjectsV2Command) {
          const prefix = command.input.Prefix;
          const object =
            typeof prefix === "string"
              ? objectsByPrefix.get(prefix)
              : undefined;
          if (!object) {
            return { Contents: [] };
          }
          matchingListRequests += 1;
          return {
            Contents: [
              {
                Key: object.key,
                Size: object.size,
                LastModified: new Date("2026-08-18T00:00:00.000Z"),
              },
            ],
          };
        }
        if (command instanceof HeadObjectCommand) {
          const key = command.input.Key;
          const object =
            typeof key === "string" ? objectsByKey.get(key) : undefined;
          if (!object) {
            return {};
          }
          startedHeads += 1;
          activeHeads += 1;
          peakActiveHeads = Math.max(peakActiveHeads, activeHeads);
          if (startedHeads === 4) {
            firstWaveStarted.resolve(undefined);
          }
          await releaseFirstWave.promise;
          activeHeads -= 1;
          return {
            ContentLength: object.size,
            ContentType: object.contentType,
            LastModified: new Date("2026-08-18T00:00:00.000Z"),
            Metadata: {
              "artifact-id": object.id,
              filename: encodeURIComponent(object.filename),
              "user-id": encodeURIComponent(actor.userId),
            },
          };
        }
        return {};
      },
    );

    const prompt = "read the bounded attachment set";
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt,
        userMessage: {
          version: 1,
          parts: [
            ...files.map((file) => {
              return {
                type: "file" as const,
                fileId: file.id,
                filenameSnapshot: file.filename,
                contentType: file.contentType,
              };
            }),
            { type: "text", text: prompt },
          ],
        },
      },
      [201],
    );
    onTestFinished(async () => {
      if (!releaseFirstWave.settled()) {
        releaseFirstWave.resolve(undefined);
      }
      const response = await send;
      if (response.status === 201 && response.body.runId) {
        await cancelChatRun(actor, response.body.runId);
      }
    });

    await firstWaveStarted.promise;
    expect(startedHeads).toBe(4);
    expect(activeHeads).toBe(4);
    expect(peakActiveHeads).toBe(4);
    releaseFirstWave.resolve(undefined);

    const sent = await send;
    expect(sent.status).toBe(201);
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected the bounded attachment send to create a run");
    }
    expect(startedHeads).toBe(5);
    expect(peakActiveHeads).toBe(4);
    expect(matchingListRequests).toBe(0);

    const run = await api.readRun(actor, sent.body.runId);
    const promptPositions = files.map((file) => {
      return run.prompt.indexOf(`[ID] ${file.id}`);
    });
    expect(
      promptPositions.every((position) => {
        return position >= 0;
      }),
    ).toBeTruthy();
    expect(promptPositions).toStrictEqual(
      [...promptPositions].sort((a, b) => {
        return a - b;
      }),
    );

    const catalog = await chat.listArtifactCatalog(actor, {
      chatThreadId: sent.body.threadId,
      kind: "file",
      limit: 20,
    });
    for (const file of files) {
      const summary = catalog.artifacts.find((artifact) => {
        return artifact.title === file.filename;
      });
      if (!summary) {
        throw new Error(`Expected catalog entry for ${file.filename}`);
      }
      const detail = await chat.getArtifactCatalogEntry(actor, summary.id);
      expect(detail.kind).toBe("file");
      if (detail.kind !== "file") {
        throw new Error(`Expected file catalog entry for ${file.filename}`);
      }
      expect(detail.file).toMatchObject({
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
      });
    }
  }, 60_000);

  it("falls back to v2 listing when the attachment filename hint is stale", async () => {
    const { actor, agentId } = await entitledChatActor();
    const fileId = randomUUID();
    const filenameSnapshot = "stale-extension.txt";
    const storedFilename = "current-extension.png";
    const exactKey = buildArtifactKeyV2(fileId, filenameSnapshot);
    const storedKey = buildArtifactKeyV2(fileId, storedFilename);
    const prefix = buildArtifactPrefixV2(fileId);
    const operations: string[] = [];
    context.mocks.s3.send.mockImplementation(
      (command: unknown): Promise<unknown> => {
        if (command instanceof HeadObjectCommand) {
          if (command.input.Key === exactKey) {
            operations.push("head:exact");
            const notFound = new Error("exact attachment key not found");
            notFound.name = "NotFound";
            return Promise.reject(notFound);
          }
          if (command.input.Key === storedKey) {
            operations.push("head:listed");
            return Promise.resolve({
              ContentLength: 42,
              ContentType: "image/png",
              LastModified: new Date("2026-08-24T00:00:00.000Z"),
              Metadata: {
                "artifact-id": fileId,
                filename: encodeURIComponent(storedFilename),
                "user-id": encodeURIComponent(actor.userId),
              },
            });
          }
          return Promise.resolve({});
        }
        if (
          command instanceof ListObjectsV2Command &&
          command.input.Prefix === prefix
        ) {
          operations.push("list:v2");
          return Promise.resolve({
            Contents: [
              {
                Key: storedKey,
                Size: 42,
                LastModified: new Date("2026-08-24T00:00:00.000Z"),
              },
            ],
          });
        }
        return Promise.resolve({ Contents: [] });
      },
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read the stale filename attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot,
            contentType: "image/png",
          },
          { type: "text", text: "read the stale filename attachment" },
        ],
      },
    });

    expect(operations).toStrictEqual(["head:exact", "list:v2", "head:listed"]);
    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(`[Web file] ${filenameSnapshot}`);
  }, 60_000);

  it("falls back to v2 listing when the exact head lacks size", async () => {
    const { actor, agentId } = await entitledChatActor();
    const fileId = randomUUID();
    const filename = "incomplete-head.txt";
    const key = buildArtifactKeyV2(fileId, filename);
    const prefix = buildArtifactPrefixV2(fileId);
    const operations: string[] = [];
    let headRequests = 0;
    context.mocks.s3.send.mockImplementation(
      (command: unknown): Promise<unknown> => {
        if (command instanceof HeadObjectCommand && command.input.Key === key) {
          headRequests += 1;
          operations.push(headRequests === 1 ? "head:exact" : "head:listed");
          return Promise.resolve({
            ContentType: "text/plain",
            LastModified: new Date("2026-08-24T00:00:00.000Z"),
            Metadata: {
              "artifact-id": fileId,
              filename: encodeURIComponent(filename),
              "user-id": encodeURIComponent(actor.userId),
            },
          });
        }
        if (
          command instanceof ListObjectsV2Command &&
          command.input.Prefix === prefix
        ) {
          operations.push("list:v2");
          return Promise.resolve({
            Contents: [
              {
                Key: key,
                Size: 73,
                LastModified: new Date("2026-08-24T00:00:00.000Z"),
              },
            ],
          });
        }
        return Promise.resolve({ Contents: [] });
      },
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read the incomplete head attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
          { type: "text", text: "read the incomplete head attachment" },
        ],
      },
    });

    expect(operations).toStrictEqual(["head:exact", "list:v2", "head:listed"]);
    const catalog = await chat.listArtifactCatalog(actor, {
      chatThreadId: run.threadId,
      kind: "file",
      limit: 20,
    });
    const summary = catalog.artifacts.find((artifact) => {
      return artifact.title === filename;
    });
    if (!summary) {
      throw new Error("Expected incomplete-head attachment in the catalog");
    }
    const detail = await chat.getArtifactCatalogEntry(actor, summary.id);
    expect(detail.kind).toBe("file");
    if (detail.kind !== "file") {
      throw new Error("Expected incomplete-head file catalog entry");
    }
    expect(detail.file.size).toBe(73);
  }, 60_000);

  it("does not create a run when an attachment is missing", async () => {
    const { actor, agentId } = await entitledChatActor();
    const fileId = randomUUID();
    const filename = "missing.txt";
    const exactKey = buildArtifactKeyV2(fileId, filename);
    let exactHeadRequests = 0;
    context.mocks.s3.send.mockImplementation(
      (command: unknown): Promise<unknown> => {
        if (
          command instanceof HeadObjectCommand &&
          command.input.Key === exactKey
        ) {
          exactHeadRequests += 1;
          return Promise.resolve({
            ContentLength: 42,
            ContentType: "text/plain",
            LastModified: new Date("2026-08-24T00:00:00.000Z"),
            Metadata: {
              "artifact-id": fileId,
              filename: encodeURIComponent(filename),
              "user-id": encodeURIComponent(`${actor.userId}-other`),
            },
          });
        }
        return Promise.resolve({ Contents: [] });
      },
    );
    const model = await chat.getDefaultCreateThreadModel(actor);
    const prompt = "reject the missing attachment";
    const response = await requestSendEventRaw(actor, {
      agentId,
      model,
      prompt,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
          { type: "text", text: prompt },
        ],
      },
      hasTextContent: true,
    });

    expect(response).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    expect(exactHeadRequests).toBe(1);
    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.some((run) => {
        return run.prompt === prompt;
      }),
    ).toBeFalsy();
  }, 60_000);

  it("does not create a run when attachment storage fails", async () => {
    const { actor, agentId } = await entitledChatActor();
    const model = await chat.getDefaultCreateThreadModel(actor);
    context.mocks.s3.send.mockRejectedValue(
      new Error("object storage unavailable"),
    );
    const prompt = "reject the failed attachment lookup";
    const response = await requestSendEventRaw(actor, {
      agentId,
      model,
      prompt,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: randomUUID(),
            filenameSnapshot: "unavailable.txt",
            contentType: "text/plain",
          },
          { type: "text", text: prompt },
        ],
      },
      hasTextContent: true,
    });

    expect(response).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.some((run) => {
        return run.prompt === prompt;
      }),
    ).toBeFalsy();
  }, 60_000);

  it("does not create a run when attachment resolution is aborted", async () => {
    const { actor, agentId } = await entitledChatActor();
    const model = await chat.getDefaultCreateThreadModel(actor);
    const controller = new AbortController();
    const abortError = new Error(
      "client disconnected during attachment lookup",
    );
    abortError.name = "AbortError";
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        controller.abort(abortError);
      }
      return Promise.resolve({ Contents: [] });
    });
    const prompt = "abort the attachment lookup";
    const response = await requestSendEventRaw(
      actor,
      {
        agentId,
        model,
        prompt,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: randomUUID(),
              filenameSnapshot: "aborted.txt",
              contentType: "text/plain",
            },
            { type: "text", text: prompt },
          ],
        },
        hasTextContent: true,
      },
      controller.signal,
    );

    expect(controller.signal.aborted).toBeTruthy();
    expect(response).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    const runs = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runs.runs.some((run) => {
        return run.prompt === prompt;
      }),
    ).toBeFalsy();
  }, 60_000);

  it("persists attachments and injects them into the run prompt", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const fileId = randomUUID();
    const filename = "diagram final 100%.png";
    chat.mockCompletedUploadObject(actor, fileId, filename, 42);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read this file",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "image/png",
          },
          { type: "text", text: "read this file" },
        ],
      },
    });

    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(`[Web file] ${filename} (image/png)`);
    expect(created.prompt).toContain(`[ID] ${fileId}`);
    expect(created.appendSystemPrompt).toContain("okou web download-file -h");
    expect(created.appendSystemPrompt).toContain("okou web upload-file -h");

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.eventType === "input.prompt" &&
            message.userMessage?.parts.some((part) => {
              return part.type === "file";
            }) === true
          );
        });
      },
    );
    const attachedMessage = userMessages(messages.events).find((message) => {
      return message.eventType === "input.prompt";
    });
    const attached = attachedMessage?.userMessage?.parts.find((part) => {
      return part.type === "file";
    });
    expect(attached).toMatchObject({
      type: "file",
      fileId,
      filenameSnapshot: filename,
      contentType: "image/png",
    });
    await cancelChatRun(actor, run.runId);
  }, 60_000);

  it("projects one structured annotated file through its rendered derivative", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const fileId = randomUUID();
    const annotatedFileId = randomUUID();
    const filename = "billing-page.png";
    chat.mockCompletedUploadObjects(actor, [
      { id: fileId, filename, size: 42 },
      { id: annotatedFileId, filename: "billing-page.annotated.png", size: 54 },
    ]);
    const filePart = {
      type: "file" as const,
      fileId,
      filenameSnapshot: filename,
      contentType: "image/png",
      annotatedFileId,
      annotations: {
        marks: [
          {
            id: "spacing-mark",
            ordinal: 1,
            shape: "box" as const,
            rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            ink: "#5E6AD2",
            note: "Tighten this spacing",
          },
        ],
      },
    };

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "fix this",
      userMessage: {
        version: 1,
        parts: [filePart, { type: "text", text: "fix this" }],
      },
    });

    const created = await api.readRun(actor, run.runId);
    expect(created.prompt).toContain(
      `[Web file] billing-page.annotated.png (image/png)\n   [ID] ${annotatedFileId}`,
    );
    expect(created.prompt).toContain(
      `[Image annotations]\n${JSON.stringify(filePart)}`,
    );
    expect(created.prompt).not.toContain(
      `[Web file] ${filename} (image/png)\n   [ID] ${fileId}`,
    );

    const messages = await waitForThreadMessages(
      actor,
      run.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.eventType === "input.prompt" &&
            message.userMessage.parts.some((part) => {
              return part.type === "file" && part.fileId === fileId;
            })
          );
        });
      },
    );
    const attached = userMessages(messages.events)
      .filter((message) => {
        return message.eventType === "input.prompt";
      })
      .flatMap((message) => {
        return message.eventType === "input.prompt"
          ? message.userMessage.parts
          : [];
      })
      .find((part) => {
        return part.type === "file";
      });
    expect(attached).toStrictEqual(filePart);
    await cancelChatRun(actor, run.runId);
  }, 60_000);

  it("keeps a legacy VM0 attachment on the VM0 CDN for an Okou send", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const fileId = randomUUID();
    const filename = "legacy-brand.txt";
    chat.mockCompletedUploadObject(actor, fileId, filename, 24);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "read the legacy attachment",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
          { type: "text", text: "read the legacy attachment" },
        ],
      },
    });
    await flushWaitUntilForTest();

    const catalog = await chat.listArtifactCatalog(actor, {
      chatThreadId: run.threadId,
      kind: "file",
      limit: 20,
    });
    const summary = catalog.artifacts.find((artifact) => {
      return artifact.title === filename;
    });
    if (!summary) {
      throw new Error("Expected the legacy attachment in the artifact catalog");
    }
    const detail = await chat.getArtifactCatalogEntry(actor, summary.id);
    if (detail.kind !== "file") {
      throw new Error("Expected a file artifact for the legacy attachment");
    }
    expect(detail.file.url).toMatch(/^https:\/\/cdn\.vm7\.io\//);
    expect(detail.file.url).not.toMatch(
      /^https:\/\/(?:a\.okou\.io|cdn\.okou\.io)\//,
    );

    await cancelChatRun(actor, run.runId);
  }, 60_000);
});

describe("CHAT-02: queued attachments on auto-send", () => {
  it("preserves structured part order when a queued message is promoted", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor before the structured queue item",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const fileId = randomUUID();
    const queuedId = randomUUID();
    const queuedPrompt =
      "queued structured text\n\n" +
      "Feedback on this part of your reply:\n\n" +
      "> Queued quote\n\nRevise after the anchor completes";
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "file",
          fileId,
          filenameSnapshot: "ordered.txt",
          contentType: "text/plain",
        },
        { type: "text", text: "queued structured text" },
        {
          type: "feedback",
          quote: "Queued quote",
          note: [{ type: "text", text: "Revise after the anchor completes" }],
        },
      ],
    };
    chat.mockCompletedUploadObject(actor, fileId, "ordered.txt", 12);
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: queuedPrompt,
        userMessage,
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the structured queued message to auto-send");
    }
    expect(promoted.userMessage).toStrictEqual({
      version: 1,
      parts: [
        ...userMessage.parts,
        {
          type: "model",
          selectedModel: "claude-sonnet-5",
        },
      ],
    });

    const run = await api.readRun(actor, promoted.runId);
    expect(run.prompt).toBe(
      [
        `[Web file] ordered.txt (text/plain)\n   [ID] ${fileId}`,
        queuedPrompt,
      ].join("\n\n"),
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("carries queued attachments into the auto-sent follow-up run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor before the queued attachment",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const fileId = randomUUID();
    const secondFileId = randomUUID();
    const queuedId = randomUUID();
    chat.mockCompletedUploadObjects(actor, [
      { id: fileId, filename: "notes.txt", size: 12 },
      { id: secondFileId, filename: "details.json", size: 24 },
    ]);
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued with attachment",
        clientEventId: queuedId,
        realAgentInPreview: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId,
              filenameSnapshot: "notes.txt",
              contentType: "text/plain",
            },
            {
              type: "file",
              fileId: secondFileId,
              filenameSnapshot: "details.json",
              contentType: "application/json",
            },
            { type: "text", text: "queued with attachment" },
          ],
        },
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    // Completing the anchor run promotes the queued message into a fresh
    // run whose prompt carries the resolved attachment references.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId && message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to auto-send into a run");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe("queued with attachment");
    expect(promoted.userMessage?.parts).toStrictEqual(
      expect.arrayContaining([
        {
          type: "file",
          fileId,
          filenameSnapshot: "notes.txt",
          contentType: "text/plain",
        },
        {
          type: "file",
          fileId: secondFileId,
          filenameSnapshot: "details.json",
          contentType: "application/json",
        },
      ]),
    );
    const original = userMessages(messages.events).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original).toMatchObject({
      id: queuedId,
      content: null,
    });
    expect(chatEventDisplayText(original)).toBe("queued with attachment");
    expect(original.runId).toBeUndefined();

    const followUp = await api.readRun(actor, promoted.runId);
    expect(followUp.prompt).toContain("queued with attachment");
    expect(followUp.prompt).toContain("[Web file] notes.txt (text/plain)");
    expect(followUp.prompt).toContain(`[ID] ${fileId}`);
    expect(followUp.prompt).toContain(
      "[Web file] details.json (application/json)",
    );
    expect(followUp.prompt).toContain(`[ID] ${secondFileId}`);
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);
});

describe("CHAT-02: default assistant identity", () => {
  it("keeps the default name as Okou through queued runs without renaming custom agents", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const { actor, runnerGroup } = await entitledChatActor();
    bdd.acceptAgentStorageWrites();
    const onboarding = await bdd.readOnboardingStatus(actor);
    const defaultAgentId = onboarding.defaultAgentId;
    if (!defaultAgentId) {
      throw new Error("Expected the system default agent to exist");
    }

    const anchor = await sendChatRun(actor, {
      agentId: defaultAgentId,
      prompt: "start an Okou run",
    });
    const anchorRun = await api.readRun(actor, anchor.runId);
    expect(anchorRun.appendSystemPrompt).toContain("Your name is Okou.");

    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
    await expectRunAppContext({
      actor,
      runId: anchor.runId,
      claim: anchorClaim.claim,
      appUrl: "https://app.okou.ai",
    });
    const queuedEventId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId: defaultAgentId,
        threadId: anchor.threadId,
        prompt: "continue the Okou run",
        clientEventId: queuedEventId,
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the Okou follow-up to enter the chat queue");
    }
    expect(queued.body.runId).toBeNull();

    const rawQueuedEvent = (
      await chat.listThreadEventRows(actor, anchor.threadId)
    ).find((event) => {
      return event.id === queuedEventId;
    });
    if (!rawQueuedEvent) {
      throw new Error("Expected the queued Okou event in Raw Events");
    }
    expect(rawQueuedEvent).toMatchObject({
      contextType: "web",
      contextId: "0bdfae9e-63be-43dd-8193-a96e07787c20",
    });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const promotedMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(promotedMessages.events).find((message) => {
      return message.revokesEventId === queuedEventId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued Okou message to auto-send");
    }
    const promotedRun = await api.readRun(actor, promoted.runId);
    expect(promotedRun.appendSystemPrompt).toContain("Your name is Okou.");
    const promotedClaim = await claimChatRun(runnerGroup, promoted.runId);
    await expectRunAppContext({
      actor,
      runId: promoted.runId,
      claim: promotedClaim.claim,
      appUrl: "https://app.okou.ai",
    });
    await cancelChatRun(actor, promoted.runId);

    mockEnv("APP_URL", "https://preview.example.test");
    const customAgent = await bdd.createAgent(actor, {
      displayName: "Nova",
      visibility: "private",
    });
    const customRun = await sendChatRun(actor, {
      agentId: customAgent.agentId,
      prompt: "keep my custom name",
    });
    const customPrompt = (await api.readRun(actor, customRun.runId))
      .appendSystemPrompt;
    expect(customPrompt).toContain("Your name is Nova.");
    expect(customPrompt).not.toContain("Your name is Okou.");
    const customClaim = await claimChatRun(runnerGroup, customRun.runId);
    await expectRunAppContext({
      actor,
      runId: customRun.runId,
      claim: customClaim.claim,
      appUrl: "https://preview.example.test",
    });

    await cancelChatRun(actor, customRun.runId);
  }, 90_000);

  it("posts GitHub Audit links to the configured Okou app", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    bdd.acceptAgentStorageWrites();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const orgId = actor.orgId;
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.OkouDebug]: true,
      },
    );
    const installation = await github.installGithubApp(actor, agentId);
    const postedComments: string[] = [];
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
        async ({ request, params }) => {
          expect(params.owner).toBe("vm0-ai");
          expect(params.repo).toBe("vm0");
          const body = (await request.json()) as Record<string, unknown>;
          if (typeof body.body !== "string") {
            return HttpResponse.json(
              { message: "Expected a comment body" },
              { status: 400 },
            );
          }
          postedComments.push(body.body);
          return HttpResponse.json({ id: postedComments.length });
        },
      ),
    );

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "deliver an Okou GitHub response",
    });
    const claim = await claimChatRun(runnerGroup, run.runId);
    await setChatCallbackGitHubDeliveryFixture({
      runId: run.runId,
      remoteInstallationId: installation.remoteInstallationId,
      repo: "vm0-ai/vm0",
      subjectNumber: 1,
      subjectKind: "issue",
      agentId,
    });

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "GitHub callback brand response"),
    ]);
    await completeChatRunOk(run.runId, claim.sandboxHeaders);
    await flushWaitUntilForTest();

    expect(postedComments.at(-1)).toContain(
      `📋 [Audit](https://app.okou.ai/activities/${run.runId})`,
    );
    expect(postedComments).toHaveLength(1);
  }, 90_000);
});

describe("CHAT-02: run-scoped agent-token chat launches", () => {
  it("keeps immediate and queued runs agent-scoped without retired provenance", async () => {
    const { actor, agentId } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const caller = await sendChatRun(actor, {
      agentId,
      prompt: "launch chat work from this run",
    });
    const okouToken = api.okouTokenForRunWithCapabilities(actor, caller.runId, [
      "chat-thread:read",
      "chat-thread:write",
      "chat-event:read",
      "chat-event:write",
    ]);

    const createdThread = await accept(
      chatThreadsClient().create({
        headers: { authorization: `Bearer ${okouToken}` },
        body: { agentId, title: "Run-scoped handoff" },
      }),
      [201],
    );
    const immediate = await requestSendEventWithBearer(
      okouToken,
      {
        agentId,
        threadId: createdThread.body.id,
        prompt: "immediate run-scoped handoff",
      },
      [201],
    );
    if (immediate.status !== 201) {
      throw new Error("Expected the run-scoped handoff request to succeed");
    }
    if (!immediate.body.runId) {
      throw new Error("Expected the run-scoped handoff to launch immediately");
    }

    await expect(
      api.readRun(actor, immediate.body.runId),
    ).resolves.toMatchObject({
      runId: immediate.body.runId,
      prompt: "immediate run-scoped handoff",
    });
    await expect(
      readRunAutonomyBudgetFixture(context, caller.runId),
    ).resolves.toBe(10);
    await expect(
      readRunAutonomyBudgetFixture(context, immediate.body.runId),
    ).resolves.toBe(9);
    // Neither callback internals nor retired provenance are public API fields.
    // The test-only state route is the only boundary that can prove their
    // absence without importing database schemas or production services.
    const immediateState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: immediate.body.runId,
      },
      context.signal,
    );
    expect(immediateState.agent_run).toMatchObject({
      triggerSource: "agent",
    });
    expect(
      immediateState.callbacks.map((callback) => {
        return callback.internalKind;
      }),
    ).toStrictEqual(["chat"]);

    const queuedEventId = randomUUID();
    const queued = await requestSendEventWithBearer(
      okouToken,
      {
        agentId,
        clientEventId: queuedEventId,
        threadId: createdThread.body.id,
        prompt: "queued run-scoped handoff",
      },
      [201],
    );
    if (queued.status !== 201) {
      throw new Error("Expected the queued run-scoped request to succeed");
    }
    expect(queued.body.runId).toBeNull();

    await cancelChatRun(actor, immediate.body.runId);
    const promotedMessages = await waitForThreadMessages(
      actor,
      createdThread.body.id,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const promoted = userMessages(promotedMessages.events).find(
      (message): message is PromptMessage => {
        return (
          message.eventType === "input.prompt" &&
          message.revokesEventId === queuedEventId
        );
      },
    );
    if (!promoted?.runId) {
      throw new Error("Expected the queued run-scoped handoff to promote");
    }

    await expect(api.readRun(actor, promoted.runId)).resolves.toMatchObject({
      runId: promoted.runId,
      prompt: "queued run-scoped handoff",
    });
    await expect(
      readRunAutonomyBudgetFixture(context, promoted.runId),
    ).resolves.toBe(9);
    const promotedState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: promoted.runId,
      },
      context.signal,
    );
    expect(promotedState.agent_run).toMatchObject({
      triggerSource: "agent",
    });
    expect(
      promotedState.callbacks.map((callback) => {
        return callback.internalKind;
      }),
    ).toStrictEqual(["chat"]);

    await cancelChatRun(actor, promoted.runId);
    await cancelChatRun(actor, caller.runId);
  }, 90_000);
});

describe("CHAT-02/FILE-03: computer-use host grants", () => {
  it("grants computer-use capability only for a selected host", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { hostId, hostToken } = await cu.startComputerUseHost(actor);

    // The thread's sticky host is not exposed by any read route, so the
    // grant is observed through the run token issued to each claim: a
    // granted token can create write commands on the host, while an
    // ungranted token cannot. Chat messaging remains available independently.
    const plain = await sendChatRun(actor, {
      agentId,
      prompt: "no computer use selected",
    });
    const plainClaim = await claimChatRun(runnerGroup, plain.runId);
    const plainToken = okouTokenFromClaim(plainClaim.claim);
    const deniedCommand = await cu.requestCreateComputerUseWriteCommand(
      { bearer: plainToken },
      [403],
    );
    expect(deniedCommand.status).toBe(403);
    const nestedEventId = randomUUID();
    const nestedSend = await requestSendEventWithBearer(
      plainToken,
      {
        agentId,
        clientEventId: nestedEventId,
        threadId: plain.threadId,
        prompt: "run tokens can send chat messages",
      },
      [201],
    );
    expect(nestedSend.status).toBe(201);
    expect(nestedSend.body).toMatchObject({ runId: null });
    const recalled = await accept(
      chatEventsClient().send({
        headers: { authorization: `Bearer ${plainToken}` },
        body: {
          agentId,
          threadId: plain.threadId,
          revokesEventId: nestedEventId,
          clientEventId: randomUUID(),
        },
      }),
      [201],
    );
    expect(recalled.body.runId).toBeNull();
    await cancelChatRun(actor, plain.runId);

    // Selecting an online host pins it to the thread and grants the run
    // token computer-use write access on that host.
    const granted = await sendChatRun(actor, {
      agentId,
      prompt: "open the remote browser",
      computerUseHostId: hostId,
    });
    const grantedRun = await api.readRun(actor, granted.runId);
    expect(grantedRun.appendSystemPrompt).toContain("# Computer Use");
    expect(grantedRun.appendSystemPrompt).toContain(
      "Computer Use is enabled for this run on BDD Desktop.",
    );
    expect(grantedRun.appendSystemPrompt).not.toContain(hostId);
    const grantedClaim = await claimChatRun(runnerGroup, granted.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(grantedClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, granted.runId, grantedClaim.sandboxHeaders);

    // Follow-up sends without the field stay granted via the sticky host.
    const sticky = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "keep using the same host",
    });
    const stickyClaim = await claimChatRun(runnerGroup, sticky.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(stickyClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, sticky.runId, stickyClaim.sandboxHeaders);

    // An explicit null clears the sticky host: the next run on the same
    // thread is no longer granted.
    const cleared = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "drop the host",
      computerUseHostId: null,
    });
    const clearedClaim = await claimChatRun(runnerGroup, cleared.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(clearedClaim.claim) },
      [403],
    );
    await cancelChatRun(actor, cleared.runId, clearedClaim.sandboxHeaders);

    mockNow(now() + 91_000);
    const staleGranted = await sendChatRun(actor, {
      agentId,
      threadId: granted.threadId,
      prompt: "use the computer after it went offline",
      computerUseHostId: hostId,
    });
    const staleRun = await api.readRun(actor, staleGranted.runId);
    expect(staleRun.appendSystemPrompt).toContain(
      "Computer Use is enabled for this run on BDD Desktop.",
    );
    clearMockNow();
    const staleClaim = await claimChatRun(runnerGroup, staleGranted.runId);
    await cu.heartbeatComputerUseHost(hostToken);
    await cu.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(staleClaim.claim) },
      [200],
    );
    await cancelChatRun(actor, staleGranted.runId);
  }, 120_000);

  it("rejects unusable computer-use host selections", async () => {
    const actor = bdd.user();
    await api.ensureOrgModelProvider(actor);
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Computer-use guard agent",
    });

    const unknownHost = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unknown host",
        computerUseHostId: randomUUID(),
      },
      [404],
    );
    expectApiError(unknownHost.body);
    expect(unknownHost.body.error.message).toBe("Computer-use host not found");

    // Stopping a host revokes it, so an explicit selection reports it as
    // missing rather than offline, and clears any thread binding immediately.
    const stopped = await cu.startComputerUseHost(actor);
    const stoppedPinned = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin the host before stopping it",
        computerUseHostId: stopped.hostId,
      },
      [201],
    );
    if (stoppedPinned.status !== 201) {
      throw new Error("Expected the stopped-host pin send to be accepted");
    }
    await cu.stopComputerUseHost(stopped.hostToken);
    await expect(
      readThreadComputerUseHostId(actor, stoppedPinned.body.threadId),
    ).resolves.toBeNull();
    const revokedHost = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a stopped host",
        computerUseHostId: stopped.hostId,
      },
      [404],
    );
    expectApiError(revokedHost.body);
    expect(revokedHost.body.error.message).toBe("Computer-use host not found");

    // Installation-backed hosts stop as temporary offline devices, so thread
    // bindings survive and reconnect to the same host id on the next start.
    const installationId = randomUUID();
    const installed = await cu.startComputerUseHost(actor, { installationId });
    const installedPinned = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin the durable host before stopping it",
        computerUseHostId: installed.hostId,
      },
      [201],
    );
    if (installedPinned.status !== 201) {
      throw new Error("Expected the installed-host pin send to be accepted");
    }
    await cu.stopComputerUseHost(installed.hostToken);
    await expect(
      readThreadComputerUseHostId(actor, installedPinned.body.threadId),
    ).resolves.toBe(installed.hostId);
    const stoppedInstalledHost = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: installedPinned.body.threadId,
        prompt: "use a stopped durable host",
        computerUseHostId: installed.hostId,
      },
      [201],
    );
    expect(stoppedInstalledHost.body).toMatchObject({
      threadId: installedPinned.body.threadId,
    });
    const reconnected = await cu.startComputerUseHost(actor, {
      installationId,
    });
    expect(reconnected.hostId).toBe(installed.hostId);

    // A valid sticky host remains usable for later non-explicit sends.
    const survivor = await cu.startComputerUseHost(actor);
    const survivorThread = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "pin a host for a later sticky send",
        computerUseHostId: survivor.hostId,
      },
      [201],
    );
    if (survivorThread.status !== 201) {
      throw new Error("Expected the survivor send to be accepted");
    }

    // A host that stopped heartbeating goes stale-offline (status still
    // online, not revoked), but explicit selections are still accepted so the
    // run can use the host if it reconnects while running.
    mockNow(now() + 91_000);
    const offlineHostSend = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a stale host",
        computerUseHostId: survivor.hostId,
      },
      [201],
    );
    expect(offlineHostSend.body).toMatchObject({ runId: null });

    // The sticky-host fallthrough also tolerates a stale host instead of
    // failing: a send without the field on the pinned thread is accepted.
    const staleStickySend = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: survivorThread.body.threadId,
        prompt: "send while the sticky host is stale",
      },
      [201],
    );
    clearMockNow();
    expect(staleStickySend.body).toMatchObject({
      threadId: survivorThread.body.threadId,
    });
  }, 90_000);
});

describe("CHAT-02: shared user message queue", () => {
  it("dispatches idle-thread sends by appending a run-associated replacement", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const messageId = randomUUID();
    const referencedThreadId = randomUUID();
    const userMessage: UserMessageDocument = {
      version: 1,
      parts: [
        { type: "text", text: "queue-first " },
        {
          type: "chat_thread",
          threadId: referencedThreadId,
          titleSnapshot: "direct dispatch",
        },
        { type: "model", selectedModel: "gpt-5.6-sol" },
      ],
    };
    const apiStartedAt = now();
    const sent = await withMockNowForTest(apiStartedAt, async () => {
      return await chat.requestSendEvent(
        actor,
        {
          agentId,
          prompt: "queue-first direct dispatch",
          userMessage,
          clientEventId: messageId,
        },
        [201],
      );
    });
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected an idle-thread queue-first send to dispatch");
    }
    const runId = sent.body.runId;

    // The queued row stays immutable. Claiming appends the run-associated
    // replacement and links it back to the queued row.
    const messages = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === messageId && message.runId === runId
          );
        });
      },
    );
    const rows = userMessages(messages.events);
    expect(rows).toHaveLength(2);
    const claimed = rows.find((message) => {
      return message.revokesEventId === messageId;
    });
    expect(claimed).toMatchObject({
      content: null,
      userMessage: {
        version: 1,
        parts: [
          ...userMessage.parts.filter((part) => {
            return part.type !== "model";
          }),
          {
            type: "model",
            selectedModel: "claude-sonnet-5",
          },
        ],
      },
      runId,
      revokesEventId: messageId,
    });
    expect(claimed?.id).not.toBe(messageId);
    const queued = rows.find((message) => {
      return message.id === messageId;
    });
    if (!queued) {
      throw new Error("Expected the queued message");
    }
    expect(queued).toMatchObject({
      id: messageId,
      content: null,
      userMessage,
    });
    expect(queued.runId).toBeUndefined();

    const replay = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.body.threadId,
        prompt: "queue-first direct dispatch",
        clientEventId: messageId,
      },
      [201],
    );
    expect(replay.body).toStrictEqual(sent.body);
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${sent.body.threadId}`;
        });
      })
      .toBe(true);

    const claimedRun = await claimChatRun(runnerGroup, runId);
    expect(claimedRun.claim.apiStartTime).toBe(apiStartedAt);
    expect(claimedRun.claim.prompt).toBe(
      `queue-first [direct dispatch](/chats/${referencedThreadId})`,
    );

    await cancelChatRun(actor, runId);
  }, 90_000);

  it("persists user-forwarded run provenance across chat threads", async () => {
    const { actor, agentId } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "source content selected for forwarding",
    });
    await setRunAutonomyBudgetFixture(context, source.runId, 0);
    const targetThread = await chat.createThread(actor, { agentId });
    const forwardedEventId = randomUUID();
    const forwarded = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: targetThread.id,
        clientEventId: forwardedEventId,
        prompt: "Forwarded content:\n\n> deployment window is fifteen minutes",
        sourceRunId: source.runId,
      },
      [201],
    );
    if (forwarded.status !== 201 || !forwarded.body.runId) {
      throw new Error("Expected the forwarded prompt to launch a run");
    }
    const forwardedRunId = forwarded.body.runId;

    const targetMessages = await waitForThreadMessages(
      actor,
      targetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === forwardedEventId;
        });
      },
    );
    const forwardedInput = userMessages(targetMessages.events).find(
      (event): event is PromptMessage => {
        return (
          event.eventType === "input.prompt" && event.id === forwardedEventId
        );
      },
    );
    expect(forwardedInput?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "New thread",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });

    const forwardedRun = await api.readRun(actor, forwardedRunId);
    const forwardedState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: forwardedRunId,
      },
      context.signal,
    );
    expect(forwardedState.agent_run).toMatchObject({ triggerSource: "web" });
    const forwardedSystemPrompt = forwardedRun.appendSystemPrompt ?? "";
    expect(forwardedSystemPrompt).toContain("# This Run's Trigger");
    expect(forwardedSystemPrompt).toContain(
      "was sent by a person who forwarded selected content",
    );
    expect(forwardedSystemPrompt).not.toContain(
      "A person did not type it here.",
    );
    expect(forwardedSystemPrompt).toContain(`SOURCE_RUN_ID: ${source.runId}`);
    expect(forwardedSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${source.threadId}`,
    );
    await expect(
      readRunAutonomyBudgetFixture(context, source.runId),
    ).resolves.toBe(0);
    await expect(
      readRunAutonomyBudgetFixture(context, forwardedRunId),
    ).resolves.toBe(10);

    const unknownSource = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: targetThread.id,
        clientEventId: randomUUID(),
        prompt: "forwarded with unknown provenance",
        sourceRunId: randomUUID(),
      },
      [400],
    );
    expect(unknownSource).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Forward source run not found",
        },
      },
    });

    await cancelChatRun(actor, forwardedRunId);
    await cancelChatRun(actor, source.runId);
  }, 90_000);

  it("persists agent-run provenance for messages sent across chat threads", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const firstTargetThread = await chat.createThread(actor, { agentId });
    const secondTargetThread = await chat.createThread(actor, { agentId });

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate work to other chat threads",
    });
    const { claim: sourceClaim, sandboxHeaders: sourceSandboxHeaders } =
      await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim);

    const firstEventId = randomUUID();
    const firstSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: firstEventId,
        threadId: firstTargetThread.id,
        prompt: "first delegated prompt",
      },
      [201],
    );
    if (firstSend.status !== 201) {
      throw new Error("Expected the first delegated prompt to be accepted");
    }
    if (!firstSend.body.runId) {
      throw new Error("Expected the first delegated prompt to launch a run");
    }
    const firstTargetRunId = firstSend.body.runId;
    await expect(
      readRunAutonomyBudgetFixture(context, source.runId),
    ).resolves.toBe(10);
    await expect(
      readRunAutonomyBudgetFixture(context, firstTargetRunId),
    ).resolves.toBe(9);
    const firstTargetRun = await api.readRun(actor, firstTargetRunId);
    const firstTargetSystemPrompt = firstTargetRun.appendSystemPrompt ?? "";
    expect(firstTargetSystemPrompt).toContain("# This Run's Trigger");
    expect(firstTargetSystemPrompt).toContain(`SOURCE_RUN_ID: ${source.runId}`);
    expect(firstTargetSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${source.threadId}`,
    );
    expect(firstTargetSystemPrompt).toContain(`SOURCE_AGENT_ID: ${agentId}`);
    expect(firstTargetSystemPrompt).toContain(
      "SOURCE_THREAD_TITLE: New thread",
    );
    expect(firstTargetSystemPrompt).toContain(
      `okou chat messages --thread-id ${source.threadId}`,
    );
    expect(firstTargetSystemPrompt).toContain(
      `okou search "${source.runId}" --source agent-session`,
    );
    const sourceRun = await api.readRun(actor, source.runId);
    expect(sourceRun.appendSystemPrompt ?? "").not.toContain(
      "# This Run's Trigger",
    );
    const firstMessages = await waitForThreadMessages(
      actor,
      firstTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === firstEventId;
        });
      },
    );
    const firstInput = userMessages(firstMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === firstEventId;
      },
    );
    expect(firstInput).toMatchObject({
      eventType: "input.prompt",
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "first delegated prompt" },
          {
            type: "source",
            kind: "agent",
            runId: source.runId,
            threadId: source.threadId,
            agentId,
            titleSnapshot: "New thread",
            href: `/chats/${source.threadId}#run-${source.runId}`,
          },
        ],
      },
    });
    expect(firstInput?.runId).toBeUndefined();
    await chat.renameThread(actor, source.threadId, "Delegation source");
    const secondEventId = randomUUID();
    const secondSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: secondEventId,
        threadId: secondTargetThread.id,
        prompt: "second delegated prompt",
      },
      [201],
    );
    if (secondSend.status !== 201) {
      throw new Error("Expected the second delegated prompt to be accepted");
    }
    if (!secondSend.body.runId) {
      throw new Error("Expected the second delegated prompt to queue a run");
    }
    const secondTargetRunId = secondSend.body.runId;
    expect(secondSend.body.status).toBe("queued");
    await expect(
      readRunAutonomyBudgetFixture(context, secondTargetRunId),
    ).resolves.toBe(9);
    const secondMessages = await waitForThreadMessages(
      actor,
      secondTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === secondEventId;
        });
      },
    );
    const secondInput = userMessages(secondMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === secondEventId;
      },
    );
    expect(secondInput?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "Delegation source",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });

    await chat.renameThread(actor, source.threadId, "now");
    const nowTargetThread = await chat.createThread(actor, { agentId });
    const nowEventId = randomUUID();
    const nowSend = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: nowEventId,
        threadId: nowTargetThread.id,
        prompt: "delegated prompt from a placeholder thread title",
      },
      [201],
    );
    if (nowSend.status !== 201) {
      throw new Error("Expected the placeholder-title prompt to be accepted");
    }
    if (!nowSend.body.runId) {
      throw new Error("Expected the placeholder-title prompt to queue a run");
    }
    const nowTargetRunId = nowSend.body.runId;
    const nowMessages = await waitForThreadMessages(
      actor,
      nowTargetThread.id,
      (events) => {
        return userMessages(events).some((event) => {
          return event.id === nowEventId;
        });
      },
    );
    const nowInput = userMessages(nowMessages.events).find(
      (event): event is PromptMessage => {
        return event.eventType === "input.prompt" && event.id === nowEventId;
      },
    );
    expect(nowInput?.userMessage.parts).toContainEqual({
      type: "source",
      kind: "agent",
      runId: source.runId,
      threadId: source.threadId,
      agentId,
      titleSnapshot: "New thread",
      href: `/chats/${source.threadId}#run-${source.runId}`,
    });
    const forgedTargetThread = await chat.createThread(actor, { agentId });
    const forgedEventId = randomUUID();
    const forged = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: forgedEventId,
        threadId: forgedTargetThread.id,
        prompt: "forged provenance",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "forged provenance" },
            {
              type: "source",
              kind: "agent",
              runId: randomUUID(),
              threadId: randomUUID(),
              agentId: randomUUID(),
              titleSnapshot: "Forged source",
              href: `/chats/${randomUUID()}#run-${randomUUID()}`,
            },
          ],
        },
      },
      [400],
    );
    expect(forged).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "BAD_REQUEST",
          message: "Agent source annotations are server-managed",
        },
      },
    });
    const messagesAfterForgedSend = await chat.listThreadEvents(
      actor,
      forgedTargetThread.id,
    );
    expect(messagesAfterForgedSend.events).not.toContainEqual(
      expect.objectContaining({ id: forgedEventId }),
    );

    await cancelChatRun(actor, nowTargetRunId);
    await cancelChatRun(actor, secondTargetRunId);
    await cancelChatRun(actor, firstTargetRunId);
    await cancelChatRun(actor, source.runId, sourceSandboxHeaders);
  }, 90_000);

  it("keeps Web context and tools for agent prompts sent into existing threads", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }

    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate into existing chat threads",
    });
    const { claim: sourceClaim, sandboxHeaders: sourceSandboxHeaders } =
      await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim);

    const rotatedAnchorPrompt = "prior Web round before an agent rotation";
    const rotatedAnchor = await sendChatRun(actor, {
      agentId,
      prompt: rotatedAnchorPrompt,
      model: "claude-sonnet-5",
    });
    const rotatedAnchorClaim = await claimChatRun(
      runnerGroup,
      rotatedAnchor.runId,
    );
    const originalBinding = await readThreadSessionBinding(
      context,
      rotatedAnchor.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the Web anchor to bind a session");
    }

    const { providerId: codexProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "agent-web-semantics-openai-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-terra",
        isDefault: false,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: codexProviderId,
      },
    ]);
    await chat.updateThreadModelSelection(
      actor,
      rotatedAnchor.threadId,
      "gpt-5.6-terra",
    );

    const rotatedEventId = randomUUID();
    const rotatedQueued = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: rotatedEventId,
        threadId: rotatedAnchor.threadId,
        prompt: "agent prompt after the Web session rotates",
      },
      [201],
    );
    if (rotatedQueued.status !== 201) {
      throw new Error("Expected the rotated agent prompt to queue");
    }
    expect(rotatedQueued.body.runId).toBeNull();

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(
      rotatedAnchor.runId,
      rotatedAnchorClaim.sandboxHeaders,
    );
    const rotatedMessages = await waitForThreadMessages(
      actor,
      rotatedAnchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === rotatedEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const rotatedRunId = userMessages(rotatedMessages.events).find(
      (message) => {
        return message.revokesEventId === rotatedEventId;
      },
    )?.runId;
    if (!rotatedRunId) {
      throw new Error("Expected the rotated agent prompt to be promoted");
    }
    const rotatedRun = await api.readRun(actor, rotatedRunId);
    const rotatedSystemPrompt = rotatedRun.appendSystemPrompt ?? "";
    const rotatedState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: rotatedRunId,
      },
      context.signal,
    );
    expect(rotatedState.agent_run).toMatchObject({ triggerSource: "agent" });
    expect(rotatedSystemPrompt).toContain("# Web Chat Run Context");
    expect(rotatedSystemPrompt).toContain("# This Run's Trigger");
    expect(rotatedSystemPrompt).toContain(`SOURCE_RUN_ID: ${source.runId}`);
    expect(rotatedSystemPrompt).toContain(
      `SOURCE_THREAD_ID: ${source.threadId}`,
    );
    expect(rotatedSystemPrompt).toContain(rotatedAnchorPrompt);
    expect(rotatedSystemPrompt).not.toContain("# Incomplete Rounds Context");
    expect(rotatedSystemPrompt).toContain("Web chat files: use");
    expect(rotatedSystemPrompt).toContain(
      "Cross-integration messages from web chat",
    );
    expect(rotatedSystemPrompt).toContain(
      CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET,
    );
    const rotatedBinding = await readThreadSessionBinding(
      context,
      rotatedAnchor.threadId,
    );
    expect(rotatedBinding.agent_session_id).not.toBe(
      originalBinding.agent_session_id,
    );
    const rotatedClaim = await claimChatRun(runnerGroup, rotatedRunId);
    expect(rotatedClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, rotatedRunId, rotatedClaim.sandboxHeaders);

    const incompletePrompt = "failed Web round before an agent retry";
    const incomplete = await sendChatRun(actor, {
      agentId,
      prompt: incompletePrompt,
    });
    const incompleteClaim = await claimChatRun(runnerGroup, incomplete.runId);
    const incompleteEventId = randomUUID();
    const incompleteQueued = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: incompleteEventId,
        threadId: incomplete.threadId,
        prompt: "agent prompt after an incomplete Web round",
      },
      [201],
    );
    if (incompleteQueued.status !== 201) {
      throw new Error("Expected the incomplete agent prompt to queue");
    }
    expect(incompleteQueued.body.runId).toBeNull();

    await failChatRun(
      incomplete.runId,
      incompleteClaim.sandboxHeaders,
      "expected incomplete Web round",
    );
    const incompleteMessages = await waitForThreadMessages(
      actor,
      incomplete.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === incompleteEventId &&
            message.runId !== undefined
          );
        });
      },
    );
    const incompleteRunId = userMessages(incompleteMessages.events).find(
      (message) => {
        return message.revokesEventId === incompleteEventId;
      },
    )?.runId;
    if (!incompleteRunId) {
      throw new Error("Expected the incomplete agent prompt to be promoted");
    }
    const incompleteRun = await api.readRun(actor, incompleteRunId);
    const incompleteSystemPrompt = incompleteRun.appendSystemPrompt ?? "";
    const incompleteState = await runStateStore.set(
      readAgentRunState$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        runId: incompleteRunId,
      },
      context.signal,
    );
    expect(incompleteState.agent_run).toMatchObject({ triggerSource: "agent" });
    expect(incompleteSystemPrompt).toContain("# Web Chat Run Context");
    expect(incompleteSystemPrompt).toContain(incompletePrompt);
    expect(incompleteSystemPrompt).not.toContain("# Incomplete Rounds Context");
    expect(incompleteSystemPrompt).toContain("Web chat files: use");
    const promotedIncompleteClaim = await claimChatRun(
      runnerGroup,
      incompleteRunId,
    );
    expect(promotedIncompleteClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(
      actor,
      incompleteRunId,
      promotedIncompleteClaim.sandboxHeaders,
    );
    await cancelChatRun(actor, source.runId, sourceSandboxHeaders);
  }, 90_000);

  it("blocks cross-thread delegation from a zero-budget run", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const target = await chat.createThread(actor, { agentId });
    const blockedTarget = await chat.createThread(actor, { agentId });
    const root = await sendChatRun(actor, {
      agentId,
      prompt: "start bounded delegation",
    });
    const rootClaim = await claimChatRun(runnerGroup, root.runId);
    await setRunAutonomyBudgetFixture(context, root.runId, 1);

    const delegated = await requestSendEventWithBearer(
      okouTokenFromClaim(rootClaim.claim),
      {
        agentId,
        clientEventId: randomUUID(),
        threadId: target.id,
        prompt: "last allowed delegation",
      },
      [201],
    );
    if (delegated.status !== 201 || delegated.body.runId === null) {
      throw new Error("Expected the last allowed delegation to create a run");
    }
    await expect(
      readRunAutonomyBudgetFixture(context, delegated.body.runId),
    ).resolves.toBe(0);

    await completeChatRunOk(root.runId, rootClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const delegatedClaim = await claimChatRun(
      runnerGroup,
      delegated.body.runId,
    );

    const blockedEventId = randomUUID();
    const blocked = await requestSendEventWithBearer(
      okouTokenFromClaim(delegatedClaim.claim),
      {
        agentId,
        clientEventId: blockedEventId,
        threadId: blockedTarget.id,
        prompt: "delegation beyond the limit",
      },
      [409],
    );
    expect(blocked).toMatchObject({
      status: 409,
      body: {
        error: { code: "AUTONOMY_BUDGET_EXHAUSTED" },
      },
    });
    const targetMessages = await chat.listThreadEvents(actor, blockedTarget.id);
    expect(targetMessages.events).not.toContainEqual(
      expect.objectContaining({ id: blockedEventId }),
    );

    await completeChatRunOk(
      delegated.body.runId,
      delegatedClaim.sandboxHeaders,
    );
    await flushWaitUntilForTest();
  }, 90_000);

  it("derives real-agent preview mode when queued messages are claimed", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor");
    }
    const actorWithOrg = { ...actor, orgId: actor.orgId };
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: false,
    });

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "preview override queue anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const previewMessageId = randomUUID();
    const previewFileId = randomUUID();
    chat.mockCompletedUploadObject(
      actor,
      previewFileId,
      "preview-notes.txt",
      18,
    );
    const previewQueued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued real-agent preview run",
        clientEventId: previewMessageId,
        realAgentInPreview: true,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: previewFileId,
              filenameSnapshot: "preview-notes.txt",
              contentType: "text/plain",
            },
            { type: "text", text: "queued real-agent preview run" },
          ],
        },
      },
      [201],
    );
    expect(previewQueued.body).toMatchObject({ runId: null });
    const replayedPreviewMessageId = randomUUID();
    await replayPendingChatInputQueueEventFixture({
      eventId: previewMessageId,
      replacementId: replayedPreviewMessageId,
    });
    const mockMessageId = randomUUID();
    const mockQueued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued preview mock run",
        clientEventId: mockMessageId,
        realAgentInPreview: true,
      },
      [201],
    );
    expect(mockQueued.body).toMatchObject({ runId: null });
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: true,
    });

    // Terminal callbacks and the cleanup safety sweep use the same queued
    // auto-send builder; finishing the anchor guarantees that builder owns both.
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const previewMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === replayedPreviewMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const previewRunId = userMessages(previewMessages.events).find(
      (message) => {
        return message.revokesEventId === replayedPreviewMessageId;
      },
    )?.runId;
    if (!previewRunId) {
      throw new Error("Expected the preview override message to auto-send");
    }

    const previewClaim = await claimChatRun(runnerGroup, previewRunId);
    expect(previewClaim.claim.prompt).toContain(
      "queued real-agent preview run",
    );
    expect(previewClaim.claim.prompt).toContain(`[ID] ${previewFileId}`);
    expect(previewClaim.claim.realAgentInPreview).toBeTruthy();
    await updateFeatureSwitchesForUser(context, actorWithOrg, {
      [FeatureSwitchKey.RealAgentInPreview]: false,
    });
    await cancelChatRun(actor, previewRunId, previewClaim.sandboxHeaders);

    const mockMessages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === mockMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const mockRunId = userMessages(mockMessages.events).find((message) => {
      return message.revokesEventId === mockMessageId;
    })?.runId;
    if (!mockRunId) {
      throw new Error("Expected the default preview message to auto-send");
    }

    const mockClaim = await claimChatRun(runnerGroup, mockRunId);
    expect(mockClaim.claim.prompt).toBe("queued preview mock run");
    expect(mockClaim.claim.realAgentInPreview).toBeUndefined();
    await cancelChatRun(actor, mockRunId);
  }, 90_000);

  it("projects additional info and inline templates into queued web launch material", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "inline-template queue anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const style = ILLUSTRATION_TEMPLATE_ITEMS[0];
    if (!style) {
      throw new Error("Expected a registered illustration style");
    }
    const queuedMessageId = randomUUID();
    const queuedUserMessage: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "additional_info",
          text: "Create an image.\nAspect ratio: 1:1.",
        },
        { type: "text", text: "Restyle with " },
        {
          type: "template",
          titleSnapshot: style.title,
          template: {
            type: "illustration",
            selection: { illustrationStyleId: style.illustrationStyleId },
          },
        },
        { type: "text", text: " at claim" },
      ],
    };
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queued inline template projection",
        userMessage: queuedUserMessage,
        clientEventId: queuedMessageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    // The terminal callback acknowledges before it drains the queue, and it
    // reports the template usage only after the auto-sent run is already
    // visible. Settle that background work so the assertions below observe the
    // finished dispatch instead of a half-built one.
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const queuedRunId = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    })?.runId;
    if (!queuedRunId) {
      throw new Error("Expected the queued template message to auto-send");
    }

    const run = await api.readRun(actor, queuedRunId);
    const inlineMarker = `[Template #1: ${style.title} (illustration)]`;
    expect(run.prompt).toBe(
      `Create an image.\nAspect ratio: 1:1.\n\nRestyle with ${inlineMarker} at claim`,
    );
    const webPrompt = [
      "# Current Integration\nYou are currently running inside: Web",
      "You are communicating with the user through the web chat UI.",
    ].join("\n\n");
    expect(run.appendSystemPrompt).toContain(webPrompt);
    expect(run.appendSystemPrompt).toContain("# This Chat Thread");
    expect(run.appendSystemPrompt).toContain(
      `- CHAT_THREAD_ID: ${anchor.threadId}`,
    );
    expect(run.appendSystemPrompt).toContain("# Inline Templates");
    expect(run.appendSystemPrompt).toContain(style.illustrationStyleId);

    const queuedClaim = await claimChatRun(runnerGroup, queuedRunId);
    expect(queuedClaim.claim.prompt).toBe(run.prompt);
    expect(queuedClaim.claim.appendSystemPrompt).toBe(run.appendSystemPrompt);
    await cancelChatRun(actor, queuedRunId, queuedClaim.sandboxHeaders);
  }, 90_000);

  it("appends a claimed queued message after messages that are still queued", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "multiple queue order anchor",
    });

    const firstId = randomUUID();
    const firstPrompt = "first queued transcript message";
    const first = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: firstPrompt,
        clientEventId: firstId,
      },
      [201],
    );
    expect(first.body).toMatchObject({ runId: null });

    const secondId = randomUUID();
    const secondPrompt = "second queued transcript message";
    const second = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: secondPrompt,
        clientEventId: secondId,
      },
      [201],
    );
    expect(second.body).toMatchObject({ runId: null });

    await cancelChatRun(actor, anchor.runId);
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === firstId && message.runId !== undefined
          );
        });
      },
    );
    const users = userMessages(messages.events);
    const firstOriginal = users.find((message) => {
      return message.id === firstId;
    });
    const firstClaimed = users.find((message) => {
      return message.revokesEventId === firstId;
    });
    if (!firstOriginal || !firstClaimed?.runId) {
      throw new Error("Expected the first queued message to be claimed");
    }
    expect(Date.parse(firstClaimed.createdAt)).toBeGreaterThan(
      Date.parse(firstOriginal.createdAt),
    );

    const replacedIds = new Set(
      users.flatMap((message) => {
        return message.revokesEventId ? [message.revokesEventId] : [];
      }),
    );
    const visibleQueuedPrompts = users
      .filter((message) => {
        return (
          !replacedIds.has(message.id) &&
          (chatEventDisplayText(message) === firstPrompt ||
            chatEventDisplayText(message) === secondPrompt)
        );
      })
      .map((message) => {
        return chatEventDisplayText(message);
      });
    expect(visibleQueuedPrompts).toStrictEqual([secondPrompt, firstPrompt]);

    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: secondId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    await cancelChatRun(actor, firstClaimed.runId);
  }, 90_000);

  it("dispatches an idle send while thread-list publication is pending", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const publicationStarted = createDeferredPromise<void>(context.signal);
    const releasePublication = createDeferredPromise<void>(context.signal);
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "threadListChanged") {
        if (!publicationStarted.settled()) {
          publicationStarted.resolve(undefined);
        }
        return releasePublication.promise;
      }
      return Promise.resolve(undefined);
    });

    const prompt = "dispatch while thread list publication is pending";
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt,
        clientEventId: randomUUID(),
      },
      [201],
    );
    let sendSettled = false;
    const sendOutcome = send.then(
      (value) => {
        sendSettled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        sendSettled = true;
        return { ok: false as const, error };
      },
    );
    onTestFinished(async () => {
      if (!releasePublication.settled()) {
        releasePublication.resolve(undefined);
      }
      await sendOutcome;
    });

    await publicationStarted.promise;
    await expect
      .poll(() => {
        return sendSettled;
      })
      .toBeTruthy();
    expect(releasePublication.settled()).toBeFalsy();
    const outcome = await sendOutcome;
    if (!outcome.ok) {
      throw outcome.error;
    }
    const sent = outcome.value;
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the pending publication not to gate dispatch");
    }
    await waitForRunUserMessage(
      actor,
      sent.body.threadId,
      sent.body.runId,
      prompt,
    );

    await expect
      .poll(async () => {
        const runList = await api.listAgentRuns(actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          limit: 100,
        });
        return runList.runs.some((run) => {
          return run.prompt === prompt;
        });
      })
      .toBe(true);

    const threadListPublishes = context.mocks.ably.publish.mock.calls.filter(
      ([topic]) => {
        return topic === "threadListChanged";
      },
    );
    expect(threadListPublishes).toHaveLength(1);
    releasePublication.resolve(undefined);
    await cancelChatRun(actor, sent.body.runId);
  }, 90_000);

  it("keeps a queued send drainable when thread-list publication fails", async () => {
    const { actor, agentId } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "thread list publication failure anchor",
    });
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some(([topic]) => {
          return topic === "threadListChanged";
        });
      })
      .toBe(true);
    context.mocks.ably.publish.mockClear();

    let failedThreadListPublish = false;
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      if (topic === "threadListChanged" && !failedThreadListPublish) {
        failedThreadListPublish = true;
        return Promise.reject(new Error("thread list publication failed"));
      }
      return Promise.resolve(undefined);
    });

    const queuedMessageId = randomUUID();
    const queuedBody = {
      agentId,
      threadId: anchor.threadId,
      prompt: "queued send survives thread list publication failure",
      clientEventId: queuedMessageId,
    };
    const queued = await chat.requestSendEvent(actor, queuedBody, [201]);
    expect(queued.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    expect(failedThreadListPublish).toBeTruthy();

    const retried = await chat.requestSendEvent(actor, queuedBody, [201]);
    expect(retried.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });
    const threadListPublishes = context.mocks.ably.publish.mock.calls.filter(
      ([topic]) => {
        return topic === "threadListChanged";
      },
    );
    expect(threadListPublishes).toHaveLength(1);

    await cancelChatRun(actor, anchor.runId);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedMessageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedMessageId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to remain drainable");
    }
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("serializes a terminal drain against an inline queue-first send", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "terminal drain race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    await webhooks.requestAgentEvents(
      {
        runId: anchor.runId,
        events: [
          {
            type: "assistant",
            sequenceNumber: 0,
            message: {
              content: [
                { type: "text", text: "terminal callback race complete" },
              ],
            },
          },
        ],
      },
      anchorClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();

    const terminalPrompt = "terminal drain owns the queue head";
    const terminalMessageId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: terminalPrompt,
        clientEventId: terminalMessageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    // The terminal drain owns the existing queue head and reaches final run
    // admission before the inline send joins the same boundary.
    await expect.poll(admissionLock.waiterCount).toBe(1);

    const inlinePrompt = "inline send waits behind the terminal drain";
    const inlineMessageId = randomUUID();
    const send = chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: inlinePrompt,
        clientEventId: inlineMessageId,
      },
      [201],
    );
    await expect
      .poll(async () => {
        const messages = await chat.listThreadEvents(actor, anchor.threadId);
        return messages.events.some((message) => {
          return message.id === inlineMessageId;
        });
      })
      .toBe(true);
    await expect.poll(admissionLock.waiterCount).toBe(2);
    admissionLock.release();

    const sent = await send;
    await admissionLock.done;
    await flushWaitUntilForTest();
    expect(sent.body).toMatchObject({ runId: null });

    const messages = await chat.listThreadEvents(actor, anchor.threadId);
    const claimed = userMessages(messages.events).filter((message) => {
      return (
        message.revokesEventId === terminalMessageId &&
        message.runId !== undefined
      );
    });
    expect(claimed).toHaveLength(1);
    const claimedRunId = claimed[0]?.runId;
    if (!claimedRunId) {
      throw new Error("Expected the terminal drain to own the queue head");
    }
    const inline = userMessages(messages.events).find((message) => {
      return message.id === inlineMessageId;
    });
    if (!inline) {
      throw new Error("Expected the inline queued message");
    }
    expect(inline.runId).toBeUndefined();

    const runList = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    const candidates = runList.runs.filter((run) => {
      return run.prompt === terminalPrompt || run.prompt === inlinePrompt;
    });
    expect(candidates).toStrictEqual([
      expect.objectContaining({
        id: claimedRunId,
        prompt: terminalPrompt,
        status: expect.stringMatching(/^(queued|pending|running)$/),
      }),
    ]);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: inlineMessageId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(recalled.body).toMatchObject({ runId: null });
    await cancelChatRun(actor, claimedRunId);
  }, 90_000);

  it("preserves an appended claim when recall races the queue drain", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "recall claim race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const messageId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "recall races the appended claim",
        clientEventId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Pin the completion-triggered queue-first drain at run admission, then
    // make the claim and recall queue behind the exact message row in a
    // test-owned order.
    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });
    const eventQueueLock = await holdChatEventQueueItemFixture({
      threadId: anchor.threadId,
      eventId: messageId,
      signal: context.signal,
    });

    onTestFinished(async () => {
      admissionLock.release();
      eventQueueLock.release();
      await Promise.all([admissionLock.done, eventQueueLock.done]);
    });

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "recall claim race complete"),
    ]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await expect.poll(admissionLock.waiterCount).toBe(1);
    admissionLock.release();
    await admissionLock.done;
    await expect.poll(eventQueueLock.directBlockedWaiterCount).toBe(1);

    const recall = Promise.allSettled([
      chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: anchor.threadId,
          revokesEventId: messageId,
          clientEventId: randomUUID(),
        },
        [400],
      ),
    ]);
    await expect.poll(eventQueueLock.blockedWaiterCount).toBe(2);
    eventQueueLock.release();

    const [recallResult] = await recall;
    if (recallResult.status === "rejected") {
      throw recallResult.reason;
    }
    const recalled = recallResult.value;
    expectApiError(recalled.body);
    expect(recalled.body.error.message).toBe(
      "Only queued user messages can be recalled",
    );
    await eventQueueLock.done;
    await flushWaitUntilForTest();

    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === messageId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const claimed = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId;
    });
    if (!claimed?.runId) {
      throw new Error("Expected the queue drain to append a claimed message");
    }
    const original = userMessages(messages.events).find((message) => {
      return message.id === messageId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();
    expect(claimed.content).toBeNull();
    expect(chatEventDisplayText(claimed)).toBe(
      "recall races the appended claim",
    );

    await cancelChatRun(actor, claimed.runId);
  }, 90_000);

  it("lets recall win before an atomic queue-first drain", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped actor for queue serialization");
    }
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "recall-first queue race anchor",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const prompt = "recall wins the atomic queue-first race";
    const messageId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt,
        clientEventId: messageId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    const admissionLock = await holdOrgAdmissionLockFixture({
      orgId: actor.orgId,
      signal: context.signal,
    });

    // Stage the completion-triggered queue-first drain at org admission, then
    // let recall append before it can claim the queued message.
    onTestFinished(async () => {
      admissionLock.release();
      await admissionLock.done;
    });

    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "recall-first queue race complete"),
    ]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      lastEventSequence: 0,
    });
    await expect.poll(admissionLock.waiterCount).toBe(1);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: messageId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(recalled.body).toMatchObject({
      runId: null,
      threadId: anchor.threadId,
    });

    admissionLock.release();
    await admissionLock.done;
    await flushWaitUntilForTest();

    const messages = await chat.listThreadEvents(actor, anchor.threadId);
    expect(userMessages(messages.events)).toContainEqual(
      expect.objectContaining({
        content: null,
        revokesEventId: messageId,
      }),
    );
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === messageId && message.runId;
      }),
    ).toHaveLength(0);

    const runList = await api.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      runList.runs.filter((run) => {
        return run.prompt === prompt;
      }),
    ).toHaveLength(0);

    const recalledEvent = userMessages(messages.events).find((message) => {
      return message.revokesEventId === messageId && !message.runId;
    });
    if (recalledEvent === undefined) {
      throw new Error("Expected the winning recall event");
    }
    const probeEventId = randomUUID();
    const probe = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "append after the lost queue claim",
        clientEventId: probeEventId,
      },
      [201],
    );
    if (probe.status !== 201) {
      throw new Error("Expected the post-race probe event to be accepted");
    }
    const afterProbe = await chat.listThreadEvents(actor, anchor.threadId);
    const probeEvent = userMessages(afterProbe.events).find((message) => {
      return message.id === probeEventId;
    });
    if (probeEvent === undefined) {
      throw new Error("Expected the post-race probe event");
    }
    expect(probeEvent.seqId).toBe(recalledEvent.seqId + 1);
    if (probe.body.runId !== null) {
      await cancelChatRun(actor, probe.body.runId);
    }
  }, 90_000);

  it("appends replacements on auto-send and keeps queued recalls idempotent", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "queue-first anchor run",
    });
    const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first waits for the anchor",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // A second queued message can be recalled before dispatch.
    const recalledId = randomUUID();
    const toRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first message to recall",
        clientEventId: recalledId,
      },
      [201],
    );
    expect(toRecall.body).toMatchObject({ runId: null });
    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: recalledId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(recalled.body).toMatchObject({ runId: null });

    // A repeated recall stays idempotent.
    const repeatedRecall = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        revokesEventId: recalledId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({ runId: null });

    // Completing the anchor auto-sends the queued message by appending a
    // run-associated replacement while preserving the queued row.
    context.mocks.ably.publish.mockClear();
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId &&
            typeof message.runId === "string"
          );
        });
      },
    );
    const promoted = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!promoted?.runId) {
      throw new Error("Expected the queued message to append a replacement");
    }
    expect(promoted.content).toBeNull();
    expect(chatEventDisplayText(promoted)).toBe(
      "queue-first waits for the anchor",
    );
    const original = userMessages(messages.events).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();
    expect(Date.parse(promoted.createdAt)).toBeGreaterThan(
      Date.parse(original.createdAt),
    );
    const appended = await chat.listThreadEvents(actor, anchor.threadId, {
      sinceEventId: original.id,
      sinceSeqId: original.seqId,
    });
    expect(appended.events).toContainEqual(
      expect.objectContaining({
        id: promoted.id,
        revokesEventId: queuedId,
        runId: promoted.runId,
      }),
    );
    await expect
      .poll(() => {
        return context.mocks.ably.publish.mock.calls.some((call) => {
          return call[0] === `chatThreadMessageCreated:${anchor.threadId}`;
        });
      })
      .toBe(true);

    const followUp = await api.readRun(actor, promoted.runId);
    expect(followUp.prompt).toContain("queue-first waits for the anchor");
    expect(followUp.appendSystemPrompt ?? "").not.toContain(
      "queue-first message to recall",
    );
    await cancelChatRun(actor, promoted.runId);
  }, 90_000);

  it("auto-fires queued messages after cancellation recovery completes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "queue-first anchor to cancel",
    });
    const { sandboxHeaders } = await claimChatRun(runnerGroup, anchor.runId);

    const queuedId = randomUUID();
    const queued = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: anchor.threadId,
        prompt: "queue-first fires after cancel",
        clientEventId: queuedId,
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });

    // Cancellation is public immediately, but a claimed run keeps the thread
    // barrier until the runner reports cancellation recovery.
    await api.requestCancelRun(actor, anchor.runId, [200]);
    await waitForRunStatus(actor, anchor.runId, "cancelled");
    const beforeRecovery = await chat.listThreadEvents(actor, anchor.threadId);
    expect(
      userMessages(beforeRecovery.events).filter((message) => {
        return (
          message.revokesEventId === queuedId && message.runId !== undefined
        );
      }),
    ).toHaveLength(0);

    await failChatRun(anchor.runId, sandboxHeaders, "Run cancelled");
    await flushWaitUntilForTest();
    const messages = await waitForThreadMessages(
      actor,
      anchor.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === queuedId &&
            typeof message.runId === "string" &&
            message.runId !== anchor.runId
          );
        });
      },
    );
    const fired = userMessages(messages.events).find((message) => {
      return message.revokesEventId === queuedId;
    });
    if (!fired?.runId) {
      throw new Error("Expected the queued message to fire after cancel");
    }
    expect(fired.content).toBeNull();
    expect(chatEventDisplayText(fired)).toBe("queue-first fires after cancel");
    const original = userMessages(messages.events).find((message) => {
      return message.id === queuedId;
    });
    if (!original) {
      throw new Error("Expected the original queued message");
    }
    expect(original.runId).toBeUndefined();

    const followUp = await api.readRun(actor, fired.runId);
    expect(followUp.prompt).toContain("queue-first fires after cancel");
    await cancelChatRun(actor, fired.runId);
  }, 90_000);
});

/** Creation-time pinning is org-scoped, so a video test resolves the org too. */
async function videoModelSelectionActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
}> {
  const { actor, agentId } = await entitledChatActor();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an entitled chat actor to own an org");
  }
  return { actor, agentId, orgId };
}

describe("CHAT-02: run media model snapshot precedence", () => {
  it("resolves video and image fallback independently", async () => {
    const { actor, agentId } = await videoModelSelectionActor();
    await chat.updateUserModelPreference(
      actor,
      null,
      "gpt-image-2",
      "MiniMax-H3",
    );

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run for mixed media model precedence",
    });
    await cancelChatRun(actor, anchor.runId);

    await chat.updateThreadVideoModel(
      actor,
      anchor.threadId,
      "fal-ai/veo3.1/fast",
    );
    await chat.updateThreadImageModel(actor, anchor.threadId, null);
    const imageFallback = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "thread video with member image fallback",
    });
    await expect(readRunVideoModelFixture(imageFallback.runId)).resolves.toBe(
      "fal-ai/veo3.1/fast",
    );
    await expect(
      readRunImageModelSnapshotFixture(imageFallback.runId),
    ).resolves.toBe("gpt-image-2");
    await cancelChatRun(actor, imageFallback.runId);

    await chat.updateThreadVideoModel(actor, anchor.threadId, null);
    await chat.updateThreadImageModel(
      actor,
      anchor.threadId,
      "fal-ai/qwen-image",
    );
    const videoFallback = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "member video fallback with thread image",
    });
    await expect(readRunVideoModelFixture(videoFallback.runId)).resolves.toBe(
      "MiniMax-H3",
    );
    await expect(
      readRunImageModelSnapshotFixture(videoFallback.runId),
    ).resolves.toBe("fal-ai/qwen-image");
    await cancelChatRun(actor, videoFallback.runId);
  }, 90_000);
});

describe("CHAT-02: run video model snapshot", () => {
  it("pins a thread at creation and resolves later runs through that pin", async () => {
    const { actor, agentId, orgId } = await videoModelSelectionActor();

    const catalogDefault = await sendChatRun(actor, {
      agentId,
      prompt: "a thread created with no member default takes the catalog one",
    });
    await expect(readRunVideoModelFixture(catalogDefault.runId)).resolves.toBe(
      DEFAULT_VIDEO_MODEL,
    );
    await cancelChatRun(actor, catalogDefault.runId);

    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "MiniMax-H3",
    });

    // The pin the thread already carries survives the new member default. A
    // thread that followed the live default would answer "MiniMax-H3" here.
    const afterDefaultChanged = await sendChatRun(actor, {
      agentId,
      threadId: catalogDefault.threadId,
      prompt: "an existing thread keeps the model it was created with",
    });
    await expect(
      readRunVideoModelFixture(afterDefaultChanged.runId),
    ).resolves.toBe(DEFAULT_VIDEO_MODEL);
    await cancelChatRun(actor, afterDefaultChanged.runId);

    // A thread created after the change does take the new member default.
    const memberDefault = await sendChatRun(actor, {
      agentId,
      prompt: "a thread created later takes the member default",
    });
    await expect(readRunVideoModelFixture(memberDefault.runId)).resolves.toBe(
      "MiniMax-H3",
    );
    await cancelChatRun(actor, memberDefault.runId);

    await setChatThreadVideoModelFixture(
      catalogDefault.threadId,
      "fal-ai/veo3.1/fast",
    );
    const threadPinned = await sendChatRun(actor, {
      agentId,
      threadId: catalogDefault.threadId,
      prompt: "video model comes from the thread pin",
    });
    await expect(readRunVideoModelFixture(threadPinned.runId)).resolves.toBe(
      "fal-ai/veo3.1/fast",
    );

    // Re-pinning while that run is still in flight must not reach it. This is
    // the whole reason the model is snapshotted onto the run instead of being
    // read back off the thread when generation happens.
    await setChatThreadVideoModelFixture(
      catalogDefault.threadId,
      "dreamina-seedance-2-5-260628",
    );
    await expect(readRunVideoModelFixture(threadPinned.runId)).resolves.toBe(
      "fal-ai/veo3.1/fast",
    );
    await cancelChatRun(actor, threadPinned.runId);

    // The next run does pick the re-pinned model up.
    const rePinned = await sendChatRun(actor, {
      agentId,
      threadId: catalogDefault.threadId,
      prompt: "the run after the re-pin uses the new thread pin",
    });
    await expect(readRunVideoModelFixture(rePinned.runId)).resolves.toBe(
      "dreamina-seedance-2-5-260628",
    );
    await cancelChatRun(actor, rePinned.runId);
  }, 90_000);

  it("still follows the member default for a thread that predates the pin", async () => {
    const { actor, agentId, orgId } = await videoModelSelectionActor();

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run that creates the thread",
    });
    await cancelChatRun(actor, anchor.runId);

    // Clearing the pin reproduces the state of a thread created before
    // creation-time pinning. Those rows were deliberately left alone, so they
    // keep reading the live member default.
    await chat.updateThreadVideoModel(actor, anchor.threadId, null);
    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "MiniMax-H3",
    });

    const legacy = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "a thread with no pin follows the member default",
    });
    await expect(readRunVideoModelFixture(legacy.runId)).resolves.toBe(
      "MiniMax-H3",
    );
    await cancelChatRun(actor, legacy.runId);
  }, 90_000);

  it("keeps falling back past video models the catalog no longer lists", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an entitled chat actor to own an org");
    }
    // Persisted pins are projected out of jsonb without being re-validated, so
    // a run can start against an id that has since left the catalog.
    const retiredVideoModel = "dreamina-seedance-1-0-retired";

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run that creates the thread",
    });
    await cancelChatRun(actor, anchor.runId);

    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "seedance-1-5-pro-251215",
    });
    await setChatThreadVideoModelFixture(anchor.threadId, retiredVideoModel);
    const retiredThreadPin = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "retired thread pin falls through to the member default",
    });
    await expect(
      readRunVideoModelFixture(retiredThreadPin.runId),
    ).resolves.toBe("seedance-1-5-pro-251215");
    await cancelChatRun(actor, retiredThreadPin.runId);

    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: retiredVideoModel,
    });
    const retiredEverywhere = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "two retired pins fall through to the catalog default",
    });
    await expect(
      readRunVideoModelFixture(retiredEverywhere.runId),
    ).resolves.toBe(DEFAULT_VIDEO_MODEL);
    await cancelChatRun(actor, retiredEverywhere.runId);

    // `in` on a normal object also matches inherited Object.prototype keys.
    // Persisted strings must match an own catalog id exactly.
    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "MiniMax-H3",
    });
    await setChatThreadVideoModelFixture(anchor.threadId, "toString");
    const inheritedObjectKey = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "an inherited object key is not a catalog model",
    });
    await expect(
      readRunVideoModelFixture(inheritedObjectKey.runId),
    ).resolves.toBe("MiniMax-H3");
    await cancelChatRun(actor, inheritedObjectKey.runId);
  }, 90_000);

  it("snapshots a video model onto runs that own no chat thread", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an entitled chat actor to own an org");
    }

    // Non-chat triggers such as telegram leave chat_thread_id null. Those runs
    // have no thread layer to read and must still resolve rather than fail.
    const withoutPreference = await api.createRun(actor, {
      agentId,
      prompt: "threadless run without any video model preference",
      modelProvider: "anthropic-api-key",
    });
    await expect(
      readRunChatThreadIdFixture(withoutPreference.runId),
    ).resolves.toBeNull();
    await expect(
      readRunVideoModelFixture(withoutPreference.runId),
    ).resolves.toBe(DEFAULT_VIDEO_MODEL);
    await cancelChatRun(actor, withoutPreference.runId);

    await setOrgMemberVideoModelFixture({
      orgId,
      userId: actor.userId,
      selectedVideoModel: "MiniMax-H3",
    });
    const withMemberDefault = await api.createRun(actor, {
      agentId,
      prompt: "threadless run picks up the member default",
      modelProvider: "anthropic-api-key",
    });
    await expect(
      readRunChatThreadIdFixture(withMemberDefault.runId),
    ).resolves.toBeNull();
    await expect(
      readRunVideoModelFixture(withMemberDefault.runId),
    ).resolves.toBe("MiniMax-H3");
    await cancelChatRun(actor, withMemberDefault.runId);
  }, 90_000);
});

/** The image snapshot is org-scoped, so these tests resolve the org too. */
async function imageModelSnapshotActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly orgId: string;
  readonly runnerGroup: string;
}> {
  const { actor, agentId, runnerGroup } = await entitledChatActor();
  const orgId = actor.orgId;
  if (!orgId) {
    throw new Error("Expected an entitled chat actor to own an org");
  }
  return { actor, agentId, orgId, runnerGroup };
}

describe("CHAT-02: run image model snapshot", () => {
  it("resolves thread, member, and global image defaults into stable snapshots", async () => {
    const { actor, agentId, runnerGroup } = await imageModelSnapshotActor();

    const globalDefault = await sendChatRun(actor, {
      agentId,
      prompt: "image model comes from the global default",
    });
    await expect(
      readRunImageModelSnapshotFixture(globalDefault.runId),
    ).resolves.toBe(DEFAULT_IMAGE_MODEL);
    await cancelChatRun(actor, globalDefault.runId);

    await chat.updateUserModelPreference(actor, null, "fal-ai/qwen-image");

    // The thread was pinned when it was created, so the new member default
    // does not reach back into it.
    const afterDefaultChanged = await sendChatRun(actor, {
      agentId,
      threadId: globalDefault.threadId,
      prompt: "an existing thread keeps the image model it was created with",
    });
    await expect(
      readRunImageModelSnapshotFixture(afterDefaultChanged.runId),
    ).resolves.toBe(DEFAULT_IMAGE_MODEL);
    await cancelChatRun(actor, afterDefaultChanged.runId);

    const memberDefault = await sendChatRun(actor, {
      agentId,
      prompt: "a thread created later takes the member default",
    });
    await expect(
      readRunImageModelSnapshotFixture(memberDefault.runId),
    ).resolves.toBe("fal-ai/qwen-image");
    await cancelChatRun(actor, memberDefault.runId);

    const initialThreadPin = "fal-ai/bytedance/seedream/v4/text-to-image";
    await chat.updateThreadImageModel(
      actor,
      globalDefault.threadId,
      initialThreadPin,
    );
    const threadPinned = await sendChatRun(actor, {
      agentId,
      threadId: globalDefault.threadId,
      prompt: "image model comes from the thread pin",
    });
    await expect(
      readRunImageModelSnapshotFixture(threadPinned.runId),
    ).resolves.toBe(initialThreadPin);

    const nextThreadPin = "fal-ai/nano-banana-2";
    await chat.updateThreadImageModel(
      actor,
      globalDefault.threadId,
      nextThreadPin,
    );
    await expect(
      readRunImageModelSnapshotFixture(threadPinned.runId),
    ).resolves.toBe(initialThreadPin);
    const threadPinnedPrompt =
      (await api.readRun(actor, threadPinned.runId)).appendSystemPrompt ?? "";
    expect(threadPinnedPrompt).toContain("# Default built-in image model");
    expect(threadPinnedPrompt).toContain(
      "This run's default built-in image model is `seedream4`.",
    );
    expect(threadPinnedPrompt).toContain(
      "Only when the current user request explicitly names another supported built-in image model, pass `--model <model>`.",
    );
    expect(threadPinnedPrompt).toContain(
      "Otherwise omit `--model`; the server applies `seedream4`.",
    );
    expect(threadPinnedPrompt).toContain(
      "Image generation through a connected third-party service chooses its model separately; this default does not apply to that path.\n\n# Restricted Explicit Content",
    );
    await cancelChatRun(actor, threadPinned.runId);

    const rePinned = await sendChatRun(actor, {
      agentId,
      threadId: globalDefault.threadId,
      prompt: "the next run sees the updated image model pin",
    });
    await expect(
      readRunImageModelSnapshotFixture(rePinned.runId),
    ).resolves.toBe(nextThreadPin);
    const { claim: rePinnedClaim } = await claimChatRun(
      runnerGroup,
      rePinned.runId,
    );
    expect(claimEnvironment(rePinnedClaim)[DEFAULT_IMAGE_MODEL_ENV]).toBe(
      "nano-banana-2",
    );
    await cancelChatRun(actor, rePinned.runId);
  }, 90_000);

  it("falls through image model IDs that the catalog no longer supports", async () => {
    const { actor, agentId, orgId } = await imageModelSnapshotActor();
    const retiredImageModel = "fal-ai/retired-image-model";

    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "anchor run for retired image model storage",
    });
    await cancelChatRun(actor, anchor.runId);

    await chat.updateUserModelPreference(actor, null, "gpt-image-2");
    // Current preference routes reject retired IDs, so this test alone injects
    // the historical stored values whose fallback behavior it exercises.
    await setRetiredChatThreadImageModelFixture(
      anchor.threadId,
      retiredImageModel,
    );
    const retiredThreadPin = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "retired thread image model falls through to the member",
    });
    await expect(
      readRunImageModelSnapshotFixture(retiredThreadPin.runId),
    ).resolves.toBe("gpt-image-2");
    await cancelChatRun(actor, retiredThreadPin.runId);

    await setRetiredOrgMemberImageModelFixture({
      orgId,
      userId: actor.userId,
      retiredImageModel,
    });
    const retiredEverywhere = await sendChatRun(actor, {
      agentId,
      threadId: anchor.threadId,
      prompt: "retired image defaults fall through to the global default",
    });
    await expect(
      readRunImageModelSnapshotFixture(retiredEverywhere.runId),
    ).resolves.toBe(DEFAULT_IMAGE_MODEL);
    await cancelChatRun(actor, retiredEverywhere.runId);
  }, 90_000);

  it("persists the image snapshot when dispatch fails before runner start", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();
    await chat.updateUserModelPreference(actor, null, "gpt-image-2");
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);

    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "image snapshot survives pre-runner dispatch failure",
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the failed dispatch to create a run");
    }
    expect(sent.body.status).toBe("failed");
    await expect(
      readRunImageModelSnapshotFixture(sent.body.runId),
    ).resolves.toBe("gpt-image-2");
  }, 90_000);

  it("persists the resolved image model on a queued run", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();
    await chat.updateUserModelPreference(actor, null, "fal-ai/qwen-image");
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");

    const blocker = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "occupy image snapshot concurrency" },
      [201],
    );
    if (blocker.status !== 201 || blocker.body.runId === null) {
      throw new Error("Expected the blocking send to create a run");
    }
    expect(blocker.body.status).toBe("pending");

    const queued = await chat.requestSendEvent(
      actor,
      { agentId, prompt: "queue an image model snapshot" },
      [201],
    );
    if (queued.status !== 201 || queued.body.runId === null) {
      throw new Error("Expected the second send to create a queued run");
    }
    expect(queued.body.status).toBe("queued");
    await expect(
      readRunImageModelSnapshotFixture(queued.body.runId),
    ).resolves.toBe("fal-ai/qwen-image");

    await cancelChatRun(actor, queued.body.runId);
    await cancelChatRun(actor, blocker.body.runId);
  }, 90_000);

  it("snapshots direct runs and re-resolves on session continuation", async () => {
    const { actor, agentId } = await imageModelSnapshotActor();

    const first = await api.createRun(actor, {
      agentId,
      prompt: "direct image model snapshot",
      modelProvider: "anthropic-api-key",
    });
    await expect(readRunImageModelSnapshotFixture(first.runId)).resolves.toBe(
      DEFAULT_IMAGE_MODEL,
    );

    await chat.updateUserModelPreference(actor, null, "fal-ai/flux-pro/v1.1");
    const resumed = await api.createRun(actor, {
      agentId,
      sessionId: first.sessionId,
      prompt: "continued session image model snapshot",
      modelProvider: "anthropic-api-key",
    });
    expect(resumed.sessionId).toBe(first.sessionId);
    await expect(readRunImageModelSnapshotFixture(resumed.runId)).resolves.toBe(
      "fal-ai/flux-pro/v1.1",
    );
    await expect(readRunImageModelSnapshotFixture(first.runId)).resolves.toBe(
      DEFAULT_IMAGE_MODEL,
    );

    await cancelChatRun(actor, first.runId);
    await cancelChatRun(actor, resumed.runId);
  }, 90_000);
});

function configureNativeCliArtifact(): string {
  const commit = "a".repeat(40);
  const url = `https://static.okou.io/okou-cli/${commit}/package.tgz`;
  mockEnv("PI_MEMORY_STAGE1_IDLE_DELAY_MS", 60_000);
  mockEnv("GIT_COMMIT_SHA", commit);
  mockEnv("CLI_PKG_URL", url);
  return url;
}

function nativeMessagesResponse(model: string, answer: string, tool = false) {
  const events = [
    {
      type: "message_start",
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "route-bound reasoning" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "route-bound-signature" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: tool
        ? { type: "tool_use", id: randomUUID(), name: "read", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: '{"path":"/home/user/workspace/AGENTS.md"}',
          }
        : { type: "text_delta", text: answer },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn" },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  return new HttpResponse(
    events
      .map((event) => {
        return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function nativeBedrockResponse(tool = false) {
  function frame(event: string, payload: unknown): Buffer {
    const headers = Buffer.concat(
      Object.entries({
        ":message-type": "event",
        ":event-type": event,
        ":content-type": "application/json",
      }).map(([name, value]) => {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(Buffer.byteLength(value));
        return Buffer.concat([
          Buffer.from([name.length]),
          Buffer.from(name),
          Buffer.from([7]),
          length,
          Buffer.from(value),
        ]);
      }),
    );
    const body = Buffer.from(JSON.stringify(payload));
    const prefix = Buffer.alloc(12);
    prefix.writeUInt32BE(16 + headers.length + body.length);
    prefix.writeUInt32BE(headers.length, 4);
    prefix.writeUInt32BE(crc32(prefix.subarray(0, 8)), 8);
    const data = Buffer.concat([prefix, headers, body]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(data));
    return Buffer.concat([data, checksum]);
  }
  return new HttpResponse(
    new Uint8Array(
      Buffer.concat([
        frame("messageStart", { role: "assistant" }),
        ...(tool
          ? [
              frame("contentBlockStart", {
                contentBlockIndex: 0,
                start: {
                  toolUse: { toolUseId: "native-bedrock-tool", name: "read" },
                },
              }),
            ]
          : []),
        frame("contentBlockDelta", {
          contentBlockIndex: 0,
          delta: tool
            ? { toolUse: { input: '{"path":"README.md"}' } }
            : { text: "Exact Bedrock deployment answer" },
        }),
        frame("contentBlockStop", { contentBlockIndex: 0 }),
        frame("messageStop", { stopReason: tool ? "tool_use" : "end_turn" }),
        frame("metadata", {
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 2,
            totalTokens: 13,
          },
        }),
      ]),
    ),
    {
      headers: {
        "content-type": "application/vnd.amazon.eventstream",
        "x-amzn-requestid": "selected-bedrock-response",
      },
    },
  );
}

async function completeNativeToolHandoff({
  actor,
  agentId,
  run,
  claim,
  objects,
  prefix,
  model,
  surfaceId,
  requests,
}: {
  actor: ApiTestUser;
  agentId: string;
  run: Awaited<ReturnType<typeof sendChatRun>>;
  claim: Awaited<ReturnType<typeof api.claimRunnerJob>>;
  objects: Map<string, Buffer>;
  prefix: string;
  model: "claude-sonnet-4-6";
  surfaceId: string | null;
  requests: readonly { body: unknown }[];
}): Promise<void> {
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  const activeInput = "include this native active input exactly once";
  const activeInputEventId = randomUUID();
  await chat.requestSendEvent(
    actor,
    {
      agentId,
      threadId: run.threadId,
      prompt: activeInput,
      clientEventId: activeInputEventId,
    },
    [201],
  );
  const reserved = await api.reserveRunnerActiveInputs(
    claim.sandboxToken,
    run.runId,
  );
  if (reserved.outcome !== "reserved") {
    throw new Error("Expected native active input ownership");
  }
  await expect(
    api.reserveRunnerActiveInputs(claim.sandboxToken, run.runId),
  ).resolves.toStrictEqual(reserved);
  await expect(
    api.recordRunnerActiveInputDelivery(
      claim.sandboxToken,
      run.runId,
      reserved.deliveryId,
    ),
  ).resolves.toStrictEqual({ outcome: "delivered" });
  const h1 = objects.get(`${prefix}/session.jsonl`);
  const manifestBytes = objects.get(`${prefix}/manifest.json`);
  if (!h1 || !manifestBytes) {
    throw new Error("Expected native handoff history");
  }
  const manifest = piApiFirstTurnManifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const history = MemoryPiSession.fromJsonl(h1.toString("utf8"));
  const assistant = history.buildSessionContext().messages.at(-1);
  if (assistant?.role !== "assistant") {
    throw new Error("Expected native pending assistant");
  }
  const tool = assistant.content.find((block) => {
    return block.type === "toolCall";
  });
  if (tool?.type !== "toolCall") {
    throw new Error("Expected native pending tool");
  }
  history.appendMessage({
    role: "toolResult",
    toolCallId: tool.id,
    toolName: tool.name,
    content: [
      { type: "text", text: "native tool result" },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=",
      },
    ],
    isError: false,
    timestamp: 2,
  });
  history.appendMessage({
    role: "user",
    content: activeInput,
    timestamp: 3,
  });
  history.appendMessage({
    ...assistant,
    content: [{ type: "text", text: "Native sandbox completion" }],
    stopReason: "stop",
    timestamp: 3,
  });
  const h2 = history.toJsonl();
  const hash = createHash("sha256").update(h2).digest("hex");
  await webhooks.requestAgentCheckpointPrepareHistory(
    {
      runId: run.runId,
      hash,
      rawSize: Buffer.byteLength(h2),
      encodedSize: Buffer.byteLength(h2),
      encoding: "identity",
    },
    sandboxHeaders,
    [200],
  );
  objects.set(
    `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${hash}.blob`,
    Buffer.from(h2),
  );
  const sequence = manifest.sandboxEventSequenceStart;
  await webhooks.requestAgentEvents(
    {
      runId: run.runId,
      events: [
        {
          type: "assistant",
          sequenceNumber: sequence,
          message: {
            content: [{ type: "text", text: "Native sandbox completion" }],
          },
        },
        {
          type: "result",
          sequenceNumber: sequence + 1,
          result: "Native sandbox completion",
        },
      ],
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: run.runId,
      exitCode: 0,
      lastEventSequence: sequence + 1,
      checkpoint: {
        cliAgentType: "pi",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryHash: hash,
      },
    },
    sandboxHeaders,
    [200],
  );
  await waitForRunStatus(actor, run.runId, "completed");
  await flushWaitUntilForTest();
  await expectExactPrivatePiMemoryAdmission({
    orgId: requireOrgId(actor),
    userId: actor.userId,
    runId: run.runId,
  });
  await api.updateOrgModelPolicies(actor, [
    {
      model,
      isDefault: true,
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
    },
  ]);
  await authDeviceSupport.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PiLoop]: true,
  });
  const resumed = await sendChatRun(actor, {
    agentId,
    threadId: run.threadId,
    prompt: "continue with the native tool image and accepted input",
  });
  await expect
    .poll(() => {
      return objects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${resumed.runId}/manifest.json`,
      );
    })
    .toBe(true);
  await flushWaitUntilForTest();
  expect(JSON.stringify(requests[1]?.body)).toContain("image/png");
  expect(JSON.stringify(requests[1]?.body)).toContain(activeInput);
  expect(JSON.stringify(requests[1]?.body)).toContain("route-bound-signature");
  await cancelChatRun(actor, resumed.runId);
}

describe("shared native Pi route activation", () => {
  it.each([
    {
      type: "deepseek",
      model: "deepseek-v4-flash",
      url: "https://api.deepseek.com/responses",
    },
    {
      type: "deepseek",
      model: "deepseek-v4-pro",
      url: "https://api.deepseek.com/responses",
    },
    {
      type: "openrouter-codex",
      model: "deepseek-v4-flash",
      url: "https://openrouter.ai/api/v1/responses",
    },
    {
      type: "openrouter-codex",
      model: "deepseek-v4-pro",
      url: "https://openrouter.ai/api/v1/responses",
    },
  ] as const)(
    "launches canonical $type $model Responses and continues the owned Pi session",
    async ({ type, model, url }) => {
      const { actor, agentId } = await entitledChatActor();
      const { providerId } = await upsertOrgModelProvider(actor, {
        type,
        secret: "selected-deepseek-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(url, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer selected-deepseek-key",
          );
          requests.push(await request.json());
          return new HttpResponse(
            piResponsesTextSse("DeepSeek BYOK answer", requests.length),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const first = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "remember the selected DeepSeek route",
      });
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with the same history",
      });
      await waitForRunStatus(actor, second.runId, "completed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        model: getProviderRuntimeModel(type, model),
      });
      expect(JSON.stringify(requests[1])).toContain(
        "remember the selected DeepSeek route",
      );
      await expectNoBuiltInModelUsage(first.runId);
      await expectNoBuiltInModelUsage(second.runId);
    },
    90_000,
  );

  it.each(piNativeCatalogModelSchema.options)(
    "runs built-in %s API-first with native billing and exact session continuation",
    async (model) => {
      const { actor, agentId } = await entitledChatActor();
      configureNativeCliArtifact();
      await configureBuiltInPiModel(actor, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.ChatReasoningEffort]: true,
      });
      const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(
          "https://api.anthropic.com/v1/messages",
          async ({ request }) => {
            expect(request.headers.get("x-api-key")).toBeTruthy();
            expect(request.headers.get("authorization")).toBeNull();
            requests.push(await request.json());
            return nativeMessagesResponse(model, "Native Claude answer");
          },
        ),
      );
      const first = await sendChatRun(
        actor,
        {
          agentId,
          model,
          prompt: "retain this Claude native preference",
          runOptions: { reasoningEffort: "low" },
        },
        pricing,
      );
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      await expectExactPrivatePiMemoryAdmission({
        orgId: requireOrgId(actor),
        userId: actor.userId,
        runId: first.runId,
      });
      const nextEffort = model === "claude-sonnet-4-6" ? "high" : "extra";
      await chat.updateThreadModelSelection(actor, first.threadId, model, {
        reasoningEffort: nextEffort,
      });
      const second = await sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: "continue the native session",
        },
        pricing,
      );
      await waitForRunStatus(actor, second.runId, "completed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ model });
      expect(JSON.stringify(requests[0])).toContain('"effort":"low"');
      expect(JSON.stringify(requests[1])).toContain(
        `"effort":"${nextEffort === "extra" ? "xhigh" : "high"}"`,
      );
      await expect(
        chat.readThreadMetadata(actor, first.threadId),
      ).resolves.toMatchObject({
        modelSettings: { [model]: { effort: nextEffort } },
      });
      expect(JSON.stringify(requests[1])).toContain(
        "retain this Claude native preference",
      );
      expect(JSON.stringify(requests[1])).toContain("route-bound-signature");
      for (const run of [first, second]) {
        await expectPiApiUsage(run.runId, model, "", {
          input: 5,
          output: 3,
          cacheRead: 3,
          cacheCreation: 2,
        });
        await api.requestClaimRunnerJob(true, run.runId, [404], {
          capabilities: { piModelConfigGenerations: [4] },
        });
      }
      expect(
        [...objects.values()].some((value) => {
          return value.toString("utf8").includes(first.threadId);
        }),
      ).toBeTruthy();
    },
    90_000,
  );

  it.each([
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
    "custom-anthropic-messages",
    "azure-foundry",
  ] as const)(
    "hands off $0 with the same native route, frozen auth and capable claims",
    async (type) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const cliUrl = configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const secret = "selected-native-key";
      const upstreamModel =
        type === "azure-foundry" || type === "custom-anthropic-messages"
          ? "production-deployment"
          : getProviderRuntimeModel(type, model);
      let providerId: string | null = null;
      let surfaceId: string | null = null;
      if (type === "custom-anthropic-messages") {
        const created = await accept(
          modelProviderConnectionsClient().create({
            headers: sessionHeaders(actor),
            body: {
              displayName: "Native selected surface",
              secret,
              surfaces: [
                {
                  protocol: "anthropic-messages",
                  apiBaseUrl: "https://native-gateway.example.com",
                  authHeaderName: "X-Provider-Key",
                  authHeaderTemplate: "Custom {{secret}}",
                  modelMappings: { [model]: upstreamModel },
                },
              ],
            },
          }),
          [201],
        );
        surfaceId = created.body.surfaces[0]?.id ?? null;
      } else {
        const created = await upsertOrgModelProvider(
          actor,
          type === "azure-foundry"
            ? {
                type,
                authMethod: "api-key",
                selectedModel: upstreamModel,
                secrets: {
                  ANTHROPIC_FOUNDRY_API_KEY: secret,
                  ANTHROPIC_FOUNDRY_RESOURCE: "native-resource",
                },
              }
            : { type, secret },
        );
        providerId = created.providerId;
      }
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
          modelProviderSurfaceId: surfaceId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const urls = {
        "anthropic-api-key": "https://api.anthropic.com/v1/messages",
        "openrouter-api-key": "https://openrouter.ai/api/v1/messages",
        "vercel-ai-gateway": "https://ai-gateway.vercel.sh/v1/messages",
        "custom-anthropic-messages":
          "https://native-gateway.example.com/v1/messages",
        "azure-foundry":
          "https://native-resource.services.ai.azure.com/anthropic/v1/messages",
      };
      const requests: {
        body: unknown;
        auth: string | null;
        key: string | null;
        custom: string | null;
      }[] = [];
      server.use(
        http.post(urls[type], async ({ request }) => {
          requests.push({
            body: await request.json(),
            auth: request.headers.get("authorization"),
            key: request.headers.get("x-api-key"),
            custom: request.headers.get("x-provider-key"),
          });
          return nativeMessagesResponse(upstreamModel, "", true);
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "read the workspace with the selected native route",
      });
      const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}`;
      await expect
        .poll(() => {
          return objects.has(`${prefix}/manifest.json`);
        })
        .toBe(true);
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(1);
      const bearer =
        type === "openrouter-api-key" || type === "vercel-ai-gateway";
      expect(requests[0]).toMatchObject({
        body: { model: upstreamModel },
        auth: bearer ? `Bearer ${secret}` : null,
        key:
          type === "anthropic-api-key" || type === "azure-foundry"
            ? secret
            : null,
        custom:
          type === "custom-anthropic-messages" ? `Custom ${secret}` : null,
      });
      if (type !== "custom-anthropic-messages") {
        await upsertOrgModelProvider(
          actor,
          type === "azure-foundry"
            ? {
                type,
                authMethod: "api-key",
                secrets: {
                  ANTHROPIC_FOUNDRY_API_KEY: "rotated-native-secret",
                  ANTHROPIC_FOUNDRY_RESOURCE: "rotated-resource",
                },
              }
            : { type, secret: "rotated-native-secret" },
        );
      }
      await configureBuiltInPiModel(actor, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: false,
      });
      await api.heartbeatRunner(runnerGroup);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "pending",
      });
      await api.requestClaimRunnerJob(true, run.runId, [400], {
        capabilities: undefined,
      });
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      const result = await api.requestClaimRunnerJob(true, run.runId, [200], {
        capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
      });

      if (result.status !== 200) {
        throw new Error("Expected native-capable claim");
      }
      const claim = result.body;
      const config = piModelConfigV4Schema.parse(claim.piModelConfig);
      expect(config).toMatchObject({
        route: type,
        catalogModel: model,
        model: upstreamModel,
        credentialOwner: "organization",
        billingOwner: "user",
      });
      expect(piNativeInferenceUrl(config)).toBe(urls[type]);
      expect(claim.cliAgentType).toBe("pi");
      expect(claim.piSessionId).toBe(run.threadId);
      expect(claim.platformEnvironment.CLI_PKG_URL).toBe(cliUrl);
      expect(claimEnvironment(claim).OKOU_PI_NATIVE_API_KEY).toBe(
        PI_NATIVE_CREDENTIAL_PLACEHOLDER,
      );
      expect(JSON.stringify(claim)).not.toContain(secret);
      expect(claim.billableFirewalls).toStrictEqual([]);
      const expectedFirewall = piNativeFirewall(config);
      expect(claim.firewalls).toContainEqual({
        kind: "inline",
        firewall: expect.objectContaining({
          name: expectedFirewall.name,
          apis: expectedFirewall.apis,
        }),
      });
      if (!claim.encryptedSecrets || config.dialect !== "anthropic-messages") {
        throw new Error("Expected encrypted native Messages credentials");
      }
      const binding = config.credentialBindings[0];
      if (!binding) {
        throw new Error("Missing native binding");
      }
      const header = binding.credentialHeader;
      const auth = await createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${claim.sandboxToken}` },
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            [header.name]: header.valueTemplate.replace(
              "{{secret}}",
              secretTemplate(binding.secretName),
            ),
          },
        },
        [200],
      );
      expect(auth.body).toMatchObject({
        headers: {
          [header.name]: header.valueTemplate.replace("{{secret}}", secret),
        },
        resolvedSecrets: [binding.secretName],
      });
      await expectNoBuiltInModelUsage(run.runId);
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      if (type === "custom-anthropic-messages") {
        await completeNativeToolHandoff({
          actor,
          agentId,
          run,
          claim,
          objects,
          prefix,
          model,
          surfaceId,
          requests,
        });
      } else {
        await cancelChatRun(actor, run.runId, sandboxHeaders);
      }
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      const terminal = (
        await chat.listThreadEvents(actor, run.threadId)
      ).events.filter((event) => {
        return (
          "runId" in event &&
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      });
      expect(terminal).toHaveLength(1);
      await expectNoBuiltInModelUsage(run.runId);
      expect(requests).toHaveLength(
        type === "custom-anthropic-messages" ? 2 : 1,
      );
    },
    90_000,
  );
  it.each(["api-key", "access-keys", "temporary-access-keys"] as const)(
    "uses only the configured Bedrock %s region, profile and credential bundle",
    async (mode) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const profile =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/production";
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: "aws-bedrock",
        authMethod: mode === "api-key" ? "api-key" : "access-keys",
        selectedModel: profile,
        secrets:
          mode === "api-key"
            ? {
                AWS_BEARER_TOKEN_BEDROCK: "selected-bedrock-bearer",
                AWS_REGION: "us-east-1",
              }
            : {
                AWS_ACCESS_KEY_ID: "AKIASELECTED",
                AWS_SECRET_ACCESS_KEY: "selected-aws-secret",
                AWS_REGION: "us-east-1",
                ...(mode === "temporary-access-keys"
                  ? { AWS_SESSION_TOKEN: "selected-session-token" }
                  : {}),
              },
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: "aws-bedrock",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      let requests = 0;
      server.use(
        http.post(
          "https://bedrock-runtime.us-east-1.amazonaws.com/*",
          async ({ request }) => {
            requests += 1;
            expect(decodeURIComponent(new URL(request.url).pathname)).toBe(
              `/model/${profile}/converse-stream`,
            );
            expect(request.headers.get("x-api-key")).toBeNull();
            if (mode === "api-key") {
              expect(request.headers.get("authorization")).toBe(
                "Bearer selected-bedrock-bearer",
              );
            } else {
              expect(request.headers.get("authorization")).toContain(
                "Credential=AKIASELECTED/",
              );
            }
            expect(request.headers.get("x-amz-security-token")).toBe(
              mode === "temporary-access-keys"
                ? "selected-session-token"
                : null,
            );
            await expect(request.json()).resolves.toMatchObject({
              messages: expect.any(Array),
            });
            return nativeBedrockResponse(requests === 2);
          },
        ),
      );
      const first = await sendChatRun(actor, {
        agentId,
        model,
        prompt: "use the explicit Bedrock profile",
      });
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
      await expectNoBuiltInModelUsage(first.runId);
      await expectExactPrivatePiMemoryAdmission({
        orgId: requireOrgId(actor),
        userId: actor.userId,
        runId: first.runId,
      });
      expect(requests).toBe(1);
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with a tool on the same Bedrock profile",
      });
      await expect
        .poll(() => {
          return objects.has(
            `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`,
          );
        })
        .toBe(true);
      await flushWaitUntilForTest();
      await upsertOrgModelProvider(actor, {
        type: "aws-bedrock",
        authMethod: "api-key",
        secrets: {
          AWS_BEARER_TOKEN_BEDROCK: "rotated-bedrock-key",
          AWS_REGION: "us-west-2",
        },
      });
      await api.heartbeatRunner(runnerGroup);
      await api.requestClaimRunnerJob(true, second.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      const claim = await api.claimRunnerJob(second.runId, {
        capabilities: { piModelConfigGenerations: [4] },
      });
      const config = piModelConfigV4Schema.parse(claim.piModelConfig);
      expect(config).toMatchObject({
        route: "aws-bedrock",
        catalogModel: model,
        model: profile,
        region: "us-east-1",
        authMode: mode === "api-key" ? "bearer" : "sigv4",
      });
      for (const binding of config.credentialBindings) {
        expect(claimEnvironment(claim)[binding.environment]).toBe(
          PI_NATIVE_CREDENTIAL_PLACEHOLDER,
        );
      }
      for (const key of [
        "AWS_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
      ]) {
        expect(claimEnvironment(claim)).not.toHaveProperty(key);
      }
      expect(JSON.stringify(claim)).not.toMatch(
        /selected-bedrock-bearer|AKIASELECTED|selected-aws-secret|selected-session-token|rotated-bedrock-key/u,
      );
      const auth = piNativeFirewall(config).apis[0]?.auth;
      if (!auth || !claim.encryptedSecrets) {
        throw new Error("Expected exact Bedrock egress auth");
      }
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      const resolved = await createFirewallApi(context).requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: auth.headers ?? {},
          ...(auth.awsSigv4 ? { authAwsSigv4: auth.awsSigv4 } : {}),
        },
        [200],
      );
      expect(resolved.body).toMatchObject(
        mode === "api-key"
          ? { headers: { Authorization: "Bearer selected-bedrock-bearer" } }
          : {
              awsSigv4: {
                accessKeyId: "AKIASELECTED",
                secretAccessKey: "selected-aws-secret",
                ...(mode === "temporary-access-keys"
                  ? { sessionToken: "selected-session-token" }
                  : {}),
              },
            },
      );
      expect(requests).toBe(2);
      await expectNoBuiltInModelUsage(second.runId);
      await cancelChatRun(actor, second.runId, sandboxHeaders);
    },
    90_000,
  );

  it.each(["old-cli", "subscription-key", "wrong-region"] as const)(
    "rejects %s before native provider I/O",
    async (boundary) => {
      const { actor, agentId } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const type =
        boundary === "wrong-region" ? "aws-bedrock" : "anthropic-api-key";
      const { providerId } = await upsertOrgModelProvider(
        actor,
        boundary === "wrong-region"
          ? {
              type: "aws-bedrock",
              authMethod: "api-key",
              selectedModel:
                "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/wrong-region",
              secrets: {
                AWS_BEARER_TOKEN_BEDROCK: "selected-bearer",
                AWS_REGION: "us-east-1",
              },
            }
          : {
              type: "anthropic-api-key",
              secret:
                boundary === "subscription-key"
                  ? "sk-ant-oat01-subscription-secret"
                  : "selected-native-key",
            },
      );
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: type,
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      if (boundary === "old-cli") {
        mockEnv(
          "CLI_PKG_URL",
          `https://static.okou.io/okou-cli/${"b".repeat(40)}/package.tgz`,
        );
      }
      let calls = 0;
      server.use(
        http.post("https://api.anthropic.com/*", () => {
          calls += 1;
          return nativeMessagesResponse(model, "must not run");
        }),
        http.post("https://bedrock-runtime.us-east-1.amazonaws.com/*", () => {
          calls += 1;
          return nativeBedrockResponse();
        }),
      );
      const response = await chat.requestSendEvent(
        actor,
        {
          agentId,
          model,
          prompt: "reject the invalid native route",
          clientEventId: randomUUID(),
        },
        [201, 400, 422, 503],
      );
      await flushWaitUntilForTest();
      expect({ status: response.status, body: response.body }).toMatchObject({
        status: 400,
      });
      expect(calls).toBe(0);
    },
    90_000,
  );

  it.each(["in-flight", "late-result"] as const)(
    "keeps native cancellation and billing owned at the %s boundary",
    async (phase) => {
      const { actor, agentId } = await entitledChatActor();
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      await configureBuiltInPiModel(actor, model);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let requests = 0;
      server.use(
        http.post("https://api.anthropic.com/v1/messages", async () => {
          requests += 1;
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          return nativeMessagesResponse(
            model,
            "discard cancelled native output",
          );
        }),
      );
      const run = await sendChatRun(
        actor,
        { agentId, model, prompt: "cancel the native request" },
        pricing,
      );
      await entered.promise;
      if (phase === "late-result") {
        await cancelBeforeLatePiResult(
          actor,
          run.runId,
          () => {
            release.resolve(undefined);
          },
          pricing,
        );
      } else {
        await api.requestCancelRun(actor, run.runId, [200], pricing);
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "cancelled");
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      if (phase === "late-result") {
        await expectPiApiUsage(run.runId, model, "", {
          input: 5,
          output: 3,
          cacheRead: 3,
          cacheCreation: 2,
        });
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [4] },
      });
      expect(requests).toBe(1);
    },
    90_000,
  );

  it("does not switch the captured native route after a provider authentication failure", async () => {
    const { actor, agentId } = await entitledChatActor();
    configureNativeCliArtifact();
    const model = "claude-sonnet-4-6";
    await configureBuiltInPiModel(actor, model);
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    let directCalls = 0;
    let alternateCalls = 0;
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () => {
        directCalls += 1;
        return HttpResponse.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "selected credential rejected",
            },
          },
          { status: 401 },
        );
      }),
      http.post("https://openrouter.ai/*", () => {
        alternateCalls += 1;
        return nativeMessagesResponse(model, "forbidden alternate");
      }),
    );
    const run = await sendChatRun(actor, {
      agentId,
      model,
      prompt: "retain the selected route on failure",
    });
    await waitForRunStatus(actor, run.runId, "failed");
    await flushWaitUntilForTest();
    expect(directCalls).toBe(1);
    expect(alternateCalls).toBe(0);
    await api.requestClaimRunnerJob(true, run.runId, [404], {
      capabilities: { piModelConfigGenerations: [4] },
    });
  }, 90_000);

  it("captures the managed OpenRouter Claude key before API ownership and charges native categories once", async () => {
    const { actor, agentId } = await entitledChatActor();
    configureNativeCliArtifact();
    const model = "claude-sonnet-4-6";
    const withSelectedRoute = await configureBuiltInPiModelOnOpenRouter(
      actor,
      model,
    );
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    let openRouterCalls = 0;
    let anthropicCalls = 0;
    server.use(
      http.post("https://api.anthropic.com/*", () => {
        anthropicCalls += 1;
        return nativeMessagesResponse(model, "unselected");
      }),
      http.post(
        "https://openrouter.ai/api/v1/messages",
        async ({ request }) => {
          openRouterCalls += 1;
          expect(request.headers.get("authorization")).toMatch(/^Bearer .+/u);
          expect(request.headers.get("x-api-key")).toBeNull();
          await expect(request.json()).resolves.toMatchObject({
            model: "anthropic/claude-sonnet-4.6",
          });
          return nativeMessagesResponse(
            "anthropic/claude-sonnet-4.6",
            "Managed native response",
          );
        },
      ),
    );
    const run = await withSelectedRoute(() => {
      return sendChatRun(
        actor,
        { agentId, model, prompt: "use the selected managed OpenRouter route" },
        pricing,
      );
    });
    await waitForRunStatus(actor, run.runId, "completed");
    await flushWaitUntilForTest();
    expect(openRouterCalls).toBe(1);
    expect(anthropicCalls).toBe(0);
    await expectPiApiUsage(run.runId, model, "", {
      input: 5,
      output: 3,
      cacheRead: 3,
      cacheCreation: 2,
    });
  }, 90_000);
  it.each(["schedule", "event"] as const)(
    "uses the shared native %s Automation handoff, completion and owned memory path",
    async (source) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor(
        {},
        source === "event" ? "team" : "pro",
      );
      configureNativeCliArtifact();
      const model = "claude-sonnet-4-6";
      const { providerId } = await upsertOrgModelProvider(actor, {
        type: "anthropic-api-key",
        secret: "selected-automation-key",
      });
      await api.updateOrgModelPolicies(actor, [
        {
          model,
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      const pricing = await createPiApiFirstTurnUsagePricingResolution(model);
      const workflows = createWorkflowsBddApi(context);
      const workflowId = await workflows.createWorkflow(actor, {
        agentId,
        name: `native-source-${source}`,
      });
      const created = await accept(
        threadPiAutomationsClient().create({
          headers: sessionHeaders(actor),
          params: { workflowId },
          body:
            source === "schedule"
              ? { schedule: { type: "loop", intervalSeconds: 3600 } }
              : { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      );
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const automation = created.body;
      let threadId: string;
      if (
        automation.kind === "event" &&
        automation.eventType === "webhook-received" &&
        automation.webhookUrl &&
        automation.webhookSecret &&
        automation.chatThreadId
      ) {
        const event = {
          webhookUrl: automation.webhookUrl,
          webhookSecret: automation.webhookSecret,
          payload: "native event",
          timestamp: Math.floor(now() / 1000),
          usagePricingResolution: pricing,
        };
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          { duplicate: false },
        );
        await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject(
          { duplicate: true },
        );
        threadId = automation.chatThreadId;
      } else {
        const started = await accept(
          threadPiAutomationsClient().run({
            headers: sessionHeaders(actor),
            params: { id: automation.id },
          }),
          [201],
        );
        threadId = started.body.chatThreadId;
      }
      const runId = await lastThreadPiAutomationRun(actor, threadId);
      await flushWaitUntilForTest();
      await api.heartbeatRunner(runnerGroup);
      await api.requestClaimRunnerJob(true, runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      const claim = await api.claimRunnerJob(runId, {
        capabilities: { piModelConfigGenerations: [4] },
      });
      expect(claim.piModelConfig).toMatchObject({
        schemaVersion: 4,
        route: "anthropic-api-key",
        catalogModel: model,
        billingOwner: "user",
      });
      const ownedClaim = {
        claim,
        sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
      };
      await completeSandboxFirstPiRun({
        actor,
        run: { runId, threadId },
        claim: ownedClaim,
        checkpointObjects: objects,
        prompt: claim.prompt,
        answer: `owned native ${source} completion`,
        nativeModel: model,
        usagePricingResolution: pricing,
      });
      await expectThreadPiTerminal(actor, threadId, runId);
      await expectExactPrivatePiMemoryAdmission({
        orgId: requireOrgId(actor),
        userId: actor.userId,
        runId,
      });
      await expectNoBuiltInModelUsage(runId);
    },
    90_000,
  );

  it("keeps official Claude member subscription credentials on Claude Code with Pi enabled", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const model = "claude-sonnet-4-6";
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "sk-ant-oat01-official-subscription",
      },
      [200, 201],
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model,
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    let nativeCalls = 0;
    server.use(
      http.post("https://api.anthropic.com/*", () => {
        nativeCalls += 1;
        return nativeMessagesResponse(model, "must not call Pi");
      }),
    );
    const run = await sendChatRun(actor, {
      agentId,
      model,
      prompt: "retain official Claude subscription ownership",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.cliAgentType).toBe("claude-code");
    expect(claim.piModelConfig).toBeUndefined();
    expect(claimEnvironment(claim).CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();
    expect(nativeCalls).toBe(0);
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  }, 90_000);
});
