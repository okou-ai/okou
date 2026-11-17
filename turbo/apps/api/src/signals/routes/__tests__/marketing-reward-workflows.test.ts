import { createHash, randomUUID } from "node:crypto";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { workflowsDetailContract } from "@okouai/api-contracts/contracts/workflows";
import { cronGetStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import {
  marketingRewardSourceEventSchema,
  type MarketingRewardSourceEvent,
} from "../../../lib/marketing-reward-events";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { workflowsRoutes } from "../workflows";
import { getStartedRoutes } from "../get-started";
import { readGetStartedStatus } from "./helpers/get-started";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createPublicAutomationRunApi } from "./helpers/public-automation-run";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const path =
  "https://marketing-workflows.example.test/api/internal/marketing/get-started/events";

function capture(lostAcknowledgement = false) {
  mockEnv("CRON_SECRET", "workflow-source-cron");
  mockEnv(
    "MARKETING_REWARDS_EVENTS_ORIGIN",
    "https://marketing-workflows.example.test",
  );
  mockEnv(
    "MARKETING_REWARDS_EVENTS_SECRET",
    "workflow-source-service-secret-123456789",
  );
  const events: MarketingRewardSourceEvent[] = [];
  let lose = lostAcknowledgement;
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      if (event.version === 4) {
        events.push(event);
        if (lose) {
          lose = false;
          return HttpResponse.error();
        }
      }
      return HttpResponse.json({
        version: 1,
        environment: event.environment,
        eventId: event.id,
        hash: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
        receivedAt: "2026-11-17T03:00:00.000Z",
      });
    }),
  );
  return events;
}

function deliver() {
  return accept(
    setupApp({ context, routes: cronProcessBackgroundJobsRoutes })(
      cronProcessBackgroundJobsContract,
    ).process({
      headers: { authorization: "Bearer workflow-source-cron" },
    }),
    [200],
  );
}

async function invoke(actor: ApiTestUser, workflowId: string) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const sent = await accept(
    setupApp({ context, routes: workflowsRoutes })(workflowsDetailContract).run(
      {
        headers: { authorization: "Bearer clerk-session" },
        params: { workflowId },
      },
    ),
    [200],
  );
  await flushWaitUntilForTest();
  const { events } = await chat.listThreadEvents(actor, sent.body.chatThreadId);
  const launched = events
    .filter((event) => {
      return event.eventType === "input.prompt" && event.runId;
    })
    .at(-1);
  if (!launched?.runId) {
    throw new Error("Expected a public Workflow Run");
  }
  return { runId: launched.runId, chatThreadId: sent.body.chatThreadId };
}

