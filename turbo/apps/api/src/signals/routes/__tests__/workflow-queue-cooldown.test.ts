import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventAutomationPart } from "./helpers/chat-event";
import { createRouteMocks } from "./helpers/route-test";
import { coolDownBuiltInRoutesThroughReports } from "./helpers/public-built-in-model-cooldown";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";

// Public callback/cooldown contracts own a private real SQL database per case.
// Concurrent fixed-Auto readers must never observe this suite's provider reports.
const TEST_APP_ROUTES = Object.freeze([
  ...testWorkflowAutomationExecutionRoutes,
  ...webhooksWorkflowAutomationsRoutes,
  ...chatEventsRoutes,
  ...chatThreadRoutes,
  ...meModelProvidersDeleteRoutes,
  ...workflowAutomationsRoutes,
]);

const context = testContext();

const api = createRunsApi(context);

const mocks = createRouteMocks(context);

const wf = createWorkflowsBddApi(context);

const runsApi = createRunsApi(context);

const chatCallbacks = createChatCallbacksApi(context);

const WORKFLOW_NAME = "workflow-queue-workflow";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

interface Scenario {
  readonly actor: ApiTestUser;
  readonly customerId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

async function setup(): Promise<Scenario> {
  const runnerGroup = runsApi.configureRunnerGroup();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const { actor, customerId } = await wf.setupWorkflowOrg({ tier: "team" });
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  // Queue ordering uses claimable native runs; Pi route tests select their
  // own model instead of inheriting this fixture's selection.
  await runsApi.ensurePersonalSubscriptionModel(actor);
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await wf.createAgent(actor, {
    displayName: "Workflow Queue Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
  });
  mocks.clerk.session(actor.userId, actor.orgId);
  chatCallbacks.acceptChatObjectStorage();
  chatCallbacks.mockChatOutputEvents([]);
  return {
    actor,
    customerId,
    orgId: actor.orgId,
    userId: actor.userId,
    agentId: agent.agentId,
    workflowId,
    runnerGroup,
  };
}

interface WebhookAutomation {
  readonly automationId: string;
  readonly threadId: string;
  readonly token: string;
  readonly secret: string;
}

async function createWebhookAutomation(
  scenario: Scenario,
): Promise<WebhookAutomation> {
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId: scenario.workflowId },
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
    throw new Error("Expected a thread-bound webhook automation with a secret");
  }
  const token = new URL(created.body.webhookUrl).pathname.split("/").at(-1);
  if (!token) {
    throw new Error("Expected webhook URL token");
  }
  return {
    automationId: created.body.id,
    threadId: created.body.chatThreadId,
    token,
    secret: created.body.webhookSecret,
  };
}

async function postWorkflowWebhook(
  automation: WebhookAutomation,
  payload: string,
  signal: AbortSignal = context.signal,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const rawBody = JSON.stringify({ event: payload });
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({ signal, routes: TEST_APP_ROUTES }).request(
    `/api/webhooks/workflow-automations/${automation.token}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Okou-Timestamp": String(timestamp),
        "X-Okou-Signature": computeHmacSignature(
          rawBody,
          automation.secret,
          timestamp,
        ),
      },
      body: rawBody,
    },
  );
  const body: unknown = await response.json();
  // The webhook enqueues and returns; the pick runs in the background.
  await flushWaitUntilForTest();
  return { status: response.status, body };
}

function expectAccepted(result: {
  readonly status: number;
  readonly body: unknown;
}): void {
  expect(result.status).toBe(200);
  expect(result.body).toStrictEqual({ success: true, duplicate: false });
}

async function workflowRunIds(threadId: string): Promise<readonly string[]> {
  const messages = await wf.readThreadEvents(threadId);
  return messages.flatMap((message) => {
    if (
      message.eventType !== "input.prompt" ||
      chatEventAutomationPart(message)?.workflowName !== WORKFLOW_NAME ||
      !message.runId
    ) {
      return [];
    }
    return [message.runId];
  });
}

describe("CHAT-02: isolated Auto cooldown callbacks", () => {
  it("rejects a workflow automation when every built-in route is unavailable", async () => {
    const scenario = await setup();
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", scenario.runnerGroup);
    // Fixed Auto is the only foreground platform route; owned key/cooldown
    // fixtures do not grant executable authority to cloned catalog metadata.
    const model = "okou-1.0";
    await seedBuiltInModelCandidateKeys(context, model);
    await api.updateUserModelPreference(scenario.actor, model);
    // The automation thread pins the preferred Built-in model.
    const automation = await createWebhookAutomation(scenario);
    // Provider failures cool down every Built-in candidate of the model.
    await coolDownBuiltInRoutesThroughReports(context, {
      actor: scenario.actor,
      agentId: scenario.agentId,
      runnerGroup: scenario.runnerGroup,
      model,
      routes: [
        { providerType: "openrouter-codex", upstreamModel: "@preset/okou-1-0" },
      ],
    });

    const response = await postWorkflowWebhook(
      automation,
      "launch without a built-in model key",
    );
    // The trigger is accepted; the launch rejection appears in the thread.
    expectAccepted(response);

    const events = await wf.readThreadEvents(automation.threadId);
    const rejected = events.find((event) => {
      return event.eventType === "input.rejected";
    });
    if (rejected?.eventType !== "input.rejected") {
      throw new Error("Expected the workflow automation to be rejected");
    }
    expect(rejected.error).toBe("model_provider_unavailable");
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "model_provider_unavailable",
      }),
    );
    await expect(workflowRunIds(automation.threadId)).resolves.toHaveLength(0);
  });
});
