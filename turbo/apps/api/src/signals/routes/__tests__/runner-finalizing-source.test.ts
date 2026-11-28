import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runRunnerContract,
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersHeartbeatContract,
  type ActiveReuseProducer,
  type HeldHomeState,
  type HeldSandboxState,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { infer as zInfer } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  makeCodexAuthJson,
  mockClaudeCodeTokenEndpoint,
} from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

type DispatchEnvelope = zInfer<typeof runnerDispatchEnvelopeSchema>;
type RunnerHeartbeatBody = zInfer<
  (typeof runnersHeartbeatContract.heartbeat)["body"]
>;

interface CapturedDispatch {
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
const CODEX_MODEL = "gpt-6-astra";
const DEFAULT_PROFILE = "vm0/default";
const RECOVERY_PROMPT_SNIPPET =
  "okou chat messages --output-dir /tmp/okou-chat-history";

const LARGE_RUNNER_CAPACITY = Object.freeze({
  totalVcpu: 32,
  totalMemoryMb: 65_536,
  maxConcurrent: 8,
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
const personalModelProvidersApi = setupApp({
  context,
  routes: meModelProvidersUpsertRoutes,
})(personalModelProvidersMainContract);
const chatThreadsApi = setupApp({
  context,
  routes: chatThreadCreateRoutes,
})(chatThreadsContract);
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
const runRunnerApi = setupApp({
  context,
  routes: runsRoutes,
})(runRunnerContract);
const runsCancelApi = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);
const webhooksAgentEventsApi = setupApp({
  context,
  routes: webhooksAgentEventsRoutes,
})(webhookEventsContract);
const webhooksAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);

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
      lastName: "Runner",
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
  readonly totalVcpu?: number;
  readonly totalMemoryMb?: number;
  readonly maxConcurrent?: number;
  readonly admittableProfiles?: readonly string[];
  readonly heldSandboxStates?: readonly HeldSandboxState[];
  readonly heldHomeStates?: readonly HeldHomeState[];
  readonly activeReuseProducers?: readonly ActiveReuseProducer[];
  readonly mode?: RunnerHeartbeatBody["mode"];
  readonly ingressServiceActive?: boolean;
}): RunnerHeartbeatBody {
  return {
    runnerId: args.runnerId,
    runnerHostname: args.runnerHostname,
    group: args.group,
    snapshotGeneration: args.snapshotGeneration ?? 1,
    snapshotSequence: args.snapshotSequence ?? 1,
    totalVcpu: args.totalVcpu ?? 8,
    totalMemoryMb: args.totalMemoryMb ?? 16_384,
    maxConcurrent: args.maxConcurrent ?? 2,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
    runningCount: 0,
    admittableProfiles: [...(args.admittableProfiles ?? [DEFAULT_PROFILE])],
    heldSandboxStates: [...(args.heldSandboxStates ?? [])],
    heldHomeStates: [...(args.heldHomeStates ?? [])],
    activeReuseProducers: [...(args.activeReuseProducers ?? [])],
    mode: args.mode ?? "running",
    ingressServiceActive: args.ingressServiceActive ?? true,
  };
}

