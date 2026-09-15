import { createHash, randomUUID } from "node:crypto";

import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import {
  workflowAutomationsContract,
  type WorkflowSchedule,
} from "@okouai/api-contracts/contracts/workflows";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { createStore } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { makeCodexAuthJson, makeCodexJwt } from "./helpers/api-bdd-auth-device";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { readRunModelSourceFixture } from "../../../test-fixtures/agent-runs";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import type { ApiTestUser } from "./helpers/api-bdd";
import { mockGmailConnectorOAuth } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { readAgentRunCallbacks$ } from "./helpers/agent-run-callback";
import {
  chatEventAutomationPart,
  chatEventDisplayText,
} from "./helpers/chat-event";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { seedBuiltInModelKey } from "./helpers/runtime-state";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { agentsRoutes } from "../agents";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";

const TEST_APP_ROUTES = Object.freeze([
  ...testWorkflowAutomationExecutionRoutes,
  ...agentsRoutes,
  ...workflowAutomationsRoutes,
  ...workflowsRoutes,
]);

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const runReadsApi = createRunReadsApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const chatFilesApi = createChatFilesBddApi(context);
const computerUseApi = createComputerUseBddApi(context);

const WORKFLOW_NAME = "scheduler-workflow";

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

function workflowAutomationExecutionClient() {
  return setupApp({
    context,
    routes: testWorkflowAutomationExecutionRoutes,
  })(testWorkflowAutomationExecutionContract);
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
  const agent = await wf.createAgent(actor, {
    displayName: "Scheduler Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
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
  const response = await accept(
    workflowAutomationExecutionClient().execute({
      body: { automation_id: automationId },
    }),
    [200],
  );
  expect(response.body.success).toBeTruthy();
  const automation = await wf.readAutomation(automationId);
  if (!automation.chatThreadId) {
    throw new Error("Expected execution to bind a chat thread");
  }
  return automation.chatThreadId;
}

interface WorkflowRunMessage {
  readonly runId: string;
  readonly runGroupId?: string;
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
        ...(message.runGroupId === undefined
          ? {}
          : { runGroupId: message.runGroupId }),
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

async function waitForScheduleCallback(
  scenario: Scenario,
  runId: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const callbacks = await store.set(
        readAgentRunCallbacks$,
        { orgId: scenario.orgId, userId: scenario.userId, runId },
        context.signal,
      );
      return callbacks.find((callback) => {
        return (
          callback.internalKind === "workflow-automation:cron" ||
          callback.internalKind === "workflow-automation:loop"
        );
      })?.status;
    })
    .toBe("delivered");
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
  it("does not expose scoped workflow execution in production", async () => {
    mockEnv("ENV", "production");

    const response = await accept(
      workflowAutomationExecutionClient().execute({
        body: {
          automation_id: "00000000-0000-4000-8000-000000000001",
        },
      }),
      [404],
    );

    expect(response.body).toBe("Not found");
  });

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
        userConnectorsContract,
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
    expect(run.runGroupId).toBeUndefined();
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
    const emittedCallbacks = await store.set(
      readAgentRunCallbacks$,
      {
        orgId: scenario.orgId,
        userId: scenario.userId,
        runId: onceRun.runId,
      },
      context.signal,
    );
    const onceCallback = emittedCallbacks.find((callback) => {
      return callback.internalKind === "workflow-automation:cron";
    });
    expect(
      emittedCallbacks.every((callback) => {
        return !callback.hasEncryptedSecret;
      }),
    ).toBeTruthy();
    expect(onceCallback?.payload).toStrictEqual({
      automationId: created.body.id,
      timezone: "UTC",
    });
    expect(onceCallback?.status).toBe("pending");

    const automation = await wf.readAutomation(created.body.id);
    expect(automation.enabled).toBeFalsy();
    expect(automation.nextRunAt).toBeNull();

    await expect(onlyWorkflowDisplayText(threadId)).resolves.toBe(
      "The one-time scheduled run started.",
    );
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
    "uses the second member automation owner's subscription and retains it after scheduler admission (queued: %s)",
    async (queuedLaunch) => {
      const scenario = await setup();
      const support = createAuthDeviceSupportApi(context);
      const misc = createMiscRoutesApi(context);
      await support.updateFeatureSwitches(scenario.actor, {
        [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
        [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
        [FeatureSwitchKey.PiLoop]: false,
      });
      const configured = await runsApi.createOrgModelProvider(scenario.actor, {
        type: "openai-api-key",
        secret: "unused-scheduler-api-key",
      });
      await runsApi.updateOrgModelPolicies(scenario.actor, [
        {
          model: "gpt-5.6-luna",
          isDefault: true,
          defaultProviderType: "openai-api-key",
          credentialScope: "org",
          modelProviderId: configured.providerId,
        },
      ]);
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
        for (let index = 0; index < 2; index += 1) {
          const started = await chatFilesApi.requestSendEvent(
            scenario.actor,
            {
              agentId: scenario.agentId,
              model: "gpt-5.6-luna",
              prompt: `Occupy organization concurrency ${index}`,
            },
            [201],
          );
          if (started.status !== 201 || !started.body.runId) {
            throw new Error("Expected an admitted concurrency blocker");
          }
          blockers.push(started.body.runId);
        }
      }
      const member = wf.user({
        userId: `user_${randomUUID()}`,
        orgId: scenario.orgId,
        orgRole: "org:member",
      });
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
      await support.updateFeatureSwitches(member, {
        [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
        [FeatureSwitchKey.PiLoop]: false,
      });
      const owner = await connectOwner(member, "automation-owner");
      mocks.clerk.session(member.userId, scenario.orgId, "org:member");
      const created = await createDueLoopAutomation(scenario, 3600);
      // Scheduler execution is unauthenticated infrastructure; the owner is the member above.
      mocks.clerk.session(scenario.userId, scenario.orgId);
      const threadId = await executeDueWorkflowAutomations(
        created.automationId,
      );
      mocks.clerk.session(member.userId, scenario.orgId, "org:member");
      const message = await onlyWorkflowRunMessage(threadId);
      expect((await runsApi.readRun(member, message.runId)).status).toBe(
        queuedLaunch ? "queued" : "pending",
      );
      await connectOwner(member, "later-owner-account");
      for (const blocker of blockers) {
        await runsApi.requestCancelRun(scenario.actor, blocker, [200]);
      }
      await expect
        .poll(async () => {
          return (await runsApi.readRun(member, message.runId)).status;
        })
        .toBe("pending");
      await runsApi.heartbeatRunner(scenario.runnerGroup);
      const claim = await runsApi.claimRunnerJob(message.runId);
      expect(claim.cliAgentType).toBe("codex");
      expect(
        claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN?.sourceId,
      ).toBe(owner.accountId);
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
          Authorization: `Bearer ${owner.token}`,
          "ChatGPT-Account-ID": "automation-owner",
        },
      });
      await expect(
        readRunModelSourceFixture(message.runId),
      ).resolves.toMatchObject({
        modelProvider: "codex-oauth-token",
        modelProviderCredentialScope: "member",
        modelProviderId: owner.accountId,
        creditAdmitted: false,
        builtInModelKeyId: null,
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

    const execution = await accept(
      workflowAutomationExecutionClient().execute({
        body: { automation_id: created.body.id },
      }),
      [200],
    );
    expect(execution.body.success).toBeTruthy();

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
    const threadId = await executeDueWorkflowAutomations(created.body.id);
    const run = await onlyWorkflowRunMessage(threadId);
    const emittedCallbacks = await store.set(
      readAgentRunCallbacks$,
      {
        orgId: scenario.orgId,
        userId: scenario.userId,
        runId: run.runId,
      },
      context.signal,
    );
    const cronCallback = emittedCallbacks.find((callback) => {
      return callback.internalKind === "workflow-automation:cron";
    });
    expect(cronCallback?.payload).toStrictEqual({
      automationId: created.body.id,
      timezone: "UTC",
      cronExpression: "0 9 * * *",
    });
    expect(cronCallback?.status).toBe("pending");
    expect(run).toMatchObject({
      workflowId: scenario.workflowId,
      workflowName: WORKFLOW_NAME,
      triggerBrief: expect.any(String),
    });
    await completeRunThroughSandbox(scenario, run.runId, 0);

    await expect
      .poll(async () => {
        return (await wf.readAutomation(created.body.id)).nextRunAt;
      })
      .not.toBeNull();
    const automation = await wf.readAutomation(created.body.id);
    expect(automation.enabled).toBeTruthy();
  });

  it("reschedules a loop automation from a canonical-only callback", async () => {
    const scenario = await setup();
    const automation = await createDueLoopAutomation(scenario, 300);

    const threadId = await executeDueWorkflowAutomations(
      automation.automationId,
    );
    const before = now();
    const run = await onlyWorkflowRunMessage(threadId);
    const emittedCallbacks = await store.set(
      readAgentRunCallbacks$,
      {
        orgId: scenario.orgId,
        userId: scenario.userId,
        runId: run.runId,
      },
      context.signal,
    );
    const loopCallback = emittedCallbacks.find((callback) => {
      return callback.internalKind === "workflow-automation:loop";
    });
    expect(loopCallback?.payload).toStrictEqual({
      automationId: automation.automationId,
    });
    expect(loopCallback?.status).toBe("pending");
    expect(run).toMatchObject({
      workflowId: scenario.workflowId,
      workflowName: WORKFLOW_NAME,
      triggerBrief: expect.any(String),
    });
    await completeRunThroughSandbox(scenario, run.runId, 0);

    await expect
      .poll(async () => {
        return (await wf.readAutomation(automation.automationId)).nextRunAt;
      })
      .not.toBeNull();
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
      // The edit already seeded nextRunAt; wait for the old callback before
      // checking it so an eventual stale overwrite cannot pass unnoticed.
      await waitForScheduleCallback(scenario, run.runId);
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
      await seedBuiltInModelKey(context, "claude-sonnet-5");
      await runsApi.updateOrgModelPolicies(scenario.actor, [
        {
          model: "claude-sonnet-5",
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
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
      await expect
        .poll(async () => {
          const read = await wf.readAutomation(automation.automationId);
          return { enabled: read.enabled, nextRunAt: read.nextRunAt };
        })
        .toStrictEqual({ enabled: true, nextRunAt: expect.any(String) });
      const read = await wf.readAutomation(automation.automationId);
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
    await expect.poll(readFailureState).toStrictEqual({
      enabled: true,
      nextRunAt: expect.any(String),
      nextRunAtIsFuture: true,
    });

    mockNow(base + 320_000);
    const secondThreadId = await fireAndFailNextRun();
    await expect.poll(readFailureState).toStrictEqual({
      enabled: true,
      nextRunAt: expect.any(String),
      nextRunAtIsFuture: true,
    });

    mockNow(base + 640_000);
    const thirdThreadId = await fireAndFailNextRun();

    expect(new Set([firstThreadId, secondThreadId, thirdThreadId]).size).toBe(
      1,
    );
    await expect.poll(readFailureState).toStrictEqual({
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
