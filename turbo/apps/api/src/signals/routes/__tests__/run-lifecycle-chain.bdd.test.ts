import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  builtinConnectorOauthStartContract,
  builtinConnectorsSearchContract,
} from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import {
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runContextContract,
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  runnersHeartbeatContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookHeartbeatContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookStripeContract,
  webhookTelemetryContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getCustomConnectorSkillName } from "@okouai/core/storage-names";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { array, literal, object, string, type infer as zInfer } from "zod";

import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { featureSwitchesRoutes } from "../feature-switches";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runDetailRoutes } from "../run-detail";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { webhooksAgentStorageRoutes } from "../webhooks-agent-storage";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  makeCodexAuthJson,
  mockClaudeCodeTokenEndpoint,
} from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { mockClerkUsers } from "./helpers/clerk-users";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { memoryArchive } from "./helpers/public-runner-memory";
import { createRouteMocks } from "./helpers/route-test";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

type DispatchEnvelope = zInfer<typeof runnerDispatchEnvelopeSchema>;
type RunnerHeartbeatBody = zInfer<
  (typeof runnersHeartbeatContract.heartbeat)["body"]
>;

interface TrackedRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly sandboxToken: string;
  done: boolean;
}

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const CLAUDE_MODEL = "claude-fable-5-1";
const CODEX_MODEL = "gpt-6-astra";
const DEFAULT_PROFILE = "vm0/default";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const okouTokenClaimsSchema = object({
  scope: literal("okou"),
  capabilities: array(string()),
});

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const routeMocks = createRouteMocks(context);

const webhooksClerkApi = setupApp({
  context,
  routes: webhooksClerkRoutes,
})(webhookClerkContract);
const webhooksStripeApi = setupApp({
  context,
  routes: webhooksStripeRoutes,
})(webhookStripeContract);
const personalModelProvidersApi = setupApp({
  context,
  routes: meModelProvidersUpsertRoutes,
})(personalModelProvidersMainContract);
const userModelPreferenceApi = setupApp({
  context,
  routes: userModelPreferenceRoutes,
})(userModelPreferenceContract);
const featureSwitchesApi = setupApp({
  context,
  routes: featureSwitchesRoutes,
})(featureSwitchesContract);
const workflowsApi = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsCollectionContract);
const customConnectorsApi = setupApp({
  context,
  routes: customConnectorsRoutes,
})(customConnectorsContract);
const customConnectorValuesApi = setupApp({
  context,
  routes: customConnectorsValuesSetRoutes,
})(customConnectorValuesContract);
const builtinConnectorsSearchApi = setupApp({
  context,
  routes: builtinConnectorsRoutes,
})(builtinConnectorsSearchContract);
const builtinConnectorOauthStartApi = setupApp({
  context,
  routes: builtinConnectorsRoutes,
})(builtinConnectorOauthStartContract);
const builtinConnectorOauthCallbackApi = setupApp({
  context,
  routes: builtinConnectorsSlugCallbackRoutes,
})(builtinConnectorsSlugCallbackContract);
const chatEventsApi = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const runnersHeartbeatApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runsByIdApi = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runsQueueApi = setupApp({
  context,
  routes: runsRoutes,
})(runsQueueContract);
const runsCancelApi = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const runContextApi = setupApp({
  context,
  routes: runDetailRoutes,
})(runContextContract);
const webhooksAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const webhooksAgentEventsApi = setupApp({
  context,
  routes: webhooksAgentEventsRoutes,
})(webhookEventsContract);
const webhooksAgentHeartbeatApi = setupApp({
  context,
  routes: webhooksAgentHealthUsageTelemetryRoutes,
})(webhookHeartbeatContract);
const webhooksAgentTelemetryApi = setupApp({
  context,
  routes: webhooksAgentHealthUsageTelemetryRoutes,
})(webhookTelemetryContract);
const webhooksAgentStoragePrepareApi = setupApp({
  context,
  routes: webhooksAgentStorageRoutes,
})(webhookStoragesPrepareContract);
const webhooksAgentStorageCommitApi = setupApp({
  context,
  routes: webhooksAgentStorageRoutes,
})(webhookStoragesCommitContract);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function sandboxHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function signIn(actor: ApiTestUser): void {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "Chain",
    },
  ]);
  const memberships = actor.orgId
    ? [
        {
          id: `membership-${actor.userId}-${actor.orgId}`,
          createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ]
    : [];
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: memberships,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: memberships,
    },
  );
}

function initRuntimeMocks(): void {
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
}

function heartbeatPayload(args: {
  readonly runnerId: string;
  readonly runnerHostname: string;
  readonly group: string;
  readonly snapshotGeneration?: number;
  readonly snapshotSequence?: number;
  readonly maxConcurrent?: number;
  readonly admittableProfiles?: readonly string[];
}): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId,
    runnerHostname: args.runnerHostname,
    group: args.group,
    snapshotGeneration: args.snapshotGeneration ?? 1,
    snapshotSequence: args.snapshotSequence ?? 1,
    totalVcpu: 16,
    totalMemoryMb: 32_768,
    maxConcurrent: args.maxConcurrent ?? 4,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
    runningCount: 0,
    admittableProfiles: [...(args.admittableProfiles ?? [DEFAULT_PROFILE])],
    heldSandboxStates: [],
    heldHomeStates: [],
    activeReuseProducers: [],
    mode: "running",
    ingressServiceActive: true,
  };
}

function readOkouTokenCapabilities(
  token: string | undefined,
): readonly string[] {
  if (!token?.startsWith("vm0_sandbox_")) {
    throw new Error("Expected a real vm0_sandbox_ Okou token");
  }
  const jwt = token.slice("vm0_sandbox_".length);
  const payload = jwt.split(".")[1];
  if (!payload) {
    throw new Error("Expected JWT payload segment in Okou token");
  }
  const decoded: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  return okouTokenClaimsSchema.parse(decoded).capabilities;
}

