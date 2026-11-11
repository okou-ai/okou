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
  userNotificationsContract,
  type UserNotification,
} from "@okouai/api-contracts/contracts/user-notifications";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadMuteRoutes } from "../chat-threads-mute";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { cronOfficialWorkflowCatalogRoutes } from "../cron-official-workflow-catalog";
import { featureSwitchesRoutes } from "../feature-switches";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { userNotificationRoutes } from "../user-notifications";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createPublicAutomationRunApi } from "./helpers/public-automation-run";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const mocks = createRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const publicRuns = createPublicAutomationRunApi(context);
const CRON_SECRET = "automation-disabled-notifications-cron-secret";
const ADMISSION_FAILURE_MESSAGE =
  "No executor configured: set RUNNER_DEFAULT_GROUP";

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

function notificationsClient() {
  return setupApp({ context, routes: userNotificationRoutes })(
    userNotificationsContract,
  );
}

async function notificationSwitches(
  actor: ApiTestUser,
  enabled: boolean,
  inboxEnabled = true,
) {
  const updated = await accept(
    setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    ).update({
      headers: authHeaders(actor),
      body: {
        switches: {
          [FeatureSwitchKey.UserNotifications]: inboxEnabled,
          [FeatureSwitchKey.AutomationDisableNotifications]: enabled,
        },
      },
    }),
    [200],
  );
  expect(updated.body.effectiveSwitches).toMatchObject({
    [FeatureSwitchKey.UserNotifications]: inboxEnabled,
    [FeatureSwitchKey.AutomationDisableNotifications]: enabled,
  });
}

