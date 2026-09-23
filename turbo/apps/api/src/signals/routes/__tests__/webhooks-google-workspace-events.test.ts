import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID, sign as signData } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { testGoogleMeetSubscriptionRenewalContract } from "@okouai/api-contracts/contracts/test-google-meet-subscription-renewal";
import {
  workflowAutomationsContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  clearWorkflowAutomationEventConnectorAsPreviousApi,
  holdOrgAdmissionLock,
  readOrgAdmissionLockState,
  releaseOrgAdmissionLock,
  stageOfficialWorkflowAutomationFixture,
} from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { testGoogleMeetSubscriptionRenewalRoutes } from "../test-google-meet-subscription-renewal";
import { webhooksGoogleWorkspaceEventsRoutes } from "../webhooks-google-workspace-events";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";

const context = testContext({ connectorCatalog: true });
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);
const runs = createRunsApi(context);
const workflows = createWorkflowsBddApi(context);

const PUSH_AUDIENCE =
  "https://api.okou.ai/api/webhooks/google-workspace-events";
const PUSH_SERVICE_ACCOUNT =
  "google-workspace-events-push@vm0-ai-488909.iam.gserviceaccount.com";
const OIDC_CERT_KID = "google-workspace-events-test-key";
const oidcKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const oidcPublicKeyPem = oidcKeyPair.publicKey.export({
  type: "spki",
  format: "pem",
});

type OrgActor = ApiTestUser & { readonly orgId: string };

interface GoogleMeetProviderOptions {
  readonly createStatus?: number;
  readonly deleteStatus?: number;
  readonly expireTime?: string;
  readonly tokenExpiresInSeconds?: number;
  readonly onDelete?: () => Promise<void>;
}

interface GoogleMeetProviderRecorder {
  readonly accounts: Readonly<
    Record<GoogleMeetProviderAccountKey, GoogleMeetProviderAccountRecorder>
  >;
  readonly createdNames: string[];
  readonly deletedUrls: string[];
  readonly operations: string[];
  readonly runnerGroup: string;
  readonly topicName: string;
  readonly externalId: string;
  renewCalls: number;
  reactivateCalls: number;
}

type GoogleMeetProviderAccountKey = "primary" | "secondary";

interface GoogleMeetProviderAccountRecorder {
  readonly accessToken: string;
  readonly createdNames: string[];
  readonly deletedUrls: string[];
  readonly email: string;
  readonly externalId: string;
  readonly key: GoogleMeetProviderAccountKey;
  readonly operations: string[];
  renewCalls: number;
  reactivateCalls: number;
}

interface GoogleMeetFixture {
  readonly actor: OrgActor;
  readonly agentId: string;
  readonly workflowId: string;
  readonly connectorId: string;
  readonly provider: GoogleMeetProviderRecorder;
}

function authHeaders(actor: OrgActor) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

function connectorAccountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function renewalClient() {
  return setupApp({
    context,
    routes: testGoogleMeetSubscriptionRenewalRoutes,
  })(testGoogleMeetSubscriptionRenewalContract);
}

