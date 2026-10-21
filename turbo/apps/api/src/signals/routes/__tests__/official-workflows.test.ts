import {
  createImageIoTestApp,
  postFalWebhookEnvelope,
  tokenRequest,
} from "./helpers/public-image-run";
import { imageIoGenerateContract } from "@okouai/api-contracts/contracts/image-io-generate";
import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";
import { imageIoGenerateRoutes } from "../image-io-generate";
import { builtInGenerationRoutes } from "../built-in-generation";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { chatEventsRoutes } from "../chat-events";
import { webSearchContract } from "@okouai/api-contracts/contracts/web-search";
import { webSearchRoutes } from "../web-search";
import { HttpResponse, http } from "msw";
import { server } from "../../../mocks/server";
import { notificationsContract } from "@okouai/api-contracts/contracts/notifications";
import { notificationsRoutes } from "../notifications";
import { mockClerkUsers } from "./helpers/clerk-users";
import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";
import { debugMorningBriefRoutes } from "../debug-morning-brief";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { readPublishedArchive } from "./helpers/published-archive";
import { publicChatActor } from "./helpers/public-chat-actor";
import { claimBudgetRun } from "./helpers/public-autonomy-budget";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  cronExecuteWorkflowAutomationsContract,
  cronOfficialWorkflowCatalogContract,
} from "@okouai/api-contracts/contracts/cron";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
  morningBriefPreferenceContract,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
  type OfficialWorkflowBlueprint,
  type OfficialWorkflowSourceCatalog,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";

import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
  workflowVisibilityContract,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getCustomSkillStorageName,
  getOfficialWorkflowDefinitionStorageName,
} from "@okouai/core/storage-names";

import { gunzipSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import {
  createCronOfficialWorkflowCatalogRoutes,
  cronOfficialWorkflowCatalogRoutes,
} from "../cron-official-workflow-catalog";
import { logsRoutes } from "../logs";
import { morningBriefPreferenceRoutes } from "../morning-brief-preference";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { proactiveSuggestionsRoutes } from "../proactive-suggestions";
import { suggestionsContract } from "@okouai/api-contracts/contracts/suggestions";
import { suggestionsRoutes } from "../suggestions";
import {
  chatEventsContract,
  chatThreadsContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadGetRoutes } from "../chat-threads-get";

import { userPreferencesRoutes } from "../user-preferences";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";

import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";

import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";
import {
  activeDefinition,
  installCatalogStorageFixture,
  type ActiveDefinition,
} from "./helpers/official-workflow-catalog";
import { pauseBriefForMembershipFailure } from "./helpers/morning-brief-membership";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const workflowBdd = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const chat = createChatFilesBddApi(context);
const mocks = createRouteMocks(context);
const CRON_SECRET = "official-workflow-installation-cron-secret";
function createCatalogPublicationFixture() {
  let published = false;
  return {
    reset() {
      published = false;
    },
    hasProactiveDefinition() {
      return published;
    },
    recordPublished(outcome: string) {
      published = outcome !== "rejected";
    },
  };
}
const catalogPublication = createCatalogPublicationFixture();

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

// Keep a connected personal default to exercise the Official Auto override.
async function selectPersonalDefaultModel(actor: ApiTestUser): Promise<void> {
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
}

function catalog(
  definitions: OfficialWorkflowSourceCatalog["definitions"],
): OfficialWorkflowSourceCatalog {
  return {
    schemaVersion: OFFICIAL_WORKFLOW_CATALOG_PUBLICATION_SCHEMA_VERSION,
    definitions:
      catalogPublication.hasProactiveDefinition() &&
      !definitions.some((definition) => {
        return definition.name === "agent-suggestions";
      })
        ? [
            ...definitions,
            {
              name: "agent-suggestions",
              lifecycle: "retired",
              presentation: { category: "productivity" },
            },
          ]
        : definitions,
  };
}

async function syncClient(candidate: unknown) {
  const app = await setupApp({
    context,
    routes: createCronOfficialWorkflowCatalogRoutes(candidate),
    isolatePg: true,
  });
  return app(cronOfficialWorkflowCatalogContract);
}

async function syncCatalog(candidate: unknown) {
  return await accept(
    (await syncClient(candidate)).sync({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
}

function connectorDoctorDefinition(): ActiveDefinition {
  return activeDefinition("connector-doctor", [
    {
      key: "weekly-check",
      parameters: [],
      desiredState: {
        kind: "schedule",
        schedule: {
          type: "cron",
          cronExpression: "0 9 * * 1",
        },
      },
    },
  ]);
}

async function syncDeployedCatalog() {
  await syncCatalog(catalog([connectorDoctorDefinition()]));
  return await syncSourceCatalog();
}

/** Publishes the deployed source catalog through its production cron route. */
async function syncSourceCatalog() {
  const result = await accept(
    setupApp({ context, routes: cronOfficialWorkflowCatalogRoutes })(
      cronOfficialWorkflowCatalogContract,
    ).sync({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
  catalogPublication.recordPublished(result.body.outcome);
  return result;
}

async function syncMorningBriefCatalog(hiddenThread = false) {
  return await syncCatalog(
    catalog(
      MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.map((name) => {
        return {
          ...activeDefinition(name, [
            {
              key: "daily-delivery",
              parameters: [],
              desiredState: {
                kind: "schedule",
                schedule: { type: "cron", cronExpression: "0 7 * * *" },
              },
            },
          ]),
          hiddenThread,
        };
      }),
    ),
  );
}

async function executeAutomationCron() {
  return await accept(
    setupApp({ context, routes: cronExecuteWorkflowAutomationsRoutes })(
      cronExecuteWorkflowAutomationsContract,
    ).execute({ headers: { authorization: `Bearer ${CRON_SECRET}` } }),
    [200],
  );
}

async function fireOfficialSchedule(
  actor: ApiTestUser,
  automation: Pick<WorkflowAutomationSummary, "id" | "nextRunAt">,
) {
  if (!automation.nextRunAt) {
    throw new Error("Expected a scheduled Official Automation");
  }
  await withMockNowForTest(
    new Date(automation.nextRunAt).getTime(),
    async () => {
      await executeAutomationCron();
      await flushWaitUntilForTest();
    },
  );
  const current = await accept(
    automationClient().get({
      headers: authHeaders(actor),
      params: { id: automation.id },
    }),
    [200],
  );
  const chatThreadId = current.body.chatThreadId;
  if (!chatThreadId) {
    throw new Error("Expected the Official Automation thread");
  }
  const runId = await launchedAutomationRunId(actor, chatThreadId);
  if (!runId) {
    throw new Error("Expected the scheduled Official Automation Run");
  }
  return { chatThreadId, runId };
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

function workflowVisibilityClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowVisibilityContract,
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

/** Every Run the actor can see for one Agent, through the public log list. */
async function listAgentRunLogIds(
  actor: ApiTestUser,
  agentId: string,
): Promise<readonly string[]> {
  const response = await accept(
    setupApp({ context, routes: logsRoutes })(logsListContract).list({
      headers: authHeaders(actor),
      query: { agentId, limit: 100 },
    }),
    [200],
  );
  return response.body.data.map((log) => {
    return log.id;
  });
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

async function deliverClerkOrganizationMembershipCreated(
  actor: ApiTestUser,
  createdAt: Date,
  membershipId = `membership-${actor.userId}-${actor.orgId}`,
): Promise<void> {
  if (!actor.orgId || !actor.orgRole) {
    throw new Error("Expected organization-scoped Clerk member");
  }
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.created",
    data: {
      id: membershipId,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
      role: actor.orgRole,
      created_at: createdAt.getTime(),
    },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function deliverClerkOrganizationMembershipDeleted(
  actor: ApiTestUser,
): Promise<void> {
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organizationMembership.deleted",
    data: {
      id: `membership-${actor.userId}-${actor.orgId}`,
      organization: { id: actor.orgId },
      public_user_data: { user_id: actor.userId },
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
  catalogPublication.reset();
  mockEnv("CRON_SECRET", CRON_SECRET);
});

describe("Proactive Suggestions preference", () => {
  it("repairs feature availability at the same hourly minute used by its schedule", async () => {
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor);
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    const owner = { ...actor, orgId: actor.orgId };
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.AgentSuggestion]: true,
    });
    await accept(
      setupApp({ context, routes: proactiveSuggestionsRoutes })(
        proactiveSuggestionsContract,
      ).update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    const listed = await accept(
      workflowCollectionClient().list({
        headers: authHeaders(actor),
        query: {},
      }),
      [200],
    );
    const installation = listed.body.find((item) => {
      return item.official?.definitionName === "agent-suggestions";
    });
    if (!installation) {
      throw new Error("Expected Proactive Suggestions installation");
    }
    const detail = await accept(
      workflowClient().get({
        headers: authHeaders(actor),
        params: { workflowId: installation.id },
      }),
      [200],
    );
    const schedule = detail.body.automations[0];
    if (!schedule?.nextRunAt) {
      throw new Error("Expected hourly schedule");
    }
    const firstTick = new Date(schedule.nextRunAt).getTime();
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.AgentSuggestion]: false,
    });
    await withMockNowForTest(firstTick, executeAutomationCron);
    const paused = await accept(
      automationClient().get({
        headers: authHeaders(actor),
        params: { id: schedule.id },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({ enabled: false, nextRunAt: null });
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.AgentSuggestion]: true,
    });
    await withMockNowForTest(firstTick + 3_600_000, executeAutomationCron);
    const repaired = await accept(
      automationClient().get({
        headers: authHeaders(actor),
        params: { id: schedule.id },
      }),
      [200],
    );
    expect(repaired.body).toMatchObject({
      enabled: true,
      nextRunAt: new Date(firstTick + 7_200_000).toISOString(),
    });
  });

  it("runs the hourly Official workflow without Morning Brief and blocks curation and mail after opt-out", async () => {
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor);
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.AgentSuggestion]: true },
    );
    const client = setupApp({ context, routes: proactiveSuggestionsRoutes })(
      proactiveSuggestionsContract,
    );
    await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    const listed = await accept(
      workflowCollectionClient().list({
        headers: authHeaders(actor),
        query: {},
      }),
      [200],
    );
    const installation = listed.body.find((item) => {
      return item.official?.definitionName === "agent-suggestions";
    });
    if (!installation) {
      throw new Error("Expected Proactive Suggestions installation");
    }
    const detail = await accept(
      workflowClient().get({
        headers: authHeaders(actor),
        params: { workflowId: installation.id },
      }),
      [200],
    );
    const automation = detail.body.automations[0];
    if (!automation) {
      throw new Error("Expected hourly automation");
    }
    expect(automation).toMatchObject({
      enabled: true,
      kind: "schedule",
      schedule: { type: "cron", timezone: "UTC" },
    });
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    await runs.heartbeatRunner(runnerGroup);
    const { runId } = await fireOfficialSchedule(actor, automation);
    const claim = await runs.claimRunnerJob(runId);
    onTestFinished(async () => {
      await webhooks.requestAgentComplete(
        { runId, exitCode: 1, error: "Proactive Suggestions fixture cleanup" },
        { authorization: `Bearer ${claim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
    });
    expect(claim.prompt).toMatch(/^\/agent-suggestions\n/u);
    expect(
      capturedOfficialSkill(claim.storageManifest, "agent-suggestions"),
    ).toContain("Never send email");
    const token = { authorization: `Bearer ${okouTokenFromClaim(claim)}` };
    const suggestionId = randomUUID();
    const suggestions = setupApp({ context, routes: suggestionsRoutes })(
      suggestionsContract,
    );
    await accept(
      suggestions.create({
        headers: token,
        body: {
          id: suggestionId,
          title: "Review the pending decision",
          rationale: "A response is needed",
          priority: 1,
          threadId: null,
          draft: {
            draftUserMessage: {
              version: 1,
              parts: [
                { type: "text", text: "Review the verified pending decision." },
              ],
            },
            draftAttachments: null,
          },
        },
      }),
      [200],
    );
    const homepage = await accept(
      suggestions.list({ headers: authHeaders(actor) }),
      [200],
    );
    expect(
      homepage.body.suggestions.map((item) => {
        return item.id;
      }),
    ).toContain(suggestionId);
    const indicators = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).indicators({ headers: authHeaders(actor) }),
      [200],
    );
    const currentAutomation = await accept(
      automationClient().get({
        headers: authHeaders(actor),
        params: { id: automation.id },
      }),
      [200],
    );
    if (!currentAutomation.body.chatThreadId) {
      throw new Error("Expected diagnostic thread");
    }
    expect(
      indicators.body.threads[currentAutomation.body.chatThreadId],
    ).toBeUndefined();
    const thread = await accept(
      setupApp({ context, routes: chatThreadGetRoutes })(
        chatThreadMetadataContract,
      ).get({
        headers: authHeaders(actor),
        params: { id: currentAutomation.body.chatThreadId },
      }),
      [200],
    );
    expect(thread.body).toMatchObject({ hidden: true, selectedModel: "auto" });
    await accept(
      setupApp({ context, routes: notificationsRoutes })(
        notificationsContract,
      ).mail({
        headers: token,
        body: {
          kind: "notification",
          to: "me",
          subject: "Should not send",
          text: "Background checks only update suggestions.",
          idempotencyKey: "proactive-mail",
        },
      }),
      [403],
    );
    await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: false } }),
      [200],
    );
    await accept(
      setupApp({ context, routes: suggestionsRoutes })(
        suggestionsContract,
      ).list({ headers: token }),
      [403],
    );
    const paused = await accept(
      automationClient().get({
        headers: authHeaders(actor),
        params: { id: automation.id },
      }),
      [200],
    );
    expect(paused.body).toMatchObject({ enabled: false, nextRunAt: null });
    const retained = await accept(
      suggestions.list({ headers: authHeaders(actor) }),
      [200],
    );
    expect(
      retained.body.suggestions.map((item) => {
        return item.id;
      }),
    ).toContain(suggestionId);
    expect((await readBriefPreference(actor)).body.enabled).toBeFalsy();
  });
  it("defaults off and gates the preference without coupling it to Morning Brief", async () => {
    const { actor } = await prepareBriefMember();
    await bdd.completeOnboarding(actor);
    const client = setupApp({ context, routes: proactiveSuggestionsRoutes })(
      proactiveSuggestionsContract,
    );
    const headers = authHeaders(actor);
    await accept(client.get({ headers }), [403]);
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.AgentSuggestion]: true },
    );
    const initial = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(initial.body).toMatchObject({ enabled: false, status: "paused" });
    const enabled = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    expect(enabled.body).toMatchObject({ enabled: true, status: "enabled" });
    const morning = await readBriefPreference(actor);
    expect(morning.body.enabled).toBeFalsy();
    const disabled = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: false } }),
      [200],
    );
    expect(disabled.body).toMatchObject({ enabled: false, status: "paused" });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.AgentSuggestion]: false },
    );
    await accept(client.get({ headers: authHeaders(actor) }), [403]);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.AgentSuggestion]: true },
    );
    const restored = await accept(
      client.get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(restored.body.enabled).toBeFalsy();
  });

  it("keeps the explicit choice while the catalog is unavailable", async () => {
    const { actor } = await prepareBriefMember({ catalogAvailable: false });
    await bdd.completeOnboarding(actor);
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.AgentSuggestion]: true },
    );
    const client = setupApp({ context, routes: proactiveSuggestionsRoutes })(
      proactiveSuggestionsContract,
    );
    const pending = await accept(
      client.update({ headers: authHeaders(actor), body: { enabled: true } }),
      [200],
    );
    expect(pending.body).toMatchObject({ enabled: true, status: "preparing" });
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
  it("publishes one choice for overlapping Morning Brief disable requests", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    const headers = authHeaders(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected the preference installation");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected the Morning Brief automation");
    }
    const responses = await Promise.all([
      accept(
        automationClient().disable({ headers, params: { id: automation.id } }),
        [200, 409],
      ),
      accept(
        automationClient().disable({ headers, params: { id: automation.id } }),
        [200, 409],
      ),
    ]);
    expect(
      responses.some((response) => {
        return response.status === 200;
      }),
    ).toBeTruthy();
    await expect(
      readMorningBriefAutomations(actor, installation.id),
    ).resolves.toMatchObject([
      { enabled: false, nextRunAt: null, official: { intendedEnabled: false } },
    ]);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
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

async function readMorningBriefAutomations(
  actor: ApiTestUser,
  workflowId: string,
) {
  const response = await accept(
    workflowClient().get({
      headers: authHeaders(actor),
      params: { workflowId },
    }),
    [200],
  );
  return response.body.automations;
}

async function listMorningBriefAutomations(
  actor: ApiTestUser,
  workflowId: string,
) {
  const response = await accept(
    setupApp({
      context,
      routes: workflowAutomationsRoutes.filter(({ route }) => {
        return route === workflowAutomationsContract.list;
      }),
    })(workflowAutomationsContract).list({
      headers: authHeaders(actor),
      params: { workflowId },
    }),
    [200],
  );
  return response.body;
}

function mockBriefMemberships(
  entries: readonly {
    readonly actor: ApiTestUser;
    readonly createdAt: Date;
    readonly membershipId?: string;
  }[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: entries.map(({ actor, createdAt, membershipId }) => {
        return {
          id: membershipId ?? `membership-${actor.userId}-${actor.orgId}`,
          role: actor.orgRole ?? "org:member",
          createdAt: createdAt.getTime(),
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        };
      }),
    },
  );
}

async function connectBriefSource(actor: ApiTestUser): Promise<void> {
  const onboarding = await bdd.readOnboardingStatus(actor);
  if (!onboarding.defaultAgentId) {
    throw new Error("Expected default Agent");
  }
  await connectBriefSourceForAgent(actor, onboarding.defaultAgentId);
}

async function connectBriefSourceForAgent(
  actor: ApiTestUser,
  defaultAgentId: string,
): Promise<void> {
  mockGmailConnectorOAuth();
  const start = await connectors.startOauth(
    actor,
    "gmail",
    "oauth",
    defaultAgentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  // OAuth authorizes this Agent; do not repeat the same grant through PUT.
  const callback = await connectors.completeOauthCallbackResult("gmail", {
    code: "brief-code",
    state,
  });
  expect(callback.body).toMatchObject({ status: "success" });
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

async function readBriefPreference(actor: ApiTestUser) {
  return await accept(
    morningBriefPreferenceClient().get({ headers: authHeaders(actor) }),
    [200],
  );
}

/** The member's Official schedule, read through the workflow detail endpoint. */
async function readBriefSchedule(actor: ApiTestUser) {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const [installation] = await listMorningBriefInstallations(actor);
  if (!installation) {
    throw new Error("Expected one Morning Brief installation");
  }
  const [automation] = await readMorningBriefAutomations(
    actor,
    installation.id,
  );
  return {
    nextRunAt: automation?.nextRunAt ?? null,
    timezone:
      automation?.kind === "schedule" && automation.schedule.type !== "loop"
        ? automation.schedule.timezone
        : null,
  };
}

/** Independent oracle for the owner's Morning Brief start: 06:30-06:59 local. */
function expectedMorningBriefMinute(actor: ApiTestUser): number {
  if (!actor.orgId) {
    throw new Error("Expected organization-scoped actor");
  }
  const hash = Number.parseInt(
    createHash("sha256")
      .update(`${actor.orgId}/${actor.userId}`)
      .digest("hex")
      .slice(0, 8),
    16,
  );
  return 30 + ((hash + 15) % 30);
}

function localClock(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

async function prepareBriefMember({
  actor = bdd.user(),
  createdAt = new Date("2030-01-01T00:00:00.000Z"),
  catalogAvailable = true,
  bootstrap = true,
}: {
  readonly actor?: ApiTestUser;
  readonly createdAt?: Date;
  readonly catalogAvailable?: boolean;
  readonly bootstrap?: boolean;
} = {}) {
  installCatalogStorageFixture(context);
  if (catalogAvailable) {
    await syncDeployedCatalog();
  }
  mockBriefMemberships([{ actor, createdAt }]);
  if (bootstrap) {
    await deliverClerkOrganizationCreated(actor, createdAt);
  }
  return { actor, createdAt };
}

describe("Official Workflow failure recovery", () => {
  async function failScheduleOccurrence(
    actor: ApiTestUser,
    automation: WorkflowAutomationSummary,
    runnerGroup: ReturnType<typeof runs.configureRunnerGroup>,
  ) {
    if (!automation.nextRunAt) {
      throw new Error("Expected the next schedule occurrence");
    }
    const scheduledAt = new Date(automation.nextRunAt).getTime();
    const fired = await fireOfficialSchedule(actor, automation);
    mockNow(scheduledAt + 1000);
    await runs.heartbeatRunner(runnerGroup);
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

  async function preparePausedOfficialSchedule(
    name: "agent-suggestions" | "morning-brief",
  ) {
    mockNow(new Date("2030-01-01T00:00:00.000Z"));
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "UTC");
    await bdd.completeOnboarding(actor, { timezone: "UTC" });
    if (!actor.orgId) {
      throw new Error("Expected an organization");
    }
    if (name === "agent-suggestions") {
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: actor.orgId },
        { [FeatureSwitchKey.AgentSuggestion]: true },
      );
      await accept(
        setupApp({ context, routes: proactiveSuggestionsRoutes })(
          proactiveSuggestionsContract,
        ).update({ headers: authHeaders(actor), body: { enabled: true } }),
        [200],
      );
    } else {
      await connectBriefSource(actor);
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
    }
    const listed = await accept(
      workflowCollectionClient().list({
        headers: authHeaders(actor),
        query: {},
      }),
      [200],
    );
    const installation = listed.body.find((workflow) => {
      return workflow.official?.definitionName === name;
    });
    if (!installation) {
      throw new Error("Expected the Official installation");
    }
    const detail = await accept(
      workflowClient().get({
        headers: authHeaders(actor),
        params: { workflowId: installation.id },
      }),
      [200],
    );
    let automation = detail.body.automations[0];
    if (!automation) {
      throw new Error("Expected an Official schedule");
    }
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    for (let failure = 0; failure < 3; failure += 1) {
      automation = await failScheduleOccurrence(actor, automation, runnerGroup);
    }
    expect(automation).toMatchObject({
      enabled: false,
      official: { intendedEnabled: true },
    });
    expect(automation.nextRunAt).not.toBeNull();
    return { actor, automation, runnerGroup };
  }

  it.each(["agent-suggestions", "morning-brief"] as const)(
    "restores %s at its next period without a user enable operation",
    async (name) => {
      const { actor, automation, runnerGroup } =
        await preparePausedOfficialSchedule(name);
      const preference =
        name === "morning-brief"
          ? await readBriefPreference(actor)
          : await accept(
              setupApp({ context, routes: proactiveSuggestionsRoutes })(
                proactiveSuggestionsContract,
              ).get({ headers: authHeaders(actor) }),
              [200],
            );
      expect(preference.body).toMatchObject({ enabled: true, status: "error" });
      if (!automation.nextRunAt) {
        throw new Error("Expected automatic recovery time");
      }
      mockNow(new Date(automation.nextRunAt).getTime() - 60_000);
      await executeAutomationCron();
      const waiting = await accept(
        automationClient().get({
          headers: authHeaders(actor),
          params: { id: automation.id },
        }),
        [200],
      );
      expect(waiting.body.enabled).toBeFalsy();
      const recovered = await fireOfficialSchedule(actor, automation);
      mockNow(new Date(automation.nextRunAt).getTime() + 1000);
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(recovered.runId);
      const stillRecovering =
        name === "morning-brief"
          ? await readBriefPreference(actor)
          : await accept(
              setupApp({ context, routes: proactiveSuggestionsRoutes })(
                proactiveSuggestionsContract,
              ).get({ headers: authHeaders(actor) }),
              [200],
            );
      expect(stillRecovering.body).toMatchObject({
        enabled: true,
        status: "error",
      });
      await createChatEventsFixture(context).completeChatRunOk(
        recovered.runId,
        { authorization: `Bearer ${claim.sandboxToken}` },
        { cliAgentType: "pi", cliAgentSessionId: claim.piSessionId },
      );
      await flushWaitUntilForTest();
      const healthy =
        name === "morning-brief"
          ? await readBriefPreference(actor)
          : await accept(
              setupApp({ context, routes: proactiveSuggestionsRoutes })(
                proactiveSuggestionsContract,
              ).get({ headers: authHeaders(actor) }),
              [200],
            );
      expect(healthy.body).toMatchObject({ enabled: true, status: "enabled" });
    },
  );

  it.each(["user opt-out", "feature unavailable"] as const)(
    "does not resume paused suggestions after %s",
    async (reason) => {
      const { actor, automation } =
        await preparePausedOfficialSchedule("agent-suggestions");
      if (!actor.orgId || !automation.nextRunAt) {
        throw new Error("Expected an owned schedule");
      }
      if (reason === "user opt-out") {
        await accept(
          setupApp({ context, routes: proactiveSuggestionsRoutes })(
            proactiveSuggestionsContract,
          ).update({ headers: authHeaders(actor), body: { enabled: false } }),
          [200],
        );
      } else {
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.AgentSuggestion]: false },
        );
      }
      mockNow(new Date(automation.nextRunAt).getTime());
      await executeAutomationCron();
      await flushWaitUntilForTest();
      const stopped = await accept(
        automationClient().get({
          headers: authHeaders(actor),
          params: { id: automation.id },
        }),
        [200],
      );
      expect(stopped.body.enabled).toBeFalsy();
    },
  );

  it("does not resume a fault-paused brief after catalog retirement", async () => {
    const { actor, automation } =
      await preparePausedOfficialSchedule("morning-brief");
    const retired = await syncCatalog(
      catalog(
        [...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES, "connector-doctor"].map(
          (name) => {
            return {
              name,
              lifecycle: "retired" as const,
              presentation: { category: "productivity" as const },
            };
          },
        ),
      ),
    );
    expect(retired.body).toMatchObject({
      outcome: "accepted",
      diagnostics: [],
    });
    if (!automation.nextRunAt) {
      throw new Error("Expected the recovery occurrence");
    }
    mockNow(new Date(automation.nextRunAt));
    await executeAutomationCron();
    const stopped = await accept(
      automationClient().get({
        headers: authHeaders(actor),
        params: { id: automation.id },
      }),
      [200],
    );
    expect(stopped.body).toMatchObject({
      enabled: false,
      official: { intendedEnabled: true },
    });
  });

  it("keeps user-created schedules stopped after three failures", async () => {
    mockNow(new Date("2030-01-01T00:00:00.000Z"));
    // This case executes the cross-tenant automation cron with a future clock.
    // Bind before owner setup and use this client to create its schedule.
    const isolatedAutomationClient = (
      await setupApp({
        context,
        routes: workflowAutomationsRoutes,
        isolatePg: true,
      })
    )(workflowAutomationsContract);
    const { actor, defaultAgentId } = await workflowBdd.setupWorkflowOrg({
      timezone: "UTC",
    });
    const workflowId = await workflowBdd.createWorkflow(actor, {
      agentId: defaultAgentId,
      name: "user-managed-schedule",
    });
    let automation = (
      await accept(
        isolatedAutomationClient.create({
          headers: authHeaders(actor),
          params: { workflowId },
          body: { schedule: { type: "loop", intervalSeconds: 600 } },
        }),
        [201],
      )
    ).body;
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    for (let failure = 0; failure < 3; failure += 1) {
      automation = await failScheduleOccurrence(actor, automation, runnerGroup);
    }
    expect(automation).toMatchObject({ enabled: false, nextRunAt: null });
    mockNow(new Date("2030-01-02T00:00:00.000Z"));
    await executeAutomationCron();
    const stopped = await accept(
      automationClient().get({
        headers: authHeaders(actor),
        params: { id: automation.id },
      }),
      [200],
    );
    expect(stopped.body).toMatchObject({ enabled: false, nextRunAt: null });
  });
});

describe("Morning Brief explicit installation", () => {
  it.each([
    // Both entry points share recovery; cover enabled and paused intent once.
    { entry: "initialize", intendedEnabled: true },
    { entry: "timezone-update", intendedEnabled: false },
  ] as const)(
    "reconciles an existing brief after $entry while preserving enabled=$intendedEnabled",
    async ({ entry, intendedEnabled }) => {
      const { actor, installationId, automationId } =
        await pauseBriefWithoutTimezone(intendedEnabled);
      if (entry === "initialize") {
        await initializeBriefMember(actor, "Asia/Tokyo");
      } else {
        await bdd.updateUserTimezone(actor, "Asia/Tokyo");
      }
      const [recovered] = await readMorningBriefAutomations(
        actor,
        installationId,
      );
      expect(recovered).toMatchObject({
        id: automationId,
        enabled: intendedEnabled,
        schedule: {
          timezone: "Asia/Tokyo",
          cronExpression: `${expectedMorningBriefMinute(actor)} 6 * * *`,
        },
        official: { intendedEnabled, reconciliationStatus: "current" },
      });
      if (intendedEnabled) {
        expect(recovered?.nextRunAt).not.toBeNull();
      } else {
        expect(recovered?.nextRunAt).toBeNull();
      }
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: intendedEnabled,
        status: intendedEnabled ? "enabled" : "paused",
      });
      await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(
        1,
      );
    },
  );

  it.each([true, false])(
    "repairs an existing brief on retry without changing enabled=%s",
    async (intendedEnabled) => {
      const { actor, installationId, automationId } =
        await pauseBriefWithoutTimezone(intendedEnabled);
      // The accepted catalog can supply the missing configuration without
      // another worker pass. GET remains an observation; retry owns recovery.
      await publishRecoveryBrief("Asia/Shanghai");
      const client = morningBriefPreferenceClient();
      await accept(client.get({ headers: authHeaders(actor) }), [409]);
      await expect(
        readMorningBriefAutomations(actor, installationId),
      ).resolves.toMatchObject([
        {
          id: automationId,
          enabled: false,
          nextRunAt: null,
          official: {
            intendedEnabled,
            reconciliationStatus: "needs_reconfiguration",
          },
        },
      ]);
      const repaired = await accept(
        client.retry({ headers: authHeaders(actor) }),
        [200],
      );
      expect(repaired.body).toMatchObject({
        enabled: intendedEnabled,
        status: intendedEnabled ? "enabled" : "paused",
      });
      const [recovered] = await readMorningBriefAutomations(
        actor,
        installationId,
      );
      expect(recovered).toMatchObject({
        id: automationId,
        enabled: intendedEnabled,
        schedule: {
          cronExpression: `${expectedMorningBriefMinute(actor)} 6 * * *`,
        },
        official: { intendedEnabled, reconciliationStatus: "current" },
      });
      if (intendedEnabled) {
        expect(recovered?.nextRunAt).not.toBeNull();
      } else {
        expect(recovered?.nextRunAt).toBeNull();
      }
    },
  );

  it("does not recover a departed member through configuration or retry", async () => {
    const { actor, installationId, automationId } =
      await pauseBriefWithoutTimezone(true);
    mockBriefMemberships([]);
    await initializeBriefMember(actor, "Asia/Tokyo");
    await accept(
      morningBriefPreferenceClient().retry({ headers: authHeaders(actor) }),
      [409],
    );
    await expect(
      readMorningBriefAutomations(actor, installationId),
    ).resolves.toMatchObject([
      {
        id: automationId,
        enabled: false,
        nextRunAt: null,
        official: {
          intendedEnabled: true,
          reconciliationStatus: "needs_reconfiguration",
        },
      },
    ]);
  });

  it("keeps recovery of an absent brief free of installation side effects", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Tokyo");
    await bdd.updateUserTimezone(actor, "Asia/Shanghai");
    const result = await accept(
      morningBriefPreferenceClient().retry({ headers: authHeaders(actor) }),
      [200],
    );
    expect(result.body).toMatchObject({ enabled: false, status: "paused" });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
  });

  it("preserves a user opt-out committed while recovery checks membership", async () => {
    const { actor, createdAt } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const requested = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementationOnce(
      async () => {
        requested.resolve();
        await release.promise;
        return {
          data: [
            {
              id: `membership-${actor.userId}-${actor.orgId}`,
              role: actor.orgRole,
              createdAt: createdAt.getTime(),
              organization: { id: actor.orgId },
              publicUserData: { userId: actor.userId },
            },
          ],
        };
      },
    );
    const recovery = morningBriefPreferenceClient().retry({
      headers: authHeaders(actor),
    });
    await requested.promise;
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
    release.resolve();
    const recovered = await accept(recovery, [200]);
    expect(recovered.body).toMatchObject({ enabled: false, status: "paused" });
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
  });

  it("keeps an existing brief paused when membership lookup returns 404", async () => {
    const { actor, installationId, automationId } =
      await pauseBriefForMembershipFailure(context);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkTransportTestError(404),
    );
    await accept(
      morningBriefPreferenceClient().retry({ headers: authHeaders(actor) }),
      [409],
    );
    await expect(
      readMorningBriefAutomations(actor, installationId),
    ).resolves.toMatchObject([
      {
        id: automationId,
        enabled: false,
        nextRunAt: null,
        official: {
          intendedEnabled: true,
          reconciliationStatus: "needs_reconfiguration",
        },
      },
    ]);
  });

  it.each(["ordinary-first", "official-first"] as const)(
    "keeps Morning Brief enrollment on the Official identity with same-name user content (%s)",
    async (order) => {
      const { actor } = await prepareBriefMember();
      await initializeBriefMember(actor, "Asia/Shanghai");
      await bdd.completeOnboarding(actor, { timezone: "Asia/Shanghai" });
      const onboarding = await bdd.readOnboardingStatus(actor);
      if (!onboarding.defaultAgentId) {
        throw new Error("Expected the default Agent");
      }
      const headers = authHeaders(actor);
      const enable = () => {
        return accept(
          morningBriefPreferenceClient().update({
            headers,
            body: { enabled: true },
          }),
          [200],
        );
      };
      if (order === "official-first") {
        await enable();
      }
      const ordinaryId = await workflowBdd.createWorkflow(actor, {
        agentId: onboarding.defaultAgentId,
        name: "morning-brief",
        visibility: "private",
        instruction: "The user's Morning Brief instructions",
      });
      if (order === "ordinary-first") {
        await enable();
      }
      const [installation] = await listMorningBriefInstallations(actor);
      if (!installation) {
        throw new Error("Expected the enrolled Official installation");
      }
      expect(installation.id).not.toBe(ordinaryId);
      const [automation] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      expect(automation).toMatchObject({ enabled: true });
      await accept(
        morningBriefPreferenceClient().update({
          headers,
          body: { enabled: false },
        }),
        [200],
      );
      await expect(
        readMorningBriefAutomations(actor, installation.id),
      ).resolves.toMatchObject([{ id: automation?.id, enabled: false }]);
      const ordinary = await accept(
        workflowClient().get({ headers, params: { workflowId: ordinaryId } }),
        [200],
      );
      expect(ordinary.body).toMatchObject({
        id: ordinaryId,
        name: "morning-brief",
        instruction: "The user's Morning Brief instructions",
        official: null,
      });
    },
  );

  it("installs only from the preference toggle, not initialization or onboarding", async () => {
    const { actor } = await prepareBriefMember();
    const headers = authHeaders(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await bdd.completeOnboarding(actor, { timezone: "Asia/Shanghai" });
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    await flushWaitUntilForTest();
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(0);
    const reenabled = await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    expect(reenabled.body).toMatchObject({
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("reschedules an existing brief after a timezone change and keeps a paused brief paused", async () => {
    const { actor } = await prepareBriefMember();
    await connectBriefSource(actor);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [before] = await listMorningBriefInstallations(actor);
    await bdd.updateUserTimezone(actor, "America/Los_Angeles");
    const changed = await readBriefPreference(actor);
    expect(changed.body).toMatchObject({
      enabled: true,
      status: "enabled",
    });
    const changedSchedule = await readBriefSchedule(actor);
    expect(changedSchedule.timezone).toBe("America/Los_Angeles");
    expect(changedSchedule.nextRunAt).not.toBeNull();
    if (!changedSchedule.nextRunAt) {
      throw new Error("Expected next run");
    }
    expect(localClock(changedSchedule.nextRunAt, "America/Los_Angeles")).toBe(
      `06:${expectedMorningBriefMinute(actor)}`,
    );
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    await initializeBriefMember(actor, "Asia/Shanghai");
    const [after] = await listMorningBriefInstallations(actor);
    expect(after?.id).toBe(before?.id);
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: false,
      status: "paused",
    });
    await expect(readBriefSchedule(actor)).resolves.toStrictEqual({
      timezone: "Asia/Tokyo",
      nextRunAt: null,
    });
  });

  it.each([
    // Definition selection does not change binding recovery or intent handling.
    { suggestion: false, intendedEnabled: true },
    { suggestion: true, intendedEnabled: false },
  ])(
    "retains Morning Brief intent=$intendedEnabled through an unresolved catalog schedule and correction (suggestion=$suggestion)",
    async ({ suggestion, intendedEnabled }) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        const { actor } = await prepareBriefMember();
        await initializeBriefMember(actor, "Asia/Shanghai");
        if (!actor.orgId) {
          throw new Error("Expected an organization-scoped member");
        }
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.AgentSuggestion]: suggestion },
        );
        if (suggestion) {
          await accept(
            setupApp({ context, routes: proactiveSuggestionsRoutes })(
              proactiveSuggestionsContract,
            ).update({ headers: authHeaders(actor), body: { enabled: true } }),
            [200],
          );
        }
        await accept(
          morningBriefPreferenceClient().update({
            headers: authHeaders(actor),
            body: { enabled: true },
          }),
          [200],
        );
        const [installation] = await listMorningBriefInstallations(actor);
        if (!installation) {
          throw new Error("Expected the Morning Brief installation");
        }
        const [before] = await readMorningBriefAutomations(
          actor,
          installation.id,
        );
        if (!before || before.kind !== "schedule" || before.official === null) {
          throw new Error("Expected its scheduled Official automation");
        }
        if (!intendedEnabled) {
          await accept(
            morningBriefPreferenceClient().update({
              headers: authHeaders(actor),
              body: { enabled: false },
            }),
            [200],
          );
        }
        const publishSchedule = async (defaultTimezone?: string) => {
          const publication = await syncCatalog(
            catalog([
              ...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.map((name) => {
                return activeDefinition(name, [
                  {
                    key: "daily-delivery",
                    parameters: [
                      {
                        key: "delivery-cron",
                        type: "string",
                        format: "text",
                        required: true,
                        default: "0 7 * * *",
                      },
                      {
                        key: "delivery-timezone",
                        type: "string",
                        format: "timezone",
                        required: true,
                        ...(defaultTimezone === undefined
                          ? {}
                          : { default: defaultTimezone }),
                      },
                    ],
                    desiredState: {
                      kind: "schedule",
                      schedule: {
                        type: "cron",
                        cronExpression: { parameter: "delivery-cron" },
                        timezone: { parameter: "delivery-timezone" },
                      },
                    },
                  },
                ]);
              }),
              {
                name: "connector-doctor",
                lifecycle: "retired",
                presentation: { category: "productivity" },
              },
            ]),
          );
          expect(publication.body).toMatchObject({
            outcome: "accepted",
            diagnostics: [],
          });
          await executeAutomationCron();
          await flushWaitUntilForTest();
        };
        // A real catalog publication can introduce an unresolved schedule
        // parameter. The system cron owns reconciliation; observations stay public.
        await publishSchedule();
        const [paused] = await readMorningBriefAutomations(
          actor,
          installation.id,
        );
        expect(paused).toMatchObject({
          id: before.id,
          enabled: false,
          nextRunAt: null,
          schedule: before.schedule,
          official: {
            blueprintKey: "daily-delivery",
            appliedFingerprint: before.official.appliedFingerprint,
            intendedEnabled,
            reconciliationStatus: "needs_reconfiguration",
            parameterBindings: [{ key: "delivery-cron", value: "0 7 * * *" }],
          },
        });
        await expect(
          listMorningBriefInstallations(actor),
        ).resolves.toMatchObject([
          {
            id: installation.id,
            official: {
              definitionName: suggestion
                ? "internal-test-morning-brief"
                : "morning-brief",
            },
          },
        ]);
        await publishSchedule("America/Los_Angeles");
        const [recovered] = await readMorningBriefAutomations(
          actor,
          installation.id,
        );
        if (!recovered) {
          throw new Error("Expected the recovered Morning Brief automation");
        }
        expect(recovered).toMatchObject({
          id: before.id,
          enabled: intendedEnabled,
          schedule: {
            type: "cron",
            cronExpression: "0 7 * * *",
            timezone: "America/Los_Angeles",
          },
          official: {
            intendedEnabled,
            reconciliationStatus: "current",
            parameterBindings: [
              { key: "delivery-cron", value: "0 7 * * *" },
              { key: "delivery-timezone", value: "America/Los_Angeles" },
            ],
          },
        });
        if (intendedEnabled) {
          expect(recovered.nextRunAt).not.toBeNull();
        } else {
          expect(recovered.nextRunAt).toBeNull();
        }
        expect((await readBriefPreference(actor)).body).toMatchObject({
          enabled: intendedEnabled,
          status: intendedEnabled ? "enabled" : "paused",
        });
      });
    },
  );

  it("installs a rejoined member's brief from their explicit preference", async () => {
    const owner = await prepareBriefMember({
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const actor = bdd.user({ orgId: owner.actor.orgId, orgRole: "org:member" });
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    await deliverClerkOrganizationMembershipCreated(actor, createdAt);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await deliverClerkOrganizationMembershipDeleted(actor);
    await deliverClerkOrganizationMembershipCreated(
      actor,
      new Date(createdAt.getTime() + 1000),
      `rejoined-${actor.userId}-${actor.orgId}`,
    );
    await initializeBriefMember(actor, "Asia/Shanghai");
    const enabled = await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    expect(enabled.body).toMatchObject({
      status: "enabled",
      enabled: true,
      unavailableReason: null,
    });
    expect((await readBriefPreference(actor)).body).toMatchObject({
      status: "enabled",
      enabled: true,
    });
    await expect(listMorningBriefInstallations(actor)).resolves.toHaveLength(1);
  });

  it("keeps an explicit timezone choice when initialization runs later", async () => {
    const { actor } = await prepareBriefMember();
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    const initialized = await initializeBriefMember(
      actor,
      "America/Los_Angeles",
    );
    expect(initialized.body.timezone).toBe("Asia/Tokyo");
    const saved = await accept(
      setupApp({ context, routes: userPreferencesRoutes })(
        userPreferencesContract,
      ).get({ headers: authHeaders(actor) }),
      [200],
    );
    expect(saved.body.timezone).toBe("Asia/Tokyo");
  });
});

async function publishRecoveryBrief(timezone?: string) {
  return await syncCatalog(
    catalog([
      ...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.map((name) => {
        return activeDefinition(name, [
          {
            key: "daily-delivery",
            parameters: [
              {
                key: "cron",
                type: "string",
                format: "text",
                required: true,
                default: "0 9 * * *",
              },
            ],
            desiredState: {
              kind: "schedule",
              schedule: {
                type: "cron",
                cronExpression: { parameter: "cron" },
                ...(timezone === undefined ? {} : { timezone }),
              },
            },
          },
        ]);
      }),
      {
        name: "connector-doctor",
        lifecycle: "retired",
        presentation: { category: "productivity" },
      },
    ]),
  );
}

async function pauseBriefWithoutTimezone(intendedEnabled: boolean) {
  const { actor, createdAt } = await prepareBriefMember();
  await initializeBriefMember(actor, "Asia/Shanghai");
  await accept(
    morningBriefPreferenceClient().update({
      headers: authHeaders(actor),
      body: { enabled: true },
    }),
    [200],
  );
  if (!intendedEnabled) {
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: false },
      }),
      [200],
    );
  }
  const [installation] = await listMorningBriefInstallations(actor);
  if (!installation) {
    throw new Error("Expected the existing Morning Brief installation");
  }
  const [before] = await readMorningBriefAutomations(actor, installation.id);
  if (!before) {
    throw new Error("Expected its existing automation");
  }
  // Departure removes preferences but retains the existing installation and
  // choice. A real rejoin supplies fresh authority without initializing them.
  await deliverClerkOrganizationMembershipDeleted(actor);
  const rejoinedAt = new Date(createdAt.getTime() + 1000);
  const membershipId = `rejoined-${actor.userId}-${actor.orgId}`;
  mockBriefMemberships([{ actor, createdAt: rejoinedAt, membershipId }]);
  await deliverClerkOrganizationMembershipCreated(
    actor,
    rejoinedAt,
    membershipId,
  );
  await publishRecoveryBrief();
  await executeAutomationCron();
  await flushWaitUntilForTest();
  await expect(
    readMorningBriefAutomations(actor, installation.id),
  ).resolves.toMatchObject([
    {
      id: before.id,
      enabled: false,
      nextRunAt: null,
      official: {
        intendedEnabled,
        reconciliationStatus: "needs_reconfiguration",
      },
    },
  ]);
  return { actor, installationId: installation.id, automationId: before.id };
}

function capturedOfficialSkill(
  manifest: Parameters<typeof expectCanonicalStorageManifest>[0],
  definitionName: string,
) {
  const mount = expectCanonicalStorageManifest(manifest)?.storageMounts.find(
    (entry) => {
      return (
        entry.name === getOfficialWorkflowDefinitionStorageName(definitionName)
      );
    },
  );
  if (!mount) {
    throw new Error(`Expected captured Official skill: ${definitionName}`);
  }
  const archive = context.mocks.s3.send.mock.calls
    .flatMap(([command]) => {
      if (
        !(command instanceof PutObjectCommand) ||
        !command.input.Key?.endsWith(`/${mount.versionId}/archive.tar.gz`) ||
        !(command.input.Body instanceof Uint8Array)
      ) {
        return [];
      }
      return [command.input.Body];
    })
    .at(-1);
  if (!archive) {
    throw new Error("Expected the exact captured skill publication");
  }
  return gunzipSync(archive).toString("utf8");
}

describe("Morning Brief start time", () => {
  it("starts an enabled brief at the owner's minute before 07:00 local time", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Tokyo");
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected the Morning Brief installation");
    }
    const minute = expectedMorningBriefMinute(actor);
    const cron = `${minute} 6 * * *`;
    const [automation] = await listMorningBriefAutomations(
      actor,
      installation.id,
    );
    expect(automation).toMatchObject({
      enabled: true,
      schedule: { type: "cron", cronExpression: cron, timezone: "Asia/Tokyo" },
      official: {
        reconciliationStatus: "current",
        parameterBindings: [{ key: "cron", value: cron }],
      },
    });
    if (!automation?.nextRunAt) {
      throw new Error("Expected the next Morning Brief run");
    }
    expect(localClock(automation.nextRunAt, "Asia/Tokyo")).toBe(`06:${minute}`);
  });

  it.each([
    { localTime: "06:10:00", keepsPendingOccurrence: false },
    { localTime: "06:59:30", keepsPendingOccurrence: true },
  ])(
    "moves an existing 07:00 brief to the owner's minute without skipping a day (local $localTime)",
    async ({ localTime, keepsPendingOccurrence }) => {
      await withMockNowForTest(new Date("2030-01-01T03:00:00Z"), async () => {
        installCatalogStorageFixture(context);
        // The previously accepted catalog started every brief at 07:00.
        const legacy = catalog([
          ...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.map((name) => {
            return activeDefinition(name, [
              {
                key: "daily-delivery",
                parameters: [],
                desiredState: {
                  kind: "schedule",
                  schedule: { type: "cron", cronExpression: "0 7 * * *" },
                },
              },
            ]);
          }),
          connectorDoctorDefinition(),
        ]);
        expect((await syncCatalog(legacy)).body.outcome).toBe("accepted");
        const { actor } = await workflowBdd.setupWorkflowOrg({
          timezone: "Asia/Tokyo",
        });
        await connectBriefSource(actor);
        await accept(
          morningBriefPreferenceClient().update({
            headers: authHeaders(actor),
            body: { enabled: true },
          }),
          [200],
        );
        const [installation] = await listMorningBriefInstallations(actor);
        if (!installation) {
          throw new Error("Expected the Morning Brief installation");
        }
        const [initial] = await listMorningBriefAutomations(
          actor,
          installation.id,
        );
        expect(initial).toMatchObject({
          nextRunAt: "2030-01-01T22:00:00.000Z",
          schedule: {
            type: "cron",
            cronExpression: "0 7 * * *",
            timezone: "Asia/Tokyo",
          },
        });

        const minute = expectedMorningBriefMinute(actor);
        const cron = `${minute} 6 * * *`;
        mockNow(new Date(`2030-01-02T${localTime}+09:00`));
        expect((await syncSourceCatalog()).body).toMatchObject({
          outcome: "accepted",
        });
        await executeAutomationCron();
        await flushWaitUntilForTest();
        const [moved] = await listMorningBriefAutomations(
          actor,
          installation.id,
        );
        expect(moved).toMatchObject({
          id: initial?.id,
          enabled: true,
          nextRunAt: keepsPendingOccurrence
            ? "2030-01-01T22:00:00.000Z"
            : `2030-01-01T21:${minute}:00.000Z`,
          schedule: {
            type: "cron",
            cronExpression: cron,
            timezone: "Asia/Tokyo",
          },
          official: {
            reconciliationStatus: "current",
            parameterBindings: [{ key: "cron", value: cron }],
          },
        });
        if (!moved?.nextRunAt) {
          throw new Error("Expected the moved Morning Brief run");
        }

        // That day's brief runs once, then follows the owner's minute.
        const runnerGroup = runs.configureRunnerGroup();
        runs.acceptStorageDownloads();
        await runs.heartbeatRunner(runnerGroup);
        const fired = await fireOfficialSchedule(actor, moved);
        const claim = await runs.claimRunnerJob(fired.runId);
        mockNow(new Date(moved.nextRunAt).getTime() + 60_000);
        await webhooks.requestAgentComplete(
          { runId: fired.runId, exitCode: 0 },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        const [advanced] = await listMorningBriefAutomations(
          actor,
          installation.id,
        );
        expect(advanced?.nextRunAt).toBe(`2030-01-02T21:${minute}:00.000Z`);
      });
    },
  );
});

describe("Morning Brief catalog reconciliation", () => {
  // Cover each pair of independent dimensions without the full Cartesian product.
  const scenarios = [
    { definitionName: "morning-brief", paused: false, withBindings: false },
    { definitionName: "morning-brief", paused: true, withBindings: true },
    {
      definitionName: "internal-test-morning-brief",
      paused: false,
      withBindings: true,
    },
    {
      definitionName: "internal-test-morning-brief",
      paused: true,
      withBindings: false,
    },
  ];

  async function prepareReconciledSchedule({
    definitionName,
    paused,
    withBindings,
  }: (typeof scenarios)[number]) {
    // Publication and the scheduler are explicitly scoped authenticated
    // system boundaries; this first request selects the case-owned DB.
    installCatalogStorageFixture(context);
    const initialBlueprint: OfficialWorkflowBlueprint = {
      key: "daily-delivery",
      parameters: [],
      desiredState: {
        kind: "schedule",
        schedule: { type: "cron", cronExpression: "0 7 * * *" },
      },
    };
    // Both selectable Definitions start with the accepted initial schedule.
    expect(
      (
        await syncCatalog(
          catalog(
            MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.map((name) => {
              return activeDefinition(name, [initialBlueprint]);
            }),
          ),
        )
      ).body.outcome,
    ).toBe("accepted");
    // Keep the same S3 object store installed for the entire lifecycle.
    // setupWorkflowOrg would replace send with a permissive response.
    const actor = bdd.user();
    const { defaultAgentId } = await runs.grantProEntitlement(actor);
    await bdd.updateUserTimezone(actor, "Asia/Tokyo");
    await runs.ensurePersonalSubscriptionModel(actor);
    if (!actor.orgId) {
      throw new Error("Expected a Morning Brief workspace");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.AgentSuggestion]:
          definitionName === "internal-test-morning-brief",
      },
    );
    if (definitionName === "internal-test-morning-brief") {
      await accept(
        setupApp({ context, routes: proactiveSuggestionsRoutes })(
          proactiveSuggestionsContract,
        ).update({ headers: authHeaders(actor), body: { enabled: true } }),
        [200],
      );
    }
    await connectBriefSourceForAgent(actor, defaultAgentId);
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected the Morning Brief installation");
    }
    const [initial] = await listMorningBriefAutomations(actor, installation.id);
    if (!initial?.nextRunAt) {
      throw new Error("Expected its initial schedule");
    }
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    await runs.heartbeatRunner(runnerGroup);
    const first = await fireOfficialSchedule(actor, initial);
    const firstClaim = await runs.claimRunnerJob(first.runId);
    await createChatEventsFixture(context).completeChatRunOk(
      first.runId,
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      { cliAgentType: "pi", cliAgentSessionId: firstClaim.piSessionId },
    );
    await flushWaitUntilForTest();
    mockNow(new Date(initial.nextRunAt).getTime() + 1000);
    if (paused) {
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: false },
        }),
        [200],
      );
    }

    const blueprint = (changedDefaults: boolean): OfficialWorkflowBlueprint => {
      return {
        key: "daily-delivery",
        parameters: withBindings
          ? [
              {
                key: "delivery-cron",
                type: "string",
                format: "text",
                required: true,
                default: changedDefaults ? "0 9 * * *" : "0 8 * * *",
              },
              {
                key: "edition",
                type: "integer",
                required: true,
                default: changedDefaults ? 1 : 0,
              },
              {
                key: "include-summary",
                type: "boolean",
                required: true,
                default: changedDefaults,
              },
              {
                key: "note",
                type: "string",
                format: "text",
                required: true,
                default: changedDefaults ? "new default" : "",
              },
            ]
          : [],
        desiredState: {
          kind: "schedule",
          schedule: {
            type: "cron",
            cronExpression: withBindings
              ? { parameter: "delivery-cron" }
              : "0 8 * * *",
          },
        },
      };
    };
    const source = (
      blueprints: readonly OfficialWorkflowBlueprint[],
      retired = false,
    ) => {
      return catalog(
        MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.map((name) => {
          if (name !== definitionName) {
            return activeDefinition(name, [initialBlueprint]);
          }
          return retired
            ? {
                name,
                lifecycle: "retired" as const,
                presentation: { category: "productivity" },
              }
            : activeDefinition(name, blueprints);
        }),
      );
    };
    const bindings = withBindings
      ? [
          { key: "delivery-cron", value: "0 8 * * *" },
          { key: "edition", value: 0 },
          { key: "include-summary", value: false },
          { key: "note", value: "" },
        ]
      : [];
    expect((await syncCatalog(source([blueprint(false)]))).body.outcome).toBe(
      "accepted",
    );
    await executeAutomationCron();
    await flushWaitUntilForTest();
    await expect(listMorningBriefInstallations(actor)).resolves.toMatchObject([
      { id: installation.id, official: { definitionName } },
    ]);
    const [reconciled] = await listMorningBriefAutomations(
      actor,
      installation.id,
    );
    expect(reconciled).toMatchObject({
      id: initial.id,
      chatThreadId: first.chatThreadId,
      enabled: !paused,
      schedule: {
        type: "cron",
        cronExpression: "0 8 * * *",
        timezone: "Asia/Tokyo",
      },
      official: {
        blueprintKey: "daily-delivery",
        reconciliationStatus: "current",
        intendedEnabled: !paused,
        parameterBindings: bindings,
      },
    });
    expect(reconciled?.official?.appliedFingerprint).not.toBe(
      initial.official?.appliedFingerprint,
    );
    expect((await readBriefPreference(actor)).body).toMatchObject({
      enabled: !paused,
      status: paused ? "paused" : "enabled",
    });
    return {
      actor,
      installation,
      initial,
      first,
      blueprint,
      source,
      bindings,
      reconciled,
    };
  }

  it.each(scenarios)(
    "reconciles, removes and restores a schedule without replacing identities ($definitionName, paused=$paused, bindings=$withBindings)",
    async ({ definitionName, paused, withBindings }) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        const {
          actor,
          installation,
          initial,
          first,
          blueprint,
          source,
          bindings,
        } = await prepareReconciledSchedule({
          definitionName,
          paused,
          withBindings,
        });
        const history = await allThreadEventRows(actor, first.chatThreadId);
        expect((await syncCatalog(source([]))).body.outcome).toBe("accepted");
        await executeAutomationCron();
        await flushWaitUntilForTest();
        await expect(
          listMorningBriefAutomations(actor, installation.id),
        ).resolves.toStrictEqual([]);
        await accept(
          automationClient().get({
            headers: authHeaders(actor),
            params: { id: initial.id },
          }),
          [404],
        );
        await executeAutomationCron();
        await flushWaitUntilForTest();
        await expect(
          listMorningBriefAutomations(actor, installation.id),
        ).resolves.toStrictEqual([]);
        await expect(
          allThreadEventRows(actor, first.chatThreadId),
        ).resolves.toStrictEqual(history);

        // Valid retained values, including 0/false/empty string, beat new defaults.
        expect(
          (await syncCatalog(source([blueprint(true)]))).body.outcome,
        ).toBe("accepted");
        await executeAutomationCron();
        await flushWaitUntilForTest();
        const [restored] = await listMorningBriefAutomations(
          actor,
          installation.id,
        );
        expect(restored).toMatchObject({
          id: initial.id,
          chatThreadId: first.chatThreadId,
          enabled: !paused,
          schedule: {
            type: "cron",
            cronExpression: "0 8 * * *",
            timezone: "Asia/Tokyo",
          },
          official: {
            intendedEnabled: !paused,
            reconciliationStatus: "current",
            parameterBindings: bindings,
          },
        });
        await expect(
          listMorningBriefInstallations(actor),
        ).resolves.toMatchObject([
          { id: installation.id, official: { definitionName } },
        ]);
        await expect(
          allThreadEventRows(actor, first.chatThreadId),
        ).resolves.toStrictEqual(history);
        const outsider = bdd.user();
        await accept(
          automationClient().get({
            headers: authHeaders(outsider),
            params: { id: initial.id },
          }),
          [404],
        );
        await executeAutomationCron();
        await flushWaitUntilForTest();
        const unchanged = await listMorningBriefAutomations(
          actor,
          installation.id,
        );
        expect(unchanged).toMatchObject([
          {
            id: initial.id,
            chatThreadId: first.chatThreadId,
            enabled: !paused,
          },
        ]);
        if (paused) {
          expect(restored?.nextRunAt).toBeNull();

          await accept(
            morningBriefPreferenceClient().update({
              headers: authHeaders(actor),
              body: { enabled: true },
            }),
            [200],
          );
        }
        const [scheduled] = paused
          ? await listMorningBriefAutomations(actor, installation.id)
          : unchanged;
        if (!scheduled) {
          throw new Error("Expected the reconciled schedule");
        }
        const next = await fireOfficialSchedule(actor, scheduled);
        expect(next.chatThreadId).toBe(first.chatThreadId);
        const claim = await runs.claimRunnerJob(next.runId);
        expect(claim.prompt.startsWith(`/${definitionName}\n`)).toBeTruthy();
        expect(
          capturedOfficialSkill(claim.storageManifest, definitionName),
        ).toContain("Execute only the accepted Definition content.");
        await webhooks.requestAgentComplete(
          { runId: next.runId, exitCode: 0 },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
      });
    },
  );

  // Retirement skips active-definition reconciliation regardless of bindings.
  it.each([
    { definitionName: "morning-brief", paused: false, withBindings: false },
    {
      definitionName: "internal-test-morning-brief",
      paused: true,
      withBindings: false,
    },
  ] as const)(
    "retains schedule identity and history while its definition is retired ($definitionName, paused=$paused, bindings=$withBindings)",
    async ({ definitionName, paused, withBindings }) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        const {
          actor,
          installation,
          initial,
          first,
          blueprint,
          source,
          bindings,
          reconciled,
        } = await prepareReconciledSchedule({
          definitionName,
          paused,
          withBindings,
        });
        const history = await allThreadEventRows(actor, first.chatThreadId);
        // Retirement is an active-only worker no-op, even though it has no key.
        expect((await syncCatalog(source([], true))).body.outcome).toBe(
          "accepted",
        );
        await executeAutomationCron();
        await flushWaitUntilForTest();
        await expect(
          listMorningBriefAutomations(actor, installation.id),
        ).resolves.toMatchObject([
          {
            id: initial.id,
            enabled: !paused,
            official: { parameterBindings: bindings },
          },
        ]);
        await expect(
          listMorningBriefInstallations(actor),
        ).resolves.toMatchObject([
          { id: installation.id, official: { definitionName } },
        ]);
        await expect(
          allThreadEventRows(actor, first.chatThreadId),
        ).resolves.toStrictEqual(history);

        await executeAutomationCron();
        await flushWaitUntilForTest();
        await expect(
          listMorningBriefAutomations(actor, installation.id),
        ).resolves.toStrictEqual([reconciled]);
        await expect(
          allThreadEventRows(actor, first.chatThreadId),
        ).resolves.toStrictEqual(history);

        expect(
          (await syncCatalog(source([blueprint(false)]))).body.outcome,
        ).toBe("accepted");
        await executeAutomationCron();
        await flushWaitUntilForTest();
        await expect(
          listMorningBriefAutomations(actor, installation.id),
        ).resolves.toStrictEqual([reconciled]);
        await expect(
          listMorningBriefInstallations(actor),
        ).resolves.toMatchObject([
          { id: installation.id, official: { definitionName } },
        ]);
        await expect(
          allThreadEventRows(actor, first.chatThreadId),
        ).resolves.toStrictEqual(history);
      });
    },
  );
});

describe("Morning Brief suggestion instruction rollout", () => {
  it.each([
    { enabled: false, expected: false },
    { enabled: true, expected: true },
  ])(
    "scopes suggestion guidance to enabled=$enabled scheduled runs",
    async ({ enabled, expected }) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        installCatalogStorageFixture(context);
        await syncDeployedCatalog();

        const { actor } = await workflowBdd.setupWorkflowOrg({
          timezone: "Asia/Shanghai",
        });
        if (!actor.orgId) {
          throw new Error("Expected an organization-scoped actor");
        }
        await connectBriefSource(actor);
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.AgentSuggestion]: enabled },
        );
        if (enabled) {
          await accept(
            setupApp({ context, routes: proactiveSuggestionsRoutes })(
              proactiveSuggestionsContract,
            ).update({ headers: authHeaders(actor), body: { enabled: true } }),
            [200],
          );
        }
        await accept(
          morningBriefPreferenceClient().update({
            headers: authHeaders(actor),
            body: { enabled: true },
          }),
          [200],
        );
        const [installation] = await listMorningBriefInstallations(actor);
        if (!installation) {
          throw new Error("Expected the primary Morning Brief installation");
        }
        const [automation] = await readMorningBriefAutomations(
          actor,
          installation.id,
        );
        if (!automation) {
          throw new Error("Expected a Morning Brief schedule");
        }
        const runnerGroup = runs.configureRunnerGroup();
        runs.acceptStorageDownloads();
        await runs.heartbeatRunner(runnerGroup);
        const { runId } = await fireOfficialSchedule(actor, automation);
        const claim = await runs.claimRunnerJob(runId);
        onTestFinished(async () => {
          await webhooks.requestAgentComplete(
            {
              runId,
              exitCode: 1,
              error: "Morning Brief suggestion fixture cleanup",
            },
            { authorization: `Bearer ${claim.sandboxToken}` },
            [200],
          );
          await flushWaitUntilForTest();
        });
        expect(claim.appendSystemPrompt).not.toContain("okou suggestion");
        const definitionName = expected
          ? "internal-test-morning-brief"
          : "morning-brief";
        expect(claim.prompt).toMatch(new RegExp(`^/${definitionName}\\n`));
        const mountedSkill = capturedOfficialSkill(
          claim.storageManifest,
          definitionName,
        );
        expect(mountedSkill.includes("okou suggestion list --json")).toBe(
          expected,
        );
        if (expected) {
          expect(mountedSkill).toContain(
            "Match existing active suggestions before creating another.",
          );
          expect(mountedSkill).toContain(
            "There may be zero to ten active suggestions",
          );
        }
      });
    },
  );
});

describe("Debug Morning Brief", () => {
  function debugClient() {
    return setupApp({ context, routes: debugMorningBriefRoutes })(
      debugMorningBriefContract,
    );
  }
  async function enabledBrief() {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    await selectPersonalDefaultModel(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    if (!actor.orgId) {
      throw new Error("Expected a workspace");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.OkouDebug]: true },
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected Morning Brief");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected a daily schedule");
    }
    return { actor, installation, automation };
  }
  it.each([false, true])(
    "executes the selected Official skill with suggestions enabled=%s, deduplicates retries and preserves the daily schedule",
    async (enabled) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        const { actor, installation, automation } = await enabledBrief();
        if (!actor.orgId) {
          throw new Error("Expected a workspace");
        }
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.AgentSuggestion]: enabled },
        );
        if (enabled) {
          await accept(
            setupApp({ context, routes: proactiveSuggestionsRoutes })(
              proactiveSuggestionsContract,
            ).update({ headers: authHeaders(actor), body: { enabled: true } }),
            [200],
          );
        }
        const runnerGroup = runs.configureRunnerGroup();
        runs.acceptStorageDownloads();
        await runs.heartbeatRunner(runnerGroup);
        const requestId = randomUUID();
        const requestHeaders = authHeaders(actor);
        const submissions = await Promise.all(
          Array.from({ length: enabled ? 1 : 4 }, () => {
            return accept(
              debugClient().run({
                headers: requestHeaders,
                body: { requestId: requestId.toUpperCase() },
              }),
              [200],
            );
          }),
        );
        const requested = submissions[0];
        if (!requested) {
          throw new Error("Expected an accepted Debug request");
        }
        for (const submission of submissions) {
          expect(submission.body).toMatchObject({
            requestId,
            chatThreadId: requested.body.chatThreadId,
          });
        }
        expect(requested.body).toMatchObject({ requestId, status: "queued" });
        const retryHeaders = authHeaders(actor);
        const replayed = await Promise.all(
          Array.from({ length: 3 }, () => {
            return debugClient().run({
              headers: retryHeaders,
              body: { requestId },
            });
          }),
        );
        for (const replay of replayed) {
          expect(replay).toMatchObject({
            status: 200,
            body: { requestId, chatThreadId: requested.body.chatThreadId },
          });
        }
        await flushWaitUntilForTest();
        const receipt = await accept(
          debugClient().get({
            headers: authHeaders(actor),
            params: { id: requestId },
          }),
          [200],
        );
        const runId = receipt.body.runId;
        if (!runId) {
          throw new Error("Expected a real Agent Run");
        }
        expect(
          (
            await accept(
              debugClient().run({
                headers: authHeaders(actor),
                body: { requestId },
              }),
              [200],
            )
          ).body,
        ).toStrictEqual(receipt.body);
        const claim = await runs.claimRunnerJob(runId);
        const name = enabled ? "internal-test-morning-brief" : "morning-brief";
        mockEnv("RESEND_API_KEY", "test-key");
        mockEnv("RESEND_FROM_DOMAIN", "okou.io");
        mockClerkUsers(context, [
          {
            id: actor.userId,
            primaryEmailAddressId: "primary",
            emailAddresses: [{ id: "primary", emailAddress: actor.email }],
          },
        ]);
        const notifications = setupApp({
          context,
          routes: notificationsRoutes,
        })(notificationsContract);
        const notificationHeaders = {
          authorization: `Bearer ${okouTokenFromClaim(claim)}`,
        };
        const brief = {
          kind: "morning-brief" as const,
          to: "me" as const,
          subject: "Debug Morning Brief",
          text: "Verified briefing.",
        };
        const notification = await accept(
          notifications.mail({ headers: notificationHeaders, body: brief }),
          [200],
        );
        expect(notification.body).toMatchObject({
          status: "queued",
          deduplicated: false,
        });
        // The automation event identifies the email, so a retry replays it.
        expect(
          (
            await accept(
              notifications.mail({ headers: notificationHeaders, body: brief }),
              [200],
            )
          ).body,
        ).toStrictEqual({ ...notification.body, deduplicated: true });
        await accept(
          notifications.mail({
            headers: notificationHeaders,
            body: { ...brief, text: "A regenerated briefing." },
          }),
          [409],
        );
        expect(claim.prompt.split("\n")[0]).toBe(`/${name}`);
        expect(claim.prompt).toContain("morning-brief-debug");
        expect(claim.appendSystemPrompt).not.toContain("okou suggestion");
        expect(
          capturedOfficialSkill(claim.storageManifest, name).includes(
            "okou suggestion list --json",
          ),
        ).toBe(enabled);
        expect(
          (await readMorningBriefAutomations(actor, installation.id))[0],
        ).toMatchObject({
          id: automation.id,
          nextRunAt: automation.nextRunAt,
          enabled: true,
          schedule: automation.schedule,
        });
        if (enabled) {
          await createChatEventsFixture(context).completeChatRunOk(
            runId,
            {
              authorization: `Bearer ${claim.sandboxToken}`,
            },
            { cliAgentType: "pi", cliAgentSessionId: claim.piSessionId },
          );
        } else {
          await webhooks.requestAgentComplete(
            { runId, exitCode: 1, error: "Debug brief finished" },
            { authorization: `Bearer ${claim.sandboxToken}` },
            [200],
          );
        }
        await flushWaitUntilForTest();
        expect(
          (
            await accept(
              debugClient().get({
                headers: authHeaders(actor),
                params: { id: requestId },
              }),
              [200],
            )
          ).body,
        ).toMatchObject({ runId, status: enabled ? "completed" : "failed" });
        expect(
          (await readMorningBriefAutomations(actor, installation.id))[0],
        ).toMatchObject({
          nextRunAt: automation.nextRunAt,
          enabled: true,
        });
      });
    },
  );
  it("preserves a scheduled occurrence queued behind a Debug run", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      const { actor, installation, automation } = await enabledBrief();
      if (!automation.nextRunAt) {
        throw new Error("Expected a daily anchor");
      }
      // Cross the due boundary without expiring the Debug run's sandbox JWT.
      mockNow(new Date(new Date(automation.nextRunAt).getTime() - 60_000));
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      const requestId = randomUUID();
      const requested = await accept(
        debugClient().run({ headers: authHeaders(actor), body: { requestId } }),
        [200],
      );
      await flushWaitUntilForTest();
      const receipt = await accept(
        debugClient().get({
          headers: authHeaders(actor),
          params: { id: requestId },
        }),
        [200],
      );
      const debugRunId = receipt.body.runId;
      if (!debugRunId || !automation.nextRunAt) {
        throw new Error("Expected a debug run and daily anchor");
      }
      const debugClaim = await runs.claimRunnerJob(debugRunId);
      mockEnv("RESEND_API_KEY", "test-key");
      mockEnv("RESEND_FROM_DOMAIN", "okou.io");
      mockClerkUsers(context, [
        {
          id: actor.userId,
          primaryEmailAddressId: "primary",
          emailAddresses: [{ id: "primary", emailAddress: actor.email }],
        },
      ]);
      // Run-token requests re-read membership once the mocked schedule clock
      // has outlived the cached member role.
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: [
            {
              role: actor.orgRole ?? "org:member",
              organization: { id: actor.orgId },
            },
          ],
        },
      );
      const sendBrief = async (claim: typeof debugClaim) => {
        return (
          await accept(
            setupApp({ context, routes: notificationsRoutes })(
              notificationsContract,
            ).mail({
              headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
              body: {
                kind: "morning-brief",
                to: "me",
                subject: "Morning Brief",
                text: "Verified briefing.",
              },
            }),
            [200],
          )
        ).body;
      };
      const debugBrief = await sendBrief(debugClaim);
      expect(debugBrief).toMatchObject({
        status: "queued",
        deduplicated: false,
      });
      await withMockNowForTest(new Date(automation.nextRunAt), async () => {
        await executeAutomationCron();
        await flushWaitUntilForTest();
        expect(
          (await readMorningBriefAutomations(actor, installation.id))[0]
            ?.nextRunAt,
        ).toBeNull();
        await webhooks.requestAgentComplete(
          {
            runId: debugRunId,
            exitCode: 1,
            error: "Debug finished before scheduled run",
          },
          { authorization: `Bearer ${debugClaim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
        const pending = (
          await readMorningBriefAutomations(actor, installation.id)
        )[0];
        expect(pending?.nextRunAt).toBeNull();
        const scheduledRunId = await launchedAutomationRunId(
          actor,
          requested.body.chatThreadId,
        );
        if (!scheduledRunId || scheduledRunId === debugRunId) {
          throw new Error("Expected the queued scheduled run");
        }
        const scheduledClaim = await runs.claimRunnerJob(scheduledRunId);
        // Each automation event sends its own email, even with identical content.
        const scheduledBrief = await sendBrief(scheduledClaim);
        expect(scheduledBrief).toMatchObject({
          status: "queued",
          deduplicated: false,
        });
        expect(scheduledBrief.notificationId).not.toBe(
          debugBrief.notificationId,
        );
        await createChatEventsFixture(context).completeChatRunOk(
          scheduledRunId,
          { authorization: `Bearer ${scheduledClaim.sandboxToken}` },
          { cliAgentType: "pi", cliAgentSessionId: scheduledClaim.piSessionId },
        );
        await flushWaitUntilForTest();
        const settled = (
          await readMorningBriefAutomations(actor, installation.id)
        )[0];
        expect(settled?.nextRunAt).not.toBeNull();
        expect(settled?.enabled).toBeTruthy();
      });
    });
  });
  it("requires a signed-in session and Okou Debug", async () => {
    const anonymous = await accept(
      debugClient().run({ body: { requestId: randomUUID() } }),
      [401],
    );
    expect(anonymous.status).toBe(401);
    await accept(debugClient().get({ params: { id: randomUUID() } }), [401]);
    const { actor } = await enabledBrief();
    if (!actor.orgId) {
      throw new Error("Expected a workspace");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      { [FeatureSwitchKey.OkouDebug]: false },
    );
    await accept(
      debugClient().run({
        headers: authHeaders(actor),
        body: { requestId: randomUUID() },
      }),
      [403],
    );
    await accept(
      debugClient().get({
        headers: authHeaders(actor),
        params: { id: randomUUID() },
      }),
      [403],
    );
  });
  it("does not enable a paused schedule or consume an in-flight scheduled occurrence", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      const { actor, installation, automation } = await enabledBrief();
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: false },
        }),
        [200],
      );
      await accept(
        debugClient().run({
          headers: authHeaders(actor),
          body: { requestId: randomUUID() },
        }),
        [409],
      );
      expect(
        (await readMorningBriefAutomations(actor, installation.id))[0]?.enabled,
      ).toBeFalsy();
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      const fired = await fireOfficialSchedule(actor, automation);
      const claim = await runs.claimRunnerJob(fired.runId);
      onTestFinished(async () => {
        await webhooks.requestAgentComplete(
          { runId: fired.runId, exitCode: 1, error: "Scheduled brief cleanup" },
          { authorization: `Bearer ${claim.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
      });
      await accept(
        debugClient().run({
          headers: authHeaders(actor),
          body: { requestId: randomUUID() },
        }),
        [409],
      );
      expect(
        (await readMorningBriefAutomations(actor, installation.id))[0]
          ?.nextRunAt,
      ).toBeNull();
    });
  });
  it("scopes request receipts to their member and workspace", async () => {
    const { actor } = await enabledBrief();
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    await runs.heartbeatRunner(runnerGroup);
    const requestId = randomUUID();
    await accept(
      debugClient().run({ headers: authHeaders(actor), body: { requestId } }),
      [200],
    );
    await flushWaitUntilForTest();
    const { actor: other } = await enabledBrief();
    await accept(
      debugClient().get({
        headers: authHeaders(other),
        params: { id: requestId },
      }),
      [404],
    );
    await accept(
      debugClient().run({ headers: authHeaders(other), body: { requestId } }),
      [409],
    );
    expect(
      (
        await accept(
          debugClient().get({
            headers: authHeaders(actor),
            params: { id: requestId },
          }),
          [200],
        )
      ).body.requestId,
    ).toBe(requestId);
  });
});

describe("Morning Brief workflow selection", () => {
  it("switches an existing schedule both ways without replacing settings or conversation", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      const { actor } = await prepareBriefMember();
      await initializeBriefMember(actor, "Asia/Tokyo");
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const [installation] = await listMorningBriefInstallations(actor);
      if (!installation || !actor.orgId) {
        throw new Error("Expected a Morning Brief installation");
      }
      const [initial] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!initial) {
        throw new Error("Expected its schedule");
      }
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      let conversation: string | undefined;
      for (const [iteration, enabled] of [false, true, false].entries()) {
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.AgentSuggestion]: enabled },
        );
        if (enabled) {
          await accept(
            setupApp({ context, routes: proactiveSuggestionsRoutes })(
              proactiveSuggestionsContract,
            ).update({ headers: authHeaders(actor), body: { enabled: true } }),
            [200],
          );
        }
        const [schedule] = await readMorningBriefAutomations(
          actor,
          installation.id,
        );
        if (!schedule?.nextRunAt) {
          throw new Error("Expected retained schedule");
        }
        expect(schedule).toMatchObject({
          id: initial.id,
          enabled: true,
          schedule: { timezone: "Asia/Tokyo" },
        });
        const fired = await fireOfficialSchedule(actor, schedule);
        if (conversation) {
          expect(fired.chatThreadId).toBe(conversation);
        }
        conversation = fired.chatThreadId;
        const claim = await withMockNowForTest(
          new Date(schedule.nextRunAt),
          () => {
            return runs.claimRunnerJob(fired.runId);
          },
        );
        const name = enabled ? "internal-test-morning-brief" : "morning-brief";
        expect(claim.prompt).toMatch(new RegExp(`^/${name}\\n`));
        expect(claim.appendSystemPrompt).not.toContain("okou suggestion");
        expect(
          capturedOfficialSkill(claim.storageManifest, name).includes(
            "okou suggestion list --json",
          ),
        ).toBe(enabled);
        await expect(
          listMorningBriefInstallations(actor),
        ).resolves.toMatchObject([
          { id: installation.id, official: { definitionName: name } },
        ]);
        expect((await readBriefPreference(actor)).body).toMatchObject({
          enabled: true,
          status: "enabled",
        });
        if (iteration === 0) {
          await updateFeatureSwitchesForUser(
            context,
            { ...actor, orgId: actor.orgId },
            { [FeatureSwitchKey.AgentSuggestion]: true },
          );
          await accept(
            setupApp({ context, routes: proactiveSuggestionsRoutes })(
              proactiveSuggestionsContract,
            ).update({
              headers: authHeaders(actor),
              body: { enabled: true },
            }),
            [200],
          );
          await withMockNowForTest(
            new Date(schedule.nextRunAt),
            executeAutomationCron,
          );
          await expect(
            listMorningBriefInstallations(actor),
          ).resolves.toMatchObject([
            {
              id: installation.id,
              official: { definitionName: "morning-brief" },
            },
          ]);
        }
        await withMockNowForTest(new Date(schedule.nextRunAt), async () => {
          await createChatEventsFixture(context).completeChatRunOk(
            fired.runId,
            { authorization: `Bearer ${claim.sandboxToken}` },
            { cliAgentType: "pi", cliAgentSessionId: claim.piSessionId },
          );
          await flushWaitUntilForTest();
        });
      }
    });
  });

  it("keeps paused briefs paused and admits one occurrence across concurrent rollout ticks", async () => {
    await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
      const { actor } = await prepareBriefMember();
      await initializeBriefMember(actor, "Asia/Shanghai");
      if (!actor.orgId) {
        throw new Error("Expected an organization");
      }
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const [installation] = await listMorningBriefInstallations(actor);
      if (!installation) {
        throw new Error("Expected installed brief");
      }
      const [initial] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!initial) {
        throw new Error("Expected a schedule");
      }
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: false },
        }),
        [200],
      );
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: actor.orgId },
        { [FeatureSwitchKey.AgentSuggestion]: true },
      );
      await accept(
        setupApp({ context, routes: proactiveSuggestionsRoutes })(
          proactiveSuggestionsContract,
        ).update({ headers: authHeaders(actor), body: { enabled: true } }),
        [200],
      );
      await executeAutomationCron();
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: false,
        status: "paused",
      });
      await expect(
        readMorningBriefAutomations(actor, installation.id),
      ).resolves.toMatchObject([
        { id: initial.id, enabled: false, nextRunAt: null },
      ]);
      await accept(
        morningBriefPreferenceClient().update({
          headers: authHeaders(actor),
          body: { enabled: true },
        }),
        [200],
      );
      const [schedule] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!schedule?.nextRunAt) {
        throw new Error("Expected resumed schedule");
      }
      const runnerGroup = runs.configureRunnerGroup();
      runs.acceptStorageDownloads();
      await runs.heartbeatRunner(runnerGroup);
      await withMockNowForTest(new Date(schedule.nextRunAt), async () => {
        await Promise.all([executeAutomationCron(), executeAutomationCron()]);
        await flushWaitUntilForTest();
      });
      const [running] = await readMorningBriefAutomations(
        actor,
        installation.id,
      );
      if (!running?.chatThreadId) {
        throw new Error("Expected a delivery thread");
      }
      const runId = await launchedAutomationRunId(actor, running.chatThreadId);
      if (!runId) {
        throw new Error("Expected its scheduled Run");
      }
      const onboarding = await bdd.readOnboardingStatus(actor);
      if (!onboarding.defaultAgentId) {
        throw new Error("Expected Okou");
      }
      const briefEvents = await allThreadEventRows(actor, running.chatThreadId);
      expect(
        briefEvents
          .filter((event) => {
            return event.eventType === "input.prompt" && event.runId;
          })
          .map((event) => {
            return event.runId;
          }),
      ).toStrictEqual([runId]);
      const claim = await withMockNowForTest(
        new Date(schedule.nextRunAt),
        () => {
          return runs.claimRunnerJob(runId);
        },
      );
      expect(claim.prompt).toMatch(/^\/internal-test-morning-brief\n/);
      await expect(
        readMorningBriefAutomations(actor, installation.id),
      ).resolves.toMatchObject([{ id: initial.id, nextRunAt: null }]);
      await withMockNowForTest(new Date(schedule.nextRunAt), async () => {
        await createChatEventsFixture(context).completeChatRunOk(
          runId,
          { authorization: `Bearer ${claim.sandboxToken}` },
          { cliAgentType: "pi", cliAgentSessionId: claim.piSessionId },
        );
        await flushWaitUntilForTest();
      });
      expect((await readBriefPreference(actor)).body).toMatchObject({
        enabled: true,
        status: "enabled",
      });
    });
  });
});

describe("Official schedule expiry", () => {
  async function readAutomation(actor: ApiTestUser, id: string) {
    const response = await accept(
      automationClient().get({ headers: authHeaders(actor), params: { id } }),
      [200],
    );
    return response.body;
  }

  it.each(["before", "after"] as const)(
    "preserves a Morning Brief occurrence claimed %s a later tick, settings retry and duplicate completion",
    async (claimTiming) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        installCatalogStorageFixture(context);
        await syncDeployedCatalog();
        const { actor } = await workflowBdd.setupWorkflowOrg({
          timezone: "Asia/Shanghai",
        });
        await connectBriefSource(actor);
        await accept(
          morningBriefPreferenceClient().update({
            headers: authHeaders(actor),
            body: { enabled: true },
          }),
          [200],
        );
        const [installation] = await listMorningBriefInstallations(actor);
        if (!installation?.agentId) {
          throw new Error("Expected the member's Morning Brief Agent");
        }
        const [automation] = await readMorningBriefAutomations(
          actor,
          installation.id,
        );
        if (!automation?.nextRunAt) {
          throw new Error("Expected the Morning Brief anchor");
        }
        const runnerGroup = runs.configureRunnerGroup();
        runs.acceptStorageDownloads();
        await runs.heartbeatRunner(runnerGroup);
        mockNow(Date.parse(automation.nextRunAt) + 30 * 60_000);
        await executeAutomationCron();
        await flushWaitUntilForTest();
        const runIds = await listAgentRunLogIds(actor, installation.agentId);
        expect(runIds).toHaveLength(1);
        const runId = runIds[0];
        if (!runId) {
          throw new Error("Expected the scheduled Morning Brief Run");
        }
        if (claimTiming === "after") {
          mockNow(now() + 60 * 60_000);
          expect((await executeAutomationCron()).body.executed).toBe(0);
          await flushWaitUntilForTest();
          await expect(
            listAgentRunLogIds(actor, installation.agentId),
          ).resolves.toStrictEqual(runIds);
        }
        const claim = await runs.claimRunnerJob(runId);
        const completion = () => {
          return webhooks.requestAgentComplete(
            { runId, exitCode: 1, error: "Morning Brief Runner completion" },
            { authorization: `Bearer ${claim.sandboxToken}` },
            [200],
          );
        };
        onTestFinished(async () => {
          await completion();
        });
        mockNow(now() + 60 * 60_000);
        await executeAutomationCron();
        await expect(
          readAutomation(actor, automation.id),
        ).resolves.toMatchObject({
          enabled: true,
          nextRunAt: null,
        });
        await expect(
          listAgentRunLogIds(actor, installation.agentId),
        ).resolves.toStrictEqual(runIds);
        await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
          status: "running",
        });
        mockBriefMemberships([
          { actor, createdAt: new Date("2030-01-01T00:00:00Z") },
        ]);
        await publishRecoveryBrief("Asia/Tokyo");
        await accept(
          morningBriefPreferenceClient().retry({ headers: authHeaders(actor) }),
          [200],
        );
        await expect(
          readAutomation(actor, automation.id),
        ).resolves.toMatchObject({
          enabled: true,
          nextRunAt: null,
          schedule: { timezone: "Asia/Tokyo" },
          official: { reconciliationStatus: "current" },
        });
        await completion();
        await flushWaitUntilForTest();
        const settled = await readAutomation(actor, automation.id);
        expect(settled.nextRunAt).not.toBeNull();
        if (!settled.nextRunAt) {
          throw new Error("Expected the successor Morning Brief anchor");
        }
        expect(Date.parse(settled.nextRunAt)).toBeGreaterThan(now());
        await completion();
        await executeAutomationCron();
        await expect(
          readAutomation(actor, automation.id),
        ).resolves.toStrictEqual(settled);
        await expect(
          listAgentRunLogIds(actor, installation.agentId),
        ).resolves.toStrictEqual(runIds);
      });
    },
  );
});

describe("Official Workflow credit policy", () => {
  async function enabledOfficialWorkflow() {
    const { actor } = await prepareBriefMember();
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          id: `membership-${actor.userId}-${actor.orgId}`,
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ],
    });
    await initializeBriefMember(actor, "Asia/Shanghai");
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected Official installation");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected Official automation");
    }
    const runnerGroup = runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    await runs.heartbeatRunner(runnerGroup);
    return { actor, installation, automation, runnerGroup };
  }

  it("rejects direct messages, agent messages, interrupts, cancellation and thread deletion", async () => {
    const { actor, installation, automation } = await enabledOfficialWorkflow();
    if (!automation.nextRunAt) {
      throw new Error("Expected scheduled time");
    }
    mockNow(new Date(automation.nextRunAt).getTime());
    const started = await fireOfficialSchedule(actor, automation);
    const claim = await runs.claimRunnerJob(started.runId);
    const before = await allThreadEventRows(actor, started.chatThreadId);
    await chat.requestSendEvent(
      actor,
      {
        agentId: installation.agentId,
        threadId: started.chatThreadId,
        prompt: "Perform an unrelated task",
      },
      [403],
    );
    await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
        body: {
          agentId: installation.agentId,
          threadId: started.chatThreadId,
          prompt: "Steer the free Run",
          hasTextContent: true,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Steer the free Run" }],
          },
        },
      }),
      [403],
    );
    await chat.requestSendEvent(
      actor,
      {
        agentId: installation.agentId,
        threadId: started.chatThreadId,
        interruptsRunId: started.runId,
      },
      [403],
    );
    const refused = await runs.requestCancelRun(actor, started.runId, [404]);
    expect(refused.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    await chat.requestDeleteThread(actor, started.chatThreadId, [404]);
    await expect(
      allThreadEventRows(actor, started.chatThreadId),
    ).resolves.toStrictEqual(before);
    await expect(
      runs.nextSteerableInput(claim.sandboxToken, started.runId),
    ).resolves.toMatchObject({ input: null });
    expect(claim.piSessionId).toBe(started.runId);
    await createChatEventsFixture(context).completeChatRunOk(
      started.runId,
      { authorization: `Bearer ${claim.sandboxToken}` },
      { cliAgentType: "pi", cliAgentSessionId: claim.piSessionId },
    );
    await flushWaitUntilForTest();
    expect((await runs.readRun(actor, started.runId)).status).toBe("completed");
    await chat.requestSendEvent(
      actor,
      {
        agentId: installation.agentId,
        threadId: started.chatThreadId,
        prompt: "Continue after completion",
      },
      [403],
    );
  });

  it("settles late Official usage for free while refusing new work from completed Runs", async () => {
    const { actor, automation } = await enabledOfficialWorkflow();
    await runs.grantProEntitlement(actor);
    const creditsBefore = (await runs.readBillingStatus(actor)).credits;
    expect(creditsBefore).toBeGreaterThan(0);
    const packBefore = await runs.readUsagePackCredits(actor);
    const started = await fireOfficialSchedule(actor, automation);
    const claim = await runs.claimRunnerJob(started.runId);
    await createChatEventsFixture(context).completeChatRunOk(
      started.runId,
      { authorization: `Bearer ${claim.sandboxToken}` },
      { cliAgentType: "pi", cliAgentSessionId: claim.piSessionId },
    );
    await flushWaitUntilForTest();
    mockEnv("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN", "official-search-provider");
    await accept(
      setupApp({ context, routes: webSearchRoutes })(webSearchContract).search({
        headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
        body: { query: "A new task after the Official Run ended", limit: 1 },
      }),
      [403],
    );
    await accept(
      setupApp({ context, routes: imageIoGenerateRoutes })(
        imageIoGenerateContract,
      ).post({
        headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
        body: { prompt: "A new image after the Official Run ended" },
      }),
      [403],
    );
    await webhooks.requestAgentUsageEvent(
      {
        runId: started.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "model",
            provider: "@preset/okou-1-0",
            category: "tokens.input",
            quantity: 100_000,
          },
        ],
      },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect((await runs.readBillingStatus(actor)).credits).toBe(creditsBefore);
    expect((await runs.readUsagePackCredits(actor)).totalCredits).toBe(
      packBefore.totalCredits,
    );
  });

  it("starts each Official execution with its own native session and no previous conversation", async () => {
    const { actor, installation, automation } = await enabledOfficialWorkflow();
    if (!automation.nextRunAt) {
      throw new Error("Expected scheduled time");
    }
    mockNow(new Date(automation.nextRunAt).getTime());
    const started = await fireOfficialSchedule(actor, automation);
    const claim = await runs.claimRunnerJob(started.runId);
    expect(claim.piSessionId).toBe(started.runId);
    await createChatEventsFixture(context).completeChatRunOk(
      started.runId,
      { authorization: `Bearer ${claim.sandboxToken}` },
      { cliAgentType: "pi", cliAgentSessionId: claim.piSessionId },
    );
    await flushWaitUntilForTest();
    const [nextAutomation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!nextAutomation) {
      throw new Error("Expected successor schedule");
    }
    const next = await fireOfficialSchedule(actor, nextAutomation);
    const nextClaim = await runs.claimRunnerJob(next.runId);
    expect(next.chatThreadId).toBe(started.chatThreadId);
    expect(nextClaim.piSessionId).toBe(next.runId);
    expect(nextClaim.nativeContinuation).toMatchObject({
      sessionId: null,
      generationRunId: null,
      recoveryPrompt: null,
    });
    await createChatEventsFixture(context).completeChatRunOk(
      next.runId,
      { authorization: `Bearer ${nextClaim.sandboxToken}` },
      { cliAgentType: "pi", cliAgentSessionId: nextClaim.piSessionId },
    );
    await flushWaitUntilForTest();
  });

  it("keeps ordinary Runs on their paid policy alongside free Official automations", async () => {
    const { actor, installation } = await enabledOfficialWorkflow();
    const before = await runs.readBillingStatus(actor);
    const packBefore = await runs.readUsagePackCredits(actor);
    const started = await runs.createThreadRun(actor, {
      agentId: installation.agentId,
      model: null,
      prompt: "An ordinary paid task beside Official automations",
    });
    const claim = await runs.claimRunnerJob(started.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    await webhooks.requestAgentUsageEvent(
      {
        runId: started.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "model",
            provider: "@preset/okou-1-0",
            category: "tokens.input",
            quantity: 1000,
          },
        ],
      },
      headers,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: started.runId,
        exitCode: 1,
        error: "Paid policy fixture finished",
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect((await runs.readBillingStatus(actor)).credits).toBe(before.credits);
    expect((await runs.readUsagePackCredits(actor)).totalCredits).toBe(
      packBefore.totalCredits - 1,
    );
  });

  it("runs models, search and image generation at zero credits and settles retries for free", async () => {
    const { actor, installation, automation, runnerGroup } =
      await enabledOfficialWorkflow();
    const funded = await runs.readBillingStatus(actor);
    const fundedPack = await runs.readUsagePackCredits(actor);
    await chat.updateUserModelPreference(actor, null, "gpt-image-1");
    // Spend the normal onboarding grant through the ordinary Auto Run protocol.
    const ordinary = await runs.createThreadRun(actor, {
      agentId: installation.agentId,
      model: null,
      prompt: "Spend the ordinary credit grant",
    });
    const ordinaryClaim = await runs.claimRunnerJob(ordinary.runId);
    await webhooks.requestAgentUsageEvent(
      {
        runId: ordinary.runId,
        events: [
          {
            idempotencyKey: randomUUID(),
            kind: "model",
            provider: "@preset/okou-1-0",
            category: "tokens.input",
            quantity: (funded.credits + fundedPack.totalCredits) * 1000,
          },
        ],
      },
      { authorization: `Bearer ${ordinaryClaim.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentComplete(
      { runId: ordinary.runId, exitCode: 1, error: "Ordinary task finished" },
      { authorization: `Bearer ${ordinaryClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect((await runs.readBillingStatus(actor)).credits).toBe(0);
    expect((await runs.readUsagePackCredits(actor)).totalCredits).toBe(0);
    await expect(
      runs.readThreadRunRejection(actor, {
        agentId: installation.agentId,
        model: null,
        prompt: "An ordinary task at zero balance",
      }),
    ).resolves.toBe("insufficient_credits");
    await runs.heartbeatRunner(runnerGroup);
    const started = await fireOfficialSchedule(actor, automation);
    const claim = await runs.claimRunnerJob(started.runId);
    const headers = { authorization: `Bearer ${claim.sandboxToken}` };
    if (!claim.encryptedSecrets) {
      throw new Error("Expected captured model credentials");
    }
    await createFirewallApi(context).requestFirewallAuth(
      headers,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENROUTER_API_KEY")}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
        firewallBillable: true,
      },
      [200],
    );
    mockEnv("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN", "official-search-provider");
    server.use(
      http.post("https://api.perplexity.ai/search", () => {
        return HttpResponse.json({
          results: [
            {
              title: "Official search",
              url: "https://example.com/official",
              snippet: "Verified task context",
            },
          ],
        });
      }),
    );
    const searched = await accept(
      setupApp({ context, routes: webSearchRoutes })(webSearchContract).search({
        headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
        body: { query: "Official briefing context", limit: 1 },
      }),
      [200],
    );
    expect(searched.body).toMatchObject({
      creditsCharged: 0,
      results: [{ title: "Official search" }],
    });
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
    let imageRequestUrl: string | null = null;
    server.use(
      http.post(
        "https://queue.fal.run/fal-ai/gpt-image-1/text-to-image",
        ({ request }) => {
          imageRequestUrl = request.url;
          return HttpResponse.json({
            request_id: "official-image",
            status_url:
              "https://queue.fal.run/test/requests/official-image/status",
            response_url:
              "https://queue.fal.run/test/requests/official-image/response",
          });
        },
      ),
      http.get("https://fal.media/files/test/official-image.png", () => {
        return new HttpResponse(Buffer.from("Official image bytes"), {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );
    const image = await accept(
      setupApp({ context, routes: imageIoGenerateRoutes })(
        imageIoGenerateContract,
      ).post({
        headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
        body: { prompt: "A chart for the official briefing" },
      }),
      [202],
    );
    await postFalWebhookEnvelope(
      createImageIoTestApp(context),
      imageRequestUrl,
      {
        status: "COMPLETED",
        payload: {
          images: [
            {
              url: "https://fal.media/files/test/official-image.png",
              width: 1024,
              height: 1024,
              content_type: "image/png",
            },
          ],
          prompt: "A chart for the official briefing",
        },
      },
    );
    await flushWaitUntilForTest();
    const generated = await accept(
      setupApp({ context, routes: builtInGenerationRoutes })(
        builtInGenerationContract,
      ).get({
        headers: authHeaders(actor),
        params: { generationId: image.body.generationId },
      }),
      [200],
    );
    expect(generated.body).toMatchObject({
      status: "completed",
      result: { creditsCharged: 0 },
    });
    const usage = {
      runId: started.runId,
      events: [
        {
          idempotencyKey: randomUUID(),
          kind: "model" as const,
          provider: "@preset/okou-1-0",
          category: "tokens.input",
          quantity: 500_000,
        },
        {
          idempotencyKey: randomUUID(),
          kind: "image" as const,
          provider: "fal-ai/nano-banana-2",
          category: "output_image",
          quantity: 2,
        },
      ],
    };
    await webhooks.requestAgentUsageEvent(usage, headers, [200]);
    await webhooks.requestAgentUsageEvent(usage, headers, [200]);
    await webhooks.requestAgentComplete(
      { runId: started.runId, exitCode: 1, error: "Official task finished" },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    expect((await runs.readBillingStatus(actor)).credits).toBe(0);
    await expect(
      allThreadEventRows(actor, started.chatThreadId),
    ).resolves.toContainEqual(
      expect.objectContaining({
        eventType: "usage.recorded",
        runId: started.runId,
        payload: expect.objectContaining({
          usage: expect.objectContaining({ totalCredits: 0 }),
        }),
      }),
    );
  });
});

describe("Official Workflow installations", () => {
  it("keeps Official threads hidden and pinned to Auto", async () => {
    const { actor, createdAt } = await prepareBriefMember({
      catalogAvailable: false,
      bootstrap: false,
    });
    await syncMorningBriefCatalog(true);
    await deliverClerkOrganizationCreated(actor, createdAt);
    await initializeBriefMember(actor, "Asia/Shanghai");
    await selectPersonalDefaultModel(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected Official installation");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected Official automation");
    }
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const started = await fireOfficialSchedule(actor, automation);
    expect((await runs.readRun(actor, started.runId)).source).toMatchObject({
      model: "auto",
      providerType: "built-in",
    });
    await runs.requestCancelRun(actor, started.runId, [404]);
    const threadId = started.chatThreadId;
    const metadata = () => {
      return setupApp({ context, routes: chatThreadGetRoutes })(
        chatThreadMetadataContract,
      ).get({ headers: authHeaders(actor), params: { id: threadId } });
    };
    expect((await accept(metadata(), [200])).body).toMatchObject({
      selectedModel: "auto",
      hidden: true,
    });
    await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadModelSelectionContract,
      ).update({
        headers: authHeaders(actor),
        params: { id: threadId },
        body: { model: "claude-fable-5-1" },
      }),
      [400],
    );
    const listEvents = () => {
      return setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({ headers: authHeaders(actor), query: {} });
    };
    expect((await accept(listEvents(), [200])).body.events).toContainEqual(
      expect.objectContaining({
        chatThreadId: threadId,
        kind: "created",
        selectedModel: "auto",
        hidden: true,
      }),
    );
  });

  it("names a new Morning Brief thread in the default locale", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Shanghai");
    await selectPersonalDefaultModel(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers: authHeaders(actor),
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected the preference installation");
    }
    const [automation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!automation) {
      throw new Error("Expected the Morning Brief Automation");
    }

    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    const started = await fireOfficialSchedule(actor, automation);
    await expect(
      chat.readThreadMetadata(actor, started.chatThreadId),
    ).resolves.toMatchObject({
      title: "Okou Morning Brief",
      selectedModel: "auto",
      hidden: true,
    });
    await runs.requestCancelRun(actor, started.runId, [404]);
  });

  it("rejects manual runs and ordinary workflow and automation mutations of an Official installation", async () => {
    const { actor } = await prepareBriefMember();
    await initializeBriefMember(actor, "Asia/Tokyo");
    const headers = authHeaders(actor);
    await accept(
      morningBriefPreferenceClient().update({
        headers,
        body: { enabled: true },
      }),
      [200],
    );
    const [installation] = await listMorningBriefInstallations(actor);
    if (!installation) {
      throw new Error("Expected the preference installation");
    }
    const [dailyAutomation] = await readMorningBriefAutomations(
      actor,
      installation.id,
    );
    if (!dailyAutomation) {
      throw new Error("Expected the Morning Brief Automation");
    }
    const firstWorkflowId = installation.id;
    const agentId = installation.agentId;
    const composer = await accept(
      workflowCollectionClient().composer({
        headers,
        query: { agentId },
      }),
      [200],
    );
    expect(
      composer.body.map((workflow) => {
        return workflow.id;
      }),
    ).not.toContain(firstWorkflowId);
    const manualRuns = [
      await accept(
        workflowClient().run({
          headers,
          extraHeaders: { origin: "https://app.okou.ai" },
          params: { workflowId: firstWorkflowId },
        }),
        [409],
      ),
      await accept(
        automationClient().run({
          headers,
          params: { id: dailyAutomation.id },
        }),
        [409],
      ),
    ];
    for (const response of manualRuns) {
      expect(response.body.error.message).toBe(
        "Official Workflows can only run through their automatic triggers",
      );
    }
    await accept(
      workflowClient().update({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { displayName: "Forged edit" },
      }),
      [409],
    );
    await accept(
      workflowVisibilityClient().publish({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowVisibilityClient().demote({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    const forked = await accept(
      workflowClient().copy({
        headers,
        params: { workflowId: firstWorkflowId },
        body: { toAgentId: agentId },
      }),
      [201],
    );
    expect(forked.body).toMatchObject({
      name: installation.name,
      official: null,
      visibility: "private",
    });
    expect(forked.body.id).not.toBe(firstWorkflowId);
    await accept(
      workflowClient().chatThread({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      workflowClient().delete({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [409],
    );
    await accept(
      automationClient().create({
        headers,
        params: { workflowId: firstWorkflowId },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
    await accept(
      automationClient().update({
        headers,
        params: { id: dailyAutomation.id },
        body: {
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [409],
    );
    await accept(
      automationClient().delete({
        headers,
        params: { id: dailyAutomation.id },
      }),
      [409],
    );

    const unchanged = await accept(
      workflowClient().get({
        headers,
        params: { workflowId: firstWorkflowId },
      }),
      [200],
    );
    expect(unchanged.body).toMatchObject({
      id: firstWorkflowId,
      official: { definitionName: "morning-brief" },
      automations: [{ id: dailyAutomation.id }],
      shadowedBy: expect.objectContaining({ id: forked.body.id }),
    });
  });
});

describe("Official Workflow Run admission", () => {
  it("pins ordinary Workflow publications across a normal revision", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(() => {
      return fixture.api.updateUserModelPreference(
        owned.actor,
        "claude-fable-5-1",
      );
    });
    const published: {
      workflowId: string;
      archive: ReturnType<typeof readPublishedArchive>;
    }[] = [];
    for (const name of ["first", "retained"]) {
      const start = context.mocks.s3.send.mock.calls.length;
      const workflowId = await owned.run(() => {
        return workflowBdd.createWorkflow(owned.actor, {
          agentId: owned.agentId,
          name: `published-${name}-${randomUUID().slice(0, 8)}`,
          instruction: `Read the ${name} publication.`,
        });
      });
      published.push({
        workflowId,
        archive: readPublishedArchive(context, start),
      });
    }
    const firstWorkflow = published[0];
    const retainedWorkflow = published[1];
    if (!firstWorkflow || !retainedWorkflow) {
      throw new Error("Expected two published Workflows");
    }
    const first = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use both original Workflow publications",
    });
    const updateStart = context.mocks.s3.send.mock.calls.length;
    await owned.run(() => {
      return accept(
        workflowClient().update({
          headers: authHeaders(owned.actor),
          params: { workflowId: firstWorkflow.workflowId },
          body: {
            instruction: "Read the revised first publication.",
            files: [],
          },
        }),
        [200],
      );
    });
    const updated = readPublishedArchive(context, updateStart);
    expect(updated.versionId).not.toBe(firstWorkflow.archive.versionId);
    const check = async (runId: string, expected: typeof published) => {
      const { claim, sandboxHeaders } = await owned.claimChatRun(
        owned.runnerGroup,
        runId,
      );
      const mounts =
        expectCanonicalStorageManifest(
          claim.storageManifest,
        )?.storageMounts.filter((mount) => {
          return expected.some((workflow) => {
            return (
              mount.name === getCustomSkillStorageName(workflow.workflowId)
            );
          });
        }) ?? [];
      expect(mounts).toHaveLength(2);
      for (const workflow of expected) {
        expect(mounts).toContainEqual(
          expect.objectContaining({
            name: getCustomSkillStorageName(workflow.workflowId),
            versionId: workflow.archive.versionId,
            archiveSize: workflow.archive.archiveSize,
            archiveUrl: expect.any(String),
          }),
        );
      }
      await owned.run(() => {
        return fixture.failChatRun(
          runId,
          sandboxHeaders,
          "Workflow publications inspected",
        );
      });
      await owned.run(flushWaitUntilForTest);
    };
    await check(first.runId, published);
    const later = await owned.sendChatRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Use the updated and retained Workflow publications",
    });
    await check(later.runId, [
      { ...firstWorkflow, archive: updated },
      retainedWorkflow,
    ]);
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

describe("Morning Brief dormant partial bindings", () => {
  // Both Definitions share dormant retention; keep both intended enable states.
  it.each([
    { definitionName: "morning-brief", paused: false },
    { definitionName: "internal-test-morning-brief", paused: true },
  ] as const)(
    "retains new partial values across dormant correction ($definitionName, paused=$paused)",
    async ({ definitionName, paused }) => {
      await withMockNowForTest(new Date("2030-01-01T00:00:00Z"), async () => {
        installCatalogStorageFixture(context);
        const initialBlueprint: OfficialWorkflowBlueprint = {
          key: "daily-delivery",
          parameters: [],
          desiredState: {
            kind: "schedule",
            schedule: { type: "cron", cronExpression: "0 7 * * *" },
          },
        };
        const source = (blueprints: readonly OfficialWorkflowBlueprint[]) => {
          return catalog(
            MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES.map((name) => {
              return activeDefinition(
                name,
                name === definitionName ? blueprints : [initialBlueprint],
              );
            }),
          );
        };
        expect(
          (await syncCatalog(source([initialBlueprint]))).body.outcome,
        ).toBe("accepted");
        const actor = bdd.user();
        const { defaultAgentId } = await runs.grantProEntitlement(actor, {
          stripeTransport: "http",
        });
        await bdd.updateUserTimezone(actor, "Asia/Tokyo");
        await runs.ensurePersonalSubscriptionModel(actor);
        if (!actor.orgId) {
          throw new Error("Expected an organization-scoped owner");
        }
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          {
            [FeatureSwitchKey.AgentSuggestion]:
              definitionName === "internal-test-morning-brief",
          },
        );
        if (definitionName === "internal-test-morning-brief") {
          await accept(
            setupApp({ context, routes: proactiveSuggestionsRoutes })(
              proactiveSuggestionsContract,
            ).update({ headers: authHeaders(actor), body: { enabled: true } }),
            [200],
          );
        }
        await connectBriefSourceForAgent(actor, defaultAgentId);
        await accept(
          morningBriefPreferenceClient().update({
            headers: authHeaders(actor),
            body: { enabled: true },
          }),
          [200],
        );
        const [installation] = await listMorningBriefInstallations(actor);
        if (!installation) {
          throw new Error("Expected the public Morning Brief installation");
        }
        const [initial] = await listMorningBriefAutomations(
          actor,
          installation.id,
        );
        if (!initial) {
          throw new Error("Expected its initial scheduled automation");
        }
        if (paused) {
          await accept(
            morningBriefPreferenceClient().update({
              headers: authHeaders(actor),
              body: { enabled: false },
            }),
            [200],
          );
        }
        expect((await syncCatalog(source([]))).body.outcome).toBe("accepted");
        await executeAutomationCron();
        await flushWaitUntilForTest();
        await expect(
          listMorningBriefAutomations(actor, installation.id),
        ).resolves.toStrictEqual([]);
        await accept(
          automationClient().get({
            headers: authHeaders(actor),
            params: { id: initial.id },
          }),
          [404],
        );
        await expect(
          listMorningBriefInstallations(actor),
        ).resolves.toMatchObject([
          { id: installation.id, official: { definitionName } },
        ]);
        const blueprint = (corrected: boolean): OfficialWorkflowBlueprint => {
          return {
            key: "daily-delivery",
            parameters: [
              {
                key: "delivery-cron",
                type: "string",
                format: "text",
                required: true,
                default: "0 8 * * *",
              },
              {
                key: "delivery-timezone",
                type: "string",
                format: "timezone",
                required: true,
                ...(corrected ? { default: "America/Los_Angeles" } : {}),
              },
              {
                key: "edition",
                type: "integer",
                required: true,
                default: corrected ? 1 : 0,
              },
              {
                key: "include-summary",
                type: "boolean",
                required: true,
                default: corrected,
              },
              {
                key: "note",
                type: "string",
                format: "text",
                required: true,
                default: corrected ? "new default" : "",
              },
            ],
            desiredState: {
              kind: "schedule",
              schedule: {
                type: "cron",
                cronExpression: { parameter: "delivery-cron" },
                timezone: { parameter: "delivery-timezone" },
              },
            },
          };
        };
        expect(
          (await syncCatalog(source([blueprint(false)]))).body.outcome,
        ).toBe("accepted");
        await executeAutomationCron();
        await flushWaitUntilForTest();
        await expect(
          listMorningBriefAutomations(actor, installation.id),
        ).resolves.toStrictEqual([]);
        await expect(
          listMorningBriefInstallations(actor),
        ).resolves.toMatchObject([
          { id: installation.id, official: { definitionName } },
        ]);
        await accept(
          automationClient().get({
            headers: authHeaders(actor),
            params: { id: initial.id },
          }),
          [404],
        );
        const outsider = bdd.user();
        await accept(
          automationClient().get({
            headers: authHeaders(outsider),
            params: { id: initial.id },
          }),
          [404],
        );
        expect(
          (await syncCatalog(source([blueprint(true)]))).body.outcome,
        ).toBe("accepted");
        await executeAutomationCron();
        await flushWaitUntilForTest();
        const [restored] = await listMorningBriefAutomations(
          actor,
          installation.id,
        );
        expect(restored).toMatchObject({
          id: initial.id,
          enabled: !paused,
          schedule: {
            type: "cron",
            cronExpression: "0 8 * * *",
            timezone: "America/Los_Angeles",
          },
          official: {
            blueprintKey: "daily-delivery",
            intendedEnabled: !paused,
            reconciliationStatus: "current",
            parameterBindings: [
              { key: "delivery-cron", value: "0 8 * * *" },
              { key: "delivery-timezone", value: "America/Los_Angeles" },
              { key: "edition", value: 0 },
              { key: "include-summary", value: false },
              { key: "note", value: "" },
            ],
          },
        });
        await accept(
          automationClient().get({
            headers: authHeaders(outsider),
            params: { id: initial.id },
          }),
          [404],
        );
        await executeAutomationCron();
        await flushWaitUntilForTest();
        await expect(
          listMorningBriefAutomations(actor, installation.id),
        ).resolves.toStrictEqual([restored]);
      });
    },
  );
});