function createRunTracker() {
  const tracked: TrackedRun[] = [];

  onTestFinished(async () => {
    initRuntimeMocks();
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        return Promise.resolve(apiTestS3PresignedUrl(command));
      },
    );
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const errors: unknown[] = [];
    const initialFlush = await settleIncludingAbort(flushWaitUntilForTest);
    if (!initialFlush.ok) {
      errors.push(initialFlush.error);
    }
    const pendingCompletions: Promise<unknown>[] = [];
    for (const entry of tracked) {
      if (entry.done) {
        continue;
      }
      const cleaned = await settleIncludingAbort(async () => {
        signIn(entry.actor);
        const current = await accept(
          runsByIdApi.getById({
            headers: SESSION_HEADERS,
            params: { id: entry.runId },
          }),
          [200],
        );
        if (["queued", "pending", "running"].includes(current.body.status)) {
          await accept(
            runsCancelApi.cancel({
              headers: SESSION_HEADERS,
              params: { id: entry.runId },
            }),
            [200],
          );
        }
        if (!["completed", "failed", "timeout"].includes(current.body.status)) {
          pendingCompletions.push(
            accept(
              webhooksAgentCompleteApi.complete({
                headers: sandboxHeaders(entry.sandboxToken),
                body: {
                  runId: entry.runId,
                  exitCode: 137,
                  error: "Run cancelled by test cleanup",
                },
              }),
              [200],
            ),
          );
        }
        entry.done = true;
      });
      if (!cleaned.ok) {
        errors.push(cleaned.error);
      }
    }
    if (pendingCompletions.length > 0) {
      const completed = await settleIncludingAbort(() => {
        return Promise.all(pendingCompletions);
      });
      if (!completed.ok) {
        errors.push(completed.error);
      }
    }
    const finalFlush = await settleIncludingAbort(flushWaitUntilForTest);
    if (!finalFlush.ok) {
      errors.push(finalFlush.error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Run lifecycle chain cleanup failed");
    }
  });

  return {
    track(actor: ApiTestUser, runId: string, sandboxToken: string): TrackedRun {
      const entry: TrackedRun = { actor, runId, sandboxToken, done: false };
      tracked.push(entry);
      return entry;
    },
  };
}

function createDirectRunnerHarness(group: string) {
  const acceptedByRunId = new Map<string, ExecutionContext>();
  const acceptedOrder: string[] = [];

  async function register(
    options: {
      readonly admittableProfiles?: readonly string[];
      readonly mountHandler?: boolean;
    } = {},
  ): Promise<{
    readonly runnerId: string;
    readonly hostname: string;
    readonly heartbeatGeneration: number;
  }> {
    const runnerId = randomUUID();
    const heartbeatGeneration = 1;
    const hostname = `runner-${runnerId}.okou.app`;
    const expectedAuth = officialRunnerHeaders().authorization;

    if (options.mountHandler !== false) {
      server.use(
        http.post(
          `https://${hostname}/runners/${runnerId}/control/runs/:runId/dispatch`,
          async ({ request, params }) => {
            if (request.headers.get("authorization") !== expectedAuth) {
              return new HttpResponse(null, { status: 401 });
            }
            const encoding = request.headers.get("content-encoding");
            const rawBytes = Buffer.from(await request.arrayBuffer());
            const bytes =
              encoding === "gzip"
                ? gunzipSync(rawBytes).toString("utf8")
                : rawBytes.toString("utf8");
            const envelope: DispatchEnvelope =
              runnerDispatchEnvelopeSchema.parse(JSON.parse(bytes));
            if (
              envelope.runnerId !== runnerId ||
              envelope.heartbeatGeneration !== heartbeatGeneration ||
              envelope.executionContext.runId !== params.runId
            ) {
              throw new Error("Unexpected direct Runner dispatch identity");
            }
            acceptedByRunId.set(
              envelope.executionContext.runId,
              envelope.executionContext,
            );
            acceptedOrder.push(envelope.executionContext.runId);
            return HttpResponse.json({
              runnerId,
              heartbeatGeneration,
              runId: envelope.executionContext.runId,
              disposition: "accepted",
            });
          },
        ),
      );
    }

    await accept(
      runnersHeartbeatApi.heartbeat({
        headers: officialRunnerHeaders(),
        body: heartbeatPayload({
          runnerId,
          runnerHostname: hostname,
          group,
          snapshotGeneration: heartbeatGeneration,
          admittableProfiles: options.admittableProfiles,
        }),
      }),
      [200],
    );

    return { runnerId, hostname, heartbeatGeneration };
  }

  function nextAccepted(afterIndex: number): ExecutionContext {
    const runId = acceptedOrder[afterIndex];
    if (!runId) {
      throw new Error("Expected a direct Runner dispatch to be accepted");
    }
    const execution = acceptedByRunId.get(runId);
    if (!execution) {
      throw new Error(`Missing captured execution context for run ${runId}`);
    }
    return execution;
  }

  return {
    register,
    acceptedCount: () => {
      return acceptedOrder.length;
    },
    nextAccepted,
  };
}

async function provisionOrg(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected a workspace actor");
  }
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
    type: "organization.created",
    data: { id: actor.orgId, created_by: actor.userId, created_at: now() },
  });
  await accept(webhooksClerkApi.post({ body: "{}", extraHeaders: {} }), [200]);
  await flushWaitUntilForTest();
}

async function addPersonalClaudeProvider(actor: ApiTestUser): Promise<void> {
  signIn(actor);
  await accept(
    personalModelProvidersApi.upsert({
      headers: SESSION_HEADERS,
      body: {
        type: "claude-code-oauth-token",
        secret: `claude-token-${randomUUID()}`,
      },
    }),
    [201],
  );
}

async function addPersonalCodexProvider(actor: ApiTestUser): Promise<void> {
  signIn(actor);
  await accept(
    personalModelProvidersApi.upsert({
      headers: SESSION_HEADERS,
      body: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: { CODEX_AUTH_JSON: makeCodexAuthJson() },
      },
    }),
    [201],
  );
}

async function setFeatureSwitches(
  actor: ApiTestUser,
  switches: Readonly<Record<string, boolean>>,
): Promise<void> {
  signIn(actor);
  await accept(
    featureSwitchesApi.update({
      headers: SESSION_HEADERS,
      body: { switches },
    }),
    [200],
  );
}

function installRunContextDiagnosticCapture() {
  const capturedByRunId = new Map<string, Record<string, unknown>>();

  context.mocks.axiom.ingest.mockImplementation(
    (dataset: unknown, events: unknown) => {
      if (
        typeof dataset === "string" &&
        dataset.endsWith("run-context") &&
        Array.isArray(events)
      ) {
        for (const event of events) {
          if (isRecord(event) && typeof event.runId === "string") {
            capturedByRunId.set(event.runId.toLowerCase(), event);
          }
        }
      }
      return true;
    },
  );
  context.mocks.axiom.query.mockImplementation((apl: unknown) => {
    if (typeof apl === "string" && apl.includes("run-context")) {
      for (const [runId, snapshot] of capturedByRunId) {
        if (apl.includes(runId)) {
          return Promise.resolve([snapshot]);
        }
      }
    }
    return Promise.resolve([]);
  });

  return {
    capturedByRunId,
  };
}

