import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { bankingContract } from "@okouai/api-contracts/contracts/banking";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookHeartbeatContract,
  webhookMemoryArchiveContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { array, literal, object, string, type infer as zInfer } from "zod";

import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { authMeRoutes } from "../../routes/auth-me";
import { bankingRoutes } from "../../routes/banking";
import { browserRoutes } from "../../routes/browser";
import { chatEventsRoutes } from "../../routes/chat-events";
import { computerUseRoutes } from "../../routes/computer-use";
import { featureSwitchesRoutes } from "../../routes/feature-switches";
import { meModelProvidersUpsertRoutes } from "../../routes/me-model-providers-upsert";
import { runnersRoutes } from "../../routes/runners";
import { runsRoutes } from "../../routes/runs";
import { runsCancelRoutes } from "../../routes/runs-cancel";
import { webhooksAgentCompleteRoutes } from "../../routes/webhooks-agent-complete";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import { webhooksClerkRoutes } from "../../routes/webhooks-clerk";
import { webhooksRunMemoryArchiveRoutes } from "../../routes/webhooks-run-memory-archive";
import {
  createBddApi,
  type ApiTestUser,
} from "../../routes/__tests__/helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "../../routes/__tests__/helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "../../routes/__tests__/helpers/api-bdd-chat-callbacks";
import { createComputerUseBddApi } from "../../routes/__tests__/helpers/api-bdd-computer-use";
import { createRunsApi } from "../../routes/__tests__/helpers/api-bdd-runs";
import { mockClerkUsers } from "../../routes/__tests__/helpers/clerk-users";
import { createRouteMocks } from "../../routes/__tests__/helpers/route-test";

type DispatchEnvelope = zInfer<typeof runnerDispatchEnvelopeSchema>;
type RunnerHeartbeatBody = zInfer<
  (typeof runnersHeartbeatContract.heartbeat)["body"]
>;

interface TrackedRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly sandboxToken: string;
  readonly issuedAtMs: number;
  done: boolean;
}

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const CLAUDE_MODEL = "claude-fable-5-1";
const DEFAULT_PROFILE = "vm0/default";
const RUN_CONTROL_TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

const firewallClaimsSchema = object({
  scope: literal("firewall"),
  userId: string().min(1),
  orgId: string().min(1),
  runId: string().min(1),
});

const okouClaimsSchema = object({
  scope: literal("okou"),
  userId: string().min(1),
  orgId: string().min(1),
  runId: string().min(1),
  capabilities: array(string()),
  cloudBrowserEnabled: literal(true).optional(),
  computerUseHostId: string().optional(),
});

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const computerUse = createComputerUseBddApi(context);
const routeMocks = createRouteMocks(context);

