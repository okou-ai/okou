import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chatThreadMetadataContract,
  chatThreadMuteContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  cronExecuteWorkflowAutomationsContract,
  cronOfficialWorkflowCatalogContract,
} from "@okouai/api-contracts/contracts/cron";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  morningBriefPreferenceContract,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  feedContract,
  type PlatformEvent,
} from "@okouai/api-contracts/contracts/feed";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
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
import { cronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";
import { featureSwitchesRoutes } from "../feature-switches";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { feedRoutes } from "../feed";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createPublicAutomationRunApi } from "./helpers/public-automation-run";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";

const context = testContext();
const mocks = createRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const publicRuns = createPublicAutomationRunApi(context);
const CRON_SECRET = "automation-disabled-feed-events-cron-secret";

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
  mockEnv("CRON_SECRET", CRON_SECRET);
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

/** Issue #46339 explicitly scopes the authenticated operator cron as a system boundary. */
async function executeCron() {
  const response = await accept(
    setupApp({ context, routes: cronExecuteWorkflowAutomationsRoutes })(
      cronExecuteWorkflowAutomationsContract,
    ).execute({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
  expect(response.body.success).toBeTruthy();
  await flushWaitUntilForTest();
}

async function fireNextOccurrence(scenario: Scenario) {
  const before = await readAutomation(scenario);
  if (!before.enabled || !before.nextRunAt) {
    throw new Error(
      "Expected an enabled recurring schedule with a next occurrence",
    );
  }
  mockNow(new Date(before.nextRunAt));
  await runs.registerDirectRunner(scenario.runnerGroup);
  await executeCron();
  return await readAutomation(scenario);
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
  recoveryScheduled = false,
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
      disabledAt,
      consecutiveFailures: 3,
      recoveryScheduled,
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

async function startScheduledRun(scenario: Scenario) {
  const automation = await fireNextOccurrence(scenario);
  if (!automation.chatThreadId) {
    throw new Error("Expected a scheduled automation thread");
  }
  authHeaders(scenario.actor);
  const events = await workflows.readThreadEvents(automation.chatThreadId);
  const latestInput = [...events].reverse().find((event) => {
    return event.eventType === "input.prompt" && event.runId;
  });
  if (!latestInput?.runId) {
    throw new Error(
      "Expected the cron to launch a Run through its public thread events",
    );
  }
  const owned = publicRuns.track(
    scenario.actor,
    latestInput.runId,
    scenario.runnerGroup,
  );
  const execution = await runs.executionInput(latestInput.runId);
  owned.sandboxToken = execution.sandboxToken;
  return {
    automation,
    runId: latestInput.runId,
    headers: { authorization: `Bearer ${execution.sandboxToken}` },
    owned,
  };
}

async function completeFailedOccurrence(
  scenario: Scenario,
  options: { readonly creditError?: boolean; readonly mute?: boolean } = {},
) {
  const started = await startScheduledRun(scenario);
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
    await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    const scenario = await createScenario();
    for (let failure = 0; failure < 3; failure++) {
      await completeFailedOccurrence(scenario);
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
  });

  it("excludes credit failures and deduplicates the runtime disable feed event", async () => {
    await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    const scenario = await createScenario({ scheduleType: "loop" });
    for (const failure of [1, 2]) {
      await completeFailedOccurrence(scenario, { mute: failure === 1 });
      expect((await readAutomation(scenario)).enabled).toBeTruthy();
      await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
    }
    await completeFailedOccurrence(scenario, { creditError: true });
    expect((await readAutomation(scenario)).enabled).toBeTruthy();
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);

    const threshold = await completeFailedOccurrence(scenario);
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
    await executeCron();
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
    await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
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
      await completeFailedOccurrence(scenario);
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
      await completeFailedOccurrence(scenario);
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

  it("notifies once for a journaled Morning Brief after three Runner failures and retains its recovery anchor", async () => {
    // Both the catalog publisher and schedule scanner operate across tenants.
    const cron = await setupApp({
      context,
      routes: [
        ...cronOfficialWorkflowCatalogRoutes,
        ...cronExecuteWorkflowAutomationsRoutes,
      ],
      isolatePg: true,
    });
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockNow(new Date("2030-01-01T12:00:00.000Z"));
    const { actor, defaultAgentId } = await workflows.setupWorkflowOrg({
      model: "claude-fable-5-1",
      timezone: "UTC",
    });
    const runnerGroup = await runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    installWorkflowVolumeS3Fixture(context);
    const published = await accept(
      cron(cronOfficialWorkflowCatalogContract).sync({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(published.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });
    await feedSwitch(actor, true);
    const enabled = await accept(
      setupApp({ context, routes: morningBriefPreferenceRoutes })(
        morningBriefPreferenceContract,
      ).update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    expect(enabled.body).toStrictEqual({
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
    await flushWaitUntilForTest();
    const listed = await accept(
      setupApp({ context, routes: workflowsRoutes })(
        workflowsCollectionContract,
      ).list({ headers: authHeaders(actor), query: {} }),
      [200],
    );
    const workflow = listed.body.find((item) => {
      return (
        item.official?.definitionName === MORNING_BRIEF_OFFICIAL_DEFINITION_NAME
      );
    });
    if (!workflow) {
      throw new Error("Expected the preference to install Morning Brief");
    }
    expect(workflow).toMatchObject({
      agentId: defaultAgentId,
      ownerUserId: actor.userId,
      official: { installationState: "installed" },
    });
    const automations = await accept(
      automationsClient().list({
        headers: authHeaders(actor),
        params: { workflowId: workflow.id },
      }),
      [200],
    );
    expect(automations.body).toHaveLength(1);
    const [automation] = automations.body;
    if (!automation) {
      throw new Error("Expected the canonical Morning Brief schedule");
    }
    expect(automation).toMatchObject({
      enabled: true,
      ownerUserId: actor.userId,
      kind: "schedule",
      schedule: { type: "cron", timezone: "UTC" },
      official: {
        blueprintKey: MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
        reconciliationStatus: "current",
        intendedEnabled: true,
      },
    });
    const scenario: Scenario = {
      actor,
      workflowId: workflow.id,
      workflowName: workflow.name,
      runnerGroup,
      automationId: automation.id,
    };
    for (let failure = 1; failure < 3; failure++) {
      await completeFailedOccurrence(scenario);
      expect((await readAutomation(scenario)).enabled).toBeTruthy();
      await expect(inbox(actor)).resolves.toStrictEqual([]);
    }
    const threshold = await completeFailedOccurrence(scenario);
    const disabledAt = new Date(now()).toISOString();
    const disabled = await readAutomation(scenario);
    expect(disabled).toMatchObject({
      enabled: false,
      official: { intendedEnabled: true },
    });
    if (!disabled.nextRunAt) {
      throw new Error("Expected Morning Brief to retain a recovery anchor");
    }
    expect(new Date(disabled.nextRunAt).getTime()).toBeGreaterThan(now());
    const delivered = await inbox(actor);
    expect(delivered).toHaveLength(1);
    const [notice] = delivered;
    if (!notice) {
      throw new Error("Expected the owner's Morning Brief disable notice");
    }
    expectDisableNotice(notice, scenario, disabledAt, true);

    await webhooks.requestAgentComplete(
      threshold.completion,
      threshold.headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect(
      (await inbox(actor)).map((item) => {
        return item.id;
      }),
    ).toStrictEqual([notice.id]);

    await expect(readAutomation(scenario)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: disabled.nextRunAt,
    });
    const peer = workflows.user({ orgId: actor.orgId });
    await feedSwitch(peer, true);
    await expect(inbox(peer)).resolves.toStrictEqual([]);
    await accept(
      feedClient().dismiss({
        headers: authHeaders(peer),
        params: { id: notice.id },
      }),
      [404],
    );
    const otherWorkspace = workflows.user({ userId: actor.userId });
    await feedSwitch(otherWorkspace, true);
    await expect(inbox(otherWorkspace)).resolves.toStrictEqual([]);
    await accept(
      feedClient().dismiss({
        headers: authHeaders(otherWorkspace),
        params: { id: notice.id },
      }),
      [404],
    );
    await expect(inbox(actor)).resolves.toHaveLength(1);
    await accept(
      feedClient().dismiss({
        headers: authHeaders(actor),
        params: { id: notice.id },
      }),
      [204],
    );
    await expect(inbox(actor)).resolves.toStrictEqual([]);
    // Dismissing an event does not change the automation or its recovery anchor.
    await expect(readAutomation(scenario)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: disabled.nextRunAt,
    });
  });

  it("keeps disabling schedules without emitting while the feed switch is off", async () => {
    await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    const scenario = await createScenario({ feedEnabled: false });
    for (const failure of [1, 2, 3]) {
      await completeFailedOccurrence(scenario);
      expect((await readAutomation(scenario)).enabled).toBe(failure < 3);
    }
    await feedSwitch(scenario.actor, true);
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
  });

  it("does not emit for a manual disable and can emit again after re-enabling", async () => {
    await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
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
        await completeFailedOccurrence(scenario);
      }
      await expect(inbox(scenario.actor)).resolves.toHaveLength(cycle + 1);
    }
  });
  it("does not emit when a one-time schedule stops after its attempt", async () => {
    await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    const scenario = await createScenario({ scheduleType: "once" });
    await completeFailedOccurrence(scenario);
    await expect(readAutomation(scenario)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
  });

  it("publishes a feed event after three run preparation failures", async () => {
    await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    const scenario = await createScenario();
    context.mocks.s3.getSignedUrl.mockRejectedValue(
      new Error("Storage unavailable"),
    );
    for (const failure of [1, 2, 3]) {
      await expect(fireNextOccurrence(scenario)).rejects.toThrow(
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
