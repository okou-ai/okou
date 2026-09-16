import { randomUUID } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createEmailApi } from "./helpers/api-bdd-email";
import { createRunsApi } from "./helpers/api-bdd-runs";

/**
 * helper gap:
 * - RUN-02 exhaustive connector credential, secret, variable, grant, custom
 *   connector, and skill setup still needs public API helper coverage before
 *   the old DB fixture matrix can be ported without DB writes. This file covers
 *   model-provider setup through API routes and run-context GET boundaries.
 * - RUN-01/RUN-03/CHAIN-RUN successful dispatch is covered by
 *   run-lifecycle.bdd.test.ts via the public Stripe invoice.paid entitlement
 *   helper (grantProEntitlement); this file keeps the unauthenticated and
 *   malformed admission boundaries plus runner auth surfaces.
 * - RUN-04 persisted runner log ingestion needs callback/event API helpers.
 *   Checkpoint creation through the sandbox webhook is covered by
 *   run-lifecycle.bdd.test.ts; missing-run GET boundaries stay here.
 * - SCHED-02 sync-skills valid-path coverage needs a focused external GitHub
 *   tarball/S3 helper; this file keeps shared cron auth rejection route-based
 *   without running valid global sweeps from the wrong owner file.
 */

const context = testContext();

function resendSendCallsTo(recipient: string): number {
  return context.mocks.resend.send.mock.calls.filter((call) => {
    const [payload] = call;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "to" in payload &&
      payload.to === recipient
    );
  }).length;
}

async function createAgentWithModelProvider(actor: ApiTestUser): Promise<{
  readonly agentId: string;
}> {
  const bdd = createBddApi(context);
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "BDD run agent",
    description: "Exercises run and cron API integration tests.",
    visibility: "private",
  });

  const api = createRunsApi(context);
  await api.ensureOrgModelProvider(actor);

  return { agentId: agent.agentId };
}

describe("RUN-01: run creation admission and validation", () => {
  it("rejects invalid or unauthorized run creation requests through API validation", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const actor = bdd.user();

    const unauthenticated = await api.requestCreateRun(
      null,
      {
        agentId: randomUUID(),
        prompt: "summarize the repo",
        modelProvider: "anthropic-api-key",
      },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missingAgent = await api.requestCreateRunUnchecked(
      actor,
      { prompt: "summarize the repo" },
      [400],
    );
    expectApiError(missingAgent.body);
    expect(missingAgent.body.error.code).toBe("BAD_REQUEST");
    expect(missingAgent.body.error.message).toBe(
      "Missing agentId or sessionId",
    );

    const invalidTools = await api.requestCreateRun(
      actor,
      {
        agentId: randomUUID(),
        prompt: "use a malformed tool list",
        tools: ["Bash,Read"],
        modelProvider: "anthropic-api-key",
      },
      [400],
    );
    expectApiError(invalidTools.body);
    expect(invalidTools.body.error.code).toBe("BAD_REQUEST");

    const missingSession = await api.requestCreateRun(
      actor,
      {
        sessionId: randomUUID(),
        prompt: "resume a missing session",
        modelProvider: "anthropic-api-key",
      },
      [404],
    );
    expectApiError(missingSession.body);
    expect(missingSession.body.error.code).toBe("NOT_FOUND");

    const missingAgentId = await api.requestCreateRun(
      actor,
      {
        agentId: randomUUID(),
        prompt: "run a missing agent",
        modelProvider: "anthropic-api-key",
      },
      [404],
    );
    expectApiError(missingAgentId.body);
    expect(missingAgentId.body.error.code).toBe("NOT_FOUND");
  });
});

