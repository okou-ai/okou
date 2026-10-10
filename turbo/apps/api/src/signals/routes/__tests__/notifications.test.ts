import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { notificationsContract } from "@okouai/api-contracts/contracts/notifications";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { notificationsRoutes } from "../notifications";
import { featureSwitchesRoutes } from "../feature-switches";
import { emailSubscriptionRoutes } from "../email-subscription";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { mockClerkUsers } from "./helpers/clerk-users";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createPublicAutomationResultEmailApi } from "./helpers/public-automation-result-email";

const context = testContext();
const mocks = createRouteMocks(context);
const humanHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const client = () => {
  return setupApp({ context, routes: notificationsRoutes })(
    notificationsContract,
  );
};
const features = () => {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
};
const preferences = () => {
  return setupApp({ context, routes: emailSubscriptionRoutes })(
    emailSubscriptionContract,
  );
};

async function feature(actor: ApiTestUser, enabled: boolean) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  await accept(
    features().update({
      headers: humanHeaders,
      body: { switches: { notifyMail: enabled } },
    }),
    [200],
  );
}

async function runningAgent(enabled = true) {
  mockEnv("RESEND_API_KEY", "test-key");
  mockEnv("RESEND_FROM_DOMAIN", "okou.io");
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "Mail notification agent",
    visibility: "private",
  });
  if (!enabled) {
    await feature(actor, false);
  }
  await runs.heartbeatRunner(runnerGroup);
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    model: "claude-fable-5-1",
    prompt: "Notify me about a useful update",
  });
  expect(run).toMatchObject({ status: "pending" });
  const claim = await runs.claimRunnerJob(run.runId);
  mockClerkUsers(context, [
    {
      id: actor.userId,
      primaryEmailAddressId: "primary",
      emailAddresses: [{ id: "primary", emailAddress: actor.email }],
      firstName: "Test",
      lastName: "User",
      imageUrl: null,
    },
  ]);
  return {
    actor,
    runs,
    runId: run.runId,
    headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
  };
}

const body = () => {
  return {
    to: "me" as const,
    subject: "Useful update",
    text: "## Today\nA useful update.",
    idempotencyKey: `update:${randomUUID()}`,
  };
};