function workflowDetailClient() {
  return setupApp({ context, routes: workflowsRoutes })(
    workflowsDetailContract,
  );
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signedGoogleIdToken(): string {
  const issuedAt = Math.floor(now() / 1000);
  const header = { alg: "RS256", kid: OIDC_CERT_KID, typ: "JWT" };
  const payload = {
    aud: PUSH_AUDIENCE,
    email: PUSH_SERVICE_ACCOUNT,
    email_verified: true,
    exp: issuedAt + 600,
    iat: issuedAt,
    iss: "https://accounts.google.com",
    sub: "google-workspace-events-test-subject",
  };
  const signedContent = `${encodeJwtPart(header)}.${encodeJwtPart(payload)}`;
  const signature = signData(
    "RSA-SHA256",
    Buffer.from(signedContent, "utf8"),
    oidcKeyPair.privateKey,
  );
  return `${signedContent}.${signature.toString("base64url")}`;
}

function configureGoogleMeetBoundaries(
  options: GoogleMeetProviderOptions = {},
): GoogleMeetProviderRecorder {
  const testId = randomUUID();
  const account = (
    key: GoogleMeetProviderAccountKey,
  ): GoogleMeetProviderAccountRecorder => {
    return {
      accessToken: `google-meet-access-${key}-${testId}`,
      createdNames: [],
      deletedUrls: [],
      email: `meet-${key}-${testId}@example.test`,
      externalId: `google-meet-user-${key}-${testId}`,
      key,
      operations: [],
      renewCalls: 0,
      reactivateCalls: 0,
    };
  };
  const accounts = {
    primary: account("primary"),
    secondary: account("secondary"),
  } as const;
  const subscriptionAccounts = new Map<
    string,
    GoogleMeetProviderAccountRecorder
  >();
  const recorder: GoogleMeetProviderRecorder = {
    accounts,
    createdNames: [],
    deletedUrls: [],
    operations: [],
    runnerGroup: `vm0/google-workspace-events-${testId}`,
    topicName: `projects/vm0-ai-488909/topics/google-workspace-events-${testId}`,
    externalId: accounts.primary.externalId,
    renewCalls: 0,
    reactivateCalls: 0,
  };

  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", recorder.runnerGroup);
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME",
    recorder.topicName,
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_AUDIENCE",
    PUSH_AUDIENCE,
  );
  mockOptionalEnv(
    "GOOGLE_WORKSPACE_EVENTS_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL",
    PUSH_SERVICE_ACCOUNT,
  );

  server.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const requestBody = new URLSearchParams(await request.text());
      const code = requestBody.get("code");
      const refreshToken = requestBody.get("refresh_token");
      const requestedAccount = Object.values(accounts).find((candidate) => {
        return (
          code === `google-meet-code-${candidate.key}` ||
          refreshToken === `google-meet-refresh-${candidate.key}-${testId}`
        );
      });
      if (!requestedAccount) {
        return HttpResponse.text("unknown test Google Meet account", {
          status: 503,
        });
      }
      return HttpResponse.json({
        access_token: requestedAccount.accessToken,
        refresh_token: `google-meet-refresh-${requestedAccount.key}-${testId}`,
        expires_in: options.tokenExpiresInSeconds ?? 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", ({ request }) => {
      const requestedAccount = Object.values(accounts).find((candidate) => {
        return (
          request.headers.get("authorization") ===
          `Bearer ${candidate.accessToken}`
        );
      });
      if (!requestedAccount) {
        return HttpResponse.text("unknown test Google Meet account", {
          status: 503,
        });
      }
      return HttpResponse.json({
        id: requestedAccount.externalId,
        email: requestedAccount.email,
        name: `Google Meet ${requestedAccount.key} User`,
      });
    }),
    http.post(
      "https://workspaceevents.googleapis.com/v1/subscriptions",
      async ({ request }) => {
        const requestText = await request.text();
        const requestedAccount = Object.values(accounts).find((candidate) => {
          return (
            request.headers.get("authorization") ===
            `Bearer ${candidate.accessToken}`
          );
        });
        if (
          !requestedAccount ||
          !requestText.includes(recorder.topicName) ||
          !requestText.includes(requestedAccount.externalId)
        ) {
          return HttpResponse.text("unowned test subscription", {
            status: 503,
          });
        }
        const call = requestedAccount.createdNames.length + 1;
        const subscriptionName = `subscriptions/google-meet-${testId}-${requestedAccount.key}-${call}`;
        subscriptionAccounts.set(subscriptionName, requestedAccount);
        recorder.createdNames.push(subscriptionName);
        recorder.operations.push(`create:${subscriptionName}`);
        requestedAccount.createdNames.push(subscriptionName);
        requestedAccount.operations.push(`create:${subscriptionName}`);
        const body: unknown = JSON.parse(requestText);
        expect(body).toStrictEqual({
          targetResource: `//cloudidentity.googleapis.com/users/${requestedAccount.externalId}`,
          eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
          notificationEndpoint: { pubsubTopic: recorder.topicName },
          ttl: "604800s",
        });
        if (options.createStatus !== undefined) {
          return HttpResponse.text("create failed", {
            status: options.createStatus,
          });
        }
        return HttpResponse.json({
          response: {
            name: subscriptionName,
            targetResource: `//cloudidentity.googleapis.com/users/${requestedAccount.externalId}`,
            eventTypes: ["google.workspace.meet.transcript.v2.fileGenerated"],
            notificationEndpoint: { pubsubTopic: recorder.topicName },
            state: "ACTIVE",
            expireTime: options.expireTime ?? "2099-08-14T00:00:00.000Z",
          },
        });
      },
    ),
    http.patch(
      /^https:\/\/workspaceevents\.googleapis\.com\/v1\/subscriptions\/[^/]+$/,
      async ({ request }) => {
        const subscriptionName = new URL(request.url).pathname.slice(
          "/v1/".length,
        );
        const requestedAccount = subscriptionAccounts.get(subscriptionName);
        if (!requestedAccount) {
          return HttpResponse.text("unowned test subscription", {
            status: 503,
          });
        }
        recorder.renewCalls += 1;
        recorder.operations.push(`renew:${subscriptionName}`);
        requestedAccount.renewCalls += 1;
        requestedAccount.operations.push(`renew:${subscriptionName}`);
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${requestedAccount.accessToken}`,
        );
        expect(new URL(request.url).searchParams.get("updateMask")).toBe("ttl");
        await expect(request.json()).resolves.toStrictEqual({
          name: subscriptionName,
          ttl: "604800s",
        });
        return HttpResponse.json({
          response: {
            name: subscriptionName,
            state: "ACTIVE",
            expireTime: "2099-08-14T00:00:00.000Z",
          },
        });
      },
    ),
    http.post(
      /^https:\/\/workspaceevents\.googleapis\.com\/v1\/subscriptions\/[^/]+:reactivate$/,
      ({ request }) => {
        const subscriptionName = new URL(request.url).pathname
          .slice("/v1/".length)
          .replace(/:reactivate$/, "");
        const requestedAccount = subscriptionAccounts.get(subscriptionName);
        if (!requestedAccount) {
          return HttpResponse.text("unowned test subscription", {
            status: 503,
          });
        }
        recorder.reactivateCalls += 1;
        requestedAccount.reactivateCalls += 1;
        return HttpResponse.json({
          response: {
            name: subscriptionName,
            state: "ACTIVE",
            expireTime: "2099-08-14T00:00:00.000Z",
          },
        });
      },
    ),
    http.delete(
      /^https:\/\/workspaceevents\.googleapis\.com\/v1\/subscriptions\/[^/]+$/,
      async ({ request }) => {
        const url = new URL(request.url);
        const subscriptionName = url.pathname.slice("/v1/".length);
        const requestedAccount = subscriptionAccounts.get(subscriptionName);
        if (!requestedAccount) {
          return HttpResponse.text("unowned test subscription", {
            status: 503,
          });
        }
        recorder.deletedUrls.push(url.toString());
        recorder.operations.push(`delete-start:${subscriptionName}`);
        requestedAccount.deletedUrls.push(url.toString());
        requestedAccount.operations.push(`delete-start:${subscriptionName}`);
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${requestedAccount.accessToken}`,
        );
        expect(url.searchParams.get("allowMissing")).toBe("true");
        await options.onDelete?.();
        recorder.operations.push(`delete-end:${subscriptionName}`);
        requestedAccount.operations.push(`delete-end:${subscriptionName}`);
        if (options.deleteStatus !== undefined) {
          return HttpResponse.text("delete failed", {
            status: options.deleteStatus,
          });
        }
        return HttpResponse.json({
          name: `operations/delete-google-meet-${testId}`,
          done: true,
        });
      },
    ),
    http.get("https://www.googleapis.com/oauth2/v1/certs", () => {
      return HttpResponse.json(
        { [OIDC_CERT_KID]: oidcPublicKeyPem },
        { headers: { "cache-control": "no-cache" } },
      );
    }),
  );
  return recorder;
}