async function createReadOnlyConnectorSkill(args: {
  readonly actor: ApiTestUser;
  readonly displayName: string;
  readonly endpointPrefix: string;
  readonly skillMarkdown: string;
}) {
  signIn(args.actor);
  const created = await accept(
    customConnectorsApi.create({
      headers: SESSION_HEADERS,
      body: {
        kind: "http",
        displayName: args.displayName,
        prefixTemplates: [args.endpointPrefix],
        authMode: "manual",
        fields: [
          {
            key: "token",
            label: "API Token",
            kind: "secret",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.token}}",
          },
        ],
        queryInjections: [],
        skillMarkdown: args.skillMarkdown,
      },
    }),
    [201],
  );
  await accept(
    customConnectorValuesApi.set({
      headers: SESSION_HEADERS,
      params: { id: created.body.id },
      body: {
        values: [
          {
            key: "token",
            kind: "secret",
            value: `secret-${randomUUID()}`,
          },
        ],
        account: { intent: "add", displayName: args.displayName },
      },
    }),
    [200],
  );
  return {
    connector: created.body,
    skillName: getCustomConnectorSkillName(created.body.slug, created.body.id),
  };
}

async function grantProSubscription(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor for Pro tier");
  }
  const periodEnd = nowDate();
  periodEnd.setTime(now() + 30 * 24 * 60 * 60 * 1000);
  await postSubscriptionInvoicePaid(context.signal, {
    orgId: actor.orgId,
    userId: actor.userId,
    tier: "pro",
    customerId: generatedStripeCustomerId(),
    subscriptionId: generatedStripeSubscriptionId(),
    currentPeriodEnd: periodEnd,
  });
}

