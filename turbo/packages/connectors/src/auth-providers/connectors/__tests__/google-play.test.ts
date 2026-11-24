import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { connectorAuthClientIdentity } from "../../../connector-auth-method";
import { server } from "../../__tests__/test-server";
import { googlePlayProvider } from "../google-play/provider";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const scopes = [
  "https://www.googleapis.com/auth/androidpublisher",
  "https://www.googleapis.com/auth/userinfo.email",
];
const authCodeGrant = authCodeGrantFixture(scopes);
const authClient = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-client",
  clientSecret: "test-secret",
} as const;
const redirectUri = "https://example.com/callback";

it("authorizes Android Publisher, identifies the Play account and refreshes offline access", async () => {
  const authorization = await googlePlayProvider.grant.buildAuthUrl({
    authCodeGrant,
    authClient: connectorAuthClientIdentity(authClient),
    redirectUri,
    state: "play-state",
  });
  if (typeof authorization !== "string")
    throw new Error("Expected a Google authorization URL");
  const query = new URL(authorization).searchParams;
  expect(query.get("scope")?.split(" ")).toEqual(scopes);
  expect(query.get("access_type")).toBe("offline");
  server.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (
        body.get("grant_type") === "refresh_token" &&
        body.get("refresh_token") === "test-refresh"
      ) {
        return HttpResponse.json({
          access_token: "test-fresh",
          expires_in: 3600,
        });
      }
      if (
        body.get("code") === "test-code" &&
        body.get("redirect_uri") === redirectUri
      ) {
        return HttpResponse.json({
          access_token: "test-access",
          refresh_token: "test-refresh",
          scope: scopes.join(" "),
        });
      }
      return new HttpResponse(null, { status: 400 });
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", ({ request }) => {
      return request.headers.get("authorization") === "Bearer test-access"
        ? HttpResponse.json({
            id: "play-account",
            email: "publisher@example.com",
          })
        : new HttpResponse(null, { status: 401 });
    }),
  );
  const grant = await googlePlayProvider.grant.exchangeCode({
    authCodeGrant,
    authClient,
    redirectUri,
    code: "test-code",
  });
  expect(grant).toMatchObject({
    scopes,
    outputs: { accessToken: "test-access", refreshToken: "test-refresh" },
    userInfo: { id: "play-account", email: "publisher@example.com" },
  });
  const access = await googlePlayProvider.access.refresh(
    { authClient, inputs: { refreshToken: "test-refresh" } },
    new AbortController().signal,
  );
  expect(access).toEqual({
    outputs: { accessToken: "test-fresh" },
    expiresIn: 3600,
  });
});

it("rejects consent that identifies the account without granting Play access", async () => {
  server.use(
    http.post("https://oauth2.googleapis.com/token", () => {
      return HttpResponse.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        scope: "https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v2/userinfo", () => {
      return HttpResponse.json({
        id: "play-account",
        email: "publisher@example.com",
      });
    }),
  );

  await expect(
    googlePlayProvider.grant.exchangeCode({
      authCodeGrant,
      authClient,
      redirectUri,
      code: "test-code",
    }),
  ).rejects.toThrow("Grant Google Play Developer API access");
});
