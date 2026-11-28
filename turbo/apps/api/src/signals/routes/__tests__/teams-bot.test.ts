import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

import {
  teamsBotContract,
  teamsBotIngressResponseSchema,
} from "@okouai/api-contracts/contracts/teams-bot";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  array,
  object,
  string,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
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
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsFixtureExternalId,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });

/** The only issuer production accepts (`BOT_FRAMEWORK_ISSUER`, lib/teams-bot-auth.ts). */
const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const TOKEN_ALGORITHM = "RS256";

/** Simulated Bot Framework key pair; generated once because RSA generation is slow. */
const botFrameworkSigner = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** Outgoing activity fields, after `TeamsActivityBody` in external/teams-bot-client.ts. */
const botActivityBody = object({
  type: string(),
  text: string().optional(),
  textFormat: string().optional(),
  replyToId: string().optional(),
  entities: array(zUnknown()).optional(),
  attachments: array(
    object({
      contentType: string(),
      content: object({
        body: array(zUnknown()).optional(),
        actions: array(zUnknown()).optional(),
      }),
    }),
  ).optional(),
  channelData: object({
    tenant: object({ id: string() }).optional(),
  }).optional(),
});

/** One activity the bot posted to a Teams conversation through the connector. */
interface BotPost {
  readonly conversation: string;
  /** The activity this post answers; undefined for a new conversation message. */
  readonly inReplyTo: string | undefined;
  readonly activity: zInfer<typeof botActivityBody>;
}

/**
 * Stands in for the Bot Framework connector. Production takes the bot token
 * from `MICROSOFT_TEAMS_BOT_TOKEN_URL` when set and posts to
 * `<serviceUrl>/v3/conversations/<conversation>/activities[/<replyTo>]`
 * (external/teams-bot-client.ts `botTokenUrl`, `teamsConversationActivityUrl`).
 */
function captureBotPosts(fixture: TeamsConnectFixture): readonly BotPost[] {
  const posts: BotPost[] = [];
  const tokenUrl = "https://bot-token.okou.test/oauth2/token";
  const serviceUrl = fixture.serviceUrl.replace(/\/+$/u, "");
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", randomUUID());
  mockOptionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL", tokenUrl);
  server.use(
    http.post(tokenUrl, () => {
      return HttpResponse.json({ access_token: randomUUID() });
    }),
    http.post<{ conversationId: string; activityId?: string }>(
      `${serviceUrl}/v3/conversations/:conversationId/activities/:activityId?`,
      async ({ request, params }) => {
        posts.push({
          conversation: params.conversationId,
          inReplyTo: params.activityId,
          activity: botActivityBody.parse(await request.json()),
        });
        return HttpResponse.json({ id: randomUUID() });
      },
    ),
  );
  return posts;
}

function adaptiveCardOf(post: BotPost | undefined) {
  const content = post?.activity.attachments?.[0]?.content;
  if (!content) {
    throw new Error("Expected the bot post to carry an adaptive card");
  }
  return content;
}

/** Teams delivers `activity` with a valid bot token; the webhook answers 200. */
async function deliverToBot(activity: Record<string, unknown>) {
  const response = await postTeamsActivityForTest({
    signal: context.signal,
    activity,
  });
  expect(response.status).toBe(200);
  const ingress = teamsBotIngressResponseSchema.parse(await response.json());
  await flushWaitUntilForTest();
  return ingress;
}

/** A non-message Teams event in the fixture team conversation, sent by Ada. */
function teamsEvent(
  fixture: TeamsConnectFixture,
  event: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return teamsMessageActivityForTest(fixture, {
    text: undefined,
    entities: undefined,
    replyToId: undefined,
    ...event,
  });
}

/** The admin reads `GET /api/integrations/teams/connect`. */
async function adminTeamsConnection(fixture: TeamsConnectFixture) {
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  const { body } = await accept(
    setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    ).getStatus({ headers: SESSION }),
    [200],
  );
  return body;
}

/**
 * Publishes the simulated key as the Bot Framework signing key. Production
 * reads the OpenID document from `MICROSOFT_TEAMS_BOT_OPENID_METADATA_URL`
 * when set and follows its `jwks_uri` (lib/teams-bot-auth.ts).
 */
