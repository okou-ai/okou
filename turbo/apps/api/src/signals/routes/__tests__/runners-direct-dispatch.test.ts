import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { expect, onTestFinished, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatEventsRoutes } from "../chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { cronCleanupSandboxesContract } from "@okouai/api-contracts/contracts/cron";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { env } from "../../../lib/env";

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

test("persists preparation failure and releases admission before another Run", async () => {
  const f = await launchFixture();
  await f.api.registerDirectRunner(f.group);
  await createBddApi(context).updateAgentInstructions(
    f.actor,
    f.agentId,
    `# Direct preparation ${randomUUID()}`,
  );
  context.mocks.s3.getSignedUrl.mockRejectedValue(
    new Error("Object signing is unavailable"),
  );
  const chat = createChatFilesBddApi(context);
  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    f.actor,
    {
      agentId: f.agentId,
      prompt: "Fail execution preparation",
      clientEventId,
    },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected admission to enqueue");
  }
  await expect(flushWaitUntilForTest()).rejects.toThrow(
    "Run execution preparation failed",
  );
  const events = await chat.listThreadEvents(f.actor, sent.body.threadId);
  const admitted = events.events.find((event) => {
    return event.revokesEventId === clientEventId;
  });
  if (!admitted?.runId) {
    throw new Error("Expected a durable admitted Run");
  }
  await expect(f.api.readRun(f.actor, admitted.runId)).resolves.toMatchObject({
    status: "failed",
    error: "Run execution preparation failed",
  });
  expect((await f.api.readRunQueue(f.actor)).body.concurrency.active).toBe(0);
  f.api.acceptStorageDownloads();
  const next = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    threadId: sent.body.threadId,
    prompt: "Continue after preparation recovered",
  });
  expect(next.status).toBe("running");
});

test("keeps PAT-advertised serving capacity outside the official fleet", async () => {
  const f = await launchFixture();
  const identity = await f.api.registerDirectRunner(f.group, {
    maxConcurrent: 1,
  });
  const token = await f.api.createCliToken(f.actor);
  const attacker = { runnerId: randomUUID(), heartbeatGeneration: 4 };
  const hostname = `runner-${attacker.runnerId}.okou.app`;
  server.use(
    http.post(
      `https://${hostname}/runners/${attacker.runnerId}/control/runs/:runId/dispatch`,
      ({ params }) => {
        return HttpResponse.json({
          ...attacker,
          runId: params.runId,
          disposition: "accepted",
        });
      },
    ),
  );
  await f.api.requestHeartbeatRunnerAs(`Bearer ${token.token}`, [200], {
    runnerId: attacker.runnerId,
    snapshotGeneration: attacker.heartbeatGeneration,
    runnerHostname: hostname,
    group: f.group,
    ingressServiceActive: true,
    maxConcurrent: 100,
  });
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "Use an official process",
  });
  expect(run.status).toBe("running");
  expect(
    (await f.api.requestRunRunner(f.actor, run.runId, [200])).body,
  ).toMatchObject({
    runnerId: identity.runnerId,
    runnerHeartbeatGeneration: identity.heartbeatGeneration,
  });
});

test("recovers interrupted delivery through the ordinary Run heartbeat timeout", async () => {
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const chat = createChatFilesBddApi(context);
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  const request = new AbortController();
  onTestFinished(() => {
    request.abort();
  });
  const received = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  let interrupted = false;
  const identity = await f.api.registerDirectRunner(f.group, {
    reply: async (envelope) => {
      if (!interrupted) {
        interrupted = true;
        received.resolve();
        await release.promise;
        return HttpResponse.error();
      }
      return HttpResponse.json({
        runnerId: envelope.runnerId,
        heartbeatGeneration: envelope.heartbeatGeneration,
        runId: envelope.executionContext.runId,
        disposition: "accepted",
      });
    },
  });
  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    f.actor,
    {
      agentId: f.agentId,
      clientEventId,
      prompt: "Interrupt this invocation after publication",
    },
    [201],
    {},
    AbortSignal.any([request.signal, context.signal]),
  );
  if (sent.status !== 201) {
    throw new Error("Expected the input to enqueue");
  }
  await received.promise;
  request.abort();
  release.resolve();
  await flushWaitUntilForTest();
  const page = await chat.listThreadEvents(f.actor, sent.body.threadId);
  const admitted = page.events.find((event) => {
    return event.revokesEventId === clientEventId;
  });
  if (!admitted?.runId) {
    throw new Error("Expected a durable admitted Run");
  }
  expect(
    (await f.api.requestRunRunner(f.actor, admitted.runId, [200])).body,
  ).toMatchObject({
    runnerId: identity.runnerId,
    runnerHeartbeatGeneration: identity.heartbeatGeneration,
  });
  mockNow(clock + 121_000);
  await accept(
    setupApp({ context, routes: cronCleanupSandboxesRoutes })(
      cronCleanupSandboxesContract,
    ).cleanup({
      headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  await expect(f.api.readRun(f.actor, admitted.runId)).resolves.toMatchObject({
    status: "timeout",
    error: "Run timed out (no heartbeat)",
  });
  expect((await f.api.readRunQueue(f.actor)).body.concurrency.active).toBe(0);
  const next = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    threadId: sent.body.threadId,
    prompt: "Continue after interrupted delivery recovered",
  });
  expect(next.status).toBe("running");
});

