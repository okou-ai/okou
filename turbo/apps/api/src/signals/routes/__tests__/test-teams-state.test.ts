import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { teamsBotIngressResponseSchema } from "@okouai/api-contracts/contracts/teams-bot";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { teamsConnectRoutes } from "../teams-connect";
import { createBddApi } from "./helpers/api-bdd";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { connectTeamsAccountForTest } from "./helpers/teams-account";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const bdd = createBddApi(context);
const reads = createRunReadsApi(context);
const routes = createRouteMocks(context);
const threadsApi = setupApp({ context, routes: chatThreadRoutes });
const chatThreads = threadsApi(chatThreadsContract);
const teamsConnect = setupApp({ context, routes: teamsConnectRoutes })(
  teamsConnectContract,
);
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });

async function recordTeamsNotice(
  notices: string[],
  request: Request,
): Promise<void> {
  const body = (await request.json()) as {
    readonly text?: string;
    readonly attachments?: readonly {
      readonly contentType: string;
      readonly content: {
        readonly body?: readonly {
          readonly type: string;
          readonly text?: string;
        }[];
      };
    }[];
  };
  if (body.text) {
    notices.push(body.text);
  }
  for (const attachment of body.attachments ?? []) {
    if (attachment.contentType === "application/vnd.microsoft.card.adaptive") {
      for (const item of attachment.content.body ?? []) {
        if (item.type === "TextBlock" && item.text) {
          notices.push(item.text);
        }
      }
    }
  }
}

