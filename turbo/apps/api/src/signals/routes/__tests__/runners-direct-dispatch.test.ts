import { randomUUID } from "node:crypto";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatEventsRoutes } from "../chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { completePublicClaudeRun } from "./helpers/public-native-run";

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

test("delivers complete input after binding its process and leaves no new Claim job", async () => {
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
  expect((await f.api.pollRunner(f.group)).body.job).toBeNull();
  await f.api.requestClaimRunnerJob(true, run.runId, [404]);
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
  expect((await f.api.pollRunner(f.group)).body.job).toBeNull();
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