function createRunTracker() {
  const tracked: TrackedRun[] = [];

  onTestFinished(async () => {
    clearMockNow();
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
                  exitCode: 1,
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
      throw new AggregateError(errors, "Finalizing source test cleanup failed");
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

function createRunnerRegistry(group: string) {
  const acceptedByRunId = new Map<string, CapturedDispatch>();
  const acceptedRunOrder: string[] = [];

  async function registerRunner(
    options: {
      readonly runnerId?: string;
      readonly heartbeatGeneration?: number;
      readonly hostname?: string;
      readonly totalVcpu?: number;
      readonly totalMemoryMb?: number;
      readonly maxConcurrent?: number;
      readonly heldSandboxStates?: readonly HeldSandboxState[];
      readonly heldHomeStates?: readonly HeldHomeState[];
      readonly activeReuseProducers?: readonly ActiveReuseProducer[];
      readonly mode?: RunnerHeartbeatBody["mode"];
      readonly ingressServiceActive?: boolean;
      readonly reply?: (args: {
        readonly envelope: DispatchEnvelope;
        readonly bytes: string;
        readonly rawBytes: Buffer;
        readonly encoding: string | null;
        readonly runnerId: string;
        readonly heartbeatGeneration: number;
      }) => Response | Promise<Response>;
    } = {},
  ): Promise<RegisteredRunner> {
    const runnerId = options.runnerId ?? randomUUID();
    const heartbeatGeneration = options.heartbeatGeneration ?? 1;
    const hostname = options.hostname ?? `runner-${runnerId}.okou.app`;
    const dispatches: CapturedDispatch[] = [];
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
            throw new Error("Unexpected direct Runner identity");
          }
          const captured: CapturedDispatch = {
            envelope,
            bytes,
            rawBytes,
            encoding,
          };
          dispatches.push(captured);
          if (options.reply) {
            const response = await options.reply({
              ...captured,
              runnerId,
              heartbeatGeneration,
            });
            if (response.status === 200) {
              acceptedByRunId.set(envelope.executionContext.runId, captured);
              acceptedRunOrder.push(envelope.executionContext.runId);
            }
            return response;
          }
          acceptedByRunId.set(envelope.executionContext.runId, captured);
          acceptedRunOrder.push(envelope.executionContext.runId);
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
          snapshotSequence: 1,
          totalVcpu: options.totalVcpu,
          totalMemoryMb: options.totalMemoryMb,
          maxConcurrent: options.maxConcurrent,
          heldSandboxStates: options.heldSandboxStates,
          heldHomeStates: options.heldHomeStates,
          activeReuseProducers: options.activeReuseProducers,
          mode: options.mode,
          ingressServiceActive: options.ingressServiceActive,
        }),
      }),
      [200],
    );

    return { runnerId, heartbeatGeneration, hostname, dispatches };
  }

  async function sendHeartbeat(
    runner: Pick<
      RegisteredRunner,
      "runnerId" | "heartbeatGeneration" | "hostname"
    >,
    args: {
      readonly snapshotSequence?: number;
      readonly totalVcpu?: number;
      readonly totalMemoryMb?: number;
      readonly maxConcurrent?: number;
      readonly heldSandboxStates?: readonly HeldSandboxState[];
      readonly heldHomeStates?: readonly HeldHomeState[];
      readonly activeReuseProducers?: readonly ActiveReuseProducer[];
      readonly mode?: RunnerHeartbeatBody["mode"];
      readonly ingressServiceActive?: boolean;
    } = {},
  ): Promise<void> {
    await accept(
      runnersHeartbeatApi.heartbeat({
        headers: officialRunnerHeaders(),
        body: heartbeatPayload({
          runnerId: runner.runnerId,
          runnerHostname: runner.hostname,
          group,
          snapshotGeneration: runner.heartbeatGeneration,
          snapshotSequence: args.snapshotSequence ?? 2,
          totalVcpu: args.totalVcpu,
          totalMemoryMb: args.totalMemoryMb,
          maxConcurrent: args.maxConcurrent,
          heldSandboxStates: args.heldSandboxStates,
          heldHomeStates: args.heldHomeStates,
          activeReuseProducers: args.activeReuseProducers,
          mode: args.mode,
          ingressServiceActive: args.ingressServiceActive,
        }),
      }),
      [200],
    );
  }

  function latestAcceptedDispatch(afterCount: number): CapturedDispatch {
    const runId = acceptedRunOrder[afterCount];
    if (!runId) {
      throw new Error("Expected a direct Runner dispatch to be accepted");
    }
    const dispatch = acceptedByRunId.get(runId);
    if (!dispatch) {
      throw new Error(`Missing captured dispatch for run ${runId}`);
    }
    return dispatch;
  }

  return {
    registerRunner,
    sendHeartbeat,
    acceptedCount: () => {
      return acceptedRunOrder.length;
    },
    latestAcceptedDispatch,
  };
}

