import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chatThreadMetadataContract,
  chatThreadMuteContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { cronExecuteWorkflowAutomationsContract } from "@okouai/api-contracts/contracts/cron";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  feedContract,
  type PlatformEvent,
} from "@okouai/api-contracts/contracts/feed";
import {
  workflowAutomationsContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadMuteRoutes } from "../chat-threads-mute";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { featureSwitchesRoutes } from "../feature-switches";
import { feedRoutes } from "../feed";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createPublicAutomationRunApi } from "./helpers/public-automation-run";
import { createRouteMocks } from "./helpers/route-test";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";

const context = testContext();
const mocks = createRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const publicRuns = createPublicAutomationRunApi(context);
const CRON_SECRET = "automation-disabled-feed-events-cron-secret";
const AUTOMATION_DESCRIPTION = "Prepare a summary of the owner's open tasks.";

interface Scenario {
  readonly actor: ApiTestUser;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runnerGroup: string;
  readonly automationId: string;
}

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function feedClient() {
  return setupApp({ context, routes: feedRoutes })(feedContract);
}

async function feedSwitch(actor: ApiTestUser, enabled: boolean) {
  await accept(
    setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    ).update({
      headers: authHeaders(actor),
      body: { switches: { [FeatureSwitchKey.AgentSuggestion]: enabled } },
    }),
    [200],
  );
}

async function createScenario(
  options: {
    readonly feedEnabled?: boolean;
    readonly scheduleType?: "cron" | "loop" | "once";
  } = {},
): Promise<Scenario> {
  mockNow(new Date("2030-01-01T12:00:00.000Z"));
  const { actor, defaultAgentId } = await workflows.setupWorkflowOrg({
    model: "claude-fable-5-1",
    timezone: "UTC",
  });
  const runnerGroup = await runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  await feedSwitch(actor, options.feedEnabled ?? true);
  const workflowName = `disabled-feed-event-${randomUUID().slice(0, 8)}`;
  const workflowId = await workflows.createWorkflow(actor, {
    agentId: defaultAgentId,
    name: workflowName,
    description: AUTOMATION_DESCRIPTION,
    visibility: "private",
    instruction: "Prepare the owner's scheduled report.",
  });
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(actor),
      params: { workflowId },
      body: {
        schedule:
          options.scheduleType === "once"
            ? {
                type: "once",
                atTime: new Date(now() + 60_000).toISOString(),
                timezone: "UTC",
              }
            : options.scheduleType === "loop"
              ? { type: "loop", intervalSeconds: 60 }
              : { type: "cron", cronExpression: "* * * * *", timezone: "UTC" },
      },
    }),
    [201],
  );
  expect(created.body.enabled).toBeTruthy();
  return {
    actor,
    workflowId,
    workflowName,
    runnerGroup,
    automationId: created.body.id,
  };
}

async function readAutomation(scenario: Scenario) {
  const response = await accept(
    automationsClient().get({
      headers: authHeaders(scenario.actor),
      params: { id: scenario.automationId },
    }),
    [200],
  );
  return response.body;
}

async function inbox(actor: ApiTestUser) {
  const response = await accept(
    feedClient().list({
      headers: authHeaders(actor),
      query: { type: "event" },
    }),
    [200],
  );
  return response.body.items.filter((item) => {
    return item.type === "event";
  });
}

function expectDisableNotice(
  event: PlatformEvent,
  scenario: Scenario,
  disabledAt: string,
) {
  expect(event).toMatchObject({
    type: "event",
    sourceType: "platform-event",
    state: { status: "active" },
    expiresAt: null,
    content: {
      eventType: "automation-disabled",
      automationId: scenario.automationId,
      workflowId: scenario.workflowId,
      workspaceId: scenario.actor.orgId,
      automationName: scenario.workflowName,
      automationDescription: AUTOMATION_DESCRIPTION,
      disabledAt,
      consecutiveFailures: 3,
      recoveryScheduled: false,
    },
  });
}

async function muteThread(
  scenario: Scenario,
  automation: WorkflowAutomationSummary,
) {
  if (!automation.chatThreadId) {
    throw new Error("Expected the automation's destination thread");
  }
  await accept(
    setupApp({ context, routes: chatThreadMuteRoutes })(
      chatThreadMuteContract,
    ).mute({
      headers: authHeaders(scenario.actor),
      params: { id: automation.chatThreadId },
    }),
    [204],
  );
  const thread = await accept(
    setupApp({ context, routes: chatThreadGetRoutes })(
      chatThreadMetadataContract,
    ).get({
      headers: authHeaders(scenario.actor),
      params: { id: automation.chatThreadId },
    }),
    [200],
  );
  expect(thread.body.muted).toBeTruthy();
}

