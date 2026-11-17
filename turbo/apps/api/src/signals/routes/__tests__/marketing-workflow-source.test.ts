import { randomUUID } from "node:crypto";
import { marketingWorkflowSourceContract } from "@okouai/api-contracts/contracts/marketing-workflow-source";
import { workflowsDetailContract } from "@okouai/api-contracts/contracts/workflows";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { marketingWorkflowSourceRoutes } from "../marketing-workflow-source";
import { workflowsRoutes } from "../workflows";
import { createBddApi } from "./helpers/api-bdd";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createPublicAutomationRunApi } from "./helpers/public-automation-run";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { marketingRewardConsumer } from "./helpers/marketing-reward-consumer";
import { readGetStartedStatus } from "./helpers/get-started";

const context = testContext();
const bdd = createBddApi(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const secret = "workflow-source-observation-service-1234567890123456789";
const headers = Object.freeze({ authorization: `Bearer ${secret}` });

beforeEach(() => {
  mockEnv("MARKETING_REWARDS_SOURCE_SECRET", secret);
});

function client() {
  return setupApp({ context, routes: marketingWorkflowSourceRoutes })(
    marketingWorkflowSourceContract,
  );
}

async function invokedWorkflow() {
  const consumer = marketingRewardConsumer(context);
  const { actor } = await workflows.setupWorkflowOrg({ tier: "team" });
  const { agentId } = await workflows.createAgent(actor, {
    visibility: "public",
  });
  installWorkflowVolumeS3Fixture(context);
  const workflowId = await workflows.createWorkflow(actor, {
    agentId,
    name: `source-observation-${randomUUID().slice(0, 8)}`,
    instruction: "private-workflow-instruction-for-source-observation",
  });
  const executor = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
  await bdd.completeOnboarding(executor);
  await runs.ensurePersonalSubscriptionModel(executor, {
    model: "claude-fable-5-1",
  });
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const group = await runs.configureRunnerGroup();
  mocks.clerk.session(executor.userId, executor.orgId, executor.orgRole);
  const launched = (
    await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsDetailContract,
      ).run({
        headers: { authorization: "Bearer clerk-session" },
        params: { workflowId },
      }),
      [200],
    )
  ).body;
  await flushWaitUntilForTest();
  const listed = await chat.listThreadEvents(executor, launched.chatThreadId);
  const input = listed.events.find((event) => {
    return event.eventType === "input.prompt" && event.runId;
  });
  if (!input?.runId) {
    throw new Error("Expected public Workflow Run");
  }
  await consumer.deliver();
  const source = consumer.received.find((event) => {
    return event.type === "workflow.run-created" && event.runId === input.runId;
  });
  if (!source || source.type !== "workflow.run-created") {
    throw new Error("Expected retained Workflow source");
  }
  const queued = consumer.received.find((event) => {
    return (
      event.type === "workflow.input-queued" &&
      event.sourceEventId === source.sourceEventId
    );
  });
  if (!queued || queued.type !== "workflow.input-queued") {
    throw new Error("Expected captured queued Workflow source");
  }
  return {
    actor,
    executor,
    group,
    workflowId,
    runId: input.runId,
    source,
    queued,
  };
}

test("requires the dedicated read-only capability before resolving a retained source", async () => {
  const api = client();
  const params = { eventId: randomUUID() };
  for (const credential of [
    "clerk-session",
    "source-intake-secret",
    "financial-settlement-secret",
  ]) {
    const denied = await api.observe({
      params,
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
  }
  expect((await api.observe({ params, headers })).status).toBe(404);
  mockEnv("MARKETING_REWARDS_SOURCE_SECRET", undefined);
  const disabled = await api.observe({ params, headers });
  expect(disabled.status).toBe(503);
  expect(disabled.headers.get("cache-control")).toBe("no-store");
});

test("reports actual failed Run facts after Workflow deletion while preserving the original creator and financial state", async () => {
  await setupApp({
    context,
    routes: marketingWorkflowSourceRoutes,
    isolatePg: true,
  });
  mockNow(new Date("2026-11-17T06:00:00.000Z"));
  const fixture = await invokedWorkflow();
  await createPublicAutomationRunApi(context).complete(
    fixture.executor,
    fixture.runId,
    fixture.group,
    { exitCode: 1, output: "private-failure-detail-not-for-marketing" },
  );
  await createMiscRoutesApi(context).deleteWorkflow(
    fixture.actor,
    fixture.workflowId,
    [204],
  );
  const response = await accept(
    client().observe({ params: { eventId: fixture.source.id }, headers }),
    [200],
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.body).toMatchObject({
    version: 1,
    environment: "development",
    source: {
      eventId: fixture.source.id,
      type: "workflow.run-created",
      orgId: fixture.actor.orgId,
      actorUserId: fixture.executor.userId,
      creatorUserId: fixture.actor.userId,
      workflowId: fixture.workflowId,
      inputEventId: fixture.source.sourceEventId,
      runId: fixture.runId,
    },
    observation: {
      kind: "run",
      runId: fixture.runId,
      status: "failed",
      completedAt: "2026-11-17T06:00:00.000Z",
    },
  });
  expect(JSON.stringify(response.body)).not.toContain(
    "private-workflow-instruction",
  );
  expect(JSON.stringify(response.body)).not.toContain("private-failure-detail");
  const status = await readGetStartedStatus(context, fixture.actor);
  expect(
    status.quests.find((quest) => {
      return quest.key === "workflow";
    })?.claimedCount,
  ).toBe(0);
});

test("observes user cancellation through the same captured Run without creating an award", async () => {
  await setupApp({
    context,
    routes: marketingWorkflowSourceRoutes,
    isolatePg: true,
  });
  const fixture = await invokedWorkflow();
  const params = { eventId: fixture.queued.id };
  const before = (await accept(client().observe({ params, headers }), [200]))
    .body;
  expect(before.source.runId).toBeNull();
  expect(before.observation).toMatchObject({
    kind: "run",
    runId: fixture.runId,
  });
  await runs.requestCancelRun(fixture.executor, fixture.runId, [200]);
  const after = (await accept(client().observe({ params, headers }), [200]))
    .body;
  expect(after.source).toStrictEqual(before.source);
  expect(after.observation).toMatchObject({
    kind: "run",
    runId: fixture.runId,
    status: "cancelled",
  });
  expect(
    (await readGetStartedStatus(context, fixture.actor)).quests.find(
      (quest) => {
        return quest.key === "workflow";
      },
    )?.claimedCount,
  ).toBe(0);
});
