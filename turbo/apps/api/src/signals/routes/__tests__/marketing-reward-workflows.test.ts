import { marketingRewardSettlementContract } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { marketingRewardSettlementRoutes } from "../marketing-reward-settlement";
import { campaignRequest } from "./helpers/marketing-reward-consumer";
import { createHash, randomUUID } from "node:crypto";
import { workflowsDetailContract } from "@okouai/api-contracts/contracts/workflows";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  marketingRewardSourceEventSchema,
  type MarketingRewardSourceEvent,
} from "../../../lib/marketing-reward-events";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { workflowsRoutes } from "../workflows";
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

function capture() {
  mockEnv(
    "MARKETING_REWARDS_EVENTS_ORIGIN",
    "https://marketing-workflows.example.test",
  );
  mockEnv(
    "MARKETING_REWARDS_EVENTS_SECRET",
    "workflow-source-service-secret-123456789",
  );
  const events: MarketingRewardSourceEvent[] = [];
  server.use(
    http.post(path, async ({ request }) => {
      const event = marketingRewardSourceEventSchema.parse(
        await request.json(),
      );
      if (event.version === 4) {
        events.push(event);
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

test("retains the creator separately from the executor and the complete lineage after Workflow deletion", async () => {
  const received = capture();
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
  await flushWaitUntilForTest();
  expect(received).toHaveLength(3);
  const facts = received;
  expect(
    facts
      .map((event) => {
        return event.type;
      })
      .sort(),
  ).toStrictEqual([
    "workflow.input-queued",
    "workflow.run-completed",
    "workflow.run-created",
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
  const queued = facts.find((event) => {
    return event.type === "workflow.input-queued";
  });
  if (!queued || queued.version !== 4) {
    throw new Error("Expected queued Workflow source");
  }
  for (const type of ["workflow.run-created", "workflow.run-completed"]) {
    expect(
      facts.find((event) => {
        return event.type === type;
      }),
    ).toMatchObject({
      runId: launched.runId,
      sourceEventId: queued.sourceEventId,
    });
  }
  expect(
    new Set(
      facts.map((event) => {
        return event.id;
      }),
    ).size,
  ).toBe(3);
  await flushWaitUntilForTest();
});

test("records event automation provenance but never certifies a failed Run or an ordinary Run that mounts a Workflow", async () => {
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
  await flushWaitUntilForTest();
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
  await flushWaitUntilForTest();
});

test("continues publishing source facts after the creator has already earned the lifetime workflow reward", async () => {
  const received = capture();
  const settlementSecret = "workflow-lifetime-settlement-12345678901234567890";
  mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", settlementSecret);
  const { actor } = await workflows.setupWorkflowOrg();
  mockEnv(
    "MARKETING_REWARDS_ROUTING",
    JSON.stringify({ mode: "cohort", userIds: [actor.userId], orgIds: [] }),
  );
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
    await flushWaitUntilForTest();
    const fact = received.find((event) => {
      return (
        event.type === "workflow.run-completed" &&
        event.runId === launched.runId
      );
    });
    if (!fact || fact.type !== "workflow.run-completed") {
      throw new Error("Expected completed owner source");
    }
    const intent = campaignRequest({
      version: 1,
      environment: fact.environment,
      policy: "get-started-v1",
      sourceEventId: fact.id,
      questKey: "workflow",
      sourceKey: fact.sourceEventId,
      rewardKey: `workflow:${fact.creatorUserId}`,
      orgId: fact.orgId,
      actorUserId: fact.userId,
      beneficiaryUserId: fact.creatorUserId,
      rewardTarget: "user",
      rewardAmount: 1000,
      completedAt: fact.occurredAt,
    });
    const result = await accept(
      setupApp({ context, routes: marketingRewardSettlementRoutes })(
        marketingRewardSettlementContract,
      ).settle({
        body: intent,
        headers: { authorization: `Bearer ${settlementSecret}` },
      }),
      [200],
    );
    expect(result.body.receipt.status).toBe(
      invocation === 0 ? "granted" : "ineligible",
    );
  }
  await flushWaitUntilForTest();
  mockEnv("MARKETING_REWARDS_ROUTING", undefined);
  expect((await readGetStartedStatus(context, actor)).quests).toContainEqual(
    expect.objectContaining({
      key: "workflow",
      claimedCount: 1,
      earnedCredits: 1000,
    }),
  );
  expect(received).toHaveLength(6);
  expect(
    received.filter((event) => {
      return event.type === "workflow.run-completed";
    }),
  ).toHaveLength(2);
});
