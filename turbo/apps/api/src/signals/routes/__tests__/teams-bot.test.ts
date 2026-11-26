import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

import {
  teamsBotContract,
  teamsBotIngressResponseSchema,
} from "@okouai/api-contracts/contracts/teams-bot";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { teamsBotRoutes } from "../teams-bot";
import { teamsConnectRoutes } from "../teams-connect";
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

const SESSION = { authorization: "Bearer clerk-session" };
const BOT_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_BOT_APP_ID = "99999999-9999-9999-9999-999999999999";
const BOT_FRAMEWORK_KEYS_URL =
  "https://login.botframework.com/v1/.well-known/keys";

/** A Bot Framework signing key published only for the audience check. */
const botFrameworkKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

interface TeamsSentActivity {
  readonly conversationId: string;
  readonly replyTo: string | null;
  readonly body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paramString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Teams' Bot Framework connector records every activity the bot sends. */
function recordTeamsDeliveries(
  fixture: TeamsConnectFixture,
): TeamsSentActivity[] {
  const sent: TeamsSentActivity[] = [];
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", randomUUID());
  server.use(
    http.post(
      `https://login.microsoftonline.com/${BOT_APP_TENANT_ID}/oauth2/v2.0/token`,
      () => {
        return HttpResponse.json({
          access_token: "teams-bot-access-token",
          expires_in: 3600,
        });
      },
    ),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId?`,
      async ({ request, params }) => {
        const body: unknown = await request.json();
        sent.push({
          conversationId: paramString(params.conversationId) ?? "",
          replyTo: paramString(params.activityId),
          body: isRecord(body) ? body : {},
        });
        return HttpResponse.json({ id: `sent-${sent.length}` });
      },
    ),
  );
  return sent;
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

async function readTeamsStatus(fixture: TeamsConnectFixture) {
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  const response = await accept(
    setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    ).getStatus({ headers: SESSION }),
    [200],
  );
  return response.body;
}

function channelData(fixture: TeamsConnectFixture) {
  return {
    tenant: { id: fixture.teamsTenantId, name: fixture.teamsTenantName },
    team: {
      id: fixture.teamsTeamId,
      aadGroupId: fixture.teamsTeamAadGroupId,
      name: fixture.teamsTeamName,
    },
    channel: { id: fixture.teamsChannelId, name: "General" },
    teamsAppId: fixture.teamsAppId,
  };
}

function cardOf(activity: TeamsSentActivity): Record<string, unknown> {
  const attachments = activity.body.attachments;
  const first: unknown = Array.isArray(attachments) ? attachments[0] : null;
  if (!isRecord(first) || !isRecord(first.content)) {
    throw new Error("Expected an adaptive card attachment");
  }
  return first.content;
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function botFrameworkToken(audience: string, serviceUrl: string): string {
  const seconds = Math.floor(now() / 1000);
  const signingInput = `${encodeJwtPart({ alg: "RS256", typ: "JWT", kid: "other-audience-key" })}.${encodeJwtPart(
    {
      iss: "https://api.botframework.com",
      aud: audience,
      exp: seconds + 600,
      nbf: seconds - 30,
      serviceurl: serviceUrl,
    },
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(botFrameworkKey.privateKey).toString("base64url")}`;
}

describe("POST /api/webhooks/teams/bot", () => {
  it("teams-bot-015 ignores an unmentioned channel disconnect command", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    await installTeamsForTest(context.signal, fixture);
    const sent = recordTeamsDeliveries(fixture);

    const body = await postActivity(
      teamsMessageActivityForTest(fixture, {
        id: `activity-disconnect-${fixture.fixtureId}`,
        text: "disconnect",
        entities: [],
      }),
    );

    expect(body.activity).toMatchObject({
      kind: "message",
      text: "disconnect",
      mentionsRecipient: false,
    });
    expect(sent).toStrictEqual([]);
  });

  it("teams-bot-006 rejects a Teams token issued for another bot app", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    server.use(
      http.get(
        "https://login.botframework.com/v1/.well-known/openidconfiguration",
        () => {
          return HttpResponse.json({
            issuer: "https://api.botframework.com",
            jwks_uri: BOT_FRAMEWORK_KEYS_URL,
            id_token_signing_alg_values_supported: ["RS256"],
          });
        },
      ),
      http.get(BOT_FRAMEWORK_KEYS_URL, () => {
        return HttpResponse.json({
          keys: [
            {
              ...botFrameworkKey.publicKey.export({ format: "jwk" }),
              kid: "other-audience-key",
              use: "sig",
              alg: "RS256",
              endorsements: ["msteams"],
            },
          ],
        });
      }),
    );

    const response = await accept(
      setupApp({ context, routes: teamsBotRoutes })(teamsBotContract).post({
        body: teamsMessageActivityForTest(fixture),
        extraHeaders: {
          authorization: `Bearer ${botFrameworkToken(OTHER_BOT_APP_ID, fixture.serviceUrl)}`,
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid Teams bot token audience",
      },
    });
  });

  it("teams-bot-007 normalizes a mention from an unconnected sender and offers a connect card", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    await installTeamsForTest(context.signal, fixture);
    const sent = recordTeamsDeliveries(fixture);

    const body = await postActivity(teamsMessageActivityForTest(fixture));

    expect(body.ok).toBeTruthy();
    expect(body.activity).toMatchObject({
      kind: "message",
      tenantId: fixture.teamsTenantId,
      teamId: fixture.teamsTeamId,
      channelId: fixture.teamsChannelId,
      conversationId: fixture.teamsConversationId,
      threadId: fixture.teamsThreadId,
      sender: {
        id: fixture.teamsUserId,
        name: "Ada Lovelace",
        aadObjectId: fixture.teamsAadObjectId,
      },
      recipient: { id: fixture.teamsBotId, name: "Nova" },
      rawText: "<at>Nova</at> deploy the preview",
      text: "deploy the preview",
      mentionsRecipient: true,
      idempotencyKey: `${fixture.teamsConversationId}:message:${fixture.teamsActivityId}`,
    });
    const connectUrl = new URL(body.connectUrl ?? "");
    expect(`${connectUrl.origin}${connectUrl.pathname}`).toBe(
      "https://app.okou.test/settings/teams",
    );
    expect(Object.fromEntries(connectUrl.searchParams)).toMatchObject({
      tenantId: fixture.teamsTenantId,
      teamsUserId: fixture.teamsUserId,
      activityId: fixture.teamsActivityId,
      teamId: fixture.teamsTeamId,
      conversationType: "channel",
      botName: "Nova",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      conversationId: fixture.teamsConversationId,
      replyTo: fixture.teamsActivityId,
    });
    expect(sent[0]?.body.text).toBeUndefined();
    const card = cardOf(
      sent[0] ?? { conversationId: "", replyTo: null, body: {} },
    );
    expect(card.body).toStrictEqual([
      expect.objectContaining({
        text: expect.stringContaining("Please connect your account"),
      }),
    ]);
    expect(card.actions).toStrictEqual([
      {
        type: "Action.OpenUrl",
        title: "Connect",
        url: body.connectUrl,
      },
    ]);

    await connectTeamsAccountForTest(context, fixture, { learnSender: false });
    const status = await readTeamsStatus(fixture);

    expect(status).toMatchObject({
      isInstalled: true,
      isConnected: true,
      tenantId: fixture.teamsTenantId,
    });
  });

  it("teams-bot-011 sends one team welcome across installation and members-added events", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    await installTeamsForTest(context.signal, fixture);
    const sent = recordTeamsDeliveries(fixture);
    const shared = {
      timestamp: "2026-07-14T08:30:00.000Z",
      serviceUrl: fixture.serviceUrl,
      channelId: "msteams",
      conversation: {
        id: fixture.teamsConversationId,
        conversationType: "channel",
      },
      channelData: channelData(fixture),
      from: {
        id: fixture.teamsUserId,
        name: "Ada Lovelace",
        aadObjectId: fixture.teamsAadObjectId,
      },
      recipient: { id: fixture.teamsBotId, name: "Nova" },
    };

    await postActivity({
      ...shared,
      type: "installationUpdate",
      id: `activity-installed-${fixture.fixtureId}`,
      action: "add",
    });
    await postActivity({
      ...shared,
      type: "conversationUpdate",
      id: `activity-members-added-${fixture.fixtureId}`,
      membersAdded: [{ id: fixture.teamsBotId, name: "Nova" }],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      conversationId: fixture.teamsConversationId,
      replyTo: null,
    });
    expect(sent[0]?.body).toMatchObject({
      type: "message",
      textFormat: "markdown",
      text: expect.stringContaining(
        "<at>Ada Lovelace</at> added Nova to this Teams workspace.",
      ),
      entities: [
        {
          type: "mention",
          text: "<at>Ada Lovelace</at>",
          mentioned: { id: fixture.teamsUserId, name: "Ada Lovelace" },
        },
      ],
      channelData: { tenant: { id: fixture.teamsTenantId } },
    });
    expect(sent[0]?.body.replyToId).toBeUndefined();
  });

  it("teams-bot-012 sends a personal welcome when Teams adds the bot in personal scope", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    const sent = recordTeamsDeliveries(fixture);
    const personalConversationId = `a:personal-${fixture.teamsUserId}`;

    await postActivity({
      type: "installationUpdate",
      id: `activity-personal-install-${fixture.fixtureId}`,
      action: "add",
      timestamp: "2026-07-14T08:30:00.000Z",
      serviceUrl: fixture.serviceUrl,
      channelId: "msteams",
      conversation: {
        id: personalConversationId,
        conversationType: "personal",
      },
      channelData: {
        tenant: { id: fixture.teamsTenantId },
        teamsAppId: fixture.teamsAppId,
      },
      from: {
        id: fixture.teamsUserId,
        name: "Ada Lovelace",
        aadObjectId: fixture.teamsAadObjectId,
      },
      recipient: { id: fixture.teamsBotId, name: "Nova" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      conversationId: personalConversationId,
      replyTo: null,
    });
    expect(sent[0]?.body).toMatchObject({
      type: "message",
      textFormat: "markdown",
      text: expect.stringMatching(
        /^Hi, I'm Nova\. I connect Teams conversations to AI agents[\s\S]*Commands: `help`, `connect`, `disconnect`\. Mention `@Nova` with a task or send a DM to work privately\.$/u,
      ),
    });
    expect(sent[0]?.body.entities).toBeUndefined();
    expect(sent[0]?.body.replyToId).toBeUndefined();
  });

  it("teams-bot-013 answers unmentioned help and greeting messages", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    const sent = recordTeamsDeliveries(fixture);
    const groupChatId = `19:group-${fixture.fixtureId}@thread.v2`;
    const messages = [
      { id: `activity-help-${fixture.fixtureId}`, text: "help" },
      { id: `activity-slash-help-${fixture.fixtureId}`, text: "/help" },
      {
        id: `activity-group-help-${fixture.fixtureId}`,
        text: "help",
        conversation: { id: groupChatId, conversationType: "groupChat" },
      },
      { id: `activity-hi-${fixture.fixtureId}`, text: "Hi" },
    ];

    const responses = [];
    for (const message of messages) {
      responses.push(
        await postActivity(
          teamsMessageActivityForTest(fixture, { ...message, entities: [] }),
        ),
      );
    }

    expect(
      sent.map((activity) => {
        return activity.replyTo;
      }),
    ).toStrictEqual(
      messages.map((message) => {
        return message.id;
      }),
    );
    expect(sent[0]?.body.text).toStrictEqual(
      expect.stringContaining("Nova Teams Bot Help"),
    );
    expect(sent[2]).toMatchObject({
      conversationId: groupChatId,
      body: { text: expect.stringContaining("Nova Teams Bot Help") },
    });
    const greetingCard = cardOf(
      sent[3] ?? { conversationId: "", replyTo: null, body: {} },
    );
    expect(greetingCard.actions).toStrictEqual([
      {
        type: "Action.OpenUrl",
        title: "Connect",
        url: responses[3]?.connectUrl,
      },
    ]);
    expect(responses[3]?.connectUrl).toStrictEqual(expect.any(String));
  });

  it("teams-bot-037 removes the bot installation and keeps the connected Teams identity", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    await installTeamsForTest(context.signal, fixture);
    await connectTeamsAccountForTest(context, fixture, { learnSender: false });

    await postActivity({
      type: "conversationUpdate",
      id: `activity-remove-${fixture.fixtureId}`,
      timestamp: "2026-06-30T09:20:00.000Z",
      serviceUrl: fixture.serviceUrl,
      channelId: "msteams",
      conversation: {
        id: fixture.teamsConversationId,
        conversationType: "channel",
      },
      channelData: channelData(fixture),
      recipient: { id: fixture.teamsBotId, name: "Nova" },
      membersRemoved: [{ id: fixture.teamsBotId, name: "Nova" }],
    });
    const status = await readTeamsStatus(fixture);

    expect(status).toMatchObject({
      isInstalled: false,
      isConnected: true,
      pendingInstallation: false,
      isAdmin: true,
      connectUrl: null,
      linkedAccounts: [
        expect.objectContaining({
          teamsAadObjectId: fixture.teamsAadObjectId,
        }),
      ],
    });
    expect(status.installUrl).toStrictEqual(expect.any(String));
  });
});