describe("RUN-01..04 and CHAIN-RUN: run admission, runner, and visible reads", () => {
  it("sets up run prerequisites through APIs and exposes the no-credit admission boundary", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const actor = bdd.user();
    const { agentId } = await createAgentWithModelProvider(actor);

    const denied = await api.requestCreateRun(
      actor,
      {
        agentId,
        prompt: "Produce a concise status report.",
        modelProvider: "anthropic-api-key",
        tools: ["Bash"],
        settings: "{}",
      },
      [402],
    );
    expectApiError(denied.body);
    expect(denied.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.active).toBe(0);
    expect(queue.body.queue).toHaveLength(0);

    const runnerGroup = api.configureRunnerGroup();
    const heartbeat = await api.heartbeatRunner(runnerGroup);
    expect(heartbeat.body.ok).toBeTruthy();

    const poll = await api.pollRunner(runnerGroup);
    expect(poll.body.job).toBeNull();

    const missingRunId = randomUUID();
    const missingRun = await api.requestReadRun(actor, missingRunId, [404]);
    expectApiError(missingRun.body);
    expect(missingRun.body.error.code).toBe("NOT_FOUND");

    const missingContext = await api.requestRunContext(
      actor,
      missingRunId,
      [404],
    );
    expectApiError(missingContext.body);
    expect(missingContext.body.error.code).toBe("NOT_FOUND");
  });

  it("keeps official runner held-sandbox heartbeat and empty polling visible through public endpoints", async () => {
    const api = createRunsApi(context);
    const runnerGroup = api.configureRunnerGroup();
    const heldSandboxStates = [
      {
        reuseKey: "thread:cron-bdd-held",
        lastCompletedAt: new Date(now()).toISOString(),
        reusableSandbox: { profile: "vm0/default" },
      },
    ];

    const heartbeat = await api.requestHeartbeatRunner(true, [200], {
      heldSandboxStates,
    });
    if (heartbeat.status !== 200) {
      throw new Error(
        `Expected runner heartbeat to succeed, got ${heartbeat.status}`,
      );
    }
    expect(heartbeat.body.ok).toBeTruthy();

    const emptyPoll = await api.requestPollRunner(
      true,
      { group: runnerGroup, supportedProfiles: ["vm0/default"] },
      [200],
    );
    if (emptyPoll.status !== 200) {
      throw new Error(
        `Expected empty poll to succeed, got ${emptyPoll.status}`,
      );
    }
    expect(emptyPoll.body.job).toBeNull();
  });

  it("keeps missing run detail and context hidden for another organization", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const outsider = bdd.user();
    const missingRunId = randomUUID();

    const hiddenRun = await api.requestReadRun(outsider, missingRunId, [404]);
    expectApiError(hiddenRun.body);
    expect(hiddenRun.body.error.code).toBe("NOT_FOUND");

    const hiddenContext = await api.requestRunContext(
      outsider,
      missingRunId,
      [404],
    );
    expectApiError(hiddenContext.body);
    expect(hiddenContext.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects runner metadata reads and job claims at unauthenticated, malformed, and missing boundaries", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const actor = bdd.user();
    const missingRunId = randomUUID();
    const invalidRunId = "not-a-run-id";

    const unauthenticatedRunner = await api.requestRunRunner(
      null,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedRunner.body);
    expect(unauthenticatedRunner.body.error.code).toBe("UNAUTHORIZED");

    const invalidRunner = await api.requestRunRunner(
      actor,
      invalidRunId,
      [400],
    );
    expectApiError(invalidRunner.body);
    expect(invalidRunner.body.error.code).toBe("BAD_REQUEST");

    const missingRunner = await api.requestRunRunner(
      actor,
      missingRunId,
      [404],
    );
    expectApiError(missingRunner.body);
    expect(missingRunner.body.error.code).toBe("NOT_FOUND");

    const unauthenticatedClaim = await api.requestClaimRunnerJob(
      false,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedClaim.body);
    expect(unauthenticatedClaim.body.error.code).toBe("UNAUTHORIZED");

    const invalidClaim = await api.requestClaimRunnerJob(
      true,
      invalidRunId,
      [400],
    );
    expectApiError(invalidClaim.body);
    expect(invalidClaim.body.error.code).toBe("BAD_REQUEST");

    const missingClaim = await api.requestClaimRunnerJob(
      true,
      missingRunId,
      [404],
    );
    expectApiError(missingClaim.body);
    expect(missingClaim.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects malformed and unauthenticated runner, queue, read, context, and cancel requests", async () => {
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    const actor = bdd.user();
    const missingRunId = randomUUID();
    const invalidRunId = "not-a-run-id";

    const unauthenticatedQueue = await api.requestReadRunQueue(null, [401]);
    expectApiError(unauthenticatedQueue.body);
    expect(unauthenticatedQueue.body.error.code).toBe("UNAUTHORIZED");

    const unauthenticatedRead = await api.requestReadRun(
      null,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedRead.body);
    expect(unauthenticatedRead.body.error.code).toBe("UNAUTHORIZED");

    const invalidRead = await api.requestReadRun(actor, invalidRunId, [400]);
    expectApiError(invalidRead.body);
    expect(invalidRead.body.error.code).toBe("BAD_REQUEST");

    const invalidContext = await api.requestRunContext(
      actor,
      invalidRunId,
      [400],
    );
    expectApiError(invalidContext.body);
    expect(invalidContext.body.error.code).toBe("BAD_REQUEST");

    const unauthenticatedCancel = await api.requestCancelRun(
      null,
      missingRunId,
      [401],
    );
    expectApiError(unauthenticatedCancel.body);
    expect(unauthenticatedCancel.body.error.code).toBe("UNAUTHORIZED");

    const invalidCancel = await api.requestCancelRun(
      actor,
      invalidRunId,
      [400],
    );
    expectApiError(invalidCancel.body);
    expect(invalidCancel.body.error.code).toBe("BAD_REQUEST");

    const missingCancel = await api.requestCancelRun(
      actor,
      missingRunId,
      [404],
    );
    expectApiError(missingCancel.body);
    expect(missingCancel.body.error.code).toBe("NOT_FOUND");

    const unauthenticatedHeartbeat = await api.requestHeartbeatRunner(
      false,
      [401],
    );
    expectApiError(unauthenticatedHeartbeat.body);
    expect(unauthenticatedHeartbeat.body.error.code).toBe("UNAUTHORIZED");

    const invalidHeartbeatGroup = await api.requestHeartbeatRunner(
      true,
      [400],
      { group: "other/test" },
    );
    expectApiError(invalidHeartbeatGroup.body);
    expect(invalidHeartbeatGroup.body.error.code).toBe("BAD_REQUEST");

    const unauthenticatedPoll = await api.requestPollRunner(
      false,
      { group: "vm0/test", supportedProfiles: ["vm0/default"] },
      [401],
    );
    expectApiError(unauthenticatedPoll.body);
    expect(unauthenticatedPoll.body.error.code).toBe("UNAUTHORIZED");

    const invalidPollGroup = await api.requestPollRunner(
      true,
      { group: "not-a-group", supportedProfiles: ["vm0/default"] },
      [400],
    );
    expectApiError(invalidPollGroup.body);
    expect(invalidPollGroup.body.error.code).toBe("BAD_REQUEST");
  });

  it("issues runner realtime tokens only for authenticated vm0 runner groups", async () => {
    const api = createRunsApi(context);

    const unauthenticated = await api.requestRunnerRealtimeToken(
      false,
      { group: "vm0/test" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const malformedGroup = await api.requestRunnerRealtimeToken(
      true,
      { group: "not-a-group" },
      [400],
    );
    expectApiError(malformedGroup.body);
    expect(malformedGroup.body.error.code).toBe("BAD_REQUEST");

    const forbiddenGroup = await api.requestRunnerRealtimeToken(
      true,
      { group: "other/test" },
      [403],
    );
    expectApiError(forbiddenGroup.body);
    expect(forbiddenGroup.body.error.code).toBe("FORBIDDEN");

    const capability = JSON.stringify({
      "runner-group:vm0/test": ["subscribe"],
    });
    context.mocks.ably.createTokenRequest.mockResolvedValueOnce({
      keyName: "ably-key",
      timestamp: now(),
      capability,
      nonce: "nonce",
      mac: "mac",
    });

    const token = await api.requestRunnerRealtimeToken(
      true,
      { group: "vm0/test" },
      [200],
    );
    if (token.status !== 200) {
      throw new Error("Expected runner realtime token request to succeed");
    }
    expect(token.body.capability).toBe(capability);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        "runner-group:vm0/test": ["subscribe"],
      },
      ttl: 60 * 60 * 1000,
    });
  });
});

