import { createHash, randomUUID } from "node:crypto";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorAccountRoutes } from "../connector-accounts";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const mocks = createRouteMocks(context);
const client = setupApp({
  context,
  routes: [
    ...builtinConnectorsRoutes,
    ...builtinConnectorsSlugCallbackRoutes,
    ...connectorAccountRoutes,
  ],
});
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const providers = ["tiktok", "dropbox", "spotify"] as const;
type Provider = (typeof providers)[number];

beforeEach(() => {
  mockEnv("APP_URL", "https://app.okou.ai");
  for (const slug of providers) {
    mockOptionalEnv(`${slug.toUpperCase()}_OAUTH_CLIENT_ID`, "native-client");
    mockOptionalEnv(
      `${slug.toUpperCase()}_OAUTH_CLIENT_SECRET`,
      "server-secret",
    );
  }
});

async function actor(enabled: boolean) {
  const identity = {
    userId: `user_${randomUUID()}`,
    orgId: createUniqueStaffOrgIdFixture(),
  };
  await updateFeatureSwitchesForUser(context, identity, {
    [FeatureSwitchKey.IosConnectorAppAuthorization]: enabled,
    [FeatureSwitchKey.TikTokOAuthConnector]: true,
    [FeatureSwitchKey.SpotifyConnector]: true,
  });
  mocks.clerk.session(identity.userId, identity.orgId);
}

async function start(slug: Provider, native = true, connectionId?: string) {
  return (
    await accept(
      client(builtinConnectorOauthStartContract).start({
        headers,
        params: { connectorSlug: slug },
        body: {
          authMethod: "oauth",
          callbackTarget: "app",
          nativeCallback: "ios-https",
          ...(native ? { nativeAppAuthorization: "ios" as const } : {}),
          ...(slug === "dropbox" ? { nativeAppClientId: "native-client" } : {}),
          account: connectionId
            ? { intent: "reconnect", connectionId }
            : { intent: "add" },
        },
      }),
      [200],
    )
  ).body;
}

async function completion(slug: Provider, attemptId: string) {
  return await accept(
    client(connectorAccountsContract).oauthCompletion({
      headers,
      params: { attemptId },
      query: { kind: "builtin", connectorSlug: slug },
    }),
    [200, 404],
  );
}

function provider(slug: Provider, url: URL) {
  const tokenURLs = {
    tiktok: "https://open.tiktokapis.com/v2/oauth/token/",
    dropbox: "https://api.dropboxapi.com/oauth2/token",
    spotify: "https://accounts.spotify.com/api/token",
  };
  const scope = url.searchParams.get("scope");
  server.use(
    http.post(tokenURLs[slug], async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      expect(body.get("code")).toBe("native-code");
      expect(body.get("redirect_uri")).toBe(
        url.searchParams.get("redirect_uri"),
      );
      if (slug !== "spotify") {
        const verifier = body.get("code_verifier");
        expect(verifier).toBeTruthy();
        expect(
          createHash("sha256")
            .update(verifier!)
            .digest(slug === "tiktok" ? "hex" : "base64url"),
        ).toBe(url.searchParams.get("code_challenge"));
        expect(body.get("client_secret")).toBe("server-secret");
      } else {
        expect(body.get("code_verifier")).toBeNull();
        expect(request.headers.get("Authorization")).toBe(
          `Basic ${Buffer.from("native-client:server-secret").toString("base64")}`,
        );
      }
      return HttpResponse.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        open_id: "native-user",
        scope,
      });
    }),
  );
  if (slug === "tiktok") {
    server.use(
      http.get("https://open.tiktokapis.com/v2/user/info/", () => {
        return HttpResponse.json({
          data: {
            user: { open_id: "native-user", display_name: "Native user" },
          },
          error: { code: "ok" },
        });
      }),
    );
  } else if (slug === "dropbox") {
    server.use(
      http.post(
        "https://api.dropboxapi.com/2/users/get_current_account",
        () => {
          return HttpResponse.json({
            account_id: "native-user",
            name: { display_name: "Native user" },
          });
        },
      ),
    );
  } else {
    server.use(
      http.get("https://api.spotify.com/v1/me", () => {
        return HttpResponse.json({
          id: "native-user",
          display_name: "Native user",
        });
      }),
    );
  }
}