function publishBotFrameworkKey(keyId: string): void {
  const openIdUrl = "https://bot-framework.okou.test/openid-configuration";
  const keysUrl = "https://bot-framework.okou.test/signing-keys";
  mockOptionalEnv("MICROSOFT_TEAMS_BOT_OPENID_METADATA_URL", openIdUrl);
  server.use(
    http.get(openIdUrl, () => {
      return HttpResponse.json({
        issuer: BOT_FRAMEWORK_ISSUER,
        jwks_uri: keysUrl,
        id_token_signing_alg_values_supported: [TOKEN_ALGORITHM],
      });
    }),
    http.get(keysUrl, () => {
      return HttpResponse.json({
        keys: [
          {
            ...botFrameworkSigner.publicKey.export({ format: "jwk" }),
            kid: keyId,
          },
        ],
      });
    }),
  );
}

/** A Bot Framework bearer token signed with the published key. */
function botFrameworkBearer(
  keyId: string,
  claims: Readonly<Record<string, unknown>>,
): string {
  const signingInput = [
    { alg: TOKEN_ALGORITHM, typ: "JWT", kid: keyId },
    claims,
  ]
    .map((part) => {
      return Buffer.from(JSON.stringify(part)).toString("base64url");
    })
    .join(".");
  const signature = sign(
    "sha256",
    Buffer.from(signingInput),
    botFrameworkSigner.privateKey,
  );
  return `Bearer ${signingInput}.${signature.toString("base64url")}`;
}