async function startManualRun(scenario: Scenario) {
  // Each owner request is a distinct click, including when the case controls time.
  mockNow(now() + 60_000);
  await runs.registerDirectRunner(scenario.runnerGroup);
  const started = await publicRuns.start(
    scenario.actor,
    scenario.automationId,
    scenario.runnerGroup,
  );
  const automation = await readAutomation(scenario);
  const owned = publicRuns.track(
    scenario.actor,
    started.runId,
    scenario.runnerGroup,
  );
  const execution = await runs.executionInput(started.runId);
  owned.sandboxToken = execution.sandboxToken;
  return {
    automation,
    runId: started.runId,
    headers: { authorization: `Bearer ${execution.sandboxToken}` },
    owned,
  };
}

async function completeFailedManualRun(
  scenario: Scenario,
  options: { readonly creditError?: boolean; readonly mute?: boolean } = {},
) {
  const started = await startManualRun(scenario);
  if (options.mute) {
    await muteThread(scenario, started.automation);
  }
  const completion = {
    runId: started.runId,
    exitCode: 1,
    error: options.creditError
      ? "insufficient_credits"
      : "Scheduled execution failed",
    ...(options.creditError
      ? { failureReason: "insufficient_credits" as const }
      : {}),
  };
  await webhooks.requestAgentComplete(completion, started.headers, [200]);
  started.owned.acknowledged = true;
  await flushWaitUntilForTest();
  expect((await runs.readRun(scenario.actor, started.runId)).status).toBe(
    "failed",
  );
  return { ...started, completion };
}

