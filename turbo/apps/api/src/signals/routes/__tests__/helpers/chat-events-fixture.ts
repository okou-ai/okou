import { piNativeCatalogModelSchema } from "@okouai/api-contracts/contracts/pi-native-models";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Header } from "tar";
import { getInstructionsStorageName } from "@okouai/core/storage-names";
import { readCanonicalAgentNameFixture } from "../../../../test-fixtures/canonical-agent-authority";
import { createStoragesBddApi } from "./api-bdd-storages";
import { storageTextFile } from "./api-bdd-storage-files";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  chatEventsContract,
  chatThreadsContract,
  type ChatEvent,
  type ChatRunOptionsRequest,
  type ChatThreadEvent,
  type GenerationTemplateRequest,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { modelProviderConnectionsMainContract } from "@okouai/api-contracts/contracts/model-provider-gateways";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import {
  getModelProviderFirewall,
  type UpsertModelProviderRequest,
  type ModelProviderType,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { replayChatThreadEvents } from "@okouai/core/chat-thread-event-replay";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { computeHmacSignature } from "../../../../lib/event-consumer/hmac";
import { server } from "../../../../mocks/server";
import { withBuiltInModelRuntimeRouteCandidateUnavailableForTest } from "../../../../test-fixtures/built-in-model-runtime-route";
import {
  holdPiApiFirstTurnLifecycleLockFixture,
  readRunUsageEventsFixture,
} from "../../../../test-fixtures/chat-events";
import {
  readmitPiMemoryStage1CandidateFixture,
  readPiConversationIdentityFixture,
  readPiMemoryStage1CandidateFixture,
} from "../../../../test-fixtures/pi-memory-stage1-candidates";
import { seededSystemSkillArchive } from "../../../../test-fixtures/seeded-system-skill-archive";
import {
  createUsagePricingFixture,
  type UsagePricingFixture,
} from "../../../../test-fixtures/usage-pricing";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { chatEventsRoutes } from "../../chat-events";
import { chatThreadRoutes } from "../../chat-threads";
import { mailRoutes } from "../../mail";
import { modelProviderGatewayRoutes } from "../../model-provider-gateways";
import { modelProvidersRoutes } from "../../model-providers";
import { webhooksWorkflowAutomationsRoutes } from "../../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../../workflow-automations";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./api-bdd";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./api-bdd-auth-device-support";
import { createChatCallbacksApi } from "./api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createConnectorBddApi } from "./api-bdd-connectors";
import { createMiscRoutesApi } from "./api-bdd-misc";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { chatEventDisplayText } from "./chat-event";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";
import {
  readRunLaunchSnapshotFixture,
  resolveBuiltInModelRouteFixture,
  seedBuiltInModelCandidateKeys,
  seedBuiltInModelKey as seedBuiltInModelKeyState,
} from "./runtime-state";

const TEST_APP_ROUTES = Object.freeze([
  ...chatEventsRoutes,
  ...chatThreadRoutes,
  ...mailRoutes,
  ...modelProviderGatewayRoutes,
  ...modelProvidersRoutes,
]);

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

export const CODEX_WEB_IMAGE_UPLOAD_PROMPT_SNIPPET =
  "okou web upload-file -f <path>";

export const API_FIRST_TURN_OWNERSHIP_BUDGET_MS = 45_000;

export const API_FIRST_TURN_COORDINATION_BUDGET_MS = 55_000;

const PI_API_FIRST_TURN_BASE_USAGE_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;

export const GPT_PI_BDD_MODELS = [
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
] as const;

export type PiGptBddModel = (typeof GPT_PI_BDD_MODELS)[number];

export const GPT_API_KEY_BDD_ROUTES = GPT_PI_BDD_MODELS.flatMap(
  (selectedModel) => {
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
  },
);

export const USER_OWNED_GPT_FAST_BDD_ROUTES = [
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

export type PiApiFirstTurnUsageProvider =
  | z.infer<typeof piNativeCatalogModelSchema>
  | "deepseek-v4-flash"
  | "deepseek-v4.1-flash"
  | "deepseek-v4-pro"
  | PiGptBddModel;

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

export type PromptMessage = Extract<ChatEvent, { eventType: "input.prompt" }>;

type OutputMessage = Extract<ChatEvent, { eventType: "output.message" }>;

export type RunnerClaim = Awaited<
  ReturnType<ReturnType<typeof createRunsApi>["claimRunnerJob"]>
>;

export interface EntitledChatActor {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly providerId: string;
}

export interface ChatRunSendBody {
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
export function userMessageWithTemplate(
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

export const openRouterBodySchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
  max_tokens: z.number().optional(),
  reasoning: z
    .object({ effort: z.enum(["none", "minimal", "low", "medium", "high"]) })
    .optional(),
});

export function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected entitled chat actor to have an org");
  }
  return actor.orgId;
}

