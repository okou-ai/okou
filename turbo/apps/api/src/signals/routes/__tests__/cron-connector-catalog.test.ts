import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";

const context = testContext();

/** Holds Slack's token exchange until the case releases it. */
function holdSlackTokenExchange() {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  server.use(
    http.post("https://slack.com/api/oauth.v2.access", async () => {
      markStarted();
      await released;
      return HttpResponse.json({
        ok: true,
        authed_user: {
          id: "U012AB3CD",
          access_token: `xoxp-${randomUUID()}`,
          scope: "channels:read,chat:write",
        },
      });
    }),
    http.post("https://slack.com/api/auth.revoke", () => {
      return HttpResponse.json({ ok: true, revoked: true });
    }),
  );
  return { started, release };
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Slack authorization state");
  }
  return state;
}

/** Starts Slack OAuth and completes its callback while the exchange is held. */
async function connectSlackInFlight(admin: ApiTestUser) {
  const connectors = createConnectorBddApi(context);
  mockSlackConnectorOAuth();
  const exchange = holdSlackTokenExchange();
  const started = await connectors.startOauth(admin, "slack", "oauth");
  const callback = connectors.completeOauthCallback("slack", {
    code: `code-${randomUUID()}`,
    state: stateOf(started.authorizationUrl),
  });
  await exchange.started;
  exchange.release();
  await callback;
  return await connectors.listBuiltinConnectorAccounts(admin, "slack");
}

test("cron-connector-catalog-010 (1/2) connects the Slack account once the held exchange is released", async () => {
  const admin = createBddApi(context).user({ orgRole: "org:admin" });

  const accounts = await connectSlackInFlight(admin);

  expect(accounts).toStrictEqual([
    expect.objectContaining({
      authMethod: "oauth",
      externalId: "U012AB3CD",
      connectionStatus: "connected",
    }),
  ]);
});

test("cron-connector-catalog-010 (2/2) reconnects exactly the same Slack account", async () => {
  const connectors = createConnectorBddApi(context);
  const admin = createBddApi(context).user({ orgRole: "org:admin" });
  const [connected] = await connectSlackInFlight(admin);
  if (!connected) {
    throw new Error("Expected the connected Slack account");
  }

  const reconnect = await connectors.startOauth(admin, "slack", "oauth", {
    intent: "reconnect",
    connectionId: connected.id,
  });
  await connectors.completeOauthCallback("slack", {
    code: `code-${randomUUID()}`,
    state: stateOf(reconnect.authorizationUrl),
  });

  await expect(
    connectors.listBuiltinConnectorAccounts(admin, "slack"),
  ).resolves.toStrictEqual([
    expect.objectContaining({
      id: connected.id,
      authMethod: "oauth",
      externalId: "U012AB3CD",
      connectionStatus: "connected",
    }),
  ]);
});
