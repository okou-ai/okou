import { createHash, randomUUID } from "node:crypto";

import { antigravityDeviceAuthContract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
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

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
// Members are unique per case; the staff organization identity only selects
// the production staff gate, so one hash-colliding org serves the file.
const staffOrgId = createUniqueStaffOrgIdFixture();

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function configureClient(): { clientId: string; clientSecret: string } {
  const clientId = `client-${randomUUID()}.apps.googleusercontent.com`;
  const clientSecret = `secret-${randomUUID()}`;
  mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", clientId);
  mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", clientSecret);
  return { clientId, clientSecret };
}

async function optedInStaffMember(): Promise<Member> {
  const member = {
    userId: `user_${randomUUID()}`,
    orgId: staffOrgId,
  };
  await updateFeatureSwitchesForUser(context, member, {
    [FeatureSwitchKey.GeminiAntigravity]: true,
  });
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  return member;
}

function deviceAuthClient() {
  return setupApp({ context, routes: antigravityDeviceAuthRoutes })(
    antigravityDeviceAuthContract,
  );
}

interface GoogleReceipts {
  readonly exchanges: URLSearchParams[];
  readonly lookups: string[];
}

function googleAccount(email: string): GoogleReceipts {
  const receipts: GoogleReceipts = { exchanges: [], lookups: [] };
  server.use(
    http.post(TOKEN_URL, async ({ request }) => {
      receipts.exchanges.push(new URLSearchParams(await request.text()));
      return HttpResponse.json({
        access_token: "google-access-token",
        refresh_token: "google-refresh-token",
        expires_in: 3600,
      });
    }),
    http.get(USERINFO_URL, ({ request }) => {
      receipts.lookups.push(request.headers.get("authorization") ?? "");
      return HttpResponse.json({ id: "google-user-1", email });
    }),
  );
  return receipts;
}

function redirectAddress(params: Record<string, string>): string {
  const url = new URL(REDIRECT_URI);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

describe("Antigravity Google sign-in", () => {
  it("antigravity-device-auth-001 is only offered to opted-in staff members with a configured client", async () => {
    configureClient();
    const api = deviceAuthClient();
    const staffMember = { userId: `user_${randomUUID()}`, orgId: staffOrgId };

    createRouteMocks(context).clerk.session(staffMember.userId, staffOrgId);
    const notOptedIn = await accept(api.start({ headers, body: {} }), [404]);
    expect(notOptedIn.status).toBe(404);

    await updateFeatureSwitchesForUser(context, staffMember, {
      [FeatureSwitchKey.GeminiAntigravity]: true,
    });
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", undefined);
    createRouteMocks(context).clerk.session(staffMember.userId, staffOrgId);
    const unconfigured = await accept(api.start({ headers, body: {} }), [503]);
    expect(unconfigured.body.error.code).toBe(
      "ANTIGRAVITY_DEVICE_AUTH_UNAVAILABLE",
    );

    configureClient();
    createRouteMocks(context).clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
    );
    await accept(api.start({ headers, body: {} }), [404]);
  });

  it("antigravity-device-auth-002 connects the Google account from the pasted redirect address", async () => {
    const { clientId, clientSecret } = configureClient();
    const member = await optedInStaffMember();
    const receipts = googleAccount("Member@Gmail.com");
    const api = deviceAuthClient();
    // Google's Cloud Code API answers the plan and quota reads after connect.
    // Regular expressions keep the method suffix: MSW reads `:name` in a path
    // string as a parameter.
    server.use(
      http.post(
        /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:loadCodeAssist$/,
        () => {
          return HttpResponse.json({
            cloudaicompanionProject: "member-cloud-project",
            currentTier: { id: "free-tier", name: "Free" },
          });
        },
      ),
      http.post(
        /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:retrieveUserQuotaSummary$/,
        () => {
          return HttpResponse.json({
            groups: [
              {
                displayName: "Gemini",
                buckets: [
                  {
                    bucketId: "gemini-5h",
                    window: "5h",
                    remainingFraction: 0.75,
                    resetTime: "2026-12-01T00:00:00Z",
                  },
                ],
              },
            ],
          });
        },
      ),
    );

    const started = await accept(api.start({ headers, body: {} }), [200]);
    const browserUrl = new URL(started.body.browserUrl);
    expect(`${browserUrl.origin}${browserUrl.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const params = browserUrl.searchParams;
    expect(params.get("client_id")).toBe(clientId);
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")?.split(" ")).toContain(
      "https://www.googleapis.com/auth/cloud-platform",
    );
    const state = params.get("state");
    const challenge = params.get("code_challenge");
    expect(state).toBeTruthy();
    expect(challenge).toBeTruthy();

    const pasted = `  ${redirectAddress({ state: state ?? "", code: "auth-code-1" })}  `;
    const completed = await accept(
      api.complete({
        headers,
        body: {
          sessionToken: started.body.sessionToken,
          authorizationCode: pasted,
        },
      }),
      [200],
    );
    expect(completed.body.status).toBe("complete");
    expect(completed.body.created).toBeTruthy();
    expect(completed.body.provider).toMatchObject({
      type: "antigravity",
      isActive: true,
      accountEmail: "member@gmail.com",
    });

    // Later plan and quota reads may refresh the token; the sign-in itself
    // exchanges the pasted authorization code.
    const exchange = receipts.exchanges.find((candidate) => {
      return candidate.get("grant_type") === "authorization_code";
    });
    expect(exchange?.get("code")).toBe("auth-code-1");
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(exchange?.get("client_id")).toBe(clientId);
    expect(exchange?.get("client_secret")).toBe(clientSecret);
    const verifier = exchange?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      challenge,
    );
    expect(receipts.lookups).toContain("Bearer google-access-token");

    createRouteMocks(context).clerk.session(member.userId, member.orgId);
    const listed = await accept(
      setupApp({ context, routes: meModelProvidersListRoutes })(
        personalModelProvidersMainContract,
      ).list({ headers }),
      [200],
    );
    const provider = listed.body.modelProviders.find((candidate) => {
      return candidate.id === completed.body.provider.id;
    });
    expect(provider).toMatchObject({
      type: "antigravity",
      accountEmail: "member@gmail.com",
    });
    expect(JSON.stringify(listed.body)).not.toContain("google-refresh-token");

    const replay = await accept(
      api.complete({
        headers,
        body: {
          sessionToken: started.body.sessionToken,
          authorizationCode: pasted,
        },
      }),
      [400],
    );
    expect(replay.body.error.message).toBe("Sign-in is not pending");
    const relisted = await accept(
      setupApp({ context, routes: meModelProvidersListRoutes })(
        personalModelProvidersMainContract,
      ).list({ headers }),
      [200],
    );
    expect(
      relisted.body.modelProviders.filter((candidate) => {
        return candidate.type === "antigravity";
      }),
    ).toHaveLength(1);
  });

  it("antigravity-device-auth-003 keeps the sign-in pending when another sign-in's address is pasted", async () => {
    configureClient();
    await optedInStaffMember();
    const receipts = googleAccount(`member-${randomUUID()}@gmail.com`);
    const api = deviceAuthClient();

    const started = await accept(api.start({ headers, body: {} }), [200]);
    const state =
      new URL(started.body.browserUrl).searchParams.get("state") ?? "";
    const sessionToken = started.body.sessionToken;

    for (const foreign of [
      redirectAddress({ state: "another-sign-in", code: "auth-code-2" }),
      redirectAddress({ code: "auth-code-2" }),
    ]) {
      const rejected = await accept(
        api.complete({
          headers,
          body: { sessionToken, authorizationCode: foreign },
        }),
        [400],
      );
      expect(rejected.body.error.message).toBe(
        "The pasted address belongs to another sign-in",
      );
    }
    const denied = await accept(
      api.complete({
        headers,
        body: {
          sessionToken,
          authorizationCode: redirectAddress({
            state,
            error: "access_denied",
          }),
        },
      }),
      [400],
    );
    expect(denied.body.error.message).toBe(
      "Google sign-in was not approved: access_denied",
    );
    expect(receipts.exchanges).toHaveLength(0);

    await accept(
      api.complete({
        headers,
        body: {
          sessionToken,
          authorizationCode: redirectAddress({ state, code: "auth-code-2" }),
        },
      }),
      [200],
    );
    expect(receipts.exchanges).toHaveLength(1);
  });
});
