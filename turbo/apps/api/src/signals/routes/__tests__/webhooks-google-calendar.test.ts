import { createHash } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { HttpResponse, http } from "msw";
import { expect, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { clearWorkflowAutomationEventConnectorAsPreviousApi } from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { workflowAutomationsRoutes } from "../workflow-automations";
import {
  clearGoogleCalendarBeforeRunStartHookForTest,
  setGoogleCalendarBeforeRunStartHookForTest,
  webhooksGoogleCalendarRoutes,
} from "../webhooks-google-calendar";

const TEST_APP_ROUTES = Object.freeze([
  ...webhooksGoogleCalendarRoutes,
  ...workflowAutomationsRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

async function completeRunThroughSandbox(
  sandboxToken: string,
  runId: string,
): Promise<void> {
  const sandboxHeaders = { authorization: `Bearer ${sandboxToken}` };
  await webhooksApi.requestAgentComplete(
    {
      runId,
      exitCode: 0,
      checkpoint: {
        cliAgentType: "claude-code",
        cliAgentSessionId: `calendar-webhook-cli-${runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`calendar webhook history ${runId}`)
          .digest("hex"),
      },
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
}

const WORKFLOW_NAME = "calendar-webhook-workflow";
const CALENDAR_EMAIL = "calendar-webhook-user@example.com";

function authHeaders() {
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

interface GoogleCalendarWatchChannel {
  readonly channelId: string;
  readonly channelToken: string;
  readonly resourceId: string;
}

interface GoogleCalendarApiRecorder {
  /** Watch channels registered against the provider, in order. */
  readonly channels: GoogleCalendarWatchChannel[];
  baselineCalls: number;
  incrementalCalls: number;
}

function configureGoogleCalendarApiMock(args: {
  readonly baselineItems?: readonly Record<string, unknown>[];
  readonly incrementalItems?: readonly Record<string, unknown>[];
  readonly incrementalNextSyncToken?: string;
  readonly incrementalResponses?: readonly {
    readonly items: readonly Record<string, unknown>[];
    readonly nextSyncToken: string;
  }[];
}): GoogleCalendarApiRecorder {
  const recorder: GoogleCalendarApiRecorder = {
    channels: [],
    baselineCalls: 0,
    incrementalCalls: 0,
  };
  let incrementalCallCount = 0;
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  server.use(
    http.post(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/watch",
      async ({ request, params }) => {
        expect(params.calendarId).toBe("primary");
        expect(request.headers.get("authorization")).toBe(
          "Bearer calendar-access-token",
        );
        const body = (await request.json()) as {
          readonly id?: string;
          readonly type?: string;
          readonly address?: string;
          readonly token?: string;
          readonly params?: { readonly ttl?: string };
        };
        expect(body).toMatchObject({
          type: "web_hook",
          address: "https://api.okou.ai/api/webhooks/google-calendar",
          params: { ttl: "604800" },
        });
        if (!body.id || !body.token) {
          throw new Error("Expected calendar watch id and token");
        }
        recorder.channels.push({
          channelId: body.id,
          channelToken: body.token,
          resourceId: "calendar-resource-1",
        });
        return HttpResponse.json({
          id: body.id,
          resourceId: "calendar-resource-1",
          resourceUri:
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.get(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
      ({ request, params }) => {
        expect(params.calendarId).toBe("primary");
        expect(request.headers.get("authorization")).toBe(
          "Bearer calendar-access-token",
        );
        const url = new URL(request.url);
        expect(url.searchParams.get("showDeleted")).toBe("true");
        expect(url.searchParams.get("maxResults")).toBe("2500");
        const syncToken = url.searchParams.get("syncToken");
        if (!syncToken) {
          recorder.baselineCalls += 1;
          return HttpResponse.json({
            items: args.baselineItems ?? [],
            nextSyncToken: "calendar-sync-baseline",
          });
        }
        recorder.incrementalCalls += 1;
        expect(syncToken).toBeTruthy();
        const sequentialResponse =
          args.incrementalResponses?.[
            Math.min(incrementalCallCount, args.incrementalResponses.length - 1)
          ];
        incrementalCallCount += 1;
        if (sequentialResponse) {
          return HttpResponse.json({
            items: sequentialResponse.items,
            nextSyncToken: sequentialResponse.nextSyncToken,
          });
        }
        return HttpResponse.json({
          items: args.incrementalItems ?? [],
          nextSyncToken: args.incrementalNextSyncToken ?? "calendar-sync-next",
        });
      },
    ),
  );
  return recorder;
}

interface AccountAwareGoogleCalendarRecorder {
  readonly channels: (GoogleCalendarWatchChannel & {
    readonly accessToken: string;
  })[];
  readonly baselineAccessTokens: string[];
  readonly incrementalAccessTokens: string[];
  readonly stoppedAccessTokens: string[];
}

function googleCalendarRequestAccessToken(request: Request): string {
  return request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
}

function configureAccountAwareGoogleCalendarApiMock(args: {
  readonly resourcePrefix: string;
  readonly incrementalItems?: (
    accessToken: string,
  ) => readonly Record<string, unknown>[];
  readonly stopStatus?: 204 | 500;
}): AccountAwareGoogleCalendarRecorder {
  const recorder: AccountAwareGoogleCalendarRecorder = {
    channels: [],
    baselineAccessTokens: [],
    incrementalAccessTokens: [],
    stoppedAccessTokens: [],
  };
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  server.use(
    http.post(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events/watch",
      async ({ request, params }) => {
        const accessToken = googleCalendarRequestAccessToken(request);
        const body = (await request.json()) as {
          readonly id?: string;
          readonly token?: string;
        };
        if (!body.id || !body.token || typeof params.calendarId !== "string") {
          throw new Error(
            "Expected Calendar watch target and channel identity",
          );
        }
        const resourceId = `${args.resourcePrefix}-${recorder.channels.length + 1}`;
        recorder.channels.push({
          channelId: body.id,
          channelToken: body.token,
          resourceId,
          accessToken,
        });
        return HttpResponse.json({
          id: body.id,
          resourceId,
          resourceUri: `https://www.googleapis.com/calendar/v3/calendars/${params.calendarId}/events`,
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.get(
      "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events",
      ({ request }) => {
        const accessToken = googleCalendarRequestAccessToken(request);
        const syncToken = new URL(request.url).searchParams.get("syncToken");
        if (!syncToken) {
          recorder.baselineAccessTokens.push(accessToken);
          return HttpResponse.json({
            items: [],
            nextSyncToken: `${args.resourcePrefix}-baseline-${accessToken}`,
          });
        }
        recorder.incrementalAccessTokens.push(accessToken);
        return HttpResponse.json({
          items: args.incrementalItems?.(accessToken) ?? [],
          nextSyncToken: `${args.resourcePrefix}-next-${accessToken}`,
        });
      },
    ),
    http.post(
      "https://www.googleapis.com/calendar/v3/channels/stop",
      ({ request }) => {
        recorder.stoppedAccessTokens.push(
          googleCalendarRequestAccessToken(request),
        );
        return args.stopStatus === 500
          ? HttpResponse.json({ error: "retain channel" }, { status: 500 })
          : new HttpResponse(null, { status: 204 });
      },
    ),
  );
  return recorder;
}

interface CalendarScenario {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly runnerGroup: string;
  readonly workflowId: string;
}

async function setupFixture(): Promise<CalendarScenario> {
  const runnerGroup = runsApi.configureRunnerGroup();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  const { actor } = await wf.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  const agent = await wf.createAgent(actor, {
    displayName: "Calendar Webhook Agent",
  });
  const workflowId = await wf.createWorkflow(actor, {
    agentId: agent.agentId,
    name: WORKFLOW_NAME,
  });
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
  context.mocks.s3.send.mockResolvedValue({});
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId: agent.agentId,
    runnerGroup,
    workflowId,
  };
}

async function expectAutomationDisplayMessage(
  threadId: string,
  expectedMessage: string,
): Promise<void> {
  const events = await wf.readThreadEvents(threadId);
  const visibleEvent = events.find((event) => {
    return (
      event.eventType === "input.automation" ||
      event.eventType === "input.prompt"
    );
  });
  if (!visibleEvent) {
    throw new Error("Expected a visible calendar automation event");
  }
  expect(chatEventDisplayText(visibleEvent)).toBe(expectedMessage);
}

async function connectGoogleCalendar(
  scenario: CalendarScenario,
): Promise<void> {
  mockGoogleCalendarConnectorOAuth({ email: CALENDAR_EMAIL });
  await wf.connectConnector(scenario.actor, "google-calendar");
  if (!scenario.actor.orgId) {
    throw new Error("Expected an org-scoped workflow actor");
  }
  mocks.clerk.session(
    scenario.actor.userId,
    scenario.actor.orgId,
    "org:member",
  );
}

async function addGoogleCalendarAccount(
  scenario: CalendarScenario,
  args: {
    readonly accessToken: string;
    readonly email: string;
    readonly subject: string;
  },
): Promise<string> {
  mockGoogleCalendarConnectorOAuth(args);
  const start = await connectorsApi.startOauth(
    scenario.actor,
    "google-calendar",
    "oauth",
    scenario.agentId,
    { intent: "add", displayName: args.email },
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Google Calendar OAuth state");
  }
  await connectorsApi.completeOauthCallback("google-calendar", {
    code: "google-calendar-second-code",
    state,
  });
  const accounts = await connectorsApi.listBuiltinConnectorAccounts(
    scenario.actor,
    "google-calendar",
  );
  const account = accounts.find((candidate) => {
    return candidate.externalEmail === args.email;
  });
  if (!account) {
    throw new Error("Expected the added Google Calendar account");
  }
  return account.id;
}

async function postGoogleCalendarWebhook(
  headers: NonNullable<RequestInit["headers"]>,
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request("/api/webhooks/google-calendar", {
    method: "POST",
    headers,
    body: "",
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function webhookHeaders(
  state: GoogleCalendarWatchChannel,
  overrides?: Record<string, string>,
): Record<string, string> {
  return {
    "x-goog-channel-id": state.channelId,
    "x-goog-channel-token": state.channelToken,
    "x-goog-resource-id": state.resourceId,
    "x-goog-resource-state": "exists",
    "x-goog-message-number": "2",
    ...overrides,
  };
}

describe("POST /api/webhooks/google-calendar", () => {
  it("short-circuits before Calendar event reads when no consumer remains", async () => {
    const recorder = configureGoogleCalendarApiMock({});
    server.use(
      http.post("https://www.googleapis.com/calendar/v3/channels/stop", () => {
        return HttpResponse.json({ error: "stop failed" }, { status: 500 });
      }),
    );
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );
    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );

    const response = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    expect(recorder.baselineCalls).toBe(1);
    expect(recorder.incrementalCalls).toBe(0);

    server.use(
      http.post("https://www.googleapis.com/calendar/v3/channels/stop", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [204],
    );
  });

  it("acknowledges events without dispatching after Calendar access becomes unavailable", async () => {
    const startedAt = Date.parse("2026-09-02T00:00:00.000Z");
    mockNow(startedAt);
    const recorder = configureGoogleCalendarApiMock({});
    const scenario = await setupFixture();
    await connectGoogleCalendar(scenario);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );
    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    let refreshCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        refreshCalls += 1;
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }),
    );
    mockNow(startedAt + 2 * 60 * 60 * 1000);
    context.mocks.sentry.captureException.mockClear();

    for (const messageNumber of ["2", "3"]) {
      const response = await postGoogleCalendarWebhook(
        webhookHeaders(watch, { "x-goog-message-number": messageNumber }),
      );
      expect(response).toStrictEqual({
        status: 200,
        body: {
          success: true,
          watchStates: 1,
          dispatched: 0,
          duplicates: 0,
        },
      });
    }

    expect(refreshCalls).toBe(1);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    await expect(
      connectorsApi.readConnectorBySlug(scenario.actor, "google-calendar"),
    ).resolves.toMatchObject({
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    });
    await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [200],
    );

    mockNow(startedAt);
    server.use(
      http.post("https://www.googleapis.com/calendar/v3/channels/stop", () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await connectGoogleCalendar(scenario);
    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: created.body.id },
      }),
      [204],
    );
  });

  it("dispatches newly created calendar events and de-duplicates retries", async () => {
    const recorder = configureGoogleCalendarApiMock({
      incrementalItems: [
        {
          id: "event-created-1",
          etag: '"created-etag"',
          status: "confirmed",
          summary: "Planning",
          htmlLink: "https://calendar.google.com/event?eid=1",
          created: "2026-06-29T01:00:00.000Z",
          updated: "2026-06-29T01:00:00.000Z",
          start: { dateTime: "2026-06-30T09:00:00-07:00" },
          end: { dateTime: "2026-06-30T09:30:00-07:00" },
          organizer: { email: CALENDAR_EMAIL, self: true },
        },
      ],
    });

    const scenario = await setupFixture();
    const { runnerGroup, workflowId } = scenario;
    await updateFeatureSwitchesForUser(context, scenario.actor, {});
    await connectGoogleCalendar(scenario);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const first = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    if (!created.body.chatThreadId) {
      throw new Error("Expected the automation to have a chat thread");
    }
    await expectAutomationDisplayMessage(
      created.body.chatThreadId,
      'Google Calendar event "Planning" was created.',
    );
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(),
        params: { id: created.body.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
    await runsApi.heartbeatRunner(runnerGroup);
    const firstJob = await runsApi.pollRunner(runnerGroup);
    expect(firstJob.body.job?.runId).toStrictEqual(expect.any(String));
    const firstRunId = firstJob.body.job!.runId;
    await runsApi.claimRunnerJob(firstRunId);

    // A redelivery for the same event revision dispatches nothing and no new
    // runner job appears.
    const second = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    const idleAfterDuplicate = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterDuplicate.body.job).toBeNull();
  });

  it("repairs a legacy projection and dispatches only from the selected Calendar account", async () => {
    const firstAccessToken = "calendar-first-access-token";
    const secondAccessToken = "calendar-second-access-token";
    const calendar = configureAccountAwareGoogleCalendarApiMock({
      resourcePrefix: "calendar-selected",
      stopStatus: 500,
      incrementalItems: (accessToken) => {
        return accessToken === secondAccessToken
          ? [
              {
                id: "selected-account-event",
                etag: '"selected-account-version"',
                status: "confirmed",
                summary: "Selected account event",
                created: "2026-08-01T09:00:00.000Z",
                updated: "2026-08-01T09:00:00.000Z",
              },
            ]
          : [];
      },
    });

    const scenario = await setupFixture();
    await updateFeatureSwitchesForUser(context, scenario.actor, {});
    mockGoogleCalendarConnectorOAuth({
      accessToken: firstAccessToken,
      email: "calendar-first@example.com",
      subject: "calendar-first-subject",
    });
    await wf.connectConnector(scenario.actor, "google-calendar");
    const secondConnectorId = await addGoogleCalendarAccount(scenario, {
      accessToken: secondAccessToken,
      email: "calendar-second@example.com",
      subject: "calendar-second-subject",
    });

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );
    const chatThreadId = created.body.chatThreadId;
    if (!chatThreadId) {
      throw new Error("Expected the Calendar automation thread");
    }
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(),
        params: { id: chatThreadId },
        body: {
          connectionId: secondConnectorId,
          target: { kind: "builtin", connectorSlug: "google-calendar" },
        },
      }),
      [200],
    );
    await clearWorkflowAutomationEventConnectorAsPreviousApi(
      context,
      created.body.id,
    );

    const firstWatch = calendar.channels.find((channel) => {
      return channel.accessToken === firstAccessToken;
    });
    const secondWatch = calendar.channels.find((channel) => {
      return channel.accessToken === secondAccessToken;
    });
    if (!firstWatch || !secondWatch) {
      throw new Error("Expected one watch for each Calendar account");
    }

    const oldSource = await postGoogleCalendarWebhook(
      webhookHeaders(firstWatch),
    );
    expect(oldSource).toStrictEqual({
      status: 200,
      body: {
        success: true,
        watchStates: 1,
        dispatched: 0,
        duplicates: 0,
      },
    });
    expect(calendar.incrementalAccessTokens).toStrictEqual([]);

    const selectedSource = await postGoogleCalendarWebhook(
      webhookHeaders(secondWatch),
    );
    expect(selectedSource).toStrictEqual({
      status: 200,
      body: {
        success: true,
        watchStates: 1,
        dispatched: 1,
        duplicates: 0,
      },
    });
    expect(calendar.incrementalAccessTokens).toStrictEqual([secondAccessToken]);

    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const job = await runsApi.pollRunner(scenario.runnerGroup);
    if (!job.body.job) {
      throw new Error("Expected a selected-account Calendar run");
    }
    const claim = await runsApi.claimRunnerJob(job.body.job.runId);
    expect(
      Object.values(claim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(expect.objectContaining({ sourceId: secondConnectorId }));
  });

  it("supersedes an old Calendar source when account selection changes at queue admission", async () => {
    const firstAccessToken = "calendar-admission-first-token";
    const secondAccessToken = "calendar-admission-second-token";
    const calendar = configureAccountAwareGoogleCalendarApiMock({
      resourcePrefix: "calendar-admission",
      stopStatus: 500,
      incrementalItems: () => {
        return [
          {
            id: "calendar-admission-event",
            etag: '"calendar-admission-version"',
            status: "confirmed",
            summary: "Admission race",
            created: "2026-08-01T10:00:00.000Z",
            updated: "2026-08-01T10:00:00.000Z",
          },
        ];
      },
    });

    const scenario = await setupFixture();
    await updateFeatureSwitchesForUser(context, scenario.actor, {});
    mockGoogleCalendarConnectorOAuth({
      accessToken: firstAccessToken,
      email: "calendar-admission-first@example.com",
      subject: "calendar-admission-first-subject",
    });
    await wf.connectConnector(scenario.actor, "google-calendar");
    const secondConnectorId = await addGoogleCalendarAccount(scenario, {
      accessToken: secondAccessToken,
      email: "calendar-admission-second@example.com",
      subject: "calendar-admission-second-subject",
    });
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );
    const admissionChatThreadId = created.body.chatThreadId;
    if (!admissionChatThreadId) {
      throw new Error("Expected the Calendar automation thread");
    }
    const firstWatch = calendar.channels.find((channel) => {
      return channel.accessToken === firstAccessToken;
    });
    if (!firstWatch) {
      throw new Error("Expected the initial Calendar watch");
    }

    onTestFinished(() => {
      clearGoogleCalendarBeforeRunStartHookForTest();
    });
    setGoogleCalendarBeforeRunStartHookForTest(async () => {
      clearGoogleCalendarBeforeRunStartHookForTest();
      await accept(
        chatThreadConnectorSelectionsClient().update({
          headers: authHeaders(),
          params: { id: admissionChatThreadId },
          body: {
            connectionId: secondConnectorId,
            target: { kind: "builtin", connectorSlug: "google-calendar" },
          },
        }),
        [200],
      );
    });

    const response = await postGoogleCalendarWebhook(
      webhookHeaders(firstWatch),
    );

    expect(response).toStrictEqual({
      status: 200,
      body: {
        success: true,
        watchStates: 1,
        dispatched: 0,
        duplicates: 0,
      },
    });
    expect(calendar.incrementalAccessTokens).toStrictEqual([firstAccessToken]);
    expect(
      calendar.channels.some((channel) => {
        return channel.accessToken === secondAccessToken;
      }),
    ).toBeTruthy();
    await runsApi.heartbeatRunner(scenario.runnerGroup);
    const idle = await runsApi.pollRunner(scenario.runnerGroup);
    expect(idle.body.job).toBeNull();
  });

  it("reconciles Calendar watches across default deletion and first-account re-add", async () => {
    const firstAccessToken = "calendar-lifecycle-first-token";
    const secondAccessToken = "calendar-lifecycle-second-token";
    const thirdAccessToken = "calendar-lifecycle-third-token";
    const calendar = configureAccountAwareGoogleCalendarApiMock({
      resourcePrefix: "calendar-lifecycle",
    });

    const scenario = await setupFixture();
    await updateFeatureSwitchesForUser(context, scenario.actor, {});
    mockGoogleCalendarConnectorOAuth({
      accessToken: firstAccessToken,
      email: "calendar-lifecycle-first@example.com",
      subject: "calendar-lifecycle-first-subject",
    });
    await wf.connectConnector(scenario.actor, "google-calendar");
    const initialAccounts = await connectorsApi.listBuiltinConnectorAccounts(
      scenario.actor,
      "google-calendar",
    );
    const firstAccount = initialAccounts[0];
    if (!firstAccount) {
      throw new Error("Expected the first Calendar account");
    }
    const secondConnectorId = await addGoogleCalendarAccount(scenario, {
      accessToken: secondAccessToken,
      email: "calendar-lifecycle-second@example.com",
      subject: "calendar-lifecycle-second-subject",
    });
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );
    const firstWatch = calendar.channels[0];
    if (!firstWatch) {
      throw new Error("Expected the first Calendar watch");
    }

    await connectorsApi.setDefaultBuiltinConnectorAccount(
      scenario.actor,
      "google-calendar",
      secondConnectorId,
    );
    await connectorsApi.deleteBuiltinConnectorAccount(
      scenario.actor,
      "google-calendar",
      secondConnectorId,
    );
    const accountsAfterDefaultDeletion =
      await connectorsApi.listBuiltinConnectorAccounts(
        scenario.actor,
        "google-calendar",
      );
    expect(accountsAfterDefaultDeletion).toMatchObject([
      { id: firstAccount.id, isDefault: true },
    ]);
    await connectorsApi.deleteBuiltinConnectorAccount(
      scenario.actor,
      "google-calendar",
      firstAccount.id,
    );

    mockGoogleCalendarConnectorOAuth({
      accessToken: thirdAccessToken,
      email: "calendar-lifecycle-third@example.com",
      subject: "calendar-lifecycle-third-subject",
    });
    await wf.connectConnector(scenario.actor, "google-calendar");

    expect(
      calendar.channels.map((channel) => {
        return channel.accessToken;
      }),
    ).toStrictEqual([
      firstAccessToken,
      secondAccessToken,
      firstAccessToken,
      thirdAccessToken,
    ]);
    expect(calendar.baselineAccessTokens).toStrictEqual([
      firstAccessToken,
      secondAccessToken,
      firstAccessToken,
      thirdAccessToken,
    ]);
    expect(calendar.stoppedAccessTokens).toStrictEqual([
      firstAccessToken,
      secondAccessToken,
      firstAccessToken,
    ]);
    await expect(
      postGoogleCalendarWebhook(webhookHeaders(firstWatch)),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("switches Calendar principal accounts and stops the captured old channel", async () => {
    const firstAccessToken = "calendar-principal-first-token";
    const refreshedAccessToken = "calendar-principal-refreshed-token";
    const replacementAccessToken = "calendar-principal-replacement-token";
    const calendar = configureAccountAwareGoogleCalendarApiMock({
      resourcePrefix: "calendar-principal",
    });
    const scenario = await setupFixture();

    mockGoogleCalendarConnectorOAuth({
      accessToken: firstAccessToken,
      email: "calendar-principal-first@example.com",
      subject: "calendar-principal-first-subject",
    });
    await wf.connectConnector(scenario.actor, "google-calendar");
    const initialConnection = await connectorsApi.readConnectorBySlug(
      scenario.actor,
      "google-calendar",
    );
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );
    const oldChannel = calendar.channels[0];
    if (!oldChannel) {
      throw new Error("Expected the initial Calendar channel");
    }

    mockGoogleCalendarConnectorOAuth({
      accessToken: refreshedAccessToken,
      email: "calendar-principal-renamed@example.com",
      subject: "calendar-principal-first-subject",
    });
    const reconnect = await connectorsApi.startOauth(
      scenario.actor,
      "google-calendar",
      "oauth",
      scenario.agentId,
      { intent: "reconnect", connectionId: initialConnection.id },
    );
    const reconnectState = new URL(reconnect.authorizationUrl).searchParams.get(
      "state",
    );
    if (!reconnectState) {
      throw new Error("Expected Calendar reconnect OAuth state");
    }
    await connectorsApi.completeOauthCallback("google-calendar", {
      code: "google-calendar-same-principal-code",
      state: reconnectState,
    });
    expect(calendar.channels).toHaveLength(1);
    expect(calendar.stoppedAccessTokens).toStrictEqual([]);

    mockGoogleCalendarConnectorOAuth({
      accessToken: replacementAccessToken,
      email: "calendar-principal-replacement@example.com",
      subject: "calendar-principal-replacement-subject",
    });
    await wf.connectConnector(scenario.actor, "google-calendar");

    const replacementAccount = (
      await connectorsApi.listBuiltinConnectorAccounts(
        scenario.actor,
        "google-calendar",
      )
    ).find((account) => {
      return account.externalId === "calendar-principal-replacement-subject";
    });
    if (!replacementAccount) {
      throw new Error("Expected the replacement Calendar account");
    }
    await connectorsApi.deleteBuiltinConnectorAccount(
      scenario.actor,
      "google-calendar",
      initialConnection.id,
    );

    const replacementConnection = await connectorsApi.readConnectorBySlug(
      scenario.actor,
      "google-calendar",
    );
    expect(replacementConnection).toMatchObject({
      id: replacementAccount.id,
      externalId: "calendar-principal-replacement-subject",
    });
    expect(
      calendar.channels.map((channel) => {
        return channel.accessToken;
      }),
    ).toStrictEqual([firstAccessToken, replacementAccessToken]);
    expect(calendar.stoppedAccessTokens).toStrictEqual([refreshedAccessToken]);
    await expect(
      postGoogleCalendarWebhook(webhookHeaders(oldChannel)),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("finishes captured Calendar channel cleanup after request cancellation", async () => {
    const accessToken = "calendar-cleanup-abort-token";
    const calendar = configureAccountAwareGoogleCalendarApiMock({
      resourcePrefix: "calendar-cleanup-abort",
    });
    const scenario = await setupFixture();
    await updateFeatureSwitchesForUser(context, scenario.actor, {});

    mockGoogleCalendarConnectorOAuth({
      accessToken,
      email: "calendar-cleanup-abort@example.com",
      subject: "calendar-cleanup-abort-subject",
    });
    await wf.connectConnector(scenario.actor, "google-calendar");
    const connection = await connectorsApi.readConnectorBySlug(
      scenario.actor,
      "google-calendar",
    );
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-updated",
          eventConfig: {
            provider: "google-calendar",
            event: "event_updated",
            calendarId: "team-calendar@example.com",
          },
        },
      }),
      [201],
    );
    expect(calendar.channels).toHaveLength(2);

    const requestController = new AbortController();
    const stoppedChannelIds: string[] = [];
    server.use(
      http.post(
        "https://www.googleapis.com/calendar/v3/channels/stop",
        async ({ request }) => {
          const body = (await request.json()) as { readonly id?: string };
          if (!body.id) {
            throw new Error("Expected a Calendar channel id");
          }
          stoppedChannelIds.push(body.id);
          if (stoppedChannelIds.length === 1) {
            const error = new Error("request cancelled during channel cleanup");
            error.name = "AbortError";
            requestController.abort(error);
          }
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const accountClient = setupApp({
      context,
      routes: connectorAccountRoutes,
      signal: requestController.signal,
    })(connectorAccountsContract);

    await expect(
      accountClient.delete({
        headers: authHeaders(),
        params: { connectionId: connection.id },
        body: {
          target: { kind: "builtin", connectorSlug: "google-calendar" },
        },
      }),
    ).rejects.toThrow("Unknown response status 500");
    expect(new Set(stoppedChannelIds)).toStrictEqual(
      new Set(
        calendar.channels.map((channel) => {
          return channel.channelId;
        }),
      ),
    );
    await expect(
      connectorsApi.listBuiltinConnectorAccounts(
        scenario.actor,
        "google-calendar",
      ),
    ).resolves.toStrictEqual([]);
  });

  it("ignores updated and cancelled calendar events", async () => {
    const recorder = configureGoogleCalendarApiMock({
      baselineItems: [
        {
          id: "event-existing",
          etag: '"existing-etag"',
          status: "confirmed",
          summary: "Existing",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-01T00:00:00.000Z",
        },
      ],
      incrementalItems: [
        {
          id: "event-existing",
          etag: '"updated-etag"',
          status: "confirmed",
          summary: "Existing updated",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-29T01:00:00.000Z",
        },
        {
          id: "event-cancelled",
          status: "cancelled",
          created: "2026-06-29T01:00:00.000Z",
          updated: "2026-06-29T01:00:00.000Z",
        },
      ],
    });

    const scenario = await setupFixture();
    const { runnerGroup, workflowId } = scenario;
    await connectGoogleCalendar(scenario);

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const response = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    await runsApi.heartbeatRunner(runnerGroup);
    const idle = await runsApi.pollRunner(runnerGroup);
    expect(idle.body.job).toBeNull();
  });

  it("dispatches updated calendar events once per event revision", async () => {
    const recorder = configureGoogleCalendarApiMock({
      baselineItems: [
        {
          id: "event-existing",
          etag: '"existing-etag-1"',
          status: "confirmed",
          summary: "Existing",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-01T00:00:00.000Z",
        },
      ],
      incrementalResponses: [
        {
          items: [
            {
              id: "event-existing",
              etag: '"existing-etag-2"',
              status: "confirmed",
              summary: "Existing updated",
              created: "2026-06-01T00:00:00.000Z",
              updated: "2026-06-29T01:00:00.000Z",
            },
          ],
          nextSyncToken: "calendar-sync-updated-1",
        },
        {
          items: [
            {
              id: "event-existing",
              etag: '"existing-etag-2"',
              status: "confirmed",
              summary: "Existing updated",
              created: "2026-06-01T00:00:00.000Z",
              updated: "2026-06-29T01:00:00.000Z",
            },
          ],
          nextSyncToken: "calendar-sync-updated-2",
        },
        {
          items: [
            {
              id: "event-existing",
              etag: '"existing-etag-3"',
              status: "confirmed",
              summary: "Existing updated again",
              created: "2026-06-01T00:00:00.000Z",
              updated: "2026-06-29T02:00:00.000Z",
            },
          ],
          nextSyncToken: "calendar-sync-updated-3",
        },
      ],
    });

    const scenario = await setupFixture();
    const { runnerGroup, workflowId } = scenario;
    await connectGoogleCalendar(scenario);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-updated",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const first = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    if (!created.body.chatThreadId) {
      throw new Error("Expected the automation to have a chat thread");
    }
    await expectAutomationDisplayMessage(
      created.body.chatThreadId,
      'Google Calendar event "Existing updated" was updated.',
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const firstJob = await runsApi.pollRunner(runnerGroup);
    expect(firstJob.body.job?.runId).toStrictEqual(expect.any(String));
    const firstClaim = await runsApi.claimRunnerJob(firstJob.body.job!.runId);

    // The same revision (same etag) arriving again dispatches nothing.
    const second = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    const idleAfterSameRevision = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterSameRevision.body.job).toBeNull();

    // Finish the first run so the workflow queue can dispatch the next event.
    await completeRunThroughSandbox(
      firstClaim.sandboxToken,
      firstJob.body.job!.runId,
    );

    // A new revision (new etag) dispatches exactly one more run.
    const third = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(third.status).toBe(200);
    expect(third.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    const thirdJob = await runsApi.pollRunner(runnerGroup);
    expect(thirdJob.body.job?.runId).toStrictEqual(expect.any(String));
    expect(thirdJob.body.job?.runId).not.toBe(firstJob.body.job?.runId);
    await runsApi.claimRunnerJob(thirdJob.body.job!.runId);
    const idleAfterThird = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterThird.body.job).toBeNull();
  });

  it("dispatches cancelled calendar events and de-duplicates minimal deleted payloads", async () => {
    const recorder = configureGoogleCalendarApiMock({
      baselineItems: [
        {
          id: "event-existing",
          etag: '"existing-etag"',
          status: "confirmed",
          summary: "Existing",
          created: "2026-06-01T00:00:00.000Z",
          updated: "2026-06-01T00:00:00.000Z",
        },
      ],
      incrementalResponses: [
        {
          items: [
            {
              id: "event-existing",
              status: "cancelled",
            },
          ],
          nextSyncToken: "calendar-sync-cancelled-1",
        },
        {
          items: [
            {
              id: "event-existing",
              status: "cancelled",
            },
          ],
          nextSyncToken: "calendar-sync-cancelled-2",
        },
      ],
    });

    const scenario = await setupFixture();
    const { runnerGroup, workflowId } = scenario;
    await connectGoogleCalendar(scenario);
    const cancelled = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-cancelled",
        },
      }),
      [201],
    );
    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-updated",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const first = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(first.status).toBe(200);
    expect(first.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 1,
      duplicates: 0,
    });
    if (!cancelled.body.chatThreadId) {
      throw new Error("Expected the automation to have a chat thread");
    }
    await expectAutomationDisplayMessage(
      cancelled.body.chatThreadId,
      "A Google Calendar event was cancelled.",
    );
    // Only the cancelled automation dispatched a run; the minimal deleted
    // payload never reaches the updated automation.
    await runsApi.heartbeatRunner(runnerGroup);
    const firstJob = await runsApi.pollRunner(runnerGroup);
    expect(firstJob.body.job?.runId).toStrictEqual(expect.any(String));
    await runsApi.claimRunnerJob(firstJob.body.job!.runId);
    const idleAfterFirst = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterFirst.body.job).toBeNull();

    const second = await postGoogleCalendarWebhook(webhookHeaders(watch));

    expect(second.status).toBe(200);
    expect(second.body).toStrictEqual({
      success: true,
      watchStates: 1,
      dispatched: 0,
      duplicates: 0,
    });
    const idleAfterSecond = await runsApi.pollRunner(runnerGroup);
    expect(idleAfterSecond.body.job).toBeNull();
  });

  it("rejects webhook notifications with the wrong channel token", async () => {
    const recorder = configureGoogleCalendarApiMock({});

    const scenario = await setupFixture();
    const { workflowId } = scenario;
    await connectGoogleCalendar(scenario);

    await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "google-calendar-event-created",
        },
      }),
      [201],
    );

    const watch = recorder.channels[0];
    if (!watch) {
      throw new Error("Expected a registered Google Calendar watch channel");
    }

    const response = await postGoogleCalendarWebhook(
      webhookHeaders(watch, { "x-goog-channel-token": "wrong-token" }),
    );

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({ error: "Unauthorized" });
  });
});
