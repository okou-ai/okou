import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runContextContract,
  runRunnerContract,
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
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
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { cliAuthRoutes } from "../cli-auth";
import { instructionsRoutes } from "../instructions";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runDetailRoutes } from "../run-detail";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

type DispatchEnvelope = zInfer<typeof runnerDispatchEnvelopeSchema>;
type RunnerHeartbeatBody = zInfer<
  (typeof runnersHeartbeatContract.heartbeat)["body"]
>;

interface CapturedDispatch {
  readonly runnerId: string;
  readonly heartbeatGeneration: number;
  readonly envelope: DispatchEnvelope;
  readonly bytes: string;
  readonly rawBytes: Buffer;
  readonly encoding: string | null;
}

interface RegisteredRunner {
  readonly runnerId: string;
  readonly heartbeatGeneration: number;
  readonly hostname: string;
  readonly dispatches: CapturedDispatch[];
}

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
const instructionsApi = setupApp({
  context,
  routes: instructionsRoutes,
})(instructionsContract);
const chatEventsApi = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const chatThreadEventsApi = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadEventsContract);
const runnersHeartbeatApi = setupApp({
  context,
  routes: runnersRoutes,
})(runnersHeartbeatContract);
const runsByIdApi = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runRunnerApi = setupApp({
  context,
  routes: runsRoutes,
})(runRunnerContract);
const runsQueueApi = setupApp({
  context,
  routes: runsRoutes,
})(runsQueueContract);
const runContextApi = setupApp({
  context,
  routes: runDetailRoutes,
})(runContextContract);
const runsCancelApi = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const webhooksAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
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

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
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
      lastName: "Dispatch",
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
  readonly runnerHostname?: string;
  readonly group: string;
  readonly snapshotGeneration?: number;
  readonly snapshotSequence?: number;
  readonly totalVcpu?: number;
  readonly totalMemoryMb?: number;
  readonly maxConcurrent?: number;
  readonly allocatedVcpu?: number;
  readonly allocatedMemoryMb?: number;
  readonly runningCount?: number;
  readonly admittableProfiles?: readonly string[];
  readonly mode?: RunnerHeartbeatBody["mode"];
  readonly ingressServiceActive?: boolean;
}): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId,
    ...(args.runnerHostname === undefined
      ? {}
      : { runnerHostname: args.runnerHostname }),
    group: args.group,
    snapshotGeneration: args.snapshotGeneration ?? 1,
    snapshotSequence: args.snapshotSequence ?? 1,
    totalVcpu: args.totalVcpu ?? 8,
    totalMemoryMb: args.totalMemoryMb ?? 16_384,
    maxConcurrent: args.maxConcurrent ?? 2,
    allocatedVcpu: args.allocatedVcpu ?? 0,
    allocatedMemoryMb: args.allocatedMemoryMb ?? 0,
    runningCount: args.runningCount ?? 0,
    admittableProfiles: [...(args.admittableProfiles ?? [DEFAULT_PROFILE])],
    heldSandboxStates: [],
    heldHomeStates: [],
    activeReuseProducers: [],
    mode: args.mode ?? "running",
    ingressServiceActive: args.ingressServiceActive ?? true,
  };
}

