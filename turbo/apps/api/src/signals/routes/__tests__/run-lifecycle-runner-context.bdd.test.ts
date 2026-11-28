import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  AVAILABLE_PAID_TOOL_IDS,
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  runnersSteerContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_DELIVERY_INSTRUCTION } from "@okouai/core/presentation-generation-instructions";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { array, literal, object, string, type infer as zInfer } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { authMeRoutes } from "../auth-me";
import { chatEventsRoutes } from "../chat-events";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { featureSwitchesRoutes } from "../feature-switches";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { paidToolsRoutes } from "../paid-tools";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { userPreferencesRoutes } from "../user-preferences";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  makeCodexAuthJson,
  mockClaudeCodeTokenEndpoint,
} from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { mockClerkUsers } from "./helpers/clerk-users";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";
import { createRouteMocks } from "./helpers/route-test";
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
const SCHOOLHOUSE_TEMPLATE_ID = "template:html-ppt-schoolhouse";

const STANDARD_DISALLOWED_TOOLS = Object.freeze([
  "CronCreate",
  "CronList",
  "CronDelete",
  "ScheduleWakeup",
  "AskUserQuestion",
  "Skill(loop)",
  "Skill(loop *)",
]);

const okouTokenClaimsSchema = object({
  scope: literal("okou"),
  capabilities: array(string()),
});

const stringListSchema = array(string());

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const connectors = createConnectorBddApi(context);
const routeMocks = createRouteMocks(context);

const authMeApi = setupApp({ context, routes: authMeRoutes })(authContract);
const webhooksClerkApi = setupApp({
  context,
  routes: webhooksClerkRoutes,
})(webhookClerkContract);
const personalModelProvidersApi = setupApp({
  context,
  routes: meModelProvidersUpsertRoutes,
})(personalModelProvidersMainContract);
const chatEventsApi = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const runnersHeartbeatApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runnersSteerApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersSteerContract);
const runsByIdApi = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runsCancelApi = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const webhooksAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const paidToolsApi = setupApp({
  context,
  routes: paidToolsRoutes,
})(paidToolsContract);
const featureSwitchesApi = setupApp({
  context,
  routes: featureSwitchesRoutes,
})(featureSwitchesContract);
const connectorPermissionsApi = setupApp({
  context,
  routes: connectorPermissionsRoutes,
})(connectorPermissionsContract);
const userPreferencesApi = setupApp({
  context,
  routes: userPreferencesRoutes,
})(userPreferencesContract);
const workflowsApi = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsCollectionContract);

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function signIn(
  actor: ApiTestUser,
  profile: { readonly firstName?: string; readonly lastName?: string } = {},
): void {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: profile.firstName ?? "BDD",
      lastName: profile.lastName ?? "Runner",
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
  readonly maxConcurrent?: number;
}): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId,
    runnerHostname: args.runnerHostname,
    group: args.group,
    snapshotGeneration: args.snapshotGeneration ?? 1,
    snapshotSequence: 1,
    totalVcpu: 16,
    totalMemoryMb: 32_768,
    maxConcurrent: args.maxConcurrent ?? 4,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
    runningCount: 0,
    admittableProfiles: [DEFAULT_PROFILE],
    heldSandboxStates: [],
    heldHomeStates: [],
    activeReuseProducers: [],
    mode: "running",
    ingressServiceActive: true,
  };
}