describe("agent mail notifications", () => {
  it("rejects Morning Brief purpose from an ordinary run without consuming the key or silently downgrading", async () => {
    const fixture = await runningAgent();
    const input = { ...body(), subject: "Morning Brief" };
    const rejected = await accept(
      client().mail({
        headers: fixture.headers,
        body: { ...input, kind: "morning-brief" },
      }),
      [403],
    );
    expect(rejected.body.error).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("official Morning Brief automation"),
    });
    const ordinary = await accept(
      client().mail({ headers: fixture.headers, body: input }),
      [200],
    );
    expect(ordinary.body).toMatchObject({
      status: "queued",
      deduplicated: false,
    });
    expect(
      (
        await accept(
          client().mail({
            headers: fixture.headers,
            body: { ...input, kind: "notification" },
          }),
          [200],
        )
      ).body,
    ).toMatchObject({
      notificationId: ordinary.body.notificationId,
      deduplicated: true,
    });
    await accept(
      client().mail({
        headers: fixture.headers,
        body: { ...input, kind: "morning-brief" },
      }),
      [409],
    );
  });

  it("does not authorize a custom automation merely named morning-brief", async () => {
    const workflows = createWorkflowsBddApi(context);
    const runs = createRunsApi(context);
    const publicResults = createPublicAutomationResultEmailApi(context);
    const runnerGroup = runs.configureRunnerGroup();
    const { actor } = await workflows.setupWorkflowOrg({
      model: "claude-fable-5-1",
    });
    const { agentId } = await workflows.createAgent(actor);
    const workflowId = await workflows.createWorkflow(actor, {
      agentId,
      name: "morning-brief",
    });
    await feature(actor, true);
    const automation = await accept(
      setupApp({ context, routes: workflowAutomationsRoutes })(
        workflowAutomationsContract,
      ).create({
        headers: humanHeaders,
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    publicResults.configureDelivery(actor);
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.heartbeatRunner(runnerGroup);
    const { runId } = await publicResults.start(
      actor,
      automation.body.id,
      runnerGroup,
    );
    const claim = await runs.claimRunnerJob(runId);
    publicResults.track(actor, runId, runnerGroup).sandboxToken =
      claim.sandboxToken;
    const headers = { authorization: `Bearer ${okouTokenFromClaim(claim)}` };
    const input = body();
    await accept(
      client().mail({ headers, body: { ...input, kind: "morning-brief" } }),
      [403],
    );
    expect(
      (await accept(client().mail({ headers, body: input }), [200])).body,
    ).toMatchObject({ status: "queued", deduplicated: false });
  });

  it("rejects caller-supplied presentation and source URLs", async () => {
    const fixture = await runningAgent();
    const input = {
      ...body(),
      manageUrl: "https://example.com/manage",
      runUrl: "https://example.com/run",
      heroUrl: "https://example.com/image.png",
    };
    const rejected = await accept(
      client().mail({ headers: fixture.headers, body: input }),
      [400],
    );
    expect(rejected.body.error.code).toBe("BAD_REQUEST");
  });

  it("does not turn a recipient-provider failure into a no-email skip", async () => {
    const fixture = await runningAgent();
    const input = body();
    context.mocks.clerk.users.getUser.mockRejectedValueOnce(
      new Error("Clerk unavailable"),
    );
    const failed = await accept(
      client().mail({ headers: fixture.headers, body: input }),
      [500],
    );
    expect(failed.body).not.toHaveProperty("notificationId");
    expect(
      (
        await accept(
          client().mail({ headers: fixture.headers, body: input }),
          [200],
        )
      ).body,
    ).toMatchObject({ status: "queued", deduplicated: false });
  });
  it("does not consume a key when delivery is unconfigured, and validates content before admission", async () => {
    const fixture = await runningAgent();
    const input = body();
    await accept(
      client().mail({
        headers: fixture.headers,
        body: { ...input, subject: "Invalid\nsubject" },
      }),
      [400],
    );
    await accept(
      client().mail({
        headers: fixture.headers,
        body: { ...input, text: " " },
      }),
      [400],
    );
    mockOptionalEnv("RESEND_API_KEY", undefined);
    await accept(
      client().mail({ headers: fixture.headers, body: input }),
      [503],
    );
    mockOptionalEnv("RESEND_API_KEY", "test-key");
    expect(
      (
        await accept(
          client().mail({ headers: fixture.headers, body: input }),
          [200],
        )
      ).body,
    ).toMatchObject({ status: "queued", deduplicated: false });
  });
  it("deduplicates concurrent requests, rejects changed content, and preserves receipts after run termination", async () => {
    const fixture = await runningAgent();
    const input = body();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => {
        return accept(
          client().mail({ headers: fixture.headers, body: input }),
          [200],
        );
      }),
    );
    const first = results[0]!.body;
    expect(first).toMatchObject({
      status: "queued",
      channel: "mail",
      recipient: "me",
      reason: null,
    });
    expect(
      new Set(
        results.map((result) => {
          return result.body.notificationId;
        }),
      ).size,
    ).toBe(1);
    expect(
      results.filter((result) => {
        return !result.body.deduplicated;
      }),
    ).toHaveLength(1);
    await accept(
      client().mail({
        headers: fixture.headers,
        body: { ...input, text: "Different" },
      }),
      [409],
    );
    await fixture.runs.requestCancelRun(fixture.actor, fixture.runId, [200]);
    expect(
      (
        await accept(
          client().get({
            headers: fixture.headers,
            params: { id: first.notificationId },
          }),
          [200],
        )
      ).body.status,
    ).toBe("queued");
    expect(
      (
        await accept(
          client().mail({ headers: fixture.headers, body: input }),
          [200],
        )
      ).body.deduplicated,
    ).toBeTruthy();
    await accept(
      client().mail({ headers: fixture.headers, body: body() }),
      [403],
    );
  });

  it("requires capability issuance and a currently enabled feature; human sessions cannot send", async () => {
    const fixture = await runningAgent(false);
    await accept(
      client().mail({ headers: fixture.headers, body: body() }),
      [403],
    );
    await feature(fixture.actor, true);
    await accept(
      client().mail({ headers: fixture.headers, body: body() }),
      [403],
    );
    const human = await accept(
      client().mail({ headers: humanHeaders, body: body() }),
      [403],
    );
    expect(human.body.error.code).toBe("FORBIDDEN");
    const enabled = await runningAgent();
    await feature(enabled.actor, false);
    await accept(
      client().mail({ headers: enabled.headers, body: body() }),
      [403],
    );
    await accept(
      client().get({ headers: enabled.headers, params: { id: randomUUID() } }),
      [403],
    );
  });

  it("records an unsubscribe skip and keeps it on replay after resubscription", async () => {
    const fixture = await runningAgent();
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
    await accept(
      preferences().update({
        headers: humanHeaders,
        body: { subscribed: false },
      }),
      [200],
    );
    const input = body();
    const result = await accept(
      client().mail({ headers: fixture.headers, body: input }),
      [200],
    );
    expect(result.body).toMatchObject({
      status: "skipped",
      reason: "unsubscribed",
      deduplicated: false,
    });
    await accept(
      preferences().update({
        headers: humanHeaders,
        body: { subscribed: true },
      }),
      [200],
    );
    expect(
      (
        await accept(
          client().mail({ headers: fixture.headers, body: input }),
          [200],
        )
      ).body,
    ).toMatchObject({
      notificationId: result.body.notificationId,
      status: "skipped",
      deduplicated: true,
    });
    expect(
      (
        await accept(
          client().mail({ headers: fixture.headers, body: body() }),
          [200],
        )
      ).body.status,
    ).toBe("queued");
  });

  it("skips an address suppressed by a signed provider webhook", async () => {
    const fixture = await runningAgent();
    mockEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
    const webhooks = createWebhookCallbackApi(context);
    const event = {
      type: "email.bounced",
      data: { email_id: "previous-provider-email", to: [fixture.actor.email] },
    };
    await webhooks.requestResendInboundWebhook(
      event,
      webhooks.signedResendWebhookHeaders(event),
      [200],
    );
    expect(
      (
        await accept(
          client().mail({ headers: fixture.headers, body: body() }),
          [200],
        )
      ).body,
    ).toMatchObject({ status: "skipped", reason: "suppressed" });
  });

  it("skips a user without an account email", async () => {
    const fixture = await runningAgent();
    mockClerkUsers(context, [
      {
        id: fixture.actor.userId,
        primaryEmailAddressId: null,
        emailAddresses: [],
      },
    ]);
    expect(
      (
        await accept(
          client().mail({ headers: fixture.headers, body: body() }),
          [200],
        )
      ).body,
    ).toMatchObject({ status: "skipped", reason: "no-email" });
  });

  it("scopes lookup to the owner and workspace and rejects missing membership", async () => {
    const fixture = await runningAgent();
    const result = await accept(
      client().mail({ headers: fixture.headers, body: body() }),
      [200],
    );
    expect(result.body.status).toBe("queued");
    const other = createBddApi(context).user();
    await feature(other, true);
    await accept(
      client().get({
        headers: humanHeaders,
        params: { id: result.body.notificationId },
      }),
      [404],
    );
    const otherWorkspace = { ...fixture.actor, orgId: `org_${randomUUID()}` };
    await feature(otherWorkspace, true);
    await accept(
      client().get({
        headers: humanHeaders,
        params: { id: result.body.notificationId },
      }),
      [404],
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.deleted",
      data: {
        id: `orgmem_${randomUUID()}`,
        organization_id: fixture.actor.orgId,
        user_id: fixture.actor.userId,
      },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    await accept(
      client().mail({ headers: fixture.headers, body: body() }),
      [400],
    );
    mocks.clerk.session(fixture.actor.userId, fixture.actor.orgId);
    await accept(
      client().get({
        headers: humanHeaders,
        params: { id: result.body.notificationId },
      }),
      [404],
    );
  });
});
