import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

import { teamsBotContract } from "@okouai/api-contracts/contracts/teams-bot";
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
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { createRouteMocks } from "./helpers/route-test";
import {
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const KEY_ID = "teams-identity-refresh-key";
const METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const KEYS_URL = "https://login.botframework.com/v1/.well-known/keys";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CONNECTED_TEXT =
  "You're already connected to Okou. Mention @Nova in any channel or send a DM to start chatting with your agent.";
const CONNECT_TEXT =
  "Please connect your account to use Okou in this Teams workspace.";

interface Delivery {
  readonly url: string;
  readonly body: unknown;
}

function botAuthorization(fixture: TeamsConnectFixture): string {
  const seconds = Math.floor(now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: KEY_ID }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.botframework.com",
      aud: BOT_APP_ID,
      exp: seconds + 600,
      nbf: seconds - 30,
      serviceurl: fixture.serviceUrl,
    }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `Bearer ${header}.${payload}.${signer.sign(keyPair.privateKey).toString("base64url")}`;
}

function configureProvider(fixture: TeamsConnectFixture): Delivery[] {
  const deliveries: Delivery[] = [];
  server.use(
    http.get(METADATA_URL, () => {
      return HttpResponse.json({
        issuer: "https://api.botframework.com",
        jwks_uri: KEYS_URL,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }),
    http.get(KEYS_URL, () => {
      return HttpResponse.json({
        keys: [
          {
            ...keyPair.publicKey.export({ format: "jwk" }),
            kid: KEY_ID,
            use: "sig",
            alg: "RS256",
            endorsements: ["msteams"],
          },
        ],
      });
    }),
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
      () => {
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
  );
  return deliveries;
}

async function postActivity(
  fixture: TeamsConnectFixture,
  body: Record<string, unknown>,
) {
  const response = await accept(
    setupApp({ context, routes: teamsBotRoutes })(teamsBotContract).post({
      extraHeaders: { authorization: botAuthorization(fixture) },
      body,
    }),
    [200],
  );
  await flushWaitUntilForTest();
  expect(response.body.ok).toBeTruthy();
  return response.body;
}

function setupIdentityFixture(withAad: boolean) {
  const fixture = teamsConnectFixture({ teamsAppId: BOT_APP_ID });
  const owner = createFixtureOperationOwner(async () => {
    await flushWaitUntilForTest();
    await removeTeamsForTest(context.signal, fixture);
    await flushWaitUntilForTest();
  });
  return owner.run(async () => {
    setupTeamsConnectTestEnv();
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "teams-test-password");
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const deliveries = configureProvider(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    await postActivity(
      fixture,
      teamsMessageActivityForTest(fixture, {
        text: "installation seed",
        entities: [],
        replyToId: null,
      }),
    );
    const client = setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
    const connected = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          ...(withAad ? { teamsAadObjectId: fixture.teamsAadObjectId } : {}),
        },
      }),
      [200],
    );
    expect(connected.body).toMatchObject({ success: true, role: "admin" });
    const status = await accept(
      client.getStatus({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      tenantId: fixture.teamsTenantId,
    });
    return { fixture, deliveries, run: owner.run };
  });
}

async function personalConnect(
  fixture: TeamsConnectFixture,
  sender: { readonly id: string; readonly aadObjectId?: string },
) {
  const activityId = randomUUID();
  const conversationId = `personal-${fixture.fixtureId}`;
  const response = await postActivity(
    fixture,
    teamsMessageActivityForTest(fixture, {
      id: activityId,
      conversation: { id: conversationId, conversationType: "personal" },
      channelData: { tenant: { id: fixture.teamsTenantId } },
      from: sender,
      text: "/connect",
      entities: [],
      replyToId: null,
    }),
  );
  expect(response.activity).toMatchObject({
    kind: "message",
    sender: { id: sender.id, aadObjectId: sender.aadObjectId ?? null },
    text: "/connect",
  });
  return { activityId, conversationId, connectUrl: response.connectUrl };
}