function configureTeamsHandlers(
  installation: TeamsConnectFixture,
  notices: string[],
): void {
  setupTeamsConnectTestEnv();
  const tokenUrl = "https://teams-auth.test/token";
  const graphTokenUrl = "https://teams-graph-token.okou.test/oauth2/token";
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "teams-app-password");
  mockOptionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL", tokenUrl);
  mockOptionalEnv("MICROSOFT_TEAMS_GRAPH_TOKEN_URL", graphTokenUrl);
  context.mocks.ably.publish.mockResolvedValue(undefined);
  server.use(
    http.post(tokenUrl, () => {
      return HttpResponse.json({
        access_token: "teams-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(graphTokenUrl, () => {
      return HttpResponse.json({
        access_token: "teams-graph-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(
      `https://login.microsoftonline.com/${installation.teamsTenantId}/oauth2/v2.0/token`,
      () => {
        return HttpResponse.json({
          access_token: "teams-graph-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    ),
    http.get(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(installation.teamsAadObjectId)}/teamwork/installedApps`,
      () => {
        return HttpResponse.json({
          value: [
            {
              id: `app-install-${installation.fixtureId}`,
              teamsApp: {
                externalId: "00000000-0000-0000-0000-000000000001",
              },
            },
          ],
        });
      },
    ),
    http.get(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(installation.teamsAadObjectId)}/teamwork/installedApps/app-install-${installation.fixtureId}/chat`,
      () => {
        return HttpResponse.json({
          id: `chat-${installation.fixtureId}`,
          chatType: "oneOnOne",
        });
      },
    ),
    http.get(
      `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(`chat-${installation.fixtureId}`)}/messages`,
      () => {
        return HttpResponse.json({ value: [] });
      },
    ),
    http.get(
      `${installation.serviceUrl}v3/conversations/:conversationId/members/:userId`,
      () => {
        return HttpResponse.json({
          id: installation.teamsUserId,
          tenantId: installation.teamsTenantId,
          aadObjectId: installation.teamsAadObjectId,
        });
      },
    ),
    http.post(`${installation.serviceUrl}v3/conversations`, () => {
      return HttpResponse.json({
        id: `a:welcome-${installation.fixtureId}`,
      });
    }),
    http.post(
      `${installation.serviceUrl}v3/conversations/:conversationId/activities`,
      async ({ request }) => {
        await recordTeamsNotice(notices, request);
        return HttpResponse.json({ id: "typing-activity" });
      },
    ),
    http.post(
      `${installation.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
      async ({ request }) => {
        await recordTeamsNotice(notices, request);
        return HttpResponse.json({ id: "reply-activity" });
      },
    ),
    http.put(
      `${installation.serviceUrl}v3/conversations/:conversationId/activities/:activityId/reactions/:reaction`,
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.delete(
      `${installation.serviceUrl}v3/conversations/:conversationId/activities/:activityId/reactions/:reaction`,
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId",
      () => {
        return HttpResponse.json({
          id: installation.teamsThreadId,
          createdDateTime: "2026-06-30T09:05:00.000Z",
          body: { contentType: "text", content: "Release checklist" },
          from: {
            user: {
              id: installation.teamsAadObjectId,
              displayName: "Ada Lovelace",
            },
          },
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId/replies",
      () => {
        return HttpResponse.json({ value: [] });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages",
      () => {
        return HttpResponse.json({ value: [] });
      },
    ),
    http.get("https://graph.microsoft.com/v1.0/users/:userId", () => {
      return HttpResponse.json({
        id: installation.teamsAadObjectId,
        displayName: "Ada Lovelace",
        userPrincipalName: installation.teamsUserPrincipalName,
        mail: installation.teamsUserPrincipalName,
      });
    }),
  );
}

async function createInstalledTeamsMember(options: {
  readonly onboarded: boolean;
}) {
  const installation = teamsConnectFixture();
  const actor = bdd.user({
    userId: installation.userId,
    orgId: installation.orgId,
  });
  const notices: string[] = [];
  configureTeamsHandlers(installation, notices);
  if (options.onboarded) {
    await bdd.bootstrapLimitedFreeOnboarding(actor);
  }
  await installTeamsForTest(context.signal, installation);
  await connectTeamsAccountForTest(context, installation, {
    displayName: "Teams User",
    learnSender: false,
  });
  await flushWaitUntilForTest();
  return { installation, actor, notices };
}

function authFor(installation: TeamsConnectFixture) {
  routes.clerk.session(installation.userId, installation.orgId, "org:admin");
  return SESSION;
}

async function postPersonalTeamsMessage(
  installation: TeamsConnectFixture,
  text: string,
) {
  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity: teamsMessageActivityForTest(installation, {
      id: "activity-e2e",
      conversation: {
        id: "19:e2e-dm@thread.v2",
        conversationType: "personal",
      },
      channelData: {
        tenant: {
          id: installation.teamsTenantId,
          name: installation.teamsTenantName,
        },
      },
      from: {
        id: installation.teamsUserId,
        name: "Teams User",
        aadObjectId: installation.teamsAadObjectId,
        userPrincipalName: installation.teamsUserPrincipalName,
      },
      text,
      entities: [],
      replyToId: null,
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly ok: boolean;
    readonly activity: {
      readonly kind: string;
      readonly conversationType: string;
      readonly tenantId: string;
      readonly text: string;
    };
    readonly connectUrl: string;
  };
  expect(body).toMatchObject({
    ok: true,
    activity: {
      kind: "message",
      conversationType: "personal",
      tenantId: installation.teamsTenantId,
      text,
    },
  });
  const connectUrl = new URL(body.connectUrl);
  expect(connectUrl.pathname).toBe("/settings/teams");
  expect(connectUrl.searchParams.get("tenantId")).toBe(
    installation.teamsTenantId,
  );
  await flushWaitUntilForTest();
}

async function createChannelMentionThread() {
  const fixture = teamsConnectFixture();
  const notices: string[] = [];
  configureTeamsHandlers(fixture, notices);
  await Promise.all([
    createStore().set(
      seedOrgMembership$,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        role: "admin",
        name: "Teams workspace",
      },
      context.signal,
    ),
    updateFeatureSwitchesForUser(
      context,
      { userId: fixture.userId, orgId: fixture.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.OkouDebug]: true },
    ),
    installTeamsForTest(context.signal, fixture),
  ]);
  await connectTeamsAccountForTest(context, fixture, {
    displayName: "Ada Lovelace",
    learnSender: false,
  });

  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity: teamsMessageActivityForTest(fixture, {
      text: "<at>Nova</at> deploy the preview",
    }),
  });
  expect(response.status).toBe(200);
  teamsBotIngressResponseSchema.parse(await response.json());
  await flushWaitUntilForTest();

  const lifecycle = await accept(
    chatThreads.events({ headers: authFor(fixture), query: {} }),
    [200],
  );
  const createdEvent = lifecycle.body.events.find((event) => {
    return event.kind === "created";
  });
  if (!createdEvent) {
    throw new Error("Expected a created thread lifecycle event");
  }
  return { fixture, chatThreadId: createdEvent.chatThreadId };
}

describe("Teams webhook dispatch", () => {
  it("test-teams-state-003 (1/4) reports installed and connected status for the connected un-onboarded member", async () => {
    const member = await createInstalledTeamsMember({ onboarded: false });

    const status = await accept(
      teamsConnect.getStatus({ headers: authFor(member.installation) }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      tenantId: member.installation.teamsTenantId,
    });
  });

  it("test-teams-state-003 (2/4) reports installed and not connected status after the onboarded member disconnects", async () => {
    const member = await createInstalledTeamsMember({ onboarded: true });
    await accept(
      teamsConnect.disconnect({
        headers: authFor(member.installation),
        query: {},
      }),
      [200],
    );

    const status = await accept(
      teamsConnect.getStatus({ headers: authFor(member.installation) }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
      tenantId: member.installation.teamsTenantId,
    });
  });

  it("test-teams-state-003 (3/4) rejects an unlinked Teams user with a connect notice and keeps the Run list empty", async () => {
    const member = await createInstalledTeamsMember({ onboarded: true });
    await accept(
      teamsConnect.disconnect({
        headers: authFor(member.installation),
        query: {},
      }),
      [200],
    );

    await postPersonalTeamsMessage(
      member.installation,
      "hello while disconnected",
    );
    expect(member.notices).toContain(
      "Please connect your account to use Okou in this Teams workspace.",
    );

    const logs = await reads.requestListLogs(
      member.actor,
      { limit: 20 },
      [200],
    );
    expect(logs.body.data).toStrictEqual([]);
  });

  it("test-teams-state-003 (4/4) dispatches a personal message and creates a thread for a connected member", async () => {
    const member = await createInstalledTeamsMember({ onboarded: false });

    await postPersonalTeamsMessage(
      member.installation,
      "hello from connected teams user",
    );

    const events = await accept(
      chatThreads.events({
        headers: authFor(member.installation),
        query: {},
      }),
      [200],
    );
    expect(
      events.body.events.some((event) => {
        return event.kind === "created";
      }),
    ).toBeTruthy();
  });
});

describe("Teams chat callbacks", () => {
  it("internal-callbacks-teams-010 (1/2) enables cloud browser on the thread created by a Teams bot mention", async () => {
    const { fixture, chatThreadId } = await createChannelMentionThread();

    const metadata = await accept(
      threadsApi(chatThreadMetadataContract).get({
        headers: authFor(fixture),
        params: { id: chatThreadId },
      }),
      [200],
    );
    expect(metadata.body.cloudBrowserEnabled).toBeTruthy();
  });

  it("internal-callbacks-teams-010 (2/2) preserves Teams canonical input with normalized mention text and source link", async () => {
    const { fixture, chatThreadId } = await createChannelMentionThread();

    const events = await readProjectedChatEvents(context, {
      threadId: chatThreadId,
      headers: authFor(fixture),
    });
    const promptEvent = events.find((event) => {
      return event.eventType === "input.prompt";
    });
    if (!promptEvent || promptEvent.eventType !== "input.prompt") {
      throw new Error("Expected an input.prompt event");
    }
    expect(promptEvent.content).toBeNull();
    expect(promptEvent.userMessage.version).toBe(1);
    expect(promptEvent.userMessage.parts).toStrictEqual([
      {
        type: "text",
        text: "@Nova deploy the preview",
      },
      {
        type: "source",
        kind: "teams",
        href: `https://teams.microsoft.com/l/message/${encodeURIComponent(fixture.teamsChannelId)}/${encodeURIComponent(fixture.teamsActivityId)}?tenantId=${encodeURIComponent(fixture.teamsTenantId)}`,
      },
    ]);
  });
});
