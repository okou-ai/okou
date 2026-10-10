import { randomUUID } from "node:crypto";

import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { teamsBotIngressResponseSchema } from "@okouai/api-contracts/contracts/teams-bot";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { onboardingStatusRoutes } from "../onboarding-status";
import { teamsConnectRoutes } from "../teams-connect";
import { userPreferencesRoutes } from "../user-preferences";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import {
  postTeamsActivityForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const runs = createRunsApi(context);
function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function configureTeamsProvider(fixture: TeamsConnectFixture) {
  const deliveries: { readonly url: string; readonly body: unknown }[] = [];
  setupTeamsConnectTestEnv();
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "test-teams-password");
  // Every test database has the managed Auto key, so a member's Teams message
  // launches a real run; give it an executor and storage downloads.
  runs.configureRunnerGroup();
  runs.acceptStorageDownloads();
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.ably.publish.mockResolvedValue(undefined);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: fixture.orgId }, role: "org:admin" }],
    totalCount: 1,
  });
  server.use(
    http.post(
      "https://login.microsoftonline.com/:tenant/oauth2/v2.0/token",
      () => {
        return HttpResponse.json({
          access_token: `teams-token-${fixture.fixtureId}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    ),
    http.post(`${fixture.serviceUrl}v3/conversations`, () => {
      return HttpResponse.json({ id: `welcome-${fixture.fixtureId}` });
    }),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities`,
      async ({ request }) => {
        deliveries.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({ id: randomUUID() });
      },
    ),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
      async ({ request }) => {
        deliveries.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({ id: randomUUID() });
      },
    ),
    http.put(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId/reactions/:reaction`,
      () => {
        return HttpResponse.json({});
      },
    ),
    http.delete(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId/reactions/:reaction`,
      () => {
        return HttpResponse.json({});
      },
    ),
    http.put(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
      () => {
        return HttpResponse.json({ id: randomUUID() });
      },
    ),
    http.delete(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
      () => {
        return HttpResponse.json({});
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps",
      () => {
        return HttpResponse.json({ value: [] });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId?",
      () => {
        return HttpResponse.json(
          { error: { code: "ItemNotFound", message: "No optional history" } },
          { status: 404 },
        );
      },
    ),
  );
  return deliveries;
}

async function postActivity(activity: Record<string, unknown>) {
  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity,
  });
  expect(response.status).toBe(200);
  const body = teamsBotIngressResponseSchema.parse(await response.json());
  await flushWaitUntilForTest();
  return body;
}

async function connect(fixture: TeamsConnectFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  // The signed-in app initializes preferences, which establishes the member's
  // memory before any run can mount it.
  await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers: authHeaders(),
      body: { timezone: "UTC", locale: "en-US" },
    }),
    [200],
  );
  await accept(
    setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    ).connect({
      headers: authHeaders(),
      body: {
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        teamsAadObjectId: fixture.teamsAadObjectId,
      },
    }),
    [200],
  );
}

async function setupTeamsRoute() {
  const fixture = teamsConnectFixture();
  const deliveries = configureTeamsProvider(fixture);
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const app = await setupApp({
    context,
    routes: onboardingStatusRoutes,
    isolatePg: true,
  });
  const onboarding = await accept(
    app(onboardingStatusContract).getStatus({ headers: authHeaders() }),
    [200],
  );
  expect(onboarding.body.hasDefaultAgent).toBeTruthy();
  await postActivity(
    teamsMessageActivityForTest(fixture, {
      type: "installationUpdate",
      action: "add",
    }),
  );
  await connect(fixture);
  return { fixture, deliveries };
}

async function createdThreads(fixture: TeamsConnectFixture) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const events = await accept(
    setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract).events(
      { headers: authHeaders(), query: {} },
    ),
    [200],
  );
  expect(events.body.hasMore).toBeFalsy();
  return events.body.events.filter((event) => {
    return event.kind === "created";
  });
}

async function inputRows(fixture: TeamsConnectFixture, threadId: string) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const result = await accept(
    setupApp({ context, routes: chatThreadRoutes })(
      chatThreadEventsContract,
    ).rows({
      headers: authHeaders(),
      params: { threadId },
      query: { sinceSeqId: 0, limit: 50 },
    }),
    [200],
  );
  expect(result.body.hasMore).toBeFalsy();
  return result.body.rows.filter((row) => {
    return row.eventType === "input.prompt";
  });
}