const authMeApi = setupApp({
  context,
  routes: authMeRoutes,
})(authContract);
const bankingApi = setupApp({
  context,
  routes: bankingRoutes,
})(bankingContract);
const browserApi = setupApp({
  context,
  routes: browserRoutes,
})(browserContract);
const computerUseHostsApi = setupApp({
  context,
  routes: computerUseRoutes,
})(computerUseHostsContract);
const featureSwitchesApi = setupApp({
  context,
  routes: featureSwitchesRoutes,
})(featureSwitchesContract);
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
const webhooksAgentHeartbeatApi = setupApp({
  context,
  routes: webhooksAgentHealthUsageTelemetryRoutes,
})(webhookHeartbeatContract);
const webhooksMemoryArchiveApi = setupApp({
  context,
  routes: webhooksRunMemoryArchiveRoutes,
})(webhookMemoryArchiveContract);

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function decodePrefixedJwtPayload(token: string, prefix: string): unknown {
  if (!token.startsWith(prefix)) {
    throw new Error(`Expected token with prefix ${prefix}`);
  }
  const payload = token.slice(prefix.length).split(".")[1];
  if (!payload) {
    throw new Error("Expected JWT payload segment");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function readFirewallClaims(token: string) {
  return firewallClaimsSchema.parse(
    decodePrefixedJwtPayload(token, "vm0_firewall_"),
  );
}

function readOkouClaims(token: string | undefined) {
  if (!token) {
    throw new Error("Expected OKOU_TOKEN in platformEnvironment");
  }
  return okouClaimsSchema.parse(
    decodePrefixedJwtPayload(token, "vm0_sandbox_"),
  );
}

function signOutClerk(): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
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
      lastName: "Tokens",
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
}): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId,
    runnerHostname: args.runnerHostname,
    group: args.group,
    snapshotGeneration: 1,
    snapshotSequence: 1,
    totalVcpu: 16,
    totalMemoryMb: 32_768,
    maxConcurrent: 4,
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
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        return Promise.resolve(apiTestS3PresignedUrl(command));
      },
    );
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const errors: unknown[] = [];
    const cleanedAll = await settleIncludingAbort(async () => {
      const initialFlush = await settleIncludingAbort(flushWaitUntilForTest);
      if (!initialFlush.ok) {
        errors.push(initialFlush.error);
      }
      const toCompleteByIssuedAt = new Map<number, TrackedRun[]>();
      for (const entry of tracked) {
        if (entry.done) {
          continue;
        }
        const cleaned = await settleIncludingAbort(async () => {
          mockNow(entry.issuedAtMs);
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
          if (
            !["completed", "failed", "timeout"].includes(current.body.status)
          ) {
            const bucket = toCompleteByIssuedAt.get(entry.issuedAtMs) ?? [];
            bucket.push(entry);
            toCompleteByIssuedAt.set(entry.issuedAtMs, bucket);
          }
          entry.done = true;
        });
        if (!cleaned.ok) {
          errors.push(cleaned.error);
        }
      }
      for (const [issuedAtMs, entries] of toCompleteByIssuedAt) {
        mockNow(issuedAtMs);
        const completed = await settleIncludingAbort(() => {
          return Promise.all(
            entries.map((entry) => {
              return accept(
                webhooksAgentCompleteApi.complete({
                  headers: bearerHeaders(entry.sandboxToken),
                  body: {
                    runId: entry.runId,
                    exitCode: 137,
                    error: "Run cancelled by test cleanup",
                  },
                }),
                [200],
              );
            }),
          );
        });
        if (!completed.ok) {
          errors.push(completed.error);
        }
      }
      const finalFlush = await settleIncludingAbort(flushWaitUntilForTest);
      if (!finalFlush.ok) {
        errors.push(finalFlush.error);
      }
    });
    clearMockNow();
    if (!cleanedAll.ok) {
      errors.push(cleanedAll.error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Auth token test cleanup failed");
    }
  });

  return {
    track(actor: ApiTestUser, runId: string, sandboxToken: string): TrackedRun {
      const entry: TrackedRun = {
        actor,
        runId,
        sandboxToken,
        issuedAtMs: now(),
        done: false,
      };
      tracked.push(entry);
      return entry;
    },
  };
}

