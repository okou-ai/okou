import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnerSshContract } from "@okouai/api-contracts/contracts/runner-ssh";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { sshHostsContract } from "@okouai/api-contracts/contracts/ssh-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { featureSwitchesRoutes } from "../feature-switches";
import { logsRoutes } from "../logs";
import { remoteDevicesRoutes } from "../remote-devices";
import { runnerSshRoutes } from "../runner-ssh";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { sshAccessRoutes } from "../ssh-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { holdDownloadSigning } from "./helpers/hold-download-signing";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const POLICY_HEADER = Object.freeze({
  "X-Okou-Remote-Device-Policy": "1",
});
const OBSERVED_HOST_KEY = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${"A".repeat(42)}A`,
});

interface RealtimePublication {
  readonly channel: string;
  readonly topic: string;
  readonly payload: unknown;
}

interface TrackedRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  sandboxToken: string | undefined;
  done: boolean;
}

interface DispatchedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly cliAgentType: "claude-code" | "codex" | "pi" | "antigravity";
  readonly runnerIdentity: {
    readonly runnerId: string;
    readonly heartbeatGeneration: number;
  };
  readonly sandboxToken: string;
  readonly agentToken: string;
}

function asCliAgentType(
  value: string,
): "claude-code" | "codex" | "pi" | "antigravity" {
  if (
    value === "claude-code" ||
    value === "codex" ||
    value === "pi" ||
    value === "antigravity"
  ) {
    return value;
  }
  throw new Error(`Unexpected cliAgentType: ${value}`);
}

function requireOrgOwner(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  return {
    orgId: actor.orgId,
    userId: actor.userId,
    orgRole: actor.orgRole ?? ("org:admin" as const),
  };
}

function sessionHeadersFor(context: TestContext, actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return SESSION_HEADERS;
}

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function clearRealtimePublications(context: TestContext): void {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

function sortedRealtimePublications(
  context: TestContext,
): readonly RealtimePublication[] {
  const gets = context.mocks.ably.channelGet.mock;
  const publishes = context.mocks.ably.publish.mock;
  return publishes.calls
    .map((call, index) => {
      const publishedAt = publishes.invocationCallOrder[index] ?? 0;
      let channel = "";
      for (const [getIndex, order] of gets.invocationCallOrder.entries()) {
        if (order < publishedAt) {
          channel = String(gets.calls[getIndex]?.[0] ?? "");
        }
      }
      return {
        channel,
        topic: String(call[0] ?? ""),
        payload: call[1],
      };
    })
    .sort((left, right) => {
      const leftKey = `${left.channel}|${left.topic}|${JSON.stringify(left.payload)}`;
      const rightKey = `${right.channel}|${right.topic}|${JSON.stringify(right.payload)}`;
      return leftKey.localeCompare(rightKey);
    });
}

function sortPublications(
  items: readonly RealtimePublication[],
): readonly RealtimePublication[] {
  return [...items].sort((left, right) => {
    const leftKey = `${left.channel}|${left.topic}|${JSON.stringify(left.payload)}`;
    const rightKey = `${right.channel}|${right.topic}|${JSON.stringify(right.payload)}`;
    return leftKey.localeCompare(rightKey);
  });
}

describe("runner-ssh authority, invalidation and observations", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chats = createChatFilesBddApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const workflows = createWorkflowsBddApi(context);

  const sshConnectionsApi = setupApp({
    context,
    routes: sshConnectionsRoutes,
  })(sshConnectionsContract);
  const chatRemoteAccessApi = setupApp({
    context,
    routes: chatRemoteAccessRoutes,
  })(chatRemoteAccessContract);
  const runnerSshApi = setupApp({
    context,
    routes: runnerSshRoutes,
  })(runnerSshContract);
  const sshAccessApi = setupApp({
    context,
    routes: sshAccessRoutes,
  })(sshHostsContract);
  const remoteDevicesApi = setupApp({
    context,
    routes: remoteDevicesRoutes,
  })(remoteDevicesContract);
  const featureSwitchesApi = setupApp({
    context,
    routes: featureSwitchesRoutes,
  })(featureSwitchesContract);
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
  const webhookCompleteApi = setupApp({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const webhookEventsApi = setupApp({
    context,
    routes: webhooksAgentEventsRoutes,
  })(webhookEventsContract);
  const webhookClerkApi = setupApp({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);
  const webhookStripeApi = setupApp({
    context,
    routes: webhooksStripeRoutes,
  })(webhookStripeContract);
  const workflowsApi = setupApp({
    context,
    routes: workflowsRoutes,
  })(workflowsCollectionContract);
  const workflowAutomationsApi = setupApp({
    context,
    routes: workflowAutomationsRoutes,
  })(workflowAutomationsContract);
  const logsApi = setupApp({
    context,
    routes: logsRoutes,
  })(logsListContract);

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
        accept(
          webhookClerkApi.post({
            body: "{}",
            extraHeaders: {},
          }),
          [401],
        ),
        accept(
          webhookStripeApi.post({
            body: "{}",
            extraHeaders: {},
          }),
          [401],
        ),
        accept(sshConnectionsApi.list({ headers: {} }), [401]),
        accept(chatRemoteAccessApi.listHostDefaults({ headers: {} }), [401]),
        accept(
          runnerSshApi.resolve({
            headers: {},
            params: { runId: warmupId },
            body: {
              connectionId: warmupId,
              runnerIdentity: { runnerId: warmupId, heartbeatGeneration: 1 },
            },
          }),
          [401],
        ),
        accept(sshAccessApi.list({ headers: {} }), [401]),
        accept(remoteDevicesApi.list({ headers: {} }), [401]),
        accept(featureSwitchesApi.get({ headers: {} }), [401]),
        accept(
          chatEventsApi.send({
            headers: {},
            body: {
              prompt: "warmup",
              hasTextContent: true,
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
            body: {
              runnerId: warmupId,
              group: "vm0/warmup",
              snapshotGeneration: 1,
              snapshotSequence: 1,
              totalVcpu: 8,
              totalMemoryMb: 16_384,
              maxConcurrent: 2,
              allocatedVcpu: 0,
              allocatedMemoryMb: 0,
              runningCount: 0,
              admittableProfiles: ["vm0/default"],
              heldSandboxStates: [],
              heldHomeStates: [],
              activeReuseProducers: [],
              mode: "running",
            },
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
          webhookCompleteApi.complete({
            headers: {},
            body: { runId: warmupId, exitCode: 0 },
          }),
          [401],
        ),
        accept(
          webhookEventsApi.send({
            headers: {},
            body: {
              runId: warmupId,
              events: [{ type: "system", sequenceNumber: 0 }],
            },
          }),
          [401],
        ),
        accept(workflowsApi.list({ headers: {} }), [401]),
        accept(
          workflowAutomationsApi.get({ headers: {}, params: { id: warmupId } }),
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

  afterEach(() => {
    clearMockNow();
  });

  function createRunTracker() {
    const tracked: TrackedRun[] = [];

    onTestFinished(async () => {
      clearMockNow();
      useSecretKmsProbe();
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
          const current = await runs.readRun(entry.actor, entry.runId);
          if (["queued", "pending", "running"].includes(current.status)) {
            await runs.requestCancelRun(entry.actor, entry.runId, [200]);
          }
          if (
            entry.sandboxToken &&
            !["completed", "failed", "timeout"].includes(current.status)
          ) {
            pendingCompletions.push(
              webhooks.requestAgentComplete(
                {
                  runId: entry.runId,
                  exitCode: 1,
                  error: "Run cancelled by test cleanup",
                  failureReason: "execution_timeout",
                },
                { authorization: `Bearer ${entry.sandboxToken}` },
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
        throw new AggregateError(errors, "Runner SSH test cleanup failed");
      }
    });

    return {
      track(actor: ApiTestUser, runId: string, sandboxToken?: string) {
        const existing = tracked.find((entry) => {
          return entry.runId === runId;
        });
        if (existing) {
          if (sandboxToken) {
            existing.sandboxToken = sandboxToken;
          }
          return existing;
        }
        const entry: TrackedRun = {
          actor,
          runId,
          sandboxToken,
          done: false,
        };
        tracked.push(entry);
        return entry;
      },
      markDone(runId: string) {
        const entry = tracked.find((candidate) => {
          return candidate.runId === runId;
        });
        if (entry) {
          entry.done = true;
        }
      },
    };
  }

  function prepareRunMocks() {
    const kmsProbe = useSecretKmsProbe();
    bdd.acceptStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-runner-ssh-key");
    return kmsProbe;
  }

  async function launchChatRun(
    tracker: ReturnType<typeof createRunTracker>,
    actor: ApiTestUser,
    runnerGroup: string,
    prompt: string,
  ): Promise<DispatchedRun> {
    const sent = await chats.requestSendEvent(
      actor,
      {
        prompt,
        clientEventId: randomUUID(),
        model: null,
      },
      [201],
    );
    if (!("threadId" in sent.body)) {
      throw new Error("Expected chat send to return a threadId");
    }
    await flushWaitUntilForTest();
    const dispatch = runs.receivedDispatches(runnerGroup).at(-1);
    const agentToken =
      dispatch?.executionContext.platformEnvironment.OKOU_TOKEN;
    if (!dispatch || !agentToken) {
      throw new Error("Expected a dispatched active Run");
    }
    const runId = dispatch.executionContext.runId;
    const sandboxToken = dispatch.executionContext.sandboxToken;
    tracker.track(actor, runId, sandboxToken);
    return {
      runId,
      threadId: sent.body.threadId,
      cliAgentType: asCliAgentType(dispatch.executionContext.cliAgentType),
      runnerIdentity: {
        runnerId: dispatch.runnerId,
        heartbeatGeneration: dispatch.heartbeatGeneration,
      },
      sandboxToken,
      agentToken,
    };
  }

  async function launchChatRuns(
    tracker: ReturnType<typeof createRunTracker>,
    actor: ApiTestUser,
    runnerGroup: string,
    prompts: readonly [string, string],
  ): Promise<readonly [DispatchedRun, DispatchedRun]> {
    const [firstSent, secondSent] = await Promise.all(
      prompts.map((prompt) => {
        return chats.requestSendEvent(
          actor,
          { prompt, clientEventId: randomUUID(), model: null },
          [201],
        );
      }),
    );
    if (
      !firstSent ||
      !secondSent ||
      !("threadId" in firstSent.body) ||
      !("threadId" in secondSent.body)
    ) {
      throw new Error("Expected concurrent chat sends to return threadIds");
    }
    await flushWaitUntilForTest();
    const dispatches = runs.receivedDispatches(runnerGroup);
    const findFor = (prompt: string, threadId: string): DispatchedRun => {
      const dispatch = [...dispatches].reverse().find((candidate) => {
        return candidate.executionContext.prompt === prompt;
      });
      const agentToken =
        dispatch?.executionContext.platformEnvironment.OKOU_TOKEN;
      if (!dispatch || !agentToken) {
        throw new Error(`Expected a dispatched active Run for "${prompt}"`);
      }
      const runId = dispatch.executionContext.runId;
      const sandboxToken = dispatch.executionContext.sandboxToken;
      tracker.track(actor, runId, sandboxToken);
      return {
        runId,
        threadId,
        cliAgentType: asCliAgentType(dispatch.executionContext.cliAgentType),
        runnerIdentity: {
          runnerId: dispatch.runnerId,
          heartbeatGeneration: dispatch.heartbeatGeneration,
        },
        sandboxToken,
        agentToken,
      };
    };
    return [
      findFor(prompts[0], firstSent.body.threadId),
      findFor(prompts[1], secondSent.body.threadId),
    ];
  }

  async function completeRunOk(
    tracker: ReturnType<typeof createRunTracker>,
    run: Pick<
      DispatchedRun,
      "runId" | "threadId" | "cliAgentType" | "sandboxToken"
    >,
  ): Promise<void> {
    const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };
    await webhooks.requestAgentEvents(
      {
        runId: run.runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      sandboxHeaders,
      [200],
    );
    const completed = await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: run.cliAgentType,
          cliAgentSessionId:
            run.cliAgentType === "pi"
              ? run.threadId
              : `runner-ssh-${run.runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      sandboxHeaders,
      [200],
    );
    if (!("status" in completed.body)) {
      throw new Error("Expected completion response to include status");
    }
    expect(completed.body.status).toBe("completed");
    tracker.markDone(run.runId);
    await flushWaitUntilForTest();
  }

  async function createSshHost(
    actor: ApiTestUser,
    options: {
      readonly displayName: string;
      readonly host: string;
      readonly username?: string;
      readonly privateKey?: string;
      readonly enableDefault?: boolean;
    },
  ) {
    const headers = sessionHeadersFor(context, actor);
    const created = await accept(
      sshConnectionsApi.create({
        headers,
        body: {
          id: randomUUID(),
          displayName: options.displayName,
          host: options.host,
          credential: inlineSshKey(
            options.username ?? "deploy",
            options.privateKey ?? `key-${randomUUID()}`,
          ),
        },
      }),
      [201],
    );
    if (options.enableDefault !== false) {
      await accept(
        chatRemoteAccessApi.updateHostDefault({
          headers,
          params: { protocol: "ssh", connectionId: created.body.id },
          body: { enabled: true },
        }),
        [200],
      );
    }
    return created.body;
  }

  it(
    "runner-ssh-001 (1/2) notifies every active owner Run and skips completed Runs on edit, rotation, reset and delete",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      prepareRunMocks();
      const tracker = createRunTracker();
      const owner = bdd.user({ orgRole: "org:admin" });
      const ownerIdentity = requireOrgOwner(owner);

      const [runnerGroup, , host] = await Promise.all([
        runs.configureRunnerGroup({ maxConcurrent: 4 }),
        deliverOrganizationCreated(context, owner),
        createSshHost(owner, {
          displayName: "Primary Bastion",
          host: "bastion.example.com",
          username: "deploy",
        }),
      ]);

      const [completedRun, activeRun1] = await launchChatRuns(
        tracker,
        owner,
        runnerGroup,
        ["Run that finishes before SSH edits", "First active SSH Run"],
      );
      await completeRunOk(tracker, completedRun);

      const activeRun2 = await launchChatRun(
        tracker,
        owner,
        runnerGroup,
        "Second active SSH Run",
      );

      const expectedPublications = sortPublications([
        {
          channel: `user:${ownerIdentity.userId}`,
          topic: "ssh:changed",
          payload: { orgId: ownerIdentity.orgId },
        },
        {
          channel: `runner-group:${runnerGroup}`,
          topic: "ssh-authority-invalidated",
          payload: { runId: activeRun1.runId, connectionId: host.id },
        },
        {
          channel: `runner-group:${runnerGroup}`,
          topic: "ssh-authority-invalidated",
          payload: { runId: activeRun2.runId, connectionId: host.id },
        },
      ]);

      const ownerHeaders = sessionHeadersFor(context, owner);
      await flushWaitUntilForTest();

      clearRealtimePublications(context);
      const editedHost = await accept(
        sshConnectionsApi.update({
          headers: ownerHeaders,
          params: { connectionId: host.id },
          body: { expectedGeneration: 1, host: "bastion-v2.example.com" },
        }),
        [200],
      );
      expect(editedHost.body.generation).toBe(2);
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        expectedPublications,
      );

      clearRealtimePublications(context);
      const rotated = await accept(
        sshConnectionsApi.update({
          headers: ownerHeaders,
          params: { connectionId: host.id },
          body: {
            expectedGeneration: 2,
            credential: inlineSshKey("deploy-rotated", `key-${randomUUID()}`),
          },
        }),
        [200],
      );
      expect(rotated.body.generation).toBe(3);
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        expectedPublications,
      );

      clearRealtimePublications(context);
      const reset = await accept(
        sshConnectionsApi.resetHostKey({
          headers: ownerHeaders,
          params: { connectionId: host.id },
          body: { expectedGeneration: 3 },
        }),
        [200],
      );
      expect(reset.body.generation).toBe(4);
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        expectedPublications,
      );

      clearRealtimePublications(context);
      await accept(
        sshConnectionsApi.delete({
          headers: ownerHeaders,
          params: { connectionId: host.id },
          body: { expectedGeneration: 4 },
        }),
        [204],
      );
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        expectedPublications,
      );

      const finalList = await accept(
        sshConnectionsApi.list({ headers: ownerHeaders }),
        [200],
      );
      expect(finalList.body.connections).toStrictEqual([]);
    },
  );

  it(
    "runner-ssh-001 (2/2) isolates SSH invalidation publications from another owner sharing the Runner group",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      prepareRunMocks();
      const tracker = createRunTracker();
      const ownerA = bdd.user({ orgRole: "org:admin" });
      const ownerB = bdd.user({ orgRole: "org:admin" });
      const identityA = requireOrgOwner(ownerA);

      const [runnerGroup, , hostA] = await Promise.all([
        runs.configureRunnerGroup({ maxConcurrent: 4 }),
        deliverOrganizationCreated(context, ownerA),
        createSshHost(ownerA, {
          displayName: "Owner A Host",
          host: "owner-a.example.com",
        }),
      ]);
      const [, hostB] = await Promise.all([
        deliverOrganizationCreated(context, ownerB),
        createSshHost(ownerB, {
          displayName: "Owner B Host",
          host: "owner-b.example.com",
        }),
      ]);

      const runA = await launchChatRun(
        tracker,
        ownerA,
        runnerGroup,
        "Owner A active Run",
      );
      await launchChatRun(tracker, ownerB, runnerGroup, "Owner B active Run");

      const expectedPublications = sortPublications([
        {
          channel: `user:${identityA.userId}`,
          topic: "ssh:changed",
          payload: { orgId: identityA.orgId },
        },
        {
          channel: `runner-group:${runnerGroup}`,
          topic: "ssh-authority-invalidated",
          payload: { runId: runA.runId, connectionId: hostA.id },
        },
      ]);

      const headersA = sessionHeadersFor(context, ownerA);
      await flushWaitUntilForTest();

      clearRealtimePublications(context);
      await accept(
        sshConnectionsApi.update({
          headers: headersA,
          params: { connectionId: hostA.id },
          body: { expectedGeneration: 1, host: "owner-a-v2.example.com" },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        expectedPublications,
      );

      clearRealtimePublications(context);
      await accept(
        sshConnectionsApi.update({
          headers: headersA,
          params: { connectionId: hostA.id },
          body: {
            expectedGeneration: 2,
            credential: inlineSshKey("deploy-next", `key-${randomUUID()}`),
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        expectedPublications,
      );

      clearRealtimePublications(context);
      await accept(
        sshConnectionsApi.resetHostKey({
          headers: headersA,
          params: { connectionId: hostA.id },
          body: { expectedGeneration: 3 },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        expectedPublications,
      );

      clearRealtimePublications(context);
      await accept(
        sshConnectionsApi.delete({
          headers: headersA,
          params: { connectionId: hostA.id },
          body: { expectedGeneration: 4 },
        }),
        [204],
      );
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        expectedPublications,
      );

      const listA = await accept(
        sshConnectionsApi.list({ headers: headersA }),
        [200],
      );
      expect(listA.body.connections).toStrictEqual([]);

      const listB = await accept(
        sshConnectionsApi.list({ headers: sessionHeadersFor(context, ownerB) }),
        [200],
      );
      expect(listB.body.connections).toContainEqual(
        expect.objectContaining({ id: hostB.id, host: "owner-b.example.com" }),
      );
    },
  );

  it(
    "runner-ssh-017 (1/2) denies a pending Run and a completed Run without decrypting credentials",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kmsProbe = prepareRunMocks();
      const tracker = createRunTracker();
      const owner = bdd.user({ orgRole: "org:admin" });

      const runnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 3,
      };
      const [runnerGroup, , host] = await Promise.all([
        runs.configureRunnerGroup({ maxConcurrent: 4, runnerIdentity }),
        deliverOrganizationCreated(context, owner),
        createSshHost(owner, {
          displayName: "Lifecycle Host",
          host: "lifecycle.example.com",
        }),
        bdd.updatePersonalInstructions(
          owner,
          `Pending SSH hold ${randomUUID()}`,
        ),
      ]);
      const runnerHeaders = officialRunnerHeaders();

      const pendingHold = holdDownloadSigning(context);
      const pendingClientEventId = randomUUID();
      const pendingSent = await chats.requestSendEvent(
        owner,
        {
          prompt: "Pending SSH Run",
          clientEventId: pendingClientEventId,
          model: null,
        },
        [201],
      );
      if (!("threadId" in pendingSent.body)) {
        throw new Error("Expected pending chat send to return a threadId");
      }
      await pendingHold.waitForPending();
      const pendingEvents = await chats.listThreadEvents(
        owner,
        pendingSent.body.threadId,
      );
      const pendingRunId = pendingEvents.events.find((event) => {
        return event.revokesEventId === pendingClientEventId;
      })?.runId;
      if (!pendingRunId) {
        throw new Error("Expected a committed pending Run id");
      }
      const pendingRunState = await runs.readRun(owner, pendingRunId);
      expect(pendingRunState.status).toBe("pending");

      const [pendingResolve, pendingPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: pendingRunId },
            body: {
              connectionId: host.id,
              runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId: pendingRunId },
            body: {
              connectionId: host.id,
              runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(pendingResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(pendingPin.body).toStrictEqual({ outcome: "unavailable" });

      pendingHold.release();
      await flushWaitUntilForTest();
      const pendingDispatch = runs.dispatchedRun(pendingRunId);
      tracker.track(
        owner,
        pendingRunId,
        pendingDispatch.executionContext.sandboxToken,
      );

      const completedRun = await launchChatRun(
        tracker,
        owner,
        runnerGroup,
        "Completed SSH Run",
      );
      await completeRunOk(tracker, completedRun);

      const [completedResolve, completedPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: completedRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: completedRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId: completedRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: completedRun.runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(completedResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(completedPin.body).toStrictEqual({ outcome: "unavailable" });
      expect(kmsProbe.decryptCalls).toBe(0);
    },
  );

  it(
    "runner-ssh-017 (2/2) denies a cancelled Run and a failed Run without decrypting credentials",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kmsProbe = prepareRunMocks();
      const tracker = createRunTracker();
      const owner = bdd.user({ orgRole: "org:admin" });

      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup({ maxConcurrent: 4 }),
        deliverOrganizationCreated(context, owner),
      ]);

      const host = await createSshHost(owner, {
        displayName: "Terminal Host",
        host: "terminal.example.com",
      });
      const runnerHeaders = officialRunnerHeaders();

      const cancelledRun = await launchChatRun(
        tracker,
        owner,
        runnerGroup,
        "Run to cancel",
      );
      await runs.requestCancelRun(owner, cancelledRun.runId, [200]);
      await flushWaitUntilForTest();
      const cancelledState = await runs.readRun(owner, cancelledRun.runId);
      expect(cancelledState.status).toBe("cancelled");

      const [cancelledResolve, cancelledPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: cancelledRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: cancelledRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId: cancelledRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: cancelledRun.runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(cancelledResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(cancelledPin.body).toStrictEqual({ outcome: "unavailable" });

      await webhooks.requestAgentComplete(
        {
          runId: cancelledRun.runId,
          exitCode: 1,
          error: "Run cancelled",
          failureReason: "execution_timeout",
        },
        { authorization: `Bearer ${cancelledRun.sandboxToken}` },
        [200],
      );
      tracker.markDone(cancelledRun.runId);
      await flushWaitUntilForTest();

      const failedRun = await launchChatRun(
        tracker,
        owner,
        runnerGroup,
        "Run that fails",
      );
      await webhooks.requestAgentComplete(
        {
          runId: failedRun.runId,
          exitCode: 1,
          error: "Execution timed out",
          failureReason: "execution_timeout",
        },
        { authorization: `Bearer ${failedRun.sandboxToken}` },
        [200],
      );
      tracker.markDone(failedRun.runId);
      await flushWaitUntilForTest();
      const failedState = await runs.readRun(owner, failedRun.runId);
      expect(failedState.status).toBe("failed");

      const [failedResolve, failedPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: failedRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: failedRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId: failedRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: failedRun.runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(failedResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(failedPin.body).toStrictEqual({ outcome: "unavailable" });
      expect(kmsProbe.decryptCalls).toBe(0);
    },
  );

  it(
    "runner-ssh-011 requires official Runner auth and current winning-runner, owner, Run, chat and device authority for observations",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      prepareRunMocks();
      const tracker = createRunTracker();
      const owner1 = bdd.user({ orgRole: "org:admin" });
      const owner2 = bdd.user({ orgRole: "org:admin" });
      const owner3 = bdd.user({ orgRole: "org:admin" });
      const owner1Identity = requireOrgOwner(owner1);

      const runnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 5,
      };
      const [runnerGroup, , host1] = await Promise.all([
        runs.configureRunnerGroup({ maxConcurrent: 4, runnerIdentity }),
        deliverOrganizationCreated(context, owner1),
        createSshHost(owner1, {
          displayName: "Observed Host",
          host: "observed.example.com",
        }),
      ]);
      const [, host2] = await Promise.all([
        deliverOrganizationCreated(context, owner3),
        createSshHost(owner2, {
          displayName: "Foreign Host",
          host: "foreign.example.com",
        }),
      ]);
      const host3 = await createSshHost(owner3, {
        displayName: "Completed Owner Host",
        host: "completed-owner.example.com",
      });

      const activeRun = await launchChatRun(
        tracker,
        owner1,
        runnerGroup,
        "Active observation Run",
      );
      const completedRun = await launchChatRun(
        tracker,
        owner3,
        runnerGroup,
        "Completed observation Run",
      );
      await completeRunOk(tracker, completedRun);

      const baseTime = now();
      mockNow(baseTime - 2000);
      const firstObservedAt = nowDate().toISOString();
      const validObserveBody = {
        connectionId: host1.id,
        runnerIdentity: activeRun.runnerIdentity,
        expectedGeneration: 1,
        expectedCreatedAt: host1.createdAt,
        observedAt: firstObservedAt,
        failureReason: "authentication_failed" as const,
      };

      const owner1Headers = sessionHeadersFor(context, owner1);
      const wrongSecretHeaders = {
        authorization: `Bearer vm0_official_${"0".repeat(64)}`,
      };
      const [sessionRejected, sandboxRejected, wrongSecretRejected] =
        await Promise.all([
          accept(
            runnerSshApi.observe({
              headers: owner1Headers,
              params: { runId: activeRun.runId },
              body: validObserveBody,
            }),
            [401],
          ),
          accept(
            runnerSshApi.observe({
              headers: { authorization: `Bearer ${activeRun.sandboxToken}` },
              params: { runId: activeRun.runId },
              body: validObserveBody,
            }),
            [401],
          ),
          accept(
            runnerSshApi.observe({
              headers: wrongSecretHeaders,
              params: { runId: activeRun.runId },
              body: validObserveBody,
            }),
            [401],
          ),
        ]);
      expect(sessionRejected.status).toBe(401);
      expect(sandboxRejected.status).toBe(401);
      expect(wrongSecretRejected.status).toBe(401);

      const runnerHeaders = officialRunnerHeaders();
      const [
        wrongRunnerId,
        olderGeneration,
        foreignConnection,
        completedRunObserve,
      ] = await Promise.all([
        accept(
          runnerSshApi.observe({
            headers: runnerHeaders,
            params: { runId: activeRun.runId },
            body: {
              ...validObserveBody,
              runnerIdentity: {
                runnerId: randomUUID(),
                heartbeatGeneration:
                  activeRun.runnerIdentity.heartbeatGeneration,
              },
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.observe({
            headers: runnerHeaders,
            params: { runId: activeRun.runId },
            body: {
              ...validObserveBody,
              runnerIdentity: {
                runnerId: activeRun.runnerIdentity.runnerId,
                heartbeatGeneration:
                  activeRun.runnerIdentity.heartbeatGeneration - 1,
              },
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.observe({
            headers: runnerHeaders,
            params: { runId: activeRun.runId },
            body: {
              ...validObserveBody,
              connectionId: host2.id,
              expectedCreatedAt: host2.createdAt,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.observe({
            headers: runnerHeaders,
            params: { runId: completedRun.runId },
            body: {
              connectionId: host3.id,
              runnerIdentity: completedRun.runnerIdentity,
              expectedGeneration: 1,
              expectedCreatedAt: host3.createdAt,
              observedAt: firstObservedAt,
              failureReason: "authentication_failed",
            },
          }),
          [200],
        ),
      ]);
      expect(wrongRunnerId.body).toStrictEqual({ outcome: "unavailable" });
      expect(olderGeneration.body).toStrictEqual({ outcome: "unavailable" });
      expect(foreignConnection.body).toStrictEqual({ outcome: "unavailable" });
      expect(completedRunObserve.body).toStrictEqual({
        outcome: "unavailable",
      });

      await accept(
        chatRemoteAccessApi.setThreadOverride({
          headers: sessionHeadersFor(context, owner1),
          params: {
            threadId: activeRun.threadId,
            protocol: "ssh",
            connectionId: host1.id,
          },
          body: { enabled: false },
        }),
        [200],
      );
      const disabledOverrideObserve = await accept(
        runnerSshApi.observe({
          headers: runnerHeaders,
          params: { runId: activeRun.runId },
          body: validObserveBody,
        }),
        [200],
      );
      expect(disabledOverrideObserve.body).toStrictEqual({
        outcome: "unavailable",
      });

      await accept(
        chatRemoteAccessApi.clearThreadOverride({
          headers: sessionHeadersFor(context, owner1),
          params: {
            threadId: activeRun.threadId,
            protocol: "ssh",
            connectionId: host1.id,
          },
        }),
        [200],
      );
      const recordedObserve = await accept(
        runnerSshApi.observe({
          headers: runnerHeaders,
          params: { runId: activeRun.runId },
          body: validObserveBody,
        }),
        [200],
      );
      expect(recordedObserve.body).toStrictEqual({ outcome: "recorded" });

      const ownerObservations = await accept(
        sshConnectionsApi.observations({
          headers: sessionHeadersFor(context, owner1),
        }),
        [200],
      );
      expect(ownerObservations.body.observations).toStrictEqual([
        expect.objectContaining({
          connectionId: host1.id,
          generation: 1,
          failureReason: "authentication_failed",
        }),
      ]);

      // Verify #50892 live remote device policy on observation admission.
      await updateFeatureSwitchesForUser(context, owner1Identity, {
        [FeatureSwitchKey.RemoteDevices]: true,
      });
      const directory = await accept(
        remoteDevicesApi.list({ headers: sessionHeadersFor(context, owner1) }),
        [200],
      );
      const device = directory.body.devices.find((candidate) => {
        return candidate.channels.some((channel) => {
          return channel.kind === "ssh" && channel.id === host1.id;
        });
      });
      if (!device) {
        throw new Error("Expected companion Remote Device for SSH host");
      }

      mockNow(baseTime);
      const recoveryObservedAt = nowDate().toISOString();
      const recoveryBody = {
        ...validObserveBody,
        observedAt: recoveryObservedAt,
        failureReason: null,
      };
      const [missingPolicyObserve, deniedDeviceObserve] = await Promise.all([
        accept(
          runnerSshApi.observe({
            headers: runnerHeaders,
            params: { runId: activeRun.runId },
            body: recoveryBody,
          }),
          [200],
        ),
        accept(
          runnerSshApi.observe({
            headers: runnerHeaders,
            extraHeaders: POLICY_HEADER,
            params: { runId: activeRun.runId },
            body: recoveryBody,
          }),
          [200],
        ),
      ]);
      expect(missingPolicyObserve.body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(deniedDeviceObserve.body).toStrictEqual({
        outcome: "unavailable",
      });

      await accept(
        remoteDevicesApi.setAccess({
          headers: sessionHeadersFor(context, owner1),
          params: { deviceId: device.id },
          body: { mode: "always" },
        }),
        [200],
      );
      const allowedDeviceObserve = await accept(
        runnerSshApi.observe({
          headers: runnerHeaders,
          extraHeaders: POLICY_HEADER,
          params: { runId: activeRun.runId },
          body: recoveryBody,
        }),
        [200],
      );
      expect(allowedDeviceObserve.body).toStrictEqual({ outcome: "recorded" });
      clearMockNow();
    },
  );

  it(
    "runner-ssh-016 returns indistinguishable unavailable for wrong claims and foreign or hidden-org connections",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kmsProbe = prepareRunMocks();
      const tracker = createRunTracker();
      const owner = bdd.user({ orgRole: "org:admin" });
      const foreignOwner = bdd.user({ orgRole: "org:admin" });
      const sameUserOtherOrg = bdd.user({
        userId: owner.userId,
        orgRole: "org:admin",
      });

      const runnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 2,
      };
      const [runnerGroup, , ownedHost] = await Promise.all([
        runs.configureRunnerGroup({ maxConcurrent: 4, runnerIdentity }),
        deliverOrganizationCreated(context, owner),
        createSshHost(owner, {
          displayName: "Owned Host",
          host: "owned.example.com",
        }),
      ]);
      const [, foreignHost] = await Promise.all([
        deliverOrganizationCreated(context, foreignOwner),
        createSshHost(foreignOwner, {
          displayName: "Foreign Host",
          host: "foreign.example.com",
        }),
      ]);
      const hiddenHost = await createSshHost(sameUserOtherOrg, {
        displayName: "Other Org Host",
        host: "other-org.example.com",
      });

      const ownerRun = await launchChatRun(
        tracker,
        owner,
        runnerGroup,
        "Owner active SSH Run",
      );
      await launchChatRun(
        tracker,
        foreignOwner,
        runnerGroup,
        "Foreign active SSH Run",
      );

      const runnerHeaders = officialRunnerHeaders();
      const results = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: ownerRun.runId },
            body: {
              connectionId: randomUUID(),
              runnerIdentity: ownerRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: ownerRun.runId },
            body: {
              connectionId: foreignHost.id,
              runnerIdentity: ownerRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: ownerRun.runId },
            body: {
              connectionId: ownedHost.id,
              runnerIdentity: {
                runnerId: randomUUID(),
                heartbeatGeneration:
                  ownerRun.runnerIdentity.heartbeatGeneration,
              },
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: ownerRun.runId },
            body: {
              connectionId: ownedHost.id,
              runnerIdentity: {
                runnerId: ownerRun.runnerIdentity.runnerId,
                heartbeatGeneration: 8,
              },
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: randomUUID() },
            body: {
              connectionId: ownedHost.id,
              runnerIdentity: ownerRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: ownerRun.runId },
            body: {
              connectionId: hiddenHost.id,
              runnerIdentity: ownerRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId: ownerRun.runId },
            body: {
              connectionId: foreignHost.id,
              runnerIdentity: ownerRun.runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId: ownerRun.runId },
            body: {
              connectionId: hiddenHost.id,
              runnerIdentity: ownerRun.runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);

      for (const response of results) {
        expect(response.body).toStrictEqual({ outcome: "unavailable" });
      }
      expect(kmsProbe.decryptCalls).toBe(0);

      const foreignList = await accept(
        sshConnectionsApi.list({
          headers: sessionHeadersFor(context, foreignOwner),
        }),
        [200],
      );
      expect(foreignList.body.connections).toContainEqual(
        expect.objectContaining({
          id: foreignHost.id,
          learnedHostKey: null,
        }),
      );
    },
  );

  it(
    "runner-ssh-018 checks current chat access, deletion and device policy on every event-automation Runner call",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kmsProbe = prepareRunMocks();
      const tracker = createRunTracker();
      const owner = bdd.user({ orgRole: "org:admin" });
      const ownerIdentity = requireOrgOwner(owner);

      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup({ maxConcurrent: 4 }),
        runs.grantProEntitlement(owner, { tier: "team" }),
      ]);

      const [host, workflowId] = await Promise.all([
        createSshHost(owner, {
          displayName: "Automation Target",
          host: "automation.example.com",
        }),
        workflows.createWorkflow(owner, {
          name: `runner-ssh-event-${randomUUID().slice(0, 8)}`,
          visibility: "private",
          instruction: "Use authorized SSH hosts.",
        }),
      ]);
      const ownerHeaders = sessionHeadersFor(context, owner);
      const automation = await accept(
        workflowAutomationsApi.create({
          headers: ownerHeaders,
          params: { workflowId },
          body: {
            kind: "event",
            eventType: "webhook-received",
            enabled: true,
          },
        }),
        [201],
      );
      const started = await accept(
        workflowAutomationsApi.run({
          headers: ownerHeaders,
          params: { id: automation.body.id },
        }),
        [201],
      );
      expect(started.body.chatThreadId).toStrictEqual(expect.any(String));
      await flushWaitUntilForTest();

      const dispatch = runs.receivedDispatches(runnerGroup).at(-1);
      if (!dispatch) {
        throw new Error("Expected a dispatched event-automation Run");
      }
      const runId = dispatch.executionContext.runId;
      const runnerIdentity = {
        runnerId: dispatch.runnerId,
        heartbeatGeneration: dispatch.heartbeatGeneration,
      };
      tracker.track(owner, runId, dispatch.executionContext.sandboxToken);

      const logs = await accept(
        logsApi.list({
          headers: sessionHeadersFor(context, owner),
          query: { limit: 50 },
        }),
        [200],
      );
      expect(logs.body.data).toContainEqual(
        expect.objectContaining({
          id: runId,
          triggerSource: "automation-event",
        }),
      );

      await accept(
        chatRemoteAccessApi.updateHostDefault({
          headers: sessionHeadersFor(context, owner),
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: false },
        }),
        [200],
      );

      const runnerHeaders = officialRunnerHeaders();
      const [disabledResolve, disabledPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId },
            body: { connectionId: host.id, runnerIdentity },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId },
            body: {
              connectionId: host.id,
              runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(disabledResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(disabledPin.body).toStrictEqual({ outcome: "unavailable" });

      await accept(
        chatRemoteAccessApi.updateHostDefault({
          headers: sessionHeadersFor(context, owner),
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: true },
        }),
        [200],
      );
      await accept(
        sshConnectionsApi.delete({
          headers: sessionHeadersFor(context, owner),
          params: { connectionId: host.id },
          body: { expectedGeneration: 1 },
        }),
        [204],
      );

      const [deletedResolve, deletedPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId },
            body: { connectionId: host.id, runnerIdentity },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId },
            body: {
              connectionId: host.id,
              runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(deletedResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(deletedPin.body).toStrictEqual({ outcome: "unavailable" });

      // Verify #50892 live device denial on the same event-automation Run with zero decryption.
      const deviceHost = await createSshHost(owner, {
        displayName: "Device-Gated Automation Host",
        host: "device-gated.example.com",
        enableDefault: true,
      });
      await updateFeatureSwitchesForUser(context, ownerIdentity, {
        [FeatureSwitchKey.RemoteDevices]: true,
      });
      const [deviceDeniedResolve, deviceDeniedPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            extraHeaders: POLICY_HEADER,
            params: { runId },
            body: { connectionId: deviceHost.id, runnerIdentity },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            extraHeaders: POLICY_HEADER,
            params: { runId },
            body: {
              connectionId: deviceHost.id,
              runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(deviceDeniedResolve.body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(deviceDeniedPin.body).toStrictEqual({ outcome: "unavailable" });
      expect(kmsProbe.decryptCalls).toBe(0);
    },
  );

  it(
    "runner-ssh-004 enforces current per-host defaults, thread overrides and live remote device policy for a dispatched chat Run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      prepareRunMocks();
      const tracker = createRunTracker();
      const owner = bdd.user({ orgRole: "org:admin" });
      const ownerIdentity = requireOrgOwner(owner);

      const privateKey = `key-${randomUUID()}`;
      const [runnerGroup, , host] = await Promise.all([
        runs.configureRunnerGroup({ maxConcurrent: 4 }),
        deliverOrganizationCreated(context, owner),
        createSshHost(owner, {
          displayName: "Toggled Host",
          host: "toggled.example.com",
          username: "deploy",
          privateKey,
          enableDefault: false,
        }),
      ]);

      const activeRun = await launchChatRun(
        tracker,
        owner,
        runnerGroup,
        "Run toggling SSH defaults and overrides",
      );
      const runnerHeaders = officialRunnerHeaders();

      const beforeDefaultOn = await accept(
        runnerSshApi.resolve({
          headers: runnerHeaders,
          params: { runId: activeRun.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: activeRun.runnerIdentity,
          },
        }),
        [200],
      );
      expect(beforeDefaultOn.body).toStrictEqual({ outcome: "unavailable" });

      await accept(
        chatRemoteAccessApi.updateHostDefault({
          headers: sessionHeadersFor(context, owner),
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: true },
        }),
        [200],
      );
      const withDefaultOn = await accept(
        runnerSshApi.resolve({
          headers: runnerHeaders,
          params: { runId: activeRun.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: activeRun.runnerIdentity,
          },
        }),
        [200],
      );
      expect(withDefaultOn.body).toStrictEqual({
        outcome: "resolved",
        host: "toggled.example.com",
        port: 22,
        username: "deploy",
        generation: 1,
        learnedHostKey: null,
        privateKey,
        passphrase: null,
      });

      await flushWaitUntilForTest();
      clearRealtimePublications(context);
      await accept(
        chatRemoteAccessApi.setThreadOverride({
          headers: sessionHeadersFor(context, owner),
          params: {
            threadId: activeRun.threadId,
            protocol: "ssh",
            connectionId: host.id,
          },
          body: { enabled: false },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      expect(sortedRealtimePublications(context)).toStrictEqual(
        sortPublications([
          {
            channel: `user:${ownerIdentity.userId}`,
            topic: "ssh:changed",
            payload: { orgId: ownerIdentity.orgId },
          },
          {
            channel: `runner-group:${runnerGroup}`,
            topic: "ssh-authority-invalidated",
            payload: { runId: activeRun.runId, connectionId: host.id },
          },
        ]),
      );

      const [overrideDisabledResolve, overrideDisabledPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            params: { runId: activeRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: activeRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            params: { runId: activeRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: activeRun.runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(overrideDisabledResolve.body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(overrideDisabledPin.body).toStrictEqual({
        outcome: "unavailable",
      });

      await accept(
        chatRemoteAccessApi.updateHostDefault({
          headers: sessionHeadersFor(context, owner),
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: false },
        }),
        [200],
      );
      await accept(
        chatRemoteAccessApi.setThreadOverride({
          headers: sessionHeadersFor(context, owner),
          params: {
            threadId: activeRun.threadId,
            protocol: "ssh",
            connectionId: host.id,
          },
          body: { enabled: true },
        }),
        [200],
      );
      const withOverrideOn = await accept(
        runnerSshApi.resolve({
          headers: runnerHeaders,
          params: { runId: activeRun.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: activeRun.runnerIdentity,
          },
        }),
        [200],
      );
      expect(withOverrideOn.body).toMatchObject({
        outcome: "resolved",
        host: "toggled.example.com",
        username: "deploy",
      });

      await accept(
        chatRemoteAccessApi.clearThreadOverride({
          headers: sessionHeadersFor(context, owner),
          params: {
            threadId: activeRun.threadId,
            protocol: "ssh",
            connectionId: host.id,
          },
        }),
        [200],
      );
      const afterClearOverride = await accept(
        runnerSshApi.resolve({
          headers: runnerHeaders,
          params: { runId: activeRun.runId },
          body: {
            connectionId: host.id,
            runnerIdentity: activeRun.runnerIdentity,
          },
        }),
        [200],
      );
      expect(afterClearOverride.body).toStrictEqual({ outcome: "unavailable" });

      // Opt into #50892 live remote device policy and verify inventory + Runner enforcement.
      await updateFeatureSwitchesForUser(context, ownerIdentity, {
        [FeatureSwitchKey.RemoteDevices]: true,
      });
      await accept(
        chatRemoteAccessApi.updateHostDefault({
          headers: sessionHeadersFor(context, owner),
          params: { protocol: "ssh", connectionId: host.id },
          body: { enabled: true },
        }),
        [404],
      );

      const directory = await accept(
        remoteDevicesApi.list({ headers: sessionHeadersFor(context, owner) }),
        [200],
      );
      const device = directory.body.devices.find((candidate) => {
        return candidate.channels.some((channel) => {
          return channel.kind === "ssh" && channel.id === host.id;
        });
      });
      if (!device) {
        throw new Error("Expected companion Remote Device for SSH host");
      }

      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      const runHeaders = { authorization: `Bearer ${activeRun.agentToken}` };
      const [deniedInventory, deniedPolicyResolve] = await Promise.all([
        accept(sshAccessApi.list({ headers: runHeaders }), [200]),
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            extraHeaders: POLICY_HEADER,
            params: { runId: activeRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: activeRun.runnerIdentity,
            },
          }),
          [200],
        ),
      ]);
      expect(deniedInventory.body.hosts).toStrictEqual([]);
      expect(deniedPolicyResolve.body).toStrictEqual({
        outcome: "unavailable",
      });

      await accept(
        remoteDevicesApi.approve({
          headers: sessionHeadersFor(context, owner),
          params: { threadId: activeRun.threadId },
          body: { deviceId: device.id },
        }),
        [200],
      );
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      const [allowedInventory, legacyRunnerResolve, policyRunnerResolve] =
        await Promise.all([
          accept(sshAccessApi.list({ headers: runHeaders }), [200]),
          accept(
            runnerSshApi.resolve({
              headers: runnerHeaders,
              params: { runId: activeRun.runId },
              body: {
                connectionId: host.id,
                runnerIdentity: activeRun.runnerIdentity,
              },
            }),
            [200],
          ),
          accept(
            runnerSshApi.resolve({
              headers: runnerHeaders,
              extraHeaders: POLICY_HEADER,
              params: { runId: activeRun.runId },
              body: {
                connectionId: host.id,
                runnerIdentity: activeRun.runnerIdentity,
              },
            }),
            [200],
          ),
        ]);
      expect(allowedInventory.body.hosts).toContainEqual(
        expect.objectContaining({ id: host.id, host: "toggled.example.com" }),
      );
      expect(legacyRunnerResolve.body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(
        policyRunnerResolve.headers.get("x-okou-remote-device-policy"),
      ).toBe("1");
      expect(policyRunnerResolve.body).toMatchObject({
        outcome: "resolved",
        host: "toggled.example.com",
        username: "deploy",
      });

      await accept(
        remoteDevicesApi.setAccess({
          headers: sessionHeadersFor(context, owner),
          params: { deviceId: device.id },
          body: { mode: "denied" },
        }),
        [200],
      );
      const [revokedResolve, revokedPin] = await Promise.all([
        accept(
          runnerSshApi.resolve({
            headers: runnerHeaders,
            extraHeaders: POLICY_HEADER,
            params: { runId: activeRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: activeRun.runnerIdentity,
            },
          }),
          [200],
        ),
        accept(
          runnerSshApi.pin({
            headers: runnerHeaders,
            extraHeaders: POLICY_HEADER,
            params: { runId: activeRun.runId },
            body: {
              connectionId: host.id,
              runnerIdentity: activeRun.runnerIdentity,
              expectedGeneration: 1,
              observedHostKey: OBSERVED_HOST_KEY,
            },
          }),
          [200],
        ),
      ]);
      expect(revokedResolve.body).toStrictEqual({ outcome: "unavailable" });
      expect(revokedPin.body).toStrictEqual({ outcome: "unavailable" });
    },
  );
});
