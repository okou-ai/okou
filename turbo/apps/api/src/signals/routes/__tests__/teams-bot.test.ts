import {
  createHmac,
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";

import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createAppWithRoutes } from "../../../app-factory-core";
import { signSandboxJwtForTests, verifyOkouToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { integrationsTeamsDownloadFileRoutes } from "../integrations-teams-download-file";
import { teamsBotRoutes } from "../teams-bot";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { readAgentRunCallbacks$ } from "./helpers/agent-run-callback";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsFixtureExternalId,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { chatThreadRoutes } from "../chat-threads";
import { teamsConnectRoutes } from "../teams-connect";

const context = testContext();
const callbackStore = createStore();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const computerUseApi = createComputerUseBddApi(context);
const runsApi = createRunsApi(context);
const userConfigApi = createUserConfigBddApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const trackTeamsFixture = createFixtureTracker<TeamsConnectFixture>(
  async (fixture) => {
    await removeTeamsForTest(context.signal, fixture);
  },
);
const TEAMS_BOT_PATH = "http://api.test/api/webhooks/teams/bot";
const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const BOT_APP_PASSWORD = "teams-test-password";
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const APP_ORIGIN = "https://app.okou.test";
const KEY_ID = "teams-test-key";
const TEAMS_LOGIN_PROMPT_FALLBACK_TEXT =
  "Please connect your account to use Okou in this Teams workspace.";
const TEAMS_LOGIN_PROMPT_CARD_TEXT =
  "Please connect your account to use Okou in this Teams workspace.";
const TEAMS_WELCOME_TEXT = [
  "Hi, I'm Nova. I connect Teams conversations to AI agents for research, triage, reports, engineering work, operations, and support.",
  "",
  "To get started, use `connect` to link this Teams workspace to Okou. An org admin may need to complete workspace setup first.",
  "",
  "Commands: `help`, `connect`, `disconnect`, `switch`, `model`. Mention `@Nova` with a task or send a DM to work privately.",
].join("\n");
const BOT_FRAMEWORK_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_KEYS_URL =
  "https://login.botframework.com/v1/.well-known/keys";
const BOT_FRAMEWORK_TOKEN_URL = `https://login.microsoftonline.com/${TEAMS_APP_TENANT_ID}/oauth2/v2.0/token`;

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = keyPair.publicKey.export({ format: "jwk" });

function botFixture(): TeamsConnectFixture {
  return teamsConnectFixture({
    teamsTenantName: "Tenant One",
    teamsTeamName: "Team One",
    serviceUrl: SERVICE_URL,
  });
}

async function trackedBotFixture(): Promise<TeamsConnectFixture> {
  return await trackTeamsFixture(Promise.resolve(botFixture()));
}

function teamsInstallUrl(): string {
  const url = new URL(`https://teams.microsoft.com/l/app/${BOT_APP_ID}`);
  url.searchParams.set("installAppPackage", "true");
  url.searchParams.set("appTenantId", TEAMS_APP_TENANT_ID);
  return url.toString();
}

function teamsOauthConnectUrl(fixture: TeamsConnectFixture): string {
  const url = new URL("https://api.okou.test/api/teams/oauth/connect");
  url.searchParams.set("orgId", fixture.orgId);
  url.searchParams.set("userId", fixture.userId);
  return url.toString();
}

function botFrameworkHandlers(): string[] {
  const requests: string[] = [];
  server.use(
    http.get(BOT_FRAMEWORK_METADATA_URL, () => {
      requests.push("metadata");
      return HttpResponse.json({
        issuer: "https://api.botframework.com",
        jwks_uri: BOT_FRAMEWORK_KEYS_URL,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }),
    http.get(BOT_FRAMEWORK_KEYS_URL, () => {
      requests.push("jwks");
      return HttpResponse.json({
        keys: [
          {
            ...publicJwk,
            kid: KEY_ID,
            use: "sig",
            alg: "RS256",
            endorsements: ["msteams"],
          },
        ],
      });
    }),
  );
  return requests;
}

function teamsServiceBaseUrl(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/u, "");
}

interface TeamsOutboundRequest {
  readonly conversationId: string;
  readonly activityId: string | null;
  readonly body: unknown;
}

interface TeamsReactionRequest {
  readonly method: "PUT" | "DELETE";
  readonly conversationId: string;
  readonly activityId: string;
  readonly reactionType: string;
}

type TeamsOutboundRequests = TeamsOutboundRequest[] & {
  readonly reactions: TeamsReactionRequest[];
};

function teamsOutboundHandlers(serviceUrl: string): TeamsOutboundRequests {
  const serviceBaseUrl = teamsServiceBaseUrl(serviceUrl);
  const responseActivityId = `teams-activity-${randomUUID()}`;
  const requests: TeamsOutboundRequests = Object.assign(
    [] as TeamsOutboundRequest[],
    { reactions: [] as TeamsReactionRequest[] },
  );
  server.use(
    http.post(BOT_FRAMEWORK_TOKEN_URL, async ({ request }) => {
      const form = await request.formData();
      expect(form.get("client_id")).toBe(BOT_APP_ID);
      expect(form.get("client_secret")).toBe(BOT_APP_PASSWORD);
      expect(form.get("scope")).toBe("https://api.botframework.com/.default");
      return HttpResponse.json({
        access_token: "teams-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities`,
      async ({ params, request }) => {
        requests.push({
          conversationId:
            typeof params.conversationId === "string"
              ? params.conversationId
              : "",
          activityId: null,
          body: await request.json(),
        });
        return HttpResponse.json({ id: responseActivityId });
      },
    ),
    http.post(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId`,
      async ({ params, request }) => {
        requests.push({
          conversationId:
            typeof params.conversationId === "string"
              ? params.conversationId
              : "",
          activityId:
            typeof params.activityId === "string" ? params.activityId : "",
          body: await request.json(),
        });
        return HttpResponse.json({ id: responseActivityId });
      },
    ),
    http.put(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType`,
      ({ params }) => {
        requests.reactions.push({
          method: "PUT",
          conversationId:
            typeof params.conversationId === "string"
              ? params.conversationId
              : "",
          activityId:
            typeof params.activityId === "string" ? params.activityId : "",
          reactionType:
            typeof params.reactionType === "string" ? params.reactionType : "",
        });
        return new HttpResponse(null, { status: 200 });
      },
    ),
    http.delete(
      `${serviceBaseUrl}/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType`,
      ({ params }) => {
        requests.reactions.push({
          method: "DELETE",
          conversationId:
            typeof params.conversationId === "string"
              ? params.conversationId
              : "",
          activityId:
            typeof params.activityId === "string" ? params.activityId : "",
          reactionType:
            typeof params.reactionType === "string" ? params.reactionType : "",
        });
        return new HttpResponse(null, { status: 200 });
      },
    ),
  );
  return requests;
}

interface TeamsGraphMessageFixture {
  readonly id: string;
  readonly replyToId?: string | null;
  readonly text: string;
  readonly createdDateTime: string;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly senderPrincipalName?: string | null;
  readonly graphUserPrincipalName?: string | null;
  readonly attachments?: readonly Record<string, unknown>[];
  readonly mentions?: readonly Record<string, unknown>[];
}

function graphTokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    tenantId,
  )}/oauth2/v2.0/token`;
}

function teamsGraphMessage(
  message: TeamsGraphMessageFixture,
  defaultSenderId: string,
): Record<string, unknown> {
  return {
    id: message.id,
    replyToId: message.replyToId ?? null,
    createdDateTime: message.createdDateTime,
    messageType: "message",
    from: {
      user: {
        id: message.senderId ?? defaultSenderId,
        displayName: message.senderName ?? "Ada Lovelace",
        ...(message.senderPrincipalName !== undefined
          ? { userPrincipalName: message.senderPrincipalName }
          : {}),
      },
    },
    body: {
      contentType: "html",
      content: `<p>${message.text}</p>`,
    },
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.mentions ? { mentions: message.mentions } : {}),
  };
}

function teamsGraphUserMap(
  messages: readonly TeamsGraphMessageFixture[],
  defaultSenderId: string,
): ReadonlyMap<
  string,
  {
    readonly displayName: string;
    readonly userPrincipalName: string | null;
  }
> {
  const users = new Map<
    string,
    {
      readonly displayName: string;
      readonly userPrincipalName: string | null;
    }
  >();
  for (const message of messages) {
    const senderId = message.senderId ?? defaultSenderId;
    const existing = users.get(senderId);
    const userPrincipalName =
      message.graphUserPrincipalName ?? existing?.userPrincipalName ?? null;
    users.set(senderId, {
      displayName:
        message.senderName ?? existing?.displayName ?? "Ada Lovelace",
      userPrincipalName,
    });
  }
  return users;
}

function teamsGraphHistoryHandlers(args: {
  readonly fixture: TeamsConnectFixture;
  readonly teamsAppId?: string;
  readonly personalChatId?: string;
  readonly chatMessages?: readonly TeamsGraphMessageFixture[];
  readonly channelMessages: readonly TeamsGraphMessageFixture[];
  readonly threadRoots: Readonly<Record<string, TeamsGraphMessageFixture>>;
  readonly threadReplies: Readonly<
    Record<string, readonly TeamsGraphMessageFixture[]>
  >;
}): string[] {
  const requests: string[] = [];
  const personalChatId =
    args.personalChatId ??
    `19:${teamsFixtureExternalId(
      args.fixture,
      "personal-chat",
    )}@unq.gbl.spaces`;
  const personalInstallationId = teamsFixtureExternalId(
    args.fixture,
    "personal-app-installation",
  );
  const teamsAppId = args.teamsAppId ?? args.fixture.teamsAppId;
  const users = teamsGraphUserMap(
    [
      ...(args.chatMessages ?? []),
      ...args.channelMessages,
      ...Object.values(args.threadRoots),
      ...Object.values(args.threadReplies).flat(),
    ],
    args.fixture.teamsUserId,
  );
  server.use(
    http.post(
      graphTokenUrl(args.fixture.teamsTenantId),
      async ({ request }) => {
        const form = await request.formData();
        expect(form.get("client_id")).toBe(BOT_APP_ID);
        expect(form.get("client_secret")).toBe(BOT_APP_PASSWORD);
        expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
        requests.push("graph-token");
        return HttpResponse.json({
          access_token: "teams-graph-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        const url = new URL(request.url);
        expect(url.searchParams.get("$filter")).toBe(
          `teamsApp/externalId eq '${teamsAppId}'`,
        );
        expect(url.searchParams.get("$expand")).toBe("teamsApp");
        const userId = typeof params.userId === "string" ? params.userId : "";
        requests.push(`personal-installed-apps:${userId}`);
        return HttpResponse.json({
          value: args.chatMessages
            ? [
                {
                  id: personalInstallationId,
                  teamsApp: { externalId: teamsAppId },
                },
              ]
            : [],
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps/:installationId/chat",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        expect(params.installationId).toBe(personalInstallationId);
        const userId = typeof params.userId === "string" ? params.userId : "";
        requests.push(`personal-app-chat:${userId}`);
        return HttpResponse.json({
          id: personalChatId,
          chatType: "oneOnOne",
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/chats/:chatId/messages",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        expect(request.url).toContain("%24top=50");
        expect(request.url).toContain("%24orderby=createdDateTime+desc");
        const chatId = typeof params.chatId === "string" ? params.chatId : "";
        expect(chatId).toBe(personalChatId);
        requests.push(`chat-messages:${chatId}`);
        return HttpResponse.json({
          value: (args.chatMessages ?? []).map((message) => {
            return teamsGraphMessage(message, args.fixture.teamsUserId);
          }),
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        expect(params.teamId).toBe(args.fixture.teamsTeamAadGroupId);
        requests.push("channel-messages");
        return HttpResponse.json({
          value: args.channelMessages.map((message) => {
            return teamsGraphMessage(message, args.fixture.teamsUserId);
          }),
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId/replies",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        expect(params.teamId).toBe(args.fixture.teamsTeamAadGroupId);
        const messageId =
          typeof params.messageId === "string" ? params.messageId : "";
        requests.push(`thread-replies:${messageId}`);
        return HttpResponse.json({
          value: (args.threadReplies[messageId] ?? []).map((message) => {
            return teamsGraphMessage(message, args.fixture.teamsUserId);
          }),
        });
      },
    ),
    http.get(
      "https://graph.microsoft.com/v1.0/teams/:teamId/channels/:channelId/messages/:messageId",
      ({ params, request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer teams-graph-token",
        );
        expect(params.teamId).toBe(args.fixture.teamsTeamAadGroupId);
        const messageId =
          typeof params.messageId === "string" ? params.messageId : "";
        requests.push(`thread-root:${messageId}`);
        const root = args.threadRoots[messageId];
        return root
          ? HttpResponse.json(teamsGraphMessage(root, args.fixture.teamsUserId))
          : HttpResponse.json(
              { error: { code: "NotFound", message: "Message not found" } },
              { status: 404 },
            );
      },
    ),
    http.get("https://graph.microsoft.com/v1.0/users/:userId", ({ params }) => {
      const userId = typeof params.userId === "string" ? params.userId : "";
      const user = users.get(userId);
      requests.push(`user:${userId}`);
      return user
        ? HttpResponse.json({
            id: userId,
            displayName: user.displayName,
            userPrincipalName: user.userPrincipalName,
          })
        : HttpResponse.json(
            { error: { code: "NotFound", message: "User not found" } },
            { status: 404 },
          );
    }),
  );
  return requests;
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function legacyTeamsFileId(payload: Readonly<Record<string, unknown>>): string {
  const encodedPayload = encodeJwtPart(payload);
  const signature = createHmac("sha256", "a".repeat(64))
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function signJwt(args: {
  readonly payload: Record<string, unknown>;
  readonly privateKey: KeyObject;
}): string {
  const header = encodeJwtPart({
    alg: "RS256",
    typ: "JWT",
    kid: KEY_ID,
  });
  const payload = encodeJwtPart(args.payload);
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(args.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function teamsToken(
  overrides: {
    readonly audience?: string | readonly string[];
    readonly serviceUrl?: string;
  } = {},
): string {
  const seconds = Math.floor(now() / 1000);
  return signJwt({
    privateKey: keyPair.privateKey,
    payload: {
      iss: "https://api.botframework.com",
      aud: overrides.audience ?? BOT_APP_ID,
      exp: seconds + 600,
      nbf: seconds - 30,
      serviceurl: overrides.serviceUrl ?? SERVICE_URL,
    },
  });
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? `run_${randomUUID()}`,
    capabilities: (args.capabilities ?? ["teams:write"]) as never,
    iat: seconds,
    exp: seconds + 60,
  });
}

function teamsMessageActivity(
  fixture: TeamsConnectFixture,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "message",
    id: fixture.teamsActivityId,
    timestamp: "2026-06-30T09:10:00.000Z",
    serviceUrl: fixture.serviceUrl,
    channelId: "msteams",
    conversation: {
      id: fixture.teamsConversationId,
      conversationType: "channel",
    },
    channelData: {
      tenant: { id: fixture.teamsTenantId, name: fixture.teamsTenantName },
      team: {
        id: fixture.teamsTeamId,
        aadGroupId: fixture.teamsTeamAadGroupId,
        name: fixture.teamsTeamName,
      },
      channel: { id: fixture.teamsChannelId, name: "General" },
      teamsAppId: fixture.teamsAppId,
    },
    from: {
      id: fixture.teamsUserId,
      name: "Ada Lovelace",
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
    },
    recipient: { id: fixture.teamsBotId, name: "Nova" },
    text: "<at>Nova</at> deploy the preview",
    entities: [
      {
        type: "mention",
        text: "<at>Nova</at>",
        mentioned: { id: fixture.teamsBotId, name: "Nova" },
      },
    ],
    replyToId: fixture.teamsThreadId,
    ...overrides,
  };
}

function teamsBotRemovedActivity(
  fixture: TeamsConnectFixture,
): Record<string, unknown> {
  return {
    type: "conversationUpdate",
    id: teamsFixtureExternalId(fixture, "activity-remove"),
    timestamp: "2026-06-30T09:20:00.000Z",
    serviceUrl: fixture.serviceUrl,
    channelId: "msteams",
    conversation: {
      id: fixture.teamsConversationId,
      conversationType: "channel",
    },
    channelData: {
      tenant: { id: fixture.teamsTenantId, name: fixture.teamsTenantName },
      team: {
        id: fixture.teamsTeamId,
        aadGroupId: fixture.teamsTeamAadGroupId,
        name: fixture.teamsTeamName,
      },
      channel: { id: fixture.teamsChannelId, name: "General" },
      teamsAppId: fixture.teamsAppId,
    },
    recipient: { id: fixture.teamsBotId, name: "Nova" },
    membersRemoved: [{ id: fixture.teamsBotId, name: "Nova" }],
  };
}

function teamsBotInstalledActivity(
  fixture: TeamsConnectFixture,
): Record<string, unknown> {
  return {
    type: "conversationUpdate",
    id: teamsFixtureExternalId(fixture, "activity-install"),
    timestamp: "2026-06-30T09:15:00.000Z",
    serviceUrl: fixture.serviceUrl,
    channelId: "msteams",
    conversation: {
      id: fixture.teamsConversationId,
      conversationType: "channel",
    },
    channelData: {
      tenant: { id: fixture.teamsTenantId, name: fixture.teamsTenantName },
      team: {
        id: fixture.teamsTeamId,
        aadGroupId: fixture.teamsTeamAadGroupId,
        name: fixture.teamsTeamName,
      },
      channel: { id: fixture.teamsChannelId, name: "General" },
      teamsAppId: fixture.teamsAppId,
    },
    from: {
      id: fixture.teamsUserId,
      name: "Ada Lovelace",
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
    },
    recipient: { id: fixture.teamsBotId, name: "Nova" },
    membersAdded: [{ id: fixture.teamsBotId, name: "Nova" }],
  };
}

function teamsBotInstallationAddedActivity(
  fixture: TeamsConnectFixture,
): Record<string, unknown> {
  return {
    type: "installationUpdate",
    action: "add",
    id: teamsFixtureExternalId(fixture, "activity-installation-add"),
    timestamp: "2026-06-30T09:15:00.000Z",
    serviceUrl: fixture.serviceUrl,
    channelId: "msteams",
    conversation: {
      id: fixture.teamsConversationId,
      conversationType: "channel",
    },
    channelData: {
      tenant: { id: fixture.teamsTenantId, name: fixture.teamsTenantName },
      team: {
        id: fixture.teamsTeamId,
        aadGroupId: fixture.teamsTeamAadGroupId,
        name: fixture.teamsTeamName,
      },
      channel: { id: fixture.teamsChannelId, name: "General" },
      teamsAppId: fixture.teamsAppId,
    },
    from: {
      id: fixture.teamsUserId,
      name: "Ada Lovelace",
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
    },
    recipient: { id: fixture.teamsBotId, name: "Nova" },
  };
}

async function postTeamsActivity(
  args: {
    readonly activity: Record<string, unknown>;
    readonly token?: string;
    readonly url?: string;
  },
  signal: AbortSignal = context.signal,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: teamsBotRoutes,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (args.token) {
    headers.authorization = `Bearer ${args.token}`;
  }
  return await app.request(args.url ?? TEAMS_BOT_PATH, {
    method: "POST",
    headers,
    body: JSON.stringify(args.activity),
  });
}

async function readTeamsBotResponseAndFlush(
  response: Response,
): Promise<unknown> {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  await flushWaitUntilForTest();
  return body;
}

async function runIdForPrompt(
  actor: ReturnType<typeof authOrgApi.user>,
  prompt: string,
): Promise<string> {
  const list = await runsApi.listAgentRuns(actor, { limit: 20 });
  const run = list.runs.find((item) => {
    return item.prompt === prompt;
  });
  if (!run) {
    throw new Error(`Expected Teams run for prompt: ${prompt}`);
  }
  return run.id;
}

async function completeCancelledRun(
  runId: string,
  sandboxToken: string,
): Promise<void> {
  await webhooksApi.requestAgentComplete(
    { runId, exitCode: 1, error: "Run cancelled" },
    { authorization: `Bearer ${sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();
}

function requestTokenFromUrl(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  const prefix = "/computer-use/authorize/";
  if (!url.pathname.startsWith(prefix)) {
    throw new Error(`Unexpected authorization URL: ${authorizationUrl}`);
  }
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

function promptSection(
  prompt: string,
  heading: string,
  nextHeading?: string,
): string {
  const startIndex = prompt.indexOf(heading);
  if (startIndex === -1) {
    throw new Error(`Missing prompt section ${heading}`);
  }
  if (!nextHeading) {
    return prompt.slice(startIndex);
  }

  const endIndex = prompt.indexOf(nextHeading, startIndex + heading.length);
  return endIndex === -1
    ? prompt.slice(startIndex)
    : prompt.slice(startIndex, endIndex);
}

async function connectTeamsFixture(
  fixture: TeamsConnectFixture,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({ context, routes: teamsConnectRoutes })(
    teamsConnectContract,
  );
  await accept(
    client.connect({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        tenantId: fixture.teamsTenantId,
        teamsAadObjectId: fixture.teamsAadObjectId,
        teamsUserDisplayName: "Ada Lovelace",
        teamsUserPrincipalName: fixture.teamsUserPrincipalName,
      },
    }),
    [200],
  );
}

function teamsPersonalMessageActivity(args: {
  readonly fixture: TeamsConnectFixture;
  readonly id: string;
  readonly text: string;
  readonly value?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return teamsMessageActivity(args.fixture, {
    id: args.id,
    conversation: {
      id: `a:personal-${args.fixture.teamsUserId}`,
      conversationType: "personal",
    },
    channelData: {
      tenant: {
        id: args.fixture.teamsTenantId,
        name: args.fixture.teamsTenantName,
      },
      teamsAppId: args.fixture.teamsAppId,
    },
    text: args.text,
    entities: [],
    ...(args.value ? { value: args.value } : {}),
    replyToId: null,
  });
}

function teamsPersonalThreadMessageActivity(args: {
  readonly fixture: TeamsConnectFixture;
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
}): Record<string, unknown> {
  return teamsMessageActivity(args.fixture, {
    id: args.id,
    conversation: {
      id: `a:personal-${args.fixture.teamsUserId}`,
      conversationType: "personal",
    },
    channelData: {
      tenant: {
        id: args.fixture.teamsTenantId,
        name: args.fixture.teamsTenantName,
      },
      teamsAppId: args.fixture.teamsAppId,
    },
    text: args.text,
    entities: [],
    replyToId: args.threadId,
  });
}

async function setupConnectedTeamsBotActor(): Promise<{
  readonly fixture: TeamsConnectFixture;
  readonly actor: ReturnType<typeof authOrgApi.user>;
  readonly runnerGroup: string;
  readonly outboundRequests: TeamsOutboundRequests;
}> {
  const fixture = await trackTeamsFixture(
    Promise.resolve(teamsConnectFixture()),
  );
  const actor = authOrgApi.user({
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
  });
  const runnerGroup = runsApi.configureRunnerGroup();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  authOrgApi.acceptAgentStorageWrites();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  const defaultAgent = await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Teams default agent",
  });
  await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
    visibility: "public",
  });
  await runsApi.grantProEntitlement(actor);
  await runsApi.ensureOrgModelProvider(actor);
  botFrameworkHandlers();
  const outboundRequests = teamsOutboundHandlers(fixture.serviceUrl);

  const installResponse = await postTeamsActivity({
    activity: teamsMessageActivity(fixture),
    token: teamsToken(),
  });
  expect(installResponse.status).toBe(200);
  await installResponse.json();
  await flushWaitUntilForTest();
  await connectTeamsFixture(fixture);

  return { fixture, actor, runnerGroup, outboundRequests };
}

