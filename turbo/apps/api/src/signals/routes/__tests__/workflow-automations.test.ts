import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomInt, randomUUID } from "node:crypto";

import {
  chatThreadByIdContract,
  chatThreadMetadataContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadDeleteRoutes } from "../chat-threads-delete";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { githubOauthRoutes } from "../github-oauth";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  mockGmailConnectorOAuth,
  mockGoogleFormsConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { mockClerkUsers } from "./helpers/clerk-users";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const bdd = createBddApi(context);
const workflowsBdd = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const PRO_PRICE = apiTestEnvironment.OKOU_PRICE_PRO;
const TEAM_PRICE = apiTestEnvironment.OKOU_PRICE_TEAM;
const DAY_SECONDS = 86_400;
const GMAIL_TOPIC = "projects/okou-test/topics/gmail-automations";
const GOOGLE_FORMS_TOPIC = "projects/okou-test/topics/google-forms-automations";
const GOOGLE_FORMS_AUDIENCE = "https://api.okou.ai/api/webhooks/google-forms";
const GOOGLE_FORMS_SA = "forms-push@okou-test.iam.gserviceaccount.com";
const GITHUB_APP_SLUG = "okou-test";
const GITHUB_APP_ID = "123456";
const GITHUB_APP_PRIVATE_KEY_B64 = Buffer.from(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }),
).toString("base64");

function setupClients() {
  const mocks = createRouteMocks(context);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", `whsec_${randomUUID()}`);
  context.mocks.s3.send.mockResolvedValue({
    ContentLength: 1024,
    UploadId: randomUUID(),
    ETag: "fixture-etag",
  });

  const appFor = setupApp({
    context,
    routes: [
      ...webhooksStripeRoutes,
      ...workflowsRoutes,
      ...workflowAutomationsRoutes,
      ...chatThreadDeleteRoutes,
      ...chatThreadGetRoutes,
    ],
  });

  const stripeWebhook = appFor(webhookStripeContract);
  const workflows = appFor(workflowsCollectionContract);
  const workflowDetail = appFor(workflowsDetailContract);
  const automations = appFor(workflowAutomationsContract);
  const chatThreadById = appFor(chatThreadByIdContract);
  const chatThreadMetadata = appFor(chatThreadMetadataContract);

  function asActor(actor: ApiTestUser) {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  }

  async function deliverStripeEvent(event: Record<string, unknown>) {
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    await accept(
      stripeWebhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=workflow-automations" },
      }),
      [200],
    );
  }

  async function activatePlan(
    orgId: string,
    tier: "pro" | "team",
    existing?: {
      readonly customerId?: string;
      readonly subscriptionId?: string;
    },
  ) {
    const priceId = tier === "team" ? TEAM_PRICE : PRO_PRICE;
    const customerId =
      existing?.customerId ?? `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId =
      existing?.subscriptionId ?? `sub_${randomUUID().slice(0, 8)}`;
    const end = Math.floor(now() / 1000) + 30 * DAY_SECONDS;
    const start = end - 30 * DAY_SECONDS;

    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: customerId,
      metadata: { orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      status: "active",
      customer: customerId,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: priceId },
            current_period_start: start,
            current_period_end: end,
          },
        ],
      },
    });

    await deliverStripeEvent({
      id: `evt_${randomUUID()}`,
      created: Math.floor(now() / 1000),
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: {},
            },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID().slice(0, 8)}`,
                price: { id: priceId },
                quantity: 1,
                parent: { type: "subscription_item_details" },
                period: { start, end },
              },
            ],
          },
        },
      },
    });

    return { customerId, subscriptionId };
  }

  async function setupOrgWorkflow(
    options: {
      readonly tier?: "pro" | "team";
      readonly name?: string;
      readonly visibility?: "public" | "private";
    } = {},
  ) {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected org-scoped actor");
    }
    const billing = await activatePlan(actor.orgId, options.tier ?? "pro");
    asActor(actor);
    const workflowName = options.name ?? `wf-${randomUUID().slice(0, 8)}`;
    const created = await accept(
      workflows.create({
        headers: AUTH_HEADERS,
        body: {
          name: workflowName,
          visibility: options.visibility ?? "public",
        },
      }),
      [201],
    );
    return {
      actor,
      orgId: actor.orgId,
      workflowId: created.body.id,
      workflowName,
      ...billing,
    };
  }

  async function createWorkflowFor(
    actor: ApiTestUser,
    options: {
      readonly name?: string;
      readonly visibility?: "public" | "private";
    } = {},
  ) {
    asActor(actor);
    const name = options.name ?? `wf-${randomUUID().slice(0, 8)}`;
    const created = await accept(
      workflows.create({
        headers: AUTH_HEADERS,
        body: {
          name,
          visibility: options.visibility ?? "public",
        },
      }),
      [201],
    );
    return { id: created.body.id, name };
  }

  return {
    asActor,
    activatePlan,
    deliverStripeEvent,
    setupOrgWorkflow,
    createWorkflowFor,
    workflows,
    workflowDetail,
    automations,
    chatThreadById,
    chatThreadMetadata,
  };
}

function configureGmailPubSub() {
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC);
}

function configureGoogleFormsPubSub() {
  mockOptionalEnv("GOOGLE_FORMS_PUBSUB_TOPIC_NAME", GOOGLE_FORMS_TOPIC);
  mockOptionalEnv("GOOGLE_FORMS_PUBSUB_PUSH_AUDIENCE", GOOGLE_FORMS_AUDIENCE);
  mockOptionalEnv(
    "GOOGLE_FORMS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    GOOGLE_FORMS_SA,
  );
}

