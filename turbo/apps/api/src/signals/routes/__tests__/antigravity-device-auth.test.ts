import { createHash, randomUUID } from "node:crypto";

import { antigravityDeviceAuthContract as contract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { antigravityDeviceAuthRoutes } from "../antigravity-device-auth";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerk = createRouteMocks(context).clerk;
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";
// MSW reads ":name" in a path string as a parameter; match by expression.
const CLOUD_CODE_METHOD =
  /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:(loadCodeAssist|fetchAvailableModels)$/;

function app() {
  return setupApp({
    context,
    routes: [...antigravityDeviceAuthRoutes, ...meModelProvidersListRoutes],
  });
}

async function enrolledMember() {
  const member = {
    orgId: createUniqueStaffOrgIdFixture(),
    userId: `user_${randomUUID()}`,
  };
  clerk.session(member.userId, member.orgId);
  await updateFeatureSwitchesForUser(context, member, {
    [FeatureSwitchKey.GeminiAntigravity]: true,
  });
  return member;
}

function configureClient() {
  mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "agy-client.example");
  mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "agy-client-secret");
}

function mockGoogle(
  token: () => Response = () => {
    return HttpResponse.json({
      access_token: "test-google-access-token",
      refresh_token: "test-google-refresh-token",
      expires_in: 3599,
      token_type: "Bearer",
    });
  },
) {
  const exchanges: URLSearchParams[] = [];
  const lookups: (string | null)[] = [];
  server.use(
    http.post(TOKEN_URL, async ({ request }) => {
      exchanges.push(new URLSearchParams(await request.text()));
      return token();
    }),
    http.get(USERINFO_URL, ({ request }) => {
      lookups.push(request.headers.get("authorization"));
      return HttpResponse.json({ id: "1234567890", email: "Member@Gmail.com" });
    }),
    // Listing a connected account reads its live plan and quota.
    http.post(CLOUD_CODE_METHOD, () => {
      return HttpResponse.json({});
    }),
  );
  return { exchanges, lookups };
}

async function start() {
  const response = await accept(
    app()(contract).start({ headers, body: {} }),
    [200],
  );
  const browserUrl = new URL(response.body.browserUrl);
  return { sessionToken: response.body.sessionToken, browserUrl };
}

function complete(sessionToken: string, authorizationCode: string) {
  return app()(contract).complete({
    headers,
    body: { sessionToken, authorizationCode },
  });
}

function redirectAddress(state: string | null, code = "4/0AeaYSHB-code") {
  const url = new URL(REDIRECT_URI);
  if (state !== null) {
    url.searchParams.set("state", state);
  }
  url.searchParams.set("code", code);
  url.searchParams.set(
    "scope",
    "email profile https://www.googleapis.com/auth/cloud-platform",
  );
  return url.toString();
}

