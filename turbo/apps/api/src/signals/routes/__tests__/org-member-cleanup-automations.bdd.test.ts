import { randomUUID } from "node:crypto";

import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";

/*
A departing member keeps no armed workflow automation. Both departure paths -
in-app member removal and the Clerk membership webhook - run the same member
cleanup, so each case asserts the same outcomes through public surfaces: the
event automation stops dispatching, the schedule is no longer selected as due,
the row survives with its configuration, and automations outside the departing
(organization, owner) pair are untouched.

`executed` alone cannot tell an eagerly disarmed schedule from one the poller
retires lazily at its next due time: both leave nothing executed. `skipped`
separates them. A row that is still enabled is selected as due and then denied
by the poller's membership gate, which counts it as skipped and clears its
`next_run_at`; a row disarmed at departure is never selected at all, so the
tick reports `skipped: 0` and the automation keeps the `next_run_at` it was
created with.
*/

const context = testContext();
const mocks = createRouteMocks(context);
const org = createAuthOrgAgentsBddApi(context);
const wf = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

const WEBHOOK_APP_ROUTES = Object.freeze([
  ...webhooksWorkflowAutomationsRoutes,
]);

const LOOP_INTERVAL_SECONDS = 3600;

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function executionClient() {
  return setupApp({ context, routes: testWorkflowAutomationExecutionRoutes })(
    testWorkflowAutomationExecutionContract,
  );
}

function orgIdOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  return actor.orgId;
}

/**
 * The creating admin of an entitled workspace with an organization default
 * model, which is what a workspace owner reaches through billing and
 * onboarding. Passing an existing identity gives that same person a second
 * workspace.
 */
async function setupWorkspaceOwner(actor: ApiTestUser): Promise<ApiTestUser> {
  await runs.grantProEntitlement(actor, { tier: "team" });
  await runs.ensureOrgModelProvider(actor);
  context.mocks.s3.send.mockResolvedValue({});
  return actor;
}

interface OwnedAutomations {
  readonly owner: ApiTestUser;
  readonly scheduleAutomationId: string;
  readonly scheduleNextRunAt: string | null;
  readonly webhookAutomationId: string;
  readonly webhookToken: string;
  readonly webhookSecret: string;
}

/**
 * One owner, one schedule and one event automation. Each automation gets its
 * own workflow so neither queues behind the other's automation chat thread.
 */
async function seedOwnedAutomations(
  owner: ApiTestUser,
  label: string,
): Promise<OwnedAutomations> {
  const agent = await wf.createAgent(owner, {
    displayName: `${label} automation agent`,
  });
  const scheduleWorkflowId = await wf.createWorkflow(owner, {
    agentId: agent.agentId,
    name: `${label}-schedule-${shortId()}`,
  });
  const eventWorkflowId = await wf.createWorkflow(owner, {
    agentId: agent.agentId,
    name: `${label}-event-${shortId()}`,
  });
  mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);

  // A loop automation is due from the moment it is created.
  const schedule = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId: scheduleWorkflowId },
      body: {
        schedule: { type: "loop", intervalSeconds: LOOP_INTERVAL_SECONDS },
      },
    }),
    [201],
  );
  expect(schedule.body.enabled).toBeTruthy();
  expect(schedule.body.nextRunAt).not.toBeNull();

  const webhook = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId: eventWorkflowId },
      body: { kind: "event", eventType: "webhook-received" },
    }),
    [201],
  );
  if (
    webhook.body.kind !== "event" ||
    webhook.body.eventType !== "webhook-received" ||
    !webhook.body.webhookUrl ||
    !webhook.body.webhookSecret
  ) {
    throw new Error("Expected a webhook automation with a one-time secret");
  }
  expect(webhook.body.enabled).toBeTruthy();
  const token = new URL(webhook.body.webhookUrl).pathname.split("/").at(-1);
  if (!token) {
    throw new Error("Expected a webhook URL token");
  }

  return {
    owner,
    scheduleAutomationId: schedule.body.id,
    scheduleNextRunAt: schedule.body.nextRunAt,
    webhookAutomationId: webhook.body.id,
    webhookToken: token,
    webhookSecret: webhook.body.webhookSecret,
  };
}

