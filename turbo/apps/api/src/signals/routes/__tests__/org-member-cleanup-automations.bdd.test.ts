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
Departing members keep no armed workflow automation. Both departure paths —
in-app member removal and the Clerk membership webhook — run the same member
cleanup, so each case here asserts the same three outcomes through public
surfaces: the event automation stops dispatching, the schedule is no longer
selected as due, and every automation outside the departing (org, owner) pair
keeps firing.

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

/** Automation reads are org-scoped, so an admin can audit a departed owner's row. */
async function readAsAdmin(admin: ApiTestUser, automationId: string) {
  mocks.clerk.session(admin.userId, admin.orgId, admin.orgRole);
  return await wf.readAutomation(automationId);
}

async function setupOrgWithDepartingMember(label: string): Promise<{
  readonly admin: ApiTestUser;
  readonly member: ApiTestUser;
}> {
  const { actor: admin } = await wf.setupWorkflowOrg({ tier: "team" });
  if (!admin.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const member = wf.user({
    orgId: admin.orgId,
    orgRole: "org:member",
    email: `${label}-member-${shortId()}@example.test`,
  });
  context.mocks.s3.send.mockResolvedValue({});
  return { admin, member };
}

describe("Org member cleanup disarms the departing member's automations", () => {
  it("stops event dispatch and schedule selection for the removed member alone", async () => {
    runs.configureRunnerGroup();
    const { admin, member } = await setupOrgWithDepartingMember("removal");
    const departing = await seedOwnedAutomations(member, "departing");
    const retained = await seedOwnedAutomations(admin, "retained");

    // The same owner in a second organization is a different pair entirely.
    const { actor: otherOrgAdmin } = await wf.setupWorkflowOrg({
      tier: "team",
    });
    if (!otherOrgAdmin.orgId) {
      throw new Error("Expected an org-scoped workflow actor");
    }
    const memberElsewhere = wf.user({
      userId: member.userId,
      orgId: otherOrgAdmin.orgId,
      orgRole: "org:admin",
      email: member.email,
    });
    const elsewhere = await seedOwnedAutomations(memberElsewhere, "elsewhere");

    org.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    await expect(
      org.removeMember(admin, { email: member.email }),
    ).resolves.toStrictEqual({
      message: `Removed ${member.email} from org`,
    });

    // The event automation no longer dispatches: its delivery is refused
    // outright, while an identical webhook owned by a current member of the
    // same organization still dispatches at the same moment. The disarmed
    // state behind that refusal is read back below; the dispatchers that
    // consult `workflowAutomationCanFire` would also fail closed on the
    // membership row this cleanup deletes.
    expect(await postWebhookDelivery(departing)).toBe(404);
    expect(await postWebhookDelivery(retained)).toBe(200);

    // The schedule is never selected as due again — not selected and then
    // skipped by the poller's membership gate.
    expect(await runScheduleTick(departing.scheduleAutomationId)).toStrictEqual(
      { success: true, executed: 0, skipped: 0 },
    );
    expect(await runScheduleTick(retained.scheduleAutomationId)).toStrictEqual({
      success: true,
      executed: 1,
      skipped: 0,
    });

    // Disabled, not deleted: the schedule keeps its configuration and its
    // creation-time anchor so an administrator can re-enable or reassign it.
    expect(
      await readAsAdmin(admin, departing.scheduleAutomationId),
    ).toMatchObject({
      kind: "schedule",
      enabled: false,
      nextRunAt: departing.scheduleNextRunAt,
      schedule: { type: "loop", intervalSeconds: LOOP_INTERVAL_SECONDS },
    });
    expect(
      await readAsAdmin(admin, departing.webhookAutomationId),
    ).toMatchObject({
      kind: "event",
      eventType: "webhook-received",
      enabled: false,
    });
    expect(
      await readAsAdmin(admin, retained.scheduleAutomationId),
    ).toMatchObject({ enabled: true });
    expect(
      await readAsAdmin(admin, retained.webhookAutomationId),
    ).toMatchObject({ enabled: true });

    // The same person's automations in another organization stay armed.
    org.mockClerkOrg(otherOrgAdmin, {
      members: [{ actor: otherOrgAdmin, role: "org:admin" }],
    });
    expect(
      await readAsAdmin(otherOrgAdmin, elsewhere.scheduleAutomationId),
    ).toMatchObject({ enabled: true });
    expect(await postWebhookDelivery(elsewhere)).toBe(200);
    expect(await runScheduleTick(elsewhere.scheduleAutomationId)).toStrictEqual(
      { success: true, executed: 1, skipped: 0 },
    );
  }, 60_000);

  it("disarms the same automations when Clerk reports the membership deleted", async () => {
    runs.configureRunnerGroup();
    const { admin, member } = await setupOrgWithDepartingMember("webhook");
    const departing = await seedOwnedAutomations(member, "clerk-departing");

    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        id: `orgmem_${shortId()}`,
        organization_id: admin.orgId,
        user_id: member.userId,
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    // The webhook acknowledges before the cleanup it owns finishes.
    await flushWaitUntilForTest();
    await expect
      .poll(
        async () => {
          const automation = await readAsAdmin(
            admin,
            departing.scheduleAutomationId,
          );
          return automation.enabled;
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBe(false);

    expect(await postWebhookDelivery(departing)).toBe(404);
    expect(await runScheduleTick(departing.scheduleAutomationId)).toStrictEqual(
      { success: true, executed: 0, skipped: 0 },
    );
    expect(
      await readAsAdmin(admin, departing.webhookAutomationId),
    ).toMatchObject({
      kind: "event",
      eventType: "webhook-received",
      enabled: false,
    });
  }, 30_000);
});