async function installGithubAppForOrg(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("GitHub installation requires an org-scoped actor");
  }
  const clientId = `gh-client-${randomUUID().slice(0, 8)}`;
  const clientSecret = `gh-secret-${randomUUID().slice(0, 8)}`;
  mockOptionalEnv("GITHUB_APP_SLUG", GITHUB_APP_SLUG);
  mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", GITHUB_APP_PRIVATE_KEY_B64);
  mockOptionalEnv("GITHUB_APP_CLIENT_ID", clientId);
  mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", clientSecret);

  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  mockClerkMembership(context, actor, "org:admin");
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "GitHub",
    },
  ]);

  const installationId = String(randomInt(1_000_000_000, 9_999_999_999));
  const targetId = String(randomInt(1_000_000_000, 9_999_999_999));
  const code = `gh-install-${randomUUID().slice(0, 8)}`;
  const accessToken = `gho_${code}`;

  server.use(
    http.get("https://api.github.com/app/installations", () => {
      return HttpResponse.json([]);
    }),
    http.get(
      `https://api.github.com/app/installations/${installationId}`,
      () => {
        return HttpResponse.json({
          id: Number(installationId),
          app_id: Number(GITHUB_APP_ID),
          app_slug: GITHUB_APP_SLUG,
          account: {
            id: Number(targetId),
            login: "okou-ai",
            type: "Organization",
          },
        });
      },
    ),
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () => {
        return HttpResponse.json(
          {
            token: "ghs_test_installation_token",
            expires_at: "2099-01-01T00:00:00Z",
          },
          { status: 201 },
        );
      },
    ),
    http.post("https://github.com/login/oauth/access_token", () => {
      return HttpResponse.json({
        access_token: accessToken,
        scope: "repo,project,workflow",
      });
    }),
    http.get("https://api.github.com/user", () => {
      return HttpResponse.json({
        id: Number(targetId),
        login: "octocat",
        email: null,
      });
    }),
    http.get("https://api.github.com/user/memberships/orgs", () => {
      return HttpResponse.json([
        {
          state: "active",
          role: "admin",
          organization: { id: Number(targetId) },
        },
      ]);
    }),
  );

  const rawRequest = setupRawAppRequest({ context, routes: githubOauthRoutes });
  const installQuery = new URLSearchParams({
    userId: actor.userId,
    orgId: actor.orgId,
  }).toString();
  const installResponse = await rawRequest(
    `/api/github/oauth/install?${installQuery}`,
    { method: "GET", headers: AUTH_HEADERS },
  );
  const location = installResponse.headers.get("location");
  if (installResponse.status !== 307 || !location) {
    throw new Error(
      `Expected GitHub install redirect, got ${installResponse.status}`,
    );
  }
  const state = new URL(location).searchParams.get("state");
  if (!state) {
    throw new Error("Expected GitHub install redirect state");
  }

  const callbackQuery = new URLSearchParams({
    installation_id: installationId,
    setup_action: "install",
    state,
    code,
  }).toString();
  let callbackResponse = await rawRequest(
    `/api/github/app/setup/callback?${callbackQuery}`,
    { method: "GET", headers: AUTH_HEADERS },
  );
  let callbackLocation = callbackResponse.headers.get("location");
  if (
    callbackResponse.status === 307 &&
    callbackLocation &&
    new URL(callbackLocation).pathname === "/api/github/app/setup/callback"
  ) {
    callbackResponse = await rawRequest(callbackLocation, {
      method: "GET",
      headers: AUTH_HEADERS,
    });
    callbackLocation = callbackResponse.headers.get("location");
  }
  if (
    callbackResponse.status !== 307 ||
    !callbackLocation ||
    new URL(callbackLocation).pathname !== "/workflows"
  ) {
    throw new Error(
      `Expected GitHub setup callback to finish at /workflows, got ${callbackResponse.status} ${callbackLocation ?? ""}`,
    );
  }
}