test.each(["lost", "process", "generation", "run"] as const)(
  "retries identical bytes on the same process after a %s response and a later 429",
  async (responseKind) => {
    const f = await launchFixture();
    const bytes: string[] = [];
    const identity = await f.api.registerDirectRunner(f.group, {
      reply: (envelope, body) => {
        bytes.push(body);
        if (bytes.length === 1) {
          if (responseKind === "lost") {
            return HttpResponse.error();
          }
          return HttpResponse.json({
            runnerId:
              responseKind === "process" ? randomUUID() : envelope.runnerId,
            heartbeatGeneration:
              responseKind === "generation"
                ? envelope.heartbeatGeneration + 1
                : envelope.heartbeatGeneration,
            runId:
              responseKind === "run"
                ? randomUUID()
                : envelope.executionContext.runId,
            disposition: "accepted",
          });
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
  },
);

test("switches candidates only after a definite refusal", async () => {
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
  const f = await launchFixture();
  const offers: {
    readonly runnerId: string;
    readonly executionContext: unknown;
    readonly notAfter: number;
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
    new Set(
      offers.map((offer) => {
        return offer.notAfter;
      }),
    ).size,
  ).toBe(1);
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
  // The three-minute shift can prune another case's still-fresh receiver.
  await setupApp({ context, routes: chatEventsRoutes, isolatePg: true });
  const f = await launchFixture();
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  const stale = await f.api.registerDirectRunner(f.group, {
    maxConcurrent: 100,
  });
  mockNow(clock + 180_001);
  await f.api.requestHeartbeatRunner(true, [200], {
    group: f.group,
    runnerId: stale.runnerId,
    snapshotGeneration: stale.heartbeatGeneration,
    runnerHostname: `runner-${stale.runnerId}.okou.app`,
    maxConcurrent: 100,
    ingressServiceActive: true,
  });
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
  await f.api.registerDirectRunner("vm0/unrelated-group", {
    maxConcurrent: 100,
  });
  const identity = await f.api.registerDirectRunner(f.group, {
    runnerIdentity: { runnerId: randomUUID(), heartbeatGeneration: 2 },
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
  await f.api.requestHeartbeatRunner(true, [200], {
    group: f.group,
    runnerId: identity.runnerId,
    snapshotGeneration: 1,
    snapshotSequence: 100,
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

test("advances when preferred busy pressure outlasts its preference without renewing delivery", async () => {
  const f = await launchFixture();
  const clock = now();
  mockNow(clock);
  onTestFinished(clearMockNow);
  const identity = await f.api.registerDirectRunner(f.group, {
    maxConcurrent: 1,
  });
  const first = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "Establish the preferred process",
    model: "claude-fable-5-1",
  });
  const input = await f.api.executionInput(first.runId);
  await completePublicClaudeRun(
    context,
    first,
    { authorization: `Bearer ${input.sandboxToken}` },
    "Predecessor completed",
  );
  const deadlines: number[] = [];
  await f.api.registerDirectRunner(f.group, {
    runnerIdentity: identity,
    maxConcurrent: 1,
    reply: (envelope) => {
      deadlines.push(envelope.notAfter);
      mockNow(clock + 2000);
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
  const alternative = await f.api.registerDirectRunner(f.group, {
    reply: (envelope) => {
      deadlines.push(envelope.notAfter);
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
    prompt: "Continue after preference expires",
  });
  expect(next.status).toBe("running");
  expect(deadlines).toHaveLength(2);
  expect(new Set(deadlines).size).toBe(1);
  expect(
    (await f.api.requestRunRunner(f.actor, next.runId, [200])).body,
  ).toMatchObject({
    runnerId: alternative.runnerId,
    runnerHeartbeatGeneration: alternative.heartbeatGeneration,
  });
});
