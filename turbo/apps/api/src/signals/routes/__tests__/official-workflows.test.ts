import { createProactiveCronApi } from "./helpers/proactive-cron";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { runDataRouterRequestContract } from "@okouai/api-contracts/contracts/data-router";
import { http, HttpResponse } from "msw";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { billingStatusRoutes } from "../billing-status";
import { webhooksAgentDataRequestRoutes } from "../webhooks-agent-data-request";
import { notificationsContract } from "@okouai/api-contracts/contracts/notifications";
import { notificationsRoutes } from "../notifications";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import {
  cronCleanupSandboxesContract,
  cronProactiveContract,
  cronExecuteWorkflowAutomationsContract,
} from "@okouai/api-contracts/contracts/cron";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { cronProactiveRoutes } from "../cron-proactive";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";
import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
  morningBriefPreferenceContract,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { debugMorningBriefRoutes } from "../debug-morning-brief";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { launchBudgetRun } from "./helpers/public-autonomy-budget";
import { publicChatActor } from "./helpers/public-chat-actor";

import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { feedRoutes } from "../feed";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";

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
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import { readExecutionContentBundle } from "./helpers/execution-content-bundle";

const context = testContext();
const bdd = createBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const cron = Object.freeze({ authorization: "Bearer test-cron-secret" });

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
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
  const owned = await publicChatActor(context, {});
  return await owned.run(async () => {
    await runs.updateUserModelPreference(owned.actor, "claude-fable-5-1");
    const workflowId = await workflowBdd.createWorkflow(owned.actor, {
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
      prompt: "Delegate a workflow",
    });
    const source = await launchBudgetRun(context, owned, sent);
    return { owned, actor: owned.actor, workflow: detail.body, source };
  });
}

describe("My Okou proactive settings", () => {
  it("sets hourly checks and new suggestion delivery together without changing other sources or legacy clients", async () => {
    const app = setupApp({
      context,
      routes: [...proactiveSuggestionsRoutes, ...feedRoutes],
    });
    const { actor } = await prepareBriefMember();
    const headers = authHeaders(actor);
    const hourly = app(proactiveSuggestionsContract);
    const feed = app(feedContract);
    expect(
      (await accept(hourly.get({ headers }), [200])).body.enabled,
    ).toBeFalsy();
    expect(
      (await accept(feed.sources({ headers }), [200])).body.suggestions,
    ).toBeTruthy();
    await accept(
      feed.updateSources({ headers, body: { offers: false } }),
      [200],
    );
    for (const enabled of [false, true]) {
      await accept(
        hourly.updateWithFeed({ headers, body: { enabled } }),
        [200],
      );
      expect((await accept(hourly.get({ headers }), [200])).body.enabled).toBe(
        enabled,
      );
      expect(
        (await accept(feed.sources({ headers }), [200])).body,
      ).toStrictEqual({
        suggestions: enabled,
        offers: false,
        whatsNew: true,
        systemUpdates: true,
      });
    }
    await accept(hourly.update({ headers, body: { enabled: false } }), [200]);
    expect(
      (await accept(feed.sources({ headers }), [200])).body.suggestions,
    ).toBeTruthy();
  });
});

describe("Daily profile learning through Suggestions", () => {
  it("keeps an opt-in cancellable while the Learning time zone is unavailable", async () => {
    const app = setupApp({
      context,
      routes: proactiveSuggestionsRoutes,
    });
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor);
    const client = app(proactiveSuggestionsContract);
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
  it("saves both Suggestions schedules without installing a Workflow or involving the automation cron", async () => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...proactiveSuggestionsRoutes,
        ...cronExecuteWorkflowAutomationsRoutes,
      ],
    });
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    const headers = authHeaders(actor);
    const settings = app(proactiveSuggestionsContract);
    const result = await accept(
      settings.update({ headers, body: { enabled: true } }),
      [200],
    );
    expect(result.body).toMatchObject({ enabled: true, status: "enabled" });
    const tick = await accept(
      app(cronExecuteWorkflowAutomationsContract).execute({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );
    expect(tick.body).toMatchObject({ executed: 0, skipped: 0 });
    const listed = await accept(
      workflowCollectionClient().list({ headers, query: {} }),
      [200],
    );
    expect(
      listed.body.filter((workflow) => {
        return workflow.official;
      }),
    ).toHaveLength(0);
  });

  it("clears the departed member's Suggestions opt-in", async () => {
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    const pref = setupApp({ context, routes: proactiveSuggestionsRoutes })(
      proactiveSuggestionsContract,
    );
    const headers = authHeaders(actor);
    const enabled = await accept(
      pref.update({ headers, body: { enabled: true } }),
      [200],
    );
    expect(enabled.body.status).toBe("enabled");
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        id: `membership-${actor.userId}-${actor.orgId}`,
        organization_id: actor.orgId,
        user_id: actor.userId,
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    const preference = await accept(
      pref.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(preference.body).toMatchObject({ enabled: false, status: "paused" });
  });

  it("keeps the Suggestions choice while the member has no timezone", async () => {
    const app = setupApp({
      context,
      routes: proactiveSuggestionsRoutes,
    });
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor);
    const client = app(proactiveSuggestionsContract);
    const initial = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(initial.body).toMatchObject({ enabled: false, status: "paused" });
    const pending = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    expect(pending.body).toMatchObject({
      enabled: true,
      status: "preparing",
      unavailableReason: "missing-timezone",
    });
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
  });
});

