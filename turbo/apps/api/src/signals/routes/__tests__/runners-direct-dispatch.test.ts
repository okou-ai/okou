import { randomUUID } from "node:crypto";
import { HttpResponse } from "msw";
import { expect, onTestFinished, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatEventsRoutes } from "../chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { clearMockNow, mockNow, now } from "../../../lib/time";

const context = testContext();

async function launchFixture() {
  const api = createRunsApi(context);
  const bdd = createBddApi(context);
  const callbacks = createChatCallbacksApi(context);
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  const actor = bdd.user();
  const group = await api.configureRunnerGroup({ registerRunner: false });
  await api.grantProEntitlement(actor);
  await api.ensurePersonalSubscriptionModel(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Direct dispatch agent",
    description: "Exercises full input delivery.",
    visibility: "private",
  });
  return { api, actor, group, agentId: agent.agentId };
}

test("delivers complete input after binding its process", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const identity = await f.api.registerDirectRunner(f.group, {
    reply: async (envelope) => {
      expect(
        (
          await f.api.requestRunRunner(
            f.actor,
            envelope.executionContext.runId,
            [200],
          )
        ).body,
      ).toMatchObject({
        runnerId: envelope.runnerId,
        runnerHeartbeatGeneration: envelope.heartbeatGeneration,
      });
      return HttpResponse.json({
        runnerId: envelope.runnerId,
        heartbeatGeneration: envelope.heartbeatGeneration,
        runId: envelope.executionContext.runId,
        disposition: "accepted",
      });
    },
  });
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "direct complete input",
  });
  const input = await f.api.executionInput(run.runId);
  expect(input.runId).toBe(run.runId);
  expect(input.prompt).toContain("direct complete input");
  expect(input.sandboxToken).toBeTruthy();
  expect(input.platformEnvironment.OKOU_TOKEN).toMatch(/^vm0_sandbox_/);
  expect(input.contentBundles).toBeDefined();
  expect(run.status).toBe("running");
  expect(
    (await f.api.requestRunRunner(f.actor, run.runId, [200])).body,
  ).toMatchObject({
    runnerId: identity.runnerId,
    runnerHeartbeatGeneration: identity.heartbeatGeneration,
  });
});

test("fails a Run with no serving process and releases its concurrency slot", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "no serving process",
  });
  expect(run).toMatchObject({
    status: "failed",
    error: "No eligible serving Runner is available",
  });
  expect((await f.api.readRunQueue(f.actor)).body.concurrency.active).toBe(0);
});

test("retries identical bytes on the same process after a lost response and a later 429", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const bytes: string[] = [];
  const identity = await f.api.registerDirectRunner(f.group, {
    reply: (envelope, body) => {
      bytes.push(body);
      if (bytes.length === 1) {
        return HttpResponse.error();
      }
      return HttpResponse.json(
        {
          runnerId: envelope.runnerId,
          heartbeatGeneration: envelope.heartbeatGeneration,
          runId: envelope.executionContext.runId,
          disposition: bytes.length === 2 ? "busy" : "accepted",
        },
        { status: bytes.length === 2 ? 429 : 200 },
      );
    },
  });
  let alternatives = 0;
  await f.api.registerDirectRunner(f.group, {
    runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 2 },
    maxConcurrent: 1,
    reply: (envelope) => {
      alternatives++;
      return HttpResponse.json({
        runnerId: envelope.runnerId,
        heartbeatGeneration: envelope.heartbeatGeneration,
        runId: envelope.executionContext.runId,
        disposition: "accepted",
      });
    },
  });
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "ambiguous delivery",
  });
  expect(run.status).toBe("running");
  expect(bytes).toHaveLength(3);
  expect(new Set(bytes).size).toBe(1);
  expect(alternatives).toBe(0);
  expect(
    (await f.api.requestRunRunner(f.actor, run.runId, [200])).body,
  ).toMatchObject({
    runnerId: identity.runnerId,
    runnerHeartbeatGeneration: identity.heartbeatGeneration,
  });
});

test("switches candidates only after a definite refusal", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const visited: string[] = [];
  let rejected = false;
  const reply: NonNullable<
    NonNullable<Parameters<typeof f.api.registerDirectRunner>[1]>["reply"]
  > = (envelope) => {
    visited.push(envelope.runnerId);
    const disposition = rejected ? "accepted" : "rejected";
    rejected = true;
    return HttpResponse.json({
      runnerId: envelope.runnerId,
      heartbeatGeneration: envelope.heartbeatGeneration,
      runId: envelope.executionContext.runId,
      disposition,
    });
  };
  await f.api.registerDirectRunner(f.group, {
    runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 2 },
    reply,
  });
  await f.api.registerDirectRunner(f.group, {
    runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 3 },
    reply,
  });
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "definite rejection",
  });
  expect(run.status).toBe("running");
  expect(visited).toHaveLength(2);
  expect(new Set(visited).size).toBe(2);
  expect(
    (await f.api.requestRunRunner(f.actor, run.runId, [200])).body,
  ).toMatchObject({ runnerId: visited[1] });
});

