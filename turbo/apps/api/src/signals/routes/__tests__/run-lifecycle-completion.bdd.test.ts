import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { CHAT_RUN_TRANSIENT_ERROR_MESSAGE } from "@okouai/api-contracts/contracts/errors";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runRunnerContract,
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  runnersHeartbeatContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookHeartbeatContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookTelemetryContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { infer as zInfer } from "zod";

import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { cliAuthRoutes } from "../cli-auth";
import { logsRoutes } from "../logs";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { webhooksAgentStorageRoutes } from "../webhooks-agent-storage";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { mockClerkUsers } from "./helpers/clerk-users";
import { memoryArchive } from "./helpers/public-runner-memory";
import { createRouteMocks } from "./helpers/route-test";

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
const DEFAULT_PROFILE = "vm0/default";
const RECOVERY_HISTORY_COMMAND =
  "okou chat messages --output-dir /tmp/okou-chat-history";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const routeMocks = createRouteMocks(context);

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
const chatThreadEventsApi = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadEventsContract);
const cliAuthDeviceApi = setupApp({
  context,
  routes: cliAuthRoutes,
})(cliAuthDeviceContract);
const cliAuthApproveApi = setupApp({
  context,
  routes: cliAuthRoutes,
})(cliAuthApproveContract);
const cliAuthTokenApi = setupApp({
  context,
  routes: cliAuthRoutes,
})(cliAuthTokenContract);
const runnersHeartbeatApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runnerRealtimeTokenApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnerRealtimeTokenContract);
const runsByIdApi = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runRunnerApi = setupApp({
  context,
  routes: runsRoutes,
})(runRunnerContract);
const runsCancelApi = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const logsByIdApi = setupApp({
  context,
  routes: logsRoutes,
})(logsByIdContract);
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
      lastName: "Completion",
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
      throw new AggregateError(errors, "Run completion test cleanup failed");
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

  async function register(): Promise<{
    readonly runnerId: string;
    readonly hostname: string;
    readonly heartbeatGeneration: number;
  }> {
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
          snapshotGeneration: heartbeatGeneration,
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

async function setupNativeRunMember() {
  const tracker = createRunTracker();
  const actor = bdd.user();
  const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;

  initRuntimeMocks();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
  mockClaudeCodeTokenEndpoint();
  signIn(actor);

  const runner = createDirectRunnerHarness(group);

  const [registeredRunner] = await Promise.all([
    runner.register(),
    provisionOrg(actor),
    addPersonalClaudeProvider(actor),
  ]);

  async function launchChatRun(args: {
    readonly prompt: string;
    readonly threadId?: string;
    readonly model?: string | null;
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

  async function readRun(runId: string) {
    signIn(actor);
    const response = await accept(
      runsByIdApi.getById({
        headers: SESSION_HEADERS,
        params: { id: runId },
      }),
      [200],
    );
    return response.body;
  }

  async function readRunRunner(runId: string) {
    signIn(actor);
    const response = await accept(
      runRunnerApi.getRunner({
        headers: SESSION_HEADERS,
        params: { id: runId },
      }),
      [200],
    );
    return response.body;
  }

  async function cancelRun(runId: string) {
    signIn(actor);
    const response = await accept(
      runsCancelApi.cancel({
        headers: SESSION_HEADERS,
        params: { id: runId },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    return response.body;
  }

  return {
    actor,
    group,
    registeredRunner,
    launchChatRun,
    readRun,
    readRunRunner,
    cancelRun,
  };
}

function installInMemoryStorageObjects(): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      command instanceof GetObjectCommand ||
      command instanceof HeadObjectCommand
    ) {
      const key = command.input.Key;
      const bytes = key ? objects.get(key) : undefined;
      if (!bytes) {
        return Promise.reject(
          Object.assign(new Error("Missing storage object"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      });
    }
    return Promise.resolve({});
  });
  return objects;
}

describe("RUN-03: run lifecycle completion, cancellation, and runner authentication", () => {
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
          chatThreadEventsApi.rows({
            headers: {},
            params: { threadId: warmupId },
            query: { sinceSeqId: 0, limit: 10 },
          }),
          [401],
        ),
        accept(
          cliAuthApproveApi.approve({
            headers: {},
            body: { device_code: "warmup" },
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
          runnerRealtimeTokenApi.create({
            headers: {},
            body: { group: "vm0/warmup" },
          }),
          [401],
        ),
        accept(
          runsByIdApi.getById({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runRunnerApi.getRunner({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          logsByIdApi.getById({ headers: {}, params: { id: warmupId } }),
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
    if (!warmed.ok) {
      throw warmed.error;
    }
  });

  it(
    "run-lifecycle-completion.bdd-006 delivers chat run callbacks through cancellation side effects",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const first = await setup.launchChatRun({
        prompt: "First cancellable turn",
        model: CLAUDE_MODEL,
      });
      await setup.cancelRun(first.runId);
      await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 137,
            error: "Cancelled by user",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      first.trackedEntry.done = true;

      const second = await setup.launchChatRun({
        prompt: "Second cancellable turn",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });
      await setup.cancelRun(second.runId);
      await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(second.execution.sandboxToken),
          body: {
            runId: second.runId,
            exitCode: 137,
            error: "Cancelled by user",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      second.trackedEntry.done = true;

      const third = await setup.launchChatRun({
        prompt: "Third cancellable turn without sandbox completion",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });
      await setup.cancelRun(third.runId);

      const [firstRun, secondRun, thirdRun, projectedEvents] =
        await Promise.all([
          setup.readRun(first.runId),
          setup.readRun(second.runId),
          setup.readRun(third.runId),
          (async () => {
            signIn(setup.actor);
            return await readProjectedChatEvents(context, {
              threadId: first.threadId,
              headers: SESSION_HEADERS,
            });
          })(),
        ]);

      expect(firstRun.status).toBe("cancelled");
      expect(secondRun.status).toBe("cancelled");
      expect(thirdRun.status).toBe("cancelled");

      const cancelledEvents = projectedEvents.filter((event) => {
        return event.eventType === "run.cancelled";
      });
      expect(cancelledEvents).toHaveLength(3);
      for (const runId of [first.runId, second.runId, third.runId]) {
        const match = cancelledEvents.find((event) => {
          return event.runId === runId;
        });
        expect(match?.runLifecycleEvent).toBe("cancelled");
      }
      const thirdEvent = cancelledEvents.find((event) => {
        return event.runId === third.runId;
      });
      expect(thirdEvent?.content).toBe("Run cancelled");
    },
  );

  it(
    "run-lifecycle-completion.bdd-007 (1/3) rejects heartbeats after clean exit completion",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const completedRun = await setup.launchChatRun({
        prompt: "Run that completes cleanly",
        model: CLAUDE_MODEL,
      });
      await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(completedRun.execution.sandboxToken),
          body: {
            runId: completedRun.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `session-${completedRun.runId}`,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      completedRun.trackedEntry.done = true;

      const heartbeat = await accept(
        webhooksAgentHeartbeatApi.send({
          headers: sandboxHeaders(completedRun.execution.sandboxToken),
          body: { runId: completedRun.runId },
        }),
        [404],
      );
      expect(heartbeat.status).toBe(404);
    },
  );

  it(
    "run-lifecycle-completion.bdd-007 (2/3) rejects heartbeats after non-zero exit failure",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const failedRun = await setup.launchChatRun({
        prompt: "Run that exits non-zero",
        model: CLAUDE_MODEL,
      });
      await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(failedRun.execution.sandboxToken),
          body: {
            runId: failedRun.runId,
            exitCode: 1,
            error: "Command exited with status 1",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      failedRun.trackedEntry.done = true;

      const heartbeat = await accept(
        webhooksAgentHeartbeatApi.send({
          headers: sandboxHeaders(failedRun.execution.sandboxToken),
          body: { runId: failedRun.runId },
        }),
        [404],
      );
      expect(heartbeat.status).toBe(404);
    },
  );

  it(
    "run-lifecycle-completion.bdd-007 (3/3) rejects heartbeats after member cancellation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();

      const cancelledRun = await setup.launchChatRun({
        prompt: "Run cancelled by member",
        model: CLAUDE_MODEL,
      });
      await setup.cancelRun(cancelledRun.runId);

      const heartbeat = await accept(
        webhooksAgentHeartbeatApi.send({
          headers: sandboxHeaders(cancelledRun.execution.sandboxToken),
          body: { runId: cancelledRun.runId },
        }),
        [404],
      );
      expect(heartbeat.status).toBe(404);
    },
  );

  it(
    "run-lifecycle-completion.bdd-032 preserves exact native recovery outputs after a failed Runner fallback",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const first = await setup.launchChatRun({
        prompt: "Initial turn that fails before reporting outputs",
        model: CLAUDE_MODEL,
      });

      const initialFailure = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 1,
            error: "Runner fallback failure",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(initialFailure.body).toStrictEqual({
        success: true,
        status: "failed",
      });
      first.trackedEntry.done = true;

      const recoveredSessionId = `recovered-${first.runId}`;
      const recoveryBody = {
        runId: first.runId,
        exitCode: 1,
        completion: {
          cliAgentType: "claude-code" as const,
          cliAgentSessionId: recoveredSessionId,
          cliAgentSessionHistoryDisposition: "native_only" as const,
        },
      };

      const recovery = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: recoveryBody,
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(recovery.body).toStrictEqual({ success: true, status: "failed" });

      const afterRecovery = await setup.readRun(first.runId);
      expect(afterRecovery.status).toBe("failed");
      expect(afterRecovery.result?.frameworkSessionId).toBe(recoveredSessionId);
      expect(Array.isArray(afterRecovery.result?.storageOutputs)).toBeTruthy();

      const replay = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: recoveryBody,
        }),
        [200],
      );
      expect(replay.body).toStrictEqual({ success: true, status: "failed" });
      expect((await setup.readRun(first.runId)).result).toStrictEqual(
        afterRecovery.result,
      );

      const conflict = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            ...recoveryBody,
            completion: {
              ...recoveryBody.completion,
              cliAgentSessionId: `conflicting-${first.runId}`,
            },
          },
        }),
        [400],
      );
      expect(conflict.body.error.message).toContain(
        "[RUN_OUTPUT_ALREADY_COMMITTED]",
      );
      expect((await setup.readRun(first.runId)).result).toStrictEqual(
        afterRecovery.result,
      );

      const continued = await setup.launchChatRun({
        prompt: "Continue after failed fallback",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });
      expect(continued.execution.nativeContinuation.sessionId).toBeNull();
      expect(continued.execution.nativeContinuation.generationRunId).toBeNull();
      expect(continued.execution.nativeContinuation.recoveryPrompt).toContain(
        RECOVERY_HISTORY_COMMAND,
      );
    },
  );

  it(
    "run-lifecycle-completion.bdd-033 preserves exact native recovery outputs after a cancelled Runner fallback",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const first = await setup.launchChatRun({
        prompt: "Initial turn cancelled before recovery outputs",
        model: CLAUDE_MODEL,
      });
      await setup.cancelRun(first.runId);

      const recoveredSessionId = `recovered-cancel-${first.runId}`;
      const recoveryBody = {
        runId: first.runId,
        exitCode: 137,
        completion: {
          cliAgentType: "claude-code" as const,
          cliAgentSessionId: recoveredSessionId,
          cliAgentSessionHistoryDisposition: "native_only" as const,
        },
      };

      const recovery = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: recoveryBody,
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(recovery.body).toStrictEqual({ success: true, status: "failed" });
      first.trackedEntry.done = true;

      const afterRecovery = await setup.readRun(first.runId);
      expect(afterRecovery.status).toBe("cancelled");
      expect(afterRecovery.result?.frameworkSessionId).toBe(recoveredSessionId);
      expect(Array.isArray(afterRecovery.result?.storageOutputs)).toBeTruthy();

      const replay = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: recoveryBody,
        }),
        [200],
      );
      expect(replay.body).toStrictEqual({ success: true, status: "failed" });
      expect((await setup.readRun(first.runId)).result).toStrictEqual(
        afterRecovery.result,
      );

      const conflict = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            ...recoveryBody,
            completion: {
              ...recoveryBody.completion,
              cliAgentSessionId: `conflicting-cancel-${first.runId}`,
            },
          },
        }),
        [400],
      );
      expect(conflict.body.error.message).toContain(
        "[RUN_OUTPUT_ALREADY_COMMITTED]",
      );
      expect((await setup.readRun(first.runId)).result).toStrictEqual(
        afterRecovery.result,
      );

      const continued = await setup.launchChatRun({
        prompt: "Continue after cancelled recovery",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });
      expect(continued.execution.nativeContinuation.sessionId).toBe(
        recoveredSessionId,
      );
      expect(continued.execution.nativeContinuation.generationRunId).toBe(
        first.runId,
      );
    },
  );

  it(
    "run-lifecycle-completion.bdd-038 preserves initialized native binding through timeout and late recovery outputs",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const first = await setup.launchChatRun({
        prompt: "Initialized run that later times out",
        model: CLAUDE_MODEL,
      });

      const cliSessionId = `init-session-${first.runId}`;
      await accept(
        webhooksAgentEventsApi.send({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: cliSessionId,
                sequenceNumber: 0,
              },
            ],
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();

      const timedOut = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 124,
            error: "runner job timed out",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(timedOut.body).toStrictEqual({ success: true, status: "failed" });
      first.trackedEntry.done = true;

      const failedRun = await setup.readRun(first.runId);
      expect(failedRun.status).toBe("failed");
      expect(failedRun.failureReason).toBe("unknown");

      const lateRecovery = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 124,
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
      expect(lateRecovery.body).toStrictEqual({
        success: true,
        status: "failed",
      });

      const recoveredRun = await setup.readRun(first.runId);
      expect(recoveredRun.result?.frameworkSessionId).toBe(cliSessionId);
      expect(Array.isArray(recoveredRun.result?.storageOutputs)).toBeTruthy();

      const continued = await setup.launchChatRun({
        prompt: "Continue initialized timed-out conversation",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });
      expect(continued.execution.nativeContinuation.sessionId).toBe(
        cliSessionId,
      );
      expect(continued.execution.nativeContinuation.generationRunId).toBe(
        first.runId,
      );
    },
  );

  it(
    "run-lifecycle-completion.bdd-039 preserves uninitialized native binding through timeout and late recovery outputs",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const first = await setup.launchChatRun({
        prompt: "Uninitialized run that later times out",
        model: CLAUDE_MODEL,
      });

      const timedOut = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 124,
            error: "runner job timed out",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(timedOut.body).toStrictEqual({ success: true, status: "failed" });
      first.trackedEntry.done = true;

      const failedRun = await setup.readRun(first.runId);
      expect(failedRun.status).toBe("failed");
      expect(failedRun.failureReason).toBe("unknown");

      const lateSessionId = `late-uninit-${first.runId}`;
      const lateRecovery = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(first.execution.sandboxToken),
          body: {
            runId: first.runId,
            exitCode: 124,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: lateSessionId,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(lateRecovery.body).toStrictEqual({
        success: true,
        status: "failed",
      });

      const recoveredRun = await setup.readRun(first.runId);
      expect(recoveredRun.result?.frameworkSessionId).toBe(lateSessionId);
      expect(Array.isArray(recoveredRun.result?.storageOutputs)).toBeTruthy();

      const continued = await setup.launchChatRun({
        prompt: "Continue uninitialized timed-out conversation",
        threadId: first.threadId,
        model: CLAUDE_MODEL,
      });
      expect(continued.execution.nativeContinuation.sessionId).toBeNull();
      expect(continued.execution.nativeContinuation.generationRunId).toBeNull();
      expect(continued.execution.nativeContinuation.recoveryPrompt).toContain(
        RECOVERY_HISTORY_COMMAND,
      );
    },
  );

  it(
    "run-lifecycle-completion.bdd-001 cancels a running Run and treats repeat cancellation as settled",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const launched = await setup.launchChatRun({
        prompt: "Long task to cancel",
        model: CLAUDE_MODEL,
      });

      expect((await setup.readRun(launched.runId)).status).toBe("running");

      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();

      const firstCancel = await setup.cancelRun(launched.runId);
      expect(firstCancel.status).toBe("cancelled");
      expect((await setup.readRun(launched.runId)).status).toBe("cancelled");

      expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
        `runner-group:${setup.group}`,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
        runId: launched.runId,
        mode: "cooperative",
      });

      signIn(setup.actor);
      const repeatCancel = await accept(
        runsCancelApi.cancel({
          headers: SESSION_HEADERS,
          params: { id: launched.runId },
        }),
        [200],
      );
      expect(repeatCancel.status).toBe(200);
      expect(repeatCancel.body.status).toBe("cancelled");
    },
  );

  it(
    "run-lifecycle-completion.bdd-008 reports snapshots and telemetry HTTP outcomes through authenticated sandbox webhooks",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const previousTelemetryToken = optionalEnv("AXIOM_TOKEN_TELEMETRY");
      onTestFinished(() => {
        mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", previousTelemetryToken);
      });

      const setup = await setupNativeRunMember();
      const objects = installInMemoryStorageObjects();

      mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", "xaat-bdd-telemetry");
      server.use(
        http.post(
          "https://api.axiom.co/v1/datasets/:dataset/ingest",
          async ({ request }) => {
            const payload: unknown = await request.json();
            const count = Array.isArray(payload) ? payload.length : 1;
            return HttpResponse.json({
              ingested: count,
              failed: 0,
              processedBytes: 128,
            });
          },
        ),
      );

      const launched = await setup.launchChatRun({
        prompt: "Write memory and report telemetry",
        model: CLAUDE_MODEL,
      });
      const memory = launched.execution.startupInputs.memory;
      if (!memory) {
        throw new Error("Expected dispatched chat Run to carry a Memory mount");
      }

      const headers = sandboxHeaders(launched.execution.sandboxToken);
      const timestamp = nowDate().toISOString();

      const configuredTelemetry = await accept(
        webhooksAgentTelemetryApi.send({
          headers,
          body: {
            runId: launched.runId,
            networkLogs: [{ timestamp, type: "http" }],
            sandboxOperations: [
              {
                ts: timestamp,
                action_type: "storage_commit",
                duration_ms: 12,
                success: true,
              },
            ],
          },
        }),
        [200],
      );
      expect(configuredTelemetry.status).toBe(200);

      mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", undefined);
      const unconfiguredTelemetry = await accept(
        webhooksAgentTelemetryApi.send({
          headers,
          body: {
            runId: launched.runId,
            networkLogs: [{ timestamp, type: "http" }],
            sandboxOperations: [
              {
                ts: timestamp,
                action_type: "storage_commit",
                duration_ms: 8,
                success: true,
              },
            ],
          },
        }),
        [200],
      );
      expect(unconfiguredTelemetry.status).toBe(200);

      const files = [
        storageTextFile("notes/bdd-memory.md", "Snapshot persisted in test\n"),
      ];
      const prepared = await accept(
        webhooksAgentStoragePrepareApi.prepare({
          headers,
          body: {
            runId: launched.runId,
            storageId: memory.storageId,
            parentVersionId: memory.versionId,
            files,
          },
        }),
        [200],
      );
      if (!prepared.body.uploads) {
        throw new Error("Expected presigned upload targets for new version");
      }
      objects.set(
        prepared.body.uploads.archive.key,
        memoryArchive("notes/bdd-memory.md", "Snapshot persisted in test\n"),
      );
      objects.set(
        prepared.body.uploads.manifest.key,
        Buffer.from(
          JSON.stringify({
            version: 1,
            files,
            createdAt: timestamp,
          }),
        ),
      );

      const committed = await accept(
        webhooksAgentStorageCommitApi.commit({
          headers,
          body: {
            runId: launched.runId,
            storageId: memory.storageId,
            parentVersionId: memory.versionId,
            versionId: prepared.body.versionId,
            files,
          },
        }),
        [200],
      );
      expect(committed.body.versionId).toBe(prepared.body.versionId);
      expect(committed.body.versionId).not.toBe(memory.versionId);

      const expectedStorageOutputs = [
        {
          name: "memory",
          mountPath: CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
          version: committed.body.versionId,
          ...(memory.missingRootPolicy === undefined
            ? {}
            : { missingRootPolicy: memory.missingRootPolicy }),
        },
      ];
      const completionBody = {
        runId: launched.runId,
        exitCode: 0,
        completion: {
          cliAgentType: "claude-code" as const,
          cliAgentSessionId: `snapshot-session-${launched.runId}`,
          cliAgentSessionHistoryDisposition: "native_only" as const,
          storageOutputs: expectedStorageOutputs,
        },
      };

      const completed = await accept(
        webhooksAgentCompleteApi.complete({
          headers,
          body: completionBody,
        }),
        [200],
      );
      await flushWaitUntilForTest();
      launched.trackedEntry.done = true;
      expect(completed.body).toStrictEqual({
        success: true,
        status: "completed",
      });

      signIn(setup.actor);
      const [runAfterComplete, logDetail] = await Promise.all([
        setup.readRun(launched.runId),
        accept(
          logsByIdApi.getById({
            headers: SESSION_HEADERS,
            params: { id: launched.runId },
          }),
          [200],
        ),
      ]);
      expect(runAfterComplete.status).toBe("completed");
      expect(runAfterComplete.result?.storageOutputs).toStrictEqual(
        expectedStorageOutputs,
      );
      expect(logDetail.body.status).toBe("completed");
      expect(logDetail.body.framework).toBe("claude-code");

      const replayed = await accept(
        webhooksAgentCompleteApi.complete({
          headers,
          body: completionBody,
        }),
        [200],
      );
      expect(replayed.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      await expect(setup.readRun(launched.runId)).resolves.toStrictEqual(
        runAfterComplete,
      );

      const lateFailure = await accept(
        webhooksAgentCompleteApi.complete({
          headers,
          body: {
            runId: launched.runId,
            exitCode: 1,
            error: "Late failure after completion",
            failureReason: "provider_server_error",
          },
        }),
        [200],
      );
      expect(lateFailure.body).toStrictEqual({
        success: true,
        status: "completed",
      });
      const runAfterLateFailure = await setup.readRun(launched.runId);
      expect(runAfterLateFailure.status).toBe("completed");
      expect(runAfterLateFailure.failureReason).toBeUndefined();
    },
  );

  it(
    "run-lifecycle-completion.bdd-030 normalizes a future reason and ignores contradictory legacy cancellation diagnostics",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const launched = await setup.launchChatRun({
        prompt: "Trigger unrecognized future failure reason",
        model: CLAUDE_MODEL,
      });

      const completed = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(launched.execution.sandboxToken),
          body: {
            runId: launched.runId,
            exitCode: 1,
            failureReason: "future_reason",
            error:
              "Run was cancelled after hitting usage limit at https://private.internal.example/secret-trace",
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      launched.trackedEntry.done = true;

      expect(completed.body).toStrictEqual({ success: true, status: "failed" });

      signIn(setup.actor);
      const [run, projectedEvents, rawRows] = await Promise.all([
        setup.readRun(launched.runId),
        readProjectedChatEvents(context, {
          threadId: launched.threadId,
          headers: SESSION_HEADERS,
        }),
        accept(
          chatThreadEventsApi.rows({
            headers: SESSION_HEADERS,
            params: { threadId: launched.threadId },
            query: { sinceSeqId: 0, limit: 50 },
          }),
          [200],
        ),
      ]);

      expect(run.status).toBe("failed");
      expect(run.failureReason).toBe("unknown");

      const projectedFailures = projectedEvents.flatMap((event) => {
        return event.eventType === "run.failed" &&
          event.runId === launched.runId
          ? [event]
          : [];
      });
      expect(projectedFailures).toHaveLength(1);
      expect(projectedFailures[0]?.failureReason).toBe("unknown");
      expect(projectedFailures[0]?.content).toBe(
        CHAT_RUN_TRANSIENT_ERROR_MESSAGE,
      );

      const rawFailures = rawRows.body.rows.filter((row) => {
        return row.eventType === "run.failed" && row.runId === launched.runId;
      });
      expect(rawFailures).toHaveLength(1);
      expect(rawFailures[0]?.failureReason).toBe("unknown");
    },
  );

  it(
    "run-lifecycle-completion.bdd-040 acknowledges a clean exit whose missing outputs fails the run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const launched = await setup.launchChatRun({
        prompt: "Clean exit without native outputs",
        model: CLAUDE_MODEL,
      });
      const runnerBefore = await setup.readRunRunner(launched.runId);

      const completed = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(launched.execution.sandboxToken),
          body: {
            runId: launched.runId,
            exitCode: 0,
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      launched.trackedEntry.done = true;

      expect(completed.body).toStrictEqual({ success: true, status: "failed" });
      const [runAfter, runnerAfter] = await Promise.all([
        setup.readRun(launched.runId),
        setup.readRunRunner(launched.runId),
      ]);
      expect(runAfter.status).toBe("failed");
      expect(runAfter.failureReason).toBe("unknown");
      expect(runnerAfter).toStrictEqual(runnerBefore);
    },
  );

  it(
    "run-lifecycle-completion.bdd-042 keeps a cancelled run settled when its finalized completion arrives late",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupNativeRunMember();
      const launched = await setup.launchChatRun({
        prompt: "Cancel before finalized clean completion arrives",
        model: CLAUDE_MODEL,
      });

      await setup.cancelRun(launched.runId);

      const lateCleanCompletion = await accept(
        webhooksAgentCompleteApi.complete({
          headers: sandboxHeaders(launched.execution.sandboxToken),
          body: {
            runId: launched.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `late-clean-${launched.runId}`,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      launched.trackedEntry.done = true;

      expect(lateCleanCompletion.body).toStrictEqual({
        success: true,
        status: "failed",
      });
      expect((await setup.readRun(launched.runId)).status).toBe("cancelled");
    },
  );

  it("run-lifecycle-completion.bdd-004 scopes CLI PAT realtime access to allowed Runner groups", async () => {
    const actor = bdd.user();
    const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;

    initRuntimeMocks();
    signIn(actor);

    const [device] = await Promise.all([
      accept(cliAuthDeviceApi.create({ body: {} }), [200]),
      provisionOrg(actor),
    ]);
    signIn(actor);
    await accept(
      cliAuthApproveApi.approve({
        headers: SESSION_HEADERS,
        body: { device_code: device.body.device_code },
      }),
      [200],
    );
    const exchanged = await accept(
      cliAuthTokenApi.exchange({
        body: { device_code: device.body.device_code },
      }),
      [200],
    );
    const patHeaders = {
      authorization: `Bearer ${exchanged.body.access_token}`,
    };

    const runnerId = randomUUID();
    await accept(
      runnersHeartbeatApi.heartbeat({
        headers: patHeaders,
        body: heartbeatPayload({
          runnerId,
          runnerHostname: `runner-${runnerId}.okou.app`,
          group,
        }),
      }),
      [200],
    );

    const issuedTokenRequest = {
      keyName: "bdd-key.name",
      ttl: 3_600_000,
      timestamp: now(),
      capability: JSON.stringify({ [`runner-group:${group}`]: ["subscribe"] }),
      nonce: `nonce-${randomUUID()}`,
      mac: "bdd-mac-signature",
    };
    context.mocks.ably.createTokenRequest.mockResolvedValueOnce(
      issuedTokenRequest,
    );

    const [allowed, forbidden] = await Promise.all([
      accept(
        runnerRealtimeTokenApi.create({
          headers: patHeaders,
          body: { group },
        }),
        [200],
      ),
      accept(
        runnerRealtimeTokenApi.create({
          headers: patHeaders,
          body: { group: "wrong-org/default" },
        }),
        [403],
      ),
    ]);

    expect(allowed.body).toStrictEqual(issuedTokenRequest);
    expect(forbidden.body.error.message).toBe(
      "Only vm0/* runner groups are supported",
    );
  });

  it("run-lifecycle-completion.bdd-005 rejects runner calls with malformed or wrong runner credentials", async () => {
    const realSecret = env("OFFICIAL_RUNNER_SECRET");
    const wrongFirstChar = realSecret.startsWith("0") ? "1" : "0";
    const wrongSameLengthSecret = `${wrongFirstChar}${realSecret.slice(1)}`;
    const body = heartbeatPayload({
      runnerId: randomUUID(),
      runnerHostname: `runner-${randomUUID()}.okou.app`,
      group: `vm0/bdd-${randomUUID().slice(0, 8)}`,
    });

    const invalidAuthorizations = [
      `Basic ${Buffer.from("runner:password").toString("base64")}`,
      "Bearer not-a-runner-credential",
      "Bearer vm0_live_invalid.pat.token",
      "Bearer vm0_official_short",
      `Bearer vm0_official_${wrongSameLengthSecret}`,
    ];

    const responses = await Promise.all(
      invalidAuthorizations.map((authorization) => {
        return accept(
          runnersHeartbeatApi.heartbeat({
            headers: { authorization },
            body,
          }),
          [401],
        );
      }),
    );

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body.error).toStrictEqual({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
  });
});