async function connectGoogleMeet(
  actor: OrgActor,
  provider: GoogleMeetProviderRecorder,
  accountKey: GoogleMeetProviderAccountKey = "primary",
  agentId?: string,
  account?: ConnectorAccountMutationIntent,
): Promise<string> {
  const started = await connectors.startOauth(
    actor,
    "google-meet",
    "oauth",
    agentId,
    account,
  );
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Google Meet OAuth state");
  }
  await connectors.completeOauthCallback("google-meet", {
    code: `google-meet-code-${accountKey}`,
    state,
  });
  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "google-meet",
  );
  const connectedAccount = accounts.find((candidate) => {
    return candidate.externalEmail === provider.accounts[accountKey].email;
  });
  if (!connectedAccount) {
    throw new Error(`Expected the ${accountKey} Google Meet connector account`);
  }
  return connectedAccount.id;
}

async function setupFixture(
  options: GoogleMeetProviderOptions = {},
): Promise<GoogleMeetFixture> {
  const provider = configureGoogleMeetBoundaries(options);
  const { actor } = await workflows.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const orgActor: OrgActor = { ...actor, orgId: actor.orgId };
  const agent = await workflows.createAgent(orgActor, {
    displayName: "Google Meet automation agent",
  });
  const workflowId = await workflows.createWorkflow(orgActor, {
    agentId: agent.agentId,
    name: `google-meet-transcript-${randomUUID()}`,
  });
  const connectorId = await connectGoogleMeet(orgActor, provider);
  context.mocks.s3.send.mockResolvedValue({});
  return {
    actor: orgActor,
    agentId: agent.agentId,
    workflowId,
    connectorId,
    provider,
  };
}

async function createMeetAutomation(
  fixture: GoogleMeetFixture,
  enabled?: boolean,
  workflowId: string = fixture.workflowId,
) {
  return await accept(
    automationsClient().create({
      headers: authHeaders(fixture.actor),
      params: { workflowId },
      body: {
        kind: "event",
        eventType: "google-meet-transcript-generated",
        ...(enabled === undefined ? {} : { enabled }),
      },
    }),
    [201],
  );
}

function pubSubPushBody(
  subscriptionName: string,
  eventId: string = randomUUID(),
): string {
  const cloudEvent = {
    id: `google-meet-cloud-event-${eventId}`,
    source: `//workspaceevents.googleapis.com/${subscriptionName}`,
    subject: `//meet.googleapis.com/conferenceRecords/${eventId}`,
    type: "google.workspace.meet.transcript.v2.fileGenerated",
    time: "2026-08-14T01:00:00.000Z",
    specversion: "1.0",
    data: {
      transcript: {
        name: `conferenceRecords/${eventId}/transcripts/${eventId}`,
      },
    },
  };
  return JSON.stringify({
    message: {
      messageId: `google-meet-pubsub-${eventId}`,
      data: Buffer.from(JSON.stringify(cloudEvent), "utf8").toString("base64"),
    },
    subscription:
      "projects/vm0-ai-488909/subscriptions/google-workspace-events-push",
  });
}

async function postWorkspaceEvent(subscriptionName: string): Promise<Response> {
  return await createApp({
    signal: context.signal,
    routes: webhooksGoogleWorkspaceEventsRoutes,
  }).request("/api/webhooks/google-workspace-events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${signedGoogleIdToken()}`,
      "content-type": "application/json",
    },
    body: pubSubPushBody(subscriptionName),
  });
}

