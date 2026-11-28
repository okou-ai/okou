import { randomUUID } from "node:crypto";
import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOpenIdStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const STEAM_ID = "76561198000000000";
const STEAM_ENDPOINT = "https://steamcommunity.com/openid/login";
const STEAM_TARGET = { kind: "builtin", connectorSlug: "steam" } as const;

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return headers;
}

/** Steam's check_authentication answer; flip `valid` to model Steam rejecting assertions. */
function steamVerifies() {
  const verification = { valid: true };
  server.use(
    http.post(STEAM_ENDPOINT, () => {
      return HttpResponse.text(
        `ns:http://specs.openid.net/auth/2.0\nis_valid:${String(verification.valid)}\n`,
      );
    }),
  );
  return verification;
}

function startRequest(
  actor: ApiTestUser,
  account: ConnectorAccountMutationIntent,
  nativeCallback?: "ios-https",
) {
  return setupApp({ context, routes: builtinConnectorsRoutes })(
    builtinConnectorOpenIdStartContract,
  ).start({
    params: { connectorSlug: "steam" },
    headers: signIn(actor),
    body: {
      authMethod: "openid",
      account,
      ...(nativeCallback ? { nativeCallback } : {}),
    },
  });
}

async function start(
  actor: ApiTestUser,
  account: ConnectorAccountMutationIntent = { intent: "add" },
  nativeCallback?: "ios-https",
) {
  const response = await accept(
    startRequest(actor, account, nativeCallback),
    [200],
  );
  return response.body;
}

/** The signed `id_res` assertion Steam sends back to the advertised return URL. */
function steamAssertion(authorizationUrl: string) {
  const returnTo = new URL(authorizationUrl).searchParams.get(
    "openid.return_to",
  );
  const state = returnTo ? new URL(returnTo).searchParams.get("state") : null;
  if (!returnTo || !state) {
    throw new Error("Expected a Steam return URL with state");
  }
  const claimedId = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  return {
    state,
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_ENDPOINT,
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": returnTo,
    "openid.response_nonce": `2026-11-26T05:00:00Z${randomUUID()}`,
    "openid.assoc_handle": "1234567890",
    "openid.signed":
      "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "c2lnbmVkLWJ5LXN0ZWFt",
  };
}

function callbackClient() {
  return setupApp({ context, routes: builtinConnectorsSlugCallbackRoutes })(
    builtinConnectorsSlugCallbackContract,
  );
}

async function browserCallback(authorizationUrl: string) {
  return await accept(
    callbackClient().callback({
      params: { connectorSlug: "steam" },
      query: steamAssertion(authorizationUrl),
      headers: {},
    }),
    [307],
  );
}

function completionRequest(actor: ApiTestUser, attemptId: string) {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  ).oauthCompletion({
    headers: signIn(actor),
    params: { attemptId },
    query: STEAM_TARGET,
  });
}

async function connectSteam(actor: ApiTestUser) {
  const started = await start(actor);
  await browserCallback(started.authorizationUrl);
  return await connectors.readDefaultBuiltinAccount(actor, "steam");
}

describe("Steam OpenID connector", () => {
  it("connectors-openid.bdd-001 returns the native attempt after Steam verifies the assertion", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    steamVerifies();
    const member = bdd.user();

    const started = await start(member, { intent: "add" }, "ios-https");
    const callback = await accept(
      callbackClient().callback({
        params: { connectorSlug: "steam" },
        query: {
          ...steamAssertion(started.authorizationUrl),
          responseMode: "json",
        },
        headers: {},
      }),
      [200],
    );

    expect(started.nativeCallbackUrl).toBe(
      `https://app.okou.ai/native/connector-authorization?attemptId=${started.oauthAttemptId}`,
    );
    expect(callback.body).toMatchObject({
      status: "success",
      nativeAppReturn: {
        platform: "ios",
        attemptId: started.oauthAttemptId,
        httpsHost: "app.okou.ai",
      },
    });
  });

  it("connectors-openid.bdd-003 stores the verified SteamID from the callback", async () => {
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    steamVerifies();
    const member = bdd.user();

    const started = await start(member);
    const authorization = new URL(started.authorizationUrl);
    await browserCallback(started.authorizationUrl);
    const account = await connectors.readDefaultBuiltinAccount(member, "steam");
    const completion = await accept(
      completionRequest(member, started.oauthAttemptId),
      [200],
    );

    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      STEAM_ENDPOINT,
    );
    expect(authorization.searchParams.get("openid.realm")).toBe(
      "https://api.okou.ai/",
    );
    expect(authorization.searchParams.get("openid.return_to")).toMatch(
      /^https:\/\/api\.okou\.ai\/api\/connectors\/steam\/callback\?state=[0-9a-f]{64}$/u,
    );
    expect(completion.body).toStrictEqual({ connectionId: account.id });
    expect(account).toMatchObject({
      target: STEAM_TARGET,
      authMethod: "openid",
      connectionStatus: "connected",
      externalId: STEAM_ID,
      externalUsername: STEAM_ID,
      oauthScopes: [],
    });
  });

  it("connectors-openid.bdd-004 keeps the active account until a verified replacement succeeds", async () => {
    const verification = steamVerifies();
    const member = bdd.user();
    const original = await connectSteam(member);

    const pendingAdd = await start(member);
    const pendingCompletion = await accept(
      completionRequest(member, pendingAdd.oauthAttemptId),
      [404],
    );
    await expect(
      connectors.readDefaultBuiltinAccount(member, "steam"),
    ).resolves.toStrictEqual(original);
    verification.valid = false;
    const rejected = await browserCallback(pendingAdd.authorizationUrl);
    const errorLocation = new URL(rejected.headers.get("location") ?? "");
    await expect(
      connectors.readDefaultBuiltinAccount(member, "steam"),
    ).resolves.toStrictEqual(original);

    verification.valid = true;
    const reconnect = await start(member, {
      intent: "reconnect",
      connectionId: original.id,
    });
    const pendingReconnect = await accept(
      completionRequest(member, reconnect.oauthAttemptId),
      [404],
    );
    await expect(
      connectors.readDefaultBuiltinAccount(member, "steam"),
    ).resolves.toStrictEqual(original);
    await browserCallback(reconnect.authorizationUrl);
    const replaced = await connectors.readDefaultBuiltinAccount(
      member,
      "steam",
    );
    const reconnected = await accept(
      completionRequest(member, reconnect.oauthAttemptId),
      [200],
    );

    expect(pendingCompletion.status).toBe(404);
    expect(errorLocation.pathname).toBe("/connector/error");
    expect(errorLocation.searchParams.get("connectorSlug")).toBe("steam");
    expect(errorLocation.searchParams.get("message")).toBe(
      "OpenID authorization failed. Please try again.",
    );
    expect(pendingReconnect.body.error.message).toBe(
      "OAuth completion not found",
    );
    expect(replaced.id).toBe(original.id);
    expect(replaced.externalId).toBe(STEAM_ID);
    expect(reconnected.body).toStrictEqual({ connectionId: original.id });
  });

  it("connectors-openid.bdd-005 rejects reconnecting another user's account", async () => {
    steamVerifies();
    const owner = bdd.user();
    const other = bdd.user({ orgId: owner.orgId });
    const original = await connectSteam(owner);
    const before = await connectors.listBuiltinConnectorAccounts(
      owner,
      "steam",
    );

    const response = await accept(
      startRequest(other, { intent: "reconnect", connectionId: original.id }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Connector account not found" },
    });
    await expect(
      connectors.listBuiltinConnectorAccounts(owner, "steam"),
    ).resolves.toStrictEqual(before);
  });
});