test("tries every capacity-ranked candidate with the same prepared execution input", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const offers: {
    readonly runnerId: string;
    readonly executionContext: unknown;
  }[] = [];
  const candidates = [
    { totalVcpu: 4, totalMemoryMb: 32_768, maxConcurrent: 8 },
    { totalVcpu: 16, totalMemoryMb: 4096, maxConcurrent: 8 },
    { totalVcpu: 16, totalMemoryMb: 32_768, maxConcurrent: 3 },
  ];
  const identities = [];
  for (const [index, heartbeat] of candidates.entries()) {
    identities.push(
      await f.api.registerDirectRunner(f.group, {
        heartbeat,
        reply: (envelope) => {
          offers.push(envelope);
          return HttpResponse.json({
            runnerId: envelope.runnerId,
            heartbeatGeneration: envelope.heartbeatGeneration,
            runId: envelope.executionContext.runId,
            disposition: index === 1 ? "accepted" : "rejected",
          });
        },
      }),
    );
  }
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "Visit all capacity-ranked processes",
  });
  expect(run.status).toBe("running");
  expect(
    offers.map((offer) => {
      return offer.runnerId;
    }),
  ).toStrictEqual([
    identities[2]?.runnerId,
    identities[0]?.runnerId,
    identities[1]?.runnerId,
  ]);
  expect(offers[1]?.executionContext).toStrictEqual(
    offers[0]?.executionContext,
  );
  expect(offers[2]?.executionContext).toStrictEqual(
    offers[0]?.executionContext,
  );
  expect(
    (await f.api.requestRunRunner(f.actor, run.runId, [200])).body,
  ).toMatchObject({
    runnerId: identities[1]?.runnerId,
  });
});

test.each([
  {
    kind: "unlimited",
    maxConcurrent: 0,
    runningCount: 100,
    allocatedVcpu: 0,
    allocatedMemoryMb: 0,
  },
  {
    kind: "reclaimable",
    maxConcurrent: 2,
    runningCount: 2,
    allocatedVcpu: 8,
    allocatedMemoryMb: 16_384,
  },
])("dispatches to advertised $kind capacity", async (heartbeat) => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const { kind, ...resources } = heartbeat;
  const identity = await f.api.registerDirectRunner(f.group, {
    heartbeat: resources,
  });
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: `Use ${kind} capacity`,
  });
  expect(run.status).toBe("running");
  expect(
    (await f.api.requestRunRunner(f.actor, run.runId, [200])).body,
  ).toMatchObject({
    runnerId: identity.runnerId,
    runnerHeartbeatGeneration: identity.heartbeatGeneration,
  });
});

test("selects a fresh serving process after stale, unavailable and untrusted-host observations", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  await f.api.registerDirectRunner(f.group);
  mockNow(clock + 180_001);
  await f.api.registerDirectRunner(f.group, {
    hostname: "untrusted.example.test",
    maxConcurrent: 100,
  });
  await f.api.registerDirectRunner(f.group, {
    heartbeat: { ingressServiceActive: false },
  });
  await f.api.registerDirectRunner(f.group, {
    heartbeat: { mode: "draining" },
  });
  await f.api.registerDirectRunner(f.group, {
    heartbeat: { admittableProfiles: [] },
  });
  const identity = await f.api.registerDirectRunner(f.group, {
    heartbeat: { snapshotSequence: 2 },
  });
  // A replay cannot remove this process's current serving observation.
  await f.api.requestHeartbeatRunner(true, [200], {
    group: f.group,
    runnerId: identity.runnerId,
    snapshotGeneration: identity.heartbeatGeneration,
    snapshotSequence: 1,
    mode: "starting",
  });
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "Use a current serving process",
  });
  expect(run.status).toBe("running");
  expect(
    (await f.api.requestRunRunner(f.actor, run.runId, [200])).body,
  ).toMatchObject({
    runnerId: identity.runnerId,
    runnerHeartbeatGeneration: identity.heartbeatGeneration,
  });
});

