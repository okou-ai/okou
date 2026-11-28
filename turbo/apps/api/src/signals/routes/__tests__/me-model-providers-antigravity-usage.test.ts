import { randomUUID } from "node:crypto";
import { antigravityDeviceAuthContract } from "@okouai/api-contracts/contracts/antigravity-device-auth";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { antigravityDeviceAuthRoutes } from "../antigravity-device-auth";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { mockSecretKmsHttp } from "./helpers/secret-kms-http";

const context = testContext();
const mocks = createRouteMocks(context);
// MSW reads ":name" in a path string as a parameter, so match the exact
// Cloud Code method URLs with regular expressions.
const LOAD_CODE_ASSIST =
  /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:loadCodeAssist$/;
const RETRIEVE_USER_QUOTA_SUMMARY =
  /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:retrieveUserQuotaSummary$/;

interface GoogleQuotaBucket {
  readonly bucketId?: string;
  readonly displayName?: string;
  readonly window?: string;
  readonly remainingFraction?: number;
  readonly remainingAmount?: string;
  readonly disabled?: boolean;
  readonly resetTime?: string;
}

interface GoogleQuotaGroup {
  readonly displayName?: string;
  readonly buckets: readonly GoogleQuotaBucket[];
}

interface GoogleQuota {
  readonly tier: { readonly id: string; readonly name: string };
  readonly groups: readonly GoogleQuotaGroup[];
}

/** Google signs in once, then serves the plan and quota per Settings read. */
function mockGoogle(quota: GoogleQuota) {
  const quotaRequests: unknown[] = [];
  server.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "refresh_token") {
        return HttpResponse.json({
          access_token: "test-google-usage-access",
          expires_in: 3599,
          token_type: "Bearer",
        });
      }
      return HttpResponse.json({
        access_token: "test-google-sign-in-access",
        refresh_token: "test-google-refresh",
        expires_in: 3599,
      });
    }),
    http.get("https://www.googleapis.com/oauth2/v1/userinfo", () => {
      return HttpResponse.json({ id: "4242", email: "pilot@gmail.com" });
    }),
    http.post(LOAD_CODE_ASSIST, ({ request }) => {
      if (
        request.headers.get("authorization") !==
        "Bearer test-google-usage-access"
      ) {
        return new HttpResponse(null, { status: 401 });
      }
      return HttpResponse.json({
        cloudaicompanionProject: "agy-project-1",
        currentTier: { id: "standard-tier", name: "Standard" },
        paidTier: quota.tier,
      });
    }),
    http.post(RETRIEVE_USER_QUOTA_SUMMARY, async ({ request }) => {
      quotaRequests.push(await request.json());
      return HttpResponse.json({ groups: quota.groups });
    }),
  );
  return quotaRequests;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function connectGoogleAccount(): Promise<{
  readonly orgId: string;
  readonly userId: string;
}> {
  const actor = {
    orgId: createUniqueStaffOrgIdFixture(),
    userId: `user_agy_usage_${randomUUID().slice(0, 8)}`,
  };
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.GeminiAntigravity]: true,
  });
  mocks.clerk.session(actor.userId, actor.orgId);
  const client = setupApp({ context, routes: antigravityDeviceAuthRoutes })(
    antigravityDeviceAuthContract,
  );
  const started = await accept(
    client.start({ headers: authHeaders(), body: {} }),
    [200],
  );
  const redirect = new URL("http://localhost:51121/oauth-callback");
  redirect.searchParams.set(
    "state",
    new URL(started.body.browserUrl).searchParams.get("state") ?? "",
  );
  redirect.searchParams.set("code", "4/0AeaYSHB-code");
  await accept(
    client.complete({
      headers: authHeaders(),
      body: {
        sessionToken: started.body.sessionToken,
        authorizationCode: redirect.toString(),
      },
    }),
    [200],
  );
  return actor;
}

async function listGoogleAccount() {
  const client = setupApp({ context, routes: meModelProvidersListRoutes })(
    personalModelProvidersMainContract,
  );
  const listed = await accept(client.list({ headers: authHeaders() }), [200]);
  return listed.body.modelProviders.find((provider) => {
    return provider.type === "antigravity";
  });
}

function inHours(hours: number): string {
  return new Date(now() + hours * 60 * 60 * 1000).toISOString();
}

describe("Google AI subscription usage", () => {
  beforeEach(() => {
    mockSecretKmsHttp();
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_ID", "agy-client.example");
    mockOptionalEnv("ANTIGRAVITY_OAUTH_CLIENT_SECRET", "agy-client-secret");
  });

  it("shows both the 5-hour and weekly Gemini quota windows from the quota summary", async () => {
    const fiveHourReset = inHours(3);
    const weeklyReset = inHours(120);
    const quotaRequests = mockGoogle({
      tier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-5h",
              displayName: "5 hours",
              window: "5h",
              remainingFraction: 0.739,
              resetTime: fiveHourReset,
            },
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly",
              window: "weekly",
              remainingFraction: 0.42,
              resetTime: weeklyReset,
            },
            {
              bucketId: "gemini-5h-disabled",
              window: "5h",
              remainingFraction: 0,
              disabled: true,
              resetTime: inHours(1),
            },
          ],
        },
        // Dedicated Argon preview and third-party pools do not govern Okou's
        // Gemini 4 Neon/Carbon/Hydrogen models.
        {
          displayName: "Gemini 4 Argon",
          buckets: [
            {
              bucketId: "gemini-argon-wtu-weekly",
              window: "weekly",
              remainingFraction: 0.1,
              resetTime: inHours(96),
            },
          ],
        },
        {
          displayName: "Claude & GPT Models",
          buckets: [
            {
              bucketId: "3p-5h",
              window: "5h",
              remainingFraction: 0,
              resetTime: inHours(1),
            },
            {
              bucketId: "3p-weekly",
              window: "weekly",
              remainingFraction: 0,
              resetTime: inHours(48),
            },
          ],
        },
      ],
    });
    await connectGoogleAccount();

    await expect(listGoogleAccount()).resolves.toMatchObject({
      planType: "ultra",
      subscriptionResetPeriod: "weekly",
      subscriptionNextResetAt: weeklyReset,
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 26.1,
          remainingPercent: 73.9,
          resetAt: fiveHourReset,
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 58,
          remainingPercent: 42,
          resetAt: weeklyReset,
          windowSeconds: 604_800,
        },
      },
    });
    expect(quotaRequests).toStrictEqual([{ project: "agy-project-1" }]);
  });

  it("handles weekly-only Gemini quota, zero remaining fraction, and amount-only buckets", async () => {
    const weeklyReset = inHours(72);
    mockGoogle({
      tier: { id: "free-tier", name: "Antigravity Free" },
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-5h",
              window: "5h",
              remainingAmount: "50",
              resetTime: inHours(2),
            },
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly",
              remainingFraction: 0,
              resetTime: weeklyReset,
            },
          ],
        },
      ],
    });
    await connectGoogleAccount();

    await expect(listGoogleAccount()).resolves.toMatchObject({
      planType: "free",
      subscriptionResetPeriod: "weekly",
      subscriptionNextResetAt: weeklyReset,
      subscriptionUsage: {
        fiveHour: null,
        weekly: {
          usedPercent: 100,
          remainingPercent: 0,
          resetAt: weeklyReset,
          windowSeconds: 604_800,
        },
      },
    });
  });
});