describe("Google Workspace Events subscription lifecycle", () => {
  it("dispatches a visible Google Meet transcript message", async () => {
    const fixture = await setupFixture();
    const created = await createMeetAutomation(fixture);
    if (!created.body.chatThreadId) {
      throw new Error("Expected the automation to bind a chat thread");
    }
    const subscriptionName = fixture.provider.createdNames[0];
    if (!subscriptionName) {
      throw new Error("Expected a Workspace Events subscription");
    }

    const response = await postWorkspaceEvent(subscriptionName);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });

    const events = await workflows.readThreadEvents(created.body.chatThreadId);
    const visibleEvent = events.find((event) => {
      return (
        event.eventType === "input.automation" ||
        event.eventType === "input.prompt"
      );
    });
    if (!visibleEvent) {
      throw new Error("Expected a visible Google Meet automation event");
    }
    expect(chatEventDisplayText(visibleEvent)).toBe(
      "A Google Meet transcript is ready.",
    );
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.id },
      }),
      [204],
    );
  });

  it("does not create provider state for a disabled automation", async () => {
    const fixture = await setupFixture();
    const created = await createMeetAutomation(fixture, false);

    expect(created.body.enabled).toBeFalsy();
    expect(fixture.provider.operations).toStrictEqual([]);

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.id },
      }),
      [204],
    );
    expect(fixture.provider.operations).toStrictEqual([]);
  });

  it("rolls back active create and enable when provider setup fails", async () => {
    const fixture = await setupFixture({ createStatus: 503 });
    const disabled = await createMeetAutomation(fixture, false);

    const enableFailure = await accept(
      automationsClient().enable({
        headers: authHeaders(fixture.actor),
        params: { id: disabled.body.id },
      }),
      [400],
    );
    expect(enableFailure.body.error.message).toContain(
      "Failed to ensure Google Meet Workspace Events subscription",
    );

    const createFailure = await accept(
      automationsClient().create({
        headers: authHeaders(fixture.actor),
        params: { workflowId: fixture.workflowId },
        body: {
          kind: "event",
          eventType: "google-meet-transcript-generated",
        },
      }),
      [400],
    );
    expect(createFailure.body.error.message).toContain(
      "Failed to ensure Google Meet Workspace Events subscription",
    );

    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(fixture.actor),
        params: { workflowId: fixture.workflowId },
      }),
      [200],
    );
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      id: disabled.body.id,
      enabled: false,
    });
    expect(fixture.provider.createdNames).toHaveLength(2);
    expect(fixture.provider.deletedUrls).toStrictEqual([]);
  });

  it("keeps a shared subscription until the last enabled consumer", async () => {
    const fixture = await setupFixture();
    const first = await createMeetAutomation(fixture);
    const second = await createMeetAutomation(fixture);
    expect(fixture.provider.createdNames).toHaveLength(1);

    await accept(
      automationsClient().disable({
        headers: authHeaders(fixture.actor),
        params: { id: first.body.id },
      }),
      [200],
    );
    expect(fixture.provider.deletedUrls).toStrictEqual([]);

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: second.body.id },
      }),
      [204],
    );
    expect(fixture.provider.deletedUrls).toHaveLength(1);
    expect(fixture.provider.deletedUrls[0]).toContain(
      `/${fixture.provider.createdNames[0]}?allowMissing=true`,
    );

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: first.body.id },
      }),
      [204],
    );
    expect(fixture.provider.deletedUrls).toHaveLength(1);
  });

  it("isolates simultaneous subscriptions and dispatch by selected account", async () => {
    const fixture = await setupFixture();
    const primary = await createMeetAutomation(fixture);
    const secondaryConnectorId = await connectGoogleMeet(
      fixture.actor,
      fixture.provider,
      "secondary",
      fixture.agentId,
      { intent: "add", displayName: "Secondary Google Meet" },
    );
    const secondaryWorkflowId = await workflows.createWorkflow(fixture.actor, {
      agentId: fixture.agentId,
      name: `google-meet-secondary-${randomUUID()}`,
    });
    const secondary = await createMeetAutomation(
      fixture,
      false,
      secondaryWorkflowId,
    );
    if (!secondary.body.chatThreadId) {
      throw new Error("Expected a secondary automation chat thread");
    }
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(fixture.actor),
        params: { id: secondary.body.chatThreadId },
        body: {
          connectionId: secondaryConnectorId,
          target: { kind: "builtin", connectorSlug: "google-meet" },
        },
      }),
      [200],
    );
    await accept(
      automationsClient().enable({
        headers: authHeaders(fixture.actor),
        params: { id: secondary.body.id },
      }),
      [200],
    );

    const primarySubscription =
      fixture.provider.accounts.primary.createdNames[0];
    const secondarySubscription =
      fixture.provider.accounts.secondary.createdNames[0];
    if (!primarySubscription || !secondarySubscription) {
      throw new Error("Expected one subscription for each Google Meet account");
    }
    expect(fixture.provider.accounts.primary.createdNames).toHaveLength(1);
    expect(fixture.provider.accounts.secondary.createdNames).toHaveLength(1);

    await runs.heartbeatRunner(fixture.provider.runnerGroup);
    const primaryPush = await postWorkspaceEvent(primarySubscription);
    expect(primaryPush.status).toBe(200);
    await expect(primaryPush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });
    const primaryRunIds = new Set(
      (
        await runs.listAgentRuns(fixture.actor, {
          agent: fixture.agentId,
          limit: 20,
        })
      ).runs.map((run) => {
        return run.id;
      }),
    );
    const secondaryPush = await postWorkspaceEvent(secondarySubscription);
    expect(secondaryPush.status).toBe(200);
    await expect(secondaryPush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });
    const secondaryRunId = (
      await runs.listAgentRuns(fixture.actor, {
        agent: fixture.agentId,
        limit: 20,
      })
    ).runs.find((run) => {
      return !primaryRunIds.has(run.id);
    })?.id;
    if (!secondaryRunId) {
      throw new Error("Expected a queued run for the secondary account");
    }
    const claim = await runs.claimRunnerJob(secondaryRunId);
    expect(
      Object.values(claim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(
      expect.objectContaining({ sourceId: secondaryConnectorId }),
    );

    await createMeetAutomation(fixture);
    expect(fixture.provider.accounts.primary.createdNames).toHaveLength(1);
    expect(fixture.provider.accounts.secondary.createdNames).toHaveLength(1);
    expect(primary.body.chatThreadId).not.toBe(secondary.body.chatThreadId);
  });

  it("reconciles subscriptions when selection and default account change", async () => {
    const fixture = await setupFixture();
    const created = await createMeetAutomation(fixture);
    if (!created.body.chatThreadId) {
      throw new Error("Expected an automation chat thread");
    }
    const primarySubscription =
      fixture.provider.accounts.primary.createdNames[0];
    if (!primarySubscription) {
      throw new Error("Expected a primary Google Meet subscription");
    }
    const secondaryConnectorId = await connectGoogleMeet(
      fixture.actor,
      fixture.provider,
      "secondary",
      fixture.agentId,
      { intent: "add", displayName: "Secondary Google Meet" },
    );

    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.chatThreadId },
        body: {
          connectionId: secondaryConnectorId,
          target: { kind: "builtin", connectorSlug: "google-meet" },
        },
      }),
      [200],
    );
    const firstSecondarySubscription =
      fixture.provider.accounts.secondary.createdNames[0];
    if (!firstSecondarySubscription) {
      throw new Error("Expected a selected-account subscription");
    }
    expect(fixture.provider.accounts.primary.deletedUrls).toHaveLength(1);

    const delayedPrimary = await postWorkspaceEvent(primarySubscription);
    expect(delayedPrimary.status).toBe(200);
    await expect(delayedPrimary.json()).resolves.toMatchObject({
      watchStates: 0,
      dispatched: 0,
    });
    const selectedPush = await postWorkspaceEvent(firstSecondarySubscription);
    expect(selectedPush.status).toBe(200);
    await expect(selectedPush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });

    await accept(
      chatThreadConnectorSelectionsClient().clear({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.chatThreadId },
        body: { kind: "builtin", connectorSlug: "google-meet" },
      }),
      [204],
    );
    expect(fixture.provider.accounts.primary.createdNames).toHaveLength(2);
    expect(fixture.provider.accounts.secondary.deletedUrls).toHaveLength(1);

    await accept(
      connectorAccountsClient().setDefault({
        headers: authHeaders(fixture.actor),
        params: { connectionId: secondaryConnectorId },
        body: { target: { kind: "builtin", connectorSlug: "google-meet" } },
      }),
      [200],
    );
    expect(fixture.provider.accounts.primary.deletedUrls).toHaveLength(2);
    expect(fixture.provider.accounts.secondary.createdNames).toHaveLength(2);
  });

  it("retains staged official subscriptions across default account changes", async () => {
    const fixture = await setupFixture();
    const staged = await createMeetAutomation(fixture, false);
    await stageOfficialWorkflowAutomationFixture(
      context,
      staged.body.id,
      "meet-transcript",
    );
    expect(fixture.provider.createdNames).toStrictEqual([]);

    const secondaryConnectorId = await connectGoogleMeet(
      fixture.actor,
      fixture.provider,
      "secondary",
      fixture.agentId,
      { intent: "add", displayName: "Secondary Google Meet" },
    );
    expect(fixture.provider.accounts.primary.createdNames).toHaveLength(1);
    expect(fixture.provider.accounts.secondary.createdNames).toStrictEqual([]);

    await accept(
      connectorAccountsClient().setDefault({
        headers: authHeaders(fixture.actor),
        params: { connectionId: secondaryConnectorId },
        body: { target: { kind: "builtin", connectorSlug: "google-meet" } },
      }),
      [200],
    );
    expect(fixture.provider.accounts.primary.deletedUrls).toHaveLength(1);
    expect(fixture.provider.accounts.secondary.createdNames).toHaveLength(1);
  });

  it("supersedes an old source that changes before queue admission", async () => {
    const fixture = await setupFixture();
    const created = await createMeetAutomation(fixture);
    if (!created.body.chatThreadId) {
      throw new Error("Expected an automation chat thread");
    }
    const primarySubscription =
      fixture.provider.accounts.primary.createdNames[0];
    if (!primarySubscription) {
      throw new Error("Expected a primary Google Meet subscription");
    }
    const secondaryConnectorId = await connectGoogleMeet(
      fixture.actor,
      fixture.provider,
      "secondary",
      fixture.agentId,
      { intent: "add", displayName: "Secondary Google Meet" },
    );
    const admissionLockRequest = holdOrgAdmissionLock(
      context,
      `chat_event_queue:${created.body.chatThreadId}`,
    );
    const cleanupRequests: Promise<unknown>[] = [admissionLockRequest];
    onTestFinished(async () => {
      const cleanupResults = await Promise.allSettled([
        releaseOrgAdmissionLock(context),
        ...cleanupRequests,
      ]);
      const cleanupFailure = cleanupResults.find((result) => {
        return result.status === "rejected";
      });
      if (cleanupFailure?.status === "rejected") {
        throw cleanupFailure.reason;
      }
    });
    await expect
      .poll(async () => {
        return (await readOrgAdmissionLockState(context)).held;
      })
      .toBe(true);

    const oldSourceRequest = postWorkspaceEvent(primarySubscription);
    cleanupRequests.push(oldSourceRequest);
    await expect
      .poll(async () => {
        return (await readOrgAdmissionLockState(context)).waiting;
      })
      .toBe(true);
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.chatThreadId },
        body: {
          connectionId: secondaryConnectorId,
          target: { kind: "builtin", connectorSlug: "google-meet" },
        },
      }),
      [200],
    );
    await releaseOrgAdmissionLock(context);
    await admissionLockRequest;

    const oldSource = await oldSourceRequest;
    expect(oldSource.status).toBe(200);
    await expect(oldSource.json()).resolves.toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    const events = await workflows.readThreadEvents(created.body.chatThreadId);
    expect(
      events.filter((event) => {
        return (
          chatEventDisplayText(event) === "A Google Meet transcript is ready."
        );
      }),
    ).toStrictEqual([]);

    const secondarySubscription =
      fixture.provider.accounts.secondary.createdNames[0];
    if (!secondarySubscription) {
      throw new Error("Expected a secondary Google Meet subscription");
    }
    const currentSource = await postWorkspaceEvent(secondarySubscription);
    expect(currentSource.status).toBe(200);
    await expect(currentSource.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });
  });

  async function setupCopiedMeetAutomation() {
    const fixture = await setupFixture();
    const source = await createMeetAutomation(fixture);
    if (!source.body.chatThreadId) {
      throw new Error("Expected a source automation chat thread");
    }
    const secondaryConnectorId = await connectGoogleMeet(
      fixture.actor,
      fixture.provider,
      "secondary",
      fixture.agentId,
      { intent: "add", displayName: "Secondary Google Meet" },
    );
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(fixture.actor),
        params: { id: source.body.chatThreadId },
        body: {
          connectionId: secondaryConnectorId,
          target: { kind: "builtin", connectorSlug: "google-meet" },
        },
      }),
      [200],
    );
    const sourceSubscription =
      fixture.provider.accounts.secondary.createdNames[0];
    if (!sourceSubscription) {
      throw new Error("Expected a source-account subscription");
    }

    const targetAgent = await workflows.createAgent(fixture.actor, {
      displayName: "Google Meet copy target agent",
    });
    const copied = await accept(
      workflowDetailClient().copy({
        headers: authHeaders(fixture.actor),
        params: { workflowId: fixture.workflowId },
        body: { toAgentId: targetAgent.agentId },
      }),
      [201],
    );
    const copiedAutomations = await accept(
      automationsClient().list({
        headers: authHeaders(fixture.actor),
        params: { workflowId: copied.body.id },
      }),
      [200],
    );
    const copiedSubscription =
      fixture.provider.accounts.primary.createdNames[1];
    if (!copiedSubscription) {
      throw new Error("Expected a destination-default subscription");
    }
    return {
      fixture,
      copiedAutomations,
      sourceSubscription,
      copiedSubscription,
    };
  }

  it("reprojects a copied automation to the destination default account", async () => {
    const { fixture, copiedAutomations } = await setupCopiedMeetAutomation();
    expect(copiedAutomations.body).toContainEqual(
      expect.objectContaining({
        kind: "event",
        eventType: "google-meet-transcript-generated",
        enabled: true,
      }),
    );
    expect(fixture.provider.accounts.secondary.deletedUrls).toStrictEqual([]);
  });

  it("dispatches source and copied Google Meet automations independently", async () => {
    const { sourceSubscription, copiedSubscription } =
      await setupCopiedMeetAutomation();
    const sourcePush = await postWorkspaceEvent(sourceSubscription);
    expect(sourcePush.status).toBe(200);
    await expect(sourcePush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });
    const copiedPush = await postWorkspaceEvent(copiedSubscription);
    expect(copiedPush.status).toBe(200);
    await expect(copiedPush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });
  });

  it("repairs a legacy null account projection before dispatch", async () => {
    const fixture = await setupFixture();
    const created = await createMeetAutomation(fixture);
    const subscriptionName = fixture.provider.createdNames[0];
    if (!subscriptionName) {
      throw new Error("Expected a Workspace Events subscription");
    }
    await clearWorkflowAutomationEventConnectorAsPreviousApi(
      context,
      created.body.id,
    );

    const repairedPush = await postWorkspaceEvent(subscriptionName);
    expect(repairedPush.status).toBe(200);
    await expect(repairedPush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });
  });

  it("retains the exact subscription after reconnecting the same account", async () => {
    const fixture = await setupFixture();
    await createMeetAutomation(fixture);
    const originalSubscription =
      fixture.provider.accounts.primary.createdNames[0];
    if (!originalSubscription) {
      throw new Error("Expected an original Google Meet subscription");
    }

    const reconnectedConnectorId = await connectGoogleMeet(
      fixture.actor,
      fixture.provider,
      "primary",
      fixture.agentId,
      { intent: "reconnect", connectionId: fixture.connectorId },
    );
    expect(reconnectedConnectorId).toBe(fixture.connectorId);
    expect(fixture.provider.accounts.primary.createdNames).toStrictEqual([
      originalSubscription,
    ]);

    const reconnectedPush = await postWorkspaceEvent(originalSubscription);
    expect(reconnectedPush.status).toBe(200);
    await expect(reconnectedPush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });
  });

  it("fails closed and does not retry after provider delete failure", async () => {
    const fixture = await setupFixture({ deleteStatus: 503 });
    const created = await createMeetAutomation(fixture);
    const subscriptionName = fixture.provider.createdNames[0];
    if (!subscriptionName) {
      throw new Error("Expected a Workspace Events subscription");
    }

    await accept(
      automationsClient().disable({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(fixture.provider.deletedUrls).toHaveLength(1);

    const delayed = await postWorkspaceEvent(subscriptionName);
    expect(delayed.status).toBe(200);
    await expect(delayed.json()).resolves.toStrictEqual({
      success: true,
      watchStates: 0,
      dispatched: 0,
      duplicates: 0,
    });

    const renewed = await accept(
      renewalClient().renew({
        body: {
          org_id: fixture.actor.orgId,
          user_id: fixture.actor.userId,
        },
      }),
      [200],
    );
    expect(renewed.body).toMatchObject({
      success: true,
      renewed: 0,
      repaired: 0,
    });
    expect(fixture.provider.createdNames).toHaveLength(1);
    expect(fixture.provider.renewCalls).toBe(0);
  });

  it("commits connector deletion before one best-effort provider delete", async () => {
    const deleteStarted = createDeferredPromise<void>(context.signal);
    const deleteRelease = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!deleteRelease.settled()) {
        deleteRelease.resolve();
      }
    });
    const fixture = await setupFixture({
      deleteStatus: 503,
      tokenExpiresInSeconds: 60,
      onDelete: async () => {
        deleteStarted.resolve();
        await deleteRelease.promise;
      },
    });
    await createMeetAutomation(fixture);
    const subscriptionName = fixture.provider.createdNames[0];
    if (!subscriptionName) {
      throw new Error("Expected a Workspace Events subscription");
    }
    mockOptionalEnv(
      "GOOGLE_WORKSPACE_EVENTS_PUBSUB_TOPIC_NAME",
      `${fixture.provider.topicName}-replacement`,
    );

    const deletion = connectorAccountsClient().delete({
      headers: authHeaders(fixture.actor),
      params: { connectionId: fixture.connectorId },
      body: { target: { kind: "builtin", connectorSlug: "google-meet" } },
    });
    await deleteStarted.promise;
    const accountsWhileDeleteIsPending =
      await connectors.listBuiltinConnectorAccounts(
        fixture.actor,
        "google-meet",
      );
    expect(accountsWhileDeleteIsPending).toStrictEqual([]);
    deleteRelease.resolve();

    const deleted = await accept(deletion, [200]);
    expect(deleted.body).toStrictEqual({
      deletedConnectionId: fixture.connectorId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: null,
    });
    expect(fixture.provider.deletedUrls).toHaveLength(1);
    expect(fixture.provider.deletedUrls[0]).toContain(
      `/${subscriptionName}?allowMissing=true`,
    );
    const automations = await accept(
      automationsClient().list({
        headers: authHeaders(fixture.actor),
        params: { workflowId: fixture.workflowId },
      }),
      [200],
    );
    const automation = automations.body[0];
    if (!automation) {
      throw new Error("Expected the Google Meet automation");
    }
    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: automation.id },
      }),
      [204],
    );
  });

  it("promotes a sibling account and repairs after deleting and re-adding accounts", async () => {
    const fixture = await setupFixture();
    await createMeetAutomation(fixture);
    const primarySubscription =
      fixture.provider.accounts.primary.createdNames[0];
    if (!primarySubscription) {
      throw new Error("Expected a primary Google Meet subscription");
    }
    const secondaryConnectorId = await connectGoogleMeet(
      fixture.actor,
      fixture.provider,
      "secondary",
      fixture.agentId,
      { intent: "add", displayName: "Secondary Google Meet" },
    );

    const deletedPrimary = await accept(
      connectorAccountsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { connectionId: fixture.connectorId },
        body: { target: { kind: "builtin", connectorSlug: "google-meet" } },
      }),
      [200],
    );
    expect(deletedPrimary.body).toStrictEqual({
      deletedConnectionId: fixture.connectorId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: secondaryConnectorId,
    });
    const secondarySubscription =
      fixture.provider.accounts.secondary.createdNames[0];
    if (!secondarySubscription) {
      throw new Error("Expected a promoted-account subscription");
    }
    expect(fixture.provider.accounts.primary.deletedUrls).toHaveLength(1);

    const delayedPrimary = await postWorkspaceEvent(primarySubscription);
    expect(delayedPrimary.status).toBe(200);
    await expect(delayedPrimary.json()).resolves.toMatchObject({
      watchStates: 0,
      dispatched: 0,
    });
    const promotedPush = await postWorkspaceEvent(secondarySubscription);
    expect(promotedPush.status).toBe(200);
    await expect(promotedPush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });

    const deletedLast = await accept(
      connectorAccountsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { connectionId: secondaryConnectorId },
        body: { target: { kind: "builtin", connectorSlug: "google-meet" } },
      }),
      [200],
    );
    expect(deletedLast.body).toStrictEqual({
      deletedConnectionId: secondaryConnectorId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: null,
    });
    expect(fixture.provider.accounts.secondary.deletedUrls).toHaveLength(1);

    const readdedConnectorId = await connectGoogleMeet(
      fixture.actor,
      fixture.provider,
      "primary",
      fixture.agentId,
    );
    expect(readdedConnectorId).not.toBe(fixture.connectorId);
    expect(fixture.provider.accounts.primary.createdNames).toHaveLength(2);
    const readdedSubscription =
      fixture.provider.accounts.primary.createdNames[1];
    if (!readdedSubscription) {
      throw new Error("Expected a re-added-account subscription");
    }
    const readdedPush = await postWorkspaceEvent(readdedSubscription);
    expect(readdedPush.status).toBe(200);
    await expect(readdedPush.json()).resolves.toMatchObject({
      watchStates: 1,
      dispatched: 1,
    });
  });

  it("serializes last-consumer cleanup with a concurrent enable", async () => {
    const deleteStarted = createDeferredPromise<void>(context.signal);
    const deleteRelease = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!deleteRelease.settled()) {
        deleteRelease.resolve();
      }
    });
    const fixture = await setupFixture({
      onDelete: async () => {
        deleteStarted.resolve();
        await deleteRelease.promise;
      },
    });
    const active = await createMeetAutomation(fixture);
    const disabled = await createMeetAutomation(fixture, false);

    const disableRequest = automationsClient().disable({
      headers: authHeaders(fixture.actor),
      params: { id: active.body.id },
    });
    await deleteStarted.promise;
    const enableRequest = automationsClient().enable({
      headers: authHeaders(fixture.actor),
      params: { id: disabled.body.id },
    });

    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(fixture.actor),
        params: { workflowId: fixture.workflowId },
      }),
      [200],
    );
    expect(
      listed.body.find((automation) => {
        return automation.id === disabled.body.id;
      })?.enabled,
    ).toBeFalsy();
    expect(fixture.provider.createdNames).toHaveLength(1);
    deleteRelease.resolve();

    await accept(disableRequest, [200]);
    await accept(enableRequest, [200]);
    expect(fixture.provider.createdNames).toHaveLength(2);
    expect(fixture.provider.operations).toStrictEqual([
      `create:${fixture.provider.createdNames[0]}`,
      `delete-start:${fixture.provider.createdNames[0]}`,
      `delete-end:${fixture.provider.createdNames[0]}`,
      `create:${fixture.provider.createdNames[1]}`,
    ]);

    await accept(
      automationsClient().disable({
        headers: authHeaders(fixture.actor),
        params: { id: disabled.body.id },
      }),
      [200],
    );
    expect(fixture.provider.deletedUrls).toHaveLength(2);
    expect(fixture.provider.deletedUrls[1]).toContain(
      `/${fixture.provider.createdNames[1]}?allowMissing=true`,
    );
  });

  it("renews a due subscription while an enabled consumer remains", async () => {
    const fixture = await setupFixture({
      expireTime: new Date(now() + 30 * 60 * 1000).toISOString(),
    });
    const created = await createMeetAutomation(fixture);

    const renewed = await accept(
      renewalClient().renew({
        body: {
          org_id: fixture.actor.orgId,
          user_id: fixture.actor.userId,
        },
      }),
      [200],
    );
    const unchanged = await accept(
      renewalClient().renew({
        body: {
          org_id: fixture.actor.orgId,
          user_id: fixture.actor.userId,
        },
      }),
      [200],
    );
    expect(renewed.body).toMatchObject({
      success: true,
      renewed: 1,
      repaired: 0,
    });
    expect(unchanged.body).toMatchObject({
      success: true,
      renewed: 0,
      repaired: 0,
    });
    expect(fixture.provider.renewCalls).toBe(1);

    await accept(
      automationsClient().delete({
        headers: authHeaders(fixture.actor),
        params: { id: created.body.id },
      }),
      [204],
    );
  });
});