describe("okou workflow automations", () => {
  it("workflow-automations-005 rejects creation on a workflow the caller cannot see", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { orgId, workflowId } = await setupOrgWorkflow({
      tier: "pro",
      visibility: "private",
    });
    const peer = bdd.user({ orgId, orgRole: "org:member" });

    asActor(peer);
    const response = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [404],
    );

    expect(response.body.error).toStrictEqual({
      code: "NOT_FOUND",
      message: `Workflow not found: ${workflowId}`,
    });
  });

  it("workflow-automations-001 creates, disables, and re-enables a cron automation without binding a chat thread", async () => {
    mockNow(new Date("2026-06-26T08:00:00.000Z"));
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * 1-5",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      kind: "schedule",
      enabled: true,
      chatThreadId: null,
      nextRunAt: "2026-06-26T09:00:00.000Z",
      scheduleSummary: "0 9 * * 1-5 (UTC)",
    });

    const disabled = await accept(
      automations.disable({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(disabled.body).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });

    mockNow(new Date("2026-06-26T10:00:00.000Z"));
    const reenabled = await accept(
      automations.enable({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(reenabled.body).toMatchObject({
      enabled: true,
      nextRunAt: "2026-06-29T09:00:00.000Z",
      chatThreadId: null,
    });
  });

  it("workflow-automations-002 lists thread-bound workflow automations", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId, workflowName } = await setupOrgWorkflow({
      tier: "team",
    });

    asActor(actor);
    const webhook = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const threadId = webhook.body.chatThreadId;
    if (!threadId) {
      throw new Error("Expected webhook automation to bind a chat thread");
    }
    await accept(
      automations.delete({
        headers: AUTH_HEADERS,
        params: { id: webhook.body.id },
      }),
      [204],
    );

    const loop = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 60 },
        },
      }),
      [201],
    );
    const cron = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: {
            type: "cron",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );

    expect(loop.body.chatThreadId).toBe(threadId);
    expect(cron.body.chatThreadId).toBe(threadId);

    const listed = await accept(
      automations.listForChatThread({
        headers: AUTH_HEADERS,
        params: { threadId },
      }),
      [200],
    );
    expect(listed.body).toHaveLength(2);
    expect(listed.body[0]).toMatchObject({
      id: loop.body.id,
      kind: "schedule",
      chatThreadId: threadId,
      scheduleSummary: "Every 60s",
      workflow: { id: workflowId, name: workflowName },
    });
    expect(listed.body[1]).toMatchObject({
      id: cron.body.id,
      kind: "schedule",
      chatThreadId: threadId,
      scheduleSummary: "0 9 * * * (UTC)",
      workflow: { id: workflowId, name: workflowName },
    });
  });

  it("workflow-automations-003 (1/3) shares one destination thread across concurrent webhook automation creates", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "team" });

    asActor(actor);
    const [first, second] = await Promise.all([
      accept(
        automations.create({
          headers: AUTH_HEADERS,
          params: { workflowId },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      ),
      accept(
        automations.create({
          headers: AUTH_HEADERS,
          params: { workflowId },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      ),
    ]);

    const firstThreadId = first.body.chatThreadId;
    if (!firstThreadId) {
      throw new Error("Expected concurrent creates to bind a thread");
    }
    expect(second.body.chatThreadId).toBe(firstThreadId);

    const threadList = await accept(
      automations.listForChatThread({
        headers: AUTH_HEADERS,
        params: { threadId: firstThreadId },
      }),
      [200],
    );
    expect(
      new Set(
        threadList.body.map((item) => {
          return item.id;
        }),
      ),
    ).toStrictEqual(new Set([first.body.id, second.body.id]));
  });

  it("workflow-automations-003 (2/3) disables bound automations and clears their thread after deleting the destination thread", async () => {
    const { setupOrgWorkflow, asActor, automations, chatThreadById } =
      setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "team" });

    asActor(actor);
    const [first, second] = await Promise.all([
      accept(
        automations.create({
          headers: AUTH_HEADERS,
          params: { workflowId },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      ),
      accept(
        automations.create({
          headers: AUTH_HEADERS,
          params: { workflowId },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      ),
    ]);

    const firstThreadId = first.body.chatThreadId;
    if (!firstThreadId) {
      throw new Error("Expected concurrent creates to bind a thread");
    }

    await accept(
      chatThreadById.delete({
        headers: AUTH_HEADERS,
        params: { id: firstThreadId },
      }),
      [204],
    );

    const [firstAfterDelete, secondAfterDelete] = await Promise.all([
      accept(
        automations.get({
          headers: AUTH_HEADERS,
          params: { id: first.body.id },
        }),
        [200],
      ),
      accept(
        automations.get({
          headers: AUTH_HEADERS,
          params: { id: second.body.id },
        }),
        [200],
      ),
    ]);
    expect(firstAfterDelete.body).toMatchObject({
      enabled: false,
      chatThreadId: null,
    });
    expect(secondAfterDelete.body).toMatchObject({
      enabled: false,
      chatThreadId: null,
    });
  });

  it("workflow-automations-003 (3/3) rebinds a subsequent webhook automation to a new thread after deleting the old thread", async () => {
    const {
      setupOrgWorkflow,
      asActor,
      automations,
      chatThreadById,
      chatThreadMetadata,
    } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "team" });

    asActor(actor);
    const first = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const firstThreadId = first.body.chatThreadId;
    if (!firstThreadId) {
      throw new Error("Expected webhook automation to bind a thread");
    }

    await accept(
      chatThreadById.delete({
        headers: AUTH_HEADERS,
        params: { id: firstThreadId },
      }),
      [204],
    );

    const rebound = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const reboundThreadId = rebound.body.chatThreadId;
    if (!reboundThreadId) {
      throw new Error("Expected rebound automation to bind a new thread");
    }
    expect(reboundThreadId).not.toBe(firstThreadId);

    await Promise.all([
      accept(
        chatThreadMetadata.get({
          headers: AUTH_HEADERS,
          params: { id: firstThreadId },
        }),
        [404],
      ),
      accept(
        chatThreadMetadata.get({
          headers: AUTH_HEADERS,
          params: { id: reboundThreadId },
        }),
        [200],
      ),
    ]);
  });

  it("workflow-automations-004 validates, creates, updates and lists a one-time schedule in its time zone", async () => {
    mockNow(new Date("2026-06-22T07:50:00.000Z"));
    const { setupOrgWorkflow, asActor, automations, workflowDetail } =
      setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });

    asActor(actor);
    const pastResponse = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: {
            type: "once",
            atTime: "2026-06-22T07:49:00.000Z",
            timezone: "UTC",
          },
        },
      }),
      [400],
    );
    expect(pastResponse.body.error).toStrictEqual({
      code: "BAD_REQUEST",
      message: "Schedule atTime must be in the future",
    });

    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: {
            type: "once",
            atTime: "2026-06-22T15:55:00",
            timezone: "Asia/Shanghai",
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      kind: "schedule",
      nextRunAt: "2026-06-22T07:55:00.000Z",
      schedule: {
        type: "once",
        atTime: "2026-06-22T07:55:00.000Z",
        timezone: "Asia/Shanghai",
      },
    });

    const updated = await accept(
      automations.update({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
        body: {
          schedule: {
            type: "once",
            atTime: "2026-06-22T16:05:00",
            timezone: "Asia/Shanghai",
          },
        },
      }),
      [200],
    );
    expect(updated.body).toMatchObject({
      kind: "schedule",
      nextRunAt: "2026-06-22T08:05:00.000Z",
      schedule: {
        type: "once",
        atTime: "2026-06-22T08:05:00.000Z",
        timezone: "Asia/Shanghai",
      },
    });

    const [listRes, detailRes] = await Promise.all([
      accept(
        automations.list({ headers: AUTH_HEADERS, params: { workflowId } }),
        [200],
      ),
      accept(
        workflowDetail.get({ headers: AUTH_HEADERS, params: { workflowId } }),
        [200],
      ),
    ]);
    const expectedMatch = {
      id: created.body.id,
      kind: "schedule",
      nextRunAt: "2026-06-22T08:05:00.000Z",
      schedule: {
        type: "once",
        atTime: "2026-06-22T08:05:00.000Z",
        timezone: "Asia/Shanghai",
      },
    };
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject(expectedMatch);
    expect(detailRes.body.automations).toHaveLength(1);
    expect(detailRes.body.automations[0]).toMatchObject(expectedMatch);
  });

  it("workflow-automations-006 requires Team for webhook automation creation", async () => {
    const { setupOrgWorkflow, activatePlan, asActor, automations } =
      setupClients();
    const { actor, orgId, workflowId, customerId, subscriptionId } =
      await setupOrgWorkflow({ tier: "pro" });

    asActor(actor);
    const proAttempt = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [402],
    );
    expect(proAttempt.body.error).toStrictEqual({
      code: "TEAM_REQUIRED",
      message: "Webhook automations require a Team workspace",
    });

    await activatePlan(orgId, "team", { customerId, subscriptionId });

    asActor(actor);
    const teamAttempt = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    expect(teamAttempt.body).toMatchObject({
      kind: "event",
      eventType: "webhook-received",
    });
  });

  it("workflow-automations-008 lists owned workflow automations across visible workflows", async () => {
    const { setupOrgWorkflow, createWorkflowFor, asActor, automations } =
      setupClients();
    const { actor, workflowId, workflowName } = await setupOrgWorkflow({
      tier: "pro",
    });
    const second = await createWorkflowFor(actor);

    asActor(actor);
    const firstAuto = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 60 },
        },
      }),
      [201],
    );
    const secondAuto = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId: second.id },
        body: {
          kind: "schedule",
          schedule: {
            type: "cron",
            cronExpression: "0 10 * * *",
            timezone: "UTC",
          },
        },
      }),
      [201],
    );

    const workspaceList = await accept(
      automations.listWorkspace({ headers: AUTH_HEADERS }),
      [200],
    );
    expect(workspaceList.body).toHaveLength(2);
    const byId = new Map(
      workspaceList.body.map((entry) => {
        return [entry.automation.id, entry];
      }),
    );
    expect(byId.get(firstAuto.body.id)?.workflow).toMatchObject({
      id: workflowId,
      name: workflowName,
    });
    expect(byId.get(secondAuto.body.id)?.workflow).toMatchObject({
      id: second.id,
      name: second.name,
    });
    for (const entry of workspaceList.body) {
      expect("files" in entry.workflow).toBeFalsy();
      expect("fileContents" in entry.workflow).toBeFalsy();
    }
  });

  it("workflow-automations-009 (1/2) discloses webhook credentials only on create and reveal while hiding them in lists", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "team" });

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const automation = created.body;
    if (
      automation.kind !== "event" ||
      automation.eventType !== "webhook-received" ||
      !automation.webhookUrl ||
      !automation.webhookSecret ||
      !automation.chatThreadId
    ) {
      throw new Error("Expected created webhook-received automation");
    }
    const threadId = automation.chatThreadId;
    const webhookPath = new URL(automation.webhookUrl).pathname;
    expect(automation.eventConfig).toStrictEqual({
      provider: "webhook",
      event: "received",
      auth: { mode: "hmac-sha256" },
    });
    expect(
      webhookPath.startsWith("/api/webhooks/workflow-automations/whk_"),
    ).toBeTruthy();
    expect(automation.secretLastFour).toBe(automation.webhookSecret.slice(-4));

    const [workflowList, threadList, revealed] = await Promise.all([
      accept(
        automations.list({ headers: AUTH_HEADERS, params: { workflowId } }),
        [200],
      ),
      accept(
        automations.listForChatThread({
          headers: AUTH_HEADERS,
          params: { threadId },
        }),
        [200],
      ),
      accept(
        automations.revealWebhookSecret({
          headers: AUTH_HEADERS,
          params: { id: automation.id },
        }),
        [200],
      ),
    ]);
    for (const listed of [workflowList.body[0], threadList.body[0]]) {
      if (
        !listed ||
        listed.kind !== "event" ||
        listed.eventType !== "webhook-received"
      ) {
        throw new Error("Expected webhook-received entry in list");
      }
      expect(listed.secretLastFour).toBe(automation.secretLastFour);
      expect(listed.webhookUrl).toBeUndefined();
      expect(listed.webhookSecret).toBeUndefined();
    }

    expect(revealed.body).toStrictEqual({
      webhookUrl: automation.webhookUrl,
      webhookSecret: automation.webhookSecret,
    });
  });

  it("workflow-automations-009 (2/2) notifies on deletion and keeps the thread model while emptying its automation list", async () => {
    const { setupOrgWorkflow, asActor, automations, chatThreadMetadata } =
      setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "team" });
    await runsApi.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const threadId = created.body.chatThreadId;
    if (!threadId) {
      throw new Error("Expected created webhook-received automation thread");
    }

    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();

    await accept(
      automations.delete({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
      }),
      [204],
    );

    expect(
      channelsPublishedTo(
        context.mocks,
        `chatThreadAutomationsChanged:${threadId}`,
      ),
    ).toContain(`user:${actor.userId}`);

    const [threadMeta, threadListAfter] = await Promise.all([
      accept(
        chatThreadMetadata.get({
          headers: AUTH_HEADERS,
          params: { id: threadId },
        }),
        [200],
      ),
      accept(
        automations.listForChatThread({
          headers: AUTH_HEADERS,
          params: { threadId },
        }),
        [200],
      ),
    ]);
    expect(threadMeta.body.selectedModel).toBe("claude-fable-5-1");
    expect(threadListAfter.body).toStrictEqual([]);
  });

  it("workflow-automations-013 (1/2) disables the webhook with paid_plan_required after Stripe deletes the Team subscription", async () => {
    const { setupOrgWorkflow, deliverStripeEvent, asActor, automations } =
      setupClients();
    const { actor, workflowId, customerId, subscriptionId } =
      await setupOrgWorkflow({ tier: "team" });

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );

    await deliverStripeEvent({
      id: `evt_${randomUUID()}`,
      created: Math.floor(now() / 1000),
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "canceled",
          metadata: {},
          items: { data: [{ price: { id: TEAM_PRICE } }] },
        },
      },
    });

    asActor(actor);
    const afterDowngrade = await accept(
      automations.get({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(afterDowngrade.body).toMatchObject({
      enabled: false,
      disabledReason: "paid_plan_required",
    });
  });

  it("workflow-automations-013 (2/2) clears the plan-disabled reason on re-enable after regaining Team without rotating credentials", async () => {
    const {
      setupOrgWorkflow,
      activatePlan,
      deliverStripeEvent,
      asActor,
      automations,
    } = setupClients();
    const { actor, orgId, workflowId, customerId, subscriptionId } =
      await setupOrgWorkflow({ tier: "team" });

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const automation = created.body;
    if (
      automation.kind !== "event" ||
      automation.eventType !== "webhook-received" ||
      !automation.webhookUrl ||
      !automation.webhookSecret
    ) {
      throw new Error("Expected webhook-received automation");
    }

    await deliverStripeEvent({
      id: `evt_${randomUUID()}`,
      created: Math.floor(now() / 1000),
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "canceled",
          metadata: {},
          items: { data: [{ price: { id: TEAM_PRICE } }] },
        },
      },
    });

    await activatePlan(orgId, "team", { customerId });

    asActor(actor);
    const reenabled = await accept(
      automations.enable({
        headers: AUTH_HEADERS,
        params: { id: automation.id },
      }),
      [200],
    );
    expect(reenabled.body).toMatchObject({
      enabled: true,
      disabledReason: null,
    });

    const revealed = await accept(
      automations.revealWebhookSecret({
        headers: AUTH_HEADERS,
        params: { id: automation.id },
      }),
      [200],
    );
    expect(revealed.body).toStrictEqual({
      webhookUrl: automation.webhookUrl,
      webhookSecret: automation.webhookSecret,
    });
  });

  it("workflow-automations-014 requires a connected account for provider event automations", async () => {
    configureGmailPubSub();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });

    asActor(actor);
    const gmailRes = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [400],
    );
    expect(gmailRes.body.error.message).toBe(
      "Connect Gmail before adding a Gmail event automation",
    );

    const calRes = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [400],
    );
    expect(calRes.body.error.message).toBe(
      "Connect Google Calendar before adding a Google Calendar event automation",
    );

    const notionRes = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: `https://www.notion.so/Page-${randomUUID().replaceAll("-", "")}`,
          },
        },
      }),
      [400],
    );
    expect(notionRes.body.error.message).toBe(
      "Connect Notion before adding a Notion event automation",
    );
  });

  it("workflow-automations-016 rejects Google Forms respondent links with edit-page guidance", async () => {
    mockGoogleFormsConnectorOAuth();
    configureGoogleFormsPubSub();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "google-forms");

    asActor(actor);
    const response = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl:
              "https://docs.google.com/forms/d/e/1FAIpQLSeRespondentExample/viewform",
          },
        },
      }),
      [400],
    );
    expect(response.body.error.message).toBe(
      "Please open the form's edit page and copy the link from the address bar",
    );
  });

  it("workflow-automations-018 validates Google Forms, seeds the raw cursor, creates a watch, and warns for unpublished forms", async () => {
    mockGoogleFormsConnectorOAuth();
    configureGoogleFormsPubSub();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "google-forms");

    const formId = `form_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const editUrl = `https://docs.google.com/forms/d/${formId}/edit`;
    const expireTime = new Date(now() + 7 * 86_400_000).toISOString();

    server.use(
      http.get(`https://forms.googleapis.com/v1/forms/${formId}`, () => {
        return HttpResponse.json({
          formId,
          info: { title: "Customer survey" },
          publishSettings: {
            publishState: {
              isPublished: false,
              isAcceptingResponses: false,
            },
          },
        });
      }),
      http.get(
        `https://forms.googleapis.com/v1/forms/${formId}/responses`,
        () => {
          return HttpResponse.json({ responses: [] });
        },
      ),
      http.post(
        `https://forms.googleapis.com/v1/forms/${formId}/watches`,
        () => {
          return HttpResponse.json({
            id: `watch_${randomUUID().slice(0, 8)}`,
            eventType: "RESPONSES",
            expireTime,
            target: { topic: { topicName: GOOGLE_FORMS_TOPIC } },
          });
        },
      ),
    );

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-forms-response-submitted",
          eventConfig: {
            provider: "google-forms",
            event: "response_submitted",
            formUrl: editUrl,
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "google-forms-response-submitted",
      enabled: true,
      warning:
        "This Google Form is not accepting responses yet. Publish it before expecting response events.",
      eventConfig: {
        provider: "google-forms",
        event: "response_submitted",
        connectorId: expect.any(String),
        form: {
          id: formId,
          title: "Customer survey",
          url: editUrl,
        },
      },
    });
  });

  it("workflow-automations-025 requires standard notion.so page and database URLs for Notion automations", async () => {
    mockNotionConnectorOAuth();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "notion");

    asActor(actor);
    const pageRes = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: "https://example.com/notion-page",
          },
        },
      }),
      [400],
    );
    expect(pageRes.body.error.message).toBe(
      "Enter a standard notion.so page URL",
    );

    const dbRes = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: "https://example.com/notion-database",
          },
        },
      }),
      [400],
    );
    expect(dbRes.body.error.message).toBe(
      "Enter a standard notion.so database URL",
    );
  });

  it("workflow-automations-026 reports inaccessible Notion pages and databases", async () => {
    mockNotionConnectorOAuth();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "notion");

    const pageId = randomUUID();
    const dbId = randomUUID();
    server.use(
      http.get(`https://api.notion.com/v1/pages/${pageId}`, () => {
        return HttpResponse.json(
          { object: "error", status: 404, code: "object_not_found" },
          { status: 404 },
        );
      }),
      http.get(`https://api.notion.com/v1/databases/${dbId}`, () => {
        return HttpResponse.json(
          { object: "error", status: 404, code: "object_not_found" },
          { status: 404 },
        );
      }),
      http.get(`https://api.notion.com/v1/data_sources/${dbId}`, () => {
        return HttpResponse.json(
          { object: "error", status: 404, code: "object_not_found" },
          { status: 404 },
        );
      }),
    );

    asActor(actor);
    const pageRes = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: `https://www.notion.so/Missing-${pageId.replaceAll("-", "")}`,
          },
        },
      }),
      [400],
    );
    expect(pageRes.body.error.message).toBe(
      "Okou cannot access this Notion page",
    );

    const dbRes = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: `https://www.notion.so/Missing-${dbId.replaceAll("-", "")}`,
          },
        },
      }),
      [400],
    );
    expect(dbRes.body.error.message).toBe(
      "Okou cannot access this Notion database",
    );
  });

  it("workflow-automations-027 creates Notion child page automations by validating and storing the parent page", async () => {
    mockNotionConnectorOAuth();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "notion");

    const pageId = randomUUID();
    const rawUrl = `https://www.notion.so/Roadmap-${pageId.replaceAll("-", "")}`;
    const canonicalUrl = `https://www.notion.so/Roadmap-${pageId.replaceAll("-", "")}`;
    server.use(
      http.get(`https://api.notion.com/v1/pages/${pageId}`, () => {
        return HttpResponse.json({
          object: "page",
          id: pageId,
          url: canonicalUrl,
          parent: { type: "workspace" },
          properties: {
            title: {
              id: "title",
              type: "title",
              title: [{ plain_text: "Roadmap" }],
            },
          },
        });
      }),
    );

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: rawUrl,
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "notion-child-page-created",
      enabled: true,
      schedule: null,
      scheduleSummary: null,
      nextRunAt: null,
      chatThreadId: expect.any(String),
      eventConfig: {
        provider: "notion",
        event: "child_page_created",
        connectorId: expect.any(String),
        parentPage: {
          id: pageId,
          url: canonicalUrl,
          title: "Roadmap",
          rawUrl,
        },
      },
    });
  });

  it("workflow-automations-028 creates Notion database item automations by validating and storing the data source", async () => {
    mockNotionConnectorOAuth();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "notion");

    const databaseId = randomUUID();
    const dataSourceId = randomUUID();
    const rawUrl = `https://www.notion.so/Bug-Bash-${databaseId.replaceAll("-", "")}`;
    const dataSourceUrl = `https://www.notion.so/${databaseId.replaceAll("-", "")}`;

    server.use(
      http.get(`https://api.notion.com/v1/data_sources/${databaseId}`, () => {
        return HttpResponse.json(
          { object: "error", status: 404, code: "object_not_found" },
          { status: 404 },
        );
      }),
      http.get(`https://api.notion.com/v1/databases/${databaseId}`, () => {
        return HttpResponse.json({
          object: "database",
          id: databaseId,
          url: dataSourceUrl,
          title: [{ plain_text: "Bug Bash" }],
          data_sources: [{ id: dataSourceId, name: "Bug Bash" }],
        });
      }),
      http.get(`https://api.notion.com/v1/data_sources/${dataSourceId}`, () => {
        return HttpResponse.json({
          object: "data_source",
          id: dataSourceId,
          name: "Bug Bash",
          url: dataSourceUrl,
          parent: { type: "database_id", database_id: databaseId },
        });
      }),
    );

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: rawUrl,
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "notion-database-item-created",
      enabled: true,
      schedule: null,
      scheduleSummary: null,
      nextRunAt: null,
      chatThreadId: expect.any(String),
      eventConfig: {
        provider: "notion",
        event: "database_item_created",
        connectorId: expect.any(String),
        dataSource: {
          id: dataSourceId,
          url: dataSourceUrl,
          title: "Bug Bash",
          rawUrl,
        },
      },
    });
  });

  it("workflow-automations-029 creates Notion page content updated automations for a page scope", async () => {
    mockNotionConnectorOAuth();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "notion");

    const pageId = randomUUID();
    const rawUrl = `https://www.notion.so/Roadmap-${pageId.replaceAll("-", "")}`;
    const canonicalUrl = `https://www.notion.so/Roadmap-${pageId.replaceAll("-", "")}`;
    server.use(
      http.get(`https://api.notion.com/v1/pages/${pageId}`, () => {
        return HttpResponse.json({
          object: "page",
          id: pageId,
          url: canonicalUrl,
          parent: { type: "workspace" },
          properties: {
            title: {
              id: "title",
              type: "title",
              title: [{ plain_text: "Roadmap" }],
            },
          },
        });
      }),
    );

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: rawUrl,
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "notion-page-content-updated",
      enabled: true,
      schedule: null,
      scheduleSummary: null,
      nextRunAt: null,
      chatThreadId: expect.any(String),
      eventConfig: {
        provider: "notion",
        event: "page_content_updated",
        connectorId: expect.any(String),
        scope: {
          type: "page",
          page: {
            id: pageId,
            url: canonicalUrl,
            title: "Roadmap",
            rawUrl,
          },
        },
      },
    });
  });

  it("workflow-automations-031 creates a Gmail event automation with a watch and updates its match criteria", async () => {
    mockGmailConnectorOAuth();
    configureGmailPubSub();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "gmail");

    const watchRegistrations: unknown[] = [];
    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/profile", () => {
        return HttpResponse.json({
          emailAddress: "bdd-gmail@example.test",
          historyId: "1000",
        });
      }),
      http.post(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        async ({ request }) => {
          watchRegistrations.push(await request.json());
          return HttpResponse.json({
            historyId: "1001",
            expiration: String(now() + 7 * 86_400_000),
          });
        },
      ),
    );

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: { subject: { contains: "invoice" } },
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "gmail-new-message",
      enabled: true,
      schedule: null,
      scheduleSummary: null,
      chatThreadId: expect.any(String),
      eventConfig: {
        provider: "gmail",
        event: "new_message",
        match: { subject: { contains: "invoice" } },
      },
    });
    expect(watchRegistrations).toHaveLength(1);
    expect(watchRegistrations[0]).toMatchObject({ topicName: GMAIL_TOPIC });

    const updated = await accept(
      automations.update({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: { from: { contains: "billing@example.com" } },
          },
        },
      }),
      [200],
    );
    if (
      updated.body.kind !== "event" ||
      updated.body.eventType !== "gmail-new-message"
    ) {
      throw new Error("Expected gmail-new-message automation");
    }
    expect(updated.body.eventConfig.match).toStrictEqual({
      from: { contains: "billing@example.com" },
    });
  });

  it("workflow-automations-033 creates Google Calendar event-created automations with a watch and baseline", async () => {
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockGoogleCalendarConnectorOAuth({ email: "calendar-user@example.com" });
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "google-calendar");

    const watchRegistrations: unknown[] = [];
    const baselineSyncTokens: (string | null)[] = [];

    server.use(
      http.get(
        "https://www.googleapis.com/calendar/v3/calendars/:calendarId",
        () => {
          return HttpResponse.json({ id: "calendar-user@example.com" });
        },
      ),
      http.post(
        "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/watch",
        async ({ request }) => {
          const body = (await request.json()) as { readonly id?: string };
          watchRegistrations.push(body);
          return HttpResponse.json({
            id: body.id ?? `ch_${randomUUID().slice(0, 8)}`,
            resourceId: "res-calendar-1",
            resourceUri:
              "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            expiration: String(now() + 7 * 86_400_000),
          });
        },
      ),
      http.get(
        "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
        ({ request }) => {
          const url = new URL(request.url);
          baselineSyncTokens.push(url.searchParams.get("syncToken"));
          return HttpResponse.json({
            items: [
              {
                id: "evt-confirmed-1",
                status: "confirmed",
                summary: "Existing standup",
              },
            ],
            nextSyncToken: "sync-token-baseline-1",
          });
        },
      ),
    );

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
          eventConfig: {
            provider: "google-calendar",
            event: "event_created",
            calendarId: "calendar-user@example.com",
          },
        },
      }),
      [201],
    );

    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "google-calendar-event-created",
      enabled: true,
      schedule: null,
      scheduleSummary: null,
      chatThreadId: expect.any(String),
      eventConfig: {
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      },
    });
    expect(watchRegistrations).toHaveLength(1);
    expect(baselineSyncTokens).toStrictEqual([null]);
  });

  it("workflow-automations-048 leaves a Gmail automation disabled when watch setup fails", async () => {
    mockGmailConnectorOAuth();
    configureGmailPubSub();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "gmail");

    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/profile", () => {
        return HttpResponse.json({
          emailAddress: "bdd-gmail@example.test",
          historyId: "1000",
        });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json(
          { error: { code: 500, message: "Gmail watch unavailable" } },
          { status: 500 },
        );
      }),
    );

    asActor(actor);
    const disabledCreated = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
          enabled: false,
        },
      }),
      [201],
    );
    expect(disabledCreated.body.enabled).toBeFalsy();

    await accept(
      automations.enable({
        headers: AUTH_HEADERS,
        params: { id: disabledCreated.body.id },
      }),
      [400],
    );

    const readAfterEnable = await accept(
      automations.get({
        headers: AUTH_HEADERS,
        params: { id: disabledCreated.body.id },
      }),
      [200],
    );
    expect(readAfterEnable.body.enabled).toBeFalsy();

    await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-new-message",
          eventConfig: { provider: "gmail", event: "new_message" },
          enabled: true,
        },
      }),
      [400],
    );

    const listRes = await accept(
      automations.list({ headers: AUTH_HEADERS, params: { workflowId } }),
      [200],
    );
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject({
      id: disabledCreated.body.id,
      enabled: false,
    });
  });

  it("workflow-automations-052 (1/2) rejects a missing Gmail label on create and creates once the exact label exists", async () => {
    mockGmailConnectorOAuth();
    configureGmailPubSub();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "gmail");

    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/profile", () => {
        return HttpResponse.json({
          emailAddress: "bdd-gmail@example.test",
          historyId: "1000",
        });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json({
          historyId: "1001",
          expiration: String(now() + 7 * 86_400_000),
        });
      }),
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels", () => {
        return HttpResponse.json({
          labels: [{ id: "Label_support", name: "Support" }],
        });
      }),
    );

    asActor(actor);
    const missingCreate = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "support",
          },
        },
      }),
      [400],
    );
    expect(missingCreate.body.error).toStrictEqual({
      code: "GMAIL_LABEL_NOT_FOUND",
      message:
        "Label not found in the connected Gmail account. Check the label name and connected account.",
    });

    const listBeforeCreate = await accept(
      automations.list({ headers: AUTH_HEADERS, params: { workflowId } }),
      [200],
    );
    expect(listBeforeCreate.body).toStrictEqual([]);

    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Support",
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "gmail-label-applied",
      enabled: true,
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: "Support",
        resolvedLabelId: "Label_support",
      },
    });
  });

  it("workflow-automations-052 (2/2) keeps a Gmail label automation unchanged when an update label is missing and updates once added", async () => {
    mockGmailConnectorOAuth();
    configureGmailPubSub();
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await workflowsBdd.connectConnector(actor, "gmail");

    const gmailLabels: { readonly id: string; readonly name: string }[] = [
      { id: "Label_support", name: "Support" },
    ];

    server.use(
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/profile", () => {
        return HttpResponse.json({
          emailAddress: "bdd-gmail@example.test",
          historyId: "1000",
        });
      }),
      http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
        return HttpResponse.json({
          historyId: "1001",
          expiration: String(now() + 7 * 86_400_000),
        });
      }),
      http.get("https://gmail.googleapis.com/gmail/v1/users/me/labels", () => {
        return HttpResponse.json({ labels: gmailLabels });
      }),
    );

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "gmail-label-applied",
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Support",
          },
        },
      }),
      [201],
    );

    const missingUpdate = await accept(
      automations.update({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Escalated",
          },
        },
      }),
      [400],
    );
    expect(missingUpdate.body.error.code).toBe("GMAIL_LABEL_NOT_FOUND");

    const unchanged = await accept(
      automations.get({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(unchanged.body).toMatchObject({
      eventConfig: {
        labelName: "Support",
        resolvedLabelId: "Label_support",
      },
    });

    gmailLabels.push({ id: "Label_escalated", name: "Escalated" });
    const recoveredUpdate = await accept(
      automations.update({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Escalated",
          },
        },
      }),
      [200],
    );
    expect(recoveredUpdate.body).toMatchObject({
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: "Escalated",
        resolvedLabelId: "Label_escalated",
      },
    });
  });

  it("workflow-automations-054 (1/2) creates a GitHub pull request automation with action, merged, and PR filters", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await installGithubAppForOrg(actor);

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "github-pull-request",
          eventConfig: {
            provider: "github",
            event: "pull_request",
            repository: "okou-ai/okou",
            action: "closed",
            merged: true,
            filters: {
              baseBranches: ["main"],
              authors: ["octocat"],
              pullRequestNumbers: ["42"],
            },
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "github-pull-request",
      enabled: true,
      schedule: null,
      scheduleSummary: null,
      eventConfig: {
        provider: "github",
        event: "pull_request",
        repository: "okou-ai/okou",
        action: "closed",
        merged: true,
        filters: {
          baseBranches: ["main"],
          authors: ["octocat"],
          pullRequestNumbers: ["42"],
        },
      },
    });
  });

  it("workflow-automations-054 (2/2) updates a GitHub pull request automation to labeled and rejects opened with merged", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await installGithubAppForOrg(actor);

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "github-pull-request",
          eventConfig: {
            provider: "github",
            event: "pull_request",
            repository: "okou-ai/okou",
            action: "closed",
            merged: true,
            filters: {
              baseBranches: ["main"],
              authors: ["octocat"],
              pullRequestNumbers: ["42"],
            },
          },
        },
      }),
      [201],
    );

    const updated = await accept(
      automations.update({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "github",
            event: "pull_request",
            repository: "okou-ai/okou",
            action: "labeled",
            filters: { labels: ["ready-to-merge"] },
          },
        },
      }),
      [200],
    );
    if (
      updated.body.kind !== "event" ||
      updated.body.eventType !== "github-pull-request"
    ) {
      throw new Error("Expected github-pull-request automation");
    }
    expect(updated.body.eventConfig).toStrictEqual({
      provider: "github",
      event: "pull_request",
      repository: "okou-ai/okou",
      action: "labeled",
      filters: { labels: ["ready-to-merge"] },
    });

    await accept(
      automations.update({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "github",
            event: "pull_request",
            repository: "okou-ai/okou",
            action: "opened",
            merged: true,
            filters: {},
          },
        },
      }),
      [400],
    );
  });

  it("workflow-automations-055 creates and updates GitHub workflow run completed automations", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });
    await installGithubAppForOrg(actor);

    asActor(actor);
    const created = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "github-workflow-run-completed",
          eventConfig: {
            provider: "github",
            event: "workflow_run_completed",
            filters: {
              repositories: ["okou-ai/okou"],
              workflows: ["CI"],
              conclusions: ["failure", "startup_failure"],
              branches: ["main"],
              events: ["push"],
              actors: ["dependabot[bot]"],
            },
          },
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      kind: "event",
      eventType: "github-workflow-run-completed",
      enabled: true,
      nextRunAt: null,
      eventConfig: {
        provider: "github",
        event: "workflow_run_completed",
        filters: {
          repositories: ["okou-ai/okou"],
          workflows: ["CI"],
          conclusions: ["failure", "startup_failure"],
          branches: ["main"],
          events: ["push"],
          actors: ["dependabot[bot]"],
        },
      },
    });

    const updated = await accept(
      automations.update({
        headers: AUTH_HEADERS,
        params: { id: created.body.id },
        body: {
          eventConfig: {
            provider: "github",
            event: "workflow_run_completed",
            filters: {
              repositories: ["okou-ai/okou"],
              conclusions: ["success"],
              branches: ["release"],
            },
          },
        },
      }),
      [200],
    );
    if (
      updated.body.kind !== "event" ||
      updated.body.eventType !== "github-workflow-run-completed"
    ) {
      throw new Error("Expected github-workflow-run-completed automation");
    }
    expect(updated.body.eventConfig).toStrictEqual({
      provider: "github",
      event: "workflow_run_completed",
      filters: {
        repositories: ["okou-ai/okou"],
        conclusions: ["success"],
        branches: ["release"],
      },
    });
  });

  it("workflow-automations-056 rejects GitHub pull request automations when the GitHub App is not installed", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const { actor, workflowId } = await setupOrgWorkflow({ tier: "pro" });

    asActor(actor);
    const response = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "github-pull-request",
          eventConfig: {
            provider: "github",
            event: "pull_request",
            repository: "okou-ai/okou",
            action: "opened",
            filters: {},
          },
        },
      }),
      [400],
    );
    expect(response.body.error).toStrictEqual({
      code: "BAD_REQUEST",
      message: "Install GitHub before creating GitHub webhook automations",
    });
  });

  it("workflow-automations-059 allows another org member to manage only their own automations", async () => {
    const { setupOrgWorkflow, asActor, automations } = setupClients();
    const {
      actor: owner,
      orgId,
      workflowId,
    } = await setupOrgWorkflow({
      tier: "pro",
      visibility: "public",
    });

    asActor(owner);
    const ownerAutomation = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );

    const peer = bdd.user({ orgId, orgRole: "org:member" });
    asActor(peer);
    const peerAutomation = await accept(
      automations.create({
        headers: AUTH_HEADERS,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 7200 },
        },
      }),
      [201],
    );
    expect(peerAutomation.body.ownerUserId).toBe(peer.userId);

    const deleteOwnerAttempt = await accept(
      automations.delete({
        headers: AUTH_HEADERS,
        params: { id: ownerAutomation.body.id },
      }),
      [403],
    );
    expect(deleteOwnerAttempt.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: "Only the automation owner can manage this automation",
    });
  });
});

