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
const deviceAuthClient = setupApp({
  context,
  routes: antigravityDeviceAuthRoutes,
})(antigravityDeviceAuthContract);
const providersListClient = setupApp({
  context,
  routes: meModelProvidersListRoutes,
})(personalModelProvidersMainContract);
// MSW reads ":name" in a path string as a parameter, so match the exact
// Cloud Code method URLs with regular expressions.
const LOAD_CODE_ASSIST =
  /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:loadCodeAssist$/;
const RETRIEVE_USER_QUOTA_SUMMARY =
  /^https:\/\/daily-cloudcode-pa\.googleapis\.com\/v1internal:retrieveUserQuotaSummary$/;

interface QuotaSummaryBucketFixture {
  readonly bucketId: string;
  readonly displayName?: string;
  readonly window?: string;
  readonly remainingFraction: number;
  readonly disabled?: boolean;
  readonly resetTime?: string;
}

interface QuotaSummaryGroupFixture {
  readonly displayName: string;
  readonly buckets: readonly QuotaSummaryBucketFixture[];
}

interface GoogleQuota {
  readonly tier: { readonly id: string; readonly name: string };
  readonly groups: readonly QuotaSummaryGroupFixture[];
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
  const started = await accept(
    deviceAuthClient.start({ headers: authHeaders(), body: {} }),
    [200],
  );
  const redirect = new URL("http://localhost:51121/oauth-callback");
  redirect.searchParams.set(
    "state",
    new URL(started.body.browserUrl).searchParams.get("state") ?? "",
  );
  redirect.searchParams.set("code", "4/0AeaYSHB-code");
  await accept(
    deviceAuthClient.complete({
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
  const listed = await accept(
    providersListClient.list({ headers: authHeaders() }),
    [200],
  );
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

  it("shows the Google AI plan and the tightest Gemini 5-hour quota from the summary", async () => {
    const carbonReset = inHours(3);
    const quotaRequests = mockGoogle({
      tier: { id: "g1-pro-tier", name: "Google AI Pro" },
      groups: [
        {
          displayName: "Gemini",
          buckets: [
            {
              bucketId: "gemini-5h-primary",
              window: "5h",
              remainingFraction: 0.75,
              resetTime: inHours(2),
            },
            {
              bucketId: "gemini-5h-tight",
              window: "5h",
              remainingFraction: 0.4,
              resetTime: carbonReset,
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
        // Third-party and Argon preview pools are excluded from Gemini quota.
        {
          displayName: "Claude & GPT",
          buckets: [
            {
              bucketId: "claude-5h",
              window: "5h",
              remainingFraction: 0,
              resetTime: inHours(1),
            },
          ],
        },
        {
          displayName: "Gemini Argon Preview",
          buckets: [
            {
              bucketId: "argon-5h",
              window: "5h",
              remainingFraction: 0.1,
              resetTime: inHours(1),
            },
          ],
        },
      ],
    });
    await connectGoogleAccount();

    await expect(listGoogleAccount()).resolves.toMatchObject({
      planType: "pro",
      subscriptionResetPeriod: "5-hour window",
      subscriptionNextResetAt: carbonReset,
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 60,
          remainingPercent: 40,
          resetAt: carbonReset,
          windowSeconds: 18_000,
        },
        weekly: null,
      },
    });
    expect(quotaRequests).toStrictEqual([{ project: "agy-project-1" }]);
  });

  it("maps weekly quota summary windows and weekly reset metadata", async () => {
    const weeklyReset = inHours(72);
    mockGoogle({
      tier: { id: "free-tier", name: "Antigravity Free" },
      groups: [
        {
          displayName: "Gemini",
          buckets: [
            {
              bucketId: "gemini-weekly",
              window: "7d",
              remainingFraction: 0.9,
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
          usedPercent: 10,
          remainingPercent: 90,
          resetAt: weeklyReset,
          windowSeconds: 604_800,
        },
      },
    });
  });
});
