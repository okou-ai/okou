import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const firewall = createFirewallApi(context);
const connectors = createConnectorBddApi(context);
const mocks = createRouteMocks(context);
const userHeaders = { authorization: "Bearer clerk-session" } as const;

async function admittedConfiguredMcp(
  owned: Awaited<ReturnType<typeof publicChatActor>>,
) {
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  const catalog = automaticMcpCatalogFixture("static-headers");
  const provider = mockAutomaticMcpOAuthProvider(context, {
    registration: "cimd",
    initialExpiresIn: 3600,
  });
  mocks.clerk.session(owned.actor.userId, owned.actor.orgId);
  const automatic = setupApp({
    context,
    routes: builtinConnectorsAutomaticRoutes,
  })(builtinConnectorAutomaticContract);
  const accounts = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  const started = await accept(
    automatic.start({
      headers: userHeaders,
      params: { connectorSlug: catalog.slug },
      body: {
        authMethod: catalog.methodId,
        account: { intent: "add" },
        agentId: owned.agentId,
        authorizeAgent: true,
      },
    }),
    [200],
  );
  if (started.body.result !== "authorization") {
    throw new Error("Expected Automatic OAuth authorization");
  }
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  const callback = await accept(
    automatic.callback({
      query: {
        state,
        code: "configured-header-code",
        iss: provider.issuer,
        responseMode: "json",
      },
    }),
    [200],
  );
  expect(callback.body.status).toBe("success");
  const receipt = await accept(
    accounts.oauthCompletion({
      headers: userHeaders,
      params: { attemptId: started.body.oauthAttemptId },
      query: catalog.target,
    }),
    [200],
  );
  const connectionId = receipt.body.connectionId;
  const run = await owned.sendChatRun(owned.actor, {
    agentId: owned.agentId,
    prompt: "Use the admitted configured MCP profile",
  });
  const { claim, sandboxHeaders } = await owned.claimChatRun(
    owned.runnerGroup,
    run.runId,
  );
  expect(claim.firewalls).toContainEqual({
    kind: "builtin",
    name: catalog.slug,
    sourceId: connectionId,
  });
  return {
    catalog,
    claim,
    connectionId,
    sandboxHeaders,
    body: {
      encryptedSecrets:
        claim.encryptedSecrets ?? firewall.encryptedSecretsBody({}),
      authHeaders: catalog.firewallAuthHeaders,
      matchedFirewall: {
        name: catalog.slug,
        apiId: `${catalog.slug}:0`,
        base: catalog.endpoint,
        connectorSlug: catalog.slug,
        sourceId: connectionId,
        routingVariables: {},
      },
    },
  };
}

describe("catalog-owned Automatic MCP static headers", () => {
  it("resolves the configured profile privately through refresh and denies a deleted account", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { catalog, claim, body, sandboxHeaders, connectionId } =
        await admittedConfiguredMcp(owned);
      expect(claim.environment).not.toHaveProperty("MCP_ACCESS_TOKEN");
      expect(claim.environment).not.toHaveProperty(
        "AUTOMATIC_STATIC_ACCESS_TOKEN",
      );
      expect(claim.platformEnvironment).not.toHaveProperty(
        "AUTOMATIC_STATIC_ACCESS_TOKEN",
      );
      expect(claim.secretValues).not.toContain(
        "automatic-initial-access-token",
      );

      const initial = await accept(
        firewall.requestFirewallAuth(sandboxHeaders, body, [200]),
        [200],
      );
      expect(initial.body.headers).toStrictEqual({
        Authorization: "Bearer automatic-initial-access-token",
        "X-Datadog-MCP-Toolsets": "all,cases",
        "X-Mcp-Options": "Mode=FULL; preview=v2",
      });
      const refreshed = await accept(
        firewall.requestFirewallAuth(
          sandboxHeaders,
          {
            ...body,
            forceRefresh: true,
          },
          [200],
        ),
        [200],
      );
      expect(refreshed.body.headers).toStrictEqual({
        Authorization: "Bearer automatic-refreshed-access-token",
        "X-Datadog-MCP-Toolsets": "all,cases",
        "X-Mcp-Options": "Mode=FULL; preview=v2",
      });

      await connectors.deleteBuiltinConnectorAccount(
        owned.actor,
        catalog.slug,
        connectionId,
      );
      const deleted = await accept(
        firewall.requestFirewallAuth(sandboxHeaders, body, [424]),
        [424],
      );
      expect(deleted.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
    });
  });

  it("denies omitted, changed and additional request policy without poisoning the accepted profile", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { body, sandboxHeaders } = await admittedConfiguredMcp(owned);
      const authorization = body.authHeaders.Authorization;
      if (authorization === undefined) {
        throw new Error("Expected the configured catalog OAuth bearer");
      }
      const rejectedProfiles: Record<string, string>[] = [
        { Authorization: authorization },
        { ...body.authHeaders, "X-Datadog-MCP-Toolsets": "core" },
        { ...body.authHeaders, "X-Api-Key": "caller-controlled" },
        { ...body.authHeaders, Authorization: "Bearer caller-controlled" },
        { "X-Datadog-MCP-Toolsets": "all,cases" },
      ];
      for (const authHeaders of rejectedProfiles) {
        const denied = await accept(
          firewall.requestFirewallAuth(
            sandboxHeaders,
            { ...body, authHeaders },
            [424],
          ),
          [424],
        );
        expect(denied.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
      }
      for (const extra of [
        { authQuery: { toolsets: "all" } },
        { authBase: "https://other.example.test/mcp" },
      ]) {
        const denied = await accept(
          firewall.requestFirewallAuth(
            sandboxHeaders,
            { ...body, ...extra },
            [424],
          ),
          [424],
        );
        expect(denied.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
      }
      const wrongSource = await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          ...body,
          matchedFirewall: { ...body.matchedFirewall, sourceId: randomUUID() },
        },
        [403, 424],
      );
      expect(wrongSource.status).not.toBe(200);

      const accepted = await accept(
        firewall.requestFirewallAuth(sandboxHeaders, body, [200]),
        [200],
      );
      expect(accepted.body.headers).toStrictEqual({
        Authorization: "Bearer automatic-initial-access-token",
        "X-Datadog-MCP-Toolsets": "all,cases",
        "X-Mcp-Options": "Mode=FULL; preview=v2",
      });
    });
  });
});