function createRunTracker() {
  const tracked: TrackedRun[] = [];

  onTestFinished(async () => {
    initRuntimeMocks();
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
                headers: { authorization: `Bearer ${entry.sandboxToken}` },
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
      throw new AggregateError(errors, "Runner context test cleanup failed");
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

function createDirectRunnerHarness(
  group: string,
  options: {
    readonly reply?: (
      envelope: DispatchEnvelope,
    ) => Response | Promise<Response>;
  } = {},
) {
  const acceptedByRunId = new Map<string, ExecutionContext>();
  const acceptedOrder: string[] = [];

  async function register(): Promise<void> {
    const runnerId = randomUUID();
    const heartbeatGeneration = 1;
    const hostname = `runner-${runnerId}.okou.app`;
    const expectedAuth = officialRunnerHeaders().authorization;

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
          const envelope = runnerDispatchEnvelopeSchema.parse(
            JSON.parse(bytes),
          );
          if (
            envelope.runnerId !== runnerId ||
            envelope.heartbeatGeneration !== heartbeatGeneration ||
            envelope.executionContext.runId !== params.runId
          ) {
            throw new Error("Unexpected direct Runner dispatch identity");
          }
          if (options.reply) {
            const response = await options.reply(envelope);
            if (response.status === 200) {
              acceptedByRunId.set(
                envelope.executionContext.runId,
                envelope.executionContext,
              );
              acceptedOrder.push(envelope.executionContext.runId);
            }
            return response;
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

    await accept(
      runnersHeartbeatApi.heartbeat({
        headers: officialRunnerHeaders(),
        body: heartbeatPayload({
          runnerId,
          runnerHostname: hostname,
          group,
          snapshotGeneration: heartbeatGeneration,
        }),
      }),
      [200],
    );
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
    executionFor(runId: string): ExecutionContext {
      const execution = acceptedByRunId.get(runId);
      if (!execution) {
        throw new Error(`Run ${runId} was not accepted by direct Runner`);
      }
      return execution;
    },
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

async function setPaidTool(
  actor: ApiTestUser,
  toolId: PaidToolId,
  disabled: boolean,
): Promise<void> {
  signIn(actor);
  await accept(
    paidToolsApi.update({
      headers: SESSION_HEADERS,
      params: { toolId },
      body: { disabled },
    }),
    [200],
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

function parseDisabledPaidTools(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    throw new Error(
      `Missing ${DISABLED_PAID_TOOLS_ENV_VAR} in platformEnvironment`,
    );
  }
  const parsed: unknown = JSON.parse(raw);
  return stringListSchema.parse(parsed);
}

async function setupNativeRunMember(
  options: {
    readonly orgId?: string;
    readonly reply?: (
      envelope: DispatchEnvelope,
    ) => Response | Promise<Response>;
    readonly includeCodex?: boolean;
    readonly featureSwitches?: Readonly<Record<string, boolean>>;
  } = {},
) {
  const tracker = createRunTracker();
  const actor = bdd.user({ orgId: options.orgId });
  const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;

  initRuntimeMocks();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
  mockClaudeCodeTokenEndpoint();
  signIn(actor);

  const runner = createDirectRunnerHarness(group, { reply: options.reply });

  await Promise.all([
    runner.register(),
    provisionOrg(actor),
    addPersonalClaudeProvider(actor),
    ...(options.includeCodex ? [addPersonalCodexProvider(actor)] : []),
    ...(options.featureSwitches
      ? [setFeatureSwitches(actor, options.featureSwitches)]
      : []),
  ]);

  async function launchChatRun(
    sender: ApiTestUser,
    args: {
      readonly prompt: string;
      readonly threadId?: string;
      readonly model?: string | null;
      readonly userMessage?: UserMessageInputDocument;
    },
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
          userMessage: args.userMessage ?? {
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
      eventId: clientEventId,
      threadId: sent.body.threadId,
      runId: execution.runId,
      execution,
      trackedEntry,
    };
  }

  return {
    actor,
    group,
    runner,
    tracker,
    launchChatRun,
  };
}

function buildSchoolhouseMessage(args: {
  readonly text: string;
  readonly outputFormat: "html" | "pptx";
}): UserMessageInputDocument {
  return {
    version: 1,
    parts: [
      {
        type: "template",
        titleSnapshot: "Schoolhouse Presentation",
        template: {
          type: "presentation",
          selection: {
            templateId: SCHOOLHOUSE_TEMPLATE_ID,
            outputFormat: args.outputFormat,
          },
        },
      },
      { type: "text", text: args.text },
    ],
  };
}

const STAFF_ORG_ID_012 = createUniqueStaffOrgIdFixture();
const STAFF_ORG_ID_013 = createUniqueStaffOrgIdFixture();

describe("RUN-01: agent runner context, queue promotion, and skills", () => {
  beforeAll(async () => {
    const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    const warmed = await settleIncludingAbort(async () => {
      await Promise.all([
        accept(authMeApi.me({ headers: {} }), [401]),
        accept(webhooksClerkApi.post({ body: "{}", extraHeaders: {} }), [401]),
        accept(
          personalModelProvidersApi.upsert({
            headers: {},
            body: { type: "claude-code-oauth-token", secret: "warmup" },
          }),
          [401],
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
          runnersSteerApi.next({
            headers: {},
            params: { runId: warmupId },
          }),
          [401],
        ),
        accept(
          runnersSteerApi.steered({
            headers: {},
            params: { runId: warmupId, eventId: warmupId },
            body: {},
          }),
          [401],
        ),
        accept(
          runsByIdApi.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
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
          paidToolsApi.update({
            headers: {},
            params: { toolId: "web-search" },
            body: { disabled: true },
          }),
          [401],
        ),
        accept(
          featureSwitchesApi.update({
            headers: {},
            body: { switches: { [FeatureSwitchKey.Banking]: true } },
          }),
          [401],
        ),
        accept(
          connectorPermissionsApi.apply({
            headers: {},
            body: {
              target: { kind: "builtin", connectorSlug: "slack" },
              mode: "patch",
              grants: [{ permission: "chat:write", action: "allow" }],
            },
          }),
          [401],
        ),
        accept(
          userPreferencesApi.update({
            headers: {},
            body: { timezone: "UTC" },
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
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  it(
    "run-lifecycle-runner-context.bdd-001 injects agent identity, tool hints, and user info into the runner context",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const tracker = createRunTracker();
      const actor = bdd.user();
      const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;

      initRuntimeMocks();
      const s3 = installWorkflowVolumeS3Fixture(context, undefined, {
        bundlesOnly: true,
      });
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
      mockEnv("APP_URL", "https://app.example.test");
      mockEnv("OKOU_WEB_URL", "https://app.example.test");
      mockOptionalEnv("SLACK_OAUTH_CLIENT_ID", "slack-bdd-client-id");
      mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-bdd-client-secret");
      mockClaudeCodeTokenEndpoint();

      server.use(
        http.post("https://slack.com/api/oauth.v2.access", () => {
          return HttpResponse.json({
            ok: true,
            team: { id: "T_BDD_CONTEXT" },
            authed_user: {
              id: "U_BDD_CONTEXT",
              access_token: "xoxp-bdd-context-token",
              scope:
                "channels:read,chat:write,users:read,files:read,files:write",
            },
          });
        }),
        http.get("https://slack.com/api/users.info", () => {
          return HttpResponse.json({
            ok: true,
            user: {
              id: "U_BDD_CONTEXT",
              name: "ava",
              real_name: "Ava Lin",
              profile: { email: actor.email },
            },
          });
        }),
      );

      // Populate user_cache with the member's display name and email first.
      signIn(actor, { firstName: "Ava", lastName: "Lin" });
      await accept(authMeApi.me({ headers: SESSION_HEADERS }), [200]);

      const runner = createDirectRunnerHarness(group);

      await Promise.all([
        runner.register(),
        runs.grantProEntitlement(actor),
        addPersonalClaudeProvider(actor),
      ]);

      const [, customConnector, slackOauthStart] = await Promise.all([
        accept(
          userPreferencesApi.update({
            headers: SESSION_HEADERS,
            body: { timezone: "America/Los_Angeles" },
          }),
          [200],
        ),
        connectors.createCustomConnector(actor, {
          displayName: "Internal Ledger API",
          prefixTemplates: ["https://ledger.example.test/"],
          authMode: "manual",
          fields: [
            {
              key: "secret",
              label: "Ledger API Secret",
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
        }),
        connectors.startOauth(actor, "slack", "oauth"),
        accept(
          workflowsApi.create({
            headers: SESSION_HEADERS,
            body: {
              name: "bdd-context-workflow",
              visibility: "private",
              instruction: "Run the context verification checklist.",
            },
          }),
          [201],
        ),
      ]);

      const slackState = new URL(
        slackOauthStart.authorizationUrl,
      ).searchParams.get("state");
      if (!slackState) {
        throw new Error("Expected Slack OAuth authorization URL state");
      }

      await Promise.all([
        connectors.completeOauthCallback("slack", {
          code: "slack-bdd-auth-code",
          state: slackState,
        }),
        connectors.setCustomConnectorSecret(
          actor,
          customConnector.id,
          "bdd-ledger-secret-value",
        ),
      ]);

      signIn(actor, { firstName: "Ava", lastName: "Lin" });
      await accept(
        connectorPermissionsApi.apply({
          headers: SESSION_HEADERS,
          body: {
            target: { kind: "builtin", connectorSlug: "slack" },
            mode: "patch",
            grants: [{ permission: "chat:write", action: "allow" }],
          },
        }),
        [200],
      );

      const beforeCount = runner.acceptedCount();
      signIn(actor, { firstName: "Ava", lastName: "Lin" });
      const sent = await accept(
        chatEventsApi.send({
          headers: SESSION_HEADERS,
          body: {
            prompt: "Inspect full runner context",
            hasTextContent: true,
            clientEventId: randomUUID(),
            model: CLAUDE_MODEL,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "Inspect full runner context" }],
            },
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();

      const execution = runner.nextAccepted(beforeCount);
      tracker.track(actor, execution.runId, execution.sandboxToken);

      const prompt = execution.appendSystemPrompt ?? "";
      const orderedSnippets = [
        "# Identity",
        "Your name is Okou.",
        "# Execution Time Limit",
        "maximum execution time of 2 hours",
        "# Agent Tools",
        "okou --help",
        "okou workflow automation --help",
        "okou browser use",
        "- Managed research data:",
        "okou data tools",
        "okou chat send --thread-id <thread-id>",
        "okou slack message send --help",
        "okou host <dir> --site <slug> [--spa]",
        "okou connector search <service-name>",
        "okou generate -h",
        "okou connector permission-request",
        "okou instructions view",
        "okou workflow create|edit <name>",
        "# Current User Info",
        "Name: Ava Lin",
        `Email: ${actor.email}`,
        "Timezone: America/Los_Angeles",
        "# Current Integration",
        "You are currently running inside: Web",
        "# Integration Note",
        "okou web download-file -h",
      ];
      let cursor = -1;
      for (const snippet of orderedSnippets) {
        const nextIndex = prompt.indexOf(snippet, cursor + 1);
        expect(
          nextIndex,
          `missing or out-of-order snippet: ${snippet}`,
        ).toBeGreaterThan(cursor);
        cursor = nextIndex;
      }

      for (const forbiddenHint of [
        "okou slack download-file",
        "okou feishu download-file",
        "okou teams download-file",
        "okou telegram download-file",
        "okou phone download-file",
        "okou github download-file",
      ]) {
        expect(prompt).not.toContain(forbiddenHint);
      }

      expect(execution.userTimezone).toBe("America/Los_Angeles");
      expect(execution.disallowedTools).toStrictEqual([
        ...STANDARD_DISALLOWED_TOOLS,
      ]);
      expect(execution.platformEnvironment.OKOU_APP_URL).toBe(
        "https://app.example.test",
      );
      expect(execution.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(
        sent.body.threadId,
      );
      expect(execution.platformEnvironment.OKOU_CURRENT_INTEGRATION).toBe(
        "web",
      );
      expect(execution.platformEnvironment.OKOU_TOKEN).toMatch(
        /^vm0_sandbox_/u,
      );

      const sandboxEnv = execution.environment ?? {};
      for (const platformKey of [
        "OKOU_APP_URL",
        "OKOU_CHAT_THREAD_ID",
        "OKOU_CURRENT_INTEGRATION",
        "OKOU_TOKEN",
      ]) {
        expect(sandboxEnv).not.toHaveProperty(platformKey);
      }

      expect(execution.firewalls).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "builtin",
            name: "slack",
          }),
        ]),
      );
      expect(execution.networkPolicies?.slack?.allow).toStrictEqual(
        expect.arrayContaining(["chat:write", "conversations:read"]),
      );

      const customFirewall = (execution.firewalls ?? []).find((entry) => {
        return (
          entry.kind === "inline" &&
          entry.customConnectorId === customConnector.id
        );
      });
      expect(customFirewall).toBeDefined();
      if (!customFirewall || customFirewall.kind !== "inline") {
        throw new Error("Expected inline custom connector firewall");
      }
      expect(customFirewall.firewall.apis).toHaveLength(1);

      expect(execution.cliAgentType).toBe("claude-code");
      const mountedWorkflow =
        execution.startupInputs.contentBundles.skills.find((skill) => {
          return skill.name === "bdd-context-workflow";
        });
      expect(mountedWorkflow).toBeDefined();
      if (!mountedWorkflow) {
        throw new Error("Expected bdd-context-workflow skill bundle");
      }
      const files = readExecutionContentBundle(
        s3.objects,
        mountedWorkflow.bundle,
      );
      expect(files.get("SKILL.md")?.toString("utf8")).toContain(
        "Run the context verification checklist.",
      );
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-006 (1/2) snapshots disabled paid tool preferences on admitted dispatch and applies later re-enables to new runs",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const firstDispatchArrived = createDeferredPromise<string>(
        context.signal,
      );
      const releaseFirstDispatch = createDeferredPromise<void>(context.signal);
      let firstReleased = false;
      const releaseFirst = () => {
        if (!firstReleased) {
          firstReleased = true;
          releaseFirstDispatch.resolve();
        }
      };
      onTestFinished(releaseFirst);

      let firstDispatchSeen = false;
      const setup = await setupNativeRunMember({
        reply: async (envelope) => {
          if (!firstDispatchSeen) {
            firstDispatchSeen = true;
            firstDispatchArrived.resolve(envelope.executionContext.runId);
            await releaseFirstDispatch.promise;
          }
          return HttpResponse.json({
            runnerId: envelope.runnerId,
            heartbeatGeneration: envelope.heartbeatGeneration,
            runId: envelope.executionContext.runId,
            disposition: "accepted",
          });
        },
      });

      await Promise.all([
        setPaidTool(setup.actor, "web-search", true),
        setPaidTool(setup.actor, "image-generation", true),
      ]);

      signIn(setup.actor);
      await accept(
        chatEventsApi.send({
          headers: SESSION_HEADERS,
          body: {
            prompt: "Queued run with disabled web search and image generation",
            hasTextContent: true,
            clientEventId: randomUUID(),
            model: CLAUDE_MODEL,
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: "Queued run with disabled web search and image generation",
                },
              ],
            },
          },
        }),
        [201],
      );

      const firstRunId = await firstDispatchArrived.promise;

      await Promise.all([
        setPaidTool(setup.actor, "web-search", false),
        setPaidTool(setup.actor, "image-generation", false),
      ]);
      releaseFirst();
      await flushWaitUntilForTest();

      const firstExecution = setup.runner.executionFor(firstRunId);
      setup.tracker.track(setup.actor, firstRunId, firstExecution.sandboxToken);

      const firstPrompt = firstExecution.appendSystemPrompt ?? "";
      expect(firstPrompt).not.toContain("okou data tools --family web-search");
      expect(firstPrompt).not.toContain("# Built-in image model");
      expect(
        parseDisabledPaidTools(
          firstExecution.platformEnvironment[DISABLED_PAID_TOOLS_ENV_VAR],
        ),
      ).toStrictEqual(["image-generation", "web-search"]);
      expect(
        firstExecution.platformEnvironment[ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR],
      ).toBe("true");
      expect(
        firstExecution.platformEnvironment[
          ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR
        ],
      ).toBeUndefined();

      const firstSandboxEnv = firstExecution.environment ?? {};
      expect(firstSandboxEnv).not.toHaveProperty(DISABLED_PAID_TOOLS_ENV_VAR);
      expect(firstSandboxEnv).not.toHaveProperty(
        ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
      );
      expect(firstSandboxEnv).not.toHaveProperty(
        ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR,
      );

      const secondRun = await setup.launchChatRun(setup.actor, {
        prompt: "Fresh run after re-enabling paid tools",
        model: CLAUDE_MODEL,
      });
      const secondPrompt = secondRun.execution.appendSystemPrompt ?? "";
      expect(secondPrompt).toContain("okou data tools --family web-search");
      expect(secondPrompt).toContain("# Built-in image model");
      expect(
        parseDisabledPaidTools(
          secondRun.execution.platformEnvironment[DISABLED_PAID_TOOLS_ENV_VAR],
        ),
      ).toStrictEqual([]);
      expect(
        secondRun.execution.platformEnvironment[
          ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR
        ],
      ).toBeUndefined();
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-006 (2/2) applies subsequent paid tool disables to Claude Code and Codex runs",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember({
        includeCodex: true,
        featureSwitches: { [FeatureSwitchKey.CodexExecution]: true },
      });

      await Promise.all([
        setPaidTool(setup.actor, "web-search", true),
        setPaidTool(setup.actor, "video-generation", true),
      ]);

      const claudeRun = await setup.launchChatRun(setup.actor, {
        prompt: "Claude run with web search and video generation disabled",
        model: CLAUDE_MODEL,
      });
      expect(
        parseDisabledPaidTools(
          claudeRun.execution.platformEnvironment[DISABLED_PAID_TOOLS_ENV_VAR],
        ),
      ).toStrictEqual(["video-generation", "web-search"]);
      expect(
        claudeRun.execution.platformEnvironment[
          ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR
        ],
      ).toBe("true");

      const codexRun = await setup.launchChatRun(setup.actor, {
        prompt: "Codex run with web search disabled",
        model: CODEX_MODEL,
      });
      expect(codexRun.execution.cliAgentType).toBe("codex");
      expect(
        codexRun.execution.platformEnvironment[
          ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR
        ],
      ).toBe("true");
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-009 advertises banking tools only while the feature is enabled",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const firstRun = await setup.launchChatRun(setup.actor, {
        prompt: "Review my recent bank account activity",
        model: CLAUDE_MODEL,
      });
      expect(firstRun.execution.appendSystemPrompt ?? "").not.toContain(
        "okou banking access-request",
      );

      await setFeatureSwitches(setup.actor, {
        [FeatureSwitchKey.Banking]: true,
      });

      const secondRun = await setup.launchChatRun(setup.actor, {
        prompt: "Check my bank balances and cash flow",
        model: CLAUDE_MODEL,
      });
      const secondPrompt = secondRun.execution.appendSystemPrompt ?? "";
      expect(secondPrompt).toContain("okou banking access-request");
      expect(secondPrompt).toContain("account-scoped, expiring grant");
      expect(secondPrompt).toContain(
        "you MUST use `okou banking`, not Data Router market data tools",
      );
      expect(secondPrompt).toContain("balances, transactions");
      expect(secondPrompt).toContain("cash flow");
      expect(secondPrompt).toContain(
        "Do not give generic banking-app directions",
      );
      expect(secondPrompt).toContain(
        "Make the callback prompt preserve the original task",
      );
      expect(secondPrompt).toContain(
        "run `okou banking accounts`, then use `okou banking balances`",
      );
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-004 omits all disabled managed tool guidance while retaining independent tools and content policy",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      await Promise.all(
        [...AVAILABLE_PAID_TOOL_IDS, "scrape", "social"].map((toolId) => {
          return setPaidTool(setup.actor, toolId, true);
        }),
      );

      const launched = await setup.launchChatRun(setup.actor, {
        prompt: "Research with all managed paid tools disabled",
        model: CLAUDE_MODEL,
      });
      const prompt = launched.execution.appendSystemPrompt ?? "";

      expect(prompt).not.toContain("okou data tools --family web-search");
      expect(prompt).not.toContain("# Built-in image model");
      expect(prompt).not.toContain("--provider built-in");

      expect(prompt).toContain("Managed research data");
      expect(prompt).toContain("okou generate <type>");
      expect(prompt).toContain("okou connector search");
      expect(prompt).toContain("okou data describe <tool>");
      expect(prompt).toContain("# Restricted Explicit Content");
      expect(
        launched.execution.platformEnvironment[
          ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR
        ],
      ).toBe("true");
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-008 uses the executing member's paid tool preferences for a shared agent",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const colleague = bdd.user({
        orgId: setup.actor.orgId,
        orgRole: "org:member",
      });

      await setPaidTool(setup.actor, "web-search", true);
      await Promise.all([
        addPersonalClaudeProvider(colleague),
        setPaidTool(colleague, "scrape", true),
      ]);

      const launched = await setup.launchChatRun(colleague, {
        prompt: "Colleague run in shared workspace",
        model: CLAUDE_MODEL,
      });

      expect(
        parseDisabledPaidTools(
          launched.execution.platformEnvironment[DISABLED_PAID_TOOLS_ENV_VAR],
        ),
      ).toStrictEqual(["scrape"]);
      expect(launched.execution.appendSystemPrompt ?? "").toContain(
        "okou data tools --family web-search",
      );
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-010 advertises SSH guidance and grants Run scopes for an ordinary organization",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const launched = await setup.launchChatRun(setup.actor, {
        prompt: "Inspect SSH and VNC host guidance",
        model: CLAUDE_MODEL,
      });
      const prompt = launched.execution.appendSystemPrompt ?? "";

      for (const expectedSnippet of [
        "okou ssh host list --json",
        "okou ssh exec",
        "okou ssh session",
        "okou ssh upload",
        "okou ssh download",
        "okou ssh --help",
        "the relevant subcommand's `--help` before use",
        "okou ssh diagnose",
        "okou ssh request-access",
        "okou vnc diagnose",
        "okou vnc request-access",
      ]) {
        expect(prompt).toContain(expectedSnippet);
      }

      const capabilities = readOkouTokenCapabilities(
        launched.execution.platformEnvironment.OKOU_TOKEN,
      );
      expect(capabilities).toContain("ssh:read");
      expect(capabilities).toContain("ssh:write");
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-012 new HTML over a PPTX default: startup and active-input guidance with presentation-convert capability",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember({
        orgId: STAFF_ORG_ID_012,
        featureSwitches: {
          [FeatureSwitchKey.PresentationOutputFormat]: true,
          [FeatureSwitchKey.PresentationConvert]: true,
        },
      });

      const requestText = "Create a new Schoolhouse deck in HTML this time.";
      const userMessage = buildSchoolhouseMessage({
        text: requestText,
        outputFormat: "pptx",
      });

      const launched = await setup.launchChatRun(setup.actor, {
        prompt: requestText,
        model: CLAUDE_MODEL,
        userMessage,
      });

      const activeEventId = randomUUID();
      signIn(setup.actor);
      await accept(
        chatEventsApi.send({
          headers: SESSION_HEADERS,
          body: {
            threadId: launched.threadId,
            prompt: requestText,
            hasTextContent: true,
            clientEventId: activeEventId,
            model: CLAUDE_MODEL,
            userMessage,
          },
        }),
        [201],
      );

      const sandboxHeaders = {
        authorization: `Bearer ${launched.execution.sandboxToken}`,
      };
      const steered = await accept(
        runnersSteerApi.next({
          headers: sandboxHeaders,
          params: { runId: launched.runId },
        }),
        [200],
      );

      expect(launched.execution.prompt).toContain(requestText);
      const systemPrompt = launched.execution.appendSystemPrompt ?? "";
      const activeInput = steered.body.input;
      expect(activeInput).not.toBeNull();
      if (!activeInput) {
        throw new Error("Expected active steerable input for Schoolhouse deck");
      }
      expect(activeInput.eventId).toBe(activeEventId);
      await accept(
        runnersSteerApi.steered({
          headers: sandboxHeaders,
          params: { runId: launched.runId, eventId: activeEventId },
          body: {},
        }),
        [200],
      );

      for (const content of [systemPrompt, activeInput.prompt]) {
        expect(content).toContain("Output format: PPTX");
        expect(content).toContain(
          "okou resource pull template:pptx-schoolhouse-runbook",
        );
        expect(content).toContain(
          `okou generate presentation --format <html|pptx> --template ${SCHOOLHOUSE_TEMPLATE_ID}`,
        );
        expect(content).toContain(
          "The message wins over the selected format preference.",
        );
        expect(content).toContain(
          "Author an editable native PPTX directly with the selected package",
        );
        expect(content).not.toContain("okou presentation convert");
      }

      expect(systemPrompt).toContain(PRESENTATION_DELIVERY_INSTRUCTION);
      expect(systemPrompt).not.toContain("- Presentation output:");
      const capabilities = readOkouTokenCapabilities(
        launched.execution.platformEnvironment.OKOU_TOKEN,
      );
      expect(capabilities).toContain("presentation-convert:write");
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-013 new PPTX without conversion capability: startup and active-input guidance",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember({
        orgId: STAFF_ORG_ID_013,
        featureSwitches: {
          [FeatureSwitchKey.PresentationOutputFormat]: true,
          [FeatureSwitchKey.PresentationConvert]: false,
        },
      });

      const requestText = "Create a new Schoolhouse deck in PPTX this time.";
      const userMessage = buildSchoolhouseMessage({
        text: requestText,
        outputFormat: "html",
      });

      const launched = await setup.launchChatRun(setup.actor, {
        prompt: requestText,
        model: CLAUDE_MODEL,
        userMessage,
      });

      const activeEventId = randomUUID();
      signIn(setup.actor);
      await accept(
        chatEventsApi.send({
          headers: SESSION_HEADERS,
          body: {
            threadId: launched.threadId,
            prompt: requestText,
            hasTextContent: true,
            clientEventId: activeEventId,
            model: CLAUDE_MODEL,
            userMessage,
          },
        }),
        [201],
      );

      const sandboxHeaders = {
        authorization: `Bearer ${launched.execution.sandboxToken}`,
      };
      const steered = await accept(
        runnersSteerApi.next({
          headers: sandboxHeaders,
          params: { runId: launched.runId },
        }),
        [200],
      );

      expect(launched.execution.prompt).toContain(requestText);
      const systemPrompt = launched.execution.appendSystemPrompt ?? "";
      const activeInput = steered.body.input;
      expect(activeInput).not.toBeNull();
      if (!activeInput) {
        throw new Error("Expected active steerable input for Schoolhouse deck");
      }
      expect(activeInput.eventId).toBe(activeEventId);
      await accept(
        runnersSteerApi.steered({
          headers: sandboxHeaders,
          params: { runId: launched.runId, eventId: activeEventId },
          body: {},
        }),
        [200],
      );

      for (const content of [systemPrompt, activeInput.prompt]) {
        expect(content).toContain("Output format: HTML");
        expect(content).toContain(
          "okou resource pull template:html-ppt-schoolhouse-runbook",
        );
        expect(content).toContain(
          `okou generate presentation --format <html|pptx> --template ${SCHOOLHOUSE_TEMPLATE_ID}`,
        );
        expect(content).toContain(
          "The message wins over the selected format preference.",
        );
        expect(content).toContain(
          "For an explicit PowerPoint/PPTX request, follow the platform's conversion instructions",
        );
        expect(content).not.toContain("okou presentation convert");
      }

      expect(systemPrompt).toContain(PRESENTATION_DELIVERY_INSTRUCTION);
      expect(systemPrompt).not.toContain("- Presentation output:");
      const capabilities = readOkouTokenCapabilities(
        launched.execution.platformEnvironment.OKOU_TOKEN,
      );
      expect(capabilities).not.toContain("presentation-convert:write");
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-018 mounts the caller's private workflow over same-slug visible workflows",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const s3 = installWorkflowVolumeS3Fixture(context, undefined, {
        bundlesOnly: true,
      });
      const colleague = bdd.user({
        orgId: setup.actor.orgId,
        orgRole: "org:member",
      });
      const workflowName = "bdd-shadow-workflow";

      signIn(setup.actor);
      await accept(
        workflowsApi.create({
          headers: SESSION_HEADERS,
          body: {
            name: workflowName,
            visibility: "public",
            instruction: "Shared workspace public instruction.",
          },
        }),
        [201],
      );
      await accept(
        workflowsApi.create({
          headers: SESSION_HEADERS,
          body: {
            name: workflowName,
            visibility: "private",
            instruction: "Caller private override instruction.",
          },
        }),
        [201],
      );
      signIn(colleague);
      await accept(
        workflowsApi.create({
          headers: SESSION_HEADERS,
          body: {
            name: workflowName,
            visibility: "private",
            instruction: "Colleague private instruction that must stay hidden.",
          },
        }),
        [201],
      );

      const launched = await setup.launchChatRun(setup.actor, {
        prompt: "Mount my private workflow over same-slug workflows",
        model: CLAUDE_MODEL,
      });

      expect(launched.execution.cliAgentType).toBe("claude-code");
      const matching =
        launched.execution.startupInputs.contentBundles.skills.filter(
          (skill) => {
            return skill.name === workflowName;
          },
        );
      expect(matching).toHaveLength(1);
      const [mounted] = matching;
      if (!mounted) {
        throw new Error("Expected mounted shadowed workflow");
      }
      const skillMd = readExecutionContentBundle(s3.objects, mounted.bundle)
        .get("SKILL.md")
        ?.toString("utf8");
      expect(skillMd).toContain("Caller private override instruction.");
      expect(skillMd).not.toContain("Shared workspace public instruction.");
      expect(skillMd).not.toContain(
        "Colleague private instruction that must stay hidden.",
      );
    },
  );

  it(
    "run-lifecycle-runner-context.bdd-020 mounts workflows for Claude Code agents and cancels cleanly",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const s3 = installWorkflowVolumeS3Fixture(context, undefined, {
        bundlesOnly: true,
      });

      signIn(setup.actor);
      await accept(
        workflowsApi.create({
          headers: SESSION_HEADERS,
          body: {
            name: "bdd-claude-kit",
            visibility: "private",
            instruction: "Claude Code kit verification workflow.",
          },
        }),
        [201],
      );

      const launched = await setup.launchChatRun(setup.actor, {
        prompt: "Start Claude Code run with bdd-claude-kit mounted",
        model: CLAUDE_MODEL,
      });

      expect(launched.execution.cliAgentType).toBe("claude-code");
      const mounted =
        launched.execution.startupInputs.contentBundles.skills.find((skill) => {
          return skill.name === "bdd-claude-kit";
        });
      expect(mounted).toBeDefined();
      if (!mounted) {
        throw new Error("Expected bdd-claude-kit skill bundle");
      }
      const skillMd = readExecutionContentBundle(s3.objects, mounted.bundle)
        .get("SKILL.md")
        ?.toString("utf8");
      expect(skillMd).toContain("Claude Code kit verification workflow.");

      signIn(setup.actor);
      await accept(
        runsCancelApi.cancel({
          headers: SESSION_HEADERS,
          params: { id: launched.runId },
        }),
        [200],
      );
      const cancelled = await accept(
        runsByIdApi.getById({
          headers: SESSION_HEADERS,
          params: { id: launched.runId },
        }),
        [200],
      );
      expect(cancelled.body.status).toBe("cancelled");
    },
  );
});
