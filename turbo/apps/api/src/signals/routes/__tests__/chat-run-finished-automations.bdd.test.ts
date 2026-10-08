import { createHash, randomUUID } from "node:crypto";

import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  readLatestWorkflowAutomationRunFixture,
  readWorkflowAutomationAutonomyFixture,
  setRunAutonomyBudgetFixture,
  setWorkflowAutomationAutonomyBudgetFixture,
} from "./helpers/runtime-state";

/**
 * chat-run-finished workflow automations: creation validation and dispatch
 * from the terminal chat callback (real sandbox complete webhooks).
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const wf = createWorkflowsBddApi(context);
const WATCHED_THREAD_TITLE = "Watched chat run";

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

interface ChatAutomationFixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly providerId: string;
  readonly workflowId: string;
  readonly runnerGroup: string;
}

async function setupChatAutomationFixture(): Promise<ChatAutomationFixture> {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  chatCallbacks.acceptChatObjectStorage();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  const { providerId } = await api.ensurePersonalSubscriptionModel(actor);
  // Completion and queue fixtures use the retained native Claude route.
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat run finished automation agent",
    description: "Exercises chat-run-finished automation dispatch.",
    visibility: "private",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: "chat-run-finished-workflow",
  });
  context.mocks.s3.send.mockResolvedValue({});
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: agent.agentId,
    providerId,
    workflowId,
    runnerGroup,
  };
}

/**
 * Each automation gets its own workflow so it also gets its own automation
 * chat thread; automations sharing a workflow queue behind each other and
 * would not record `lastRunAt` until the prior automation run completes.
 */
async function createChatRunFinishedAutomation(
  fixture: Pick<ChatAutomationFixture, "actor" | "agentId">,
  eventConfig: {
    readonly chatThreadId: string;
    readonly runStatuses?: readonly ("completed" | "failed" | "cancelled")[];
    readonly outputPattern?: string;
  },
  options: { readonly workflowChatThreadId?: string } = {},
): Promise<string> {
  const workflowId = await wf.createWorkflow(fixture.actor, {
    agentId: fixture.agentId,
    name: `crf-${randomUUID().slice(0, 8)}`,
    ...(options.workflowChatThreadId
      ? { chatThreadId: options.workflowChatThreadId }
      : {}),
  });
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId },
      body: {
        kind: "event",
        eventType: "chat-run-finished",
        eventConfig: {
          provider: "chat",
          event: "run_finished",
          chatThreadId: eventConfig.chatThreadId,
          ...(eventConfig.runStatuses
            ? { runStatuses: [...eventConfig.runStatuses] }
            : {}),
          ...(eventConfig.outputPattern
            ? { outputPattern: eventConfig.outputPattern }
            : {}),
        },
      },
    }),
    [201],
  );
  expect(created.body).toMatchObject({
    kind: "event",
    eventType: "chat-run-finished",
    enabled: true,
  });
  return created.body.id;
}

async function automationLastRunAt(automationId: string): Promise<unknown> {
  const automation = await accept(
    automationsClient().get({
      headers: authHeaders(),
      params: { id: automationId },
    }),
    [200],
  );
  return automation.body.lastRunAt;
}

async function startWatchedChatRun(
  fixture: ChatAutomationFixture,
  prompt: string,
): Promise<{ readonly runId: string; readonly threadId: string }> {
  const sent = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: fixture.agentId,
      prompt,
      clientEventId: randomUUID(),
      model: "claude-fable-5-1",
    },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected the chat send to be accepted");
  }
  // The send only enqueues; its background pick launches the run.
  await flushWaitUntilForTest();
  const page = await chat.listThreadEvents(fixture.actor, sent.body.threadId);
  const runId = page.events
    .flatMap((event) => {
      return event.eventType === "input.prompt" && event.runId
        ? [event.runId]
        : [];
    })
    .at(-1);
  if (!runId) {
    throw new Error("Expected the chat send to create a run");
  }
  await chat.renameThread(
    fixture.actor,
    sent.body.threadId,
    WATCHED_THREAD_TITLE,
  );
  return { runId, threadId: sent.body.threadId };
}