describe("Morning Brief preference", () => {
  it("preserves simultaneous first opt-ins and subsequent toggles without installing Morning Brief", async () => {
    const { actor } = await prepareBriefMember();
    await bdd.updateUserTimezone(actor, "Asia/Shanghai");
    const headers = authHeaders(actor);
    const preferences = morningBriefPreferenceClient();
    const setEnabled = (enabled: boolean) => {
      return accept(preferences.update({ headers, body: { enabled } }), [200]);
    };
    await Promise.all([setEnabled(true), setEnabled(true)]);
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
    expect(
      (await accept(preferences.get({ headers }), [200])).body,
    ).toMatchObject({ enabled: true, status: "enabled" });
    expect((await setEnabled(false)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    expect((await setEnabled(true)).body).toMatchObject({
      enabled: true,
      status: "enabled",
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
  });

  it("preserves enable intent while timezone is unavailable", async () => {
    const missingTimezone = await workflowBdd.setupWorkflowOrg();
    const timezoneHeaders = authHeaders(missingTimezone.actor);
    const unavailableTimezone = await accept(
      morningBriefPreferenceClient().get({ headers: timezoneHeaders }),
      [200],
    );
    expect(unavailableTimezone.body).toMatchObject({
      enabled: false,
      status: "paused",
      unavailableReason: null,
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

async function walletCredits(actor: ApiTestUser) {
  const wallet = await accept(
    setupApp({ context, routes: billingStatusRoutes })(
      billingStatusContract,
    ).get({ headers: authHeaders(actor) }),
    [200],
  );
  return wallet.body.credits;
}

/** Reconcile a provider-reported search charge through the sandbox and terminal webhook. */
async function completeWithSearchUsage(
  runId: string,
  headers: { authorization: string },
  credits: number,
) {
  const router = "https://data-router.test/mcp";
  mockEnv("OKOU_DATA_ROUTER_URL", router);
  mockEnv("OKOU_DATA_TOKEN", "router-test-service-token");
  const requestId = randomUUID();
  await accept(
    setupApp({ context, routes: webhooksAgentDataRequestRoutes })(
      runDataRouterRequestContract,
    ).register({ headers, body: { runId, requestId } }),
    [200],
  );
  let lookups = 0;
  server.use(
    http.post(router, () => {
      lookups++;
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: "usage",
        result: { structuredContent: { records: [{ requestId, credits }] } },
      });
    }),
  );
  await webhooks.requestAgentComplete({ runId, exitCode: 0 }, headers, [200]);
  await flushWaitUntilForTest();
  expect(lookups).toBe(1);
}

function proactiveCard() {
  const draft = {
    draftUserMessage: {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Review the update." }],
    },
    draftAttachments: null,
  };
  return {
    id: randomUUID(),
    type: "suggestion" as const,
    priority: 1,
    content: {
      title: "Review the agenda",
      rationale: "The agenda needs a decision.",
      options: [
        {
          id: "review",
          label: "Review",
          description: "Review the meeting agenda.",
          threadId: null,
          draft,
        },
      ],
      customOption: {
        id: "custom" as const,
        threadId: null,
        draft: {
          draftUserMessage: {
            version: 1 as const,
            parts: [
              {
                type: "feedback" as const,
                quote: "Review the meeting agenda.",
                note: [],
              },
            ],
          },
          draftAttachments: null,
        },
      },
    },
  };
}

describe("Standalone proactive dispatch", () => {
  it("drains globally, preserves choices saved during the handoff and skips an inactive member's original slot", async () => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronProactiveRoutes,
        ...morningBriefPreferenceRoutes,
        ...proactiveSuggestionsRoutes,
        ...cronExecuteWorkflowAutomationsRoutes,
      ],
    });
    const client = app(cronProactiveContract);
    const start = Date.UTC(2030, 0, 2, 0, 0);
    mockNow(start);
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    const headers = authHeaders(actor);
    const brief = app(morningBriefPreferenceContract);
    await accept(brief.update({ headers, body: { enabled: true } }), [200]);
    await accept(
      app(proactiveSuggestionsContract).update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    const installed = await accept(
      workflowCollectionClient().list({ headers, query: {} }),
      [200],
    );
    expect(
      installed.body.filter((workflow) => {
        return workflow.official;
      }),
    ).toHaveLength(0);
    await accept(
      client.handoff({ headers: {}, body: { action: "drain", apply: true } }),
      [401],
    );
    await accept(client.compare({ headers: {} }), [401]);
    const preview = await accept(
      client.handoff({
        headers: cron,
        body: { action: "drain", apply: false },
      }),
      [200],
    );
    expect(preview.body).toMatchObject({
      phase: "automation",
      ready: true,
      changed: false,
    });
    const drained = await accept(
      client.handoff({ headers: cron, body: { action: "drain", apply: true } }),
      [200],
    );
    expect(drained.body).toMatchObject({
      phase: "draining",
      changed: true,
      copied: 0,
    });
    await accept(brief.update({ headers, body: { enabled: false } }), [200]);
    const early = await accept(
      client.handoff({
        headers: cron,
        body: { action: "activate", apply: true },
      }),
      [200],
    );
    expect(early.body).toMatchObject({ phase: "draining", ready: false });
    mockNow(start + 5 * 60_000 - 1);
    expect(
      (await accept(client.compare({ headers: cron }), [200])).body,
    ).toMatchObject({ phase: "draining" });
    mockNow(start + 65 * 60_000);
    await accept(
      app(cronExecuteWorkflowAutomationsContract).execute({ headers: cron }),
      [200],
    );
    expect(
      (await accept(client.compare({ headers: cron }), [200])).body,
    ).toMatchObject({ phase: "standalone", inactive: 1, enqueued: 0 });
    expect((await accept(brief.get({ headers }), [200])).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    expect(
      (await accept(client.compare({ headers: cron }), [200])).body,
    ).toMatchObject({ phase: "standalone", inactive: 0, enqueued: 0 });
  });

  it("reuses the hidden thread across mornings and honors the delivery rights captured at each start", async () => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronProactiveRoutes,
        ...cronExecuteWorkflowAutomationsRoutes,
        ...cronCleanupSandboxesRoutes,
        ...morningBriefPreferenceRoutes,
        ...proactiveSuggestionsRoutes,
        ...feedRoutes,
        ...notificationsRoutes,
      ],
    });
    let clockTime = Date.UTC(2030, 0, 2, 4);
    mockNow(clockTime);
    const owned = await publicChatActor(context, {
      // This owner's hourly Suggestions slot falls at 06:59 UTC.
      actor: bdd.user({
        userId: "user_ts_ci_morning_5",
        orgId: "org_ts_ci_morning_fixture",
      }),
      clockTime: () => {
        return clockTime;
      },
    });
    const { actor } = owned;
    const headers = authHeaders(actor);
    await launchBudgetRun(
      context,
      owned,
      await owned.sendChatRun(actor, {
        prompt: "Prepare for this week's meetings.",
      }),
    );
    installWorkflowVolumeS3Fixture(context);
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    const brief = app(morningBriefPreferenceContract);
    const suggestions = app(proactiveSuggestionsContract);
    await accept(
      suggestions.updateWithFeed({ headers, body: { enabled: false } }),
      [200],
    );
    await accept(brief.update({ headers, body: { enabled: true } }), [200]);
    const scheduled = createProactiveCronApi(context);
    await scheduled.activate();
    clockTime = Date.UTC(2030, 0, 2, 6, 59);
    mockNow(clockTime);
    await owned.run(() => {
      return runs.registerDirectRunner(owned.runnerGroup);
    });
    await expect(scheduled.dispatch()).resolves.toMatchObject({ enqueued: 1 });
    const first = await scheduled.latestRun(actor, "Morning Brief");
    const earlier = await owned.runExecution(first);
    const threadId = earlier.execution.platformEnvironment.OKOU_CHAT_THREAD_ID;
    if (!threadId) {
      throw new Error("Expected the Morning Brief thread");
    }
    await expect(
      chat.readThreadMetadata(actor, threadId),
    ).resolves.toMatchObject({ hidden: true });
    expect(earlier.execution.piSessionId).toBe(first);
    const modelEdit = await chat.requestUpdateThreadModelSelection(
      actor,
      threadId,
      "claude-fable-5-1",
      [400],
    );
    expect(modelEdit.body).toMatchObject({
      error: { message: "Platform task threads use Auto" },
    });
    const firstHeaders = {
      authorization: `Bearer ${earlier.execution.platformEnvironment.OKOU_TOKEN}`,
    };
    await accept(
      app(feedContract).create({
        headers: firstHeaders,
        body: proactiveCard(),
      }),
      [403],
    );
    await webhooks.requestAgentComplete(
      { runId: first, exitCode: 0 },
      earlier.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    // Enable Suggestions at the dispatch time so its first slot is in the future.
    clockTime += 24 * 60 * 60_000;
    mockNow(clockTime);
    await accept(
      suggestions.updateWithFeed({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    await owned.run(() => {
      return runs.registerDirectRunner(owned.runnerGroup);
    });
    await expect(scheduled.dispatch()).resolves.toMatchObject({ enqueued: 1 });
    const second = await launchedAutomationRunId(actor, threadId);
    if (!second || second === first) {
      throw new Error(
        "Standalone Morning Brief must reuse its original conversation",
      );
    }
    const { execution, sandboxHeaders } = await owned.runExecution(second);
    expect(execution.piSessionId).toBe(second);
    expect(execution.nativeContinuation).toStrictEqual({
      sessionId: null,
      generationRunId: null,
      recoveryPrompt: null,
    });
    expect(execution.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(threadId);
    const agentHeaders = {
      authorization: `Bearer ${execution.platformEnvironment.OKOU_TOKEN}`,
    };
    await accept(
      brief.update({ headers: authHeaders(actor), body: { enabled: false } }),
      [200],
    );
    await accept(
      suggestions.updateWithFeed({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
    await accept(
      app(feedContract).create({
        headers: agentHeaders,
        body: proactiveCard(),
      }),
      [200],
    );
    const body = {
      to: "me" as const,
      kind: "morning-brief" as const,
      subject: "Morning Brief",
      text: "Your meeting agenda is ready.",
    };
    const sent = await accept(
      app(notificationsContract).mail({ headers: agentHeaders, body }),
      [200],
    );
    const replay = await accept(
      app(notificationsContract).mail({ headers: agentHeaders, body }),
      [200],
    );
    expect(replay.body).toMatchObject({
      notificationId: sent.body.notificationId,
      deduplicated: true,
    });
    const changed = await accept(
      app(notificationsContract).mail({
        headers: agentHeaders,
        body: { ...body, text: "A different brief for the same occurrence." },
      }),
      [409],
    );
    expect(changed.body.error.code).toBe("CONFLICT");
    await webhooks.requestAgentComplete(
      { runId: second, exitCode: 0 },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
  });

  it("claims one hourly slot across simultaneous ticks, cancels unstarted work after opting out and covers search credits on the next Run", async () => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronProactiveRoutes,
        ...proactiveSuggestionsRoutes,
        ...cronCleanupSandboxesRoutes,
        ...notificationsRoutes,
        ...feedRoutes,
      ],
    });
    const client = app(cronProactiveContract);
    const start = Date.UTC(2030, 0, 2, 9, 0);
    mockNow(start);
    let clockTime = start;
    const owned = await publicChatActor(context, {
      clockTime: () => {
        return clockTime;
      },
    });
    const { actor } = owned;
    const source = await owned.sendChatRun(actor, {
      prompt: "Review the day's work.",
    });
    await launchBudgetRun(context, owned, source);
    await accept(
      client.handoff({ headers: cron, body: { action: "drain", apply: true } }),
      [200],
    );
    mockNow(start + 5 * 60_000);
    const activated = await accept(
      client.handoff({
        headers: cron,
        body: { action: "activate", apply: true },
      }),
      [200],
    );
    expect(activated.body.phase).toBe("standalone");
    const choice = await accept(
      app(proactiveSuggestionsContract).update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    expect(choice.body.enabled).toBeTruthy();
    clockTime = start + 66 * 60_000;
    mockNow(clockTime);
    await owned.run(() => {
      return runs.registerDirectRunner(owned.runnerGroup);
    });
    const ticks = await Promise.all([
      client.compare({ headers: cron }),
      client.compare({ headers: cron }),
    ]);
    const enqueued = ticks.map((tick) => {
      if (tick.status !== 200 || !("enqueued" in tick.body)) {
        throw new Error("Expected standalone dispatcher");
      }
      return tick.body.enqueued;
    });
    expect(enqueued.sort()).toStrictEqual([0, 1]);
    const settings = app(proactiveSuggestionsContract);
    for (const enabled of [false, true]) {
      await accept(
        settings.update({ headers: authHeaders(actor), body: { enabled } }),
        [200],
      );
    }
    await accept(
      app(cronCleanupSandboxesContract).cleanup({ headers: cron }),
      [200],
    );
    await flushWaitUntilForTest();
    const reads = createRunReadsApi(context);
    const cancelled = await reads.requestListLogs(
      actor,
      { triggerSource: "proactive" },
      [200],
    );
    expect(cancelled.body.data).toHaveLength(0);
    clockTime += 60 * 60_000;
    mockNow(clockTime);
    await owned.run(() => {
      return runs.registerDirectRunner(owned.runnerGroup);
    });
    const replacement = await accept(client.compare({ headers: cron }), [200]);
    expect(replacement.body).toMatchObject({ enqueued: 1 });
    await accept(
      app(cronCleanupSandboxesContract).cleanup({ headers: cron }),
      [200],
    );
    await flushWaitUntilForTest();
    const logs = await createRunReadsApi(context).requestListLogs(
      actor,
      { triggerSource: "proactive" },
      [200],
    );
    expect(logs.body.data).toHaveLength(1);
    const run = logs.body.data[0];
    if (!run) {
      throw new Error("Expected the hourly Run");
    }
    const detail = await runs.readRun(actor, run.id);
    expect(detail.source.model).toBe("okou/proactive");
    const { execution, sandboxHeaders } = await owned.runExecution(run.id);
    const headers = {
      authorization: `Bearer ${execution.platformEnvironment.OKOU_TOKEN}`,
    };
    await accept(
      app(proactiveSuggestionsContract).updateWithFeed({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
    await accept(
      app(feedContract).create({ headers, body: proactiveCard() }),
      [200],
    );
    await accept(
      app(notificationsContract).mail({
        headers,
        body: {
          to: "me",
          kind: "morning-brief",
          subject: "Morning Brief",
          text: "Check today's meetings.",
        },
      }),
      [403],
    );
    const workflowList = await accept(
      workflowCollectionClient().list({
        headers: authHeaders(actor),
        query: {},
      }),
      [200],
    );
    expect(
      workflowList.body.filter((workflow) => {
        return workflow.official;
      }),
    ).toStrictEqual([]);
    const balance = await walletCredits(actor);
    expect(balance).toBeGreaterThan(0);
    await completeWithSearchUsage(run.id, sandboxHeaders, 7);
    await expect(walletCredits(actor)).resolves.toBe(balance);
  });
  it("starts nightly profile learning at zero balance, allows paid tools and rejects card and email publication", async () => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronProactiveRoutes,
        ...cronCleanupSandboxesRoutes,
        ...proactiveSuggestionsRoutes,
        ...notificationsRoutes,
        ...feedRoutes,
      ],
    });
    // This owner has a nightly 02:18 UTC slot and a separate hourly :48 slot.
    const actor = bdd.user({
      orgId: "org_proactive_balance",
      userId: "user_proactive_learning3",
    });
    let clockTime = Date.UTC(2030, 0, 2, 1, 59);
    mockNow(clockTime);
    const owned = await publicChatActor(context, {
      actor,
      clockTime: () => {
        return clockTime;
      },
    });
    const source = await owned.sendChatRun(actor, {
      prompt: "Prepare for today's profile review.",
    });
    const manual = await owned.runExecution(source.runId);
    const balance = await walletCredits(actor);
    expect(balance).toBeGreaterThan(0);
    await completeWithSearchUsage(source.runId, manual.sandboxHeaders, balance);
    await expect(walletCredits(actor)).resolves.toBe(0);
    const client = app(cronProactiveContract);
    await accept(
      client.handoff({ headers: cron, body: { action: "drain", apply: true } }),
      [200],
    );
    clockTime += 5 * 60_000;
    mockNow(clockTime);
    const active = await accept(
      client.handoff({
        headers: cron,
        body: { action: "activate", apply: true },
      }),
      [200],
    );
    expect(active.body.phase).toBe("standalone");
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    await accept(
      app(proactiveSuggestionsContract).updateWithFeed({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    clockTime = Date.UTC(2030, 0, 2, 2, 18);
    mockNow(clockTime);
    await owned.run(() => {
      return runs.registerDirectRunner(owned.runnerGroup);
    });
    const tick = await accept(client.compare({ headers: cron }), [200]);
    expect(tick.body).toMatchObject({ enqueued: 1 });
    await accept(
      app(cronCleanupSandboxesContract).cleanup({ headers: cron }),
      [200],
    );
    await flushWaitUntilForTest();
    const logs = await createRunReadsApi(context).requestListLogs(
      actor,
      { triggerSource: "proactive" },
      [200],
    );
    expect(logs.body.data).toHaveLength(1);
    const [run] = logs.body.data;
    if (!run) {
      throw new Error("Expected nightly profile learning");
    }
    const { execution, sandboxHeaders } = await owned.runExecution(run.id);
    expect(execution.prompt).toContain("# Proactive Learning");
    expect(execution.prompt).toContain("notes/user-profile.md");
    mockEnv("OKOU_DATA_ROUTER_URL", "https://data-router.test/mcp");
    mockEnv("OKOU_DATA_TOKEN", "router-test-service-token");
    const tool = await createFirewallApi(context).requestFirewallAuth(
      { authorization: `Bearer ${execution.firewallToken}` },
      {
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OKOU_DATA_TOKEN")}`,
        },
        firewallBillable: true,
      },
      [200],
    );
    expect(tool.body).toMatchObject({ resolvedSecrets: ["OKOU_DATA_TOKEN"] });
    const modelKey = await createFirewallApi(context).requestFirewallAuth(
      { authorization: `Bearer ${execution.firewallToken}` },
      {
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
        },
        firewallBillable: true,
      },
      [200],
    );
    expect(modelKey.body).toMatchObject({
      headers: {
        Authorization: "Bearer okou-fake-proactive-model-key-sentinel-8d2b6f41",
      },
      resolvedSecrets: ["OPENROUTER_API_KEY"],
    });
    const headers = {
      authorization: `Bearer ${execution.platformEnvironment.OKOU_TOKEN}`,
    };
    await accept(
      app(proactiveSuggestionsContract).updateWithFeed({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
    await accept(
      app(feedContract).create({ headers, body: proactiveCard() }),
      [403],
    );
    await accept(
      app(notificationsContract).mail({
        headers,
        body: {
          to: "me",
          kind: "morning-brief",
          subject: "Morning Brief",
          text: "Review the agenda.",
        },
      }),
      [403],
    );
    await completeWithSearchUsage(run.id, sandboxHeaders, 7);
    await expect(walletCredits(actor)).resolves.toBe(0);
    const settled = await accept(client.compare({ headers: cron }), [200]);
    expect(settled.body).toMatchObject({ enqueued: 0 });
    const setting = await accept(
      app(proactiveSuggestionsContract).get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(setting.body).toMatchObject({ enabled: false, status: "paused" });
  });
  it("recovers calendar tasks when onboarding supplies a timezone after the member opted in", async () => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronProactiveRoutes,
        ...morningBriefPreferenceRoutes,
        ...proactiveSuggestionsRoutes,
      ],
    });
    const client = app(cronProactiveContract);
    const start = Date.UTC(2030, 0, 2, 3);
    mockNow(start);
    const { actor } = await prepareBriefMember();
    await accept(
      client.handoff({ headers: cron, body: { action: "drain", apply: true } }),
      [200],
    );
    mockNow(start + 5 * 60_000);
    await accept(
      client.handoff({
        headers: cron,
        body: { action: "activate", apply: true },
      }),
      [200],
    );
    const brief = app(morningBriefPreferenceContract);
    const suggestions = app(proactiveSuggestionsContract);
    const headers = authHeaders(actor);
    const enable = { headers, body: { enabled: true } };
    const choices = await Promise.all([
      accept(brief.update(enable), [200]),
      accept(suggestions.update(enable), [200]),
    ]);
    for (const choice of choices) {
      expect(choice.body.unavailableReason).toBe("missing-timezone");
    }
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    await accept(client.compare({ headers: cron }), [200]);
    const preferences = await Promise.all([
      accept(brief.get({ headers }), [200]),
      accept(suggestions.get({ headers }), [200]),
    ]);
    for (const preference of preferences) {
      expect(preference.body).toMatchObject({
        enabled: true,
        status: "enabled",
        unavailableReason: null,
      });
    }
  });

  it("waits until the next regular hour after a third failed Run spans another scheduled slot", async () => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...cronProactiveRoutes,
        ...cronCleanupSandboxesRoutes,
        ...proactiveSuggestionsRoutes,
      ],
    });
    const client = app(cronProactiveContract);
    const start = Date.UTC(2030, 0, 2, 9);
    let clockTime = start;
    function at(time: number) {
      clockTime = time;
      mockNow(time);
    }
    at(start);
    // This member's hourly Suggestions are scheduled at :48.
    const actor = bdd.user({
      orgId: "org_proactive_balance",
      userId: "user_proactive_learning3",
    });
    const owned = await publicChatActor(context, {
      actor,
      clockTime: () => {
        return clockTime;
      },
    });
    const manual = await owned.sendChatRun(actor, {
      prompt: "Review today's work.",
    });
    await launchBudgetRun(context, owned, manual);
    await accept(
      client.handoff({ headers: cron, body: { action: "drain", apply: true } }),
      [200],
    );
    at(start + 5 * 60_000);
    await accept(
      client.handoff({
        headers: cron,
        body: { action: "activate", apply: true },
      }),
      [200],
    );
    const settings = app(proactiveSuggestionsContract);
    await accept(
      settings.update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    const reads = createRunReadsApi(context);
    for (let failure = 0; failure < 3; failure++) {
      at(start + (48 + failure * 60) * 60_000);
      await owned.run(() => {
        return runs.registerDirectRunner(owned.runnerGroup);
      });
      expect(
        (await accept(client.compare({ headers: cron }), [200])).body,
      ).toMatchObject({ enqueued: 1 });
      await accept(
        app(cronCleanupSandboxesContract).cleanup({ headers: cron }),
        [200],
      );
      await flushWaitUntilForTest();
      const history = await reads.requestListLogs(
        actor,
        { triggerSource: "proactive" },
        [200],
      );
      expect(history.body.data).toHaveLength(failure + 1);
      const latest = history.body.data[0];
      if (!latest) {
        throw new Error("Expected the queued Suggestions Run");
      }
      const { sandboxHeaders } = await owned.runExecution(latest.id);
      at(clockTime + (failure === 2 ? 65 : 1) * 60_000);
      await webhooks.requestAgentComplete(
        {
          runId: latest.id,
          exitCode: 1,
          error: "Managed provider temporarily unavailable",
        },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      expect(
        (await accept(client.compare({ headers: cron }), [200])).body,
      ).toMatchObject({ enqueued: 0 });
    }
    expect(
      (await accept(settings.get({ headers: authHeaders(actor) }), [200])).body,
    ).toMatchObject({ enabled: true, status: "error" });
    at(Date.UTC(2030, 0, 2, 13, 48));
    expect(
      (await accept(client.compare({ headers: cron }), [200])).body,
    ).toMatchObject({ enqueued: 1 });
  });

  it("reschedules an enabled Morning Brief when the member changes timezone and preserves a later opt-out", async () => {
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [...cronProactiveRoutes, ...morningBriefPreferenceRoutes],
    });
    const start = Date.UTC(2030, 0, 2, 3);
    mockNow(start);
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor);
    const cronClient = app(cronProactiveContract);
    await accept(
      cronClient.handoff({
        headers: cron,
        body: { action: "drain", apply: true },
      }),
      [200],
    );
    mockNow(start + 5 * 60_000);
    await accept(
      cronClient.handoff({
        headers: cron,
        body: { action: "activate", apply: true },
      }),
      [200],
    );
    const brief = app(morningBriefPreferenceContract);
    const headers = authHeaders(actor);
    const pending = await accept(
      brief.update({ headers, body: { enabled: true } }),
      [200],
    );
    expect(pending.body).toMatchObject({
      enabled: true,
      unavailableReason: "missing-timezone",
    });
    await bdd.updateUserTimezone(actor, "UTC");
    await bdd.updateUserTimezone(actor, "Asia/Shanghai");
    const ready = await accept(
      brief.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(ready.body).toMatchObject({ enabled: true, status: "enabled" });
    mockNow(Date.UTC(2030, 0, 2, 7));
    expect(
      (await accept(cronClient.compare({ headers: cron }), [200])).body,
    ).toMatchObject({ enqueued: 0, inactive: 0, expired: 0 });
    mockNow(Date.UTC(2030, 0, 2, 23));
    expect(
      (await accept(cronClient.compare({ headers: cron }), [200])).body,
    ).toMatchObject({ enqueued: 0, inactive: 1, expired: 0 });
    await accept(
      brief.update({ headers: authHeaders(actor), body: { enabled: false } }),
      [200],
    );
    await bdd.updateUserTimezone(actor, "UTC");
    expect(
      (await accept(brief.get({ headers: authHeaders(actor) }), [200])).body,
    ).toMatchObject({ enabled: false, status: "paused" });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
  });
});

describe("Workflow schedule recovery", () => {
  async function failManualScheduleRun(
    actor: ApiTestUser,
    automation: WorkflowAutomationSummary,
  ) {
    const fired = await runScheduleNow(actor, automation.id);
    const execution = await runs.executionInput(fired.runId);
    await webhooks.requestAgentComplete(
      {
        runId: fired.runId,
        exitCode: 1,
        error: "Managed provider temporarily unavailable",
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
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

  it("fires a user's morning-brief workflow on schedule and honors its edited recurrence", async () => {
    const pollApp = await setupApp({
      context,
      isolatePg: true,
      routes: cronExecuteWorkflowAutomationsRoutes,
    });
    mockNow(new Date("2030-01-01T00:00:00.000Z"));
    const client = automationClient();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "UTC",
    });
    const workflowId = await workflowBdd.createWorkflow(actor, {
      name: "morning-brief",
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
    const runnerGroup = await runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    mockNow(new Date("2030-01-01T00:10:00.000Z"));
    await runs.registerDirectRunner(runnerGroup);
    const poll = pollApp(cronExecuteWorkflowAutomationsContract);
    const tick = await accept(poll.execute({ headers: cron }), [200]);
    expect(tick.body.executed).toBe(1);
    const active = await accept(
      client.get({
        headers: authHeaders(actor),
        params: { id: automation.id },
      }),
      [200],
    );
    const runId = active.body.chatThreadId
      ? await launchedAutomationRunId(actor, active.body.chatThreadId)
      : undefined;
    if (!runId) {
      throw new Error("Expected the user's scheduled workflow Run");
    }
    const execution = await runs.executionInput(runId);
    expect(execution.cliAgentType).toBe("claude-code");
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
    await createChatEventsFixture(context).completeChatRunOk(runId, {
      authorization: `Bearer ${execution.sandboxToken}`,
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

  it("records manual runs for a user's proactive-learning workflow and stops it after three failures", async () => {
    const startedAt = Date.parse("2030-01-01T00:00:00.000Z");
    mockNow(startedAt);
    const client = automationClient();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "UTC",
    });
    const workflowId = await workflowBdd.createWorkflow(actor, {
      name: "proactive-learning",
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
    const runnerGroup = await runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    for (let failure = 0; failure < 3; failure += 1) {
      // Each user retry has its own request time rather than replaying one click.
      const firedAt = new Date(startedAt + (failure + 1) * 60_000);
      mockNow(firedAt);
      await runs.registerDirectRunner(runnerGroup);
      automation = await failManualScheduleRun(actor, automation);
      expect(automation.lastRunAt).toBe(firedAt.toISOString());
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
      app(debugMorningBriefContract).get({ params: { id: randomUUID() } }),
      [401],
    );
    expect(anonymous.status).toBe(401);
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
      app(debugMorningBriefContract).get({
        headers: authHeaders(actor),
        params: { id: randomUUID() },
      }),
      [403],
    );
  });
});

describe("Workflow Run admission", () => {
  it("captures ordinary Workflows at dispatch and applies edits to later Runs", async () => {
    const owned = await publicChatActor(context, {});
    const fixture = createChatEventsFixture(context);
    const s3 = installWorkflowVolumeS3Fixture(context);
    await owned.run(() => {
      return fixture.api.updateUserModelPreference(
        owned.actor,
        "claude-fable-5-1",
      );
    });
    const published = [];
    for (const name of ["first", "retained"]) {
      const instruction = `Read the ${name} publication.`;
      const workflowName = `published-${name}-${randomUUID().slice(0, 8)}`;
      const workflowId = await owned.run(() => {
        return workflowBdd.createWorkflow(owned.actor, {
          name: workflowName,
          instruction,
        });
      });
      published.push({ workflowId, workflowName, instruction });
    }
    const firstWorkflow = published[0];
    if (!firstWorkflow) {
      throw new Error("Expected the first Workflow");
    }
    const first = await owned.sendChatRun(owned.actor, {
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
          prompt: "Use current Workflows again",
        }));
      const { execution, sandboxHeaders } = await owned.runExecution(
        current.runId,
      );
      const skills = execution.startupInputs.contentBundles.skills;
      expect(skills).toHaveLength(2 + BUILT_IN_SKILLS.length);
      for (const workflow of published) {
        const skill = skills.find((item) => {
          return item.name === workflow.workflowName;
        });
        if (!skill) {
          throw new Error("Expected the current Workflow bundle");
        }
        expect(
          readExecutionContentBundle(s3.objects, skill.bundle)
            .get("SKILL.md")
            ?.toString(),
        ).toContain(
          workflow.workflowId === firstWorkflow.workflowId && run === null
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
      const { execution } = await owned.runExecution(launchedRunId);
      expect(execution.prompt).toBe(`/${workflow.name}`);
      expect(execution.appendSystemPrompt).toContain(
        `SOURCE_RUN_ID: ${sourceRunId}`,
      );
      expect(execution.appendSystemPrompt).toContain(
        `SOURCE_THREAD_ID: ${sourceThreadId}`,
      );
    });
  });
});