function createRunTracker() {
  const tracked: TrackedRun[] = [];

  onTestFinished(async () => {
    clearMockNow();
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
      throw new AggregateError(errors, "Direct dispatch test cleanup failed");
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

function createRunnerRegistry(defaultGroup: string) {
  const acceptedByRunId = new Map<string, CapturedDispatch>();
  const acceptedOrder: string[] = [];
  const allDispatches: CapturedDispatch[] = [];

  function mountDispatchHandler(args: {
    readonly runnerId: string;
    readonly heartbeatGeneration: number;
    readonly hostname: string;
    readonly dispatches: CapturedDispatch[];
    readonly reply?: (
      dispatch: CapturedDispatch,
    ) => Response | Promise<Response>;
  }): void {
    const expectedAuth = officialRunnerHeaders().authorization;
    server.use(
      http.post(
        `https://${args.hostname}/runners/${args.runnerId}/control/runs/:runId/dispatch`,
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
            envelope.runnerId !== args.runnerId ||
            envelope.heartbeatGeneration !== args.heartbeatGeneration ||
            envelope.executionContext.runId !== params.runId
          ) {
            throw new Error("Unexpected direct Runner dispatch identity");
          }
          const captured: CapturedDispatch = {
            runnerId: args.runnerId,
            heartbeatGeneration: args.heartbeatGeneration,
            envelope,
            bytes,
            rawBytes,
            encoding,
          };
          args.dispatches.push(captured);
          allDispatches.push(captured);
          if (args.reply) {
            const response = await args.reply(captured);
            if (response.status === 200) {
              const cloned: unknown = await response.clone().json();
              if (
                typeof cloned === "object" &&
                cloned !== null &&
                "disposition" in cloned &&
                cloned.disposition === "accepted"
              ) {
                acceptedByRunId.set(envelope.executionContext.runId, captured);
                acceptedOrder.push(envelope.executionContext.runId);
              }
            }
            return response;
          }
          acceptedByRunId.set(envelope.executionContext.runId, captured);
          acceptedOrder.push(envelope.executionContext.runId);
          return HttpResponse.json({
            runnerId: args.runnerId,
            heartbeatGeneration: args.heartbeatGeneration,
            runId: envelope.executionContext.runId,
            disposition: "accepted",
          });
        },
      ),
    );
  }

  async function registerRunner(
    options: {
      readonly runnerId?: string;
      readonly heartbeatGeneration?: number;
      readonly snapshotSequence?: number;
      readonly hostname?: string;
      readonly group?: string;
      readonly totalVcpu?: number;
      readonly totalMemoryMb?: number;
      readonly maxConcurrent?: number;
      readonly allocatedVcpu?: number;
      readonly allocatedMemoryMb?: number;
      readonly runningCount?: number;
      readonly admittableProfiles?: readonly string[];
      readonly mode?: RunnerHeartbeatBody["mode"];
      readonly ingressServiceActive?: boolean;
      readonly authHeader?: string;
      readonly mountHandler?: boolean;
      readonly reply?: (
        dispatch: CapturedDispatch,
      ) => Response | Promise<Response>;
    } = {},
  ): Promise<RegisteredRunner> {
    const runnerId = options.runnerId ?? randomUUID();
    const heartbeatGeneration = options.heartbeatGeneration ?? 1;
    const hostname = options.hostname ?? `runner-${runnerId}.okou.app`;
    const dispatches: CapturedDispatch[] = [];

    if (options.mountHandler !== false) {
      mountDispatchHandler({
        runnerId,
        heartbeatGeneration,
        hostname,
        dispatches,
        reply: options.reply,
      });
    }

    await accept(
      runnersHeartbeatApi.heartbeat({
        headers:
          options.authHeader === undefined
            ? officialRunnerHeaders()
            : { authorization: options.authHeader },
        body: heartbeatPayload({
          runnerId,
          runnerHostname: hostname,
          group: options.group ?? defaultGroup,
          snapshotGeneration: heartbeatGeneration,
          snapshotSequence: options.snapshotSequence ?? 1,
          totalVcpu: options.totalVcpu,
          totalMemoryMb: options.totalMemoryMb,
          maxConcurrent: options.maxConcurrent,
          allocatedVcpu: options.allocatedVcpu,
          allocatedMemoryMb: options.allocatedMemoryMb,
          runningCount: options.runningCount,
          admittableProfiles: options.admittableProfiles,
          mode: options.mode,
          ingressServiceActive: options.ingressServiceActive,
        }),
      }),
      [200],
    );

    return { runnerId, heartbeatGeneration, hostname, dispatches };
  }

  function latestAccepted(afterCount: number): CapturedDispatch {
    const runId = acceptedOrder[afterCount];
    if (!runId) {
      throw new Error("Expected a direct Runner dispatch to be accepted");
    }
    const dispatch = acceptedByRunId.get(runId);
    if (!dispatch) {
      throw new Error(`Missing accepted dispatch for run ${runId}`);
    }
    return dispatch;
  }

  return {
    registerRunner,
    acceptedCount: () => {
      return acceptedOrder.length;
    },
    latestAccepted,
    allDispatches,
  };
}

async function setupDispatchWorkspace() {
  const tracker = createRunTracker();
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected a workspace actor");
  }
  const orgId = actor.orgId;
  const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;

  initRuntimeMocks();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_bdd_clerk");
  mockClaudeCodeTokenEndpoint();
  signIn(actor);

  const registry = createRunnerRegistry(group);

  await Promise.all([
    (async () => {
      context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
        type: "organization.created",
        data: { id: orgId, created_by: actor.userId, created_at: now() },
      });
      await accept(
        webhooksClerkApi.post({ body: "{}", extraHeaders: {} }),
        [200],
      );
      await flushWaitUntilForTest();
    })(),
    accept(
      personalModelProvidersApi.upsert({
        headers: SESSION_HEADERS,
        body: {
          type: "claude-code-oauth-token",
          secret: `claude-token-${randomUUID()}`,
        },
      }),
      [201],
    ),
  ]);

  async function sendPrompt(args: {
    readonly prompt: string;
    readonly threadId?: string;
    readonly clientEventId?: string;
  }) {
    signIn(actor);
    const clientEventId = args.clientEventId ?? randomUUID();
    const response = await accept(
      chatEventsApi.send({
        headers: SESSION_HEADERS,
        body: {
          prompt: args.prompt,
          hasTextContent: true,
          clientEventId,
          model: CLAUDE_MODEL,
          ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: args.prompt }],
          },
        },
      }),
      [201],
    );
    return { threadId: response.body.threadId, eventId: clientEventId };
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

  async function readQueue() {
    signIn(actor);
    const response = await accept(
      runsQueueApi.getQueue({ headers: SESSION_HEADERS }),
      [200],
    );
    return response.body;
  }

  async function readThreadPromptRunIds(threadId: string): Promise<string[]> {
    signIn(actor);
    const events = await readProjectedChatEvents(context, {
      threadId,
      headers: SESSION_HEADERS,
    });
    return events.flatMap((event) => {
      return event.eventType === "input.prompt" && event.runId !== undefined
        ? [event.runId]
        : [];
    });
  }

  return {
    actor,
    group,
    registry,
    tracker,
    sendPrompt,
    readRun,
    readRunRunner,
    readQueue,
    readThreadPromptRunIds,
  };
}