async function createScenario(
  options: {
    readonly notifications?: boolean;
    readonly scheduleType?: "cron" | "loop";
  } = {},
): Promise<Scenario> {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockNow(new Date("2030-01-01T12:00:00.000Z"));
  const { actor, defaultAgentId } = await workflows.setupWorkflowOrg({
    model: "claude-fable-5-1",
    timezone: "UTC",
  });
  const runnerGroup = runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  await notificationSwitches(actor, options.notifications ?? true);
  const workflowName = `disabled-notification-${randomUUID().slice(0, 8)}`;
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
          options.scheduleType === "loop"
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
async function executeCron(expectAdmissionFailure = false) {
  const response = await accept(
    setupApp({ context, routes: cronExecuteWorkflowAutomationsRoutes })(
      cronExecuteWorkflowAutomationsContract,
    ).execute({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
  expect(response.body.success).toBeTruthy();
  if (expectAdmissionFailure) {
    // A launch preparation failure rejects its input and still propagates to
    // the background owner. Acknowledge the missing executor configuration.
    await expect(flushWaitUntilForTest()).rejects.toThrow(
      ADMISSION_FAILURE_MESSAGE,
    );
  } else {
    await flushWaitUntilForTest();
  }
}

async function fireNextOccurrence(
  scenario: Scenario,
  expectAdmissionFailure = false,
) {
  const before = await readAutomation(scenario);
  if (!before.enabled || !before.nextRunAt) {
    throw new Error(
      "Expected an enabled recurring schedule with a next occurrence",
    );
  }
  mockNow(new Date(before.nextRunAt));
  await executeCron(expectAdmissionFailure);
  return await readAutomation(scenario);
}

async function inbox(actor: ApiTestUser) {
  const response = await accept(
    notificationsClient().list({ headers: authHeaders(actor) }),
    [200],
  );
  expect(response.body.nextCursor).toBeNull();
  return response.body.items;
}

async function unreadCount(actor: ApiTestUser) {
  return (
    await accept(
      notificationsClient().summary({ headers: authHeaders(actor) }),
      [200],
    )
  ).body.unreadCount;
}

async function readNotification(actor: ApiTestUser, id: string) {
  return (
    await accept(
      notificationsClient().get({
        headers: authHeaders(actor),
        params: { id },
      }),
      [200],
    )
  ).body;
}

function expectDisableNotice(
  notification: UserNotification,
  scenario: Scenario,
  disabledAt: string,
  recoveryScheduled = false,
) {
  expect(notification.readAt).toBeNull();
  expect(notification.title.length).toBeGreaterThan(0);
  expect(notification.summary).toContain(scenario.workflowName);
  expect(notification.payload).toMatchObject({
    type: "rich_text",
    automationDisabled: {
      automationId: scenario.automationId,
      workflowId: scenario.workflowId,
      workspaceId: scenario.actor.orgId,
      automationName: scenario.workflowName,
      disabledAt,
      consecutiveFailures: 3,
      recoveryScheduled,
    },
  });
  if (notification.payload.type !== "rich_text") {
    throw new Error("Expected a backwards-compatible rich-text notification");
  }
  const markdown = notification.payload.markdown;
  expect(markdown).toContain(
    `“${scenario.workflowName.replaceAll("-", String.raw`\-`)}”`,
  );
  expect(markdown).toContain(
    "automatically disabled after 3 consecutive execution failures.",
  );
  expect(markdown).toContain("Review the automation for its current status.");
  expect(markdown).toContain(`Disabled at: ${disabledAt}`);
  expect(
    [notification.title, notification.summary, markdown].join("\n"),
  ).not.toContain(scenario.actor.orgId);
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

async function expectPreRunRejections(
  scenario: Scenario,
  automation: WorkflowAutomationSummary,
  count: number,
) {
  if (!automation.chatThreadId) {
    throw new Error("Expected the rejected occurrence's destination thread");
  }
  authHeaders(scenario.actor);
  const events = await workflows.readThreadEvents(automation.chatThreadId);
  const rejected = events.filter((event) => {
    return event.eventType === "input.rejected";
  });
  expect(rejected).toHaveLength(count);
  for (const event of rejected) {
    expect(event).toMatchObject({
      eventType: "input.rejected",
      error: "internal_error",
    });
    expect(event.runId).toBeUndefined();
  }
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
  await runs.heartbeatRunner(scenario.runnerGroup);
  const claimed = await runs.claimRunnerJob(latestInput.runId);
  owned.sandboxToken = claimed.sandboxToken;
  return {
    automation,
    runId: latestInput.runId,
    headers: { authorization: `Bearer ${claimed.sandboxToken}` },
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

describe("recurring automation auto-disable bell notifications", () => {
  it("notifies only the owner on the third pre-run failure even when its thread is muted", async () => {
    await setupApp({
      context,
      routes: cronExecuteWorkflowAutomationsRoutes,
      isolatePg: true,
    });
    const scenario = await createScenario();
    // The replacement API cannot admit scheduled work without an executor.
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);

    for (const failure of [1, 2]) {
      const automation = await fireNextOccurrence(scenario, true);
      await expectPreRunRejections(scenario, automation, failure);
      expect(automation.enabled).toBeTruthy();
      expect(automation.nextRunAt).not.toBeNull();
      await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
      await expect(unreadCount(scenario.actor)).resolves.toBe(0);
      if (failure === 1) {
        await muteThread(scenario, automation);
      }
    }
    const disabled = await fireNextOccurrence(scenario, true);
    await expectPreRunRejections(scenario, disabled, 3);
    const disabledAt = new Date(now()).toISOString();
    expect(disabled).toMatchObject({ enabled: false, nextRunAt: null });
    const delivered = await inbox(scenario.actor);
    expect(delivered).toHaveLength(1);
    const [notice] = delivered;
    if (!notice) {
      throw new Error("Expected the owner's disable notification");
    }
    expectDisableNotice(
      await readNotification(scenario.actor, notice.id),
      scenario,
      disabledAt,
    );
    await expect(unreadCount(scenario.actor)).resolves.toBe(1);

    // A disabled automation is a no-op on the real cron, not another delivery.
    await executeCron();
    expect(
      (await inbox(scenario.actor)).map((item) => {
        return item.id;
      }),
    ).toStrictEqual([notice.id]);
    const peer = workflows.user({ orgId: scenario.actor.orgId });
    await notificationSwitches(peer, true);
    await expect(inbox(peer)).resolves.toStrictEqual([]);
    await accept(
      notificationsClient().get({
        headers: authHeaders(peer),
        params: { id: notice.id },
      }),
      [404],
    );
    await accept(
      notificationsClient().markRead({
        headers: authHeaders(peer),
        params: { id: notice.id },
      }),
      [404],
    );
    await expect(unreadCount(scenario.actor)).resolves.toBe(1);
    await accept(
      notificationsClient().markRead({
        headers: authHeaders(scenario.actor),
        params: { id: notice.id },
      }),
      [200],
    );
    await expect(unreadCount(scenario.actor)).resolves.toBe(0);
    expect((await readAutomation(scenario)).enabled).toBeFalsy();
  });

  it("excludes credit failures, deduplicates runtime completion replay, and notifies again after owner re-enable", async () => {
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
    const firstCycle = await inbox(scenario.actor);
    expect(firstCycle).toHaveLength(1);
    const [firstNotice] = firstCycle;
    if (!firstNotice) {
      throw new Error("Expected a runtime disable notification");
    }
    expectDisableNotice(
      await readNotification(scenario.actor, firstNotice.id),
      scenario,
      disabledAt,
    );

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
    ).toStrictEqual([firstNotice.id]);

    const enabled = await accept(
      automationsClient().enable({
        headers: authHeaders(scenario.actor),
        params: { id: scenario.automationId },
      }),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
    for (const failure of [1, 2, 3]) {
      await completeFailedOccurrence(scenario);
      expect((await readAutomation(scenario)).enabled).toBe(failure < 3);
      await expect(inbox(scenario.actor)).resolves.toHaveLength(
        failure < 3 ? 1 : 2,
      );
    }
    const secondCycle = await inbox(scenario.actor);
    const secondNotice = secondCycle.find((item) => {
      return item.id !== firstNotice.id;
    });
    if (!secondNotice) {
      throw new Error(
        "Expected a distinct notification for the new failure cycle",
      );
    }
    expectDisableNotice(
      await readNotification(scenario.actor, secondNotice.id),
      scenario,
      new Date(now()).toISOString(),
    );
    await expect(unreadCount(scenario.actor)).resolves.toBe(2);
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
    const runnerGroup = runs.configureRunnerGroup();
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
    await notificationSwitches(actor, true);
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
      await expect(unreadCount(actor)).resolves.toBe(0);
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
    expectDisableNotice(
      await readNotification(actor, notice.id),
      scenario,
      disabledAt,
      true,
    );
    await expect(unreadCount(actor)).resolves.toBe(1);

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
    await expect(unreadCount(actor)).resolves.toBe(1);
    await expect(readAutomation(scenario)).resolves.toMatchObject({
      enabled: false,
      nextRunAt: disabled.nextRunAt,
    });
    const peer = workflows.user({ orgId: actor.orgId });
    await notificationSwitches(peer, true);
    await expect(inbox(peer)).resolves.toStrictEqual([]);
    await accept(
      notificationsClient().get({
        headers: authHeaders(peer),
        params: { id: notice.id },
      }),
      [404],
    );
  });

  it.each([
    { writerEnabled: false, inboxEnabled: true },
    { writerEnabled: true, inboxEnabled: false },
  ])(
    "does not emit with writer=$writerEnabled/inbox=$inboxEnabled or for an owner-requested stop",
    async ({ writerEnabled, inboxEnabled }) => {
      await setupApp({
        context,
        routes: cronExecuteWorkflowAutomationsRoutes,
        isolatePg: true,
      });
      const scenario = await createScenario({ notifications: writerEnabled });
      await notificationSwitches(scenario.actor, writerEnabled, inboxEnabled);
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
      for (const failure of [1, 2, 3]) {
        const automation = await fireNextOccurrence(scenario, true);
        await expectPreRunRejections(scenario, automation, failure);
        expect(automation.enabled).toBe(failure < 3);
      }
      if (!inboxEnabled) {
        await accept(
          notificationsClient().list({ headers: authHeaders(scenario.actor) }),
          [403],
        );
        await notificationSwitches(scenario.actor, writerEnabled);
      }
      await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
      await expect(unreadCount(scenario.actor)).resolves.toBe(0);

      await notificationSwitches(scenario.actor, true);
      await accept(
        automationsClient().enable({
          headers: authHeaders(scenario.actor),
          params: { id: scenario.automationId },
        }),
        [200],
      );
      const resumed = await fireNextOccurrence(scenario, true);
      await expectPreRunRejections(scenario, resumed, 4);
      expect(resumed.enabled).toBeTruthy();
      expect(resumed.nextRunAt).not.toBeNull();
      await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
      const stopped = await accept(
        automationsClient().disable({
          headers: authHeaders(scenario.actor),
          params: { id: scenario.automationId },
        }),
        [200],
      );
      expect(stopped.body).toMatchObject({ enabled: false, nextRunAt: null });
      await executeCron();
      await expect(inbox(scenario.actor)).resolves.toStrictEqual([]);
      await expect(unreadCount(scenario.actor)).resolves.toBe(0);
    },
  );
});
