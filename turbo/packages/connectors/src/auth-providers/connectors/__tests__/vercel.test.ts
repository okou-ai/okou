import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { connectorCatalogAuthMethodSchema } from "../../../connector-catalog/artifacts/artifacts";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
} from "../../../connector-catalog/compatibility";
import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import { server } from "../../__tests__/test-server";
import {
  exchangeConnectorAuthCodeWithMethod,
  refreshConnectorAuthProviderAccessTokenWithMethod,
} from "../../connector-auth";

const tokenUrl = "https://api.vercel.com/v2/oauth/access_token";
const userUrl = "https://api.vercel.com/v2/user";
const installationId = "icfg_test";
const authClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-vercel-client",
  clientSecret: "test-vercel-secret",
} as const;
const legacyMethod = {
  client: {
    clientRegistration: "static",
    clientType: "confidential",
    clientIdEnv: "VERCEL_OAUTH_CLIENT_ID",
    clientSecretEnv: "VERCEL_OAUTH_CLIENT_SECRET",
  },
  storage: { version: 1, secrets: ["VERCEL_ACCESS_TOKEN"], variables: [] },
  grant: {
    kind: "auth-code",
    callbackOrigin: "web",
    scopes: [],
    outputs: { accessToken: "$secrets.VERCEL_ACCESS_TOKEN" },
  },
  access: {
    kind: "static",
    envBindings: { VERCEL_TOKEN: "$secrets.VERCEL_ACCESS_TOKEN" },
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodRuntimeConfig;
const installationMethod = {
  ...legacyMethod,
  storage: {
    ...legacyMethod.storage,
    version: 2,
    variables: ["VERCEL_INSTALLATION_ID"],
  },
  grant: {
    ...legacyMethod.grant,
    outputs: {
      ...legacyMethod.grant.outputs,
      installationId: "$vars.VERCEL_INSTALLATION_ID",
    },
  },
  access: {
    ...legacyMethod.access,
    kind: "refresh-token",
    inputs: { installationId: "$vars.VERCEL_INSTALLATION_ID" },
    outputs: { accessToken: "$secrets.VERCEL_ACCESS_TOKEN" },
    refreshableSecrets: ["VERCEL_ACCESS_TOKEN"],
  },
} as const satisfies ConnectorAuthMethodRuntimeConfig;
const installationSelection = {
  connectorSlug: "vercel",
  authMethodId: "oauth",
  method: installationMethod,
};
const shortToken = {
  access_token: "test-installation-token",
  expires_in: 3540,
  scope: "read:project read:deployment",
};
const account = {
  id: "test-vercel-user",
  username: "test-user",
  email: null,
};

function exchange(
  selection: Pick<
    Parameters<typeof exchangeConnectorAuthCodeWithMethod>[0],
    "connectorSlug" | "authMethodId" | "method"
  >,
) {
  return exchangeConnectorAuthCodeWithMethod({
    ...selection,
    authClient,
    authorizationUrl: null,
    code: "test-authorization-code",
    redirectUri: "https://app.okou.ai/api/connectors/vercel/callback",
    state: "test-state",
    codeVerifier: undefined,
    oauthContext: undefined,
  });
}

function renew() {
  return refreshConnectorAuthProviderAccessTokenWithMethod(
    { ...installationSelection, authClient, inputs: { installationId } },
    new AbortController().signal,
  );
}

describe("Vercel OAuth provider", () => {
  it.each([
    { name: "legacy", method: legacyMethod },
    { name: "installation", method: installationMethod },
  ])("accepts the $name catalog with a single OAuth method", ({ method }) => {
    expect(
      evaluateConnectorCatalogCompatibility({
        artifact: {
          connectors: [
            {
              slug: "vercel",
              authMethods: [
                connectorCatalogAuthMethodSchema.parse({
                  ...method,
                  id: "oauth",
                  label: "OAuth",
                  description: null,
                  visible: true,
                }),
              ],
            },
          ],
        },
        capability: connectorCatalogExecutableCapabilityState({
          isConfigured: () => {
            return true;
          },
        }),
      }),
    ).toEqual([]);
  });

  it("uses short-lived access for the installation captured during authorization", async () => {
    server.use(
      http.post(tokenUrl, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        if (form.has("code")) {
          return HttpResponse.json({
            access_token: "test-code-token",
            installation_id: installationId,
          });
        }
        expect(Object.fromEntries(form)).toEqual({
          grant_type: "client_credentials",
          installation_id: installationId,
          client_id: authClient.clientId,
          client_secret: authClient.clientSecret,
        });
        return HttpResponse.json(shortToken);
      }),
      http.get(userUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${shortToken.access_token}`,
        );
        return HttpResponse.json({ user: account });
      }),
    );

    await expect(exchange(installationSelection)).resolves.toEqual({
      outputs: { accessToken: shortToken.access_token, installationId },
      expiresIn: shortToken.expires_in,
      scopes: ["read:project", "read:deployment"],
      userInfo: account,
    });
    await expect(renew()).resolves.toEqual({
      outputs: { accessToken: shortToken.access_token },
      expiresIn: shortToken.expires_in,
    });
  });

  it("reports an invalid installation through the OAuth error contract", async () => {
    server.use(
      http.post(tokenUrl, () => {
        return HttpResponse.json(
          { code: "invalid_grant", message: "Provider response detail" },
          { status: 400 },
        );
      }),
    );

    await expect(renew()).rejects.toMatchObject({
      status: 400,
      oauthError: "invalid_grant",
      message: "Vercel installation token request failed: 400",
    });
  });

  it("requires an installation ID before accepting a new authorization", async () => {
    server.use(
      http.post(tokenUrl, () => {
        return HttpResponse.json({ access_token: "test-code-token" });
      }),
    );

    await expect(exchange(installationSelection)).rejects.toThrow(
      "No installation ID in Vercel authorization response",
    );
  });

  it("still exchanges and serves legacy catalog authorizations", async () => {
    server.use(
      http.post(tokenUrl, async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get("code")).toBe("test-authorization-code");
        return HttpResponse.json({ access_token: "test-legacy-token" });
      }),
      http.get(userUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-legacy-token",
        );
        return HttpResponse.json({ user: account });
      }),
    );

    await expect(
      exchange({
        connectorSlug: "vercel",
        authMethodId: "oauth",
        method: legacyMethod,
      }),
    ).resolves.toEqual({
      outputs: { accessToken: "test-legacy-token" },
      scopes: [],
      userInfo: account,
    });
  });
});