type PersonalReply = Awaited<ReturnType<typeof personalConnect>>;

function connectedReply(
  fixture: TeamsConnectFixture,
  reply: PersonalReply,
): Delivery {
  return {
    url: `${fixture.serviceUrl}v3/conversations/${reply.conversationId}/activities/${reply.activityId}`,
    body: {
      type: "message",
      text: CONNECTED_TEXT,
      textFormat: "markdown",
      replyToId: reply.activityId,
      channelData: { tenant: { id: fixture.teamsTenantId } },
    },
  };
}

function expectConnectPrompt(
  deliveries: readonly Delivery[],
  fixture: TeamsConnectFixture,
  reply: PersonalReply,
  teamsUserId: string,
): void {
  if (!reply.connectUrl) {
    throw new Error("Expected a public Teams connect URL");
  }
  const connectUrl = new URL(reply.connectUrl);
  expect(connectUrl.origin).toBe("https://app.okou.test");
  expect(connectUrl.pathname).toBe("/settings/teams");
  expect(connectUrl.searchParams.get("tenantId")).toBe(fixture.teamsTenantId);
  expect(connectUrl.searchParams.get("teamsUserId")).toBe(teamsUserId);
  expect(connectUrl.searchParams.has("teamsAadObjectId")).toBeFalsy();
  expect(deliveries).toContainEqual({
    url: `${fixture.serviceUrl}v3/conversations/${reply.conversationId}/activities/${reply.activityId}`,
    body: {
      type: "message",
      summary: CONNECT_TEXT,
      replyToId: reply.activityId,
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
            body: [{ type: "TextBlock", text: CONNECT_TEXT, wrap: true }],
            actions: [
              {
                type: "Action.OpenUrl",
                title: "Connect",
                url: reply.connectUrl,
              },
            ],
          },
        },
      ],
      channelData: { tenant: { id: fixture.teamsTenantId } },
    },
  });
}

describe("Teams identity refresh through signed personal messages", () => {
  it("replaces a connected non-null Teams ID when the same AAD sends a new ID", async () => {
    const { fixture, deliveries, run } = await setupIdentityFixture(true);
    await run(async () => {
      const originalIdOnly = await personalConnect(fixture, {
        id: fixture.teamsUserId,
      });
      expect(deliveries).toContainEqual(
        connectedReply(fixture, originalIdOnly),
      );
      const newTeamsUserId = `29:new-${fixture.fixtureId}`;
      const refreshed = await personalConnect(fixture, {
        id: newTeamsUserId,
        aadObjectId: fixture.teamsAadObjectId,
      });
      expect(deliveries).toContainEqual(connectedReply(fixture, refreshed));
      const newIdOnly = await personalConnect(fixture, { id: newTeamsUserId });
      expect(deliveries).toContainEqual(connectedReply(fixture, newIdOnly));
      const oldIdOnly = await personalConnect(fixture, {
        id: fixture.teamsUserId,
      });
      expectConnectPrompt(deliveries, fixture, oldIdOnly, fixture.teamsUserId);
    });
  });

  it("uses a connected Teams ID when AAD is unmatched or absent", async () => {
    const { fixture, deliveries, run } = await setupIdentityFixture(false);
    await run(async () => {
      const unmatchedAad = await personalConnect(fixture, {
        id: fixture.teamsUserId,
        aadObjectId: `unmatched-${fixture.fixtureId}`,
      });
      expect(deliveries).toContainEqual(connectedReply(fixture, unmatchedAad));
      const idOnly = await personalConnect(fixture, {
        id: fixture.teamsUserId,
      });
      expect(deliveries).toContainEqual(connectedReply(fixture, idOnly));
      const unknownTeamsUserId = `29:unknown-${fixture.fixtureId}`;
      const unknown = await personalConnect(fixture, {
        id: unknownTeamsUserId,
      });
      expectConnectPrompt(deliveries, fixture, unknown, unknownTeamsUserId);
    });
  });
});