describe("Antigravity Google sign-in", () => {
  it("is limited to staff members who opted in and needs client config", async () => {
    const member = {
      orgId: createUniqueStaffOrgIdFixture(),
      userId: `user_${randomUUID()}`,
    };
    clerk.session(member.userId, member.orgId);
    configureClient();
    await accept(app()(contract).start({ headers, body: {} }), [404]);

    await updateFeatureSwitchesForUser(context, member, {
      [FeatureSwitchKey.GeminiAntigravity]: true,
    });
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", undefined);
    const unconfigured = await accept(
      app()(contract).start({ headers, body: {} }),
      [503],
    );
    expect(unconfigured.body.error.code).toBe(
      "ANTIGRAVITY_DEVICE_AUTH_UNAVAILABLE",
    );

    clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    configureClient();
    await accept(app()(contract).start({ headers, body: {} }), [404]);
  });

  it("connects the account from the pasted redirect address", async () => {
    await enrolledMember();
    configureClient();
    const google = mockGoogle();
    const { sessionToken, browserUrl } = await start();

    expect(browserUrl.origin + browserUrl.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const params = browserUrl.searchParams;
    expect(params.get("client_id")).toBe("agy-client.example");
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")?.split(" ")).toContain(
      "https://www.googleapis.com/auth/cloud-platform",
    );
    const state = params.get("state");
    expect(state).toBeTruthy();

    const completed = await accept(
      complete(sessionToken, `  ${redirectAddress(state)}\n`),
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "antigravity",
        accountEmail: "member@gmail.com",
        isActive: true,
        needsReconnect: false,
      },
    });

    expect(google.exchanges).toHaveLength(1);
    const exchange = google.exchanges[0];
    expect(Object.fromEntries(exchange ?? [])).toMatchObject({
      grant_type: "authorization_code",
      code: "4/0AeaYSHB-code",
      redirect_uri: REDIRECT_URI,
      client_id: "agy-client.example",
      client_secret: "agy-client-secret",
    });
    const verifier = exchange?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      params.get("code_challenge"),
    );
    expect(google.lookups).toStrictEqual(["Bearer test-google-access-token"]);

    const listed = await accept(
      app()(personalModelProvidersMainContract).list({ headers }),
      [200],
    );
    expect(listed.body.modelProviders).toStrictEqual([
      expect.objectContaining({
        id: completed.body.provider.id,
        type: "antigravity",
        accountEmail: "member@gmail.com",
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(
      "test-google-refresh-token",
    );

    const replay = await accept(
      complete(sessionToken, redirectAddress(state)),
      [400],
    );
    expect(replay.body.error.message).toBe("Sign-in is not pending");
    // Listing refreshes the grant for live usage; the replay must not
    // exchange the authorization code again.
    expect(
      google.exchanges.filter((exchange) => {
        return exchange.get("grant_type") === "authorization_code";
      }),
    ).toHaveLength(1);
  });

  it("keeps the sign-in pending when an address from another sign-in is pasted", async () => {
    await enrolledMember();
    configureClient();
    const google = mockGoogle();
    const { sessionToken, browserUrl } = await start();

    const foreign = await accept(
      complete(sessionToken, redirectAddress("another-state")),
      [400],
    );
    expect(foreign.body.error.message).toBe(
      "The pasted address belongs to another sign-in",
    );
    const missingState = await accept(
      complete(sessionToken, redirectAddress(null)),
      [400],
    );
    expect(missingState.body.error.message).toBe(
      "The pasted address belongs to another sign-in",
    );
    const denied = await accept(
      complete(sessionToken, `${REDIRECT_URI}?error=access_denied`),
      [400],
    );
    expect(denied.body.error.message).toBe(
      "Google sign-in was not approved: access_denied",
    );
    expect(google.exchanges).toHaveLength(0);

    await accept(
      complete(
        sessionToken,
        redirectAddress(browserUrl.searchParams.get("state")),
      ),
      [200],
    );
    expect(google.exchanges).toHaveLength(1);
  });

  it("reports a rejected code exchange and ends that sign-in", async () => {
    await enrolledMember();
    configureClient();
    const google = mockGoogle(() => {
      return HttpResponse.json(
        { error: "invalid_grant", error_description: "Bad Request" },
        { status: 400 },
      );
    });
    const { sessionToken, browserUrl } = await start();
    const state = browserUrl.searchParams.get("state");

    const failed = await accept(
      complete(sessionToken, redirectAddress(state)),
      [503],
    );
    expect(failed.body.error.message).toContain(
      "Google token exchange failed with status 400",
    );
    expect(google.lookups).toHaveLength(0);
    await accept(complete(sessionToken, redirectAddress(state)), [400]);

    const listed = await accept(
      app()(personalModelProvidersMainContract).list({ headers }),
      [200],
    );
    expect(listed.body.modelProviders).toStrictEqual([]);
  });

  it("requires offline access", async () => {
    await enrolledMember();
    configureClient();
    mockGoogle(() => {
      return HttpResponse.json({ access_token: "test-google-access-token" });
    });
    const { sessionToken, browserUrl } = await start();

    const failed = await accept(
      complete(
        sessionToken,
        redirectAddress(browserUrl.searchParams.get("state")),
      ),
      [503],
    );
    expect(failed.body.error.message).toBe(
      "Google did not grant offline access. Sign in again.",
    );
  });

  it("cancels the pending sign-in and supersedes an earlier one", async () => {
    await enrolledMember();
    configureClient();
    const google = mockGoogle();
    const first = await start();
    const second = await start();

    await accept(
      complete(
        first.sessionToken,
        redirectAddress(first.browserUrl.searchParams.get("state")),
      ),
      [400],
    );
    await accept(
      app()(contract).cancel({
        headers,
        body: { sessionToken: second.sessionToken },
      }),
      [200],
    );
    await accept(
      complete(
        second.sessionToken,
        redirectAddress(second.browserUrl.searchParams.get("state")),
      ),
      [400],
    );
    await accept(
      app()(contract).cancel({
        headers,
        body: { sessionToken: "not-a-session" },
      }),
      [400],
    );
    expect(google.exchanges).toHaveLength(0);
  });
});
