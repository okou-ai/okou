import { cronExecuteWorkflowAutomationsContract } from "@okouai/api-contracts/contracts/cron";
import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";
import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
  morningBriefPreferenceContract,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { debugMorningBriefRoutes } from "../debug-morning-brief";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { claimBudgetRun } from "./helpers/public-autonomy-budget";
import { publicChatActor } from "./helpers/public-chat-actor";

import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { proactiveLearningContract } from "@okouai/api-contracts/contracts/proactive-nightly";
import { proactiveJobsContract } from "@okouai/api-contracts/contracts/proactive-jobs";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import {
  proactiveLearningRoutes,
  proactiveJobsRoutes,
  proactiveSuggestionsRoutes,
} from "../proactive-preferences";

import { userPreferencesRoutes } from "../user-preferences";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";

import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const CRON_SECRET = "official-workflow-installation-cron-secret";

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function executeAutomationCron() {
  return await accept(
    setupApp({ context, routes: cronExecuteWorkflowAutomationsRoutes })(
      cronExecuteWorkflowAutomationsContract,
    ).execute({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
}

async function fireSchedule(
  actor: ApiTestUser,
  automation: Pick<WorkflowAutomationSummary, "id" | "nextRunAt"> &
    Partial<Pick<WorkflowAutomationSummary, "chatThreadId">>,
) {
  if (!automation.nextRunAt) {
    throw new Error("Expected a scheduled automation");
  }
  await withMockNowForTest(
    new Date(automation.nextRunAt).getTime(),
    async () => {
      await executeAutomationCron();
      await flushWaitUntilForTest();
    },
  );
  const chatThreadId =
    automation.chatThreadId ??
    (
      await accept(
        automationClient().get({
          headers: authHeaders(actor),
          params: { id: automation.id },
        }),
        [200],
      )
    ).body.chatThreadId;
  if (!chatThreadId) {
    throw new Error("Expected the automation thread");
  }
  const runId = await launchedAutomationRunId(actor, chatThreadId);
  if (!runId) {
    throw new Error("Expected the scheduled automation Run");
  }
  return { chatThreadId, runId };
}

async function runScheduleNow(actor: ApiTestUser, automationId: string) {
  const queued = await accept(
    automationClient().run({
      headers: authHeaders(actor),
      params: { id: automationId },
    }),
    [201],
  );
  const runId = await launchedAutomationRunId(actor, queued.body.chatThreadId);
  if (!runId) {
    throw new Error("Expected the manually launched automation Run");
  }
  return { runId };
}

function morningBriefPreferenceClient() {
  return setupApp({ context, routes: morningBriefPreferenceRoutes })(
    morningBriefPreferenceContract,
  );
}

function workflowClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function workflowCollectionClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsCollectionContract,
  );
}

function automationClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

async function allThreadEventRows(actor: ApiTestUser, chatThreadId: string) {
  const rows = await chat.listThreadEventRows(actor, chatThreadId);
  let page = rows;
  // The endpoint caps each page at 50; a 32-hop chain spans multiple pages.
  while (page.length === 50) {
    const last = page.at(-1);
    if (!last) {
      throw new Error("Expected a cursor on a full event page");
    }
    page = await chat.listThreadEventRows(actor, chatThreadId, {
      lastEventId: last.id,
      lastSeqId: last.seqId,
    });
    rows.push(...page);
  }
  return rows;
}

/**
 * Run now only enqueues; the background pick launches the run. Flush the pick
 * and read the newest launched run from the automation thread.
 */
async function launchedAutomationRunId(
  actor: ApiTestUser,
  chatThreadId: string,
): Promise<string | undefined> {
  await flushWaitUntilForTest();
  const events = await allThreadEventRows(actor, chatThreadId);
  const launched = [...events].reverse().find((event) => {
    return event.eventType === "input.prompt" && event.runId;
  });
  return launched?.runId ?? undefined;
}

async function deliverClerkOrganizationCreated(
  actor: ApiTestUser,
  createdAt: Date,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: {
      id: actor.orgId,
      created_by: actor.userId,
      created_at: createdAt.getTime(),
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function listMorningBriefInstallations(actor: ApiTestUser) {
  const response = await accept(
    setupApp({
      context,
      routes: workflowsRoutes.filter(({ route }) => {
        return route === workflowsCollectionContract.list;
      }),
    })(workflowsCollectionContract).list({
      headers: authHeaders(actor),
      query: {},
    }),
    [200],
  );
  return response.body.filter((workflow) => {
    return MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.some((name) => {
      return name === workflow.official?.definitionName;
    });
  });
}

async function ordinaryDelegationScenario() {
  const owned = await publicChatActor(context);
  return await owned.run(async () => {
    await runs.updateUserModelPreference(owned.actor, "claude-fable-5-1");
    const workflowId = await workflowBdd.createWorkflow(owned.actor, {
      agentId: owned.agentId,
      name: `ordinary-delegation-${randomUUID().slice(0, 8)}`,
    });
    const detail = await accept(
      workflowClient().get({
        headers: authHeaders(owned.actor),
        params: { workflowId },
      }),
      [200],
    );
    const sent = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Delegate a workflow",
    });
    const source = await claimBudgetRun(context, owned, sent);
    return { owned, actor: owned.actor, workflow: detail.body, source };
  });
}

beforeEach(() => {
  mockEnv("CRON_SECRET", CRON_SECRET);
});

describe("Workflow schedules", () => {
  it("launches a due user-created schedule through the automation cron", async () => {
    const app = await setupApp({
      context,
      routes: workflowAutomationsRoutes,
      isolatePg: true,
    });
    mockNow(new Date("2030-01-01T12:00:00.000Z"));
    const { actor, defaultAgentId } = await workflowBdd.setupWorkflowOrg({
      timezone: "UTC",
    });
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.heartbeatRunner(runnerGroup);
    const workflowId = await workflowBdd.createWorkflow(actor, {
      agentId: defaultAgentId,
      name: "scheduled-report",
      visibility: "private",
      instruction: "Prepare my scheduled report.",
    });
    const automation = (
      await accept(
        app(workflowAutomationsContract).create({
          headers: authHeaders(actor),
          params: { workflowId },
          body: {
            schedule: {
              type: "cron",
              cronExpression: "* * * * *",
              timezone: "UTC",
            },
          },
        }),
        [201],
      )
    ).body;
    const started = await fireSchedule(actor, automation);
    const claim = await runs.claimRunnerJob(started.runId);
    expect(claim.prompt).toContain("scheduled-report");
  });
});

describe("Planning and action preference", () => {
  it("preserves the combined choice independently of Learning and Suggestions", async () => {
    const app = setupApp({
      context,
      routes: [
        ...proactiveJobsRoutes,
        ...proactiveLearningRoutes,
        ...proactiveSuggestionsRoutes,
      ],
    });
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.ProactiveAgent]: true,
        [FeatureSwitchKey.AgentSuggestion]: true,
      },
    );
    const client = app(proactiveJobsContract);
    for (const independent of [
      app(proactiveLearningContract),
      app(proactiveSuggestionsContract),
    ]) {
      await accept(
        independent.update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
    }
    const initial = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(initial.body).toMatchObject({ enabled: false, status: "paused" });
    await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    const saved = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(saved.body.enabled).toBeTruthy();
    const paused = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: false } }),
      [200],
    );
    expect(paused.body).toMatchObject({ enabled: false, status: "paused" });
    for (const independent of [
      app(proactiveLearningContract),
      app(proactiveSuggestionsContract),
    ]) {
      const preference = await accept(
        independent.get({ headers: authHeaders(actor) }),
        [200],
      );
      expect(preference.body.enabled).toBeTruthy();
    }
  });

  it("keeps an opt-in cancellable while the planning time zone is unavailable", async () => {
    const app = setupApp({
      context,
      routes: proactiveJobsRoutes,
    });
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor);
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.ProactiveAgent]: true },
    );
    const client = app(proactiveJobsContract);
    const pending = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    expect(pending.body).toMatchObject({
      enabled: true,
      status: "preparing",
      unavailableReason: "missing-timezone",
    });
    const cancelled = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: false } }),
      [200],
    );
    expect(cancelled.body).toMatchObject({ enabled: false, status: "paused" });
    await bdd.updateUserTimezone(actor, "Asia/Shanghai");
    const saved = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(saved.body).toMatchObject({
      enabled: false,
      status: "paused",
      unavailableReason: null,
    });
  });
});