async function claimChatRun(
  runnerGroup: string,
  runId: string,
): Promise<{ readonly authorization: string }> {
  await api.heartbeatRunner(runnerGroup);
  let claim: Awaited<ReturnType<typeof api.requestClaimRunnerJob>> | undefined;
  await flushWaitUntilForTest();
  await expect(
    (async () => {
      claim = await api.requestClaimRunnerJob(true, runId, [200, 404]);
      return claim.status;
    })(),
  ).resolves.toBe(200);
  if (!claim || claim.status !== 200) {
    throw new Error("Expected the chat run to be claimable");
  }
  return { authorization: `Bearer ${claim.body.sandboxToken}` };
}

async function completeChatRunOk(
  runId: string,
  sandboxHeaders: { readonly authorization: string },
  options: { readonly lastEventSequence?: number } = {},
): Promise<void> {
  const stagedOutputEvents = chatCallbacks.consumeMockChatOutputEvents();
  if (stagedOutputEvents.length > 0) {
    await webhooks.requestAgentEvents(
      { runId, events: stagedOutputEvents },
      sandboxHeaders,
      [200],
    );
  }
  const historyHash = createHash("sha256")
    .update(`bdd chat session history ${runId}`)
    .digest("hex");
  await webhooks.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `bdd-cli-${runId}`,
        cliAgentSessionHistoryHash: historyHash,
      },
      ...(options.lastEventSequence === undefined
        ? stagedOutputEvents.length === 0
          ? {}
          : {
              lastEventSequence: Math.max(
                ...stagedOutputEvents.map((event) => {
                  return event.sequenceNumber;
                }),
              ),
            }
        : { lastEventSequence: options.lastEventSequence }),
    },
    sandboxHeaders,
    [200],
  );
}

async function expectAutomationFired(automationId: string): Promise<void> {
  await flushWaitUntilForTest();
  await expect(
    (() => {
      return automationLastRunAt(automationId);
    })(),
  ).resolves.toBeTruthy();
}

async function expectAutomationSourceAnnotation(
  fixture: ChatAutomationFixture,
  automationId: string,
  sourceRun: { readonly runId: string; readonly threadId: string },
): Promise<string | null> {
  const automation = await accept(
    automationsClient().get({
      headers: authHeaders(),
      params: { id: automationId },
    }),
    [200],
  );
  const automationThreadId = automation.body.chatThreadId;
  if (!automationThreadId) {
    throw new Error("Expected the automation chat thread");
  }
  const automationEvents = await chat.listThreadEvents(
    fixture.actor,
    automationThreadId,
  );
  const automationInputs = automationEvents.events.filter((event) => {
    return (
      event.eventType === "input.prompt" &&
      event.runId !== undefined &&
      event.userMessage.parts.some((part) => {
        return (
          part.type === "source" &&
          part.kind === "agent" &&
          part.runId === sourceRun.runId
        );
      })
    );
  });
  expect(automationInputs).toHaveLength(1);
  const [automationInput] = automationInputs;
  if (!automationInput || automationInput.eventType !== "input.prompt") {
    throw new Error("Expected the triggered automation input");
  }
  expect(
    automationInput.userMessage.parts.filter((part) => {
      return part.type === "source" || part.type === "automation";
    }),
  ).toStrictEqual([
    {
      type: "source",
      kind: "agent",
      runId: sourceRun.runId,
      threadId: sourceRun.threadId,
      agentId: fixture.agentId,
      titleSnapshot: WATCHED_THREAD_TITLE,
      href: `/chats/${sourceRun.threadId}#run-${sourceRun.runId}`,
    },
  ]);
  return chatEventDisplayText(automationInput);
}

