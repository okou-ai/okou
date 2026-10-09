import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";

const context = testContext();
const mocks = createRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const { chat } = createChatEventsFixture(context);
const runsApi = createRunsApi(context);

const WEBHOOK_ROUTES = Object.freeze([
  ...webhooksWorkflowAutomationsRoutes,
  ...workflowAutomationsRoutes,
]);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function createWebhookAutomation(workflowId: string) {
  const created = await accept(
    setupApp({ context, routes: workflowAutomationsRoutes })(
      workflowAutomationsContract,
    ).create({
      headers: authHeaders(),
      params: { workflowId },
      body: { kind: "event", eventType: "webhook-received" },
    }),
    [201],
  );
  if (
    created.body.kind !== "event" ||
    created.body.eventType !== "webhook-received" ||
    !created.body.webhookUrl ||
    !created.body.webhookSecret ||
    !created.body.chatThreadId
  ) {
    throw new Error("Expected a thread-bound webhook automation");
  }
  const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
  if (!token) {
    throw new Error("Expected webhook URL token");
  }
  return {
    threadId: created.body.chatThreadId,
    token,
    secret: created.body.webhookSecret,
  };
}

async function postWorkflowWebhook(args: {
  readonly token: string;
  readonly secret: string;
  readonly rawBody: string;
}) {
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({
    signal: context.signal,
    routes: WEBHOOK_ROUTES,
  }).request(`/api/webhooks/workflow-automations/${args.token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Okou-Timestamp": String(timestamp),
      "X-Okou-Signature": computeHmacSignature(
        args.rawBody,
        args.secret,
        timestamp,
      ),
    },
    body: args.rawBody,
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

describe("public selection of a retired model for webhook automation", () => {
  async function webhookAutomationWithSelection(model: string) {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const { actor } = await wf.setupWorkflowOrg({
      tier: "team",
      model: "claude-fable-5-1",
    });
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped workflow actor");
    }
    const agent = await wf.createAgent(actor, {
      displayName: "Retired Selection Automation Agent",
    });
    const workflowId = await wf.createWorkflow(actor, {
      agentId: agent.agentId,
      name: "retired-selection-workflow",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});
    runsApi.configureRunnerGroup();
    const webhook = await createWebhookAutomation(workflowId);
    await chat.updateThreadModelSelection(actor, webhook.threadId, model);
    await expect(
      postWorkflowWebhook({
        token: webhook.token,
        secret: webhook.secret,
        rawBody: JSON.stringify({ event: "retired-selection" }),
      }),
    ).resolves.toStrictEqual({
      status: 200,
      body: { success: true, duplicate: false },
    });
    await flushWaitUntilForTest();
    const events = await wf.readThreadEvents(webhook.threadId);
    const queued = events.find((event) => {
      return event.eventType === "input.automation";
    });
    if (!queued) {
      throw new Error("Expected the webhook delivery to enqueue an input");
    }
    const picked = events.find((event) => {
      return event.revokesEventId === queued.id;
    });
    return { actor, threadId: webhook.threadId, events, picked };
  }

  it("normalizes an explicit thread selection and runs its webhook automation on the successor", async () => {
    const { actor, threadId, picked } =
      await webhookAutomationWithSelection("claude-fable-5");
    if (picked?.runId === undefined) {
      throw new Error("Expected the automation input to launch a run");
    }
    const run = await runsApi.readRun(actor, picked.runId);
    expect(run.source.model).toBe("claude-fable-5-1");

    await expect(
      chat.readThreadMetadata(actor, threadId),
    ).resolves.toMatchObject({ selectedModel: "claude-fable-5-1" });
    const threadEvents = await chat.requestThreadEvents(actor, {}, [200]);
    if (threadEvents.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(
      threadEvents.body.events.filter((event) => {
        return (
          event.chatThreadId === threadId &&
          event.kind === "model_selection_updated"
        );
      }),
    ).toStrictEqual([
      expect.objectContaining({ selectedModel: "claude-fable-5-1" }),
    ]);
    await runsApi.requestCancelRun(actor, picked.runId, [200]);
  }, 90_000);
});