describe("Proactive Suggestions preference", () => {
  it("keeps the independent Suggestions choice while the catalog is unavailable", async () => {
    const app = setupApp({
      context,
      routes: [...proactiveSuggestionsRoutes, ...proactiveJobsRoutes],
    });
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor);
    const client = app(proactiveSuggestionsContract);
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.ProactiveAgent]: true,
        [FeatureSwitchKey.AgentSuggestion]: false,
      },
    );
    await accept(client.get({ headers: authHeaders(actor) }), [403]);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.ProactiveAgent]: false,
        [FeatureSwitchKey.AgentSuggestion]: true,
      },
    );
    await accept(
      app(proactiveJobsContract).get({ headers: authHeaders(actor) }),
      [403],
    );
    const initial = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(initial.body).toMatchObject({ enabled: false, status: "paused" });
    const pending = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    expect(pending.body).toMatchObject({ enabled: true, status: "preparing" });
    const morning = await accept(
      morningBriefPreferenceClient().get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(morning.body.enabled).toBeFalsy();
    const saved = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(saved.body.enabled).toBeTruthy();
    const cancelled = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: false } }),
      [200],
    );
    expect(cancelled.body).toMatchObject({ enabled: false, status: "paused" });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.ProactiveAgent]: true,
        [FeatureSwitchKey.AgentSuggestion]: false,
      },
    );
    await accept(client.get({ headers: authHeaders(actor) }), [403]);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.ProactiveAgent]: false,
        [FeatureSwitchKey.AgentSuggestion]: true,
      },
    );
    const restored = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(restored.body.enabled).toBeFalsy();
  });
});

