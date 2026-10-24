import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { agentConnectorAccessContract } from "@okouai/api-contracts/contracts/agent-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { agentsRoutes } from "../agents";
import { agentConnectorAccessRoutes } from "../agent-connector-access";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

test("each successful grant notifies readers when another grant is rejected", async () => {
  const headers = { authorization: "Bearer clerk-session" };
  const userId = `user_${randomUUID()}`;
  mocks.clerk.session(userId, `org_${randomUUID()}`);
  context.mocks.s3.send.mockResolvedValue({});
  const app = setupApp({
    context,
    routes: [...agentsRoutes, ...agentConnectorAccessRoutes],
  });
  const agents = await Promise.all(
    ["First agent", "Second agent"].map((displayName) => {
      return accept(
        app(agentsMainContract).create({
          headers,
          body: { displayName, visibility: "private" },
        }),
        [201],
      );
    }),
  );
  context.mocks.ably.publish.mockClear();
  context.mocks.ably.channelGet.mockClear();

  const agentIds = agents.map((agent) => {
    return agent.body.agentId;
  });
  const updates = await Promise.all(
    [randomUUID(), ...agentIds].map((agentId) => {
      return app(userBuiltinConnectorsContract).update({
        headers,
        params: { id: agentId },
        body: { enabledConnectorSlugs: ["github"], operation: "add" },
      });
    }),
  );
  expect(
    updates.map((response) => {
      return response.status;
    }),
  ).toStrictEqual([404, 200, 200]);
  expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
    [`user:${userId}`],
    [`user:${userId}`],
  ]);
  expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);
  for (const agentId of agentIds) {
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "composerAgentConnectorsChanged",
      { agentId },
    );
    const access = await accept(
      app(agentConnectorAccessContract).agent({
        headers,
        params: { id: agentId },
      }),
      [200],
    );
    expect(access.body.enabledConnectorSlugs).toContain("github");
  }
  expect(context.mocks.ably.publish).toHaveBeenCalledTimes(2);
});

test("a committed account deletion still notifies readers when provider revocation is cancelled", async () => {
  const headers = { authorization: "Bearer clerk-session" };
  const connectors = createConnectorBddApi(context);
  const actor = createBddApi(context).user();
  mockOptionalEnv("CALENDLY_OAUTH_CLIENT_ID", "calendly-test-client");
  mockOptionalEnv("CALENDLY_OAUTH_CLIENT_SECRET", "calendly-test-secret");
  server.use(
    http.post("https://auth.calendly.com/oauth/token", () => {
      return HttpResponse.json({
        token_type: "Bearer",
        access_token: "calendly-test-access",
        refresh_token: "calendly-test-refresh",
        expires_in: 7200,
      });
    }),
    http.get("https://api.calendly.com/users/me", () => {
      return HttpResponse.json({
        resource: {
          uri: `https://api.calendly.com/users/${actor.userId}`,
          name: "Connector owner",
          email: actor.email,
        },
      });
    }),
  );
  onTestFinished(async () => {
    server.use(
      http.post("https://auth.calendly.com/oauth/revoke", () => {
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const accounts = await connectors.listBuiltinConnectorAccounts(
      actor,
      "calendly",
    );
    for (const account of accounts) {
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "calendly",
        account.id,
      );
    }
  });
  const started = await connectors.startOauth(actor, "calendly", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Calendly authorization state");
  }
  const completed = await connectors.completeOauthCallbackResult("calendly", {
    state,
    code: "calendly-test-code",
  });
  expect(completed.body.status).toBe("success");
  const account = await connectors.readDefaultBuiltinAccount(actor, "calendly");
  const controller = new AbortController();
  server.use(
    http.post("https://auth.calendly.com/oauth/revoke", () => {
      controller.abort(new DOMException("Request cancelled", "AbortError"));
      return new HttpResponse(null, { status: 200 });
    }),
  );
  context.mocks.ably.publish.mockClear();
  context.mocks.ably.channelGet.mockClear();
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const client = setupApp({
    context,
    routes: connectorAccountRoutes,
    signal: AbortSignal.any([context.signal, controller.signal]),
    rethrowErrors: true,
  })(connectorAccountsContract);
  await expect(
    client.delete({
      headers,
      params: { connectionId: account.id },
      body: { target: { kind: "builtin", connectorSlug: "calendly" } },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
    `user:${actor.userId}`,
  );
  expect(context.mocks.ably.publish).toHaveBeenCalledWith("connector:changed", {
    connectorSlug: "calendly",
  });
  await expect(
    connectors.listBuiltinConnectorAccounts(actor, "calendly"),
  ).resolves.toStrictEqual([]);
  expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
});
