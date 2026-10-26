import { randomUUID } from "node:crypto";

import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { number, object, string, union } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { customConnectorsRoutes } from "../custom-connectors";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);

async function fixture(
  registration: "cimd" | "dcr" | "none",
  endpoint?: string,
) {
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  const provider = mockAutomaticMcpOAuthProvider(context, {
    registration,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(registration === "none" ? { authentication: "none" } : {}),
  });
  const bdd = createBddApi(context);
  const actor = bdd.user({ orgRole: "org:admin" });
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const definition = {
    kind: "mcp" as const,
    displayName: "Automatic preflight lifecycle",
    endpoint: provider.endpoint,
    transport: "streamable-http" as const,
    fields: [],
    headerInjections: [],
    queryInjections: [],
    authMode: "automatic" as const,
  };
  const client = setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorsContract,
  );
  const created = await accept(
    client.create({
      headers: { authorization: "Bearer clerk-session" },
      body: definition,
    }),
    [201],
  );
  return { actor, bdd, provider, connector: created.body, definition };
}

async function complete(authorizationUrl: string, issuer: string) {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected an OAuth authorization state");
  }
  const callback = await connectors.completeCustomConnectorOAuth2CallbackResult(
    {
      state,
      code: randomUUID(),
      iss: issuer,
    },
  );
  expect(callback.body.status).toBe("success");
}