describe("Morning Brief preference", () => {
  it("preserves enable intent while timezone is unavailable", async () => {
    const missingTimezone = await workflowBdd.setupWorkflowOrg();
    const timezoneHeaders = authHeaders(missingTimezone.actor);
    const unavailableTimezone = await accept(
      morningBriefPreferenceClient().get({ headers: timezoneHeaders }),
      [200],
    );
    expect(unavailableTimezone.body).toMatchObject({
      enabled: false,
      unavailableReason: "missing-timezone",
    });
    const rejectedTimezone = await accept(
      morningBriefPreferenceClient().update({
        headers: timezoneHeaders,
        body: { enabled: true },
      }),
      [200],
    );
    expect(rejectedTimezone.body).toMatchObject({
      status: "preparing",
      enabled: true,
      unavailableReason: "missing-timezone",
    });

    const listed = await accept(
      workflowCollectionClient().list({
        headers: authHeaders(missingTimezone.actor),
        query: {},
      }),
      [200],
    );
    expect(
      listed.body.filter((workflow) => {
        return MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.some((name) => {
          return name === workflow.official?.definitionName;
        });
      }),
    ).toHaveLength(0);
  });
});

function mockBriefMemberships(
  entries: readonly {
    readonly actor: ApiTestUser;
    readonly createdAt: Date;
  }[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: entries.map(({ actor, createdAt }) => {
        return {
          id: `membership-${actor.userId}-${actor.orgId}`,
          role: actor.orgRole ?? "org:member",
          createdAt: createdAt.getTime(),
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        };
      }),
    },
  );
}

async function initializeBriefMember(actor: ApiTestUser, timezone: string) {
  return await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(actor),
      body: { timezone, locale: "en-US" },
    }),
    [200],
  );
}

async function prepareBriefMember() {
  const actor = bdd.user();
  const createdAt = new Date("2030-01-01T00:00:00.000Z");
  mockBriefMemberships([{ actor, createdAt }]);
  await deliverClerkOrganizationCreated(actor, createdAt);
  return { actor };
}