test.each(providers)(
  "exchanges %s native codes on the server and confirms add/reconnect to the exact account",
  async (slug) => {
    await actor(true);
    let connectionId: string | undefined;
    for (const intent of ["add", "reconnect"]) {
      const started = await start(slug, true, connectionId);
      const url = new URL(started.authorizationUrl);
      const redirect =
        slug === "dropbox"
          ? "db-native-client://2/token"
          : slug === "spotify"
            ? "ai.okou.ios://connector-provider/spotify"
            : "https://app.okou.ai/connectors/tiktok/callback";
      expect(started.nativeAppAuthorization).toMatchObject({
        provider: slug,
        callbackUrl: redirect,
      });
      expect(url.searchParams.get("redirect_uri")).toBe(redirect);
      expect(url.searchParams.get("state")).toMatch(/^ios-https-v1:/u);
      if (slug === "tiktok") {
        expect(url.searchParams.get("state")).toMatch(
          /^ios-https-v1:app-tiktok:/u,
        );
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.has("from")).toBeFalsy();
      }
      expect(started.authorizationUrl).not.toContain("server-secret");
      expect(started.authorizationUrl).not.toContain("code_verifier");
      expect((await completion(slug, started.oauthAttemptId)).status).toBe(404);
      provider(slug, url);
      const result = await accept(
        client(builtinConnectorsSlugCallbackContract).callback({
          params: { connectorSlug: slug },
          query: {
            state: url.searchParams.get("state")!,
            code: "native-code",
            responseMode: "json",
          },
        }),
        [200],
      );
      expect(result.body.status).toBe("success");
      expect(result.body.nativeAppReturn?.attemptId).toBe(
        started.oauthAttemptId,
      );
      const receipt = await completion(slug, started.oauthAttemptId);
      expect(receipt.status).toBe(200);
      if (receipt.status !== 200) {
        throw new Error("Missing completion");
      }
      if (intent === "reconnect") {
        expect(receipt.body.connectionId).toBe(connectionId);
      }
      connectionId = receipt.body.connectionId;
      const account = await accept(
        client(connectorAccountsContract).connection({
          headers,
          params: { connectionId },
          query: { kind: "builtin", connectorSlug: slug },
        }),
        [200],
      );
      expect(account.body.target).toStrictEqual({
        kind: "builtin",
        connectorSlug: slug,
      });
      expect(account.body.connectionStatus).toBe("connected");
      expect(JSON.stringify(account.body)).not.toContain("refresh-token");
    }
  },
);

test.each(providers)(
  "keeps %s web OAuth when disabled or the caller lacks native capability",
  async (slug) => {
    await actor(false);
    const disabled = await start(slug);
    expect(disabled.nativeAppAuthorization).toBeUndefined();
    expect(disabled.authorizationUrl).not.toContain("app-tiktok");
    expect(
      new URL(disabled.authorizationUrl).searchParams.get("redirect_uri"),
    ).toBe(`https://app.okou.ai/connectors/${slug}/callback`);
    await actor(true);
    expect((await start(slug, false)).nativeAppAuthorization).toBeUndefined();
  },
);

test("keeps Dropbox HTTPS authorization when the build uses a different environment's public app key", async () => {
  await actor(true);
  const response = await accept(
    client(builtinConnectorOauthStartContract).start({
      headers,
      params: { connectorSlug: "dropbox" },
      body: {
        authMethod: "oauth",
        callbackTarget: "app",
        nativeCallback: "ios-https",
        nativeAppAuthorization: "ios",
        nativeAppClientId: "different-build-key",
        account: { intent: "add" },
      },
    }),
    [200],
  );
  expect(response.body.nativeAppAuthorization).toBeUndefined();
  expect(
    new URL(response.body.authorizationUrl).searchParams.get("redirect_uri"),
  ).toBe("https://app.okou.ai/connectors/dropbox/callback");
});

test.each(providers)(
  "consumes %s denial without issuing an account completion",
  async (slug) => {
    await actor(true);
    const started = await start(slug);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const denied = await accept(
      client(builtinConnectorsSlugCallbackContract).callback({
        params: { connectorSlug: slug },
        query: { state, error: "access_denied", responseMode: "json" },
      }),
      [200],
    );
    expect(denied.body.status).toBe("error");
    expect(denied.body.nativeAppReturn?.attemptId).toBe(started.oauthAttemptId);
    expect((await completion(slug, started.oauthAttemptId)).status).toBe(404);
  },
);