describe("chat-run-finished workflow automations", () => {
  it("requires the watched chat thread to belong to the automation owner", async () => {
    const fixture = await setupChatAutomationFixture();

    const missingThread = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: fixture.workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: randomUUID(),
          },
        },
      }),
      [400],
    );
    expect(missingThread.body.error.message).toContain("Chat thread not found");

    const otherUser = bdd.user({
      orgId: fixture.actor.orgId ?? undefined,
      orgRole: "org:member",
    });
    const otherAgent = await bdd.createAgent(otherUser, {
      displayName: "Other member agent",
      visibility: "private",
    });
    const otherThread = await chat.createThread(otherUser, {
      agentId: otherAgent.agentId,
      model: null,
    });
    // Restore the fixture actor's session after acting as the other member.
    await bdd.readMe(fixture.actor);
    const foreignThread = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: fixture.workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: otherThread.id,
          },
        },
      }),
      [400],
    );
    expect(foreignThread.body.error.message).toContain("Chat thread not found");
  });

  it("prevents a workflow from watching its own chat thread", async () => {
    const fixture = await setupChatAutomationFixture();
    const workflowThread = await chat.createThread(fixture.actor, {
      agentId: fixture.agentId,
      model: null,
    });
    const workflowId = await wf.createWorkflow(fixture.actor, {
      agentId: fixture.agentId,
      name: `self-watching-${randomUUID().slice(0, 8)}`,
      chatThreadId: workflowThread.id,
    });

    const response = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "chat-run-finished",
          eventConfig: {
            provider: "chat",
            event: "run_finished",
            chatThreadId: workflowThread.id,
          },
        },
      }),
      [400],
    );
    expect(response.body.error.message).toBe(
      "A workflow cannot watch run-finished events from its own chat thread",
    );
  });

  it(
    "fires claimable matching automations when a watched run completes",
    { timeout: 30_000 },
    async () => {
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(fixture, "watched completed run");
      await setRunAutonomyBudgetFixture(context, run.runId, 2);

      const fireAlways = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
      });
      const failedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
      });
      const patternMatch = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["completed"],
        outputPattern: "*deploy failed*",
      });
      const patternMiss = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        outputPattern: "*all systems nominal*",
      });
      await setWorkflowAutomationAutonomyBudgetFixture(
        context,
        patternMatch,
        0,
      );

      chatCallbacks.mockChatOutputEvents([
        {
          eventType: "assistant",
          sequenceNumber: 0,
          eventData: {
            message: {
              content: [{ type: "text", text: "Alert: Deploy FAILED on prod" }],
            },
          },
        },
      ]);
      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      await completeChatRunOk(run.runId, sandboxHeaders, {
        lastEventSequence: 0,
      });

      await expectAutomationFired(fireAlways);
      await expectAutomationFired(patternMatch);
      await expect(automationLastRunAt(failedOnly)).resolves.toBeNull();
      await expect(automationLastRunAt(patternMiss)).resolves.toBeNull();
      const fireAlwaysState = await readWorkflowAutomationAutonomyFixture(
        context,
        fireAlways,
      );
      const patternMatchState = await readWorkflowAutomationAutonomyFixture(
        context,
        patternMatch,
      );
      expect(fireAlwaysState).toMatchObject({ autonomyBudget: 32 });
      expect(patternMatchState).toMatchObject({ autonomyBudget: 0 });
      await expect(
        readLatestWorkflowAutomationRunFixture(context, fireAlways),
      ).resolves.toMatchObject({ autonomyBudget: 1 });
      await expect(
        readLatestWorkflowAutomationRunFixture(context, patternMatch),
      ).resolves.toMatchObject({ autonomyBudget: 1 });

      const displayMessage = await expectAutomationSourceAnnotation(
        fixture,
        fireAlways,
        run,
      );
      expect(displayMessage).toBe(
        "A run in the watched chat thread completed.",
      );

      const automationRuns = await api.listAgentRuns(fixture.actor, {
        status: "pending",
        limit: 20,
      });
      expect(automationRuns.runs).toHaveLength(2);
      const automationRunId = automationRuns.runs[0]?.id;
      if (!automationRunId) {
        throw new Error("Expected a triggered automation run");
      }
      await claimChatRun(fixture.runnerGroup, automationRunId);
    },
  );

  it(
    "fires failed-status automations without matching patterns on errors",
    { timeout: 30_000 },
    async () => {
      const fixture = await setupChatAutomationFixture();
      const run = await startWatchedChatRun(fixture, "watched failed run");

      const failedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
      });
      const completedOnly = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["completed"],
      });
      const failedWithPattern = await createChatRunFinishedAutomation(fixture, {
        chatThreadId: run.threadId,
        runStatuses: ["failed"],
        outputPattern: "*boom*",
      });

      const sandboxHeaders = await claimChatRun(fixture.runnerGroup, run.runId);
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1, error: "boom: sandbox exploded" },
        sandboxHeaders,
        [200],
      );

      await expectAutomationFired(failedOnly);
      await expectAutomationSourceAnnotation(fixture, failedOnly, run);
      await expect(automationLastRunAt(completedOnly)).resolves.toBeNull();
      // Error messages are not matchable output, so pattern automations stay
      // silent even when the error text would match.
      await expect(automationLastRunAt(failedWithPattern)).resolves.toBeNull();
    },
  );
});