describe("Workflow schedule recovery", () => {
  async function failManualScheduleRun(
    actor: ApiTestUser,
    automation: WorkflowAutomationSummary,
  ) {
    const fired = await runScheduleNow(actor, automation.id);
    const claim = await runs.claimRunnerJob(fired.runId);
    await webhooks.requestAgentComplete(
      {
        runId: fired.runId,
        exitCode: 1,
        error: "Managed provider temporarily unavailable",
      },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    return (
      await accept(
        automationClient().get({
          headers: authHeaders(actor),
          params: { id: automation.id },
        }),
        [200],
      )
    ).body;
  }

  it("completes an in-flight user schedule using its edited recurrence", async () => {
    mockNow(new Date("2030-01-01T00:00:00.000Z"));
    const client = automationClient();
    const { actor, defaultAgentId } = await workflowBdd.setupWorkflowOrg({
      timezone: "UTC",
    });
    const workflowId = await workflowBdd.createWorkflow(actor, {
      agentId: defaultAgentId,
      name: "edited-in-flight-schedule",
    });
    const automation = (
      await accept(
        client.create({
          headers: authHeaders(actor),
          params: { workflowId },
          body: { schedule: { type: "loop", intervalSeconds: 600 } },
        }),
        [201],
      )
    ).body;
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const [fired] = await Promise.all([
      runScheduleNow(actor, automation.id),
      runs.heartbeatRunner(runnerGroup),
    ]);
    const claim = await runs.claimRunnerJob(fired.runId);
    expect(claim.cliAgentType).toBe("claude-code");
    mockNow(new Date("2030-01-01T00:10:00.000Z"));
    const schedule = {
      type: "cron" as const,
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
    };
    const edited = await accept(
      client.update({
        headers: authHeaders(actor),
        params: { id: automation.id },
        body: { schedule },
      }),
      [200],
    );
    expect(edited.body).toMatchObject({
      schedule,
      nextRunAt: "2030-01-01T00:15:00.000Z",
    });
    mockNow(new Date("2030-01-01T00:16:00.000Z"));
    await createChatEventsFixture(context).completeChatRunOk(fired.runId, {
      authorization: `Bearer ${claim.sandboxToken}`,
    });
    await flushWaitUntilForTest();
    const completed = await accept(
      client.get({
        headers: authHeaders(actor),
        params: { id: automation.id },
      }),
      [200],
    );
    expect(completed.body).toMatchObject({
      enabled: true,
      schedule,
      nextRunAt: "2030-01-01T00:20:00.000Z",
    });
  });

  it("stops a user-created schedule after three failed manual runs", async () => {
    const startedAt = Date.parse("2030-01-01T00:00:00.000Z");
    mockNow(startedAt);
    const client = automationClient();
    const { actor, defaultAgentId } = await workflowBdd.setupWorkflowOrg({
      timezone: "UTC",
    });
    const workflowId = await workflowBdd.createWorkflow(actor, {
      agentId: defaultAgentId,
      name: "user-managed-schedule",
    });
    let automation = (
      await accept(
        client.create({
          headers: authHeaders(actor),
          params: { workflowId },
          body: { schedule: { type: "loop", intervalSeconds: 600 } },
        }),
        [201],
      )
    ).body;
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    await runs.heartbeatRunner(runnerGroup);
    for (let failure = 0; failure < 3; failure += 1) {
      // Each user retry has its own request time rather than replaying one click.
      mockNow(startedAt + (failure + 1) * 60_000);
      automation = await failManualScheduleRun(actor, automation);
    }
    expect(automation).toMatchObject({ enabled: false, nextRunAt: null });
  });
});

describe("Morning Brief initialization", () => {
  it("keeps recovery of an absent brief free of installation side effects", async () => {
    const app = setupApp({
      context,
      routes: morningBriefPreferenceRoutes,
    });
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Tokyo");
    await bdd.updateUserTimezone(actor, "Asia/Shanghai");
    const result = await accept(
      app(morningBriefPreferenceContract).retry({
        headers: authHeaders(actor),
      }),
      [200],
    );
    expect(result.body).toMatchObject({ enabled: false, status: "paused" });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
  });

  it("keeps an explicit timezone choice when initialization runs later", async () => {
    const app = setupApp({
      context,
      routes: userPreferencesRoutes,
    });
    const { actor } = await prepareBriefMember();
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    const initialized = await initializeBriefMember(
      actor,
      "America/Los_Angeles",
    );
    expect(initialized.body.timezone).toBe("Asia/Tokyo");
    const saved = await accept(
      app(userPreferencesContract).get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(saved.body.timezone).toBe("Asia/Tokyo");
  });
});

describe("Debug Morning Brief", () => {
  it("requires a signed-in session and Okou Debug", async () => {
    const app = setupApp({
      context,
      routes: debugMorningBriefRoutes,
    });
    const anonymous = await accept(
      app(debugMorningBriefContract).run({ body: { requestId: randomUUID() } }),
      [401],
    );
    expect(anonymous.status).toBe(401);
    await accept(
      app(debugMorningBriefContract).get({ params: { id: randomUUID() } }),
      [401],
    );
    const { actor } = await workflowBdd.setupWorkflowOrg();
    if (!actor.orgId) {
      throw new Error("Expected a workspace");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.OkouDebug]: false },
    );
    await accept(
      app(debugMorningBriefContract).run({
        headers: authHeaders(actor),
        body: { requestId: randomUUID() },
      }),
      [403],
    );
    await accept(
      app(debugMorningBriefContract).get({
        headers: authHeaders(actor),
        params: { id: randomUUID() },
      }),
      [403],
    );
  });
});