test("retains the creator separately from the executor after Workflow deletion and retries the same complete lineage", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const received = capture(true);
  const { actor } = await workflows.setupWorkflowOrg({ tier: "team" });
  const { agentId } = await workflows.createAgent(actor, {
    visibility: "public",
  });
  installWorkflowVolumeS3Fixture(context);
  const workflowId = await workflows.createWorkflow(actor, {
    agentId,
    name: `source-${randomUUID().slice(0, 8)}`,
    instruction: "Private instruction must not enter source events",
  });
  const executor = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
  await bdd.completeOnboarding(executor);
  await runs.ensurePersonalSubscriptionModel(executor, {
    model: "claude-fable-5-1",
  });
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = await runs.configureRunnerGroup();
  const launched = await invoke(executor, workflowId);
  await runs.heartbeatRunner(runnerGroup);
  const execution = await runs.executionInput(launched.runId);
  const complete = {
    runId: launched.runId,
    exitCode: 0,
    completion: {
      cliAgentType: execution.cliAgentType,
      cliAgentSessionId: `workflow-${launched.runId}`,
      cliAgentSessionHistoryDisposition: "native_only" as const,
    },
  };
  const callbacks = createWebhookCallbackApi(context);
  const authorization = { authorization: `Bearer ${execution.sandboxToken}` };
  await callbacks.requestAgentComplete(complete, authorization, [200]);
  await callbacks.requestAgentComplete(complete, authorization, [200]);
  await flushWaitUntilForTest();
  await expect(runs.readRun(executor, launched.runId)).resolves.toMatchObject({
    status: "completed",
  });
  await createMiscRoutesApi(context).deleteWorkflow(actor, workflowId, [204]);
  // Only delivery time changes; the source timestamps/provenance were committed earlier.
  mockNow(new Date("2026-01-01T00:00:00.000Z"));
  await deliver();
  await deliver();
  expect(received).toHaveLength(4);
  expect(received[1]).toStrictEqual(received[0]);
  const facts = received.slice(1);
  expect(
    facts.map((event) => {
      return event.type;
    }),
  ).toStrictEqual([
    "workflow.input-queued",
    "workflow.run-created",
    "workflow.run-completed",
  ]);
  for (const event of facts) {
    expect(event).toMatchObject({
      version: 4,
      orgId: actor.orgId,
      userId: executor.userId,
      workflowId,
      creatorUserId: actor.userId,
      sourceEventId: expect.any(String),
    });
  }
  expect(facts[1]).toMatchObject({
    runId: launched.runId,
    sourceEventId: facts[0]?.version === 4 ? facts[0].sourceEventId : undefined,
  });
  expect(facts[2]).toMatchObject({
    runId: launched.runId,
    sourceEventId: facts[0]?.version === 4 ? facts[0].sourceEventId : undefined,
  });
  expect(
    new Set(
      facts.map((event) => {
        return event.id;
      }),
    ).size,
  ).toBe(3);
  expect((await deliver()).body.processed).toBe(0);
});

test("records event automation provenance but never certifies a failed Run or an ordinary Run that mounts a Workflow", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const received = capture();
  const { actor } = await workflows.setupWorkflowOrg({ tier: "team" });
  const { agentId } = await workflows.createAgent(actor);
  installWorkflowVolumeS3Fixture(context);
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const group = await runs.configureRunnerGroup();
  const automated = await workflows.startEventAutomationRun(actor, agentId);
  const completion = createPublicAutomationRunApi(context);
  await completion.complete(actor, automated.runId, group, { exitCode: 1 });
  const ordinary = await runs.createThreadRun(actor, {
    agentId,
    prompt: "An ordinary chat with available Workflows",
  });
  await completion.complete(actor, ordinary.runId, group, {});
  await deliver();
  expect(received).toHaveLength(2);
  expect(
    received.map((event) => {
      return event.type;
    }),
  ).toStrictEqual(["workflow.input-queued", "workflow.run-created"]);
  expect(received[1]).toMatchObject({
    runId: automated.runId,
    creatorUserId: actor.userId,
  });
  expect((await deliver()).body.processed).toBe(0);
});

test("continues publishing source facts after the creator has already earned the lifetime workflow reward", async () => {
  await setupApp({
    context,
    routes: cronProcessBackgroundJobsRoutes,
    isolatePg: true,
  });
  const received = capture();
  const { actor } = await workflows.setupWorkflowOrg();
  const { agentId } = await workflows.createAgent(actor);
  installWorkflowVolumeS3Fixture(context);
  const workflowId = await workflows.createWorkflow(actor, {
    agentId,
    name: `lifetime-${randomUUID().slice(0, 8)}`,
  });
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const group = await runs.configureRunnerGroup();
  const completion = createPublicAutomationRunApi(context);
  for (let invocation = 0; invocation < 2; invocation += 1) {
    const launched = await invoke(actor, workflowId);
    await completion.complete(actor, launched.runId, group, {});
    await accept(
      setupApp({ context, routes: getStartedRoutes })(
        cronGetStartedContract,
      ).process({
        headers: { authorization: "Bearer workflow-source-cron" },
      }),
      [200],
    );
    expect((await readGetStartedStatus(context, actor)).quests).toContainEqual(
      expect.objectContaining({
        key: "workflow",
        claimedCount: 1,
        earnedCredits: 1000,
      }),
    );
  }
  await deliver();
  expect(received).toHaveLength(6);
  expect(
    received.filter((event) => {
      return event.type === "workflow.run-completed";
    }),
  ).toHaveLength(2);
});