function message(fixture: TeamsConnectFixture, id: string, text: string) {
  return teamsMessageActivityForTest(fixture, {
    id: `${fixture.fixtureId}-${id}`,
    text: `<at>Nova</at> ${text}`,
  });
}

function onlyThreadId(
  threads: Awaited<ReturnType<typeof createdThreads>>,
): string {
  expect(threads).toHaveLength(1);
  const thread = threads[0];
  if (!thread) {
    throw new Error("Expected the public Teams thread creation event");
  }
  return thread.chatThreadId;
}

describe("Teams route ownership through public ingress", () => {
  it("creates one durable thread and reuses it for distinct and repeated activities", async () => {
    const { fixture } = await setupTeamsRoute();
    await postActivity(message(fixture, "first", "first route message"));
    const firstThreads = await createdThreads(fixture);
    const threadId = onlyThreadId(firstThreads);
    const second = message(fixture, "second", "second route message");
    await postActivity(second);
    await postActivity(second);
    await expect(createdThreads(fixture)).resolves.toStrictEqual(firstThreads);
    const rows = await inputRows(fixture, threadId);
    expect(rows).toHaveLength(2);
    expect(rows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            userMessage: expect.objectContaining({
              parts: expect.arrayContaining([
                { type: "text", text: "@Nova first route message" },
              ]),
            }),
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            userMessage: expect.objectContaining({
              parts: expect.arrayContaining([
                { type: "text", text: "@Nova second route message" },
              ]),
            }),
          }),
        }),
      ]),
    );
  });

  it("keeps the same external channel and thread isolated between connected identities", async () => {
    const { fixture } = await setupTeamsRoute();
    const other = teamsConnectFixture({
      ...fixture,
      userId: `user_other_${fixture.fixtureId}`,
      teamsUserId: `29:other-${fixture.fixtureId}`,
      teamsAadObjectId: `aad-other-${fixture.fixtureId}`,
    });
    await connect(other);
    await postActivity(message(fixture, "owner", "owner message"));
    await postActivity(message(other, "other", "other message"));
    const ownerId = onlyThreadId(await createdThreads(fixture));
    const otherId = onlyThreadId(await createdThreads(other));
    expect(otherId).not.toBe(ownerId);
    await expect(inputRows(fixture, ownerId)).resolves.toHaveLength(1);
    await expect(inputRows(other, otherId)).resolves.toHaveLength(1);
    await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadEventsContract,
      ).rows({
        headers: authHeaders(),
        params: { threadId: ownerId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [404],
    );
  });

  it("reuses a personal thread when Teams changes the conversation destination", async () => {
    const { fixture, deliveries } = await setupTeamsRoute();
    const destination = `personal-new-${fixture.fixtureId}`;
    const personal = (id: string, conversationId: string) => {
      return teamsMessageActivityForTest(fixture, {
        id: `${fixture.fixtureId}-${id}`,
        conversation: { id: conversationId, conversationType: "personal" },
        channelData: {
          tenant: { id: fixture.teamsTenantId },
          teamsAppId: fixture.teamsAppId,
        },
        replyToId: null,
        text: id,
        entities: [],
      });
    };
    await postActivity(
      personal("first personal message", `personal-old-${fixture.fixtureId}`),
    );
    const first = await createdThreads(fixture);
    const threadId = onlyThreadId(first);
    await postActivity(personal("second personal message", destination));
    await expect(createdThreads(fixture)).resolves.toStrictEqual(first);
    const rows = await inputRows(fixture, threadId);
    expect(rows).toHaveLength(2);
    expect(deliveries).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: `${fixture.serviceUrl}v3/conversations/${encodeURIComponent(destination)}/activities/${encodeURIComponent(`${fixture.fixtureId}-second personal message`)}`,
          body: expect.objectContaining({
            type: "message",
            text: expect.any(String),
          }),
        }),
      ]),
    );
  });

  it("converges overlapping public messages onto one thread without losing either input", async () => {
    const { fixture } = await setupTeamsRoute();
    await Promise.all([
      postActivity(message(fixture, "overlap-one", "overlap one")),
      postActivity(message(fixture, "overlap-two", "overlap two")),
    ]);
    const threadId = onlyThreadId(await createdThreads(fixture));
    const rows = await inputRows(fixture, threadId);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).toContain("overlap one");
    expect(JSON.stringify(rows)).toContain("overlap two");
  });
});
