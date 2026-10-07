import { createHash, randomUUID } from "node:crypto";
import {
  scopedReviewContract,
  scopedReviewRoutes,
} from "../test-get-started-rewards";
import { readGetStartedStatus } from "./helpers/get-started";

import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  workflowAutomationsContract,
  type WorkflowSchedule,
} from "@okouai/api-contracts/contracts/workflows";
import { createStore } from "ccstate";
import { readWorkflowScheduleSkipsFixture } from "../../../test-fixtures/workflow-schedule-expiry";
import { makeCodexAuthJson, makeCodexJwt } from "./helpers/api-bdd-auth-device";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";

import {
  executeWorkflowAutomationForTest,
  executeDueWorkflowAutomationsForWorkflowForTest,
} from "../../../test-fixtures/workflow-automation-workers";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { agentsRoutes } from "../agents";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import {
  chatEventAutomationPart,
  chatEventDisplayText,
} from "./helpers/chat-event";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { seedBuiltInModelKey } from "./helpers/runtime-state";

const TEST_APP_ROUTES = Object.freeze([
  ...agentsRoutes,
  ...workflowAutomationsRoutes,
  ...workflowsRoutes,
]);

const context = testContext();
const api = createRunsApi(context);
const store = createStore();
const mocks = createRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const runReadsApi = createRunReadsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const chatFilesApi = createChatFilesBddApi(context);
const computerUseApi = createComputerUseBddApi(context);

const WORKFLOW_NAME = "scheduler-workflow";
const WORKFLOW_DISPLAY_NAME = "Scheduler Workflow";

interface Scenario {
  readonly actor: ApiTestUser;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

function okouTokenFromClaim(
  claim: Awaited<ReturnType<typeof runsApi.claimRunnerJob>>,
): string {
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token || !token.startsWith("vm0_sandbox_")) {
    throw new Error(
      "Expected the claim platform environment to carry an OKOU_TOKEN",
    );
  }
  return token;
}

async function setup(
  options: {
    readonly timezone?: string;
    readonly tier?: "pro" | "team";
    readonly workflowDisplayName?: string;
  } = {},
): Promise<Scenario> {
  const runnerGroup = runsApi.configureRunnerGroup();
  const { actor, customerId, subscriptionId } = await wf.setupWorkflowOrg({
    timezone: options.timezone,
    tier: options.tier,
  });
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  // Scheduler scenarios that claim and complete a Runner job select a native
  // model; explicit Pi cases select their own model below.
  await runsApi.ensurePersonalSubscriptionModel(actor);
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await wf.createAgent(actor, {
    displayName: "Scheduler Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
    ...(options.workflowDisplayName === undefined
      ? {}
      : { displayName: options.workflowDisplayName }),
  });
  mocks.clerk.session(actor.userId, actor.orgId);
  context.mocks.s3.send.mockResolvedValue({});
  return {
    actor,
    customerId,
    subscriptionId,
    orgId: actor.orgId,
    userId: actor.userId,
    agentId: agent.agentId,
    workflowId,
    runnerGroup,
  };
}

interface CreatedAutomation {
  readonly automationId: string;
  readonly nextRunAt: string | null;
}

/** Loop automations are due immediately on creation. */
async function createDueLoopAutomation(
  scenario: Scenario,
  intervalSeconds: number,
): Promise<CreatedAutomation> {
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId: scenario.workflowId },
      body: { schedule: { type: "loop", intervalSeconds } },
    }),
    [201],
  );
  expect(created.body.chatThreadId).toBeNull();
  return {
    automationId: created.body.id,
    nextRunAt: created.body.nextRunAt,
  };
}

async function disableAutomation(automationId: string): Promise<void> {
  await accept(
    automationsClient().disable({
      headers: authHeaders(),
      params: { id: automationId },
    }),
    [200],
  );
}

async function executeDueWorkflowAutomations(
  automationId: string,
): Promise<string> {
  await executeWorkflowAutomationForTest({ automationId }, context.signal);
  // The tick only enqueues; its background pick finishes before this returns.
  await flushWaitUntilForTest();
  const automation = await wf.readAutomation(automationId);
  if (!automation.chatThreadId) {
    throw new Error("Expected execution to bind a chat thread");
  }
  return automation.chatThreadId;
}

interface WorkflowRunMessage {
  readonly runId: string;
  readonly triggerBrief: string | null | undefined;
  readonly workflowId: string | undefined;
  readonly workflowName: string;
}

/**
 * Workflow-automation fires post a `/workflow-name` user message with the run id
 * into the bound thread; this is the public read for "runs of this automation".
 */
async function workflowRunMessages(
  threadId: string,
): Promise<readonly WorkflowRunMessage[]> {
  const messages = await wf.readThreadEvents(threadId);
  return messages.flatMap((message) => {
    const automationPart = chatEventAutomationPart(message);
    if (
      message.eventType !== "input.prompt" ||
      automationPart?.workflowName !== WORKFLOW_NAME ||
      !message.runId
    ) {
      return [];
    }
    return [
      {
        runId: message.runId,
        triggerBrief: automationPart.automationBrief,
        workflowId: automationPart.workflowId,
        workflowName: automationPart.workflowName,
      },
    ];
  });
}

