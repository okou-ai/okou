import { randomUUID } from "node:crypto";
import {
  marketingRewardSettlementContract,
  type MarketingRewardIntent,
} from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { workflowsDetailContract } from "@okouai/api-contracts/contracts/workflows";
import { expect, test, vi } from "vitest";
import { Webhook } from "svix";
import { object, uuid } from "zod";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { workflowsRoutes } from "../workflows";
import { marketingRewardSettlementRoutes } from "../marketing-reward-settlement";
import { createBddApi } from "./helpers/api-bdd";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createPublicAutomationRunApi } from "./helpers/public-automation-run";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";
import {
  campaignRequest,
  marketingRewardConsumer,
} from "./helpers/marketing-reward-consumer";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockGmailConnectorOAuth,
  mockGoogleDriveConnectorOAuth,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";

import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import {
  createAgentPhoneBddApi,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import { orgInviteRoutes } from "../org-invite";
import { webhooksClerkRoutes } from "../webhooks-clerk";

const context = testContext();
const mocks = createRouteMocks(context);
const workflows = createWorkflowsBddApi(context);
const runs = createRunsApi(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const secret = "marketing-financial-service-1234567890123456789012345";
const headers = Object.freeze({ authorization: `Bearer ${secret}` });

function client() {
  mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", secret);
  return setupApp({ context, routes: marketingRewardSettlementRoutes })(
    marketingRewardSettlementContract,
  );
}

function missingIntent() {
  const userId = `user_${randomUUID()}`;
  return campaignRequest({
    version: 1,
    environment: "development",
    policy: "get-started-v1",
    sourceEventId: randomUUID(),
    questKey: "connector",
    sourceKey: "builtin:github",
    rewardKey: `connector:${userId}:builtin:github`,
    orgId: `org_${randomUUID()}`,
    actorUserId: userId,
    beneficiaryUserId: userId,
    rewardTarget: "user",
    rewardAmount: 100,
    completedAt: "2026-11-17T04:00:00.000Z",
  });
}

async function completedWorkflow(
  consumer: ReturnType<typeof marketingRewardConsumer>,
) {
  const { actor } = await workflows.setupWorkflowOrg({ tier: "team" });
  const { agentId } = await workflows.createAgent(actor, {
    visibility: "public",
  });
  installWorkflowVolumeS3Fixture(context);
  const workflowId = await workflows.createWorkflow(actor, {
    agentId,
    name: `settlement-${randomUUID().slice(0, 8)}`,
  });
  const executor = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
  await bdd.completeOnboarding(executor);
  await runs.ensurePersonalSubscriptionModel(executor, {
    model: "claude-fable-5-1",
  });
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const group = await runs.configureRunnerGroup();
  mocks.clerk.session(executor.userId, executor.orgId, executor.orgRole);
  const launched = await accept(
    setupApp({ context, routes: workflowsRoutes })(workflowsDetailContract).run(
      {
        params: { workflowId },
        headers: { authorization: "Bearer clerk-session" },
      },
    ),
    [200],
  );
  await flushWaitUntilForTest();
  const events = (
    await chat.listThreadEvents(executor, launched.body.chatThreadId)
  ).events;
  const input = events.find((event) => {
    return event.eventType === "input.prompt" && event.runId;
  });
  if (!input?.runId) {
    throw new Error("Expected a public Workflow Run");
  }
  await createPublicAutomationRunApi(context).complete(
    executor,
    input.runId,
    group,
    {},
  );
  await flushWaitUntilForTest();
  const fact = consumer.received.find((event) => {
    return event.type === "workflow.run-completed";
  });
  if (!fact || fact.type !== "workflow.run-completed") {
    throw new Error("Expected a completed Workflow source fact");
  }
  const intent = campaignRequest({
    version: 1,
    environment: fact.environment,
    policy: "get-started-v1",
    sourceEventId: fact.id,
    questKey: "workflow",
    sourceKey: fact.sourceEventId,
    rewardKey: `workflow:${fact.creatorUserId}`,
    orgId: fact.orgId,
    actorUserId: fact.userId,
    beneficiaryUserId: fact.creatorUserId,
    rewardTarget: "user",
    rewardAmount: 1000,
    completedAt: fact.occurredAt,
  });
  return { actor, executor, workflowId, intent };
}

test("authenticates the dedicated financial capability and binds the immutable environment and terms before settling", async () => {
  const api = client();
  const body = missingIntent();
  for (const credential of [
    "clerk-session",
    "test-cron-secret",
    "read-only-receipt-secret",
    "source-intake-secret",
  ]) {
    const result = await api.settle({
      body,
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(result.status).toBe(401);
    expect(result.headers.get("cache-control")).toBe("no-store");
  }
  expect((await api.settle({ body, headers })).status).toBe(404);
  expect(
    (await api.settle({ body: { ...body, orgId: "forged-org" }, headers }))
      .status,
  ).toBe(409);
  expect(
    (
      await api.settle({
        body: campaignRequest({ ...body, environment: "production" }),
        headers,
      })
    ).status,
  ).toBe(409);
  mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", undefined);
  const disabled = await api.settle({ body, headers });
  expect(disabled.status).toBe(503);
  expect(disabled.headers.get("cache-control")).toBe("no-store");
});

test("settles for the original creator concurrently and recovers the receipt after deletion and expiry", async () => {
  await setupApp({
    context,
    routes: marketingRewardSettlementRoutes,
    isolatePg: true,
  });
  mockEnv("CRON_SECRET", "marketing-consumer-cron");
  const consumer = marketingRewardConsumer();
  const { actor, executor, workflowId, intent } =
    await completedWorkflow(consumer);
  const api = client();
  await createMiscRoutesApi(context).deleteWorkflow(actor, workflowId, [204]);
  await Promise.all([
    accept(api.settle({ body: intent, headers }), [200, 202]),
    accept(api.settle({ body: intent, headers }), [200, 202]),
  ]);
  const first = await accept(api.settle({ body: intent, headers }), [200]);
  expect(first.body.receipt).toMatchObject({
    status: "granted",
    orgId: actor.orgId,
    actorUserId: executor.userId,
    beneficiaryUserId: actor.userId,
    rewardAmount: 1000,
    rewardKey: `workflow:${actor.userId}`,
    memberCreditGrantId: expect.any(String),
  });
  expect(
    Date.parse(first.body.receipt.expiresAt ?? "") -
      Date.parse(first.body.receipt.grantedAt ?? ""),
  ).toBe(168 * 3_600_000);
  mockNow(
    new Date(Date.parse(first.body.receipt.expiresAt ?? "") + 86_400_000),
  );
  expect(
    (await accept(api.settle({ body: intent, headers }), [200])).body,
  ).toStrictEqual(first.body);
});

test("rejects caller-chosen recipients, sources and amounts even when the caller recomputes a valid request identity", async () => {
  const consumer = marketingRewardConsumer();
  const { intent } = await completedWorkflow(consumer);
  const api = client();
  const changed: MarketingRewardIntent[] = [
    campaignRequest({ ...intent, beneficiaryUserId: "another-user" }),
    campaignRequest({ ...intent, orgId: "another-org" }),
    campaignRequest({ ...intent, sourceKey: randomUUID() }),
    campaignRequest({ ...intent, completedAt: "2026-11-18T04:00:00.000Z" }),
  ];
  for (const body of changed) {
    expect((await api.settle({ body, headers })).status).toBe(409);
  }
  const inflated = { ...intent, rewardAmount: 99_999 };
  expect((await api.settle({ body: inflated, headers })).status).toBe(400);
});

test("returns a prior OAuth award by the complete request after a lost response without funding the reconnect or extending expiry", async () => {
  const consumer = marketingRewardConsumer();
  const actor = bdd.user();
  const connectors = createConnectorBddApi(context);
  mockGitHubConnectorOAuth();
  const start = await connectors.startOauth(actor, "github", "oauth");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  await connectors.completeOauthCallback("github", {
    code: randomUUID(),
    state,
  });
  await flushWaitUntilForTest();
  const fact = consumer.received.find((event) => {
    return event.type === "connector.oauth-authorized";
  });
  if (!fact || fact.type !== "connector.oauth-authorized") {
    throw new Error("Expected OAuth source fact");
  }
  const intent = campaignRequest({
    version: 1,
    environment: fact.environment,
    policy: "get-started-v1",
    sourceEventId: fact.id,
    questKey: "connector",
    sourceKey: "builtin:github",
    rewardKey: `connector:${actor.userId}:builtin:github`,
    orgId: fact.orgId,
    actorUserId: actor.userId,
    beneficiaryUserId: actor.userId,
    rewardTarget: "user",
    rewardAmount: 100,
    completedAt: fact.occurredAt,
  });
  const api = client();
  const original = await accept(api.settle({ body: intent, headers }), [200]);
  expect(original.body.receipt).toMatchObject({
    status: "granted",
    rewardAmount: 100,
  });
  mockNow(
    new Date(Date.parse(original.body.receipt.expiresAt ?? "") + 86_400_000),
  );
  expect(
    (await accept(api.settle({ body: intent, headers }), [200])).body,
  ).toStrictEqual(original.body);
});

test("preserves one user's ten-connector cap when Marketing settles real source facts from two organizations", async () => {
  const consumer = marketingRewardConsumer();
  const actor = bdd.user();
  const anotherOrg = { ...actor, orgId: `org_${randomUUID()}` };
  const connectors = createConnectorBddApi(context);
  mockGmailConnectorOAuth();
  mockGoogleDriveConnectorOAuth();
  mockGitHubConnectorOAuth();
  mockSlackConnectorOAuth();
  const slugs = [
    "gmail",
    "google-drive",
    "google-forms",
    "google-calendar",
    "google-analytics",
    "google-ads",
    "google-maps",
    "google-sheets",
    "google-meet",
    "github",
    "slack",
  ] as const;
  for (const [index, slug] of slugs.entries()) {
    const owner = index < 9 ? actor : anotherOrg;
    const start = await connectors.startOauth(owner, slug, "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected OAuth state");
    }
    await connectors.completeOauthCallback(slug, {
      code: randomUUID(),
      state,
    });
  }
  await flushWaitUntilForTest();
  const facts = consumer.received.filter((fact) => {
    return (
      fact.type === "connector.oauth-authorized" && fact.userId === actor.userId
    );
  });
  const api = client();
  const outcomes = [];
  for (const fact of facts) {
    if (
      fact.type !== "connector.oauth-authorized" ||
      fact.connector.kind !== "builtin"
    ) {
      throw new Error("Expected builtin OAuth source");
    }
    const sourceKey = `builtin:${fact.connector.connectorSlug}`;
    const intent = campaignRequest({
      version: 1,
      environment: fact.environment,
      policy: "get-started-v1",
      sourceEventId: fact.id,
      questKey: "connector",
      sourceKey,
      rewardKey: `connector:${fact.userId}:${sourceKey}`,
      orgId: fact.orgId,
      actorUserId: fact.userId,
      beneficiaryUserId: fact.userId,
      rewardTarget: "user",
      rewardAmount: 100,
      completedAt: fact.occurredAt,
    });
    const result = await accept(api.settle({ body: intent, headers }), [200]);
    expect(
      (await accept(api.settle({ body: intent, headers }), [200])).body,
    ).toStrictEqual(result.body);
    outcomes.push(result.body.receipt.status);
  }
  expect(
    outcomes.filter((status) => {
      return status === "granted";
    }),
  ).toHaveLength(10);
  expect(
    outcomes.filter((status) => {
      return status === "ineligible";
    }),
  ).toHaveLength(1);
});

test("recovers the original iMessage and organization Slack receipts without replaying their financial effects", async () => {
  const consumer = marketingRewardConsumer();
  const integrations = createBddIntegrationApi(context);
  const actor = integrations.user();
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  const phone = createAgentPhoneBddApi(context);
  const proof = await phone.requestConnectLink(
    uniquePhoneHandle(),
    phone.captureAgentPhoneSends(),
  );
  await integrations.requestConnectAgentPhone(actor, proof, [200]);
  integrations.configureSlackAppMocks();
  await integrations.installSlackWorkspace(actor);
  await flushWaitUntilForTest();
  await integrations.requestUnlinkAgentPhone(actor, [204]);
  const facts = consumer.received.filter((fact) => {
    return (
      fact.type === "imessage.identity-linked" ||
      fact.type === "slack.oauth-authorized"
    );
  });
  expect(facts).toHaveLength(2);
  const api = client();
  for (const fact of facts) {
    const slack = fact.type === "slack.oauth-authorized";
    const sourceKey = slack ? fact.workspaceId : "agentphone-link";
    const questKey = slack ? "slack" : "imessage";
    const rewardKey = slack
      ? `slack:${sourceKey}`
      : `imessage:${fact.userId}:${sourceKey}`;
    const intent = campaignRequest({
      version: 1,
      environment: fact.environment,
      policy: "get-started-v1",
      sourceEventId: fact.id,
      questKey,
      sourceKey,
      rewardKey,
      orgId: fact.orgId,
      actorUserId: fact.userId,
      beneficiaryUserId: slack ? null : fact.userId,
      rewardTarget: slack ? "org" : "user",
      rewardAmount: slack ? 2000 : 1000,
      completedAt: fact.occurredAt,
    });
    const original = await accept(api.settle({ body: intent, headers }), [200]);
    expect(original.body.receipt).toMatchObject({
      status: "granted",
      rewardKey,
      rewardTarget: slack ? "org" : "user",
    });
    expect(
      (await accept(api.settle({ body: intent, headers }), [200])).body,
    ).toStrictEqual(original.body);
  }
});

async function invitationIntent(
  consumer: ReturnType<typeof marketingRewardConsumer>,
  actor: ReturnType<typeof bdd.user>,
  inviteeUserId: string,
) {
  mocks.clerk.session(actor.userId, actor.orgId);
  const signingSecret = `whsec_${Buffer.from("marketing-acceptance-test-secret").toString("base64")}`;
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", signingSecret);
  const sdk = await vi.importActual<typeof import("@clerk/backend/webhooks")>(
    "@clerk/backend/webhooks",
  );
  context.mocks.clerk.verifyWebhook.mockImplementation((request: unknown) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected webhook Request");
    }
    return sdk.verifyWebhook(request, { signingSecret });
  });
  const invitationId = `inv_${randomUUID()}`;
  let claimId: string | undefined;
  context.mocks.clerk.organizations.createOrganizationInvitation.mockImplementationOnce(
    (input: unknown) => {
      claimId = object({
        privateMetadata: object({ getStartedClaimId: uuid() }),
      }).parse(input).privateMetadata.getStartedClaimId;
      return Promise.resolve({ id: invitationId });
    },
  );
  await accept(
    setupApp({ context, routes: orgInviteRoutes })(orgInviteContract).invite({
      headers: { authorization: "Bearer clerk-session" },
      body: { email: `${randomUUID()}@example.com`, role: "member" },
    }),
    [200],
  );
  if (!claimId) {
    throw new Error("Expected server-attributed invitation");
  }
  const body = JSON.stringify({
    type: "organizationInvitation.accepted",
    data: {
      id: invitationId,
      organization_id: actor.orgId,
      user_id: inviteeUserId,
      email_address: `${inviteeUserId}@example.com`,
      updated_at: nowDate().getTime(),
      private_metadata: { getStartedClaimId: claimId },
    },
  });
  const id = randomUUID();
  const at = nowDate();
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
        "svix-signature": new Webhook(signingSecret).sign(id, at, body),
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  const fact = consumer.received.find((event) => {
    return (
      event.type === "invitation.accepted" &&
      event.invitationId === invitationId
    );
  });
  if (!fact || fact.type !== "invitation.accepted") {
    throw new Error("Expected accepted invitation fact");
  }
  const intent = campaignRequest({
    version: 1,
    environment: fact.environment,
    policy: "get-started-v1",
    sourceEventId: fact.id,
    questKey: "invite",
    sourceKey: fact.sourceKey,
    rewardKey: `invite:${fact.inviteeUserId}`,
    orgId: fact.orgId,
    actorUserId: fact.userId,
    beneficiaryUserId: fact.userId,
    rewardTarget: "user",
    rewardAmount: 100,
    completedAt: fact.occurredAt,
  });
  return { intent, claimId };
}

test("captures a signed acceptance and settles the original inviter exactly once", async () => {
  const consumer = marketingRewardConsumer();
  const actor = bdd.user();
  await bdd.completeOnboarding(actor);
  const inviteeUserId = `user_invitee_${randomUUID()}`;
  const { intent, claimId } = await invitationIntent(
    consumer,
    actor,
    inviteeUserId,
  );
  const api = client();
  const original = await accept(api.settle({ body: intent, headers }), [200]);
  expect(original.body.receipt).toMatchObject({
    id: claimId,
    status: "granted",
    beneficiaryUserId: actor.userId,
    rewardKey: `invite:${inviteeUserId}`,
  });
  expect(
    (await accept(api.settle({ body: intent, headers }), [200])).body,
  ).toStrictEqual(original.body);
});

test("enforces the inviter's fifteen-award limit across organizations and rewards each invitee only once", async () => {
  const consumer = marketingRewardConsumer();
  const actor = bdd.user();
  const anotherOrg = { ...actor, orgId: `org_${randomUUID()}` };
  await bdd.completeOnboarding(actor);
  await bdd.completeOnboarding(anotherOrg);
  const firstInvitee = `user_${randomUUID()}`;
  const api = client();
  const outcomes = [];
  for (let index = 0; index < 16; index++) {
    const { intent } = await invitationIntent(
      consumer,
      index < 8 ? actor : anotherOrg,
      index === 0 ? firstInvitee : `user_${randomUUID()}`,
    );
    const response = await accept(api.settle({ body: intent, headers }), [200]);
    expect(
      (await accept(api.settle({ body: intent, headers }), [200])).body,
    ).toStrictEqual(response.body);
    outcomes.push(response.body.receipt.status);
  }
  expect(
    outcomes.filter((status) => {
      return status === "granted";
    }),
  ).toHaveLength(15);
  expect(
    outcomes.filter((status) => {
      return status === "ineligible";
    }),
  ).toHaveLength(1);
  const otherInviter = bdd.user();
  await bdd.completeOnboarding(otherInviter);
  const { intent } = await invitationIntent(
    consumer,
    otherInviter,
    firstInvitee,
  );
  expect(
    (await accept(api.settle({ body: intent, headers }), [200])).body.receipt,
  ).toMatchObject({
    status: "ineligible",
    reason: "already_redeemed",
  });
});