describe("POST /api/webhooks/teams/bot", () => {
  beforeEach(() => {
    setupTeamsConnectTestEnv(APP_ORIGIN);
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", BOT_APP_PASSWORD);
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
    mockEnv("OKOU_WEB_URL", "https://www.okou.test");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.axiom.query.mockResolvedValue([]);
    teamsOutboundHandlers(SERVICE_URL);
  });

  it("rejects missing Teams authorization", async () => {
    const fixture = botFixture();
    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Missing Teams bot bearer token",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("verifies the bot token on the final Microsoft console path", async () => {
    botFrameworkHandlers();
    const fixture = botFixture();
    const activity = teamsMessageActivity(fixture, { type: "typing" });

    const response = await postTeamsActivity({
      activity,
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
  });

  it("rejects a Teams activity without a stable identifier", async () => {
    const fixture = botFixture();
    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: undefined,
        timestamp: undefined,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Missing Teams activity id or timestamp",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects a Teams message without an activity id", async () => {
    const fixture = botFixture();
    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, { id: undefined }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Missing Teams message activity id",
        code: "BAD_REQUEST",
      },
    });
  });

  it("rejects a Teams token for another bot app", async () => {
    const fixture = botFixture();
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken({
        audience: "00000000-0000-0000-0000-000000000002",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Invalid Teams bot token audience",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("normalizes a valid Teams message activity", async () => {
    const fixture = await trackedBotFixture();
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      activity: {
        kind: "message",
        activityId: fixture.teamsActivityId,
        tenantId: fixture.teamsTenantId,
        serviceUrl: SERVICE_URL,
        conversationId: fixture.teamsConversationId,
        conversationType: "channel",
        teamId: fixture.teamsTeamId,
        teamAadGroupId: fixture.teamsTeamAadGroupId,
        teamName: "Team One",
        channelId: fixture.teamsChannelId,
        threadId: fixture.teamsThreadId,
        sender: {
          id: fixture.teamsUserId,
          name: "Ada Lovelace",
          aadObjectId: fixture.teamsAadObjectId,
          userPrincipalName: fixture.teamsUserPrincipalName,
        },
        recipient: {
          id: fixture.teamsBotId,
          name: "Nova",
          aadObjectId: null,
          userPrincipalName: null,
        },
        rawText: "<at>Nova</at> deploy the preview",
        text: "deploy the preview",
        mentionsRecipient: true,
        idempotencyKey: `${fixture.teamsConversationId}:message:${fixture.teamsActivityId}`,
      },
    });
    const { connectUrl: connectUrlValue } = z
      .object({ connectUrl: z.string() })
      .parse(body);
    expect(connectUrlValue).toContain(`${APP_ORIGIN}/settings/teams`);
    const connectUrl = new URL(connectUrlValue);
    expect(connectUrl.searchParams.get("tenantId")).toBe(fixture.teamsTenantId);
    expect(connectUrl.searchParams.get("tenantName")).toBe("Tenant One");
    expect(connectUrl.searchParams.get("teamsUserId")).toBe(
      fixture.teamsUserId,
    );
    expect(connectUrl.searchParams.get("teamsAadObjectId")).toBe(
      fixture.teamsAadObjectId,
    );
    expect(connectUrl.searchParams.get("activityId")).toBe(
      fixture.teamsActivityId,
    );
    expect(connectUrl.searchParams.get("teamsUserDisplayName")).toBe(
      "Ada Lovelace",
    );
    expect(connectUrl.searchParams.get("teamsUserPrincipalName")).toBe(
      fixture.teamsUserPrincipalName,
    );
    expect(connectUrl.searchParams.get("displayName")).toBeNull();
    expect(connectUrl.searchParams.get("upn")).toBeNull();
    expect(connectUrl.searchParams.get("teamId")).toBe(fixture.teamsTeamId);
    expect(connectUrl.searchParams.get("teamName")).toBe("Team One");
    expect(connectUrl.searchParams.get("conversationType")).toBe("channel");
    expect(connectUrl.searchParams.get("botName")).toBe("Nova");
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId: fixture.teamsConversationId,
      activityId: fixture.teamsActivityId,
      body: {
        type: "message",
        summary: TEAMS_LOGIN_PROMPT_FALLBACK_TEXT,
        replyToId: fixture.teamsActivityId,
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: TEAMS_LOGIN_PROMPT_CARD_TEXT,
                  wrap: true,
                },
              ],
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "Connect",
                  url: expect.stringContaining(`${APP_ORIGIN}/settings/teams`),
                },
              ],
            },
          },
        ],
        channelData: {
          tenant: { id: fixture.teamsTenantId },
        },
      },
    });
    expect(outboundRequests[0]?.body).not.toHaveProperty("text");

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          teamsUserDisplayName: "Ada Lovelace",
          teamsUserPrincipalName: fixture.teamsUserPrincipalName,
        },
      }),
      [200],
    );
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      tenantId: fixture.teamsTenantId,
      tenantName: "Tenant One",
      teamId: fixture.teamsTeamId,
      teamName: "Team One",
    });
  });

  it("uses the webhook Host for product branding and the Teams recipient for bot identity", async () => {
    const fixture = await trackedBotFixture();
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);
    mockEnv("APP_URL", "https://app.okou.ai");
    const botName = "Tenant Helper";

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: teamsFixtureExternalId(fixture, "activity-okou-host-help"),
        text: "help",
        entities: [],
        recipient: { id: fixture.teamsBotId, name: botName },
      }),
      token: teamsToken(),
      url: "https://api.okou.ai/api/webhooks/teams/bot",
    });

    const body = z
      .object({ connectUrl: z.string() })
      .parse(await readTeamsBotResponseAndFlush(response));
    const connectUrl = new URL(body.connectUrl);
    expect(connectUrl.origin).toBe("https://app.okou.ai");
    expect(connectUrl.searchParams.get("botName")).toBe(botName);
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]?.body).toMatchObject({
      text: expect.stringContaining(`${botName} Teams Bot Help`),
    });
    expect(outboundRequests[0]?.body).toMatchObject({
      text: expect.stringContaining("Connect to Okou"),
    });
    expect(outboundRequests[0]?.body).toMatchObject({
      text: expect.stringContaining(`@${botName}`),
    });
  });

  it("reuses and refreshes Teams auth metadata within explicit app lifecycles", async () => {
    const fixture = await trackedBotFixture();
    const authRequests = botFrameworkHandlers();
    const firstAppSignal = AbortSignal.any([context.signal]);
    const nextAppSignal = AbortSignal.any([context.signal]);
    const initialTime = now();

    for (const activityId of ["auth-cache-first", "auth-cache-reused"]) {
      const response = await postTeamsActivity(
        {
          activity: teamsMessageActivity(fixture, {
            id: teamsFixtureExternalId(fixture, activityId),
            entities: [],
          }),
          token: teamsToken(),
        },
        firstAppSignal,
      );
      expect(response.status).toBe(200);
      await response.json();
      await flushWaitUntilForTest();
    }
    expect(authRequests).toStrictEqual(["metadata", "jwks"]);

    await withMockNowForTest(
      initialTime + 24 * 60 * 60 * 1000 + 60_000,
      async () => {
        const refreshedResponse = await postTeamsActivity(
          {
            activity: teamsMessageActivity(fixture, {
              id: teamsFixtureExternalId(fixture, "auth-cache-refreshed"),
              entities: [],
            }),
            token: teamsToken(),
          },
          firstAppSignal,
        );
        expect(refreshedResponse.status).toBe(200);
        await refreshedResponse.json();
        await flushWaitUntilForTest();
      },
    );
    expect(authRequests).toStrictEqual([
      "metadata",
      "jwks",
      "metadata",
      "jwks",
    ]);

    const refreshedResponse = await postTeamsActivity(
      {
        activity: teamsMessageActivity(fixture, {
          id: teamsFixtureExternalId(fixture, "auth-cache-reloaded"),
          entities: [],
        }),
        token: teamsToken(),
      },
      nextAppSignal,
    );
    expect(refreshedResponse.status).toBe(200);
    await refreshedResponse.json();
    await flushWaitUntilForTest();
    expect(authRequests).toStrictEqual([
      "metadata",
      "jwks",
      "metadata",
      "jwks",
      "metadata",
      "jwks",
    ]);
  });

  it("ignores Teams channel messages that do not mention the bot", async () => {
    const fixture = await trackedBotFixture();
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: teamsFixtureExternalId(fixture, "activity-unmentioned-channel"),
        text: "hello channel",
        entities: [],
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        text: "hello channel",
        mentionsRecipient: false,
      },
    });
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
  });

  it("sends one team welcome across installation and members-added events", async () => {
    const fixture = await trackedBotFixture();
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const installationResponse = await postTeamsActivity({
      activity: teamsBotInstallationAddedActivity(fixture),
      token: teamsToken(),
    });
    const membersAddedResponse = await postTeamsActivity({
      activity: teamsBotInstalledActivity(fixture),
      token: teamsToken(),
    });

    expect(installationResponse.status).toBe(200);
    expect(membersAddedResponse.status).toBe(200);
    await installationResponse.json();
    await membersAddedResponse.json();
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId: fixture.teamsConversationId,
      activityId: null,
      body: {
        type: "message",
        text: expect.stringContaining(
          "<at>Ada Lovelace</at> added Nova to this Teams workspace.",
        ),
        textFormat: "markdown",
        entities: [
          {
            type: "mention",
            text: "<at>Ada Lovelace</at>",
            mentioned: {
              id: fixture.teamsUserId,
              name: "Ada Lovelace",
            },
          },
        ],
        channelData: {
          tenant: { id: fixture.teamsTenantId },
        },
      },
    });
    expect(outboundRequests[0]?.body).not.toHaveProperty("replyToId");
  });

  it("sends a personal welcome message when Teams adds the bot in personal scope", async () => {
    const fixture = await trackedBotFixture();
    const activityId = teamsFixtureExternalId(
      fixture,
      "activity-install-personal",
    );
    const conversationId = `a:personal-${fixture.teamsUserId}`;
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const response = await postTeamsActivity({
      activity: {
        ...teamsBotInstallationAddedActivity(fixture),
        id: activityId,
        conversation: {
          id: conversationId,
          conversationType: "personal",
        },
        channelData: {
          tenant: {
            id: fixture.teamsTenantId,
            name: fixture.teamsTenantName,
          },
          teamsAppId: fixture.teamsAppId,
        },
      },
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await response.json();
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId,
      activityId: null,
      body: {
        type: "message",
        text: TEAMS_WELCOME_TEXT,
        textFormat: "markdown",
        channelData: {
          tenant: { id: fixture.teamsTenantId },
        },
      },
    });
    expect(outboundRequests[0]?.body).not.toHaveProperty("entities");
    expect(outboundRequests[0]?.body).not.toHaveProperty("replyToId");
  });

  it("responds to Teams validation help and greeting messages without a mention", async () => {
    const fixture = await trackedBotFixture();
    const helpActivityId = teamsFixtureExternalId(
      fixture,
      "activity-validation-help",
    );
    const slashHelpActivityId = teamsFixtureExternalId(
      fixture,
      "activity-validation-slash-help",
    );
    const groupHelpActivityId = teamsFixtureExternalId(
      fixture,
      "activity-validation-group-chat-help",
    );
    const greetingActivityId = teamsFixtureExternalId(
      fixture,
      "activity-validation-hi",
    );
    const groupConversationId = `19:${teamsFixtureExternalId(
      fixture,
      "group-chat",
    )}@thread.v2`;
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const helpResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: helpActivityId,
        text: "help",
        entities: [],
      }),
      token: teamsToken(),
    });
    const helpBody = await readTeamsBotResponseAndFlush(helpResponse);
    expect(helpBody).not.toHaveProperty("dispatch");

    const slashHelpResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: slashHelpActivityId,
        text: "/help",
        entities: [],
      }),
      token: teamsToken(),
    });
    const slashHelpBody = await readTeamsBotResponseAndFlush(slashHelpResponse);
    expect(slashHelpBody).not.toHaveProperty("dispatch");

    const groupChatHelpResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: groupHelpActivityId,
        conversation: {
          id: groupConversationId,
          conversationType: "groupChat",
        },
        channelData: {
          tenant: {
            id: fixture.teamsTenantId,
            name: fixture.teamsTenantName,
          },
          teamsAppId: fixture.teamsAppId,
        },
        text: "help",
        entities: [],
        replyToId: null,
      }),
      token: teamsToken(),
    });
    const groupChatHelpBody = await readTeamsBotResponseAndFlush(
      groupChatHelpResponse,
    );
    expect(groupChatHelpBody).not.toHaveProperty("dispatch");

    const greetingResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: greetingActivityId,
        text: "Hi",
        entities: [],
      }),
      token: teamsToken(),
    });
    const greetingBody = await readTeamsBotResponseAndFlush(greetingResponse);
    expect(greetingBody).not.toHaveProperty("dispatch");
    expect(outboundRequests).toHaveLength(4);
    expect(
      outboundRequests.map((request) => {
        return request.activityId;
      }),
    ).toStrictEqual([
      helpActivityId,
      slashHelpActivityId,
      groupHelpActivityId,
      greetingActivityId,
    ]);
    expect(outboundRequests[0]?.body).toMatchObject({
      text: expect.stringContaining("Nova Teams Bot Help"),
    });
    expect(outboundRequests[2]?.body).toMatchObject({
      text: expect.stringContaining("Nova Teams Bot Help"),
    });
    expect(outboundRequests[3]?.body).toMatchObject({
      text: TEAMS_WELCOME_TEXT,
    });
  });

  it("responds to Teams greeting messages with a mention", async () => {
    const fixture = await trackedBotFixture();
    const activityId = teamsFixtureExternalId(fixture, "activity-mentioned-hi");
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: activityId,
        text: "<at>Nova</at> Hi",
      }),
      token: teamsToken(),
    });

    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        text: "Hi",
        mentionsRecipient: true,
      },
    });
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId: fixture.teamsConversationId,
      activityId,
      body: {
        type: "message",
        text: TEAMS_WELCOME_TEXT,
        replyToId: activityId,
      },
    });
  });

  it("does not run other Teams commands without a mention in channel scope", async () => {
    const fixture = await trackedBotFixture();
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: teamsFixtureExternalId(fixture, "activity-unmentioned-disconnect"),
        text: "disconnect",
        entities: [],
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        text: "disconnect",
        mentionsRecipient: false,
      },
    });
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(0);
  });

  it("handles Teams personal messages without requiring a bot mention", async () => {
    const fixture = await trackedBotFixture();
    const activityId = teamsFixtureExternalId(fixture, "activity-personal-dm");
    const conversationId = `a:personal-${fixture.teamsUserId}`;
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(SERVICE_URL);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: activityId,
        conversation: {
          id: conversationId,
          conversationType: "personal",
        },
        channelData: {
          tenant: {
            id: fixture.teamsTenantId,
            name: fixture.teamsTenantName,
          },
          teamsAppId: fixture.teamsAppId,
        },
        text: "hello from dm",
        entities: [],
        replyToId: null,
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        conversationType: "personal",
        threadId: activityId,
        text: "hello from dm",
        mentionsRecipient: false,
      },
    });
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      conversationId,
      activityId,
      body: {
        type: "message",
        summary: TEAMS_LOGIN_PROMPT_FALLBACK_TEXT,
        replyToId: activityId,
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: [
                {
                  type: "TextBlock",
                  text: TEAMS_LOGIN_PROMPT_CARD_TEXT,
                  wrap: true,
                },
              ],
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "Connect",
                  url: expect.stringContaining(`${APP_ORIGIN}/settings/teams`),
                },
              ],
            },
          },
        ],
      },
    });
    expect(outboundRequests[0]?.body).not.toHaveProperty("text");
  });

  it("downloads Teams channel reference attachments through Graph", async () => {
    botFrameworkHandlers();
    const fixture = await trackTeamsFixture(
      Promise.resolve(teamsConnectFixture()),
    );
    const activityId = teamsFixtureExternalId(fixture, "activity-file-channel");
    const attachmentId = teamsFixtureExternalId(fixture, "channel-attachment");
    const actor = authOrgApi.user({
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
    });
    const runnerGroup = runsApi.configureRunnerGroup();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    authOrgApi.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    const defaultAgent = await authOrgApi.bootstrapLimitedFreeOnboarding(
      actor,
      {
        displayName: "Teams file agent",
      },
    );
    await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
      visibility: "public",
    });
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    await installTeamsForTest(context.signal, fixture);
    await connectTeamsFixture(fixture);
    botFrameworkHandlers();
    teamsOutboundHandlers(fixture.serviceUrl);
    teamsGraphHistoryHandlers({
      fixture,
      channelMessages: [],
      threadRoots: {},
      threadReplies: {},
    });

    const contentUrl = "https://contoso.sharepoint.com/sites/docs/spec.png";
    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: activityId,
        text: "please inspect this",
        replyToId: null,
        attachments: [
          {
            id: attachmentId,
            contentType: "reference",
            contentUrl,
            name: "spec.png",
          },
        ],
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).not.toHaveProperty("dispatch");
    const canonicalFilePrompt = "[Web file] spec.png (image/png)";
    const list = await runsApi.listAgentRuns(actor, { limit: 20 });
    const run = list.runs.find((item) => {
      return (
        item.prompt.includes("please inspect this") &&
        item.prompt.includes(canonicalFilePrompt)
      );
    });
    expect(run).toBeDefined();
    const runId = run?.id;
    if (!runId) {
      throw new Error("Expected Teams file run id");
    }
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(runId);
    expect(claim.prompt).toContain("please inspect this");
    expect(claim.prompt).toContain(canonicalFilePrompt);
    expect(claim.appendSystemPrompt).toContain("okou teams download-file -h");

    const fileIdMatch = claim.prompt.match(/ {3}\[ID\] ([^\n]+)/u);
    const fileId = fileIdMatch?.[1];
    expect(fileId).toBeTruthy();
    expect(fileId).not.toContain(contentUrl);
    expect(fileId).toMatch(/^teams_file_[A-Za-z0-9_-]{22}$/u);

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const threadEvents = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const chatThreadCreated = threadEvents.body.events.find((event) => {
      return (
        event.kind === "created" && event.agentId === defaultAgent.body.agentId
      );
    });
    if (!chatThreadCreated) {
      throw new Error("Expected the canonical Teams file chat thread");
    }
    const threadEventsPage = await readProjectedChatEvents(context, {
      threadId: chatThreadCreated.chatThreadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(threadEventsPage).toContainEqual(
      expect.objectContaining({
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId,
              filenameSnapshot: "spec.png",
              contentType: "image/png",
            },
            { type: "text", text: "@Nova please inspect this" },
            {
              type: "source",
              kind: "teams",
              href: `https://teams.microsoft.com/l/message/${encodeURIComponent(
                fixture.teamsChannelId,
              )}/${activityId}?tenantId=${encodeURIComponent(fixture.teamsTenantId)}`,
            },
          ],
        },
      }),
    );

    const fileBytes = Buffer.from("teams file bytes");
    const expectedShareId = `u!${Buffer.from(contentUrl, "utf8").toString(
      "base64url",
    )}`;
    server.use(
      http.get(
        "https://graph.microsoft.com/v1.0/shares/:shareId/driveItem/content",
        ({ params, request }) => {
          expect(params.shareId).toBe(expectedShareId);
          expect(request.headers.get("authorization")).toBe(
            "Bearer teams-graph-token",
          );
          return new HttpResponse(fileBytes, {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(fileBytes.length),
            },
          });
        },
      ),
    );

    const app = createAppWithRoutes({
      signal: context.signal,
      routes: integrationsTeamsDownloadFileRoutes,
    });
    const downloadResponse = await app.request(
      `/api/integrations/teams/download-file?${new URLSearchParams({
        file_id: fileId ?? "",
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId,
          })}`,
        },
      },
    );

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("image/png");
    expect(downloadResponse.headers.get("x-file-mimetype")).toBe("image/png");
    expect(downloadResponse.headers.get("x-file-name")).toBe("spec.png");
    const receivedBytes = Buffer.from(await downloadResponse.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("uses short file ids for Teams personal attachments", async () => {
    const { fixture, actor, runnerGroup } = await setupConnectedTeamsBotActor();
    const activityId = teamsFixtureExternalId(
      fixture,
      "activity-personal-file",
    );
    const attachmentId = teamsFixtureExternalId(fixture, "personal-attachment");
    const downloadUrl = new URL(
      "https://contoso.sharepoint.com/_layouts/15/download.aspx",
    );
    downloadUrl.searchParams.set("tempauth", "a".repeat(1400));
    const fileBytes = Buffer.from("teams personal file bytes");
    server.use(
      http.get(downloadUrl.origin + downloadUrl.pathname, () => {
        return new HttpResponse(fileBytes, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(fileBytes.length),
          },
        });
      }),
    );

    const response = await postTeamsActivity({
      activity: {
        ...teamsPersonalMessageActivity({
          fixture,
          id: activityId,
          text: "inspect this personal attachment",
        }),
        attachments: [
          {
            id: attachmentId,
            contentType: "application/vnd.microsoft.teams.file.download.info",
            content: {
              downloadUrl: downloadUrl.toString(),
              fileName: "personal.png",
            },
          },
        ],
      },
      token: teamsToken(),
    });
    expect(response.status).toBe(200);
    await readTeamsBotResponseAndFlush(response);

    const list = await runsApi.listAgentRuns(actor, { limit: 20 });
    const run = list.runs.find((item) => {
      return item.prompt.includes("inspect this personal attachment");
    });
    if (!run) {
      throw new Error("Expected Teams personal file run");
    }
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    const fileId = claim.prompt.match(/ {3}\[ID\] ([^\n]+)/u)?.[1];
    expect(fileId).toMatch(/^teams_file_[A-Za-z0-9_-]{22}$/u);
    expect(fileId?.length).toBeLessThan(64);

    const app = createAppWithRoutes({
      signal: context.signal,
      routes: integrationsTeamsDownloadFileRoutes,
    });
    const downloadResponse = await app.request(
      `/api/integrations/teams/download-file?${new URLSearchParams({
        file_id: fileId ?? "",
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: run.id,
          })}`,
        },
      },
    );

    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("x-file-name")).toBe("personal.png");
    expect(
      Buffer.from(await downloadResponse.arrayBuffer()).equals(fileBytes),
    ).toBeTruthy();

    const legacyFileId = legacyTeamsFileId({
      tenantId: fixture.teamsTenantId,
      url: downloadUrl.toString(),
      name: "personal.png",
      contentType: "image/png",
    });
    const legacyDownloadResponse = await app.request(
      `/api/integrations/teams/download-file?${new URLSearchParams({
        file_id: legacyFileId,
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${okouToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
          })}`,
        },
      },
    );
    expect(legacyDownloadResponse.status).toBe(200);
  });

  it("preserves non-bot Teams mentions in message text", async () => {
    const fixture = await trackedBotFixture();
    const mentionedUserId = teamsFixtureExternalId(fixture, "29:user-grace");
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: teamsFixtureExternalId(fixture, "activity-user-mention"),
        text: "<at>Nova</at> ask <at>Grace Hopper</at> to review",
        entities: [
          {
            type: "mention",
            text: "<at>Nova</at>",
            mentioned: { id: fixture.teamsBotId, name: "Nova" },
          },
          {
            type: "mention",
            text: "<at>Grace Hopper</at>",
            mentioned: { id: mentionedUserId, name: "Grace Hopper" },
          },
        ],
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      activity: {
        kind: "message",
        text: `ask @Grace Hopper (${mentionedUserId}) to review`,
        mentionsRecipient: true,
      },
    });
    expect(body).not.toHaveProperty("dispatch");
    await flushWaitUntilForTest();
  });

  it("handles connected Teams bot commands", async () => {
    const { fixture, actor, outboundRequests } =
      await setupConnectedTeamsBotActor();
    const activityIds = {
      help: teamsFixtureExternalId(fixture, "activity-command-help"),
      connect: teamsFixtureExternalId(fixture, "activity-command-connect"),
      switch: teamsFixtureExternalId(fixture, "activity-command-switch"),
      model: teamsFixtureExternalId(fixture, "activity-command-model"),
      switchSubmit: teamsFixtureExternalId(
        fixture,
        "activity-command-switch-submit",
      ),
      modelSubmit: teamsFixtureExternalId(
        fixture,
        "activity-command-model-submit",
      ),
      switchedRun: teamsFixtureExternalId(
        fixture,
        "activity-command-switch-run",
      ),
      disconnect: teamsFixtureExternalId(
        fixture,
        "activity-command-disconnect",
      ),
    };
    const switchAgent = await authOrgApi.createAgent(actor, {
      displayName: "Teams support agent",
      visibility: "public",
    });
    outboundRequests.splice(0, outboundRequests.length);

    const helpResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: activityIds.help,
        text: "/help",
      }),
      token: teamsToken(),
    });
    expect(helpResponse.status).toBe(200);
    const helpBody = await readTeamsBotResponseAndFlush(helpResponse);
    expect(helpBody).not.toHaveProperty("dispatch");

    const connectResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: activityIds.connect,
        text: "/connect",
      }),
      token: teamsToken(),
    });
    expect(connectResponse.status).toBe(200);
    const connectBody = await readTeamsBotResponseAndFlush(connectResponse);
    expect(connectBody).not.toHaveProperty("dispatch");

    const switchResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: activityIds.switch,
        text: "/switch",
      }),
      token: teamsToken(),
    });
    expect(switchResponse.status).toBe(200);
    const switchBody = await readTeamsBotResponseAndFlush(switchResponse);
    expect(switchBody).not.toHaveProperty("dispatch");

    const modelResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: activityIds.model,
        text: "/model",
      }),
      token: teamsToken(),
    });
    expect(modelResponse.status).toBe(200);
    const modelBody = await readTeamsBotResponseAndFlush(modelResponse);
    expect(modelBody).not.toHaveProperty("dispatch");

    const switchSubmitResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: activityIds.switchSubmit,
        text: "",
        value: {
          okouTeamsAction: "switch_agent",
          selectedAgentId: switchAgent.agentId,
        },
      }),
      token: teamsToken(),
    });
    expect(switchSubmitResponse.status).toBe(200);
    const switchSubmitBody =
      await readTeamsBotResponseAndFlush(switchSubmitResponse);
    expect(switchSubmitBody).toMatchObject({
      activity: {
        value: {
          okouTeamsAction: "switch_agent",
          selectedAgentId: switchAgent.agentId,
        },
      },
    });
    expect(switchSubmitBody).not.toHaveProperty("dispatch");
    const modelSubmitResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: activityIds.modelSubmit,
        text: "",
        value: {
          okouTeamsAction: "switch_model",
          selectedModel: "claude-sonnet-5",
        },
      }),
      token: teamsToken(),
    });
    expect(modelSubmitResponse.status).toBe(200);
    const modelSubmitBody =
      await readTeamsBotResponseAndFlush(modelSubmitResponse);
    expect(modelSubmitBody).toMatchObject({
      activity: {
        value: {
          okouTeamsAction: "switch_model",
          selectedModel: "claude-sonnet-5",
        },
      },
    });
    expect(modelSubmitBody).not.toHaveProperty("dispatch");
    await expect(
      userConfigApi.readModelPreference(actor),
    ).resolves.toMatchObject({
      selectedModel: "claude-sonnet-5",
    });

    expect(outboundRequests).toHaveLength(6);
    expect(
      outboundRequests.map((request) => {
        return request.activityId;
      }),
    ).toStrictEqual([
      activityIds.help,
      activityIds.connect,
      activityIds.switch,
      activityIds.model,
      activityIds.switchSubmit,
      activityIds.modelSubmit,
    ]);
    expect(outboundRequests[0]?.body).toMatchObject({
      type: "message",
      text: expect.stringContaining("Nova Teams Bot Help"),
    });
    expect(outboundRequests[1]?.body).toMatchObject({
      type: "message",
      text: expect.stringContaining("You're already connected"),
    });
    expect(outboundRequests[2]?.body).toMatchObject({
      type: "message",
      summary: expect.stringContaining("Choose which agent should respond"),
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
            body: expect.arrayContaining([
              expect.objectContaining({
                type: "Input.ChoiceSet",
                id: "selectedAgentId",
                choices: expect.arrayContaining([
                  expect.objectContaining({
                    title: expect.stringContaining("Use org default"),
                    value: "__org_default__",
                  }),
                  expect.objectContaining({
                    title: "Teams support agent",
                    value: switchAgent.agentId,
                  }),
                ]),
              }),
            ]),
            actions: [
              {
                type: "Action.Submit",
                title: "Switch",
                data: { okouTeamsAction: "switch_agent" },
              },
            ],
          },
        },
      ],
    });
    expect(outboundRequests[3]?.body).toMatchObject({
      type: "message",
      summary: expect.stringContaining("Choose the model"),
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
            body: expect.arrayContaining([
              expect.objectContaining({
                type: "Input.ChoiceSet",
                id: "selectedModel",
                choices: expect.arrayContaining([
                  expect.objectContaining({
                    title: expect.stringContaining("Claude Sonnet 5"),
                    value: "claude-sonnet-5",
                  }),
                ]),
              }),
            ]),
            actions: [
              {
                type: "Action.Submit",
                title: "Switch",
                data: { okouTeamsAction: "switch_model" },
              },
            ],
          },
        },
      ],
    });
    expect(outboundRequests[4]?.body).toMatchObject({
      type: "message",
      text: expect.stringContaining("Teams support agent"),
    });
    expect(outboundRequests[5]?.body).toMatchObject({
      type: "message",
      text: expect.stringContaining("Claude Sonnet 5"),
    });

    outboundRequests.splice(0, outboundRequests.length);
    const switchedRunResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: activityIds.switchedRun,
        text: "run after switch",
      }),
      token: teamsToken(),
    });
    expect(switchedRunResponse.status).toBe(200);
    const switchedRunBody =
      await readTeamsBotResponseAndFlush(switchedRunResponse);
    expect(switchedRunBody).not.toHaveProperty("dispatch");
    const switchedRunId = await runIdForPrompt(actor, "run after switch");
    await expect(
      runsApi.listAgentRuns(actor, { limit: 10 }),
    ).resolves.toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({
          appendSystemPrompt: expect.stringContaining(
            "Your name is Teams support agent.",
          ),
          prompt: "run after switch",
        }),
      ]),
    });
    await runsApi.requestCancelRun(actor, switchedRunId, [200]);

    outboundRequests.splice(0, outboundRequests.length);
    const disconnectResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: activityIds.disconnect,
        text: "/disconnect",
      }),
      token: teamsToken(),
    });
    expect(disconnectResponse.status).toBe(200);
    const disconnectBody =
      await readTeamsBotResponseAndFlush(disconnectResponse);
    expect(disconnectBody).not.toHaveProperty("dispatch");
    expect(outboundRequests).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            type: "message",
            text: expect.stringContaining("agent access has been revoked"),
          }),
        }),
      ]),
    );
  });

  it.each(["agent", "model"] as const)(
    "applies a Teams %s switch to an existing chat thread",
    async (selection) => {
      const { fixture, actor, runnerGroup } =
        await setupConnectedTeamsBotActor();
      const threadId = teamsFixtureExternalId(
        fixture,
        "activity-existing-switch-root",
      );
      const activityIds = {
        initial: teamsFixtureExternalId(
          fixture,
          "activity-existing-switch-initial",
        ),
        switchAgent: teamsFixtureExternalId(
          fixture,
          "activity-existing-switch-agent",
        ),
        switchedAgentRun: teamsFixtureExternalId(
          fixture,
          "activity-existing-switch-agent-run",
        ),
        switchModel: teamsFixtureExternalId(
          fixture,
          "activity-existing-switch-model",
        ),
        switchedModelRun: teamsFixtureExternalId(
          fixture,
          "activity-existing-switch-model-run",
        ),
      };
      const supportAgent = await authOrgApi.createAgent(actor, {
        displayName: "Teams switched agent",
        visibility: "public",
      });
      const anthropic = await runsApi.createOrgModelProvider(actor, {
        type: "anthropic-api-key",
        secret: "teams-switch-anthropic-key",
      });
      const openai = await runsApi.createOrgModelProvider(actor, {
        type: "openai-api-key",
        secret: "teams-switch-openai-key",
      });
      await runsApi.updateOrgModelPolicies(actor, [
        {
          model: "claude-sonnet-5",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: anthropic.providerId,
        },
        {
          model: "gpt-5.6-sol",
          isDefault: false,
          defaultProviderType: "openai-api-key",
          credentialScope: "org",
          modelProviderId: openai.providerId,
        },
      ]);
      teamsGraphHistoryHandlers({
        fixture,
        chatMessages: [],
        channelMessages: [],
        threadRoots: {},
        threadReplies: {},
      });

      if (selection === "agent") {
        const initialResponse = await postTeamsActivity({
          activity: teamsPersonalThreadMessageActivity({
            fixture,
            id: activityIds.initial,
            threadId,
            text: "run before switching",
          }),
          token: teamsToken(),
        });
        expect(initialResponse.status).toBe(200);
        await readTeamsBotResponseAndFlush(initialResponse);
        const initialRunId = await runIdForPrompt(
          actor,
          "run before switching",
        );
        await runsApi.heartbeatRunner(runnerGroup);
        const initialClaim = await runsApi.claimRunnerJob(initialRunId);
        await runsApi.requestCancelRun(actor, initialRunId, [200]);
        await completeCancelledRun(initialRunId, initialClaim.sandboxToken);
      }

      const switchAgentResponse = await postTeamsActivity({
        activity: teamsPersonalMessageActivity({
          fixture,
          id: activityIds.switchAgent,
          text: "",
          value: {
            okouTeamsAction: "switch_agent",
            selectedAgentId: supportAgent.agentId,
          },
        }),
        token: teamsToken(),
      });
      expect(switchAgentResponse.status).toBe(200);
      await readTeamsBotResponseAndFlush(switchAgentResponse);

      const switchedAgentResponse = await postTeamsActivity({
        activity: teamsPersonalThreadMessageActivity({
          fixture,
          id: activityIds.switchedAgentRun,
          threadId,
          text: "run after agent switch",
        }),
        token: teamsToken(),
      });
      expect(switchedAgentResponse.status).toBe(200);
      await readTeamsBotResponseAndFlush(switchedAgentResponse);
      const switchedAgentRunId = await runIdForPrompt(
        actor,
        "run after agent switch",
      );
      await runsApi.heartbeatRunner(runnerGroup);
      const switchedAgentClaim =
        await runsApi.claimRunnerJob(switchedAgentRunId);
      expect(switchedAgentClaim.appendSystemPrompt).toContain(
        "Your name is Teams switched agent.",
      );
      await runsApi.requestCancelRun(actor, switchedAgentRunId, [200]);
      await completeCancelledRun(
        switchedAgentRunId,
        switchedAgentClaim.sandboxToken,
      );

      if (selection === "agent") {
        return;
      }

      const switchModelResponse = await postTeamsActivity({
        activity: teamsPersonalMessageActivity({
          fixture,
          id: activityIds.switchModel,
          text: "",
          value: {
            okouTeamsAction: "switch_model",
            selectedModel: "gpt-5.6-sol",
          },
        }),
        token: teamsToken(),
      });
      expect(switchModelResponse.status).toBe(200);
      await readTeamsBotResponseAndFlush(switchModelResponse);

      const switchedModelResponse = await postTeamsActivity({
        activity: teamsPersonalThreadMessageActivity({
          fixture,
          id: activityIds.switchedModelRun,
          threadId,
          text: "run after model switch",
        }),
        token: teamsToken(),
      });
      expect(switchedModelResponse.status).toBe(200);
      await readTeamsBotResponseAndFlush(switchedModelResponse);
      const switchedModelRunId = await runIdForPrompt(
        actor,
        "run after model switch",
      );
      await runsApi.heartbeatRunner(runnerGroup);
      const switchedModelClaim =
        await runsApi.claimRunnerJob(switchedModelRunId);
      expect(switchedModelClaim.appendSystemPrompt).toContain(
        "Your name is Teams switched agent.",
      );
      expect(switchedModelClaim.appendSystemPrompt).toContain(
        "# Microsoft Teams Run Context",
      );
      expect(switchedModelClaim.appendSystemPrompt).toContain(
        `- AGENT_SESSION_COMMAND: okou search "${switchedAgentRunId}" --source agent-session`,
      );
      expect(switchedModelClaim.appendSystemPrompt).toContain(
        "Use the AGENT_SESSION_COMMAND for a run",
      );
      expect(switchedModelClaim.appendSystemPrompt).not.toContain(
        "LOG_COMMAND",
      );
      expect(switchedModelClaim.modelUsageProvider).toBe("gpt-5.6-sol");
      await runsApi.requestCancelRun(actor, switchedModelRunId, [200]);
    },
  );

  it("replies when a connected Teams run is queued", async () => {
    const { fixture, actor, outboundRequests } =
      await setupConnectedTeamsBotActor();
    const firstActivityId = teamsFixtureExternalId(
      fixture,
      "activity-queue-active-1",
    );
    const secondActivityId = teamsFixtureExternalId(
      fixture,
      "activity-queue-active-2",
    );
    const queuedActivityId = teamsFixtureExternalId(
      fixture,
      "activity-queue-third",
    );
    const firstThreadId = teamsFixtureExternalId(
      fixture,
      "activity-queue-thread-1",
    );
    const secondThreadId = teamsFixtureExternalId(
      fixture,
      "activity-queue-thread-2",
    );
    const queuedThreadId = teamsFixtureExternalId(
      fixture,
      "activity-queue-thread-3",
    );
    outboundRequests.splice(0, outboundRequests.length);

    const [firstResponse, secondResponse] = await Promise.all([
      postTeamsActivity({
        activity: teamsPersonalThreadMessageActivity({
          fixture,
          id: firstActivityId,
          threadId: firstThreadId,
          text: "active run one",
        }),
        token: teamsToken(),
      }),
      postTeamsActivity({
        activity: teamsPersonalThreadMessageActivity({
          fixture,
          id: secondActivityId,
          threadId: secondThreadId,
          text: "active run two",
        }),
        token: teamsToken(),
      }),
    ]);
    expect(firstResponse.status).toBe(200);
    const firstBody = await readTeamsBotResponseAndFlush(firstResponse);
    expect(firstBody).not.toHaveProperty("dispatch");
    const firstRunId = await runIdForPrompt(actor, "active run one");

    expect(secondResponse.status).toBe(200);
    const secondBody = await readTeamsBotResponseAndFlush(secondResponse);
    expect(secondBody).not.toHaveProperty("dispatch");
    const secondRunId = await runIdForPrompt(actor, "active run two");

    const queuedResponse = await postTeamsActivity({
      activity: teamsPersonalThreadMessageActivity({
        fixture,
        id: queuedActivityId,
        threadId: queuedThreadId,
        text: "queued run three",
      }),
      token: teamsToken(),
    });
    expect(queuedResponse.status).toBe(200);
    const queuedBody = await readTeamsBotResponseAndFlush(queuedResponse);
    expect(queuedBody).not.toHaveProperty("dispatch");
    const queuedRunId = await runIdForPrompt(actor, "queued run three");

    expect(outboundRequests).toHaveLength(4);
    expect(
      outboundRequests.slice(0, 3).map((request) => {
        return request.body;
      }),
    ).toStrictEqual([
      {
        type: "typing",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
      {
        type: "typing",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
      {
        type: "typing",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    ]);
    expect(outboundRequests[3]).toMatchObject({
      activityId: queuedActivityId,
      body: {
        type: "message",
        summary: expect.stringContaining("Run queued"),
        attachments: [
          {
            contentType: "application/vnd.microsoft.card.adaptive",
            content: {
              type: "AdaptiveCard",
              version: "1.4",
              body: expect.arrayContaining([
                expect.objectContaining({ text: "Run queued" }),
              ]),
              actions: [
                {
                  type: "Action.OpenUrl",
                  title: "View queue",
                  url: `${APP_ORIGIN}/?queue=1`,
                },
              ],
            },
          },
        ],
      },
    });
    expect(outboundRequests[3]?.body).not.toHaveProperty("text");
    expect(outboundRequests.reactions).toHaveLength(0);

    await runsApi.requestCancelRun(actor, queuedRunId, [200]);
    await runsApi.requestCancelRun(actor, firstRunId, [200]);
    await runsApi.requestCancelRun(actor, secondRunId, [200]);
  });

  it("clears thinking and adds audit/footer text for Teams run admission failures", async () => {
    const fixture = await trackTeamsFixture(
      Promise.resolve(teamsConnectFixture()),
    );
    const switchActivityId = teamsFixtureExternalId(
      fixture,
      "activity-failure-switch-agent",
    );
    const failedActivityId = teamsFixtureExternalId(
      fixture,
      "activity-run-pre-dispatch-failure",
    );
    const actor = authOrgApi.user({
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
    });
    context.mocks.ably.publish.mockResolvedValue(undefined);
    authOrgApi.acceptAgentStorageWrites();
    const defaultAgent = await authOrgApi.bootstrapLimitedFreeOnboarding(
      actor,
      {
        displayName: "Teams default agent",
      },
    );
    await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
      visibility: "public",
    });
    const supportAgent = await authOrgApi.createAgent(actor, {
      displayName: "Teams support agent",
      visibility: "public",
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: { id: fixture.orgId },
          role: "org:admin",
        },
      ],
    });
    await updateFeatureSwitchesForUser(
      context,
      {
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "org:admin",
      },
      {
        [FeatureSwitchKey.OkouDebug]: true,
      },
    );
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(fixture.serviceUrl);

    const installResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });
    expect(installResponse.status).toBe(200);
    await installResponse.json();
    await flushWaitUntilForTest();
    await connectTeamsFixture(fixture);

    outboundRequests.splice(0, outboundRequests.length);
    const switchResponse = await postTeamsActivity({
      activity: teamsPersonalMessageActivity({
        fixture,
        id: switchActivityId,
        text: "",
        value: {
          okouTeamsAction: "switch_agent",
          selectedAgentId: supportAgent.agentId,
        },
      }),
      token: teamsToken(),
    });
    expect(switchResponse.status).toBe(200);
    const switchBody = await readTeamsBotResponseAndFlush(switchResponse);
    expect(switchBody).not.toHaveProperty("dispatch");
    await upsertOrgPlanEntitlementFixture({
      orgId: fixture.orgId,
      status: "suspended",
    });

    outboundRequests.splice(0, outboundRequests.length);
    teamsGraphHistoryHandlers({
      fixture,
      chatMessages: [],
      channelMessages: [],
      threadRoots: {},
      threadReplies: {},
    });
    const failedResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: failedActivityId,
        text: "<at>Nova</at> run without entitlement",
      }),
      token: teamsToken(),
    });
    expect(failedResponse.status).toBe(200);
    const body = await readTeamsBotResponseAndFlush(failedResponse);
    expect(body).not.toHaveProperty("dispatch");

    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      activityId: failedActivityId,
      body: {
        type: "message",
        text: expect.stringContaining(`[Audit](${APP_ORIGIN}/activities)`),
        textFormat: "markdown",
      },
    });
    expect(outboundRequests[0]?.body).toMatchObject({
      text: expect.stringContaining("Sent via Teams support agent"),
    });
    expect(outboundRequests.reactions).toStrictEqual([
      {
        method: "PUT",
        conversationId: fixture.teamsConversationId,
        activityId: failedActivityId,
        reactionType: "1f4ad_thoughtballoon",
      },
      {
        method: "DELETE",
        conversationId: fixture.teamsConversationId,
        activityId: failedActivityId,
        reactionType: "1f4ad_thoughtballoon",
      },
    ]);
  });

  it("deduplicates repeated Teams activities before queueing a second run", async () => {
    const { fixture, actor, outboundRequests } =
      await setupConnectedTeamsBotActor();
    teamsGraphHistoryHandlers({
      fixture,
      chatMessages: [],
      channelMessages: [],
      threadRoots: {},
      threadReplies: {},
    });
    outboundRequests.splice(0, outboundRequests.length);
    outboundRequests.reactions.splice(0, outboundRequests.reactions.length);
    const activity = teamsPersonalMessageActivity({
      fixture,
      id: teamsFixtureExternalId(fixture, "activity-deduplicated"),
      text: "run this Teams task once",
    });

    for (const attempt of [1, 2]) {
      const response = await postTeamsActivity({
        activity,
        token: teamsToken(),
      });
      expect(response.status, `attempt ${attempt}`).toBe(200);
      await readTeamsBotResponseAndFlush(response);
    }

    const matchingRuns = (
      await runsApi.listAgentRuns(actor, { limit: 20 })
    ).runs.filter((run) => {
      return run.prompt === "run this Teams task once";
    });
    expect(matchingRuns).toHaveLength(1);
    expect(outboundRequests).toHaveLength(1);
    expect(outboundRequests[0]).toMatchObject({
      body: {
        type: "typing",
        channelData: { tenant: { id: fixture.teamsTenantId } },
      },
    });
    expect(outboundRequests.reactions).toHaveLength(0);

    const run = matchingRuns[0];
    if (!run) {
      throw new Error("Expected the deduplicated Teams run");
    }
    await runsApi.requestCancelRun(actor, run.id, [200]);
  });

  it.each(["channel", "thread"] as const)(
    "dispatches a connected Teams %s message with its context",
    async (surface) => {
      const fixture = await trackTeamsFixture(
        Promise.resolve(teamsConnectFixture()),
      );
      const rootDispatchId = teamsFixtureExternalId(fixture, "root-dispatch");
      const contextActivityId = teamsFixtureExternalId(
        fixture,
        "activity-context",
      );
      const contextFileActivityId = teamsFixtureExternalId(
        fixture,
        "activity-context-file-only",
      );
      const dispatchActivityId = teamsFixtureExternalId(
        fixture,
        "activity-dispatch",
      );
      const channelContextActivityId = teamsFixtureExternalId(
        fixture,
        "activity-channel-context",
      );
      const priorChannelMessageId = teamsFixtureExternalId(
        fixture,
        "channel-prior",
      );
      const futureChannelMessageId = teamsFixtureExternalId(
        fixture,
        "channel-future",
      );
      const mentionedUserId = teamsFixtureExternalId(fixture, "29:user-grace");
      const planAttachmentId = teamsFixtureExternalId(
        fixture,
        "teams-file-plan",
      );
      const checklistAttachmentId = teamsFixtureExternalId(
        fixture,
        "teams-file-checklist",
      );
      const currentAttachmentId = teamsFixtureExternalId(
        fixture,
        "teams-file-current",
      );
      const actor = authOrgApi.user({
        userId: fixture.userId,
        orgId: fixture.orgId,
        orgRole: "org:admin",
      });
      const runnerGroup = runsApi.configureRunnerGroup();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      authOrgApi.acceptAgentStorageWrites();
      runsApi.acceptStorageDownloads();
      runsApi.acceptTelemetryIngest();
      const defaultAgent = await authOrgApi.bootstrapLimitedFreeOnboarding(
        actor,
        {
          displayName: "Teams default agent",
        },
      );
      await authOrgApi.updateAgentMetadata(actor, defaultAgent.body.agentId, {
        visibility: "public",
      });
      await runsApi.grantProEntitlement(actor);
      await runsApi.ensureOrgModelProvider(actor);
      botFrameworkHandlers();
      const outboundRequests = teamsOutboundHandlers(fixture.serviceUrl);

      const installResponse = await postTeamsActivity({
        activity: teamsMessageActivity(fixture),
        token: teamsToken(),
      });
      expect(installResponse.status).toBe(200);
      await installResponse.json();
      await flushWaitUntilForTest();
      await connectTeamsFixture(fixture);
      outboundRequests.splice(0, outboundRequests.length);
      outboundRequests.reactions.splice(0, outboundRequests.reactions.length);

      const channelMessages: TeamsGraphMessageFixture[] = [];
      const threadRoots: Record<string, TeamsGraphMessageFixture> = {
        [rootDispatchId]: {
          id: rootDispatchId,
          text: "remember the deployment target",
          createdDateTime: "2026-06-30T09:10:00.000Z",
          senderId: fixture.teamsUserId,
          graphUserPrincipalName: fixture.teamsUserPrincipalName,
        },
      };
      const threadReplies: Record<string, TeamsGraphMessageFixture[]> = {
        [rootDispatchId]: [
          {
            id: contextActivityId,
            text: 'confirm with <at id="0">Grace Hopper</at> that the target is staging',
            createdDateTime: "2026-06-30T09:11:00.000Z",
            senderId: fixture.teamsUserId,
            mentions: [
              {
                id: 0,
                mentionText: '<at id="0">Grace Hopper</at>',
                mentioned: {
                  user: {
                    id: mentionedUserId,
                    displayName: "Grace Hopper",
                  },
                },
              },
            ],
            attachments: [
              {
                id: planAttachmentId,
                name: "deployment-plan.pdf",
                contentType:
                  "application/vnd.microsoft.teams.file.download.info",
                content: {
                  downloadUrl: "https://files.example.test/deployment-plan.pdf",
                  fileType: "pdf",
                },
              },
            ],
          },
          {
            id: contextFileActivityId,
            text: "",
            createdDateTime: "2026-06-30T09:11:30.000Z",
            senderId: fixture.teamsUserId,
            attachments: [
              {
                id: checklistAttachmentId,
                name: "release-checklist.txt",
                contentType:
                  "application/vnd.microsoft.teams.file.download.info",
                content: {
                  downloadUrl:
                    "https://files.example.test/release-checklist.txt",
                  fileType: "txt",
                },
              },
            ],
          },
          {
            id: dispatchActivityId,
            text: "ship the Teams dispatch",
            createdDateTime: "2026-06-30T09:12:00.000Z",
            senderId: fixture.teamsUserId,
          },
        ],
      };
      const graphRequests = teamsGraphHistoryHandlers({
        fixture,
        channelMessages,
        threadRoots,
        threadReplies,
      });

      if (surface === "channel") {
        channelMessages.push(
          {
            id: channelContextActivityId,
            text: "start another topic",
            createdDateTime: "2026-06-30T09:12:00.000Z",
            senderId: fixture.teamsUserId,
          },
          {
            id: priorChannelMessageId,
            text: "api channel planning",
            createdDateTime: "2026-06-30T09:09:00.000Z",
            senderId: fixture.teamsUserId,
          },
          {
            id: futureChannelMessageId,
            text: "future channel topic",
            createdDateTime: "2026-06-30T09:13:00.000Z",
            senderId: fixture.teamsUserId,
          },
        );

        const channelContextResponse = await postTeamsActivity({
          activity: teamsMessageActivity(fixture, {
            id: channelContextActivityId,
            replyToId: null,
            text: "<at>Nova</at>",
          }),
          token: teamsToken(),
        });
        expect(channelContextResponse.status).toBe(200);
        const channelContextBody = await readTeamsBotResponseAndFlush(
          channelContextResponse,
        );
        expect(channelContextBody).not.toHaveProperty("dispatch");
        expect(outboundRequests).toHaveLength(0);
        expect(outboundRequests.reactions).toStrictEqual([
          {
            method: "PUT",
            conversationId: fixture.teamsConversationId,
            activityId: channelContextActivityId,
            reactionType: "1f4ad_thoughtballoon",
          },
        ]);
        const channelContextRunId = await runIdForPrompt(actor, "@Nova");
        await runsApi.heartbeatRunner(runnerGroup);
        const channelContextClaim =
          await runsApi.claimRunnerJob(channelContextRunId);
        const channelContextAppendSystemPrompt =
          channelContextClaim.appendSystemPrompt ?? "";
        const recentChannelContext = promptSection(
          channelContextAppendSystemPrompt,
          "# Recent Channel Messages",
        );
        expect(channelContextClaim.prompt).toBe("@Nova");
        expect(graphRequests).toContain("channel-messages");
        expect(recentChannelContext).toContain("api channel planning");
        expect(recentChannelContext).not.toContain("start another topic");
        expect(channelContextAppendSystemPrompt).not.toContain(
          "# Microsoft Teams Thread Context",
        );

        await runsApi.requestCancelRun(actor, channelContextRunId, [200]);
        await completeCancelledRun(
          channelContextRunId,
          channelContextClaim.sandboxToken,
        );
        return;
      }

      channelMessages.splice(
        0,
        channelMessages.length,
        {
          id: rootDispatchId,
          text: "remember the deployment target",
          createdDateTime: "2026-06-30T09:10:00.000Z",
          senderId: fixture.teamsUserId,
        },
        {
          id: priorChannelMessageId,
          text: "api channel planning",
          createdDateTime: "2026-06-30T09:09:00.000Z",
          senderId: fixture.teamsUserId,
        },
      );

      const response = await postTeamsActivity({
        activity: teamsMessageActivity(fixture, {
          id: dispatchActivityId,
          replyToId: rootDispatchId,
          text: "<at>Nova</at> ship the Teams dispatch",
          attachments: [
            {
              id: currentAttachmentId,
              name: "current-task.txt",
              contentType: "application/vnd.microsoft.teams.file.download.info",
              content: {
                downloadUrl: "https://files.example.test/current-task.txt",
                fileType: "txt",
              },
            },
          ],
        }),
        token: teamsToken(),
      });

      expect(response.status).toBe(200);
      const body = await readTeamsBotResponseAndFlush(response);
      expect(body).not.toHaveProperty("dispatch");
      expect(outboundRequests).toHaveLength(0);
      expect(outboundRequests.reactions).toStrictEqual([
        {
          method: "PUT",
          conversationId: fixture.teamsConversationId,
          activityId: dispatchActivityId,
          reactionType: "1f4ad_thoughtballoon",
        },
      ]);

      const dispatchRuns = await runsApi.listAgentRuns(actor, { limit: 20 });
      const dispatchRun = dispatchRuns.runs.find((run) => {
        return run.prompt.includes("ship the Teams dispatch");
      });
      if (!dispatchRun) {
        throw new Error("Expected Teams dispatch run");
      }
      const runId = dispatchRun.id;
      await runsApi.heartbeatRunner(runnerGroup);
      const claim = await runsApi.claimRunnerJob(runId);
      const appendSystemPrompt = claim.appendSystemPrompt ?? "";
      const currentUserPrompt = promptSection(
        appendSystemPrompt,
        "# Current User Info",
        "# Current Integration",
      );
      const currentIntegrationPrompt = promptSection(
        appendSystemPrompt,
        "# Current Integration",
        "# Recent Channel Messages",
      );
      const replyRecentChannelContext = promptSection(
        appendSystemPrompt,
        "# Recent Channel Messages",
        "# Microsoft Teams Thread Context",
      );
      const teamsThreadContext = promptSection(
        appendSystemPrompt,
        "# Microsoft Teams Thread Context",
      );
      expect(claim.prompt).toContain("ship the Teams dispatch");
      expect(claim.prompt).toContain(
        "[Web file] current-task.txt (text/plain)",
      );
      expect(claim.prompt).not.toContain("deployment-plan.pdf");
      expect(claim.prompt).not.toContain("release-checklist.txt");
      await expect(
        callbackStore.set(
          readAgentRunCallbacks$,
          {
            orgId: fixture.orgId,
            userId: fixture.userId,
            runId,
          },
          context.signal,
        ),
      ).resolves.toStrictEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            teamsDelivery: expect.objectContaining({
              publicBrand: "okou",
              files: expect.arrayContaining([
                expect.objectContaining({ name: "current-task.txt" }),
                expect.objectContaining({ name: "deployment-plan.pdf" }),
                expect.objectContaining({ name: "release-checklist.txt" }),
              ]),
            }),
          }),
        }),
      ]);
      expect(currentIntegrationPrompt).toContain(
        "You are currently running inside: Microsoft Teams",
      );
      expect(appendSystemPrompt).toContain(
        "Microsoft Teams messaging and files",
      );
      expect(appendSystemPrompt).toContain("okou teams --help");
      expect(appendSystemPrompt).toContain("okou teams message send -h");
      expect(appendSystemPrompt).toContain("okou teams download-file -h");
      expect(appendSystemPrompt).toContain("okou teams upload-file -h");
      expect(currentIntegrationPrompt).toContain(
        `Tenant ID: ${fixture.teamsTenantId}`,
      );
      expect(currentIntegrationPrompt).toContain(
        `Team ID: ${fixture.teamsTeamId}`,
      );
      expect(currentIntegrationPrompt).toContain(
        `Conversation ID: ${fixture.teamsConversationId}`,
      );
      expect(currentIntegrationPrompt).toContain(
        `Thread ID: ${rootDispatchId}`,
      );
      expect(currentIntegrationPrompt).not.toContain("Teams user ID:");
      expect(currentIntegrationPrompt).not.toContain("Teams display name:");
      expect(currentIntegrationPrompt).not.toContain(
        "Teams user principal name:",
      );
      expect(replyRecentChannelContext).toContain("api channel planning");
      expect(replyRecentChannelContext).not.toContain(
        "remember the deployment target",
      );
      expect(replyRecentChannelContext).not.toContain("future channel topic");
      expect(currentUserPrompt).toContain(
        `Teams user ID: ${fixture.teamsUserId}`,
      );
      expect(currentUserPrompt).toContain(
        `Teams user principal name: ${fixture.teamsUserPrincipalName}`,
      );
      expect(currentUserPrompt).toContain("Teams display name: Ada Lovelace");
      expect(teamsThreadContext).toContain(
        "The messages below are from a Microsoft Teams conversation",
      );
      expect(teamsThreadContext).toContain("- RELATIVE_INDEX: -1");
      expect(teamsThreadContext).toContain(
        `- SENDER: {id: ${fixture.teamsUserId}, name: Ada Lovelace, email: ${fixture.teamsUserPrincipalName}}`,
      );
      expect(teamsThreadContext).toContain("remember the deployment target");
      expect(teamsThreadContext).toContain(
        `confirm with @Grace Hopper (${mentionedUserId}) that the target is staging`,
      );
      expect(teamsThreadContext).toContain(
        "[Teams file] deployment-plan.pdf (application/pdf)",
      );
      expect(teamsThreadContext).toContain(
        `[Teams attachment ID] ${planAttachmentId}`,
      );
      expect(teamsThreadContext).toContain(
        "[Teams file] release-checklist.txt (text/plain)",
      );
      expect(teamsThreadContext).toContain(
        `[Teams attachment ID] ${checklistAttachmentId}`,
      );
      expect(teamsThreadContext).not.toContain("ship the Teams dispatch");
      expect(graphRequests).toContain(`thread-root:${rootDispatchId}`);
      expect(graphRequests).toContain(`thread-replies:${rootDispatchId}`);
      expect(graphRequests).toContain(`user:${fixture.teamsUserId}`);
      await runsApi.requestCancelRun(actor, runId, [200]);
      await completeCancelledRun(runId, claim.sandboxToken);
    },
  );

  it("includes recent Teams personal messages in the run context", async () => {
    const { fixture, actor, runnerGroup, outboundRequests } =
      await setupConnectedTeamsBotActor();
    const personalChatId = `19:${teamsFixtureExternalId(
      fixture,
      "personal-test",
    )}@unq.gbl.spaces`;
    const currentActivityId = teamsFixtureExternalId(
      fixture,
      "activity-personal-thread-current",
    );
    const graphRequests = teamsGraphHistoryHandlers({
      fixture,
      teamsAppId: BOT_APP_ID,
      personalChatId,
      chatMessages: [
        {
          id: currentActivityId,
          text: "continue this private task",
          createdDateTime: "2026-06-30T09:13:00.000Z",
          senderId: fixture.teamsUserId,
        },
        {
          id: teamsFixtureExternalId(
            fixture,
            "activity-personal-thread-prior-reply",
          ),
          text: "the target is staging",
          createdDateTime: "2026-06-30T09:12:00.000Z",
          senderId: fixture.teamsUserId,
        },
        {
          id: teamsFixtureExternalId(
            fixture,
            "activity-unrelated-personal-root",
          ),
          text: "unrelated private task",
          createdDateTime: "2026-06-30T09:11:00.000Z",
          senderId: fixture.teamsUserId,
        },
        {
          id: teamsFixtureExternalId(fixture, "activity-personal-thread-root"),
          text: "remember the private deployment target",
          createdDateTime: "2026-06-30T09:10:00.000Z",
          senderId: fixture.teamsUserId,
        },
      ],
      channelMessages: [],
      threadRoots: {},
      threadReplies: {},
    });
    outboundRequests.splice(0, outboundRequests.length);

    const response = await postTeamsActivity({
      activity: {
        ...teamsPersonalMessageActivity({
          fixture,
          id: currentActivityId,
          text: "continue this private task",
        }),
        channelData: {
          tenant: {
            id: fixture.teamsTenantId,
            name: fixture.teamsTenantName,
          },
        },
      },
      token: teamsToken(),
    });
    expect(response.status).toBe(200);
    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).not.toHaveProperty("dispatch");
    const runId = await runIdForPrompt(actor, "continue this private task");
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(runId);
    const threadContext = promptSection(
      claim.appendSystemPrompt ?? "",
      "# Microsoft Teams Thread Context",
    );

    expect(claim.prompt).toBe("continue this private task");
    expect(threadContext).toContain("remember the private deployment target");
    expect(threadContext).toContain("the target is staging");
    expect(threadContext).toContain("unrelated private task");
    expect(threadContext).not.toContain("continue this private task");
    expect(graphRequests).toContain(
      `personal-installed-apps:${fixture.teamsAadObjectId}`,
    );
    expect(graphRequests).toContain(
      `personal-app-chat:${fixture.teamsAadObjectId}`,
    );
    expect(graphRequests).toContain(`chat-messages:${personalChatId}`);

    await runsApi.requestCancelRun(actor, runId, [200]);
  });

  it("includes Teams thread computer use host bindings in queued agent tokens", async () => {
    const { fixture, actor, runnerGroup } = await setupConnectedTeamsBotActor();
    const threadId = teamsFixtureExternalId(
      fixture,
      "teams-computer-use-thread",
    );

    const [host, firstResponse] = await Promise.all([
      computerUseApi.startComputerUseHost(actor, {
        hostName: "Teams authorized host",
      }),
      postTeamsActivity({
        activity: teamsPersonalThreadMessageActivity({
          fixture,
          id: teamsFixtureExternalId(
            fixture,
            "activity-computer-use-authorize",
          ),
          threadId,
          text: "authorize the browser",
        }),
        token: teamsToken(),
      }),
    ]);
    expect(firstResponse.status).toBe(200);
    const firstBody = await readTeamsBotResponseAndFlush(firstResponse);
    expect(firstBody).not.toHaveProperty("dispatch");

    const firstRunId = await runIdForPrompt(actor, "authorize the browser");
    await runsApi.heartbeatRunner(runnerGroup);
    const firstClaim = await runsApi.claimRunnerJob(firstRunId);
    const firstOkouToken = firstClaim.platformEnvironment.OKOU_TOKEN;
    if (!firstOkouToken) {
      throw new Error("Claimed Teams runner job did not include OKOU_TOKEN");
    }
    const created = await computerUseApi.createComputerUseAuthorizationRequest({
      bearer: firstOkouToken,
    });
    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    await computerUseApi.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      host.hostId,
    );
    await runsApi.requestCancelRun(actor, firstRunId, [200]);
    await completeCancelledRun(firstRunId, firstClaim.sandboxToken);

    const secondResponse = await postTeamsActivity({
      activity: teamsPersonalThreadMessageActivity({
        fixture,
        id: teamsFixtureExternalId(fixture, "activity-computer-use-resume"),
        threadId,
        text: "use the browser",
      }),
      token: teamsToken(),
    });
    expect(secondResponse.status).toBe(200);
    const secondBody = await readTeamsBotResponseAndFlush(secondResponse);
    expect(secondBody).not.toHaveProperty("dispatch");

    const secondRunId = await runIdForPrompt(actor, "use the browser");
    await runsApi.heartbeatRunner(runnerGroup);
    const secondClaim = await runsApi.claimRunnerJob(secondRunId);
    const secondOkouToken = secondClaim.platformEnvironment.OKOU_TOKEN;
    if (!secondOkouToken) {
      throw new Error("Claimed Teams runner job did not include OKOU_TOKEN");
    }
    const okouAuth = verifyOkouToken(secondOkouToken);
    expect(okouAuth).toMatchObject({ computerUseHostId: host.hostId });
    expect(okouAuth?.capabilities).toContain("computer-use:write");

    await runsApi.requestCancelRun(actor, secondRunId, [200]);
    await computerUseApi.stopComputerUseHost(host.hostToken);
  });

  it("asks connected Teams users to configure a default agent", async () => {
    const fixture = await trackTeamsFixture(
      Promise.resolve(teamsConnectFixture()),
    );
    const activityId = teamsFixtureExternalId(fixture, "activity-no-default");
    botFrameworkHandlers();
    const outboundRequests = teamsOutboundHandlers(fixture.serviceUrl);

    const installResponse = await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });
    expect(installResponse.status).toBe(200);
    await installResponse.json();
    await flushWaitUntilForTest();
    await connectTeamsFixture(fixture);

    const response = await postTeamsActivity({
      activity: teamsMessageActivity(fixture, {
        id: activityId,
        text: "<at>Nova</at> hello",
      }),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const body = await readTeamsBotResponseAndFlush(response);
    expect(body).not.toHaveProperty("dispatch");
    expect(outboundRequests.at(-1)).toMatchObject({
      activityId,
      body: {
        type: "message",
        text: expect.stringContaining("No agent is configured"),
        replyToId: activityId,
      },
    });
  });

  it("normalizes a Teams bot removal activity", async () => {
    const fixture = botFixture();
    const removalActivityId = teamsFixtureExternalId(
      fixture,
      "activity-remove",
    );
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsBotRemovedActivity(fixture),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      activity: {
        kind: "bot_removed",
        reason: "members_removed",
        tenantId: fixture.teamsTenantId,
        conversationId: fixture.teamsConversationId,
        channelId: fixture.teamsChannelId,
        membersRemoved: [
          {
            id: fixture.teamsBotId,
            name: "Nova",
            aadObjectId: null,
            userPrincipalName: null,
          },
        ],
        idempotencyKey: `${fixture.teamsConversationId}:conversationUpdate:${removalActivityId}`,
      },
    });
  });

  it("cleans up installation and dependent connections on Teams bot removal", async () => {
    const fixture = await trackedBotFixture();
    botFrameworkHandlers();
    await postTeamsActivity({
      activity: teamsMessageActivity(fixture),
      token: teamsToken(),
    });
    await flushWaitUntilForTest();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
        },
      }),
      [200],
    );

    const response = await postTeamsActivity({
      activity: teamsBotRemovedActivity(fixture),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toStrictEqual({
      isInstalled: false,
      isConnected: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
      connectUrl: teamsOauthConnectUrl(fixture),
    });
  });

  it("publishes Teams status changes when an install activity refreshes a bound installation", async () => {
    const fixture = await trackedBotFixture();
    botFrameworkHandlers();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await installTeamsForTest(context.signal, fixture);
    await connectTeamsFixture(fixture);
    const actor = authOrgApi.user({
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
    });
    authOrgApi.mockClerkOrg(actor);
    await authOrgApi.requestReadOrgWithBearer(
      okouToken({ userId: fixture.userId, orgId: fixture.orgId }),
      [200],
    );
    context.mocks.ably.publish.mockClear();
    botFrameworkHandlers();

    const response = await postTeamsActivity({
      activity: teamsBotInstalledActivity(fixture),
      token: teamsToken(),
    });

    expect(response.status).toBe(200);
    await response.json();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "teams:changed",
      null,
    );
  });
});