describe("recurring automation auto-disable platform feed events", () => {
  it("keeps platform events intact when an Agent reuses their identity for a suggestion", async () => {
    const scenario = await createScenario();
    for (let failure = 0; failure < 3; failure++) {
      await completeFailedManualRun(scenario);
    }
    const [event] = await inbox(scenario.actor);
    if (!event) {
      throw new Error("Expected the disabled automation's platform event");
    }
    const { defaultAgentId } = await createBddApi(context).readOnboardingStatus(
      scenario.actor,
    );
    if (!defaultAgentId) {
      throw new Error("Expected the owner's primary Agent");
    }
    await runs.heartbeatRunner(scenario.runnerGroup);
    const run = await runs.createThreadRun(scenario.actor, {
      agentId: defaultAgentId,
      model: "claude-fable-5-1",
      prompt: "Review the failed automation and curate a useful suggestion.",
    });
    const owned = publicRuns.track(
      scenario.actor,
      run.runId,
      scenario.runnerGroup,
    );
    const execution = await runs.executionInput(run.runId);
    owned.sandboxToken = execution.sandboxToken;
    await accept(
      feedClient().create({
        headers: {
          authorization: `Bearer ${okouTokenFromExecution(execution)}`,
        },
        body: {
          id: event.id,
          type: "suggestion",
          priority: 0,
          content: {
            title: "Review the failed automation",
            rationale: "The scheduled report stopped after repeated failures.",
            options: [
              {
                id: "review",
                label: "Review automation",
                description: "Investigate the report's failures.",
                threadId: null,
                draft: {
                  draftUserMessage: {
                    version: 1,
                    parts: [{ type: "text", text: "Review this automation." }],
                  },
                  draftAttachments: null,
                },
              },
            ],
            customOption: {
              id: "custom",
              threadId: null,
              draft: {
                draftUserMessage: {
                  version: 1,
                  parts: [
                    {
                      type: "feedback",
                      quote:
                        "The scheduled report stopped after repeated failures.",
                      note: [],
                    },
                  ],
                },
                draftAttachments: null,
              },
            },
          },
        },
      }),
      [409],
    );
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([event]);
    const peer = workflows.user({ orgId: scenario.actor.orgId });
    const otherWorkspace = workflows.user({ userId: scenario.actor.userId });
    for (const outsider of [peer, otherWorkspace]) {
      await feedSwitch(outsider, true);
      await expect(inbox(outsider)).resolves.toStrictEqual([]);
      await accept(
        feedClient().dismiss({
          headers: authHeaders(outsider),
          params: { id: event.id },
        }),
        [404],
      );
    }
    await accept(
      feedClient().dismiss({
        headers: authHeaders(scenario.actor),
        params: { id: event.id },
      }),
      [204],
    );
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
    await expect(readAutomation(scenario)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
  });

  it("excludes credit failures and deduplicates the runtime disable feed event", async () => {
    const scenario = await createScenario({ scheduleType: "loop" });
    for (const failure of [1, 2]) {
      await completeFailedManualRun(scenario, { mute: failure === 1 });
      expect((await readAutomation(scenario)).enabled).toBeTruthy();
      await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
    }
    await completeFailedManualRun(scenario, { creditError: true });
    expect((await readAutomation(scenario)).enabled).toBeTruthy();
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);

    const threshold = await completeFailedManualRun(scenario);
    const disabledAt = new Date(now()).toISOString();
    await expect(readAutomation(scenario)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    const delivered = await inbox(scenario.actor);
    expect(delivered).toHaveLength(1);
    const [notice] = delivered;
    if (!notice) {
      throw new Error("Expected a runtime disable feed event");
    }
    expectDisableNotice(notice, scenario, disabledAt);

    await webhooks.requestAgentComplete(
      threshold.completion,
      threshold.headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect(
      (await inbox(scenario.actor)).map((item) => {
        return item.id;
      }),
    ).toStrictEqual([notice.id]);
    const headers = authHeaders(scenario.actor);
    await accept(
      feedClient().updateSources({
        headers,
        body: { suggestions: false, whatsNew: false, offers: false },
      }),
      [200],
    );
    expect(
      (await accept(feedClient().summary({ headers }), [200])).body.hasUnread,
    ).toBeTruthy();
    await accept(
      feedClient().updateSources({
        headers,
        body: { systemUpdates: false },
      }),
      [200],
    );
    expect(
      (await accept(feedClient().summary({ headers }), [200])).body.hasUnread,
    ).toBeFalsy();
    await expect(inbox(scenario.actor)).resolves.toStrictEqual(delivered);
    await accept(
      feedClient().updateSources({
        headers,
        body: { suggestions: true, offers: true },
      }),
      [200],
    );
    expect(
      (await accept(feedClient().sources({ headers }), [200])).body,
    ).toMatchObject({ systemUpdates: false, offers: true });
    expect(
      (await accept(feedClient().summary({ headers }), [200])).body.hasUnread,
    ).toBeFalsy();
    await accept(
      feedClient().updateSources({
        headers,
        body: { systemUpdates: true },
      }),
      [200],
    );
    expect(
      (await accept(feedClient().summary({ headers }), [200])).body.hasUnread,
    ).toBeTruthy();
    await accept(
      feedClient().markRead({ headers, params: { id: notice.id } }),
      [200],
    );
    expect(
      (await accept(feedClient().summary({ headers }), [200])).body.hasUnread,
    ).toBeFalsy();
    await expect(inbox(scenario.actor)).resolves.toStrictEqual(delivered);
    expect((await readAutomation(scenario)).enabled).toBeFalsy();
  });

  it("stops future system update deliveries until enabled again without changing automation failure handling", async () => {
    const scenario = await createScenario();
    const changed = await accept(
      feedClient().updateSources({
        headers: authHeaders(scenario.actor),
        body: { systemUpdates: false },
      }),
      [200],
    );
    expect(changed.body).toStrictEqual({
      suggestions: true,
      whatsNew: true,
      offers: true,
      systemUpdates: false,
    });
    for (let failure = 0; failure < 3; failure++) {
      await completeFailedManualRun(scenario);
    }
    expect((await readAutomation(scenario)).enabled).toBeFalsy();
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
    await accept(
      feedClient().updateSources({
        headers: authHeaders(scenario.actor),
        body: { systemUpdates: true },
      }),
      [200],
    );
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
    await accept(
      automationsClient().enable({
        headers: authHeaders(scenario.actor),
        params: { id: scenario.automationId },
      }),
      [200],
    );
    for (let failure = 0; failure < 3; failure++) {
      await completeFailedManualRun(scenario);
    }
    expect((await readAutomation(scenario)).enabled).toBeFalsy();
    const delivered = await inbox(scenario.actor);
    expect(delivered).toHaveLength(1);
    const [event] = delivered;
    if (!event) {
      throw new Error("Expected a new system update after enabling its source");
    }
    expectDisableNotice(event, scenario, new Date(now()).toISOString());
  });

  it("keeps disabling schedules without emitting while the feed switch is off", async () => {
    const scenario = await createScenario({ feedEnabled: false });
    for (const failure of [1, 2, 3]) {
      await completeFailedManualRun(scenario);
      expect((await readAutomation(scenario)).enabled).toBe(failure < 3);
    }
    await feedSwitch(scenario.actor, true);
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
  });

  it("does not emit for a manual disable and can emit again after re-enabling", async () => {
    const scenario = await createScenario();
    await accept(
      automationsClient().disable({
        headers: authHeaders(scenario.actor),
        params: { id: scenario.automationId },
      }),
      [200],
    );
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
    for (let cycle = 0; cycle < 2; cycle++) {
      await accept(
        automationsClient().enable({
          headers: authHeaders(scenario.actor),
          params: { id: scenario.automationId },
        }),
        [200],
      );
      for (let failure = 0; failure < 3; failure++) {
        await completeFailedManualRun(scenario);
      }
      await expect(inbox(scenario.actor)).resolves.toHaveLength(cycle + 1);
    }
  });

  it("does not emit when a one-time schedule stops after its attempt", async () => {
    const app = await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    mockEnv("CRON_SECRET", CRON_SECRET);
    const scenario = await createScenario({ scheduleType: "once" });
    const before = await readAutomation(scenario);
    if (!before.nextRunAt) {
      throw new Error("Expected the one-time schedule's occurrence");
    }
    mockNow(new Date(before.nextRunAt));
    await runs.registerDirectRunner(scenario.runnerGroup);
    await accept(
      app(cronExecuteWorkflowAutomationsContract).execute({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const automation = await readAutomation(scenario);
    if (!automation.chatThreadId) {
      throw new Error("Expected the one-time schedule's thread");
    }
    authHeaders(scenario.actor);
    const events = await workflows.readThreadEvents(automation.chatThreadId);
    const input = events.find((event) => {
      return event.eventType === "input.prompt" && event.runId;
    });
    if (!input?.runId) {
      throw new Error("Expected the scheduled Run in public thread events");
    }
    const owned = publicRuns.track(
      scenario.actor,
      input.runId,
      scenario.runnerGroup,
    );
    const execution = await runs.executionInput(input.runId);
    owned.sandboxToken = execution.sandboxToken;
    await webhooks.requestAgentComplete(
      {
        runId: input.runId,
        exitCode: 1,
        error: "Scheduled execution failed",
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    owned.acknowledged = true;
    await flushWaitUntilForTest();
    expect((await runs.readRun(scenario.actor, input.runId)).status).toBe(
      "failed",
    );
    await expect(readAutomation(scenario)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
  });

  it.each(["cron", "loop"] as const)(
    "admits one %s occurrence when two scheduler ticks overlap",
    async (scheduleType) => {
      const app = await setupApp({
        context,
        routes: cronExecuteWorkflowAutomationsRoutes,
        isolatePg: true,
      });
      mockEnv("CRON_SECRET", CRON_SECRET);
      const scenario = await createScenario({ scheduleType });
      const before = await readAutomation(scenario);
      if (!before.nextRunAt) {
        throw new Error("Expected the recurring schedule's next occurrence");
      }
      const dueAt = new Date(before.nextRunAt);
      mockNow(dueAt);
      await runs.registerDirectRunner(scenario.runnerGroup);
      const cron = app(cronExecuteWorkflowAutomationsContract);
      const tick = () => {
        return accept(
          cron.execute({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
          [200],
        );
      };
      const [first, second] = await Promise.all([tick(), tick()]);
      expect(first.body.executed + second.body.executed).toBe(1);
      await flushWaitUntilForTest();

      const automation = await readAutomation(scenario);
      if (!automation.chatThreadId) {
        throw new Error("Expected the recurring schedule's destination thread");
      }
      authHeaders(scenario.actor);
      const events = await workflows.readThreadEvents(automation.chatThreadId);
      const inputs = events.filter((event) => {
        return event.eventType === "input.prompt" && event.runId;
      });
      expect(inputs).toHaveLength(1);
      const runId = inputs[0]?.runId;
      if (!runId) {
        throw new Error("Expected the admitted automation Run");
      }
      const owned = publicRuns.track(
        scenario.actor,
        runId,
        scenario.runnerGroup,
      );
      const execution = await runs.executionInput(runId);
      owned.sandboxToken = execution.sandboxToken;
      await webhooks.requestAgentComplete(
        { runId, exitCode: 0 },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      owned.acknowledged = true;
      await flushWaitUntilForTest();
      await expect(readAutomation(scenario)).resolves.toMatchObject({
        enabled: true,
        nextRunAt: new Date(dueAt.getTime() + 60_000).toISOString(),
      });
    },
  );

  it("publishes a feed event after three run preparation failures", async () => {
    const app = await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    mockEnv("CRON_SECRET", CRON_SECRET);
    const scenario = await createScenario();
    context.mocks.s3.getSignedUrl.mockRejectedValue(
      new Error("Storage unavailable"),
    );
    for (const failure of [1, 2, 3]) {
      const before = await readAutomation(scenario);
      if (!before.enabled || !before.nextRunAt) {
        throw new Error("Expected the recurring schedule's next occurrence");
      }
      mockNow(new Date(before.nextRunAt));
      await runs.registerDirectRunner(scenario.runnerGroup);
      await accept(
        app(cronExecuteWorkflowAutomationsContract).execute({
          headers: { authorization: `Bearer ${CRON_SECRET}` },
        }),
        [200],
      );
      await expect(flushWaitUntilForTest()).rejects.toThrow(
        "Run execution preparation failed",
      );
      expect((await readAutomation(scenario)).enabled).toBe(failure < 3);
    }
    const delivered = await inbox(scenario.actor);
    expect(delivered).toHaveLength(1);
    const [event] = delivered;
    if (!event) {
      throw new Error("Expected a preparation failure event");
    }
    expectDisableNotice(event, scenario, new Date(now()).toISOString());
  });
});
