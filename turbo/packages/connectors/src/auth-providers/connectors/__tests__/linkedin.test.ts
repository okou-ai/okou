import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import {
  buildConnectorAuthCodeAuthorizationUrlWithMethod,
  exchangeConnectorAuthCodeWithMethod,
} from "../../connector-auth";
import { server } from "../../__tests__/test-server";

const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REDIRECT_URI = "https://app.okou.ai/connectors/linkedin/callback";
const SCOPES = ["openid", "profile", "w_member_social"];
const AUTH_CLIENT = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "synthetic-client-id",
  clientSecret: "synthetic-client-secret+/=",
} as const;

const method: ConnectorAuthMethodRuntimeConfig = {
  client: {
    clientRegistration: "static",
    clientType: "confidential",
    clientIdEnv: "LINKEDIN_OAUTH_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_OAUTH_CLIENT_SECRET",
  },
  storage: {
    version: 1,
    secrets: ["LINKEDIN_ACCESS_TOKEN"],
    variables: [],
  },
  grant: {
    kind: "auth-code",
    callbackOrigin: "web",
    scopes: SCOPES,
    outputs: { accessToken: "$secrets.LINKEDIN_ACCESS_TOKEN" },
  },
  access: {
    kind: "static",
    envBindings: { LINKEDIN_TOKEN: "$secrets.LINKEDIN_ACCESS_TOKEN" },
  },
  revoke: { kind: "none" },
};

const selection = { connectorSlug: "linkedin", authMethodId: "oauth", method };

async function exchange() {
  return await exchangeConnectorAuthCodeWithMethod({
    ...selection,
    authClient: AUTH_CLIENT,
    authorizationUrl:
      "https://www.linkedin.com/oauth/v2/authorization?scope=openid+profile+w_member_social",
    code: "synthetic-code+/=",
    redirectUri: REDIRECT_URI,
    state: "synthetic-state",
    codeVerifier: undefined,
    oauthContext: undefined,
  });
}

describe("LinkedIn managed OAuth", () => {
  it("requests self-serve publishing scopes with the exact callback and state", async () => {
    const result = await buildConnectorAuthCodeAuthorizationUrlWithMethod({
      ...selection,
      authClient: AUTH_CLIENT,
      redirectUri: REDIRECT_URI,
      state: "synthetic-state+/=",
    });
    expect(typeof result).toBe("string");
    const url = new URL(String(result));
    expect(url.origin + url.pathname).toBe(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: AUTH_CLIENT.clientId,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile w_member_social",
      state: "synthetic-state+/=",
    });
  });

  it("exchanges the code and binds the expiring access token to the OIDC member", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        expect(request.headers.get("content-type")).toBe(
          "application/x-www-form-urlencoded",
        );
        expect(
          Object.fromEntries(new URLSearchParams(await request.text())),
        ).toEqual({
          grant_type: "authorization_code",
          code: "synthetic-code+/=",
          redirect_uri: REDIRECT_URI,
          client_id: AUTH_CLIENT.clientId,
          client_secret: AUTH_CLIENT.clientSecret,
        });
        return HttpResponse.json({
          access_token: "AQsynthetic-access-token",
          expires_in: 5184000,
        });
      }),
      http.get(USERINFO_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer AQsynthetic-access-token",
        );
        return HttpResponse.json({ sub: "member-123", name: "Test Member" });
      }),
    );

    await expect(exchange()).resolves.toEqual({
      outputs: { accessToken: "AQsynthetic-access-token" },
      expiresIn: 5184000,
      scopes: SCOPES,
      userInfo: { id: "member-123", username: "Test Member", email: null },
    });
  });

  it("preserves the scopes actually reported by LinkedIn", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "AQsynthetic-access-token",
          expires_in: 3600,
          scope: "openid profile",
        });
      }),
      http.get(USERINFO_URL, () => {
        return HttpResponse.json({ sub: "member-456" });
      }),
    );

    await expect(exchange()).resolves.toEqual({
      outputs: { accessToken: "AQsynthetic-access-token" },
      expiresIn: 3600,
      scopes: ["openid", "profile"],
      userInfo: { id: "member-456", username: null, email: null },
    });
  });

  it("surfaces a rejected authorization code instead of creating a connection", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Authorization code expired",
          },
          { status: 400 },
        );
      }),
    );

    await expect(exchange()).rejects.toThrow("Authorization code expired");
  });

  it("requires a successful profile lookup before accepting the account", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "AQsynthetic-access-token",
          expires_in: 3600,
        });
      }),
      http.get(USERINFO_URL, () => {
        return new HttpResponse(null, { status: 403 });
      }),
    );

    await expect(exchange()).rejects.toMatchObject({
      status: 403,
      message: "LinkedIn userinfo request failed: 403",
    });
  });
});
