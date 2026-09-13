import {
  createSign,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from "node:crypto";

import { HttpResponse, http } from "msw";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { teamsBotRoutes } from "../../teams-bot";

const BOT_APP_ID = "00000000-0000-0000-0000-000000000001";
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const KEY_ID = "teams-test-key";
const BOT_FRAMEWORK_METADATA_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
const BOT_FRAMEWORK_KEYS_URL =
  "https://login.botframework.com/v1/.well-known/keys";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = keyPair.publicKey.export({ format: "jwk" });

export interface TeamsConnectFixture {
  readonly fixtureId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly teamsTenantId: string;
  readonly teamsTenantName: string;
  readonly teamsTeamId: string;
  readonly teamsTeamAadGroupId: string;
  readonly teamsTeamName: string;
  readonly teamsChannelId: string;
  readonly teamsConversationId: string;
  readonly teamsThreadId: string;
  readonly teamsActivityId: string;
  readonly teamsAppId: string;
  readonly teamsBotId: string;
  readonly teamsUserId: string;
  readonly teamsAadObjectId: string;
  readonly teamsUserPrincipalName: string;
  readonly serviceUrl: string;
}

export function setupTeamsConnectTestEnv(
  appUrl = "https://app.okou.test",
  apiBackendUrl = "https://api.okou.test",
): void {
  mockEnv("MICROSOFT_TEAMS_BOT_APP_ID", BOT_APP_ID);
  mockEnv("MICROSOFT_TEAMS_APP_TENANT_ID", TEAMS_APP_TENANT_ID);
  mockEnv("APP_URL", appUrl);
  mockEnv("OKOU_WEB_URL", appUrl);
  mockEnv("OKOU_API_BACKEND_URL", apiBackendUrl);
}

export function teamsConnectFixture(
  overrides: Partial<TeamsConnectFixture> = {},
): TeamsConnectFixture {
  const fixtureId = overrides.fixtureId ?? randomUUID().replace(/-/g, "");
  return {
    fixtureId,
    orgId: overrides.orgId ?? `org_teams_${fixtureId}`,
    userId: overrides.userId ?? `user_teams_${fixtureId}`,
    teamsTenantId: overrides.teamsTenantId ?? `tenant_${fixtureId}`,
    teamsTenantName: overrides.teamsTenantName ?? "Test Tenant",
    teamsTeamId: overrides.teamsTeamId ?? `team_${fixtureId}`,
    teamsTeamAadGroupId:
      overrides.teamsTeamAadGroupId ?? `team-aad-${fixtureId}`,
    teamsTeamName: overrides.teamsTeamName ?? "Test Team",
    teamsChannelId:
      overrides.teamsChannelId ?? `19:channel-${fixtureId}@thread.tacv2`,
    teamsConversationId:
      overrides.teamsConversationId ??
      `19:conversation-${fixtureId}@thread.tacv2`,
    teamsThreadId: overrides.teamsThreadId ?? `root-${fixtureId}`,
    teamsActivityId: overrides.teamsActivityId ?? `activity-${fixtureId}`,
    teamsAppId: overrides.teamsAppId ?? `teams-app-${fixtureId}`,
    teamsBotId: overrides.teamsBotId ?? `28:bot-${fixtureId}`,
    teamsUserId: overrides.teamsUserId ?? `29:user-${fixtureId}`,
    teamsAadObjectId: overrides.teamsAadObjectId ?? `aad-user-${fixtureId}`,
    teamsUserPrincipalName:
      overrides.teamsUserPrincipalName ?? `user-${fixtureId}@example.test`,
    serviceUrl: overrides.serviceUrl ?? SERVICE_URL,
  };
}

export function teamsFixtureExternalId(
  fixture: TeamsConnectFixture,
  prefix: string,
): string {
  return `${prefix}-${fixture.fixtureId}`;
}

function botFrameworkHandlers(): void {
  server.use(
    http.get(BOT_FRAMEWORK_METADATA_URL, () => {
      return HttpResponse.json({
        issuer: "https://api.botframework.com",
        jwks_uri: BOT_FRAMEWORK_KEYS_URL,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }),
    http.get(BOT_FRAMEWORK_KEYS_URL, () => {
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
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
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

function teamsToken(): string {
  const seconds = Math.floor(now() / 1000);
  return signJwt({
    privateKey: keyPair.privateKey,
    payload: {
      iss: "https://api.botframework.com",
      aud: BOT_APP_ID,
      exp: seconds + 600,
      nbf: seconds - 30,
      serviceurl: SERVICE_URL,
    },
  });
}

export function teamsMessageActivityForTest(
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

export async function postTeamsActivityForTest(args: {
  readonly signal: AbortSignal;
  readonly activity: Record<string, unknown>;
}): Promise<Response> {
  mockEnv("MICROSOFT_TEAMS_BOT_APP_ID", BOT_APP_ID);
  botFrameworkHandlers();
  const appSignal = AbortSignal.any([args.signal]);
  const app = createAppWithRoutes({
    signal: appSignal,
    routes: teamsBotRoutes,
  });
  return await app.request("https://api.okou.ai/api/webhooks/teams/bot", {
    method: "POST",
    headers: {
      authorization: `Bearer ${teamsToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args.activity),
  });
}

export async function installTeamsForTest(
  signal: AbortSignal,
  fixture: TeamsConnectFixture,
): Promise<void> {
  const response = await postTeamsActivityForTest({
    signal,
    activity: teamsMessageActivityForTest(fixture, {
      id: teamsFixtureExternalId(fixture, "activity-install-seed"),
      text: "installation seed",
      entities: [],
      replyToId: null,
    }),
  });
  if (!response.ok) {
    throw new Error(`Teams install seed failed with ${response.status}`);
  }
}

export async function removeTeamsForTest(
  signal: AbortSignal,
  fixture: TeamsConnectFixture,
): Promise<void> {
  const response = await postTeamsActivityForTest({
    signal,
    activity: teamsBotRemovedActivity(fixture),
  });
  if (!response.ok) {
    throw new Error(`Teams cleanup failed with ${response.status}`);
  }
}