// Workflow schedule lifecycle and execution coverage lives in
// zero-workflow-automations.test.ts and zero-workflow-automation-scheduler.test.ts.
// Shared cron authorization is covered in global-sweep-contracts.test.ts.

describe("SCHED-02: cron routes", () => {
  it("rejects invalid cron auth on shared cron routes", async () => {
    const api = createRunsApi(context);

    const invalidCronRoutes = await api.requestSharedCronRoutesWithoutAuth();
    expect(
      Object.values(invalidCronRoutes).every((response) => {
        return response.status === 401;
      }),
    ).toBeTruthy();
  });
});

describe("SCHED-02 and OPS-01: email outbox drain cron", () => {
  it("drains a data-export email once at its UTC retry boundary", async () => {
    const email = createEmailApi(context);
    const actor = createBddApi(context).user();
    const baseTime = now();
    mockNow(baseTime);
    onTestFinished(() => {
      clearMockNow();
    });

    const { to, subject } = await email.enqueueDataExportEmail(actor);
    const item = await email.findEmailOutboxItem({ to, subject });
    expect(resendSendCallsTo(to)).toBe(0);

    context.mocks.resend.send.mockResolvedValue({
      data: null,
      error: { message: "data export drain down" },
    });
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    const failedDrain = await email.drainEmailOutboxItems([item.id]);
    expect(failedDrain).toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(resendSendCallsTo(to)).toBe(1);

    context.mocks.resend.send.mockReset();
    context.mocks.resend.send.mockResolvedValue({
      data: { id: "resend-bdd-1" },
    });

    const beforeRetry = await email.drainEmailOutboxItems([item.id]);
    expect(beforeRetry).toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(0);
    expect(resendSendCallsTo(to)).toBe(0);

    mockNow(baseTime + 1000);
    const drain = await email.drainEmailOutboxItems([item.id]);
    expect(drain).toBe(1);
    expect(context.mocks.resend.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Okou <okou@mail.example.com>",
        to,
        subject,
        html: expect.stringContaining("Your data export is ready"),
      }),
      // The retry replays the request the first attempt committed.
      { idempotencyKey: `okou-email-outbox/v1/${item.id}` },
    );
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(resendSendCallsTo(to)).toBe(1);

    const second = await email.drainEmailOutboxItems([item.id]);
    expect(second).toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(resendSendCallsTo(to)).toBe(1);
  });

  it("skips an outbox row locked by the inline drain", async () => {
    const email = createEmailApi(context);
    const actor = createBddApi(context).user();
    const { to, subject } = await email.enqueueDataExportEmail(actor);
    const item = await email.findEmailOutboxItem({ to, subject });
    const sendStarted = createDeferredPromise<void>(context.signal);
    const releaseSend = createDeferredPromise<void>(context.signal);
    onTestFinished(async () => {
      if (!releaseSend.settled()) {
        releaseSend.resolve(undefined);
      }
      await flushWaitUntilForTest();
    });

    context.mocks.resend.send.mockReset();
    context.mocks.resend.send.mockImplementation(async (payload) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "to" in payload &&
        payload.to === to
      ) {
        sendStarted.resolve(undefined);
        await releaseSend.promise;
      }
      return { data: { id: "resend-bdd-locked" }, error: null };
    });
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);

    const firstDrain = email.drainEmailOutboxItems([item.id]);
    await sendStarted.promise;
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(resendSendCallsTo(to)).toBe(1);

    const concurrentDrain = await email.drainEmailOutboxItems([item.id]);
    expect(concurrentDrain).toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(resendSendCallsTo(to)).toBe(1);

    releaseSend.resolve(undefined);
    await expect(firstDrain).resolves.toBe(1);
    await flushWaitUntilForTest();
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(resendSendCallsTo(to)).toBe(1);

    const afterRelease = await email.drainEmailOutboxItems([item.id]);
    expect(afterRelease).toBe(0);
    expect(context.mocks.resend.send).toHaveBeenCalledTimes(1);
    expect(resendSendCallsTo(to)).toBe(1);
  });
});