function rejectedResponse(dispatch: CapturedDispatch): Response {
  return HttpResponse.json({
    runnerId: dispatch.runnerId,
    heartbeatGeneration: dispatch.heartbeatGeneration,
    runId: dispatch.envelope.executionContext.runId,
    disposition: "rejected",
  });
}

function acceptedResponse(dispatch: CapturedDispatch): Response {
  return HttpResponse.json({
    runnerId: dispatch.runnerId,
    heartbeatGeneration: dispatch.heartbeatGeneration,
    runId: dispatch.envelope.executionContext.runId,
    disposition: "accepted",
  });
}

describe("Direct Runner dispatch", () => {
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
          instructionsApi.update({
            headers: {},
            body: { content: "warmup" },
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
          runRunnerApi.getRunner({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(runsQueueApi.getQueue({ headers: {} }), [401]),
        accept(
          runContextApi.getContext({ headers: {}, params: { id: warmupId } }),
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
          cliAuthApproveApi.approve({
            headers: {},
            body: { device_code: "warmup" },
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
    "runners-direct-dispatch-007 persists preparation failure and releases admission before another Run",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();
      await setup.registry.registerRunner({ heartbeatGeneration: 2 });

      signIn(setup.actor);
      await accept(
        instructionsApi.update({
          headers: SESSION_HEADERS,
          body: {
            content: `Personal instructions ${randomUUID()} requiring signed object-storage bundle URLs.`,
          },
        }),
        [200],
      );

      context.mocks.s3.getSignedUrl.mockRejectedValue(
        new Error("Object signing is unavailable"),
      );

      const firstSent = await setup.sendPrompt({
        prompt: "First prompt while URL signing fails",
      });
      await expect(flushWaitUntilForTest()).rejects.toThrow(
        "Run execution preparation failed",
      );

      const [firstRunId] = await setup.readThreadPromptRunIds(
        firstSent.threadId,
      );
      expect(firstRunId).toBeDefined();
      if (!firstRunId) {
        throw new Error("Expected admitted Run ID in thread events");
      }

      const [failedRun, queueAfterFailure] = await Promise.all([
        setup.readRun(firstRunId),
        setup.readQueue(),
      ]);
      expect(failedRun.status).toBe("failed");
      expect(failedRun.failureReason).toBe("unknown");
      expect(queueAfterFailure.concurrency.active).toBe(0);

      context.mocks.s3.getSignedUrl.mockImplementation(
        (_client: unknown, command: unknown) => {
          return Promise.resolve(apiTestS3PresignedUrl(command));
        },
      );

      const beforeRecovery = setup.registry.acceptedCount();
      await setup.sendPrompt({
        threadId: firstSent.threadId,
        prompt: "Follow-up prompt after URL signing recovers",
      });
      await flushWaitUntilForTest();

      const recovered = setup.registry.latestAccepted(beforeRecovery);
      const recoveredRunId = recovered.envelope.executionContext.runId;
      setup.tracker.track(
        setup.actor,
        recoveredRunId,
        recovered.envelope.executionContext.sandboxToken,
      );

      const recoveredRun = await setup.readRun(recoveredRunId);
      expect(recoveredRun.status).toBe("running");
    },
  );

  it(
    "runners-direct-dispatch-021 launches the following queued input after a definite refusal releases its Thread",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const firstDispatchArrived = createDeferredPromise<string>(
        context.signal,
      );
      const secondQueued = createDeferredPromise<void>(context.signal);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          secondQueued.resolve();
        }
      };
      onTestFinished(release);

      const setup = await setupDispatchWorkspace();
      let attempts = 0;
      await setup.registry.registerRunner({
        heartbeatGeneration: 5,
        reply: async (dispatch) => {
          attempts += 1;
          if (attempts === 1) {
            firstDispatchArrived.resolve(
              dispatch.envelope.executionContext.runId,
            );
            await secondQueued.promise;
            return rejectedResponse(dispatch);
          }
          return acceptedResponse(dispatch);
        },
      });

      const firstSent = await setup.sendPrompt({
        prompt: "First prompt that will be definitely refused",
      });
      const firstRunId = await firstDispatchArrived.promise;

      await setup.sendPrompt({
        threadId: firstSent.threadId,
        prompt: "Queued follow-up prompt in same thread",
      });
      release();
      await flushWaitUntilForTest();

      const followUpDispatch = setup.registry.latestAccepted(0);
      const followUpRunId = followUpDispatch.envelope.executionContext.runId;
      setup.tracker.track(
        setup.actor,
        followUpRunId,
        followUpDispatch.envelope.executionContext.sandboxToken,
      );

      const [firstRun, followUpRun, queue, threadRunIds] = await Promise.all([
        setup.readRun(firstRunId),
        setup.readRun(followUpRunId),
        setup.readQueue(),
        setup.readThreadPromptRunIds(firstSent.threadId),
      ]);

      expect(firstRun.status).toBe("failed");
      expect(followUpRunId).not.toBe(firstRunId);
      expect(threadRunIds).toStrictEqual([firstRunId, followUpRunId]);
      expect(followUpRun.status).toBe("running");
      expect(queue.concurrency.active).toBe(1);
    },
  );

  it(
    "runners-direct-dispatch-001 delivers complete input after binding its process",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();
      let duringDispatchRunner:
        Awaited<ReturnType<typeof setup.readRunRunner>> | undefined;

      const runner = await setup.registry.registerRunner({
        heartbeatGeneration: 3,
        reply: async (dispatch) => {
          duringDispatchRunner = await setup.readRunRunner(
            dispatch.envelope.executionContext.runId,
          );
          return acceptedResponse(dispatch);
        },
      });

      const promptText = "Deliver complete execution input after binding";
      await setup.sendPrompt({ prompt: promptText });
      await flushWaitUntilForTest();

      const dispatch = setup.registry.latestAccepted(0);
      const execution = dispatch.envelope.executionContext;
      setup.tracker.track(setup.actor, execution.runId, execution.sandboxToken);

      expect(duringDispatchRunner).toMatchObject({
        runnerId: runner.runnerId,
        runnerHeartbeatGeneration: runner.heartbeatGeneration,
      });
      expect(execution.prompt).toContain(promptText);
      expect(execution.sandboxToken).toMatch(/^vm0_sandbox_/u);
      expect(execution.platformEnvironment.OKOU_TOKEN).toMatch(
        /^vm0_sandbox_/u,
      );
      expect(execution.startupInputs.contentBundles.format).toBe("tar-gzip-v1");

      const [runAfter, runnerAfter] = await Promise.all([
        setup.readRun(execution.runId),
        setup.readRunRunner(execution.runId),
      ]);
      expect(runAfter.status).toBe("running");
      expect(runnerAfter.runnerId).toBe(runner.runnerId);
      expect(runnerAfter.runnerHeartbeatGeneration).toBe(
        runner.heartbeatGeneration,
      );
    },
  );

  it(
    "runners-direct-dispatch-005 sends a complete 256-4096 KiB dispatch with content encoding gzip",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();
      const runner = await setup.registry.registerRunner({
        heartbeatGeneration: 2,
      });

      const largePrompt = "Café review.".repeat(22_000);
      await setup.sendPrompt({ prompt: largePrompt });
      await flushWaitUntilForTest();

      expect(runner.dispatches).toHaveLength(1);
      const [dispatch] = runner.dispatches;
      if (!dispatch) {
        throw new Error("Expected gzip direct dispatch");
      }
      const execution = dispatch.envelope.executionContext;
      setup.tracker.track(setup.actor, execution.runId, execution.sandboxToken);

      const decodedBytes = Buffer.byteLength(dispatch.bytes, "utf8");
      expect(dispatch.encoding).toBe("gzip");
      expect(decodedBytes).toBeGreaterThanOrEqual(256 * 1024);
      expect(decodedBytes).toBeLessThan(4096 * 1024);
      expect(execution.prompt).toContain(largePrompt);

      const run = await setup.readRun(execution.runId);
      expect(run.status).toBe("running");
    },
  );

  it(
    "runners-direct-dispatch-006 fails a Run with no serving process and releases its concurrency slot",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();

      const sent = await setup.sendPrompt({
        prompt: "Dispatch with no serving Runner process",
      });
      await flushWaitUntilForTest();

      const [runId] = await setup.readThreadPromptRunIds(sent.threadId);
      expect(runId).toBeDefined();
      if (!runId) {
        throw new Error("Expected admitted Run ID in thread events");
      }

      signIn(setup.actor);
      const [run, contextResponse, queue] = await Promise.all([
        setup.readRun(runId),
        accept(
          runContextApi.getContext({
            headers: SESSION_HEADERS,
            params: { id: runId },
          }),
          [404],
        ),
        setup.readQueue(),
      ]);

      expect(run.status).toBe("failed");
      expect(run.failureReason).toBe("unknown");
      expect(contextResponse.status).toBe(404);
      expect(queue.concurrency.active).toBe(0);
    },
  );

  it(
    "runners-direct-dispatch-008 keeps PAT-advertised serving capacity outside the official fleet",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();
      const official = await setup.registry.registerRunner({
        heartbeatGeneration: 6,
        maxConcurrent: 1,
      });

      const device = await accept(cliAuthDeviceApi.create({ body: {} }), [200]);
      signIn(setup.actor);
      await accept(
        cliAuthApproveApi.approve({
          headers: SESSION_HEADERS,
          body: { device_code: device.body.device_code },
        }),
        [200],
      );
      const patToken = await accept(
        cliAuthTokenApi.exchange({
          body: { device_code: device.body.device_code },
        }),
        [200],
      );

      const patRunner = await setup.registry.registerRunner({
        heartbeatGeneration: 9,
        maxConcurrent: 100,
        totalVcpu: 64,
        totalMemoryMb: 131_072,
        ingressServiceActive: true,
        authHeader: `Bearer ${patToken.body.access_token}`,
      });

      await setup.sendPrompt({
        prompt: "Route exclusively to official fleet",
      });
      await flushWaitUntilForTest();

      const dispatch = setup.registry.latestAccepted(0);
      const execution = dispatch.envelope.executionContext;
      setup.tracker.track(setup.actor, execution.runId, execution.sandboxToken);

      expect(patRunner.dispatches).toHaveLength(0);
      const [run, assigned] = await Promise.all([
        setup.readRun(execution.runId),
        setup.readRunRunner(execution.runId),
      ]);
      expect(run.status).toBe("running");
      expect(assigned.runnerId).toBe(official.runnerId);
      expect(assigned.runnerHeartbeatGeneration).toBe(
        official.heartbeatGeneration,
      );
    },
  );

  it(
    "runners-direct-dispatch-015 switches candidates only after a definite refusal",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();
      const visitedRunners: string[] = [];

      const handleCandidate = (dispatch: CapturedDispatch): Response => {
        visitedRunners.push(dispatch.runnerId);
        return visitedRunners.length === 1
          ? rejectedResponse(dispatch)
          : acceptedResponse(dispatch);
      };

      const [runnerA, runnerB] = await Promise.all([
        setup.registry.registerRunner({
          heartbeatGeneration: 2,
          reply: handleCandidate,
        }),
        setup.registry.registerRunner({
          heartbeatGeneration: 3,
          reply: handleCandidate,
        }),
      ]);

      await setup.sendPrompt({
        prompt: "Fail over to second candidate after definite refusal",
      });
      await flushWaitUntilForTest();

      const dispatch = setup.registry.latestAccepted(0);
      const execution = dispatch.envelope.executionContext;
      setup.tracker.track(setup.actor, execution.runId, execution.sandboxToken);

      expect(visitedRunners).toHaveLength(2);
      expect(new Set(visitedRunners).size).toBe(2);
      const secondVisited = visitedRunners[1];
      const expectedGeneration =
        secondVisited === runnerA.runnerId
          ? runnerA.heartbeatGeneration
          : runnerB.heartbeatGeneration;

      const [run, assigned] = await Promise.all([
        setup.readRun(execution.runId),
        setup.readRunRunner(execution.runId),
      ]);
      expect(run.status).toBe("running");
      expect(assigned.runnerId).toBe(secondVisited);
      expect(assigned.runnerHeartbeatGeneration).toBe(expectedGeneration);
    },
  );

  it(
    "runners-direct-dispatch-018 dispatches to advertised reclaimable capacity",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();
      const runner = await setup.registry.registerRunner({
        heartbeatGeneration: 4,
        maxConcurrent: 2,
        runningCount: 2,
        totalVcpu: 8,
        allocatedVcpu: 8,
        totalMemoryMb: 16_384,
        allocatedMemoryMb: 16_384,
      });

      await setup.sendPrompt({
        prompt: "Dispatch into reclaimable runner capacity",
      });
      await flushWaitUntilForTest();

      const dispatch = setup.registry.latestAccepted(0);
      const execution = dispatch.envelope.executionContext;
      setup.tracker.track(setup.actor, execution.runId, execution.sandboxToken);

      const [run, assigned] = await Promise.all([
        setup.readRun(execution.runId),
        setup.readRunRunner(execution.runId),
      ]);
      expect(run.status).toBe("running");
      expect(assigned.runnerId).toBe(runner.runnerId);
      expect(assigned.runnerHeartbeatGeneration).toBe(
        runner.heartbeatGeneration,
      );
    },
  );

  it(
    "runners-direct-dispatch-020 selects a fresh serving process after stale, unavailable and untrusted-host observations",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();
      const currentTime = now();

      // Register a stale runner (>180s old, <300s deletion threshold).
      mockNow(currentTime - 185_000);
      await setup.registry.registerRunner({
        heartbeatGeneration: 1,
        mountHandler: false,
      });
      clearMockNow();

      const [currentRunner] = await Promise.all([
        setup.registry.registerRunner({
          heartbeatGeneration: 2,
          snapshotSequence: 2,
          mode: "running",
          ingressServiceActive: true,
        }),
        setup.registry.registerRunner({
          hostname: "runner-untrusted.internal",
          mountHandler: false,
        }),
        setup.registry.registerRunner({
          ingressServiceActive: false,
          mountHandler: false,
        }),
        setup.registry.registerRunner({
          mode: "draining",
          mountHandler: false,
        }),
        setup.registry.registerRunner({
          admittableProfiles: [],
          mountHandler: false,
        }),
        setup.registry.registerRunner({
          group: `vm0/other-${randomUUID().slice(0, 8)}`,
          mountHandler: false,
        }),
      ]);

      // Replayed older sequence and older generation in starting mode must not overwrite current state.
      await Promise.all([
        accept(
          runnersHeartbeatApi.heartbeat({
            headers: officialRunnerHeaders(),
            body: heartbeatPayload({
              runnerId: currentRunner.runnerId,
              runnerHostname: currentRunner.hostname,
              group: setup.group,
              snapshotGeneration: 2,
              snapshotSequence: 1,
              mode: "starting",
            }),
          }),
          [200],
        ),
        accept(
          runnersHeartbeatApi.heartbeat({
            headers: officialRunnerHeaders(),
            body: heartbeatPayload({
              runnerId: currentRunner.runnerId,
              runnerHostname: currentRunner.hostname,
              group: setup.group,
              snapshotGeneration: 1,
              snapshotSequence: 9,
              mode: "starting",
            }),
          }),
          [200],
        ),
      ]);

      await setup.sendPrompt({
        prompt: "Select the fresh serving Runner process",
      });
      await flushWaitUntilForTest();

      const dispatch = setup.registry.latestAccepted(0);
      const execution = dispatch.envelope.executionContext;
      setup.tracker.track(setup.actor, execution.runId, execution.sandboxToken);

      const [run, assigned] = await Promise.all([
        setup.readRun(execution.runId),
        setup.readRunRunner(execution.runId),
      ]);
      expect(run.status).toBe("running");
      expect(assigned.runnerId).toBe(currentRunner.runnerId);
      expect(assigned.runnerHeartbeatGeneration).toBe(2);
    },
  );

  it(
    "runners-direct-dispatch-023 definite refusal releases a preselected Run even though startedAt is set",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupDispatchWorkspace();
      await setup.registry.registerRunner({
        heartbeatGeneration: 7,
        reply: (dispatch) => {
          return rejectedResponse(dispatch);
        },
      });

      const sent = await setup.sendPrompt({
        prompt: "Refuse every direct dispatch attempt",
      });
      await flushWaitUntilForTest();

      const [runId] = await setup.readThreadPromptRunIds(sent.threadId);
      expect(runId).toBeDefined();
      if (!runId) {
        throw new Error("Expected admitted Run ID in thread events");
      }

      const [run, queue] = await Promise.all([
        setup.readRun(runId),
        setup.readQueue(),
      ]);
      expect(run.status).toBe("failed");
      expect(run.failureReason).toBe("unknown");
      expect(queue.concurrency.active).toBe(0);
    },
  );
});
