import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { server } from "../../__tests__/test-server";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";
import {
  buildTikTokAuthorizationUrl,
  exchangeTikTokCode,
  refreshTikTokToken,
  revokeTikTokToken,
} from "../tiktok/oauth";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const PROFILE_URL = "https://open.tiktokapis.com/v2/user/info/";
const client = { clientId: "client-key", clientSecret: "client-secret" };
const token = {
  access_token: "access-one",
  refresh_token: "refresh-one",
  expires_in: 7200,
  refresh_expires_in: 15_552_000,
  open_id: "user-one",
  scope: "user.info.basic,video.list",
};

describe("TikTok OAuth", () => {
  it("authorizes with client_key, comma-separated scopes, and state", () => {
    const url = new URL(
      buildTikTokAuthorizationUrl(
        authCodeGrantFixture(["user.info.basic", "video.list"]),
        client.clientId,
        "https://app.example.com/callback",
        "csrf-state",
      ),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.tiktok.com/v2/auth/authorize/",
    );
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      client_key: "client-key",
      response_type: "code",
      redirect_uri: "https://app.example.com/callback",
      scope: "user.info.basic,video.list",
      state: "csrf-state",
    });
  });

  it("exchanges the code and identifies the account with the granted scopes", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        expect(Object.fromEntries(await request.formData())).toStrictEqual({
          client_key: "client-key",
          client_secret: "client-secret",
          code: "authorization-code",
          grant_type: "authorization_code",
          redirect_uri: "https://app.example.com/callback",
        });
        return HttpResponse.json({ ...token, scope: "user.info.basic" });
      }),
      http.get(PROFILE_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer access-one");
        expect(new URL(request.url).searchParams.get("fields")).toBe(
          "open_id,display_name",
        );
        return HttpResponse.json({
          data: { user: { open_id: "user-one", display_name: "Test creator" } },
          error: { code: "ok" },
        });
      }),
    );
    await expect(
      exchangeTikTokCode({
        ...client,
        code: "authorization-code",
        redirectUri: "https://app.example.com/callback",
      }),
    ).resolves.toStrictEqual({
      outputs: { accessToken: "access-one", refreshToken: "refresh-one" },
      expiresIn: 7200,
      scopes: ["user.info.basic"],
      userInfo: { id: "user-one", username: "Test creator", email: null },
    });
  });

  it("returns the rotated refresh token and uses provider-reported lifetimes", async () => {
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const body = Object.fromEntries(await request.formData());
        expect(body).toStrictEqual({
          client_key: "client-key",
          client_secret: "client-secret",
          grant_type: "refresh_token",
          refresh_token: "refresh-one",
        });
        return HttpResponse.json({
          ...token,
          access_token: "access-two",
          refresh_token: "refresh-two",
          expires_in: 3600,
        });
      }),
    );
    await expect(
      refreshTikTokToken(
        { ...client, refreshToken: "refresh-one" },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({
      outputs: { accessToken: "access-two", refreshToken: "refresh-two" },
      expiresIn: 3600,
      scopes: ["user.info.basic", "video.list"],
    });
  });

  it("rejects a refresh response missing its replacement token without exposing credentials", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({ ...token, refresh_token: undefined });
      }),
    );
    await expect(
      refreshTikTokToken(
        { ...client, refreshToken: "refresh-one" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Invalid TikTok token response");
  });

  it("preserves invalid_grant so an expired or revoked refresh token requires reconnection", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Refresh token expired",
          },
          { status: 400 },
        );
      }),
    );
    await expect(
      refreshTikTokToken(
        { ...client, refreshToken: "expired-token" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 400, oauthError: "invalid_grant" });
  });

  it("rejects a profile belonging to a different account", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json(token);
      }),
      http.get(PROFILE_URL, () => {
        return HttpResponse.json({
          data: { user: { open_id: "another-user", display_name: "Other" } },
          error: { code: "ok" },
        });
      }),
    );
    await expect(
      exchangeTikTokCode({
        ...client,
        code: "code",
        redirectUri: "https://app.example.com/callback",
      }),
    ).rejects.toThrow("Invalid TikTok profile response");
  });

  it("revokes the connected account's access token", async () => {
    server.use(
      http.post(
        "https://open.tiktokapis.com/v2/oauth/revoke/",
        async ({ request }) => {
          expect(Object.fromEntries(await request.formData())).toStrictEqual({
            client_key: "client-key",
            client_secret: "client-secret",
            token: "access-one",
          });
          return HttpResponse.json({});
        },
      ),
    );
    await expect(
      revokeTikTokToken(
        { ...client, accessToken: "access-one" },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });
});