async function onlyWorkflowRunMessage(
  threadId: string,
): Promise<WorkflowRunMessage> {
  const messages = await workflowRunMessages(threadId);
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

async function onlyWorkflowDisplayText(
  threadId: string,
): Promise<string | null> {
  const messages = await wf.readThreadEvents(threadId);
  const workflowMessages = messages.filter((message) => {
    return (
      message.eventType === "input.prompt" &&
      chatEventAutomationPart(message)?.workflowName === WORKFLOW_NAME
    );
  });
  expect(workflowMessages).toHaveLength(1);
  return chatEventDisplayText(workflowMessages[0]!);
}

async function completeRunThroughSandbox(
  scenario: Scenario,
  runId: string,
  exitCode: number,
  failureReason?: "insufficient_credits",
): Promise<void> {
  await runsApi.heartbeatRunner(scenario.runnerGroup);
  const claim = await runsApi.claimRunnerJob(runId);
  const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooksApi.requestAgentComplete(
    {
      runId,
      exitCode,
      ...(failureReason
        ? {
            failureReason,
            error: "Insufficient credits. Add credits to continue.",
          }
        : {}),
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `workflow-automation-cli-${runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`workflow automation history ${runId}`)
          .digest("hex"),
      },
    },
    sandboxHeaders,
    [200],
  );
}

async function deleteWorkflowViaApi(scenario: Scenario): Promise<void> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(`/api/workflows/${scenario.workflowId}`, {
    method: "DELETE",
    headers: { authorization: "Bearer clerk-session" },
  });
  await expectOk(response, "delete workflow");
}

describe("okou workflow automation scheduler", () => {
  it("executes only the selected due automation", async () => {
    const scenario = await setup();
    const selected = await createDueLoopAutomation(scenario, 3600);
    const unselected = await createDueLoopAutomation(scenario, 3600);

    const threadId = await executeDueWorkflowAutomations(selected.automationId);

    await expect(workflowRunMessages(threadId)).resolves.toHaveLength(1);
    const untouched = await wf.readAutomation(unselected.automationId);
    expect(untouched.lastRunAt).toBeNull();
    expect(untouched.nextRunAt).toBe(unselected.nextRunAt);
    await disableAutomation(selected.automationId);
    await disableAutomation(unselected.automationId);
  });

  it("uses the workflow display name in automation messages", async () => {
    const scenario = await setup({
      workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    });
    const automation = await createDueLoopAutomation(scenario, 3600);

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );
    const messages = await wf.readThreadEvents(threadId);
    const runMessage = messages.find((message) => {
      return (
        message.eventType === "input.prompt" &&
        chatEventAutomationPart(message)?.workflowId === scenario.workflowId
      );
    });

    expect(runMessage).toBeDefined();
    if (!runMessage) {
      throw new Error("Expected an automation run message");
    }
    expect(chatEventAutomationPart(runMessage)?.workflowName).toBe(
      WORKFLOW_DISPLAY_NAME,
    );
    await disableAutomation(automation.automationId);
  });

  it("inherits the chat thread computer-use grant for automation runs", async () => {
    const scenario = await setup({ tier: "team" });
    const automation = await createDueLoopAutomation(scenario, 3600);
    const seed = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    if (!seed.body.chatThreadId) {
      throw new Error("Expected the event automation to bind a chat thread");
    }
    const threadId = seed.body.chatThreadId;
    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: seed.body.id },
      }),
      [204],
    );
    const host = await computerUseApi.startComputerUseHost(scenario.actor, {
      hostName: "Automation Desktop",
    });
    await chatFilesApi.updateThreadComputerUseHost(
      scenario.actor,
      threadId,
      host.hostId,
    );

    await expect(
      executeDueWorkflowAutomations(automation.automationId),
    ).resolves.toBe(threadId);

    const run = await onlyWorkflowRunMessage(threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    await computerUseApi.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(claim) },
      [200],
    );
    const createdRun = await runsApi.readRun(scenario.actor, run.runId);
    expect(createdRun.appendSystemPrompt).toContain(
      "Computer Use is enabled for this run on Automation Desktop.",
    );
    await disableAutomation(automation.automationId);
  });

  it("returns actionable authorization guidance when an automation has no computer-use grant", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 3600);

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );

    const run = await onlyWorkflowRunMessage(threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    const denied = await computerUseApi.requestCreateComputerUseWriteCommand(
      { bearer: okouTokenFromClaim(claim) },
      [403],
    );
    expect(denied.body).toMatchObject({
      error: {
        message:
          "Computer Use is not authorized for this run. Authorize a computer once in the conversation, then retry.",
      },
    });
    await disableAutomation(automation.automationId);
  });

  it("uses agent connector authorization and permission grants for automation runs", async () => {
    const scenario = await setup();

    // A real Gmail connection plus the public agent-connector and permission
    // grant routes, so the gmail firewall is built into the manifest.
    mockGmailConnectorOAuth({ email: "automation-user@example.com" });
    await wf.connectConnector(scenario.actor, "gmail");
    await accept(
      setupApp({ context, routes: agentsRoutes })(
        userBuiltinConnectorsContract,
      ).update({
        headers: authHeaders(),
        params: { id: scenario.agentId },
        body: { enabledConnectorSlugs: ["gmail"] },
      }),
      [200],
    );
    await runsApi.applyUserPermissionGrant(scenario.actor, {
      agentId: scenario.agentId,
      connectorSlug: "gmail",
      permission: "messages.write",
      action: "allow",
    });
    mocks.clerk.session(scenario.userId, scenario.orgId);

    const automation = await createDueLoopAutomation(scenario, 60);

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );

    const run = await onlyWorkflowRunMessage(threadId);
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.runId);
    expect(claim.networkPolicies?.gmail?.allow ?? []).toContain(
      "messages.write",
    );
    await disableAutomation(automation.automationId);
  });

  it("fires a due cron automation: creates a run, posts to the thread, sets last run state", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    expect(created.body.chatThreadId).toBeNull();
    if (!created.body.nextRunAt) {
      throw new Error("Expected a cron automation with a next run");
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    const threadId = await executeDueWorkflowAutomations(created.body.id);

    const run = await onlyWorkflowRunMessage(threadId);
    const logs = await runReadsApi.requestListLogs(scenario.actor, {}, [200]);
    expect(logs.body.data).toContainEqual(
      expect.objectContaining({
        id: run.runId,
        triggerSource: "automation-schedule",
      }),
    );
    await expect(onlyWorkflowDisplayText(threadId)).resolves.toBe(
      "This workflow started on schedule.",
    );

    const automation = await wf.readAutomation(created.body.id);
    expect(automation.nextRunAt).toBeNull();
    expect(typeof automation.lastRunAt).toBe("string");
  });

  it("disables a one-time automation when it fires", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          schedule: {
            type: "once",
            atTime: new Date(now() + 90_000).toISOString(),
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    expect(created.body.chatThreadId).toBeNull();
    if (!created.body.nextRunAt) {
      throw new Error("Expected a one-time automation with a next run");
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    const threadId = await executeDueWorkflowAutomations(created.body.id);

    const onceRun = await onlyWorkflowRunMessage(threadId);
    const automation = await wf.readAutomation(created.body.id);
    expect(automation.enabled).toBeFalsy();
    expect(automation.nextRunAt).toBeNull();

    await expect(onlyWorkflowDisplayText(threadId)).resolves.toBe(
      "The one-time scheduled run started.",
    );
    await completeRunThroughSandbox(scenario, onceRun.runId, 0);
    await flushWaitUntilForTest();
    await expect(wf.readAutomation(created.body.id)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
  });

  it("audits and disables an expired unclaimed one-time schedule without starting a Run", async () => {
    mockEnv("WORKFLOW_SCHEDULE_EXPIRY_ENABLED", "true");
    const scenario = await setup();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          schedule: {
            type: "once",
            atTime: new Date(now() + 90_000).toISOString(),
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    if (!created.body.nextRunAt) {
      throw new Error("Missing one-time anchor");
    }
    mockNow(Date.parse(created.body.nextRunAt) + 30 * 60_000 + 1);
    const response = await executeWorkflowAutomationForTest(
      { automationId: created.body.id },
      context.signal,
    );
    expect(response).toMatchObject({ executed: 0, skipped: 1 });
    const after = await wf.readAutomation(created.body.id);
    expect(after.enabled).toBeFalsy();
    expect(after.nextRunAt).toBeNull();
    expect(after.lastRunAt).toBeNull();
    expect(after.chatThreadId).toBeNull();
    await expect(
      readWorkflowScheduleSkipsFixture(created.body.id),
    ).resolves.toMatchObject([
      { scheduledAnchorAt: new Date(created.body.nextRunAt) },
    ]);
  });

  it("fires fresh work in a workflow-scoped poll behind 201 expired anchors", async () => {
    mockEnv("WORKFLOW_SCHEDULE_EXPIRY_ENABLED", "true");
    const scenario = await setup();
    // Create historical due slots through the production API rather than
    // writing scheduler rows or asserting directly on its candidate query.
    for (let created = 0; created < 201; created += 10) {
      await Promise.all(
        Array.from({ length: Math.min(10, 201 - created) }, async () => {
          await createDueLoopAutomation(scenario, 900);
        }),
      );
    }
    mockNow(now() + 60 * 60_000);
    const fresh = await createDueLoopAutomation(scenario, 900);
    const tick = await executeDueWorkflowAutomationsForWorkflowForTest(
      scenario.workflowId,
      context.signal,
    );
    expect(tick).toMatchObject({ executed: 1, skipped: 35 });
    await flushWaitUntilForTest();
    const after = await wf.readAutomation(fresh.automationId);
    if (!after.chatThreadId) {
      throw new Error("Fresh automation did not start");
    }
    await expect(workflowRunMessages(after.chatThreadId)).resolves.toHaveLength(
      1,
    );
    await disableAutomation(fresh.automationId);
    await deleteWorkflowViaApi(scenario);
  }, 90_000);

  it("admits an unclaimed recurring schedule at exactly thirty minutes late", async () => {
    mockEnv("WORKFLOW_SCHEDULE_EXPIRY_ENABLED", "true");
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 900);
    if (!automation.nextRunAt) {
      throw new Error("Missing loop anchor");
    }
    mockNow(Date.parse(automation.nextRunAt) + 30 * 60_000);

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );
    await expect(workflowRunMessages(threadId)).resolves.toHaveLength(1);
    await disableAutomation(automation.automationId);
  });

  it("skips a recurring occurrence past thirty minutes without making a Run or disabling its schedule", async () => {
    mockEnv("WORKFLOW_SCHEDULE_EXPIRY_ENABLED", "true");
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 900);
    if (!automation.nextRunAt) {
      throw new Error("Missing loop anchor");
    }
    const at = Date.parse(automation.nextRunAt) + 30 * 60_000 + 1;
    mockNow(at);

    const first = await executeWorkflowAutomationForTest(
      { automationId: automation.automationId },
      context.signal,
    );
    expect(first).toMatchObject({ executed: 0, skipped: 1 });
    const afterSkip = await wf.readAutomation(automation.automationId);
    expect(afterSkip.enabled).toBeTruthy();
    expect(afterSkip.lastRunAt).toBeNull();
    expect(afterSkip.chatThreadId).toBeNull();
    expect(afterSkip.nextRunAt).toBe(new Date(at + 900_000).toISOString());
    await expect(
      readWorkflowScheduleSkipsFixture(automation.automationId),
    ).resolves.toMatchObject([
      { scheduledAnchorAt: new Date(automation.nextRunAt) },
    ]);

    const repeated = await executeWorkflowAutomationForTest(
      { automationId: automation.automationId },
      context.signal,
    );
    expect(repeated).toMatchObject({ executed: 0, skipped: 0 });
    await expect(
      readWorkflowScheduleSkipsFixture(automation.automationId),
    ).resolves.toHaveLength(1);
    await disableAutomation(automation.automationId);
  });

  it("fires a due loop automation with a user-facing message", async () => {
    const scenario = await setup({ timezone: "Asia/Shanghai" });
    const automation = await createDueLoopAutomation(scenario, 3600);

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );

    await expect(onlyWorkflowDisplayText(threadId)).resolves.toBe(
      "The next recurring run started.",
    );
    await disableAutomation(automation.automationId);
  });

  it.each([false, true])(
    "uses the second member automation owner's subscription and retains it from run creation (queued: %s)",
    async (queuedLaunch) => {
      const scenario = await setup();
      const misc = createMiscRoutesApi(context);
      const connectOwner = async (actor: ApiTestUser, identity: string) => {
        const token = makeCodexJwt({
          exp: Math.floor(now() / 1000) + 7200,
          identity,
          nonce: randomUUID(),
        });
        const connected = await misc.upsertPersonalModelProvider(
          actor,
          {
            type: "codex-oauth-token",
            authMethod: "auth_json",
            secrets: {
              CODEX_AUTH_JSON: makeCodexAuthJson({
                accessToken: token,
                accountId: identity,
                refreshToken: `refresh-${identity}`,
              }),
            },
          },
          [200, 201],
        );
        if (connected.status !== 200 && connected.status !== 201) {
          throw new Error("Expected connected owner");
        }
        return { token, accountId: connected.body.provider.id };
      };
      await connectOwner(scenario.actor, "agent-author");
      const blockers: string[] = [];
      if (queuedLaunch) {
        // Two blockers keep the scheduler launch queued, independent of the
        // plan's own concurrency limit.
        mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
        for (let index = 0; index < 2; index += 1) {
          const started = await chatFilesApi.requestSendEvent(
            scenario.actor,
            {
              agentId: scenario.agentId,
              model: "gpt-6-astra",
              prompt: `Occupy organization concurrency ${index}`,
            },
            [201],
          );
          if (started.status !== 201) {
            throw new Error("Expected an accepted concurrency blocker");
          }
          // The send only enqueues; its background pick launches the run.
          await flushWaitUntilForTest();
          const blocker = (
            await wf.readThreadEvents(started.body.threadId)
          ).find((event) => {
            return event.eventType === "input.prompt" && event.runId;
          })?.runId;
          if (!blocker) {
            throw new Error("Expected an admitted concurrency blocker");
          }
          blockers.push(blocker);
        }
      }
      const member = wf.user({
        userId: `user_${randomUUID()}`,
        orgId: scenario.orgId,
        orgRole: "org:member",
      });
      await createBddApi(context).completeOnboarding(member);
      // The same membership cache fixture and real CLI read used by the scheduler's access test.
      await store.set(
        seedOrgMembership$,
        { orgId: scenario.orgId, userId: member.userId, role: "member" },
        context.signal,
      );
      const apiKey = await runsApi.createCliToken(member);
      await accept(
        setupApp({ context, routes: agentsRoutes })(agentsMainContract).list({
          headers: { authorization: `Bearer ${apiKey.token}` },
        }),
        [200],
      );
      const owner = await connectOwner(member, "automation-owner");
      // The automation thread starts from the owner's own model preference.
      await chatFilesApi.updateUserModelPreference(member, "gpt-6-astra");
      mocks.clerk.session(member.userId, scenario.orgId, "org:member");
      const created = await createDueLoopAutomation(scenario, 3600);
      // Scheduler execution is unauthenticated infrastructure; the owner is the member above.
      mocks.clerk.session(scenario.userId, scenario.orgId);
      const threadId = await executeDueWorkflowAutomations(
        created.automationId,
      );
      mocks.clerk.session(member.userId, scenario.orgId, "org:member");
      // At capacity the scheduler input stays queued in the thread and no run
      // exists until a released slot picks the thread.
      await expect(workflowRunMessages(threadId)).resolves.toHaveLength(
        queuedLaunch ? 0 : 1,
      );
      const later = await connectOwner(member, "later-owner-account");
      for (const blocker of blockers) {
        await runsApi.requestCancelRun(scenario.actor, blocker, [200]);
      }
      mocks.clerk.session(member.userId, scenario.orgId, "org:member");
      // Slot release schedules the next pick. Own that work before checking
      // the account captured by the newly admitted automation run.
      await flushWaitUntilForTest();
      await expect(workflowRunMessages(threadId)).resolves.toHaveLength(1);
      const message = await onlyWorkflowRunMessage(threadId);
      // The run binds the owner's account current at run creation: the
      // original account for an immediate launch, the later one for a pick.
      const expectedOwner = queuedLaunch
        ? { ...later, identity: "later-owner-account" }
        : { ...owner, identity: "automation-owner" };
      const pendingRun = await runsApi.readRun(member, message.runId);
      expect(pendingRun).toMatchObject({
        status: "pending",
        source: {
          providerType: "codex-oauth-token",
          credentialScope: "member",
        },
      });
      // An immediate run retains the replaced account's credentials, but the
      // public source hides that now-disconnected account. A queued run binds
      // the still-connected replacement when its slot is released.
      expect(pendingRun.source?.account).toStrictEqual(
        queuedLaunch
          ? { status: "connected", id: expectedOwner.accountId }
          : { status: "unavailable" },
      );
      await runsApi.heartbeatRunner(scenario.runnerGroup);
      const claim = await runsApi.claimRunnerJob(message.runId);
      expect(claim.cliAgentType).toBe("codex");
      expect(claim.billableFirewalls).toStrictEqual([]);
      expect(
        claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN?.sourceId,
      ).toBe(expectedOwner.accountId);
      if (!claim.encryptedSecrets) {
        throw new Error("Expected subscription envelope");
      }
      const resolved = await createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${claim.sandboxToken}` },
        {
          encryptedSecrets: claim.encryptedSecrets,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
            "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID"),
          },
          secretConnectorMap: claim.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            claim.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      expect(resolved.body).toMatchObject({
        headers: {
          Authorization: `Bearer ${expectedOwner.token}`,
          "ChatGPT-Account-ID": expectedOwner.identity,
        },
      });
      mocks.clerk.session(member.userId, scenario.orgId, "org:member");
      await disableAutomation(created.automationId);
      await runsApi.requestCancelRun(member, message.runId, [200]);
    },
  );

  it("skips a due automation when the owner can no longer read the agent", async () => {
    const scenario = await setup();

    // A second org member owns the automation on the public workflow. The member
    // becomes visible to the scheduler through a CLI-token request, which
    // caches the org membership the poller checks.
    const member = wf.user({
      userId: `user_${randomUUID()}`,
      orgId: scenario.orgId,
      orgRole: "org:member",
    });
    await store.set(
      seedOrgMembership$,
      { orgId: scenario.orgId, userId: member.userId, role: "member" },
      context.signal,
    );
    mocks.clerk.session(member.userId, scenario.orgId, "org:member");
    const apiKey = await runsApi.createCliToken(member);
    await accept(
      setupApp({ context, routes: agentsRoutes })(agentsMainContract).list({
        headers: { authorization: `Bearer ${apiKey.token}` },
      }),
      [200],
    );

    mocks.clerk.session(member.userId, scenario.orgId, "org:member");
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 300 } },
      }),
      [201],
    );
    expect(created.body.chatThreadId).toBeNull();
    if (!created.body.nextRunAt) {
      throw new Error("Expected a loop automation with a next run");
    }

    // The agent owner flips the agent private, hiding it from the member.
    mocks.clerk.session(scenario.userId, scenario.orgId);
    await accept(
      setupApp({ context, routes: agentsRoutes })(
        agentsByIdContract,
      ).updateMetadata({
        headers: authHeaders(),
        params: { id: scenario.agentId },
        body: { visibility: "private" },
      }),
      [200],
    );

    await executeWorkflowAutomationForTest(
      { automationId: created.body.id },
      context.signal,
    );

    // Restore visibility so the member's product reads work again; the skip
    // already happened during the tick above.
    await accept(
      setupApp({ context, routes: agentsRoutes })(
        agentsByIdContract,
      ).updateMetadata({
        headers: authHeaders(),
        params: { id: scenario.agentId },
        body: { visibility: "public" },
      }),
      [200],
    );

    // The member's due automation was skipped without being disabled or fired.
    mocks.clerk.session(member.userId, scenario.orgId, "org:member");
    const read = await wf.readAutomation(created.body.id);
    expect(read.enabled).toBeTruthy();
    expect(read.nextRunAt).toBe(created.body.nextRunAt);
    expect(read.lastRunAt).toBeNull();
    expect(read.chatThreadId).toBeNull();

    await disableAutomation(created.body.id);
    mocks.clerk.session(scenario.userId, scenario.orgId);
  });

  it("advances a cron automation from a canonical-only callback", async () => {
    const scenario = await setup();
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    expect(created.body.chatThreadId).toBeNull();
    if (!created.body.nextRunAt) {
      throw new Error("Expected a cron automation with a next run");
    }

    mockNow(Date.parse(created.body.nextRunAt) + 60_000);
    const expectedNextRunAt = new Date(
      Date.parse(created.body.nextRunAt) + 86_400_000,
    ).toISOString();
    const threadId = await executeDueWorkflowAutomations(created.body.id);
    const run = await onlyWorkflowRunMessage(threadId);
    expect(run).toMatchObject({
      workflowId: scenario.workflowId,
      workflowName: WORKFLOW_NAME,
      triggerBrief: expect.any(String),
    });
    await completeRunThroughSandbox(scenario, run.runId, 0);

    await flushWaitUntilForTest();
    const automation = await wf.readAutomation(created.body.id);
    expect(automation.enabled).toBeTruthy();
    expect(automation.nextRunAt).toBe(expectedNextRunAt);
  });

  it("reschedules a loop automation from a canonical-only callback", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 300);

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );
    const before = now();
    const run = await onlyWorkflowRunMessage(threadId);
    expect(run).toMatchObject({
      workflowId: scenario.workflowId,
      workflowName: WORKFLOW_NAME,
      triggerBrief: expect.any(String),
    });
    await completeRunThroughSandbox(scenario, run.runId, 0);

    await flushWaitUntilForTest();
    await expect(
      (async () => {
        return (await wf.readAutomation(automation.automationId)).nextRunAt;
      })(),
    ).resolves.not.toBeNull();
    const read = await wf.readAutomation(automation.automationId);
    if (!read.nextRunAt) {
      throw new Error("Expected the loop automation to be rescheduled");
    }
    expect(Date.parse(read.nextRunAt)).toBeGreaterThanOrEqual(before + 290_000);
    await disableAutomation(automation.automationId);
  });

  it.each([
    {
      change: "cron time and timezone",
      originalSchedule: {
        type: "cron",
        cronExpression: "30 9 * * 1-5",
        timezone: "Asia/Shanghai",
      },
      updatedSchedule: {
        type: "cron",
        cronExpression: "0 1 * * 1-5",
        timezone: "UTC",
      },
      expectedNextRunAt: "2026-09-09T01:00:00.000Z",
    },
    {
      change: "cron to loop",
      originalSchedule: {
        type: "cron",
        cronExpression: "30 9 * * 1-5",
        timezone: "Asia/Shanghai",
      },
      updatedSchedule: { type: "loop", intervalSeconds: 3600 },
      expectedNextRunAt: "2026-09-08T03:35:10.634Z",
    },
    {
      change: "loop to cron",
      originalSchedule: { type: "loop", intervalSeconds: 300 },
      updatedSchedule: {
        type: "cron",
        cronExpression: "0 1 * * 1-5",
        timezone: "UTC",
      },
      expectedNextRunAt: "2026-09-09T01:00:00.000Z",
    },
    {
      change: "cron to once",
      originalSchedule: {
        type: "cron",
        cronExpression: "30 9 * * 1-5",
        timezone: "Asia/Shanghai",
      },
      updatedSchedule: {
        type: "once",
        atTime: "2026-09-08T04:00:00.000Z",
        timezone: "UTC",
      },
      expectedNextRunAt: "2026-09-08T04:00:00.000Z",
    },
  ] satisfies {
    readonly change: string;
    readonly originalSchedule: WorkflowSchedule;
    readonly updatedSchedule: WorkflowSchedule;
    readonly expectedNextRunAt: string;
  }[])(
    "uses the current schedule after an in-flight $change edit",
    async ({ originalSchedule, updatedSchedule, expectedNextRunAt }) => {
      mockNow(Date.parse("2026-09-08T01:29:00.000Z"));
      const scenario = await setup({ timezone: "Asia/Shanghai" });
      const created = await accept(
        automationsClient().create({
          headers: authHeaders(),
          params: { workflowId: scenario.workflowId },
          body: { schedule: originalSchedule },
        }),
        [201],
      );

      mockNow(Date.parse("2026-09-08T01:30:50.668Z"));
      const threadId = await executeDueWorkflowAutomations(created.body.id);
      const run = await onlyWorkflowRunMessage(threadId);

      mockNow(Date.parse("2026-09-08T02:24:37.180Z"));
      const updated = await accept(
        automationsClient().update({
          headers: authHeaders(),
          params: { id: created.body.id },
          body: { schedule: updatedSchedule },
        }),
        [200],
      );
      expect(updated.body.schedule).toStrictEqual(updatedSchedule);

      mockNow(Date.parse("2026-09-08T02:35:10.634Z"));
      await completeRunThroughSandbox(scenario, run.runId, 0);
      // Own the completion and its callbacks before reading the edited schedule.
      await flushWaitUntilForTest();
      await expect(
        runsApi.readRun(scenario.actor, run.runId),
      ).resolves.toMatchObject({ status: "completed" });
      await expect(wf.readAutomation(created.body.id)).resolves.toMatchObject({
        schedule: updatedSchedule,
        enabled: true,
        nextRunAt: expectedNextRunAt,
      });
      await disableAutomation(created.body.id);
    },
  );

  it("disables every workflow automation bound to a deleted chat thread", async () => {
    const scenario = await setup();
    const first = await createDueLoopAutomation(scenario, 60);
    const second = await createDueLoopAutomation(scenario, 120);
    const firstThreadId = await executeDueWorkflowAutomations(
      first.automationId,
    );
    await expect(wf.readAutomation(second.automationId)).resolves.toMatchObject(
      {
        chatThreadId: firstThreadId,
      },
    );

    await chatFilesApi.deleteThread(scenario.actor, firstThreadId);
    await expect(wf.readAutomation(first.automationId)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
      chatThreadId: null,
    });
    await expect(wf.readAutomation(second.automationId)).resolves.toMatchObject(
      {
        enabled: false,
        nextRunAt: null,
        chatThreadId: null,
      },
    );

    // The workflow remains reusable after deleting its automation thread.
    const replacement = await createDueLoopAutomation(scenario, 300);
    const replacementThreadId = await executeDueWorkflowAutomations(
      replacement.automationId,
    );
    expect(replacementThreadId).not.toBe(firstThreadId);
    await disableAutomation(replacement.automationId);
  });

  it.each(["loop", "cron"] as const)(
    "keeps a credit-blocked %s automation enabled and resumes after billing recovers",
    async (scheduleType) => {
      const scenario = await setup();
      await seedBuiltInModelKey(context, "okou-1.0");
      await api.updateUserModelPreference(scenario.actor, null);
      const created = await accept(
        automationsClient().create({
          headers: authHeaders(),
          params: { workflowId: scenario.workflowId },
          body: {
            schedule:
              scheduleType === "loop"
                ? { type: "loop", intervalSeconds: 300 }
                : {
                    type: "cron",
                    cronExpression: "*/5 * * * *",
                    timezone: "UTC",
                  },
          },
        }),
        [201],
      );
      // Let the paid entitlement expire through the production time boundary.
      mockNow(now() + 100 * 86_400_000);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const threadId = await executeDueWorkflowAutomations(created.body.id);
        await expect(workflowRunMessages(threadId)).resolves.toHaveLength(0);
        // The pick rejects each tick in the thread instead of the poll.
        const rejections = (await wf.readThreadEvents(threadId)).filter(
          (event) => {
            return (
              event.eventType === "input.rejected" &&
              event.error === "insufficient_credits"
            );
          },
        );
        expect(rejections).toHaveLength(attempt + 1);
        const automation = await wf.readAutomation(created.body.id);
        expect(automation.enabled).toBeTruthy();
        if (!automation.nextRunAt) {
          throw new Error("Expected a credit-blocked automation to recur");
        }
        expect(Date.parse(automation.nextRunAt)).toBeGreaterThan(now());
        mockNow(Date.parse(automation.nextRunAt));
      }

      await runsApi.grantProEntitlement(scenario.actor, {
        customerId: scenario.customerId,
        subscriptionId: scenario.subscriptionId,
      });
      const threadId = await executeDueWorkflowAutomations(created.body.id);
      const run = await onlyWorkflowRunMessage(threadId);
      expect((await wf.readAutomation(created.body.id)).enabled).toBeTruthy();
      await runsApi.requestCancelRun(scenario.actor, run.runId, [200]);
      await disableAutomation(created.body.id);
    },
  );

  it("keeps recurring after three runs stop for insufficient credits", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 300);
    const seenRunIds = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const threadId = await executeDueWorkflowAutomations(
        automation.automationId,
      );
      const run = (await workflowRunMessages(threadId)).find((message) => {
        return !seenRunIds.has(message.runId);
      });
      if (!run) {
        throw new Error("Expected a new scheduled run");
      }
      seenRunIds.add(run.runId);
      await completeRunThroughSandbox(
        scenario,
        run.runId,
        1,
        "insufficient_credits",
      );
      // The completion reschedules the loop in background work; drain it
      // instead of polling on wall-clock intervals.
      await flushWaitUntilForTest();
      const read = await wf.readAutomation(automation.automationId);
      expect({
        enabled: read.enabled,
        nextRunAt: read.nextRunAt,
      }).toStrictEqual({ enabled: true, nextRunAt: expect.any(String) });
      if (!read.nextRunAt) {
        throw new Error("Expected the next run after insufficient credits");
      }
      mockNow(Date.parse(read.nextRunAt));
    }

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );
    const messages = await workflowRunMessages(threadId);
    expect(messages).toHaveLength(4);
    const recovered = messages.find((message) => {
      return !seenRunIds.has(message.runId);
    });
    if (!recovered) {
      throw new Error("Expected the automation to recover on its next run");
    }
    await completeRunThroughSandbox(scenario, recovered.runId, 0);
    await disableAutomation(automation.automationId);
  });

  it("auto-disables an automation after three consecutive failures", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 300);
    const base = now();
    const seenRunIds = new Set<string>();

    // Three fire + failed-completion cycles through scoped execution, runner,
    // and sandbox completion surfaces auto-disable the automation.
    const fireAndFailNextRun = async (): Promise<string> => {
      const currentThreadId = await executeDueWorkflowAutomations(
        automation.automationId,
      );
      const messages = await workflowRunMessages(currentThreadId);
      const nextRun = messages.find((message) => {
        return !seenRunIds.has(message.runId);
      });
      if (!nextRun) {
        throw new Error("Expected the next fire to post a run message");
      }
      seenRunIds.add(nextRun.runId);
      await completeRunThroughSandbox(scenario, nextRun.runId, 1);
      return currentThreadId;
    };
    const readFailureState = async () => {
      const read = await wf.readAutomation(automation.automationId);
      return {
        enabled: read.enabled,
        nextRunAt: read.nextRunAt,
        nextRunAtIsFuture:
          read.nextRunAt !== null && Date.parse(read.nextRunAt) > now(),
      };
    };

    const firstThreadId = await fireAndFailNextRun();
    await flushWaitUntilForTest();
    await expect(readFailureState()).resolves.toStrictEqual({
      enabled: true,
      nextRunAt: expect.any(String),
      nextRunAtIsFuture: true,
    });

    mockNow(base + 320_000);
    const secondThreadId = await fireAndFailNextRun();
    await flushWaitUntilForTest();
    await expect(readFailureState()).resolves.toStrictEqual({
      enabled: true,
      nextRunAt: expect.any(String),
      nextRunAtIsFuture: true,
    });

    mockNow(base + 640_000);
    const thirdThreadId = await fireAndFailNextRun();

    expect(new Set([firstThreadId, secondThreadId, thirdThreadId]).size).toBe(
      1,
    );
    await flushWaitUntilForTest();
    await expect(readFailureState()).resolves.toStrictEqual({
      enabled: false,
      nextRunAt: null,
      nextRunAtIsFuture: false,
    });
  });

  it("preserves run messages when workflow deletion removes automation provenance", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 300);

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );
    const run = await onlyWorkflowRunMessage(threadId);
    expect(run).toMatchObject({
      workflowId: scenario.workflowId,
      workflowName: WORKFLOW_NAME,
    });

    // Under the hard 1:N model a workflow belongs to exactly one agent; removing
    // the workflow cascade-deletes its automations (FK onDelete: cascade).
    await deleteWorkflowViaApi(scenario);

    await accept(
      automationsClient().get({
        headers: authHeaders(),
        params: { id: automation.automationId },
      }),
      [404],
    );

    const historicalRuns = await workflowRunMessages(threadId);
    expect(historicalRuns).toStrictEqual([
      {
        runId: run.runId,
        triggerBrief: run.triggerBrief,
        workflowId: scenario.workflowId,
        workflowName: WORKFLOW_NAME,
      },
    ]);
  });
});

test("rewards the creator after a scheduled workflow successfully completes", async () => {
  const scenario = await setup();
  const automation = await createDueLoopAutomation(scenario, 900);
  const threadId = await executeDueWorkflowAutomations(automation.automationId);
  const run = await onlyWorkflowRunMessage(threadId);
  await webhooksApi.requestAgentComplete(
    {
      runId: run.runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: run.runId,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`scheduled reward ${run.runId}`)
          .digest("hex"),
      },
    },
    {
      authorization: `Bearer ${runsApi.sandboxTokenForRun(scenario.actor, run.runId)}`,
    },
    [200],
  );
  await accept(
    setupApp({ context, routes: scopedReviewRoutes })(
      scopedReviewContract,
    ).process({ body: { orgId: scenario.orgId } }),
    [200],
  );
  expect(
    (await readGetStartedStatus(context, scenario)).quests.find((q) => {
      return q.key === "workflow";
    }),
  ).toMatchObject({ claimedCount: 1, earnedCredits: 1000 });
  await disableAutomation(automation.automationId);
});