async function setupNativeRunMember(
  options: {
    readonly includeCodex?: boolean;
    readonly featureSwitches?: Readonly<Record<string, boolean>>;
    readonly proTier?: boolean;
    readonly selectedModel?: string;
  } = {},
) {
  const tracker = createRunTracker();
  const actor = bdd.user();
  const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;

  initRuntimeMocks();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
  mockClaudeCodeTokenEndpoint();
  signIn(actor);

  const runner = createDirectRunnerHarness(group);

  await Promise.all([
    runner.register(),
    provisionOrg(actor),
    ...(options.proTier ? [grantProSubscription(actor)] : []),
    (async () => {
      await Promise.all([
        addPersonalClaudeProvider(actor),
        ...(options.includeCodex ? [addPersonalCodexProvider(actor)] : []),
      ]);
      if (options.selectedModel) {
        signIn(actor);
        await accept(
          userModelPreferenceApi.update({
            headers: SESSION_HEADERS,
            body: { selectedModel: options.selectedModel, serviceTier: null },
          }),
          [200],
        );
      }
    })(),
    ...(options.featureSwitches
      ? [setFeatureSwitches(actor, options.featureSwitches)]
      : []),
  ]);

  async function launchChatRun(
    args: {
      readonly prompt: string;
      readonly threadId?: string;
      readonly model?: string | null;
    },
    sender: ApiTestUser = actor,
  ) {
    const beforeCount = runner.acceptedCount();
    const clientEventId = randomUUID();
    signIn(sender);
    const sent = await accept(
      chatEventsApi.send({
        headers: SESSION_HEADERS,
        body: {
          prompt: args.prompt,
          hasTextContent: true,
          clientEventId,
          ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
          ...(args.model === undefined ? {} : { model: args.model }),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: args.prompt }],
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const execution = runner.nextAccepted(beforeCount);
    const trackedEntry = tracker.track(
      sender,
      execution.runId,
      execution.sandboxToken,
    );
    return {
      threadId: sent.body.threadId,
      runId: execution.runId,
      execution,
      trackedEntry,
    };
  }

  async function readRun(runId: string, reader: ApiTestUser = actor) {
    signIn(reader);
    const response = await accept(
      runsByIdApi.getById({
        headers: SESSION_HEADERS,
        params: { id: runId },
      }),
      [200],
    );
    return response.body;
  }

  async function cancelAndFinishRun(
    launched: Awaited<ReturnType<typeof launchChatRun>>,
    canceller: ApiTestUser = actor,
  ) {
    signIn(canceller);
    await accept(
      runsCancelApi.cancel({
        headers: SESSION_HEADERS,
        params: { id: launched.runId },
      }),
      [200],
    );
    await accept(
      webhooksAgentCompleteApi.complete({
        headers: sandboxHeaders(launched.execution.sandboxToken),
        body: {
          runId: launched.runId,
          exitCode: 137,
          error: "Cancelled by user",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    launched.trackedEntry.done = true;
  }

  return {
    actor,
    group,
    runner,
    launchChatRun,
    readRun,
    cancelAndFinishRun,
  };
}

describe("CHAIN-RUN: entitled run lifecycle through runner and sandbox webhooks", () => {
  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_warmup");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(webhooksClerkApi.post({ body: "{}", extraHeaders: {} }), [401]),
        accept(webhooksStripeApi.post({ body: "{}", extraHeaders: {} }), [401]),
        accept(
          personalModelProvidersApi.upsert({
            headers: {},
            body: { type: "claude-code-oauth-token", secret: "warmup" },
          }),
          [401],
        ),
        accept(
          userModelPreferenceApi.update({
            headers: {},
            body: { selectedModel: CLAUDE_MODEL, serviceTier: null },
          }),
          [401],
        ),
        accept(
          featureSwitchesApi.update({
            headers: {},
            body: { switches: { [FeatureSwitchKey.LarkIntegration]: true } },
          }),
          [401],
        ),
        accept(
          workflowsApi.create({
            headers: {},
            body: { name: "warmup-workflow", visibility: "private" },
          }),
          [401],
        ),
        accept(
          customConnectorsApi.create({
            headers: {},
            body: {
              kind: "http",
              displayName: "Warmup Connector",
              prefixTemplates: ["https://warmup.example.test/"],
              authMode: "none",
              fields: [],
              headerInjections: [],
              queryInjections: [],
            },
          }),
          [401],
        ),
        accept(
          customConnectorValuesApi.set({
            headers: {},
            params: { id: warmupId },
            body: { values: [], account: { intent: "add" } },
          }),
          [401],
        ),
        accept(
          builtinConnectorsSearchApi.search({
            headers: {},
            query: { keyword: "youtube" },
          }),
          [401],
        ),
        accept(
          builtinConnectorOauthStartApi.start({
            headers: {},
            params: { connectorSlug: "x" },
            body: { authMethod: "oauth", account: { intent: "add" } },
          }),
          [401],
        ),
        accept(
          builtinConnectorOauthCallbackApi.callback({
            headers: {},
            params: { connectorSlug: "x" },
            query: { error: "access_denied" },
          }),
          [307],
        ),
        accept(
          chatEventsApi.send({
            headers: {},
            body: {
              prompt: "warmup",
              hasTextContent: true,
              clientEventId: randomUUID(),
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "warmup" }],
              },
            },
          }),
          [401],
        ),
        accept(
          runnersHeartbeatApi.heartbeat({
            headers: {},
            body: heartbeatPayload({
              runnerId: warmupId,
              runnerHostname: `runner-${warmupId}.okou.app`,
              group: "vm0/warmup",
            }),
          }),
          [401],
        ),
        accept(
          runsByIdApi.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(runsQueueApi.getQueue({ headers: {} }), [401]),
        accept(
          runsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runContextApi.getContext({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          webhooksAgentCompleteApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
        accept(
          webhooksAgentEventsApi.send({
            headers: {},
            body: {
              runId: warmupId,
              events: [{ type: "system", sequenceNumber: 0 }],
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentHeartbeatApi.send({
            headers: {},
            body: { runId: warmupId },
          }),
          [401],
        ),
        accept(
          webhooksAgentTelemetryApi.send({
            headers: {},
            body: {},
          }),
          [400],
        ),
        accept(
          webhooksAgentStoragePrepareApi.prepare({
            headers: {},
            body: { runId: warmupId, storageId: warmupId, files: [] },
          }),
          [401],
        ),
        accept(
          webhooksAgentStorageCommitApi.commit({
            headers: {},
            body: {
              runId: warmupId,
              storageId: warmupId,
              versionId: "v0",
              files: [],
            },
          }),
          [401],
        ),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  it(
    "run-lifecycle-chain.bdd-024 resumes thread sessions only on the same runtime and family",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember({
        includeCodex: true,
        featureSwitches: { [FeatureSwitchKey.CodexExecution]: true },
        selectedModel: CODEX_MODEL,
      });

      const first = await setup.launchChatRun({
        prompt: "Initial Codex subscription turn",
        model: CODEX_MODEL,
      });
      expect(first.execution.cliAgentType).toBe("codex");
      const firstCodexSessionId = `codex-session-${first.runId}`;
      await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "codex",
              cliAgentSessionId: firstCodexSessionId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      first.trackedEntry.done = true;

      // Another Runner in the same group heartbeats with no admittable profiles.
      await setup.runner.register({
        admittableProfiles: [],
        mountHandler: false,
      });

      const sameModelContinuation = await setup.launchChatRun({
        prompt: "Continue thread on gpt-6-astra",
        threadId: first.threadId,
        model: CODEX_MODEL,
      });
      expect(sameModelContinuation.execution.cliAgentType).toBe("codex");
      expect(sameModelContinuation.execution.nativeContinuation.sessionId).toBe(
        firstCodexSessionId,
      );
      expect(
        sameModelContinuation.execution.nativeContinuation.generationRunId,
      ).toBe(first.runId);
      expect(
        sameModelContinuation.execution.startupInputs.memory,
      ).toStrictEqual(first.execution.startupInputs.memory);
      expect(sameModelContinuation.execution.billableFirewalls).toStrictEqual(
        [],
      );

      const continuedRun = await setup.readRun(sameModelContinuation.runId);
      expect(continuedRun.source.model).toBe(CODEX_MODEL);
      expect(continuedRun.source.providerType).toBe("codex-oauth-token");
      expect(continuedRun.source.runtimeProviderType).toBe("codex-oauth-token");

      await setup.cancelAndFinishRun(sameModelContinuation);

      const claudeContinuation = await setup.launchChatRun({
        prompt: "Switch thread to native Claude model",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });
      expect(claudeContinuation.execution.cliAgentType).toBe("claude-code");
      expect(
        claudeContinuation.execution.nativeContinuation.sessionId,
      ).toBeNull();
    },
  );

  it(
    "run-lifecycle-chain.bdd-009 adopts a newly connected sibling account after repeated runs",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("APP_URL", "https://app.example.test");
      mockEnv("OKOU_WEB_URL", "https://app.example.test");
      mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-bdd-chain-client-id");
      mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-bdd-chain-client-secret");
      mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "slack-bdd-chain-client-id");
      mockOptionalEnv(
        "SLACK_OAUTH_CLIENT_SECRET",
        "slack-bdd-chain-client-secret",
      );

      const setup = await setupNativeRunMember();
      server.use(
        http.post("https://api.x.com/2/oauth2/token", () => {
          return HttpResponse.json({
            access_token: "x-chain-access",
            refresh_token: "x-chain-refresh",
            token_type: "Bearer",
            scope: "",
          });
        }),
        http.get("https://api.x.com/2/users/me", () => {
          return HttpResponse.json({
            data: {
              id: "chain-x-user",
              username: "chain-x-user",
              name: "Chain X",
            },
          });
        }),
        http.post("https://slack.com/api/oauth.v2.access", () => {
          return HttpResponse.json({
            ok: true,
            team: { id: "T_BDD_CHAIN" },
            authed_user: {
              id: "U_BDD_CHAIN",
              access_token: "xoxp-bdd-chain-token",
              scope:
                "channels:read,chat:write,users:read,files:read,files:write",
            },
          });
        }),
        http.get("https://slack.com/api/users.info", () => {
          return HttpResponse.json({
            ok: true,
            user: {
              id: "U_BDD_CHAIN",
              name: "chain-member",
              real_name: "Chain Member",
              profile: { email: setup.actor.email },
            },
          });
        }),
      );

      signIn(setup.actor);
      const xStart = await accept(
        builtinConnectorOauthStartApi.start({
          headers: SESSION_HEADERS,
          params: { connectorSlug: "x" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [200],
      );
      const xState = new URL(xStart.body.authorizationUrl).searchParams.get(
        "state",
      );
      if (!xState) {
        throw new Error("Expected X OAuth state parameter");
      }
      await accept(
        builtinConnectorOauthCallbackApi.callback({
          headers: {},
          params: { connectorSlug: "x" },
          query: { state: xState, code: "x-chain-code" },
        }),
        [307],
      );

      const first = await setup.launchChatRun({
        prompt: "First run targeting connected X account",
        model: CLAUDE_MODEL,
      });
      expect(first.execution.connectorRuntimeTargets).toStrictEqual([
        {
          kind: "builtin",
          connectorSlug: "x",
          sourceId: expect.stringMatching(UUID_PATTERN),
        },
      ]);
      await setup.cancelAndFinishRun(first);

      const second = await setup.launchChatRun({
        prompt: "Second run targeting connected X account",
        model: CLAUDE_MODEL,
      });
      expect(second.execution.connectorRuntimeTargets).toStrictEqual([
        {
          kind: "builtin",
          connectorSlug: "x",
          sourceId: expect.stringMatching(UUID_PATTERN),
        },
      ]);
      await setup.cancelAndFinishRun(second);

      signIn(setup.actor);
      const slackStart = await accept(
        builtinConnectorOauthStartApi.start({
          headers: SESSION_HEADERS,
          params: { connectorSlug: "slack" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [200],
      );
      const slackState = new URL(
        slackStart.body.authorizationUrl,
      ).searchParams.get("state");
      if (!slackState) {
        throw new Error("Expected Slack OAuth state parameter");
      }
      await accept(
        builtinConnectorOauthCallbackApi.callback({
          headers: {},
          params: { connectorSlug: "slack" },
          query: { state: slackState, code: "slack-bdd-chain-code" },
        }),
        [307],
      );

      const third = await setup.launchChatRun({
        prompt: "Third run targeting connected X and Slack accounts",
        model: CLAUDE_MODEL,
      });
      const thirdSlugs = third.execution.connectorRuntimeTargets
        .flatMap((target) => {
          return target.kind === "builtin" ? [target.connectorSlug] : [];
        })
        .sort();
      expect(third.execution.connectorRuntimeTargets).toHaveLength(2);
      expect(thirdSlugs).toStrictEqual(["slack", "x"]);

      const [, searchResponse] = await Promise.all([
        setup.cancelAndFinishRun(third),
        (async () => {
          signIn(setup.actor);
          return await accept(
            builtinConnectorsSearchApi.search({
              headers: SESSION_HEADERS,
              query: { keyword: "youtube" },
            }),
            [200],
          );
        })(),
      ]);
      expect(
        searchResponse.body.connectors.some((entry) => {
          return entry.slug === "youtube";
        }),
      ).toBeTruthy();
    },
  );

  it(
    "run-lifecycle-chain.bdd-002 guides ordinary runs to choose document formats by content",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const launched = await setup.launchChatRun({
        prompt: "write a project update",
        model: CLAUDE_MODEL,
      });
      const prompt = launched.execution.appendSystemPrompt ?? "";

      expect(prompt).toContain(
        "Honor the user's explicitly requested delivery format.",
      );
      expect(prompt).toContain(
        "use Markdown for text-focused documents and reports, and HTML for visual or interactive deliverables.",
      );
      expect(prompt).toContain(
        "Keep Markdown as the source of truth and let the user export DOCX or PDF from the artifact actions when they need those formats.",
      );
    },
  );

  it(
    "run-lifecycle-chain.bdd-006 advertises current Run usage and grants its Run capability",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const launched = await setup.launchChatRun({
        prompt: "Check current run token usage guidance",
        model: CLAUDE_MODEL,
      });
      const prompt = launched.execution.appendSystemPrompt ?? "";
      const capabilities = readOkouTokenCapabilities(
        launched.execution.platformEnvironment.OKOU_TOKEN,
      );

      expect(prompt).toContain(
        "- Current Run usage: use `okou run usage --json` to inspect observed provider-token usage for the currently assigned Run.",
      );
      expect(capabilities).toContain("run-usage:read");
    },
  );

  it(
    "run-lifecycle-chain.bdd-007 advertises Lark messaging only while the organization rollout is enabled",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const beforeEnable = await setup.launchChatRun({
        prompt: "Send a message before Lark rollout is enabled",
        model: CLAUDE_MODEL,
      });
      const firstPrompt = beforeEnable.execution.appendSystemPrompt ?? "";
      expect(firstPrompt).not.toContain("okou lark");
      expect(firstPrompt).toContain("okou feishu message send --help");
      await setup.cancelAndFinishRun(beforeEnable);

      await setFeatureSwitches(setup.actor, {
        [FeatureSwitchKey.LarkIntegration]: true,
      });

      const afterEnable = await setup.launchChatRun({
        prompt: "Send a message after Lark rollout is enabled",
        model: CLAUDE_MODEL,
      });
      const secondPrompt = afterEnable.execution.appendSystemPrompt ?? "";
      expect(secondPrompt).toContain(
        "- Lark messages: when the task explicitly asks to send or post to Lark, use `okou lark message send --help` for chats, DMs, and replies.",
      );
      expect(secondPrompt).toContain("okou lark message send --help");
    },
  );

  it(
    "run-lifecycle-chain.bdd-013 starts a Run for a member before Memory initialization finishes",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const diagnostics = installRunContextDiagnosticCapture();
      const newMember = bdd.user({
        orgId: setup.actor.orgId,
        orgRole: "org:member",
      });
      await addPersonalClaudeProvider(newMember);

      const first = await setup.launchChatRun(
        {
          prompt: "First run for a member whose Memory was never initialized",
          model: CLAUDE_MODEL,
        },
        newMember,
      );
      const firstMemory = first.execution.startupInputs.memory;
      expect(firstMemory).not.toBeNull();
      if (!firstMemory) {
        throw new Error("Expected initial Memory mount for new member");
      }
      expect(firstMemory.empty).toBeTruthy();
      expect(firstMemory.archiveUrl).toBeUndefined();
      expect(firstMemory.storageId).toMatch(UUID_PATTERN);
      expect(firstMemory.versionId).toMatch(/\S+/u);
      expect(firstMemory.missingRootPolicy).toBe("preserveParentVersion");

      signIn(newMember);
      const firstContext = await accept(
        runContextApi.getContext({
          headers: SESSION_HEADERS,
          params: { id: first.runId },
        }),
        [200],
      );
      expect(
        diagnostics.capturedByRunId.has(first.runId.toLowerCase()),
      ).toBeTruthy();
      expect(firstContext.body.storageMounts).toContainEqual({
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        name: "memory",
        version: firstMemory.versionId,
        writeback: true,
      });

      await setup.cancelAndFinishRun(first, newMember);

      const second = await setup.launchChatRun(
        {
          prompt: "Second run after cancelling before Memory writeback",
          model: CLAUDE_MODEL,
        },
        newMember,
      );
      expect(second.execution.startupInputs.memory).toStrictEqual(firstMemory);
    },
  );

  it(
    "run-lifecycle-chain.bdd-014 prepares the storage manifest without uploading empty artifact objects",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const s3 = installWorkflowVolumeS3Fixture(context);

      const workflowName = "bdd-chain-storage-kit";
      signIn(setup.actor);
      await accept(
        workflowsApi.create({
          headers: SESSION_HEADERS,
          body: {
            name: workflowName,
            visibility: "private",
            instruction: "Verify storage manifest without empty uploads.",
          },
        }),
        [201],
      );

      s3.clearWrites();
      const launched = await setup.launchChatRun({
        prompt: "Prepare storage manifest with workflow skill bundle",
        model: CLAUDE_MODEL,
      });
      const writesDuringPreparation = [...s3.writes];

      const workflowSkill =
        launched.execution.startupInputs.contentBundles.skills.find((skill) => {
          return skill.name === workflowName;
        });
      expect(workflowSkill).toBeDefined();
      if (!workflowSkill) {
        throw new Error("Expected workflow skill bundle in execution input");
      }
      const workflowFiles = readExecutionContentBundle(
        s3.objects,
        workflowSkill.bundle,
      );
      expect(workflowFiles.get("SKILL.md")?.toString("utf8")).toContain(
        "Verify storage manifest without empty uploads.",
      );

      const memory = launched.execution.startupInputs.memory;
      expect(memory).not.toBeNull();
      if (!memory) {
        throw new Error("Expected canonical Memory mount");
      }
      expect(memory.empty).toBeTruthy();
      expect(memory.archiveUrl).toBeUndefined();
      expect(memory.storageId).toMatch(UUID_PATTERN);
      expect(memory.versionId).toMatch(/\S+/u);
      expect(memory.missingRootPolicy).toBe("preserveParentVersion");

      const candidateFile = storageTextFile("notes.md", "memory upload check");
      const prepared = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers: sandboxHeaders(launched.execution.sandboxToken),
          body: {
            runId: launched.runId,
            storageId: memory.storageId,
            parentVersionId: memory.versionId,
            files: [candidateFile],
          },
        }),
        [200],
      );
      expect(prepared.body.existing).toBeFalsy();
      if (!prepared.body.uploads) {
        throw new Error("Expected upload keys from storage prepare");
      }
      const versionSegment = `/${prepared.body.versionId}/`;
      const prefixEnd =
        prepared.body.uploads.archive.key.indexOf(versionSegment);
      if (prefixEnd <= 0) {
        throw new Error("Expected Memory storage prefix in upload archive key");
      }
      const memoryPrefix = prepared.body.uploads.archive.key.slice(
        0,
        prefixEnd + 1,
      );
      const memoryWritesDuringPrep = writesDuringPreparation.filter((entry) => {
        return entry.key.startsWith(memoryPrefix);
      });
      expect(memoryWritesDuringPrep).toStrictEqual([]);
    },
  );

  it(
    "run-lifecycle-chain.bdd-015 resolves Connector and memory artifacts with exact candidates",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const s3 = installWorkflowVolumeS3Fixture(context);
      installRunContextDiagnosticCapture();

      const skill = await createReadOnlyConnectorSkill({
        actor: setup.actor,
        displayName: "Chain Analytics API",
        endpointPrefix: "https://analytics.example.test/",
        skillMarkdown: "# Analytics Skill\nRead-only connector skill content.",
      });

      const launched = await setup.launchChatRun({
        prompt: "Run with one read-only connector skill and Memory mount",
        model: CLAUDE_MODEL,
      });

      const runDetail = await setup.readRun(launched.runId);
      expect(runDetail.status).toBe("running");

      const mountedSkill =
        launched.execution.startupInputs.contentBundles.skills.find((entry) => {
          return entry.name === skill.skillName;
        });
      expect(mountedSkill).toBeDefined();
      if (!mountedSkill) {
        throw new Error("Expected connector skill bundle in execution input");
      }
      const extracted = readExecutionContentBundle(
        s3.objects,
        mountedSkill.bundle,
      );
      expect(extracted.get("SKILL.md")?.toString("utf8")).toContain(
        "Read-only connector skill content.",
      );

      const memory = launched.execution.startupInputs.memory;
      expect(memory).not.toBeNull();
      if (!memory) {
        throw new Error("Expected canonical Memory mount");
      }
      expect(memory.storageId).toMatch(UUID_PATTERN);
      expect(memory.versionId).toMatch(/\S+/u);
      expect(memory.missingRootPolicy).toBe("preserveParentVersion");

      signIn(setup.actor);
      const contextResponse = await accept(
        runContextApi.getContext({
          headers: SESSION_HEADERS,
          params: { id: launched.runId },
        }),
        [200],
      );
      expect(contextResponse.body.storageMounts).toContainEqual({
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        name: "memory",
        version: memory.versionId,
        writeback: true,
      });
    },
  );

  it(
    "run-lifecycle-chain.bdd-017 persists canonical mounts across historyless session continuation",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const s3 = installWorkflowVolumeS3Fixture(context);
      installRunContextDiagnosticCapture();

      const [firstSkill, secondSkill] = await Promise.all([
        createReadOnlyConnectorSkill({
          actor: setup.actor,
          displayName: "Chain Billing API",
          endpointPrefix: "https://billing-api.example.test/",
          skillMarkdown: "# Billing Skill\nFirst read-only connector skill.",
        }),
        createReadOnlyConnectorSkill({
          actor: setup.actor,
          displayName: "Chain Inventory API",
          endpointPrefix: "https://inventory-api.example.test/",
          skillMarkdown: "# Inventory Skill\nSecond read-only connector skill.",
        }),
      ]);

      const first = await setup.launchChatRun({
        prompt: "First turn with two connector skills and Memory commit",
        model: CLAUDE_MODEL,
      });
      const initialMemory = first.execution.startupInputs.memory;
      if (!initialMemory) {
        throw new Error("Expected initial Memory mount");
      }

      const memoryFile = storageTextFile(
        "journal.md",
        "Persisted across continuation",
      );
      const prepared = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            files: [memoryFile],
          },
        }),
        [200],
      );
      if (!prepared.body.uploads) {
        throw new Error("Expected Memory upload keys");
      }
      s3.objects.set(
        prepared.body.uploads.archive.key,
        memoryArchive("journal.md", "Persisted across continuation"),
      );
      s3.objects.set(
        prepared.body.uploads.manifest.key,
        Buffer.from(
          JSON.stringify({
            version: 1,
            files: [memoryFile],
            createdAt: nowDate().toISOString(),
          }),
        ),
      );
      await accept(
        webhooksAgentStorageCommitApi.commit({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            versionId: prepared.body.versionId,
            files: [memoryFile],
          },
        }),
        [200],
      );

      const firstSessionId = `native-only-${first.runId}`;
      await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: firstSessionId,
              cliAgentSessionHistoryDisposition: "native_only",
              storageOutputs: [
                {
                  name: "memory",
                  mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
                  version: prepared.body.versionId,
                  missingRootPolicy: "preserveParentVersion",
                },
              ],
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      first.trackedEntry.done = true;

      const completedFirst = await setup.readRun(first.runId);
      expect(completedFirst.result?.frameworkSessionId).toBe(firstSessionId);

      const continuation = await setup.launchChatRun({
        prompt: "Continue thread and verify skill bundles and Memory version",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });

      const skillNames =
        continuation.execution.startupInputs.contentBundles.skills.map(
          (entry) => {
            return entry.name;
          },
        );
      expect(skillNames).toContain(firstSkill.skillName);
      expect(skillNames).toContain(secondSkill.skillName);

      const continuedMemory = continuation.execution.startupInputs.memory;
      expect(continuedMemory).not.toBeNull();
      if (!continuedMemory) {
        throw new Error("Expected continued Memory mount");
      }
      expect(continuedMemory.storageId).toBe(initialMemory.storageId);
      expect(continuedMemory.versionId).toBe(prepared.body.versionId);
      expect(continuedMemory.archiveUrl).toMatch(/^https:\/\//u);
      expect(continuedMemory.empty).toBeUndefined();
      expect(continuedMemory.missingRootPolicy).toBe("preserveParentVersion");

      signIn(setup.actor);
      const continuedContext = await accept(
        runContextApi.getContext({
          headers: SESSION_HEADERS,
          params: { id: continuation.runId },
        }),
        [200],
      );
      expect(continuedContext.body.storageMounts).toContainEqual({
        mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
        name: "memory",
        version: prepared.body.versionId,
        writeback: true,
      });
    },
  );

  it(
    "run-lifecycle-chain.bdd-018 keeps a committed artifact head after initial empty artifact creation",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const s3 = installWorkflowVolumeS3Fixture(context);
      const baseS3Send = context.mocks.s3.send.getMockImplementation();
      const storageRequests: {
        readonly name: string;
        readonly key?: string;
      }[] = [];
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (
          command instanceof GetObjectCommand ||
          command instanceof HeadObjectCommand ||
          command instanceof PutObjectCommand
        ) {
          storageRequests.push({
            name: command.constructor.name,
            key: command.input.Key,
          });
        }
        return baseS3Send ? baseS3Send(command) : Promise.resolve({});
      });

      const first = await setup.launchChatRun({
        prompt: "First run with empty initial native Memory",
        model: CLAUDE_MODEL,
      });
      const initialMemory = first.execution.startupInputs.memory;
      expect(initialMemory).not.toBeNull();
      if (!initialMemory) {
        throw new Error("Expected empty initial Memory mount");
      }
      expect(initialMemory.empty).toBeTruthy();
      expect(initialMemory.archiveUrl).toBeUndefined();

      storageRequests.length = 0;
      const emptyPrepared = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            files: [],
          },
        }),
        [200],
      );
      expect(emptyPrepared.body.versionId).toBe(initialMemory.versionId);
      expect(emptyPrepared.body.existing).toBeTruthy();
      expect(emptyPrepared.body.uploads).toBeUndefined();

      const emptyCommitted = await accept(
        webhooksAgentStorageCommitApi.commit({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            versionId: emptyPrepared.body.versionId,
            files: [],
          },
        }),
        [200],
      );
      expect(emptyCommitted.body).toStrictEqual({
        success: true,
        versionId: initialMemory.versionId,
        storageName: "memory",
        size: 0,
        fileCount: 0,
        deduplicated: true,
      });
      expect(storageRequests).toStrictEqual([]);

      const artifactFile = storageTextFile(
        "artifact.txt",
        "first committed artifact",
      );
      const artifactPrepared = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            baseVersion: initialMemory.versionId,
            changes: {
              added: ["artifact.txt"],
              modified: [],
              deleted: [],
            },
            files: [artifactFile],
          },
        }),
        [200],
      );
      expect(artifactPrepared.body.existing).toBeFalsy();
      if (!artifactPrepared.body.uploads) {
        throw new Error("Expected archive and manifest upload keys");
      }
      expect(
        artifactPrepared.body.uploads.archive.key.endsWith(
          `/${artifactPrepared.body.versionId}/archive.tar.gz`,
        ),
      ).toBeTruthy();
      expect(
        storageRequests.some((entry) => {
          return (
            entry.name === "GetObjectCommand" &&
            entry.key?.endsWith(`/${initialMemory.versionId}/manifest.json`) ===
              true
          );
        }),
      ).toBeFalsy();

      s3.objects.set(
        artifactPrepared.body.uploads.archive.key,
        memoryArchive("artifact.txt", "first committed artifact"),
      );
      s3.objects.set(
        artifactPrepared.body.uploads.manifest.key,
        Buffer.from(
          JSON.stringify({
            version: 1,
            files: [artifactFile],
            createdAt: nowDate().toISOString(),
          }),
        ),
      );
      const artifactCommitted = await accept(
        webhooksAgentStorageCommitApi.commit({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            storageId: initialMemory.storageId,
            parentVersionId: initialMemory.versionId,
            versionId: artifactPrepared.body.versionId,
            files: [artifactFile],
          },
        }),
        [200],
      );
      expect(artifactCommitted.body).toMatchObject({
        success: true,
        versionId: artifactPrepared.body.versionId,
        fileCount: 1,
      });

      await setup.cancelAndFinishRun(first);

      const second = await setup.launchChatRun({
        prompt: "Next run after committing artifact.txt to Memory",
        model: CLAUDE_MODEL,
      });
      const nextMemory = second.execution.startupInputs.memory;
      expect(nextMemory).not.toBeNull();
      if (!nextMemory) {
        throw new Error("Expected committed Memory mount on next Run");
      }
      expect(nextMemory.versionId).toBe(artifactPrepared.body.versionId);
      expect(nextMemory.archiveUrl).toMatch(/^https:\/\//u);
      expect(nextMemory.empty).toBeUndefined();
    },
  );

  it(
    "run-lifecycle-chain.bdd-022 creates, dispatches, reports, and completes a Run through public APIs",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember({
        proTier: true,
        selectedModel: CLAUDE_MODEL,
      });

      const prompt = "Run complete public lifecycle on Pro tier";
      const launched = await setup.launchChatRun({
        prompt,
        model: CLAUDE_MODEL,
      });
      expect(launched.threadId).toMatch(UUID_PATTERN);
      expect(launched.execution.prompt).toBe(prompt);
      expect(launched.execution.environment?.CLAUDE_CODE_OAUTH_TOKEN).toMatch(
        /\S+/u,
      );
      expect(launched.execution.cliAgentType).toBe("claude-code");

      signIn(setup.actor);
      const [activeQueue, runningDetail] = await Promise.all([
        accept(runsQueueApi.getQueue({ headers: SESSION_HEADERS }), [200]),
        accept(
          runsByIdApi.getById({
            headers: SESSION_HEADERS,
            params: { id: launched.runId },
          }),
          [200],
        ),
      ]);
      expect(activeQueue.body.concurrency.tier).toBe("pro");
      expect(activeQueue.body.concurrency.active).toBe(1);
      expect(runningDetail.body.status).toBe("running");
      expect(runningDetail.body.startedAt).toStrictEqual(expect.any(String));

      const headers = sandboxHeaders(launched.execution.sandboxToken);
      const sessionId = `claude-lifecycle-${launched.runId}`;
      const [heartbeatRes, telemetryRes, eventsRes] = await Promise.all([
        accept(
          webhooksAgentHeartbeatApi.send({
            headers,
            body: { runId: launched.runId },
          }),
          [200],
        ),
        accept(
          webhooksAgentTelemetryApi.send({
            headers,
            body: {
              runId: launched.runId,
              systemLog: "Sandbox initialized cleanly",
            },
          }),
          [200],
        ),
        accept(
          webhooksAgentEventsApi.send({
            headers,
            body: {
              runId: launched.runId,
              events: [
                {
                  type: "system",
                  subtype: "init",
                  session_id: sessionId,
                  sequenceNumber: 0,
                },
              ],
            },
          }),
          [200],
        ),
      ]);
      expect(heartbeatRes.status).toBe(200);
      expect(telemetryRes.status).toBe(200);
      expect(eventsRes.status).toBe(200);

      const completeRes = await accept(
        webhooksAgentCompleteApi.complete({
          headers,
          body: {
            runId: launched.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: sessionId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(completeRes.status).toBe(200);
      launched.trackedEntry.done = true;

      signIn(setup.actor);
      const [completedDetail, drainedQueue, cancelAfterComplete] =
        await Promise.all([
          accept(
            runsByIdApi.getById({
              headers: SESSION_HEADERS,
              params: { id: launched.runId },
            }),
            [200],
          ),
          accept(runsQueueApi.getQueue({ headers: SESSION_HEADERS }), [200]),
          accept(
            runsCancelApi.cancel({
              headers: SESSION_HEADERS,
              params: { id: launched.runId },
            }),
            [400],
          ),
        ]);

      expect(completedDetail.body.status).toBe("completed");
      expect(completedDetail.body.completedAt).toStrictEqual(
        expect.any(String),
      );
      expect(completedDetail.body.result?.frameworkSessionId).toBe(sessionId);
      expect(drainedQueue.body.concurrency.active).toBe(0);
      expect(cancelAfterComplete.status).toBe(400);
    },
  );

  it(
    "run-lifecycle-chain.bdd-023 resumes the previous session when a run continues the same thread",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const outsideUser = bdd.user();
      const [setup] = await Promise.all([
        setupNativeRunMember(),
        grantProSubscription(outsideUser),
      ]);
      const colleague = bdd.user({
        orgId: setup.actor.orgId,
        orgRole: "org:member",
      });

      const first = await setup.launchChatRun({
        prompt: "First turn creating a resumable native session",
        model: CLAUDE_MODEL,
      });
      const cliSessionId = `resumable-session-${first.runId}`;
      await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: cliSessionId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      first.trackedEntry.done = true;

      const continued = await setup.launchChatRun({
        prompt: "Continue the same thread",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });
      expect(continued.execution.nativeContinuation.sessionId).toBe(
        cliSessionId,
      );
      expect(continued.execution.nativeContinuation.generationRunId).toBe(
        first.runId,
      );

      await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(continued.execution.sandboxToken),
          body: {
            runId: continued.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: cliSessionId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      continued.trackedEntry.done = true;

      const [firstAfter, continuedAfter] = await Promise.all([
        setup.readRun(first.runId),
        setup.readRun(continued.runId),
      ]);
      expect(firstAfter.result?.frameworkSessionId).toBe(cliSessionId);
      expect(continuedAfter.result?.frameworkSessionId).toBe(cliSessionId);

      signIn(colleague);
      const colleagueSend = await accept(
        chatEventsApi.send({
          headers: SESSION_HEADERS,
          body: {
            threadId: first.threadId,
            prompt: "Colleague attempting to post into private thread",
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: "Colleague attempting to post into private thread",
                },
              ],
            },
          },
        }),
        [404],
      );
      expect(colleagueSend.body.error.code).toBe("NOT_FOUND");

      signIn(outsideUser);
      const outsideSend = await accept(
        chatEventsApi.send({
          headers: SESSION_HEADERS,
          body: {
            threadId: first.threadId,
            prompt: "Outside Pro user attempting to post into private thread",
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: "Outside Pro user attempting to post into private thread",
                },
              ],
            },
          },
        }),
        [404],
      );
      expect(outsideSend.body.error.code).toBe("NOT_FOUND");

      const firstFinal = await setup.readRun(first.runId);
      expect(firstFinal.status).toBe("completed");
    },
  );
});
