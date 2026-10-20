import { randomUUID } from "node:crypto";

import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { builtinConnectorOauthDeviceAuthSessionContract } from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorOAuth2Contract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectedConnectorsRoutes } from "../connected-connectors";
import { builtinConnectorsOauthDeviceAuthRoutes } from "../connectors-oauth-device-auth";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import {
  mockAutomaticMcpOAuthProvider,
  mockStripeCliDashboardAuth,
} from "./helpers/api-bdd-connectors";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

test.each(["builtin", "custom"] as const)(
  "%s connected directory includes saved accounts when the default requires reconnect",
  async (kind) => {
    const startedAt = now();
    // Issue the original grant in the past so both database and application
    // expiry checks see an expired token, without waiting for wall-clock time.
    mockNow(
      startedAt - (kind === "builtin" ? 91 * 24 * 60 * 60 * 1000 : 120_000),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const mocks = createRouteMocks(context);
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkMembership(
      context,
      { userId, orgId, orgRole: "org:admin", email: "connected@example.test" },
      "org:admin",
    );
    const app = await setupApp({
      context,
      isolatePg: true,
      routes: [
        ...connectedConnectorsRoutes,
        ...connectorAccountRoutes,
        ...connectorCatalogRoutes,
        ...builtinConnectorsOauthDeviceAuthRoutes,
        ...customConnectorsRoutes,
        ...customConnectorOAuth2Routes,
      ],
    });
    const provider = mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      initialExpiresIn: 60,
      omitRefreshToken: true,
    });
    mockStripeCliDashboardAuth();
    const headers = { authorization: "Bearer clerk-session" };
    const accounts = app(connectorAccountsContract);
    let target: ConnectorAccountTarget = {
      kind: "builtin",
      connectorSlug: "stripe",
    };
    if (kind === "custom") {
      const definition = await accept(
        app(customConnectorsContract).create({
          headers,
          body: {
            kind: "mcp",
            displayName: "Saved automatic accounts",
            endpoint: provider.endpoint,
            transport: "streamable-http",
            fields: [],
            headerInjections: [],
            queryInjections: [],
            authMode: "automatic",
          },
        }),
        [201],
      );
      target = { kind: "custom", customConnectorId: definition.body.id };
    }

    async function connect(displayName: string) {
      const account = { intent: "add" as const, displayName };
      if (target.kind === "builtin") {
        const auth = app(builtinConnectorOauthDeviceAuthSessionContract);
        const issuedAt = now();
        const started = await accept(
          auth.create({
            headers,
            params: { connectorSlug: target.connectorSlug },
            body: { authMethod: "cli", account, options: { mode: "live" } },
          }),
          [200],
        );
        mockNow(issuedAt + started.body.interval * 1000 + 1);
        const completed = await accept(
          auth.poll({
            headers,
            params: {
              connectorSlug: target.connectorSlug,
              sessionId: started.body.sessionId,
            },
            body: { sessionToken: started.body.sessionToken },
          }),
          [200],
        );
        if (completed.body.status !== "complete") {
          throw new Error("Expected completed Stripe CLI authorization");
        }
        return completed.body.connector.id;
      }
      const started = await accept(
        app(customConnectorOAuth2Contract).start({
          headers,
          params: { id: target.customConnectorId },
          body: { account },
        }),
        [200],
      );
      if (started.body.result !== "authorization") {
        throw new Error("Expected automatic OAuth authorization");
      }
      const state = new URL(started.body.authorizationUrl).searchParams.get(
        "state",
      );
      if (!state) {
        throw new Error("Expected OAuth state");
      }
      const query = {
        state,
        code: randomUUID(),
        iss: provider.issuer,
        responseMode: "json" as const,
      };
      const completed = await accept(
        app(customConnectorOAuth2Contract).callback({ query }),
        [200],
      );
      expect(completed.body.status).toBe("success");
      return (
        await accept(
          accounts.oauthCompletion({
            headers,
            params: { attemptId: started.body.oauthAttemptId },
            query: target,
          }),
          [200],
        )
      ).body.connectionId;
    }

    const originalDefault = await connect("Original default");
    mockNow(startedAt);
    const savedBriefs = (
      await accept(app(connectedConnectorsContract).list({ headers }), [200])
    ).body;
    expect(savedBriefs).toStrictEqual({
      builtinConnectors:
        target.kind === "builtin"
          ? [expect.objectContaining({ slug: target.connectorSlug })]
          : [],
      customConnectors:
        target.kind === "custom"
          ? [expect.objectContaining({ id: target.customConnectorId })]
          : [],
    });
    const work = await connect("Work");
    const personal = await connect("Personal");
    const listed = await accept(
      accounts.connections({ headers, query: target }),
      [200],
    );
    expect(listed.body.connections).toHaveLength(3);
    expect(
      listed.body.connections.filter((account) => {
        return account.connectionStatus === "connected";
      }),
    ).toHaveLength(2);
    if (target.kind === "builtin") {
      const catalog = await accept(
        app(connectorCatalogContract).get({
          headers,
          params: { connectorSlug: target.connectorSlug },
        }),
        [200],
      );
      expect(catalog.body.connector).toMatchObject({
        connected: true,
        connectionStatus: "reconnect-required",
      });
    } else {
      const definitions = await accept(
        app(customConnectorsContract).list({ headers }),
        [200],
      );
      expect(definitions.body.connectors).toMatchObject([
        { id: target.customConnectorId, connected: false },
      ]);
    }

    for (const connectionId of [work, personal]) {
      await accept(
        accounts.delete({
          headers,
          params: { connectionId },
          body: { target },
        }),
        [200],
      );
    }
    await accept(
      accounts.delete({
        headers,
        params: { connectionId: originalDefault },
        body: { target },
      }),
      [200],
    );
    expect(
      (await accept(app(connectedConnectorsContract).list({ headers }), [200]))
        .body,
    ).toStrictEqual({
      builtinConnectors: [],
      customConnectors: [],
    });
  },
);