describe("okou workflow automations execution", () => {
  const chatApi = createChatFilesBddApi(context);
  const webhooksApi = createWebhookCallbackApi(context);
  const chatCallbacks = createChatCallbacksApi(context);

  function installExecutionBoundaries() {
    installWorkflowVolumeS3Fixture(context);
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    chatCallbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  }

  async function cleanupDispatchedRuns(
    actors: readonly ApiTestUser[],
    runnerGroup: string,
  ): Promise<void> {
    await flushWaitUntilForTest();
    for (let round = 0; round < 5; round++) {
      const dispatches = runsApi.receivedDispatches(runnerGroup);
      let cleanedAny = false;
      for (const envelope of dispatches) {
        const { runId, sandboxToken } = envelope.executionContext;
        for (const actor of actors) {
          const read = await runsApi.requestReadRun(actor, runId, [200, 404]);
          if (read.status !== 200) {
            continue;
          }
          if (
            read.body.status === "pending" ||
            read.body.status === "running"
          ) {
            await runsApi.requestCancelRun(actor, runId, [200]);
            await webhooksApi.requestAgentComplete(
              { runId, exitCode: 1, error: "Cancelled by test cleanup" },
              { authorization: `Bearer ${sandboxToken}` },
              [200],
            );
            await flushWaitUntilForTest();
            cleanedAny = true;
          }
          break;
        }
      }
      if (!cleanedAny) {
        break;
      }
    }
  }

  it(
    "workflow-automations-057 schedules a loop from its last run after updates and re-enabling, then converts it to cron",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(new Date("2026-06-28T06:00:00.000Z"));
      const { actor } = await workflowsBdd.setupWorkflowOrg({ tier: "pro" });
      installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      onTestFinished(async () => {
        await cleanupDispatchedRuns([actor], runnerGroup);
        clearMockNow();
      });
      const workflowId = await workflowsBdd.createWorkflow(actor, {
        name: `loop-last-run-${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      const { asActor, automations } = setupClients();
      asActor(actor);

      const created = await accept(
        automations.create({
          headers: AUTH_HEADERS,
          params: { workflowId },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 600 },
          },
        }),
        [201],
      );
      expect(created.body.nextRunAt).toBe("2026-06-28T06:00:00.000Z");

      mockNow(new Date("2026-06-28T06:05:00.000Z"));
      await accept(
        automations.run({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
        }),
        [201],
      );
      await flushWaitUntilForTest();

      mockNow(new Date("2026-06-28T06:10:00.000Z"));
      const updatedInterval = await accept(
        automations.update({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
          body: { schedule: { type: "loop", intervalSeconds: 3600 } },
        }),
        [200],
      );
      expect(updatedInterval.body.nextRunAt).toBe("2026-06-28T07:05:00.000Z");

      const disabled = await accept(
        automations.disable({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
        }),
        [200],
      );
      expect(disabled.body.nextRunAt).toBeNull();

      mockNow(new Date("2026-06-28T06:12:00.000Z"));
      const reenabled = await accept(
        automations.enable({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
        }),
        [200],
      );
      expect(reenabled.body).toMatchObject({
        enabled: true,
        nextRunAt: "2026-06-28T07:05:00.000Z",
      });

      const converted = await accept(
        automations.update({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
          body: {
            schedule: {
              type: "cron",
              cronExpression: "*/15 * * * *",
              timezone: "UTC",
            },
          },
        }),
        [200],
      );
      expect(converted.body).toMatchObject({
        kind: "schedule",
        schedule: {
          type: "cron",
          cronExpression: "*/15 * * * *",
          timezone: "UTC",
        },
        nextRunAt: "2026-06-28T06:15:00.000Z",
      });
    },
  );

  it(
    "workflow-automations-063 repairs a lazy destination after public thread deletion without reusing its identity",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startTime = Date.parse("2026-07-10T09:00:00.000Z");
      mockNow(startTime);
      const { actor } = await workflowsBdd.setupWorkflowOrg({ tier: "pro" });
      installExecutionBoundaries();
      const runnerGroup = await runsApi.configureRunnerGroup();

      onTestFinished(async () => {
        await cleanupDispatchedRuns([actor], runnerGroup);
        clearMockNow();
      });
      const workflowId = await workflowsBdd.createWorkflow(actor, {
        name: `repair-lazy-${randomUUID().slice(0, 8)}`,
        visibility: "public",
      });
      const {
        asActor,
        automations,
        workflowDetail,
        chatThreadById,
        chatThreadMetadata,
      } = setupClients();
      asActor(actor);

      const created = await accept(
        automations.create({
          headers: AUTH_HEADERS,
          params: { workflowId },
          body: {
            kind: "schedule",
            schedule: {
              type: "once",
              atTime: "2026-07-11T09:00:00.000Z",
              timezone: "UTC",
            },
          },
        }),
        [201],
      );

      const firstTrigger = await accept(
        automations.run({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      const firstThreadId = firstTrigger.body.chatThreadId;

      const firstEvents = await workflowsBdd.readThreadEvents(firstThreadId);
      const firstRunId = firstEvents.find((event) => {
        return event.eventType === "input.prompt" && event.runId !== undefined;
      })?.runId;
      if (!firstRunId) {
        throw new Error("Expected first run to launch");
      }

      const firstExec = await runsApi.executionInput(firstRunId);
      await runsApi.requestCancelRun(actor, firstRunId, [200]);
      await webhooksApi.requestAgentComplete(
        { runId: firstRunId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${firstExec.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      asActor(actor);
      await accept(
        chatThreadById.delete({
          headers: AUTH_HEADERS,
          params: { id: firstThreadId },
        }),
        [204],
      );

      const afterDelete = await accept(
        automations.get({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
        }),
        [200],
      );
      expect(afterDelete.body).toMatchObject({
        chatThreadId: null,
        enabled: false,
      });

      const lifecycleBefore = await chatApi.requestThreadEvents(
        actor,
        {},
        [200],
      );
      const prevEvents = lifecycleBefore.body.events;
      const prevLastSeqId = prevEvents.at(-1)?.seqId ?? 0;

      mockNow(startTime + 1000);
      asActor(actor);
      const secondTrigger = await accept(
        automations.run({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      const secondThreadId = secondTrigger.body.chatThreadId;
      expect(secondThreadId).not.toBe(firstThreadId);

      const history = await accept(
        workflowDetail.runHistory({
          headers: AUTH_HEADERS,
          params: { workflowId },
          query: {},
        }),
        [200],
      );
      expect(history.body.runs).toHaveLength(2);
      expect(history.body.runs[0]).toMatchObject({
        chatThreadId: secondThreadId,
        trigger: "manual",
      });
      expect(history.body.runs[1]).toMatchObject({
        id: firstRunId,
        status: "cancelled",
        chatThreadId: null,
        trigger: null,
      });

      const afterRepair = await accept(
        automations.get({
          headers: AUTH_HEADERS,
          params: { id: created.body.id },
        }),
        [200],
      );
      expect(afterRepair.body.chatThreadId).toBe(secondThreadId);

      await Promise.all([
        accept(
          chatThreadMetadata.get({
            headers: AUTH_HEADERS,
            params: { id: firstThreadId },
          }),
          [404],
        ),
        accept(
          chatThreadMetadata.get({
            headers: AUTH_HEADERS,
            params: { id: secondThreadId },
          }),
          [200],
        ),
      ]);

      const lifecycleAfter = await chatApi.requestThreadEvents(
        actor,
        {},
        [200],
      );
      expect(
        lifecycleAfter.body.events.slice(0, prevEvents.length),
      ).toStrictEqual(prevEvents);
      const addedEvents = lifecycleAfter.body.events.slice(prevEvents.length);
      expect(addedEvents).toHaveLength(1);
      expect(addedEvents[0]).toMatchObject({
        kind: "created",
        chatThreadId: secondThreadId,
        seqId: prevLastSeqId + 1,
      });
    },
  );
});