describe("Workflow Run admission", () => {
  it("selects current ordinary Workflows when a queued Run is claimed", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(() => {
      return fixture.api.updateUserModelPreference(
        owned.actor,
        "claude-fable-5-1",
      );
    });
    const published = [];
    for (const name of ["first", "retained"]) {
      const instruction = `Read the ${name} publication.`;
      const workflowId = await owned.run(() => {
        return workflowBdd.createWorkflow(owned.actor, {
          agentId: owned.agentId,
          name: `published-${name}-${randomUUID().slice(0, 8)}`,
          instruction,
        });
      });
      published.push({ workflowId, instruction });
    }
    const firstWorkflow = published[0];
    if (!firstWorkflow) {
      throw new Error("Expected the first Workflow");
    }
    const first = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use available Workflows",
    });
    const revised = "Read the revised first publication.";
    await owned.run(() => {
      return accept(
        workflowClient().update({
          headers: authHeaders(owned.actor),
          params: { workflowId: firstWorkflow.workflowId },
          body: { instruction: revised, files: [] },
        }),
        [200],
      );
    });
    for (const run of [first, null]) {
      const current =
        run ??
        (await owned.sendChatRun(owned.actor, {
          agentId: owned.agentId,
          prompt: "Use current Workflows again",
        }));
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        current.runId,
      );
      const skills = claim.storageManifest?.workflowSkills;
      expect(skills).toHaveLength(2);
      for (const workflow of published) {
        expect(
          (
            await runs.downloadWorkflow(
              current.runId,
              workflow.workflowId,
              claim.sandboxToken,
            )
          ).skillMd,
        ).toContain(
          workflow.workflowId === firstWorkflow.workflowId
            ? revised
            : workflow.instruction,
        );
      }
      await owned.run(() => {
        return fixture.failChatRun(
          current.runId,
          sandboxHeaders,
          "Workflow documents inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    }
  });

  it("launches an idle ordinary workflow input with source annotations", async () => {
    const { owned, actor, workflow, source } =
      await ordinaryDelegationScenario();
    const sourceRunId = source.runId;
    const sourceThreadId = source.threadId;
    await owned.run(async () => {
      const launched = await accept(
        workflowClient().run({
          headers: { authorization: `Bearer ${source.token}` },
          extraHeaders: { origin: "https://app.okou.ai" },
          params: { workflowId: workflow.id },
        }),
        [200],
      );
      expect(launched.body.runId).toBeNull();
      const launchedRunId = await launchedAutomationRunId(
        actor,
        launched.body.chatThreadId,
      );
      if (!launchedRunId) {
        throw new Error(
          "Expected the idle ordinary workflow input to dispatch itself",
        );
      }
      expect(launchedRunId).not.toBe(sourceRunId);
      expect(launched.body.chatThreadId).not.toBe(sourceThreadId);
      const { claim } = await owned.claimChatRun(
        owned.runnerGroup,
        launchedRunId,
      );
      expect(claim.prompt).toBe(`/${workflow.name}`);
      expect(claim.appendSystemPrompt).toContain(
        `SOURCE_RUN_ID: ${sourceRunId}`,
      );
      expect(claim.appendSystemPrompt).toContain(
        `SOURCE_THREAD_ID: ${sourceThreadId}`,
      );
    });
  });
});