function createDirectRunnerHarness(group: string) {
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
          const envelope: DispatchEnvelope = runnerDispatchEnvelopeSchema.parse(
            JSON.parse(bytes),
          );
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

    await accept(
      runnersHeartbeatApi.heartbeat({
        headers: officialRunnerHeaders(),
        body: heartbeatPayload({
          runnerId,
          runnerHostname: hostname,
          group,
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

async function setupTokenRunMember() {
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
    addPersonalClaudeProvider(actor),
  ]);

  async function launchChatRun(args: {
    readonly prompt: string;
    readonly threadId?: string;
    readonly cloudBrowserEnabled?: boolean;
    readonly computerUseHostId?: string | null;
  }) {
    const beforeCount = runner.acceptedCount();
    const clientEventId = randomUUID();
    signIn(actor);
    const sent = await accept(
      chatEventsApi.send({
        headers: SESSION_HEADERS,
        body: {
          prompt: args.prompt,
          hasTextContent: true,
          clientEventId,
          model: CLAUDE_MODEL,
          ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
          ...(args.cloudBrowserEnabled === undefined
            ? {}
            : { cloudBrowserEnabled: args.cloudBrowserEnabled }),
          ...(args.computerUseHostId === undefined
            ? {}
            : { computerUseHostId: args.computerUseHostId }),
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
      actor,
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

  async function finishRun(
    launched: Awaited<ReturnType<typeof launchChatRun>>,
  ) {
    await accept(
      webhooksAgentCompleteApi.complete({
        headers: bearerHeaders(launched.execution.sandboxToken),
        body: {
          runId: launched.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `session-${launched.runId}`,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    launched.trackedEntry.done = true;
  }

  return {
    actor,
    launchChatRun,
    finishRun,
  };
}

describe("auth tokens issued through real Run dispatch", () => {
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
        accept(bankingApi.accounts({ headers: {}, body: {} }), [401]),
        accept(
          browserApi.get({
            headers: {},
            params: { threadId: warmupId },
            query: {},
          }),
          [401],
        ),
        accept(computerUseHostsApi.list({ headers: {} }), [401]),
        accept(
          featureSwitchesApi.update({
            headers: {},
            body: { switches: { [FeatureSwitchKey.Banking]: true } },
          }),
          [401],
        ),
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
          webhooksAgentHeartbeatApi.send({
            headers: {},
            body: { runId: warmupId },
          }),
          [401],
        ),
        accept(webhooksMemoryArchiveApi.read({ headers: {} }), [401]),
      ]);
    });
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  it(
    "tokens-030 gates computer-use capability on an explicit host grant",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupTokenRunMember();
      const desktop = await computerUse.startComputerUseHost(setup.actor);

      const defaultRun = await setup.launchChatRun({
        prompt: "Run without computer-use host grant",
        computerUseHostId: null,
      });
      const defaultToken = defaultRun.execution.platformEnvironment.OKOU_TOKEN;
      const defaultClaims = readOkouClaims(defaultToken);
      expect(defaultClaims.computerUseHostId).toBeUndefined();
      expect(defaultClaims.capabilities).not.toContain("computer-use:write");

      signOutClerk();
      const deniedHosts = await accept(
        computerUseHostsApi.list({
          headers: bearerHeaders(defaultToken ?? ""),
        }),
        [403],
      );
      expect(deniedHosts.body.error.code).toBe("FORBIDDEN");

      await setup.finishRun(defaultRun);

      const scopedRun = await setup.launchChatRun({
        prompt: "Run with explicit computer-use host grant",
        computerUseHostId: desktop.hostId,
      });
      const scopedToken = scopedRun.execution.platformEnvironment.OKOU_TOKEN;
      const scopedClaims = readOkouClaims(scopedToken);
      expect(scopedClaims.computerUseHostId).toBe(desktop.hostId);
      expect(scopedClaims.capabilities).toContain("computer-use:write");

      signOutClerk();
      const allowedHosts = await accept(
        computerUseHostsApi.list({
          headers: bearerHeaders(scopedToken ?? ""),
        }),
        [200],
      );
      expect(
        allowedHosts.body.hosts.map((host) => {
          return host.id;
        }),
      ).toStrictEqual([desktop.hostId]);
    },
  );

  it(
    "tokens-012 gates banking capability behind its feature switch",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupTokenRunMember();

      const disabledRun = await setup.launchChatRun({
        prompt: "Run with Banking switch disabled",
      });
      const disabledToken =
        disabledRun.execution.platformEnvironment.OKOU_TOKEN;
      const disabledClaims = readOkouClaims(disabledToken);
      expect(disabledClaims.capabilities).not.toContain("banking:read");

      signOutClerk();
      const deniedBanking = await accept(
        bankingApi.accounts({
          headers: bearerHeaders(disabledToken ?? ""),
          body: {},
        }),
        [403],
      );
      expect(deniedBanking.body.error.code).toBe("FORBIDDEN");

      await setup.finishRun(disabledRun);

      signIn(setup.actor);
      await accept(
        featureSwitchesApi.update({
          headers: SESSION_HEADERS,
          body: { switches: { [FeatureSwitchKey.Banking]: true } },
        }),
        [200],
      );

      const enabledRun = await setup.launchChatRun({
        prompt: "Run with Banking switch enabled",
      });
      const enabledToken = enabledRun.execution.platformEnvironment.OKOU_TOKEN;
      const enabledClaims = readOkouClaims(enabledToken);
      expect(enabledClaims.capabilities).toContain("banking:read");

      signOutClerk();
      const admittedBanking = await accept(
        bankingApi.accounts({
          headers: bearerHeaders(enabledToken ?? ""),
          body: {},
        }),
        [403],
      );
      expect(admittedBanking.body.error.code).toBe("BANKING_ACCESS_DENIED");
    },
  );

  it(
    "tokens-029 gates browser capabilities on thread access",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupTokenRunMember();

      const disabledRun = await setup.launchChatRun({
        prompt: "Run without cloud browser access",
        cloudBrowserEnabled: false,
      });
      const disabledToken =
        disabledRun.execution.platformEnvironment.OKOU_TOKEN;
      const disabledClaims = readOkouClaims(disabledToken);
      expect(disabledClaims.cloudBrowserEnabled).toBeUndefined();
      expect(disabledClaims.capabilities).not.toContain("browser:read");
      expect(disabledClaims.capabilities).not.toContain("browser:write");

      signOutClerk();
      const deniedBrowser = await accept(
        browserApi.get({
          headers: bearerHeaders(disabledToken ?? ""),
          params: { threadId: disabledRun.threadId },
          query: {},
        }),
        [403],
      );
      expect(deniedBrowser.body.error.code).toBe("FORBIDDEN");

      await setup.finishRun(disabledRun);

      const enabledRun = await setup.launchChatRun({
        prompt: "Run with cloud browser access enabled",
        cloudBrowserEnabled: true,
      });
      const enabledToken = enabledRun.execution.platformEnvironment.OKOU_TOKEN;
      const enabledClaims = readOkouClaims(enabledToken);
      expect(enabledClaims.cloudBrowserEnabled).toBeTruthy();
      expect(enabledClaims.capabilities).toContain("browser:read");
      expect(enabledClaims.capabilities).toContain("browser:write");

      signOutClerk();
      const admittedBrowser = await accept(
        browserApi.get({
          headers: bearerHeaders(enabledToken ?? ""),
          params: { threadId: enabledRun.threadId },
          query: {},
        }),
        [404],
      );
      expect(admittedBrowser.body.error.code).toBe("BROWSER_NOT_FOUND");
    },
  );

  it(
    "tokens-001 isolates expiring host firewall authority from Guest identities",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const issuedAt = Date.parse("2026-11-28T00:00:00.000Z");
      mockNow(issuedAt);

      const setup = await setupTokenRunMember();
      const launched = await setup.launchChatRun({
        prompt: "Issue host firewall and sandbox tokens at fixed time",
      });

      const firewallToken = launched.execution.firewallToken;
      const sandboxToken = launched.execution.sandboxToken;
      const firewallClaims = readFirewallClaims(firewallToken);
      expect(firewallClaims).toStrictEqual({
        scope: "firewall",
        userId: setup.actor.userId,
        orgId: setup.actor.orgId,
        runId: launched.runId,
      });

      signOutClerk();
      const [
        firewallAccepted,
        firewallRejectedAsSandbox,
        firewallRejectedAsOkou,
        sandboxRejectedAsFirewall,
        sandboxAccepted,
      ] = await Promise.all([
        accept(
          webhooksMemoryArchiveApi.read({
            headers: bearerHeaders(firewallToken),
          }),
          [200],
        ),
        accept(
          webhooksAgentHeartbeatApi.send({
            headers: bearerHeaders(firewallToken),
            body: { runId: launched.runId },
          }),
          [401],
        ),
        accept(
          authMeApi.me({
            headers: bearerHeaders(firewallToken),
          }),
          [401],
        ),
        accept(
          webhooksMemoryArchiveApi.read({
            headers: bearerHeaders(sandboxToken),
          }),
          [401],
        ),
        accept(
          webhooksAgentHeartbeatApi.send({
            headers: bearerHeaders(sandboxToken),
            body: { runId: launched.runId },
          }),
          [200],
        ),
      ]);

      expect(firewallAccepted.body).toStrictEqual({});
      expect(firewallRejectedAsSandbox.status).toBe(401);
      expect(firewallRejectedAsOkou.status).toBe(401);
      expect(sandboxRejectedAsFirewall.status).toBe(401);
      expect(sandboxAccepted.body).toStrictEqual({ ok: true });

      // Advance one minute past the firewall token's 3-hour lifetime.
      mockNow(issuedAt + RUN_CONTROL_TOKEN_TTL_MS + 60_000);
      const expiredFirewall = await accept(
        webhooksMemoryArchiveApi.read({
          headers: bearerHeaders(firewallToken),
        }),
        [401],
      );
      expect(expiredFirewall.body.error.code).toBe("UNAUTHORIZED");
    },
  );

  it(
    "tokens-004 generates a run token with the okou scope behind the sandbox prefix",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupTokenRunMember();
      const launched = await setup.launchChatRun({
        prompt: "Issue default Okou run token",
      });

      const okouToken = launched.execution.platformEnvironment.OKOU_TOKEN;
      expect(okouToken?.startsWith("vm0_sandbox_")).toBeTruthy();

      const claims = readOkouClaims(okouToken);
      expect(claims.scope).toBe("okou");
      expect(claims.userId).toBe(setup.actor.userId);
      expect(claims.orgId).toBe(setup.actor.orgId);
      expect(claims.runId).toBe(launched.runId);
      expect(claims.capabilities).toContain("notify:write");
      expect(claims.capabilities).toContain("data-search:read");
      expect(claims.capabilities).toContain("whatsapp:file:write");

      signOutClerk();
      const verifiedIdentity = await accept(
        authMeApi.me({
          headers: bearerHeaders(okouToken ?? ""),
        }),
        [200],
      );
      expect(verifiedIdentity.body).toStrictEqual({
        userId: setup.actor.userId,
        email: setup.actor.email,
        orgId: setup.actor.orgId,
      });
    },
  );
});
