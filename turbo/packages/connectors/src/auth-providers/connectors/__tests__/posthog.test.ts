import { createHash } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import { resolveConnectorAuthClient } from "../../../connector-auth-method";
import {
  type ConnectorCatalogAuthMethod,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
} from "../../../connector-catalog/artifacts/artifacts";
import {
  decodeConnectorCatalogSnapshot,
  encodeConnectorCatalogSnapshot,
} from "../../../connector-catalog/artifacts/loader";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
} from "../../../connector-catalog/compatibility";
import {
  buildConnectorAuthCodeAuthorizationUrlWithMethod,
  exchangeConnectorAuthCodeWithMethod,
  refreshConnectorAuthProviderAccessTokenWithMethod,
} from "../../connector-auth";
import { server } from "../../__tests__/test-server";

const authClient = {
  clientRegistration: "static",
  clientType: "public",
  clientId: "https://app.okou.ai/connectors/posthog/metadata.json",
} as const;
const method = {
  client: authClient,
  storage: {
    version: 2,
    secrets: ["POSTHOG_ACCESS_TOKEN", "POSTHOG_REFRESH_TOKEN"],
    variables: ["POSTHOG_BASE_URL", "POSTHOG_REGION"],
  },
  grant: {
    kind: "auth-code",
    callbackOrigin: "web",
    scopes: ["user:read", "query:read", "feature_flag:write"],
    outputs: {
      accessToken: "$secrets.POSTHOG_ACCESS_TOKEN",
      refreshToken: "$secrets.POSTHOG_REFRESH_TOKEN",
      baseUrl: "$vars.POSTHOG_BASE_URL",
      region: "$vars.POSTHOG_REGION",
    },
  },
  access: {
    kind: "refresh-token",
    envBindings: {
      POSTHOG_TOKEN: "$secrets.POSTHOG_ACCESS_TOKEN",
      POSTHOG_BASE_URL: "$vars.POSTHOG_BASE_URL",
      POSTHOG_REGION: "$vars.POSTHOG_REGION",
    },
    inputs: {
      refreshToken: "$secrets.POSTHOG_REFRESH_TOKEN",
      baseUrl: "$vars.POSTHOG_BASE_URL",
      region: "$vars.POSTHOG_REGION",
    },
    outputs: {
      accessToken: "$secrets.POSTHOG_ACCESS_TOKEN",
      refreshToken: "$secrets.POSTHOG_REFRESH_TOKEN",
    },
    refreshableSecrets: ["POSTHOG_ACCESS_TOKEN"],
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodRuntimeConfig;
const selection = { connectorSlug: "posthog", authMethodId: "oauth", method };
const redirectUri = "https://app.okou.ai/connectors/posthog/callback";
const tokenUrl = "https://oauth.posthog.com/oauth/token/";
const tokenResponse = {
  access_token: "test-posthog-access",
  refresh_token: "test-posthog-refresh-1",
  token_type: "Bearer",
  expires_in: 36000,
};

async function authorize() {
  const resolvedClient = resolveConnectorAuthClient(method.client, () => {
    return undefined;
  });
  if (!resolvedClient) {
    throw new Error("PostHog must resolve its public client without secrets");
  }
  const result = await buildConnectorAuthCodeAuthorizationUrlWithMethod({
    ...selection,
    authClient: resolvedClient,
    redirectUri,
    state: "test-state",
  });
  if (typeof result === "string" || result.codeVerifier === undefined) {
    throw new Error("PostHog must preserve a PKCE verifier");
  }
  return { url: result.url, codeVerifier: result.codeVerifier };
}

function exchange(codeVerifier: string | undefined, authorizationUrl: string) {
  return exchangeConnectorAuthCodeWithMethod({
    ...selection,
    authClient,
    authorizationUrl,
    code: "test-authorization-code",
    redirectUri,
    state: "test-state",
    codeVerifier,
    oauthContext: undefined,
  });
}

function refresh(
  region: string,
  baseUrl: string,
  refreshToken = "test-posthog-refresh-1",
  signal = new AbortController().signal,
) {
  return refreshConnectorAuthProviderAccessTokenWithMethod(
    { ...selection, authClient, inputs: { refreshToken, region, baseUrl } },
    signal,
  );
}

describe("PostHog registered CIMD OAuth provider", () => {
  it("uses the shared login endpoint with a fresh S256 challenge per attempt", async () => {
    const authorization = await authorize();
    const next = await authorize();
    const url = new URL(authorization.url);
    expect(url.origin + url.pathname).toBe(
      "https://oauth.posthog.com/oauth/authorize/",
    );
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      client_id: authClient.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state: "test-state",
      scope: "user:read query:read feature_flag:write",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(authorization.codeVerifier)
        .digest("base64url"),
    });
    expect(authorization.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(next.codeVerifier).not.toBe(authorization.codeVerifier);
  });

  it.each(["us", "eu"])(
    "exchanges with PKCE and resolves the %s account through its regional API",
    async (region) => {
      const authorization = await authorize();
      const baseUrl = `https://${region}.posthog.com`;
      server.use(
        http.post(tokenUrl, async ({ request }) => {
          expect(request.headers.get("authorization")).toBeNull();
          expect(
            Object.fromEntries(new URLSearchParams(await request.text())),
          ).toStrictEqual({
            client_id: authClient.clientId,
            grant_type: "authorization_code",
            code: "test-authorization-code",
            redirect_uri: redirectUri,
            code_verifier: authorization.codeVerifier,
          });
          return HttpResponse.json({
            ...tokenResponse,
            posthog_region: region,
            posthog_base_url: baseUrl,
            scope: "user:read query:read",
          });
        }),
        http.get(`${baseUrl}/api/users/@me/`, ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-posthog-access",
          );
          return HttpResponse.json({
            id: 42,
            first_name: "Test",
            last_name: "User",
            email: "user@example.com",
          });
        }),
      );
      expect(
        await exchange(authorization.codeVerifier, authorization.url),
      ).toMatchObject({
        outputs: {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token,
          baseUrl,
          region,
        },
        expiresIn: 36000,
        scopes: ["user:read", "query:read"],
        userInfo: {
          id: region === "us" ? "42" : "eu:42",
          username: "Test User",
          email: "user@example.com",
        },
      });
    },
  );

  it("rejects exchange without the saved verifier before requesting a token", async () => {
    const authorization = await authorize();
    await expect(exchange(undefined, authorization.url)).rejects.toThrow(
      "original PKCE code verifier",
    );
  });

  it.each([
    { posthog_region: undefined, posthog_base_url: undefined },
    { posthog_region: "ap", posthog_base_url: "https://ap.posthog.com" },
    { posthog_region: "eu", posthog_base_url: "https://us.posthog.com" },
    {
      posthog_region: "eu",
      posthog_base_url: "https://eu.posthog.com.evil.test",
    },
    { posthog_region: "eu", posthog_base_url: "https://evil.test" },
    { posthog_region: "eu", posthog_base_url: "http://eu.posthog.com" },
  ])(
    "rejects invalid token region metadata before sending a bearer token (%j)",
    async (region) => {
      const authorization = await authorize();
      server.use(
        http.post(tokenUrl, () => {
          return HttpResponse.json({ ...tokenResponse, ...region });
        }),
      );
      await expect(
        exchange(authorization.codeVerifier, authorization.url),
      ).rejects.toMatchObject({ name: "ZodError" });
    },
  );

  it.each(["us", "eu"])(
    "refreshes and rotates tokens only in the saved %s region",
    async (region) => {
      const baseUrl = `https://${region}.posthog.com`;
      const rotations: Record<string, string> = {
        "test-posthog-refresh-1": "test-posthog-refresh-2",
        "test-posthog-refresh-2": "test-posthog-refresh-3",
      };
      server.use(
        http.post(`${baseUrl}/oauth/token/`, async ({ request }) => {
          expect(request.headers.get("authorization")).toBeNull();
          const body = new URLSearchParams(await request.text());
          const refreshToken = body.get("refresh_token");
          expect(Object.fromEntries(body)).toStrictEqual({
            client_id: authClient.clientId,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          });
          const next =
            refreshToken === null ? undefined : rotations[refreshToken];
          if (next === undefined || refreshToken === null) {
            return HttpResponse.json(
              { error: "invalid_grant" },
              { status: 400 },
            );
          }
          delete rotations[refreshToken];
          return HttpResponse.json({
            ...tokenResponse,
            refresh_token: next,
            posthog_region: region,
            posthog_base_url: baseUrl,
          });
        }),
      );
      const first = await refresh(region, baseUrl);
      expect(first.outputs.refreshToken).toBe("test-posthog-refresh-2");
      expect(first.scopes).toBeUndefined();
      const second = await refresh(
        region,
        baseUrl,
        first.outputs.refreshToken!,
      );
      expect(second.outputs.refreshToken).toBe("test-posthog-refresh-3");
      await expect(refresh(region, baseUrl)).rejects.toMatchObject({
        status: 400,
        oauthError: "invalid_grant",
      });
    },
  );

  it("preserves the saved refresh token but applies an explicitly empty scope response", async () => {
    server.use(
      http.post("https://eu.posthog.com/oauth/token/", () => {
        return HttpResponse.json({
          ...tokenResponse,
          refresh_token: undefined,
          scope: "",
          posthog_region: "eu",
          posthog_base_url: "https://eu.posthog.com",
        });
      }),
    );
    const result = await refresh("eu", "https://eu.posthog.com");
    expect(result.outputs).toStrictEqual({
      accessToken: tokenResponse.access_token,
    });
    expect(result.scopes).toStrictEqual([]);
  });

  it("rejects an invalid saved API URL before sending a refresh token", async () => {
    await expect(refresh("eu", "https://evil.test")).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("rejects a refresh response for a different account region", async () => {
    server.use(
      http.post("https://eu.posthog.com/oauth/token/", () => {
        return HttpResponse.json({
          ...tokenResponse,
          posthog_region: "us",
          posthog_base_url: "https://us.posthog.com",
        });
      }),
    );
    await expect(refresh("eu", "https://eu.posthog.com")).rejects.toThrow(
      "changed the account region",
    );
  });

  it("propagates provider errors from the code exchange", async () => {
    const authorization = await authorize();
    server.use(
      http.post(tokenUrl, () => {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }),
    );
    await expect(
      exchange(authorization.codeVerifier, authorization.url),
    ).rejects.toMatchObject({
      status: 400,
      oauthError: "invalid_grant",
    });
  });

  it("cancels a refresh with its owning signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      refresh("eu", "https://eu.posthog.com", undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

function decodeCatalog(client: ConnectorCatalogAuthMethod["client"]) {
  const catalogVersion = "2099-01-01.posthog-cimd";
  const artifact = {
    artifactSchemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    catalogVersion,
    categoryMetadata: {
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    },
    connectors: [
      {
        slug: "posthog",
        label: "PostHog",
        description: "PostHog analytics",
        category: "testing",
        generation: [],
        tags: [],
        authMethods: [
          {
            ...method,
            client,
            id: "oauth",
            label: "OAuth",
            description: null,
            visible: true,
          },
        ],
        icon: { key: "connectors/posthog.svg", invertInDarkMode: false },
        skill: { kind: "none" },
        firewall: { kind: "none" },
      },
    ],
  };
  const rawBytes = Buffer.from(JSON.stringify(artifact));
  return decodeConnectorCatalogSnapshot({
    catalogGzip: encodeConnectorCatalogSnapshot(rawBytes),
    catalogRawSize: rawBytes.byteLength,
    catalogVersion,
    catalogDigest: `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`,
  }).artifact;
}

describe("PostHog catalog rollout compatibility", () => {
  it("loads a static public auth-code client without deployment credentials", () => {
    const artifact = decodeCatalog(method.client);
    expect(
      evaluateConnectorCatalogCompatibility({
        artifact,
        capability: connectorCatalogExecutableCapabilityState({
          isConfigured: () => {
            return false;
          },
        }),
      }),
    ).toStrictEqual([]);
  });

  it("accepts confidential catalog clients and filters the old PostHog contract", () => {
    const client = {
      clientRegistration: "static",
      clientType: "confidential",
      clientIdEnv: "POSTHOG_OAUTH_CLIENT_ID",
      clientSecretEnv: "POSTHOG_OAUTH_CLIENT_SECRET",
    } as const;
    const artifact = decodeCatalog(client);
    expect(artifact.connectors[0]?.authMethods[0]?.client).toStrictEqual(
      client,
    );
    expect(
      evaluateConnectorCatalogCompatibility({
        artifact,
        capability: connectorCatalogExecutableCapabilityState({
          isConfigured: () => {
            return true;
          },
        }),
      }),
    ).toStrictEqual([
      {
        connectorSlug: "posthog",
        authMethodId: "oauth",
        reasons: ["provider-contract-mismatch"],
      },
    ]);
  });

  it("rejects a dynamic public client for an auth-code grant", () => {
    expect(() => {
      return decodeCatalog({
        clientRegistration: "dynamic",
        clientType: "public",
      });
    }).toThrow("relationship-mismatch");
  });

  it("rejects an auth-code grant without a client", () => {
    expect(() => {
      return decodeCatalog(undefined);
    }).toThrow("relationship-mismatch");
  });
});