describe("Automatic custom connector preflight", () => {
  it("preserves endpoint queries through OAuth discovery and connection", async () => {
    const endpoint =
      "https://automatic-mcp.example.test/server?hl=en&tag=one&tag=two&empty=&encoded=a%20b&literal=a+b";
    const { actor, connector, provider } = await fixture("cimd", endpoint);
    const started = await connectors.requestStartCustomConnectorOAuth2(
      actor,
      connector.id,
      [200],
    );
    if (started.status !== 200 || started.body.result !== "authorization") {
      throw new Error("Expected an Automatic OAuth authorization URL");
    }
    expect(
      new URL(started.body.authorizationUrl).searchParams.get("resource"),
    ).toBe(endpoint);
    await complete(started.body.authorizationUrl, provider.issuer);
    const accounts = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    expect(accounts).toHaveLength(1);
    expect(new Set(provider.endpointRequests)).toStrictEqual(
      new Set([endpoint]),
    );
    expect(provider.tokenBodies[0]?.get("resource")).toBe(endpoint);
  });

  it.each(["cimd", "dcr", "none"] as const)(
    "adds and reconnects %s accounts only for the exact user, org and definition",
    async (registration) => {
      const { actor, bdd, connector, definition, provider } =
        await fixture(registration);
      const first = await connectors.requestStartCustomConnectorOAuth2(
        actor,
        connector.id,
        [200],
      );
      if (first.status !== 200) {
        throw new Error("Expected a successful Automatic OAuth start");
      }
      if (first.body.result === "authorization") {
        await complete(first.body.authorizationUrl, provider.issuer);
      } else {
        expect(first.body.result).toBe("connected");
      }
      const [account] = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      if (!account) {
        throw new Error("Expected the publicly connected account");
      }
      const reconnect = {
        intent: "reconnect" as const,
        connectionId: account.id,
      };
      const peer = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
      const otherOrg = bdd.user({ orgRole: "org:admin" });
      const otherDefinition = await connectors.createCustomConnector(actor, {
        ...definition,
        displayName: "Another definition",
      });
      for (const [caller, definitionId, mutation] of [
        [peer, connector.id, reconnect],
        [otherOrg, connector.id, reconnect],
        [actor, otherDefinition.id, reconnect],
        [actor, connector.id, { ...reconnect, connectionId: randomUUID() }],
      ] as const) {
        const denied = await connectors.requestStartCustomConnectorOAuth2(
          caller,
          definitionId,
          [404],
          undefined,
          mutation,
        );
        expect(denied.body).toMatchObject({ error: { code: "NOT_FOUND" } });
      }
      const own = await connectors.requestStartCustomConnectorOAuth2(
        actor,
        connector.id,
        [200],
        undefined,
        reconnect,
      );
      if (own.status !== 200) {
        throw new Error("Expected a successful Automatic OAuth reconnect");
      }
      if (own.body.result === "authorization") {
        await complete(own.body.authorizationUrl, provider.issuer);
      } else {
        expect(own.body.result).toBe("connected");
      }
      await expect(
        connectors.listCustomConnectorAccounts(actor, connector.id),
      ).resolves.toMatchObject([
        { id: account.id, connectionStatus: "connected" },
      ]);
      await expect(
        connectors.listCustomConnectorAccounts(peer, connector.id),
      ).resolves.toStrictEqual([]);
    },
  );

  it.each(["cimd", "dcr", "none"] as const)(
    "rejects a definition changed while the %s provider prepares authorization",
    async (registration) => {
      const { actor, connector, definition, provider } =
        await fixture(registration);
      let changed = false;
      server.use(
        http.post(provider.endpoint, async ({ request }) => {
          const message = object({
            method: string(),
            id: union([number(), string()]).optional(),
          })
            .passthrough()
            .parse(await request.json());
          if (!changed) {
            changed = true;
            const updated = await connectors.updateCustomConnector(
              actor,
              connector.id,
              {
                ...definition,
                endpoint: "https://replacement-mcp.example.test/server",
              },
            );
            expect(updated.storageVersion).toBe(2);
          }
          if (registration === "none") {
            return message.method === "initialize"
              ? HttpResponse.json({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    serverInfo: { name: "No-auth MCP", version: "1.0.0" },
                  },
                })
              : new HttpResponse(null, { status: 202 });
          }
          return new HttpResponse(null, {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${new URL("/oauth-resource", provider.endpoint).href}", scope="read write"`,
            },
          });
        }),
      );
      const failed = await connectors.requestStartCustomConnectorOAuth2(
        actor,
        connector.id,
        [500],
      );
      expect(failed.body).toStrictEqual({ error: "Internal server error" });
      expect(provider.registrationBodies).toHaveLength(
        registration === "dcr" ? 1 : 0,
      );
      await expect(
        connectors.listCustomConnectorAccounts(actor, connector.id),
      ).resolves.toStrictEqual([]);
      await expect(
        connectors.readCustomConnector(actor, connector.id),
      ).resolves.toMatchObject({
        storageVersion: 2,
      });
    },
  );

  it.each(["cimd", "dcr"] as const)(
    "rejects %s consent after the user deletes its definition",
    async (registration) => {
      const { actor, connector, provider } = await fixture(registration);
      const authorizationUrl = await connectors.startCustomConnectorOAuth2(
        actor,
        connector.id,
      );
      const state = new URL(authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected an OAuth authorization state");
      }
      await connectors.deleteCustomConnector(actor, connector.id);
      const callback =
        await connectors.completeCustomConnectorOAuth2CallbackResult({
          state,
          code: randomUUID(),
          iss: provider.issuer,
        });
      expect(callback.body).toStrictEqual({
        status: "error",
        message: "Invalid OAuth state - please try again",
      });
      expect(provider.tokenBodies).toHaveLength(0);
      await expect(
        connectors.listCustomConnectors(actor),
      ).resolves.toStrictEqual([]);
    },
  );

  it("rejects a reconnect account deleted while its provider prepares consent", async () => {
    const { actor, connector, provider } = await fixture("cimd");
    await complete(
      await connectors.startCustomConnectorOAuth2(actor, connector.id),
      provider.issuer,
    );
    const [account] = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    if (!account) {
      throw new Error("Expected the publicly connected account");
    }
    server.use(
      http.post(provider.endpoint, async () => {
        await connectors.deleteCustomConnectorAccount(
          actor,
          connector.id,
          account.id,
        );
        return new HttpResponse(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${new URL("/oauth-resource", provider.endpoint).href}", scope="read write"`,
          },
        });
      }),
    );
    const failed = await connectors.requestStartCustomConnectorOAuth2(
      actor,
      connector.id,
      [404],
      undefined,
      { intent: "reconnect", connectionId: account.id },
    );
    expect(failed.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toStrictEqual([]);
  });

  it("rejects consent for a reconnect account deleted after authorization starts", async () => {
    const { actor, connector, provider } = await fixture("cimd");
    await complete(
      await connectors.startCustomConnectorOAuth2(actor, connector.id),
      provider.issuer,
    );
    const [account] = await connectors.listCustomConnectorAccounts(
      actor,
      connector.id,
    );
    if (!account) {
      throw new Error("Expected the publicly connected account");
    }
    const authorizationUrl = await connectors.startCustomConnectorOAuth2(
      actor,
      connector.id,
      undefined,
      { intent: "reconnect", connectionId: account.id },
    );
    const state = new URL(authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected an OAuth authorization state");
    }
    await connectors.deleteCustomConnectorAccount(
      actor,
      connector.id,
      account.id,
    );
    const callback =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state,
        code: randomUUID(),
        iss: provider.issuer,
      });
    expect(callback.body).toMatchObject({ status: "error" });
    await expect(
      connectors.listCustomConnectorAccounts(actor, connector.id),
    ).resolves.toStrictEqual([]);
  });
});
