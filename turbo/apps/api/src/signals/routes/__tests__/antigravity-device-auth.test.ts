import { randomUUID } from "node:crypto";

import { antigravityDeviceAuthContract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { antigravityDeviceAuthRoutes } from "../antigravity-device-auth";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const headers = { authorization: "Bearer clerk-session" };
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