export function totalChargedCredits(
  rows: readonly { readonly creditsCharged: number | null }[],
): number {
  return rows.reduce((total, row) => {
    if (row.creditsCharged === null) {
      throw new Error("Expected processed usage to have charged credits");
    }
    return total + row.creditsCharged;
  }, 0);
}

export async function expectPiApiUsage(
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

export async function expectTerraApiUsage(
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

export async function expectTerraApiFollowUpUsage(
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

export async function expectNoBuiltInModelUsage(runId: string): Promise<void> {
  // Operational usage rows have no production run-scoped read API. This
  // test-only observation is required to prove the user-owned no-charge
  // invariant rather than infer it from the public run status.
  await expect(readRunUsageEventsFixture(runId)).resolves.toStrictEqual([]);
}

export async function createGptUsagePricingResolution(): Promise<
  UsagePricingFixture["resolution"]
> {
  const pricing = await createUsagePricingFixture({
    configured: GPT_USAGE_PRICING,
  });
  onTestFinished(pricing.cleanup);
  return pricing.resolution;
}

export async function createPiApiFirstTurnUsagePricingResolution(
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

export function claimEnvironment(claim: RunnerClaim): Record<string, string> {
  return {
    ...claim.environment,
    ...claim.platformEnvironment,
  };
}

/** Sandbox-scoped Okou token issued through the trusted claim environment. */
export function okouTokenFromClaim(claim: RunnerClaim): string {
  const token = claimEnvironment(claim).OKOU_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error(
      "Expected the claim platform environment to carry an OKOU_TOKEN",
    );
  }
  return token;
}

/**
 * Checkpoint + exitCode-0 complete (completing without a checkpoint fails the
 * run).
 */
export interface ChatRunCompletionOptions {
  readonly activeInputDeliveryIds?: readonly string[];
  readonly cliAgentSessionId?: string;
  readonly cliAgentType?: "claude-code" | "codex" | "pi";
  readonly lastEventSequence?: number;
  readonly sessionHistory?: string;
  readonly usagePricingResolution?: UsagePricingFixture["resolution"];
}

export function assistantMessages(
  messages: readonly ChatEvent[],
): AssistantMessage[] {
  return messages.filter((message): message is AssistantMessage => {
    return !isUserMessage(message);
  });
}

export function userMessages(messages: readonly ChatEvent[]): UserMessage[] {
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

export function eventBackedContents(
  messages: readonly ChatEvent[],
  runId: string,
): OutputMessage[] {
  return messages.filter((message): message is OutputMessage => {
    return message.eventType === "output.message" && message.runId === runId;
  });
}

export function assistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    eventType: "assistant",
    sequenceNumber,
    eventData: { message: { content: [{ type: "text", text }] } },
  };
}

export function modelProviderSecretPlaceholder(
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

export async function expectExactPrivatePiMemoryAdmission(args: {
  readonly orgId: string;
  readonly runId: string;
  readonly userId: string;
}): Promise<void> {
  // Stage 1 candidates intentionally have no production read API. After the
  // real send and completion paths run, verify completion did not enqueue and
  // explicitly exercise the canonical writer's exact checkpoint ownership.
  const conversation = await readPiConversationIdentityFixture(args.runId);
  const beforeAdmission = await readPiMemoryStage1CandidateFixture({
    orgId: args.orgId,
    userId: args.userId,
  });
  expect(beforeAdmission?.sourceRunId).not.toBe(args.runId);
  await readmitPiMemoryStage1CandidateFixture(args.runId);
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
  ).toBe(0);
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

export interface PiCheckpointS3Command {
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

export function piS3ObjectKey(
  candidate: PiCheckpointS3Command,
): string | undefined {
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

export const PI_RESOURCE_ARCHIVE_DOWNLOAD_URL =
  "https://r2.example.com/storage/archive.tar.gz";

export function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export function piResponsesDeveloperPrompt(
  rawBody: string | undefined,
): string {
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

/** Create route helpers for one test file; the caller owns testContext() and its cleanup. */
export function createChatEventsFixture(context: TestContext) {
  const bdd = createBddApi(context);

  const api = createRunsApi(context);

  const chat = createChatFilesBddApi(context);

  const webhooks = createWebhookCallbackApi(context);

  const chatCallbacks = createChatCallbacksApi(context);

  const connectors = createConnectorBddApi(context);

  const misc = createMiscRoutesApi(context);

  const authDevice = createAuthDeviceApiActions(context);

  const authDeviceSupport = createAuthDeviceSupportApi(context);

  const routeMocks = createRouteMocks(context);

  const runStateStore = createStore();

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

  async function seedBuiltInModelKey(selectedModel: string): Promise<string> {
    const fixture = await seedBuiltInModelKeyState(context, selectedModel);
    return fixture.selectedModel;
  }

  async function configureBuiltInPiModel(
    actor: ApiTestUser,
    selectedModel: PiApiFirstTurnUsageProvider,
  ): Promise<void> {
    if (selectedModel === "deepseek-v4.1-flash") {
      configureNativeCliArtifact();
    }
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

  async function configureOrganizationGptModel(
    actor: ApiTestUser,
  ): Promise<void> {
    const { providerId } = await upsertOrgModelProvider(actor, {
      type: "openai-api-key",
      secret: "unused-organization-openai-key",
    });
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "gpt-5.6-terra",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
  }

  async function configureSubscriptionPiModel(
    actor: ApiTestUser,
    options: Parameters<typeof mockCodexDeviceAuthProvider>[0] = {},
    selectedModel: PiGptBddModel = "gpt-5.6-terra",
  ) {
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
      [FeatureSwitchKey.PiLoop]: true,
    });
    const oauth = mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      ...options,
    });
    const started = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      {
        mode: "add",
      },
    );
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
    const primary = await resolveBuiltInModelRouteFixture(
      context,
      selectedModel,
    );
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
          throw new Error(
            `Expected an OpenRouter fallback for ${selectedModel}`,
          );
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
      throw new Error(
        `Expected chat thread ${threadId} messages to be readable`,
      );
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
    const history =
      options.sessionHistory ?? `bdd chat session history ${runId}`;
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
    usagePricingResolution?: UsagePricingFixture["resolution"],
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const headers = sessionHeaders(actor);
    const app = createAppWithRoutes({
      signal,
      routes: TEST_APP_ROUTES,
      usagePricingResolution,
    });
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

  async function lastThreadPiAutomationRun(
    actor: ApiTestUser,
    threadId: string,
  ) {
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
      throw new Error(
        "Expected the instruction fixture archive to be verified",
      );
    }
    await context.mocks.s3.send(
      new PutObjectCommand({ ...upload, Body: archive }),
    );
    return content;
  }

  function mockPiResourceArchiveDownloads(
    unavailable = false,
    onRead?: () => void,
  ): void {
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
        onRead?.();
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
    readonly responsesModel?: {
      readonly provider: "openai" | "deepseek";
      readonly model: string;
    };
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
      provider: args.nativeModel
        ? "anthropic"
        : (args.responsesModel?.provider ?? "openai"),
      model: args.nativeModel ?? args.responsesModel?.model ?? "gpt-5.6-terra",
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
      { [FeatureSwitchKey.PiLoop]: true },
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

  return {
    bdd,
    api,
    chat,
    webhooks,
    chatCallbacks,
    connectors,
    misc,
    authDevice,
    authDeviceSupport,
    routeMocks,
    runStateStore,
    entitledChatActor,
    seedBuiltInModelKey,
    configureBuiltInPiModel,
    configureApiKeyGptPiModel,
    configureUserOwnedGptPiModel,
    configureOrganizationGptModel,
    configureSubscriptionPiModel,
    configureBuiltInPiModelOnOpenRouter,
    sendChatRun,
    expectThreadCreatedModelEvent,
    expectNoThreadModelUpdateEvent,
    claimChatRun,
    waitForThreadMessages,
    waitForRunUserMessage,
    waitForRunStatus,
    completeChatRunOk,
    failChatRun,
    cancelChatRun,
    modelProviderConnectionsClient,
    chatEventsClient,
    chatThreadsClient,
    sessionHeaders,
    upsertOrgModelProvider,
    readThreadProjection,
    requestSendEventRaw,
    requestSendEventWithBearer,
    threadPiAutomationsClient,
    postThreadPiAutomationEvent,
    lastThreadPiAutomationRun,
    expectThreadPiTerminal,
    claimGptPiSandbox,
    cancelBeforeLatePiResult,
    mockPiCheckpointObjectStore,
    expectNoPiApiFirstTurnArtifacts,
    expectPiApiFirstTurnTerminalWithoutOutput,
    uploadedPiS3Object,
    piS3Object,
    publishPendingPiInstructions,
    mockPiResourceArchiveDownloads,
    completeSandboxFirstPiRun,
    queueCapabilityProvenPiRun,
  };
}

export function configureNativeCliArtifact(): string {
  const commit = "a".repeat(40);
  const url = `https://static.okou.io/okou-cli/${commit}/package.tgz`;

  mockEnv("GIT_COMMIT_SHA", commit);
  mockEnv("CLI_PKG_URL", url);
  return url;
}
