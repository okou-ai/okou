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
import { createHash, randomUUID } from "node:crypto";
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
  it("recovers an interrupted opt-in and stops checking membership once both schedules are installed", async () => {
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
    const preference = app(proactiveSuggestionsContract);
    const membership =
      context.mocks.clerk.organizations.getOrganizationMembershipList;
    membership.mockRejectedValueOnce(
      new Error("Membership service temporarily unavailable"),
    );
    const pending = await accept(
      preference.update({ headers, body: { enabled: true } }),
      [200],
    );
    expect(pending.body).toMatchObject({ enabled: true, status: "error" });

    const shard =
      createHash("sha256")
        .update(`${actor.orgId}/${actor.userId}`)
        .digest()
        .readUInt32BE() % 60;
    // Both ticks are in the owner's shard. The new hourly schedule is not due until the next hour.
    const tickTime = Date.UTC(2030, 0, 2, 12, shard, 5);
    async function tick(at: number) {
      mockNow(at);
      await accept(
        app(cronExecuteWorkflowAutomationsContract).execute({
          headers: { authorization: "Bearer test-cron-secret" },
        }),
        [200],
      );
      await flushWaitUntilForTest();
    }
    await tick(tickTime);
    const repaired = await accept(preference.get({ headers }), [200]);
    expect(repaired.body).toMatchObject({ enabled: true, status: "enabled" });
    const list = await accept(
      workflowCollectionClient().list({ headers, query: {} }),
      [200],
    );
    const schedules = list.body.filter((w) => {
      return (
        w.official?.definitionName === "agent-suggestions" ||
        w.official?.definitionName === "proactive-learning"
      );
    });
    expect(schedules).toHaveLength(2);
    async function installations() {
      return await Promise.all(
        schedules.map(async ({ id }) => {
          const detail = await accept(
            workflowClient().get({ headers, params: { workflowId: id } }),
            [200],
          );
          return { id, updatedAt: detail.body.updatedAt };
        }),
      );
    }
    const before = await installations();
    membership.mockClear();
    await tick(tickTime + 10_000);
    expect(membership).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: actor.orgId }),
    );
    await expect(installations()).resolves.toStrictEqual(before);
  });

  it("clears the departed member's opt-in and preserves both paused schedules", async () => {
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
    const listed = await accept(
      workflowCollectionClient().list({ headers, query: {} }),
      [200],
    );
    const workflows = listed.body.filter((workflow) => {
      return (
        workflow.official?.definitionName === "agent-suggestions" ||
        workflow.official?.definitionName === "proactive-learning"
      );
    });
    expect(workflows).toHaveLength(2);
    const originals = await Promise.all(
      workflows.map(async (workflow) => {
        const response = await accept(
          automationClient().list({
            headers,
            params: { workflowId: workflow.id },
          }),
          [200],
        );
        const [automation] = response.body;
        if (!automation?.enabled) {
          throw new Error("Expected the owner's enabled schedule");
        }
        return { workflowId: workflow.id, id: automation.id };
      }),
    );
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
    for (const original of originals) {
      const response = await accept(
        automationClient().list({
          headers,
          params: { workflowId: original.workflowId },
        }),
        [200],
      );
      expect(response.body).toMatchObject([
        {
          id: original.id,
          enabled: false,
          nextRunAt: null,
          official: { intendedEnabled: false },
        },
      ]);
    }
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
  it("shares one schedule across simultaneous first opt-ins and later toggles", async () => {
    const { actor } = await prepareBriefMember();
    await bdd.updateUserTimezone(actor, "Asia/Shanghai");
    const headers = authHeaders(actor);
    const preferences = morningBriefPreferenceClient();
    const setEnabled = (enabled: boolean) => {
      return accept(preferences.update({ headers, body: { enabled } }), [200]);
    };
    await Promise.all([setEnabled(true), setEnabled(true)]);
    const installed = await listMorningBriefInstallations(actor);
    expect(installed).toHaveLength(1);
    const [workflow] = installed;
    if (!workflow) {
      throw new Error("Expected the Morning Brief installation");
    }
    const listSchedules = () => {
      return accept(
        automationClient().list({
          headers,
          params: { workflowId: workflow.id },
        }),
        [200],
      );
    };
    const first = await listSchedules();
    expect(first.body).toHaveLength(1);
    const [schedule] = first.body;
    if (!schedule) {
      throw new Error("Expected the Morning Brief schedule");
    }
    expect(schedule).toMatchObject({
      kind: "schedule",
      enabled: true,
      chatThreadId: null,
      schedule: { type: "cron", timezone: "Asia/Shanghai" },
    });
    await setEnabled(false);
    expect((await listSchedules()).body).toMatchObject([
      { id: schedule.id, enabled: false },
    ]);
    await setEnabled(true);
    expect((await listSchedules()).body).toMatchObject([
      { id: schedule.id, enabled: true, chatThreadId: null },
    ]);
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
  const cron = { authorization: "Bearer test-cron-secret" };
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
    const learning = installed.body.find((workflow) => {
      return workflow.official?.definitionName === "proactive-learning";
    });
    if (!learning) {
      throw new Error("Expected the original Learning installation");
    }
    const automations = await accept(
      automationClient().list({ headers, params: { workflowId: learning.id } }),
      [200],
    );
    const [nightly] = automations.body;
    if (!nightly) {
      throw new Error("Expected the original nightly schedule");
    }
    await accept(
      automationClient().run({ headers, params: { id: nightly.id } }),
      [409],
    );
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
      copied: 3,
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

  it("waits for an accepted Morning Brief, then reuses its thread and retains the delivery rights captured at the next start", async () => {
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
    const [workflow] = await listMorningBriefInstallations(actor);
    if (!workflow) {
      throw new Error("Missing original Morning Brief installation");
    }
    const history = async () => {
      const reply = await accept(
        automationClient().list({
          headers: authHeaders(actor),
          params: { workflowId: workflow.id },
        }),
        [200],
      );
      const [schedule] = reply.body;
      if (!schedule) {
        throw new Error("Missing original Morning Brief schedule");
      }
      return schedule;
    };
    const { nextRunAt } = await history();
    if (!nextRunAt) {
      throw new Error("Missing original Morning Brief slot");
    }
    clockTime = Date.parse(nextRunAt) + 1000;
    mockNow(clockTime);
    await owned.run(() => {
      return runs.registerDirectRunner(owned.runnerGroup);
    });
    await accept(
      app(cronExecuteWorkflowAutomationsContract).execute({ headers: cron }),
      [200],
    );
    await flushWaitUntilForTest();
    const started = await history();
    if (!started.chatThreadId) {
      throw new Error("Missing Morning Brief conversation");
    }
    const threadId = started.chatThreadId;
    const first = await launchedAutomationRunId(actor, threadId);
    if (!first) {
      throw new Error("Missing active legacy Morning Brief");
    }
    const client = app(cronProactiveContract);
    const tick = () => {
      return accept(client.compare({ headers: cron }), [200]);
    };
    const firstTicks = await Promise.all([tick(), tick()]);
    for (const response of firstTicks) {
      expect(response.body).toMatchObject({ phase: "draining" });
    }
    clockTime += 5 * 60_000;
    mockNow(clockTime);
    expect((await tick()).body).toMatchObject({ phase: "draining" });
    const earlier = await owned.runExecution(first);
    await webhooks.requestAgentComplete(
      { runId: first, exitCode: 0 },
      earlier.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    const finished = await history();
    if (!finished.nextRunAt) {
      throw new Error("Legacy completion must establish the final cursor");
    }
    const activationTicks = await Promise.all([tick(), tick()]);
    for (const response of activationTicks) {
      expect(response.body).toMatchObject({ phase: "standalone", enqueued: 0 });
    }
    clockTime = Date.parse(finished.nextRunAt) - 60_000;
    mockNow(clockTime);
    await accept(
      suggestions.updateWithFeed({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    clockTime += 60_000;
    mockNow(clockTime);
    await owned.run(() => {
      return runs.registerDirectRunner(owned.runnerGroup);
    });
    const nextSlot = await tick();
    expect(nextSlot.body).toMatchObject({ enqueued: 1 });
    await accept(
      app(cronCleanupSandboxesContract).cleanup({ headers: cron }),
      [200],
    );
    await flushWaitUntilForTest();
    const second = await launchedAutomationRunId(actor, threadId);
    if (!second || second === first) {
      throw new Error(
        "Standalone Morning Brief must reuse its original conversation",
      );
    }
    const { execution, sandboxHeaders } = await owned.runExecution(second);
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

  it("completes an in-flight user schedule using its edited recurrence", async () => {
    mockNow(new Date("2030-01-01T00:00:00.000Z"));
    const client = automationClient();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "UTC",
    });
    const workflowId = await workflowBdd.createWorkflow(actor, {
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
    const runnerGroup = await runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const [fired] = await Promise.all([
      runScheduleNow(actor, automation.id),
      runs.heartbeatRunner(runnerGroup),
    ]);
    const execution = await runs.executionInput(fired.runId);
    expect(execution.cliAgentType).toBe("claude-code");
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

  it("stops a user-created schedule after three failed manual runs", async () => {
    const startedAt = Date.parse("2030-01-01T00:00:00.000Z");
    mockNow(startedAt);
    const client = automationClient();
    const { actor } = await workflowBdd.setupWorkflowOrg({
      timezone: "UTC",
    });
    const workflowId = await workflowBdd.createWorkflow(actor, {
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
    const runnerGroup = await runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    for (let failure = 0; failure < 3; failure += 1) {
      // Each user retry has its own request time rather than replaying one click.
      mockNow(startedAt + (failure + 1) * 60_000);
      await runs.registerDirectRunner(runnerGroup);
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
