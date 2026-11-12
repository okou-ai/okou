import { randomUUID } from "node:crypto";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { settleIncludingAbort } from "../../utils";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import {
  createConnectorBddApi,
  mockCustomConnectorOAuth2Provider,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

async function scenario(
  operation:
    | "inside-basic"
    | "inside-post"
    | "outside"
    | "rotate"
    | "private-dns"
    | "redirect",
) {
  const owner = createPublicConnectorActor(context);
  owner.ownsFeatureSwitches();
  await owner.run(async () => {
    context.mocks.dns.resolve4.mockResolvedValue(["8.8.8.8"]);
    context.mocks.dns.resolve6.mockResolvedValue([]);
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    const actor = owner.actor;
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
    });
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      "org:admin",
    );
    const configs = setupApp({ context, routes: cloudflareAccessRoutes })(
      cloudflareAccessContract,
    );
    const config = (
      await accept(
        configs.create({
          headers,
          query: { view: "scoped" },
          body: {
            id: randomUUID(),
            scope: "organization",
            name: "OAuth network",
            credentials: {
              clientId: "network-client",
              clientSecret: "network-secret",
            },
          },
        }),
        [201],
      )
    ).body;
    const provider = mockCustomConnectorOAuth2Provider(context);
    const received: { headers: Headers; form: URLSearchParams }[] = [];
    server.use(
      http.post(provider.tokenUrl, async ({ request }) => {
        received.push({
          headers: request.headers,
          form: new URLSearchParams(await request.text()),
        });
        return operation === "redirect"
          ? new HttpResponse(null, {
              status: 302,
              headers: { location: "https://another.example.test/token" },
            })
          : HttpResponse.json({
              access_token: "application-token",
              refresh_token: "application-refresh",
              token_type: "Bearer",
              expires_in: 3600,
            });
      }),
    );
    const connector = await connectors.createCustomConnector(actor, {
      displayName: "Protected OAuth connector",
      kind: "http",
      prefixTemplates: [
        operation === "outside"
          ? "https://unrelated.example.test/"
          : `${new URL(provider.tokenUrl).origin}/`,
      ],
      authMode: "oauth",
      fields: [],
      queryInjections: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      networkBinding: { type: "cloudflare_access", configId: config.id },
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "application-client",
        clientSecret: "application-secret",
        authorizationUrl: provider.authorizationUrl,
        tokenUrl: provider.tokenUrl,
        tokenEndpointAuthMethod:
          operation === "inside-basic"
            ? "client_secret_basic"
            : "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {},
      },
    });
    const tested = await settleIncludingAbort(async () => {
      const authorization = new URL(
        await connectors.startCustomConnectorOAuth2AtBaseUrl(
          actor,
          connector.id,
          "https://api.okou.ai",
        ),
      );
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorization.href).not.toContain("network-secret");
      const state = authorization.searchParams.get("state");
      if (!state) {
        throw new Error("Expected an OAuth state");
      }
      if (operation === "rotate") {
        await accept(
          configs.update({
            headers,
            query: { view: "scoped" },
            params: { configId: config.id },
            body: {
              expectedRevision: config.revision,
              credentials: {
                clientId: "rotated-client",
                clientSecret: "rotated-secret",
              },
            },
          }),
          [200],
        );
      }
      if (operation === "private-dns") {
        context.mocks.dns.resolve4.mockResolvedValue(["127.0.0.1"]);
      }
      const callback =
        await connectors.completeCustomConnectorOAuth2CallbackResult(
          { code: "synthetic-code", state },
          { baseUrl: "https://api.okou.ai" },
        );
      if (
        operation === "rotate" ||
        operation === "private-dns" ||
        operation === "redirect"
      ) {
        expect(callback.body.status).toBe("error");
        await expect(
          connectors.listCustomConnectorAccounts(actor, connector.id),
        ).resolves.toStrictEqual([]);
        expect(received).toHaveLength(operation === "redirect" ? 1 : 0);
      } else {
        expect(callback.body.status).toBe("success");
        await expect(
          connectors.listCustomConnectorAccounts(actor, connector.id),
        ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
        expect(received).toHaveLength(1);
        const request = received[0];
        if (!request) {
          throw new Error("Expected a token request");
        }
        expect(request.form.get("code_verifier")).toBeTruthy();
        expect(request.form.get("code")).toBe("synthetic-code");
        if (operation === "inside-basic") {
          expect(request.headers.get("authorization")).toMatch(/^Basic /u);
          expect(request.form.has("client_secret")).toBeFalsy();
        } else {
          expect(request.form.get("client_secret")).toBe("application-secret");
        }
        expect(request.headers.get("CF-Access-Client-Secret")).toBe(
          operation === "outside" ? null : "network-secret",
        );
        expect(request.headers.get("CF-Access-Client-Id")).toBe(
          operation === "outside" ? null : "network-client",
        );
      }
      expect(
        JSON.stringify(
          await connectors.listCustomConnectorAccounts(actor, connector.id),
        ),
      ).not.toContain("network-secret");
    });
    await connectors.deleteCustomConnector(actor, connector.id);
    const preview = (
      await accept(
        configs.impactPreview({
          headers,
          params: { configId: config.id },
          query: { operation: "delete" },
        }),
        [200],
      )
    ).body;
    await accept(
      configs.delete({
        headers,
        query: { view: "scoped" },
        params: { configId: config.id },
        body: {
          expectedRevision: preview.expectedRevision,
          impactSnapshot: preview.impactSnapshot,
        },
      }),
      [204],
    );
    if (!tested.ok) {
      throw tested.error;
    }
  });
}

test.each([
  "inside-basic",
  "inside-post",
  "outside",
  "rotate",
  "private-dns",
  "redirect",
] as const)(
  "cloudflare OAuth setup preserves app authentication and current network authority: %s",
  scenario,
);