test("launches the following queued input after a definite refusal releases its Thread", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const chat = createChatFilesBddApi(context);
  const clientEventId = randomUUID();
  let queued = false;
  await f.api.registerDirectRunner(f.group, {
    reply: async (envelope) => {
      const first = !queued;
      queued = true;
      if (first) {
        const reuseKey = envelope.executionContext.reuseKey;
        if (!reuseKey?.startsWith("thread:")) {
          throw new Error("Expected a Thread-scoped Run");
        }
        await chat.requestSendEvent(
          f.actor,
          {
            agentId: f.agentId,
            threadId: reuseKey.slice("thread:".length),
            clientEventId,
            prompt: "Continue after refused delivery",
          },
          [201],
        );
      }
      return HttpResponse.json({
        runnerId: envelope.runnerId,
        heartbeatGeneration: envelope.heartbeatGeneration,
        runId: envelope.executionContext.runId,
        disposition: first ? "rejected" : "accepted",
      });
    },
  });
  const first = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "Refuse this input",
  });
  expect(first.status).toBe("failed");
  const events = await chat.listThreadEvents(f.actor, first.threadId);
  const promoted = events.events.find((event) => {
    return event.revokesEventId === clientEventId;
  });
  if (!promoted?.runId) {
    throw new Error("Expected the following input to launch");
  }
  await expect(f.api.readRun(f.actor, promoted.runId)).resolves.toMatchObject({
    status: "running",
  });
  expect((await f.api.readRunQueue(f.actor)).body.concurrency.active).toBe(1);
});

test("preserves a concurrent cancellation after the process proves it did not accept", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  await f.api.registerDirectRunner(f.group, {
    reply: async (envelope) => {
      await f.api.requestCancelRun(
        f.actor,
        envelope.executionContext.runId,
        [200],
      );
      return HttpResponse.json(
        {
          runnerId: envelope.runnerId,
          heartbeatGeneration: envelope.heartbeatGeneration,
          runId: envelope.executionContext.runId,
          disposition: "busy",
        },
        { status: 429 },
      );
    },
  });
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "cancel before acceptance",
  });
  expect(run.status).toBe("cancelled");
  expect((await f.api.readRunQueue(f.actor)).body.concurrency.active).toBe(0);
});

test("definite refusal releases a preselected Run even though startedAt is set", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  await f.api.registerDirectRunner(f.group, {
    reply: (envelope) => {
      return HttpResponse.json({
        runnerId: envelope.runnerId,
        heartbeatGeneration: envelope.heartbeatGeneration,
        runId: envelope.executionContext.runId,
        disposition: "rejected",
      });
    },
  });
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "reject input",
  });
  expect(run).toMatchObject({
    status: "failed",
    error: "Every eligible Runner refused this Run",
  });
  expect((await f.api.readRunQueue(f.actor)).body.concurrency.active).toBe(0);
});

test("waits through short preferred-process 429s before using a roomier candidate", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const identity = await f.api.registerDirectRunner(f.group, {
    maxConcurrent: 1,
  });
  const first = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "establish the preferred process",
    model: "claude-fable-5-1",
  });
  const firstInput = await f.api.executionInput(first.runId);
  await completePublicClaudeRun(
    context,
    first,
    { authorization: `Bearer ${firstInput.sandboxToken}` },
    "predecessor complete",
  );
  const bytes: string[] = [];
  await f.api.registerDirectRunner(f.group, {
    runnerIdentity: identity,
    maxConcurrent: 1,
    reply: (envelope, body) => {
      bytes.push(body);
      const busy = bytes.length < 3;
      return HttpResponse.json(
        {
          runnerId: envelope.runnerId,
          heartbeatGeneration: envelope.heartbeatGeneration,
          runId: envelope.executionContext.runId,
          disposition: busy ? "busy" : "accepted",
        },
        { status: busy ? 429 : 200 },
      );
    },
  });
  let alternatives = 0;
  await f.api.registerDirectRunner(f.group, {
    runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 2 },
    reply: (envelope) => {
      alternatives++;
      return HttpResponse.json({
        runnerId: envelope.runnerId,
        heartbeatGeneration: envelope.heartbeatGeneration,
        runId: envelope.executionContext.runId,
        disposition: "accepted",
      });
    },
  });
  const next = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    threadId: first.threadId,
    prompt: "resume on the preferred process",
  });
  expect(next.status).toBe("running");
  expect(bytes).toHaveLength(3);
  expect(new Set(bytes).size).toBe(1);
  expect(alternatives).toBe(0);
  expect(
    (await f.api.requestRunRunner(f.actor, next.runId, [200])).body,
  ).toMatchObject({
    runnerId: identity.runnerId,
    runnerHeartbeatGeneration: identity.heartbeatGeneration,
  });
});
