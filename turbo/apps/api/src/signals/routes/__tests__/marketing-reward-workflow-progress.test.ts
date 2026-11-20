import { randomUUID } from "node:crypto";
import { marketingRewardNotificationContract } from "@okouai/api-contracts/contracts/marketing-reward-notification";
import { workflowsDetailContract } from "@okouai/api-contracts/contracts/workflows";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { marketingRewardNotificationRoutes } from "../marketing-reward-notification";
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
import { captureRewardProjectionPublications } from "./helpers/reward-projection-publications";

const context = testContext();
const bdd = createBddApi(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
async function invokedWorkflow() {
  const consumer = marketingRewardConsumer();
  const { actor, defaultAgentId: agentId } = await workflows.setupWorkflowOrg({
    tier: "team",
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
  await flushWaitUntilForTest();
  const source = consumer.received.find((event) => {
    return event.type === "workflow.run-created" && event.runId === input.runId;
  });
  if (!source || source.type !== "workflow.run-created") {
    throw new Error("Expected retained Workflow source");
  }
  return {
    actor,
    executor,
    group,
    workflowId,
    runId: input.runId,
    source,
  };
}

test("refreshes the original Workflow creator from retained proof after failure and deletion without awarding credits", async () => {
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
  const publications = captureRewardProjectionPublications(context);
  const progressSecret =
    "workflow-progress-projection-1234567890123456789012345";
  mockEnv("MARKETING_REWARDS_PROJECTION_SECRET", progressSecret);
  await accept(
    setupApp({ context, routes: marketingRewardNotificationRoutes })(
      marketingRewardNotificationContract,
    ).notify({
      headers: { authorization: `Bearer ${progressSecret}` },
      body: {
        kind: "progress",
        version: 1,
        environment: "development",
        source: { kind: "event", eventId: fixture.source.id },
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  expect(publications).toStrictEqual([
    {
      channel: `user:${fixture.actor.userId}`,
      name: "getStartedRewardsChanged",
    },
  ]);
});