test.each([
  {
    registration: "none",
    challenge: "parameters",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "cimd",
    challenge: "parameters",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "dcr",
    challenge: "parameters",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "cimd",
    challenge: "bare",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "dcr",
    challenge: "bare",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "cimd",
    challenge: "combined",
    networkBound: false,
    protectedIssuer: false,
  },
  {
    registration: "cimd",
    challenge: "combined",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "dcr",
    challenge: "combined",
    networkBound: false,
    protectedIssuer: false,
  },
  {
    registration: "dcr",
    challenge: "combined",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "cimd",
    challenge: "quoted",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "cimd",
    challenge: "quoted-escape",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "cimd",
    challenge: "auth-param",
    networkBound: true,
    protectedIssuer: false,
  },
  {
    registration: "cimd",
    challenge: "bare",
    networkBound: true,
    protectedIssuer: true,
  },
  {
    registration: "dcr",
    challenge: "bare",
    networkBound: true,
    protectedIssuer: true,
  },
  {
    registration: "cimd",
    challenge: "bare",
    networkBound: false,
    protectedIssuer: true,
  },
  {
    registration: "dcr",
    challenge: "bare",
    networkBound: false,
    protectedIssuer: true,
  },
] as const)(
  "initializes MCP $registration with separate OAuth credentials (challenge: $challenge, Access: $networkBound, protected issuer: $protectedIssuer)",
  async ({ registration, challenge, networkBound, protectedIssuer }) => {
    const owner = createPublicConnectorActor(context);
    owner.ownsFeatureSwitches();
    await owner.run(async () => {
      context.mocks.dns.resolve4.mockResolvedValue(["8.8.8.8"]);
      context.mocks.dns.resolve6.mockResolvedValue([]);
      mockEnv("APP_URL", "https://app.okou.ai");
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      const actor = owner.actor;
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CustomConnectorCloudflareAccess]: true,
      });
      const configs = setupApp({ context, routes: cloudflareAccessRoutes })(
        cloudflareAccessContract,
      );
      const config = (
        await accept(
          configs.create({
            headers,
            query: { view: "scoped" },
            body: {
              id: randomUUID(),
              scope: "organization",
              name: "MCP network",
              credentials: {
                clientId: "network-client",
                clientSecret: "network-secret",
              },
            },
          }),
          [201],
        )
      ).body;
      const challengeHeader = {
        parameters: undefined,
        bare: undefined,
        combined: 'Digest realm="gateway", Bearer',
        quoted: 'Digest realm="quoted, Bearer"',
        "quoted-escape": 'Digest realm="escaped \\\", Bearer, inside"',
        "auth-param": 'Digest realm="gateway", bearer = "value"',
      }[challenge];
      const protectedOrigin = `https://${randomUUID()}.example.test`;
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        ...(protectedIssuer
          ? {
              endpoint: `${protectedOrigin}/`,
              issuer: protectedOrigin,
              tokenEndpoint: `${protectedOrigin}/token`,
            }
          : {}),
        ...(challenge !== "parameters"
          ? { discovery: "well-known-oidc" as const, challengeScope: null }
          : {}),
        ...(challengeHeader ? { challengeHeader } : {}),
        ...(registration === "none" ? { authentication: "none" as const } : {}),
      });
      const connector = await connectors.createCustomConnector(actor, {
        kind: "mcp",
        displayName: "Protected MCP",
        endpoint: provider.endpoint,
        transport: "streamable-http",
        authMode: "automatic",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        ...(networkBound
          ? {
              networkBinding: {
                type: "cloudflare_access" as const,
                configId: config.id,
              },
            }
          : {}),
      });
      const tested = await settleIncludingAbort(async () => {
        const start = await connectors.requestStartCustomConnectorOAuth2(
          actor,
          connector.id,
          [200],
        );
        if (start.status !== 200) {
          throw new Error("Expected successful MCP setup");
        }
        expect(provider.endpointHeaders.length).toBeGreaterThan(0);
        expect(
          provider.endpointHeaders.every((requestHeaders) => {
            return (
              requestHeaders.get("CF-Access-Client-Secret") ===
              (networkBound ? "network-secret" : null)
            );
          }),
        ).toBeTruthy();
        if (registration === "none") {
          expect(start.body.result).toBe("connected");
        } else {
          if (start.body.result !== "authorization") {
            throw new Error("Expected OAuth authorization");
          }
          const state = new URL(start.body.authorizationUrl).searchParams.get(
            "state",
          );
          if (!state) {
            throw new Error("Expected an OAuth state");
          }
          const callback =
            await connectors.completeCustomConnectorOAuth2CallbackResult({
              code: randomUUID(),
              state,
              iss: provider.issuer,
            });
          expect(callback.body.status).toBe("success");
          expect(provider.registrationBodies).toHaveLength(
            registration === "dcr" ? 1 : 0,
          );
          expect(provider.tokenHeaders).toHaveLength(1);
          expect(provider.tokenHeaders[0]?.has("CF-Access-Client-Secret")).toBe(
            networkBound && protectedIssuer,
          );
        }
        await expect(
          connectors.listCustomConnectorAccounts(actor, connector.id),
        ).resolves.toMatchObject([{ connectionStatus: "connected" }]);
        expect(
          JSON.stringify(
            await connectors.listCustomConnectorAccounts(actor, connector.id),
          ),
        ).not.toContain("network-secret");
      });
      await connectors.deleteCustomConnector(actor, connector.id);
      await accept(
        configs.delete({
          headers,
          query: { view: "scoped" },
          params: { configId: config.id },
          body: { expectedRevision: config.revision },
        }),
        [204],
      );
      if (!tested.ok) {
        throw tested.error;
      }
    });
  },
);