describe("POST /api/webhooks/teams/bot", () => {
  it("teams-bot-015 ignores an unmentioned channel disconnect command", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    await installTeamsForTest(context.signal, fixture);
    const posts = captureBotPosts(fixture);

    const ingress = await deliverToBot(
      teamsMessageActivityForTest(fixture, {
        id: teamsFixtureExternalId(fixture, "activity-disconnect"),
        text: "disconnect",
        entities: [],
      }),
    );

    expect(ingress.activity).toMatchObject({
      kind: "message",
      text: "disconnect",
      mentionsRecipient: false,
    });
    expect(posts).toStrictEqual([]);
  });

  it("teams-bot-006 rejects a Teams token issued for another bot app", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    const keyId = randomUUID();
    publishBotFrameworkKey(keyId);
    const otherBotAppId = randomUUID();

    const response = await accept(
      setupApp({ context, routes: teamsBotRoutes })(teamsBotContract).post({
        body: teamsMessageActivityForTest(fixture),
        extraHeaders: {
          authorization: botFrameworkBearer(keyId, {
            iss: BOT_FRAMEWORK_ISSUER,
            aud: otherBotAppId,
            exp: Math.floor(now() / 1000) + 5 * 60,
            serviceurl: fixture.serviceUrl,
          }),
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
    const posts = captureBotPosts(fixture);

    const ingress = await deliverToBot(teamsMessageActivityForTest(fixture));

    expect(ingress.ok).toBeTruthy();
    expect(ingress.activity).toMatchObject({
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
    const connectUrl = new URL(ingress.connectUrl ?? "");
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
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      conversation: fixture.teamsConversationId,
      inReplyTo: fixture.teamsActivityId,
    });
    expect(posts[0]?.activity.text).toBeUndefined();
    const card = adaptiveCardOf(posts[0]);
    expect(card.body).toStrictEqual([
      expect.objectContaining({
        text: expect.stringContaining("Please connect your account"),
      }),
    ]);
    expect(card.actions).toStrictEqual([
      {
        type: "Action.OpenUrl",
        title: "Connect",
        url: ingress.connectUrl,
      },
    ]);

    await connectTeamsAccountForTest(context, fixture, { learnSender: false });
    const connection = await adminTeamsConnection(fixture);

    expect(connection).toMatchObject({
      isInstalled: true,
      isConnected: true,
      tenantId: fixture.teamsTenantId,
    });
  });

  it("teams-bot-011 sends one team welcome across installation and members-added events", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    await installTeamsForTest(context.signal, fixture);
    const posts = captureBotPosts(fixture);

    await deliverToBot(
      teamsEvent(fixture, {
        type: "installationUpdate",
        id: teamsFixtureExternalId(fixture, "activity-installed"),
        action: "add",
      }),
    );
    await deliverToBot(
      teamsEvent(fixture, {
        type: "conversationUpdate",
        id: teamsFixtureExternalId(fixture, "activity-members-added"),
        membersAdded: [{ id: fixture.teamsBotId, name: "Nova" }],
      }),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]?.conversation).toBe(fixture.teamsConversationId);
    expect(posts[0]?.inReplyTo).toBeUndefined();
    expect(posts[0]?.activity).toMatchObject({
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
    expect(posts[0]?.activity.replyToId).toBeUndefined();
  });

  it("teams-bot-012 sends a personal welcome when Teams adds the bot in personal scope", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    const posts = captureBotPosts(fixture);
    const personalChat = `a:personal-${fixture.teamsUserId}`;

    await deliverToBot(
      teamsEvent(fixture, {
        type: "installationUpdate",
        id: teamsFixtureExternalId(fixture, "activity-personal-install"),
        action: "add",
        conversation: { id: personalChat, conversationType: "personal" },
        channelData: {
          tenant: { id: fixture.teamsTenantId },
          teamsAppId: fixture.teamsAppId,
        },
      }),
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]?.conversation).toBe(personalChat);
    expect(posts[0]?.inReplyTo).toBeUndefined();
    expect(posts[0]?.activity).toMatchObject({
      type: "message",
      textFormat: "markdown",
      text: expect.stringMatching(
        /^Hi, I'm Nova\. I connect Teams conversations to AI agents[\s\S]*Commands: `help`, `connect`, `disconnect`\. Mention `@Nova` with a task or send a DM to work privately\.$/u,
      ),
    });
    expect(posts[0]?.activity.entities).toBeUndefined();
    expect(posts[0]?.activity.replyToId).toBeUndefined();
  });

  it("teams-bot-018 asks for a message when a personal Teams message is blank", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    const posts = captureBotPosts(fixture);
    const blankId = teamsFixtureExternalId(fixture, "blank");
    const personalChat = `a:personal-${fixture.fixtureId}`;

    const ingress = await deliverToBot(
      teamsMessageActivityForTest(fixture, {
        id: blankId,
        text: "   ",
        entities: [],
        conversation: { id: personalChat, conversationType: "personal" },
        channelData: { tenant: { id: fixture.teamsTenantId } },
      }),
    );

    expect(ingress.activity).toMatchObject({
      kind: "message",
      conversationType: "personal",
      text: "",
      attachments: [],
    });
    expect(
      posts.map((post) => {
        return {
          conversation: post.conversation,
          inReplyTo: post.inReplyTo,
          text: post.activity.text,
        };
      }),
    ).toStrictEqual([
      {
        conversation: personalChat,
        inReplyTo: blankId,
        text: "Please include a message for Nova.",
      },
    ]);
  });

  it("teams-bot-013 answers unmentioned help and greeting messages", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    const posts = captureBotPosts(fixture);
    const groupChat = `19:group-${fixture.fixtureId}@thread.v2`;
    const unmentioned = [
      { id: teamsFixtureExternalId(fixture, "help"), text: "help" },
      { id: teamsFixtureExternalId(fixture, "slash-help"), text: "/help" },
      {
        id: teamsFixtureExternalId(fixture, "group-help"),
        text: "help",
        conversation: { id: groupChat, conversationType: "groupChat" },
      },
      { id: teamsFixtureExternalId(fixture, "greeting"), text: "Hi" },
    ];

    const ingresses = [];
    for (const message of unmentioned) {
      ingresses.push(
        await deliverToBot(
          teamsMessageActivityForTest(fixture, { ...message, entities: [] }),
        ),
      );
    }

    expect(
      posts.map((post) => {
        return post.inReplyTo;
      }),
    ).toStrictEqual(
      unmentioned.map((message) => {
        return message.id;
      }),
    );
    expect(posts[0]?.activity.text).toStrictEqual(
      expect.stringContaining("Nova Teams Bot Help"),
    );
    expect(posts[2]).toMatchObject({
      conversation: groupChat,
      activity: { text: expect.stringContaining("Nova Teams Bot Help") },
    });
    expect(adaptiveCardOf(posts[3]).actions).toStrictEqual([
      {
        type: "Action.OpenUrl",
        title: "Connect",
        url: ingresses[3]?.connectUrl,
      },
    ]);
    expect(ingresses[3]?.connectUrl).toStrictEqual(expect.any(String));
  });

  it("teams-bot-037 removes the bot installation and keeps the connected Teams identity", async () => {
    const fixture = teamsConnectFixture();
    setupTeamsConnectTestEnv();
    await installTeamsForTest(context.signal, fixture);
    await connectTeamsAccountForTest(context, fixture, { learnSender: false });

    await removeTeamsForTest(context.signal, fixture);
    await flushWaitUntilForTest();
    const connection = await adminTeamsConnection(fixture);

    expect(connection).toMatchObject({
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
    expect(connection.installUrl).toStrictEqual(expect.any(String));
  });
});