async function postWebhookDelivery(seeded: OwnedAutomations): Promise<number> {
  const rawBody = JSON.stringify({ event: `delivery-${shortId()}` });
  const timestamp = Math.floor(now() / 1000);
  const response = await createApp({
    signal: context.signal,
    routes: WEBHOOK_APP_ROUTES,
  }).request(`/api/webhooks/workflow-automations/${seeded.webhookToken}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Okou-Timestamp": String(timestamp),
      "X-Okou-Signature": computeHmacSignature(
        rawBody,
        seeded.webhookSecret,
        timestamp,
      ),
    },
    body: rawBody,
  });
  return response.status;
}

async function runScheduleTick(automationId: string) {
  const response = await accept(
    executionClient().execute({ body: { automation_id: automationId } }),
    [200],
  );
  return response.body;
}

/** Automation reads are organization-scoped, so any admin can audit the row. */
async function readAsAdmin(admin: ApiTestUser, automationId: string) {
  mocks.clerk.session(admin.userId, admin.orgId, admin.orgRole);
  return await wf.readAutomation(automationId);
}

describe("Org member cleanup disarms the departing member's automations", () => {
  it("stops event dispatch and schedule selection for the departing owner alone", async () => {
    runs.configureRunnerGroup();
    const departing = await setupWorkspaceOwner(wf.user());
    const peerAdmin = wf.user({
      orgId: orgIdOf(departing),
      orgRole: "org:admin",
      email: `peer-${shortId()}@example.test`,
    });
    const departingAutomations = await seedOwnedAutomations(
      departing,
      "departing",
    );
    const peerAutomations = await seedOwnedAutomations(peerAdmin, "peer");

    // The same person's second workspace is a different (organization, owner)
    // pair, and its automations must survive a departure from the first one.
    const elsewhere = await setupWorkspaceOwner(
      wf.user({ userId: departing.userId, email: departing.email }),
    );
    const elsewhereAutomations = await seedOwnedAutomations(
      elsewhere,
      "elsewhere",
    );

    // Armed before the departure: the delivery dispatches and starts a run.
    await expect(postWebhookDelivery(departingAutomations)).resolves.toBe(200);

    org.mockClerkOrg(peerAdmin, {
      members: [
        { actor: peerAdmin, role: "org:admin" },
        { actor: departing, role: "org:admin" },
      ],
    });
    await expect(
      org.removeMember(peerAdmin, { email: departing.email }),
    ).resolves.toStrictEqual({
      message: `Removed ${departing.email} from org`,
    });

    // The event automation no longer dispatches, while the same person's
    // webhook in their other workspace still does.
    await expect(postWebhookDelivery(departingAutomations)).resolves.toBe(404);
    await expect(postWebhookDelivery(elsewhereAutomations)).resolves.toBe(200);

    // The schedule is never selected as due again - not selected and then
    // skipped by the poller's membership gate.
    await expect(
      runScheduleTick(departingAutomations.scheduleAutomationId),
    ).resolves.toStrictEqual({ success: true, executed: 0, skipped: 0 });
    await expect(
      runScheduleTick(elsewhereAutomations.scheduleAutomationId),
    ).resolves.toStrictEqual({ success: true, executed: 1, skipped: 0 });

    // Disabled, not deleted: the schedule keeps its configuration and its
    // creation-time anchor, so an administrator can re-enable or reassign it.
    await expect(
      readAsAdmin(peerAdmin, departingAutomations.scheduleAutomationId),
    ).resolves.toMatchObject({
      kind: "schedule",
      enabled: false,
      nextRunAt: departingAutomations.scheduleNextRunAt,
      schedule: { type: "loop", intervalSeconds: LOOP_INTERVAL_SECONDS },
    });
    await expect(
      readAsAdmin(peerAdmin, departingAutomations.webhookAutomationId),
    ).resolves.toMatchObject({
      kind: "event",
      eventType: "webhook-received",
      enabled: false,
    });

    // Another member of the same organization keeps both of theirs armed.
    await expect(
      readAsAdmin(peerAdmin, peerAutomations.scheduleAutomationId),
    ).resolves.toMatchObject({ enabled: true });
    await expect(
      readAsAdmin(peerAdmin, peerAutomations.webhookAutomationId),
    ).resolves.toMatchObject({ enabled: true });

    // As does the same person in their other workspace.
    org.mockClerkOrg(elsewhere, {
      members: [{ actor: elsewhere, role: "org:admin" }],
    });
    await expect(
      readAsAdmin(elsewhere, elsewhereAutomations.webhookAutomationId),
    ).resolves.toMatchObject({ enabled: true });
  }, 60_000);

  it("disarms the same automations when Clerk reports the membership deleted", async () => {
    runs.configureRunnerGroup();
    const departing = await setupWorkspaceOwner(wf.user());
    const auditor = wf.user({
      orgId: orgIdOf(departing),
      orgRole: "org:admin",
      email: `auditor-${shortId()}@example.test`,
    });
    const departingAutomations = await seedOwnedAutomations(
      departing,
      "clerk-departing",
    );
    await expect(postWebhookDelivery(departingAutomations)).resolves.toBe(200);

    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        id: `orgmem_${shortId()}`,
        organization_id: orgIdOf(departing),
        user_id: departing.userId,
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    // The webhook acknowledges before the cleanup it owns finishes.
    await flushWaitUntilForTest();
    await expect
      .poll(
        async () => {
          const automation = await readAsAdmin(
            auditor,
            departingAutomations.scheduleAutomationId,
          );
          return automation.enabled;
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBe(false);

    await expect(postWebhookDelivery(departingAutomations)).resolves.toBe(404);
    await expect(
      runScheduleTick(departingAutomations.scheduleAutomationId),
    ).resolves.toStrictEqual({ success: true, executed: 0, skipped: 0 });
    await expect(
      readAsAdmin(auditor, departingAutomations.webhookAutomationId),
    ).resolves.toMatchObject({
      kind: "event",
      eventType: "webhook-received",
      enabled: false,
    });
  }, 30_000);
});