async function setupTerminalPredecessor(
  status: "completed" | "cancelled" | "failed",
  initialize: boolean,
) {
  const clock = now();
  mockNow(clock);
  const completedAtIso = nowDate().toISOString();
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

  const [runnerA] = await Promise.all([
    registry.registerRunner({
      heartbeatGeneration: 7,
    }),
    (async () => {
      context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({
        type: "organization.created",
        data: { id: orgId, created_by: actor.userId, created_at: clock },
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

  async function launchChatRun(args: {
    readonly prompt: string;
    readonly threadId?: string;
    readonly model?: string | null;
  }) {
    const beforeCount = registry.acceptedCount();
    signIn(actor);
    const sent = await accept(
      chatEventsApi.send({
        headers: SESSION_HEADERS,
        body: {
          prompt: args.prompt,
          hasTextContent: true,
          clientEventId: randomUUID(),
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
    const dispatch = registry.latestAcceptedDispatch(beforeCount);
    const runId = dispatch.envelope.executionContext.runId;
    const trackedEntry = tracker.track(
      actor,
      runId,
      dispatch.envelope.executionContext.sandboxToken,
    );
    return {
      runId,
      threadId: sent.body.threadId,
      dispatch,
      execution: dispatch.envelope.executionContext,
      trackedEntry,
    };
  }

  const predecessor = await launchChatRun({
    prompt: "Preserve terminal home state",
    model: CLAUDE_MODEL,
  });

  const sandboxHeaders = {
    authorization: `Bearer ${predecessor.execution.sandboxToken}`,
  };
  if (initialize) {
    await accept(
      webhooksAgentEventsApi.send({
        headers: sandboxHeaders,
        body: {
          runId: predecessor.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: predecessor.threadId,
              sequenceNumber: 0,
            },
            {
              type: "assistant",
              sequenceNumber: 1,
              message: { content: [{ type: "text", text: "Partial work" }] },
            },
          ],
        },
      }),
      [200],
    );
  }
  if (status === "cancelled") {
    signIn(actor);
    await accept(
      runsCancelApi.cancel({
        headers: SESSION_HEADERS,
        params: { id: predecessor.runId },
      }),
      [200],
    );
  }
  await accept(
    webhooksAgentCompleteApi.complete({
      headers: sandboxHeaders,
      body: {
        runId: predecessor.runId,
        exitCode: status === "cancelled" ? 137 : status === "failed" ? 1 : 0,
        ...(initialize
          ? {
              lastEventSequence: 1,
              completion: {
                cliAgentType: "claude-code" as const,
                cliAgentSessionId: predecessor.threadId,
                cliAgentSessionHistoryDisposition: "native_only" as const,
              },
            }
          : {}),
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  predecessor.trackedEntry.done = true;

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

  async function readRunStatus(runId: string) {
    signIn(actor);
    const response = await accept(
      runsByIdApi.getById({
        headers: SESSION_HEADERS,
        params: { id: runId },
      }),
      [200],
    );
    return response.body.status;
  }

  return {
    actor,
    clock,
    completedAtIso,
    group,
    runnerA,
    registry,
    predecessor,
    reuseKey: `thread:${predecessor.threadId}`,
    launchChatRun,
    readRunRunner,
    readRunStatus,
  };
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

describe("Independent finalizing resource dispatch", () => {
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
          chatThreadsApi.create({
            headers: {},
            body: { model: null },
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
          runRunnerApi.getRunner({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          runsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
          [401],
        ),
        accept(
          webhooksAgentEventsApi.send({
            headers: {},
            body: {
              runId: warmupId,
              events: [{ type: "result", sequenceNumber: 1, result: "warmup" }],
            },
          }),
          [401],
        ),
        accept(
          webhooksAgentCompleteApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
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
    "runner-finalizing-source-001 routes previous-Run sandbox independently of native history",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("failed", false);
      mockNow(fixture.clock + 2500);

      const [, runnerB] = await Promise.all([
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          activeReuseProducers: [
            {
              runId: fixture.predecessor.runId,
              reuseKey: fixture.reuseKey,
              profile: DEFAULT_PROFILE,
            },
          ],
          heldSandboxStates: [
            {
              reuseKey: fixture.reuseKey,
              lastCompletedAt: fixture.completedAtIso,
              reusableSandbox: {
                profile: DEFAULT_PROFILE,
                sourceRunId: randomUUID(),
              },
            },
          ],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          heldSandboxStates: [
            {
              reuseKey: fixture.reuseKey,
              lastCompletedAt: fixture.completedAtIso,
              reusableSandbox: {
                profile: DEFAULT_PROFILE,
                sourceRunId: fixture.predecessor.runId,
              },
            },
          ],
        }),
      ]);

      const next = await fixture.launchChatRun({
        threadId: fixture.predecessor.threadId,
        prompt: "Continue after failed uninitialized run",
      });
      const runner = await fixture.readRunRunner(next.runId);

      expect(runner.runnerId).toBe(runnerB.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(
        runnerB.heartbeatGeneration,
      );
      expect(next.execution.nativeContinuation.sessionId).toBeNull();
      expect(next.execution.nativeContinuation.generationRunId).toBeNull();
      expect(next.execution.nativeContinuation.recoveryPrompt).toContain(
        RECOVERY_PROMPT_SNIPPET,
      );
    },
  );

  it(
    "runner-finalizing-source-004 keeps the completed Claude source after a native Codex framework switch",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("completed", true);
      mockNow(fixture.clock + 2500);

      await Promise.all([
        addPersonalCodexProvider(fixture.actor),
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          activeReuseProducers: [
            {
              runId: fixture.predecessor.runId,
              reuseKey: fixture.reuseKey,
              profile: DEFAULT_PROFILE,
            },
          ],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          ...LARGE_RUNNER_CAPACITY,
        }),
      ]);

      const next = await fixture.launchChatRun({
        threadId: fixture.predecessor.threadId,
        prompt: "Continue with Codex after completed Claude run",
        model: CODEX_MODEL,
      });
      const runner = await fixture.readRunRunner(next.runId);

      expect(runner.runnerId).toBe(fixture.runnerA.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(
        fixture.runnerA.heartbeatGeneration,
      );
      expect(next.execution.cliAgentType).toBe("codex");
    },
  );

  it(
    "runner-finalizing-source-005 keeps the cancelled Claude source after a native Codex framework switch",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("cancelled", true);
      mockNow(fixture.clock + 2500);

      await Promise.all([
        addPersonalCodexProvider(fixture.actor),
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          activeReuseProducers: [
            {
              runId: fixture.predecessor.runId,
              reuseKey: fixture.reuseKey,
              profile: DEFAULT_PROFILE,
            },
          ],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          ...LARGE_RUNNER_CAPACITY,
        }),
      ]);

      const next = await fixture.launchChatRun({
        threadId: fixture.predecessor.threadId,
        prompt: "Continue with Codex after cancelled Claude run",
        model: CODEX_MODEL,
      });
      const runner = await fixture.readRunRunner(next.runId);

      expect(runner.runnerId).toBe(fixture.runnerA.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(
        fixture.runnerA.heartbeatGeneration,
      );
      expect(next.execution.cliAgentType).toBe("codex");
    },
  );

  it(
    "runner-finalizing-source-006 keeps the failed Claude source after a native Codex framework switch",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("failed", true);
      mockNow(fixture.clock + 2500);

      await Promise.all([
        addPersonalCodexProvider(fixture.actor),
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          activeReuseProducers: [
            {
              runId: fixture.predecessor.runId,
              reuseKey: fixture.reuseKey,
              profile: DEFAULT_PROFILE,
            },
          ],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          ...LARGE_RUNNER_CAPACITY,
        }),
      ]);

      const next = await fixture.launchChatRun({
        threadId: fixture.predecessor.threadId,
        prompt: "Continue with Codex after failed Claude run",
        model: CODEX_MODEL,
      });
      const runner = await fixture.readRunRunner(next.runId);

      expect(runner.runnerId).toBe(fixture.runnerA.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(
        fixture.runnerA.heartbeatGeneration,
      );
      expect(next.execution.cliAgentType).toBe("codex");
    },
  );

  it(
    "runner-finalizing-source-007 dispatches to a failed producer that never reported native initialization",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("failed", false);
      mockNow(fixture.clock + 2500);

      await Promise.all([
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          activeReuseProducers: [
            {
              runId: fixture.predecessor.runId,
              reuseKey: fixture.reuseKey,
              profile: DEFAULT_PROFILE,
            },
          ],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          ...LARGE_RUNNER_CAPACITY,
        }),
      ]);

      const next = await fixture.launchChatRun({
        threadId: fixture.predecessor.threadId,
        prompt: "Continue on active failed producer without native init",
      });
      const runner = await fixture.readRunRunner(next.runId);

      expect(runner.runnerId).toBe(fixture.runnerA.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(7);
      expect(next.execution.nativeContinuation.sessionId).toBeNull();
      expect(next.execution.nativeContinuation.generationRunId).toBeNull();
    },
  );

  it(
    "runner-finalizing-source-008 prefers a dispatchable Home holder when the exact sandbox holder cannot accept",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("completed", true);
      mockNow(fixture.clock + 2500);

      const [runnerC] = await Promise.all([
        fixture.registry.registerRunner({
          heartbeatGeneration: 3,
          maxConcurrent: 1,
          heldHomeStates: [
            {
              reuseKey: fixture.reuseKey,
              lastCompletedAt: fixture.completedAtIso,
              homeCaches: [
                {
                  profile: DEFAULT_PROFILE,
                  homeAffinityVersion: 1,
                  sourceRunId: fixture.predecessor.runId,
                },
              ],
            },
          ],
        }),
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          ingressServiceActive: false,
          heldSandboxStates: [
            {
              reuseKey: fixture.reuseKey,
              lastCompletedAt: fixture.completedAtIso,
              reusableSandbox: {
                profile: DEFAULT_PROFILE,
                sourceRunId: fixture.predecessor.runId,
              },
            },
          ],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          ...LARGE_RUNNER_CAPACITY,
        }),
      ]);

      const next = await fixture.launchChatRun({
        threadId: fixture.predecessor.threadId,
        prompt: "Continue on dispatchable Home holder",
      });
      const [status, runner] = await Promise.all([
        fixture.readRunStatus(next.runId),
        fixture.readRunRunner(next.runId),
      ]);

      expect(status).toBe("running");
      expect(runner.runnerId).toBe(runnerC.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(
        runnerC.heartbeatGeneration,
      );
    },
  );

  it(
    "runner-finalizing-source-009 routes to a same-host replacement while its predecessor drains",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("completed", true);

      const [, replacement] = await Promise.all([
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          mode: "draining",
          activeReuseProducers: [
            {
              runId: fixture.predecessor.runId,
              reuseKey: fixture.reuseKey,
              profile: DEFAULT_PROFILE,
            },
          ],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 8,
          hostname: fixture.runnerA.hostname,
          maxConcurrent: 1,
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          ...LARGE_RUNNER_CAPACITY,
        }),
      ]);

      mockNow(fixture.clock + 2000);

      const next = await fixture.launchChatRun({
        threadId: fixture.predecessor.threadId,
        prompt: "Continue on same-host replacement during drain",
      });
      const [status, runner] = await Promise.all([
        fixture.readRunStatus(next.runId),
        fixture.readRunRunner(next.runId),
      ]);

      expect(status).toBe("running");
      expect(runner.runnerId).toBe(replacement.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(
        replacement.heartbeatGeneration,
      );
    },
  );

  it(
    "runner-finalizing-source-012 bounds Home dispatch and same-byte retry with drain-expiry",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("completed", true);
      const drainAt = fixture.clock + 26 * 60_000;
      mockNow(drainAt);

      const [, replacement, alternative] = await Promise.all([
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          mode: "draining",
          activeReuseProducers: [],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 8,
          hostname: fixture.runnerA.hostname,
          maxConcurrent: 1,
          reply: ({ envelope, runnerId, heartbeatGeneration }) => {
            if (envelope.preferredHomeCheckout) {
              mockNow(envelope.preferredHomeCheckout.waitUntil + 1);
            }
            return HttpResponse.json(
              {
                runnerId,
                heartbeatGeneration,
                runId: envelope.executionContext.runId,
                disposition: "busy",
              },
              { status: 429 },
            );
          },
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          ...LARGE_RUNNER_CAPACITY,
        }),
      ]);

      const next = await fixture.launchChatRun({
        threadId: fixture.predecessor.threadId,
        prompt: "Continue after preferred Home drain-expiry busy retries",
      });
      const [status, runner] = await Promise.all([
        fixture.readRunStatus(next.runId),
        fixture.readRunRunner(next.runId),
      ]);

      expect(status).toBe("running");
      expect(runner.runnerId).toBe(alternative.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(
        alternative.heartbeatGeneration,
      );

      expect(replacement.dispatches).toHaveLength(2);
      const [firstPreferred, secondPreferred] = replacement.dispatches;
      expect(firstPreferred).toBeDefined();
      expect(secondPreferred).toBeDefined();
      if (!firstPreferred || !secondPreferred) {
        throw new Error("Expected two preferred dispatches to replacement");
      }
      expect(
        Buffer.compare(firstPreferred.rawBytes, secondPreferred.rawBytes),
      ).toBe(0);
      expect(firstPreferred.bytes).toBe(secondPreferred.bytes);
      expect(
        firstPreferred.envelope.preferredHomeCheckout?.predecessorRunId,
      ).toBe(fixture.predecessor.runId);
      expect(
        firstPreferred.envelope.preferredHomeCheckout?.waitUntil,
      ).toBeGreaterThan(drainAt);
      expect(
        firstPreferred.envelope.preferredHomeCheckout?.waitUntil,
      ).toBeLessThanOrEqual(drainAt + 1000);
      expect(
        firstPreferred.envelope.preferredHomeCheckout?.waitUntil,
      ).toBeLessThan(firstPreferred.envelope.notAfter);

      expect(alternative.dispatches).toHaveLength(1);
      const [fallbackDispatch] = alternative.dispatches;
      expect(fallbackDispatch).toBeDefined();
      if (!fallbackDispatch) {
        throw new Error("Expected one fallback dispatch to alternative");
      }
      expect(fallbackDispatch.envelope.preferredHomeCheckout).toBeUndefined();
      expect(fallbackDispatch.envelope.notAfter).toBe(
        firstPreferred.envelope.notAfter,
      );
    },
  );

  it(
    "runner-finalizing-source-016 keeps another Chat's producer out of a new Thread's placement",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = await setupTerminalPredecessor("failed", false);

      signIn(fixture.actor);
      const separateThread = await accept(
        chatThreadsApi.create({
          headers: SESSION_HEADERS,
          body: { model: CLAUDE_MODEL },
        }),
        [201],
      );

      const [, runnerB] = await Promise.all([
        fixture.registry.sendHeartbeat(fixture.runnerA, {
          snapshotSequence: 2,
          activeReuseProducers: [
            {
              runId: fixture.predecessor.runId,
              reuseKey: `thread:${separateThread.body.id}`,
              profile: DEFAULT_PROFILE,
            },
          ],
        }),
        fixture.registry.registerRunner({
          heartbeatGeneration: 2,
          ...LARGE_RUNNER_CAPACITY,
        }),
      ]);

      const firstInNewThread = await fixture.launchChatRun({
        threadId: separateThread.body.id,
        prompt: "Start the first run in a separate thread",
      });
      const runner = await fixture.readRunRunner(firstInNewThread.runId);

      expect(runner.runnerId).toBe(runnerB.runnerId);
      expect(runner.runnerHeartbeatGeneration).toBe(
        runnerB.heartbeatGeneration,
      );
      expect(firstInNewThread.execution.isFirstRun).toBeTruthy();
    },
  );
});
