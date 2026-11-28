import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import {
  webhookGoogleCalendarContract,
  webhookGoogleWorkspaceEventsContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { webhooksGoogleCalendarRoutes } from "../webhooks-google-calendar";
import { webhooksGoogleWorkspaceEventsRoutes } from "../webhooks-google-workspace-events";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const WORKSPACE_EVENTS_API = "https://workspaceevents.googleapis.com/v1";
const MEET_TRANSCRIPT = "google-meet-transcript-generated" as const;
const WORKSPACE_PUSH_SERVICE_ACCOUNT =
  "workspace-events-push@okou-test.iam.gserviceaccount.com";
const WORKSPACE_CERT_KID = "workspace-events-pubsub-signing-key";
const WORKSPACE_SESSION = Object.freeze({
  authorization: "Bearer clerk-session",
});
const workspaceSigningKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const workflowsApi = setupApp({
  context,
  routes: workflowsRoutes,
})(workflowsCollectionContract);
const calendarAutomations = setupApp({
  context,
  routes: workflowAutomationsRoutes,
})(workflowAutomationsContract);
const calendarWebhook = setupApp({
  context,
  routes: webhooksGoogleCalendarRoutes,
})(webhookGoogleCalendarContract);
const workspaceWebhook = setupApp({
  context,
  routes: webhooksGoogleWorkspaceEventsRoutes,
})(webhookGoogleWorkspaceEventsContract);
const calendarOauthStart = setupApp({
  context,
  routes: builtinConnectorsRoutes,
})(builtinConnectorOauthStartContract);
const calendarOauthCallback = setupApp({
  context,
  routes: builtinConnectorsSlugCallbackRoutes,
})(builtinConnectorsSlugCallbackContract);

interface CalendarEvent {
  readonly id: string;
  readonly etag: string;
  readonly status: string;
  readonly summary?: string;
}

interface CalendarProvider {
  readonly incrementalReads: string[];
  readonly baselineTokens: string[];
  readonly watchTokens: string[];
  readonly stopTokens: string[];
  stopStatus: number;
  incremental: CalendarEvent[];
  channel(): { readonly id: string; readonly token: string };
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
}

/** Google Calendar API boundary for the member's connected accounts. */
function mockCalendarProvider(baseline: CalendarEvent[]): CalendarProvider {
  const watches: { id: string; token: string }[] = [];
  const provider: CalendarProvider = {
    incrementalReads: [],
    baselineTokens: [],
    watchTokens: [],
    stopTokens: [],
    stopStatus: 204,
    incremental: [],
    channel() {
      const [watch] = watches;
      if (!watch) {
        throw new Error("Expected the automation to register a watch");
      }
      return watch;
    },
  };
  server.use(
    http.get(`${CALENDAR_API}/calendars/:calendarId/events`, ({ request }) => {
      const syncToken = new URL(request.url).searchParams.get("syncToken");
      if (syncToken) {
        provider.incrementalReads.push(syncToken);
      } else {
        provider.baselineTokens.push(bearer(request));
      }
      return HttpResponse.json({
        items: syncToken ? provider.incremental : baseline,
        nextSyncToken: `sync-${randomUUID()}`,
      });
    }),
    http.get(`${CALENDAR_API}/calendars/:calendarId`, ({ params }) => {
      return HttpResponse.json({ id: String(params.calendarId) });
    }),
    http.post(
      `${CALENDAR_API}/calendars/:calendarId/events/watch`,
      async ({ request }) => {
        provider.watchTokens.push(bearer(request));
        const body = (await request.json()) as { id: string; token: string };
        watches.push({ id: body.id, token: body.token });
        return HttpResponse.json({
          id: body.id,
          resourceId: `resource-${body.id}`,
          resourceUri: `${CALENDAR_API}/calendars/primary/events`,
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.post(`${CALENDAR_API}/channels/stop`, ({ request }) => {
      provider.stopTokens.push(bearer(request));
      return new HttpResponse(null, { status: provider.stopStatus });
    }),
  );
  return provider;
}

async function setupCalendarAutomation(
  baseline: CalendarEvent[] = [],
  accessToken = "calendar-access-token",
) {
  const workflows = createWorkflowsBddApi(context);
  const actor = workflows.user();
  mockGoogleCalendarConnectorOAuth({
    accessToken,
    subject: `calendar-${randomUUID()}`,
    email: `calendar-${randomUUID()}@example.com`,
  });
  const provider = mockCalendarProvider(baseline);
  const [workflowId] = await Promise.all([
    workflows.createWorkflow(actor, {
      name: `calendar-${randomUUID().slice(0, 8)}`,
      visibility: "private",
    }),
    workflows.connectConnector(actor, "google-calendar"),
  ]);
  const mocks = createRouteMocks(context);
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const automations = setupApp({
    context,
    routes: workflowAutomationsRoutes,
  })(workflowAutomationsContract);
  const created = await accept(
    automations.create({
      headers: { authorization: "Bearer clerk-session" },
      params: { workflowId },
      body: { kind: "event", eventType: "google-calendar-event-created" },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  return {
    actor,
    provider,
    automationId: created.body.id,
    automations,
    authenticate() {
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      return { authorization: "Bearer clerk-session" } as const;
    },
  };
}

async function notify(
  channel: { readonly id: string; readonly token: string },
  overrides: { readonly token?: string; readonly messageNumber?: string } = {},
) {
  return await setupApp({ context, routes: webhooksGoogleCalendarRoutes })(
    webhookGoogleCalendarContract,
  ).post({
    body: "",
    extraHeaders: {
      "x-goog-channel-id": channel.id,
      "x-goog-channel-token": overrides.token ?? channel.token,
      "x-goog-resource-id": `resource-${channel.id}`,
      "x-goog-resource-state": "exists",
      "x-goog-message-number": overrides.messageNumber ?? "2",
    },
  });
}

/** Given of 005: Google fails the channel stop while the member disables the automation. */
async function setupDisabledAfterFailedStop() {
  const calendar = await setupCalendarAutomation();
  calendar.provider.stopStatus = 500;
  await accept(
    calendar.automations.disable({
      headers: calendar.authenticate(),
      params: { id: calendar.automationId },
    }),
    [200],
  );
  return calendar;
}

describe("POST /api/webhooks/google-calendar", () => {
  it("webhooks-google-calendar-017 acknowledges updated and cancelled events without dispatching", async () => {
    const existing = {
      id: `event-${randomUUID()}`,
      etag: '"1"',
      status: "confirmed",
      summary: "Existing",
    };
    const { provider } = await setupCalendarAutomation([existing]);
    provider.incremental = [
      { ...existing, etag: '"2"', summary: "Existing renamed" },
      { id: `event-${randomUUID()}`, etag: '"1"', status: "cancelled" },
    ];

    const response = await accept(notify(provider.channel()), [200]);

    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
  });

  it("webhooks-google-calendar-005 (1/2) rejects a notification for the disabled automation without reading events", async () => {
    const { provider } = await setupDisabledAfterFailedStop();

    await accept(notify(provider.channel()), [401]);

    expect(provider.baselineTokens).toHaveLength(1);
    expect(provider.incrementalReads).toStrictEqual([]);
  });

  it("webhooks-google-calendar-005 (2/2) deletes the disabled automation once the channel stop succeeds", async () => {
    const { provider, automationId, automations, authenticate } =
      await setupDisabledAfterFailedStop();
    await accept(notify(provider.channel()), [401]);
    provider.stopStatus = 204;

    await expect(
      automations.delete({
        headers: authenticate(),
        params: { id: automationId },
      }),
    ).resolves.toMatchObject({ status: 204 });
  });

  it("webhooks-google-calendar-021 rejects webhook notifications with the wrong channel token", async () => {
    const { provider } = await setupFastCalendarAutomation();

    const response = await accept(
      notifyFast(provider.channel(), { token: "wrong-token" }),
      [401],
    );

    expect(response.body).toStrictEqual({ error: "Unauthorized" });
  });
});

describe("Google Workspace Events subscription lifecycle", () => {
  it("webhooks-google-workspace-events-010 fails closed and does not retry after provider delete failure", async () => {
    const { provider, automationId, authenticate } =
      await setupMeetAutomation(503);
    const subscriptionName = provider.firstSubscription();

    await accept(
      calendarAutomations.disable({
        headers: authenticate(),
        params: { id: automationId },
        body: undefined,
      }),
      [200],
    );
    await flushWaitUntilForTest();

    const pushed = await accept(pushMeetTranscript(subscriptionName), [200]);

    expect(provider.deletedNames).toStrictEqual([subscriptionName]);
    expect(pushed.body).toStrictEqual({
      success: true,
      watchStates: 0,
      dispatched: 0,
      duplicates: 0,
    });
    expect(provider.createdNames).toStrictEqual([subscriptionName]);
    expect(provider.renewedNames).toStrictEqual([]);
  });
});

function notifyFast(
  channel: { readonly id: string; readonly token: string },
  overrides: { readonly token?: string; readonly messageNumber?: string } = {},
) {
  return calendarWebhook.post({
    body: "",
    extraHeaders: {
      "x-goog-channel-id": channel.id,
      "x-goog-channel-token": overrides.token ?? channel.token,
      "x-goog-resource-id": `resource-${channel.id}`,
      "x-goog-resource-state": "exists",
      "x-goog-message-number": overrides.messageNumber ?? "2",
    },
  });
}

async function completeCalendarOauth(authorizationUrl: string, code: string) {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Google Calendar OAuth state");
  }
  const completed = await accept(
    calendarOauthCallback.callback({
      headers: {},
      params: { connectorSlug: "google-calendar" },
      query: { code, state, responseMode: "json" },
    }),
    [200],
  );
  expect(completed.body.status).toBe("success");
}

async function setupFastCalendarAutomation() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin" as const,
  };
  mockGoogleCalendarConnectorOAuth({
    accessToken: "calendar-access-token",
    subject: `calendar-${randomUUID()}`,
    email: `calendar-${randomUUID()}@example.com`,
  });
  const provider = mockCalendarProvider([]);
  const mocks = createRouteMocks(context);
  const authenticate = () => {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" } as const;
  };
  const [createdWorkflow, oauthStarted] = await Promise.all([
    accept(
      workflowsApi.create({
        headers: authenticate(),
        body: {
          name: `calendar-${randomUUID().slice(0, 8)}`,
          visibility: "private",
        },
      }),
      [201],
    ),
    accept(
      calendarOauthStart.start({
        headers: authenticate(),
        params: { connectorSlug: "google-calendar" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [200],
    ),
  ]);
  const workflowId = createdWorkflow.body.id;
  await completeCalendarOauth(
    oauthStarted.body.authorizationUrl,
    `code-${randomUUID()}`,
  );
  const created = await accept(
    calendarAutomations.create({
      headers: authenticate(),
      params: { workflowId },
      body: { kind: "event", eventType: "google-calendar-event-created" },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  return { actor, provider, automationId: created.body.id, authenticate };
}

function configureWorkspaceEventsPubSub(): void {
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME",
    `projects/okou-test/topics/workspace-events-${randomUUID()}`,
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE",
    "https://api.okou.test/api/webhooks/google-workspace-events",
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    WORKSPACE_PUSH_SERVICE_ACCOUNT,
  );
  server.use(
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json({
        [WORKSPACE_CERT_KID]: workspaceSigningKey.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      });
    }),
  );
}

function encodeWorkspaceJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function workspacePubSubToken(): string {
  const seconds = Math.floor(now() / 1000);
  const signingInput = `${encodeWorkspaceJwtPart({ alg: "RS256", typ: "JWT", kid: WORKSPACE_CERT_KID })}.${encodeWorkspaceJwtPart(
    {
      iss: "https://accounts.google.com",
      aud: optionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE"),
      sub: "workspace-events-push-service-account",
      email: WORKSPACE_PUSH_SERVICE_ACCOUNT,
      email_verified: true,
      iat: seconds,
      exp: seconds + 3600,
    },
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(workspaceSigningKey.privateKey).toString("base64url")}`;
}

function mockWorkspaceEventsApi(deleteStatus: 200 | 503 = 200) {
  const createdNames: string[] = [];
  const deletedNames: string[] = [];
  const renewedNames: string[] = [];
  server.use(
    http.get(`${WORKSPACE_EVENTS_API}/subscriptions`, () => {
      return HttpResponse.json({ subscriptions: [] });
    }),
    http.post(`${WORKSPACE_EVENTS_API}/subscriptions`, () => {
      const name = `subscriptions/sub-${randomUUID().slice(0, 8)}`;
      createdNames.push(name);
      return HttpResponse.json({
        done: true,
        response: {
          name,
          state: "ACTIVE",
          expireTime: new Date(now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          notificationEndpoint: {
            pubsubTopic:
              optionalEnv("GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME") ?? "",
          },
        },
      });
    }),
    http.patch(`${WORKSPACE_EVENTS_API}/subscriptions/:id`, ({ params }) => {
      const name = `subscriptions/${String(params.id)}`;
      renewedNames.push(name);
      return HttpResponse.json({ done: true, response: { name } });
    }),
    http.delete(`${WORKSPACE_EVENTS_API}/subscriptions/:id`, ({ params }) => {
      const name = `subscriptions/${String(params.id)}`;
      deletedNames.push(name);
      if (deleteStatus === 503) {
        return HttpResponse.json(
          { error: { code: 503, message: "Service unavailable" } },
          { status: 503 },
        );
      }
      return HttpResponse.json({ done: true });
    }),
  );
  return {
    createdNames,
    deletedNames,
    renewedNames,
    firstSubscription() {
      const [name] = createdNames;
      if (!name) {
        throw new Error("Expected Workspace Events subscription");
      }
      return name;
    },
  };
}

function pushMeetTranscript(subscriptionName: string) {
  const transcriptName = `conferenceRecords/rec-${randomUUID().slice(0, 8)}/transcripts/tr-${randomUUID().slice(0, 8)}`;
  const cloudEvent = {
    id: `ce-${randomUUID()}`,
    source: `//workspaceevents.googleapis.com/${subscriptionName}`,
    type: "google.workspace.meet.transcript.v2.fileGenerated",
    time: new Date(now()).toISOString(),
    specversion: "1.0",
    data: {
      transcript: { name: transcriptName },
    },
  };
  return workspaceWebhook.post({
    body: JSON.stringify({
      message: {
        messageId: `pubsub-${randomUUID()}`,
        data: Buffer.from(JSON.stringify(cloudEvent), "utf8").toString(
          "base64",
        ),
      },
      subscription: "projects/okou-test/subscriptions/workspace-events-push",
    }),
    extraHeaders: { authorization: `Bearer ${workspacePubSubToken()}` },
  });
}

async function setupMeetAutomation(deleteStatus: 200 | 503 = 200) {
  configureWorkspaceEventsPubSub();
  const provider = mockWorkspaceEventsApi(deleteStatus);
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin" as const,
  };
  const primaryEmail = `meet-primary-${randomUUID()}@example.com`;
  mockGoogleCalendarConnectorOAuth({
    accessToken: `meet-primary-token-${randomUUID()}`,
    subject: `meet-primary-${randomUUID()}`,
    email: primaryEmail,
  });
  const mocks = createRouteMocks(context);
  const authenticate = () => {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return WORKSPACE_SESSION;
  };
  const [createdWorkflow, oauthStarted] = await Promise.all([
    accept(
      workflowsApi.create({
        headers: authenticate(),
        body: {
          name: `meet-${randomUUID().slice(0, 8)}`,
          visibility: "private",
        },
      }),
      [201],
    ),
    accept(
      calendarOauthStart.start({
        headers: authenticate(),
        params: { connectorSlug: "google-meet" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [200],
    ),
  ]);
  const workflowId = createdWorkflow.body.id;
  const state = new URL(oauthStarted.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected Google Meet OAuth state");
  }
  const completed = await accept(
    calendarOauthCallback.callback({
      headers: {},
      params: { connectorSlug: "google-meet" },
      query: { code: `code-${randomUUID()}`, state, responseMode: "json" },
    }),
    [200],
  );
  expect(completed.body.status).toBe("success");
  const created = await accept(
    calendarAutomations.create({
      headers: authenticate(),
      params: { workflowId },
      body: { kind: "event", eventType: MEET_TRANSCRIPT },
    }),
    [201],
  );
  await flushWaitUntilForTest();

  return {
    provider,
    automationId: created.body.id,
    authenticate,
  };
}
