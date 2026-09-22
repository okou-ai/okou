import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { meModelProvidersResetSubscriptionRoutes } from "../me-model-providers-reset-subscription";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const ORGANIZATION_UUID = "11111111-2222-3333-4444-555555555555";
const RESET_URL = `https://api.anthropic.com/api/organizations/${ORGANIZATION_UUID}/reset_rate_limits`;

interface Grant {
  readonly id: string;
  readonly resets_left: number;
  readonly ends_at?: string | null;
  readonly paused?: boolean;
}

function upstream(options: {
  readonly grants?: readonly Grant[];
  readonly nextGrantId?: string | null;
  readonly result?: string;
  readonly organizationUuid?: string | null;
}) {
  const calls = {
    usage: [] as URL[],
    reset: [] as Record<string, unknown>[],
  };
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", () => {
      return HttpResponse.json({
        account: { uuid: "account-uuid", email: "reset@example.com" },
        ...(options.organizationUuid === null
          ? { organization: { name: "Reset Org" } }
          : {
              organization: {
                uuid: options.organizationUuid ?? ORGANIZATION_UUID,
                name: "Reset Org",
                organization_type: "claude_max",
                rate_limit_tier: "default_claude_max_20x",
              },
            }),
      });
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", ({ request }) => {
      calls.usage.push(new URL(request.url));
      return HttpResponse.json({
        five_hour: { utilization: 40, resets_at: "2030-01-01T00:00:00.000Z" },
        seven_day: { utilization: 70, resets_at: "2030-01-07T00:00:00.000Z" },
        cedar_ember: {
          eligible: true,
          grants: options.grants ?? [],
          next_grant_id: options.nextGrantId ?? null,
        },
      });
    }),
    http.post(RESET_URL, async ({ request }) => {
      calls.reset.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ result: options.result ?? "reset" });
    }),
  );
  return calls;
}

const context = testContext();

async function fixture(options: { readonly resetEnabled?: boolean } = {}) {
  const mocks = createRouteMocks(context);
  const owner = {
    orgId: `org_claude_reset_${randomUUID()}`,
    userId: `user_claude_reset_${randomUUID()}`,
  };
  const session = () => {
    return mocks.clerk.session(owner.userId, owner.orgId);
  };
  session();
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.ClaudeCodeUsageReset]: options.resetEnabled ?? true,
  });

  session();
  await accept(
    setupApp({
      context,
      routes: [...meModelProvidersListRoutes, ...meModelProvidersUpsertRoutes],
      rethrowErrors: true,
    })(personalModelProvidersMainContract).upsert({
      headers,
      body: { type: "claude-code-oauth-token", secret: "sk-ant-oat-reset" },
    }),
    [200, 201],
  );

  return {
    ...owner,
    list: async () => {
      session();
      const result = await accept(
        setupApp({
          context,
          routes: [
            ...meModelProvidersListRoutes,
            ...meModelProvidersUpsertRoutes,
          ],
        })(personalModelProvidersMainContract).list({ headers }),
        [200],
      );
      return result.body.modelProviders.find((provider) => {
        return provider.type === "claude-code-oauth-token";
      });
    },
    reset: async () => {
      session();
      return await setupApp({
        context,
        routes: meModelProvidersResetSubscriptionRoutes,
      })(personalModelProvidersByTypeContract).resetSubscriptionUsage({
        headers,
        params: { type: "claude-code-oauth-token" },
        body: { idempotencyKey: randomUUID() },
      });
    },
  };
}

describe("Claude Code subscription reset", () => {
  it("reports redeemable resets on the connected provider", async () => {
    const calls = upstream({
      grants: [
        { id: "grant-a", resets_left: 1, ends_at: "2030-02-01T00:00:00.000Z" },
        { id: "grant-b", resets_left: 2, ends_at: "2030-01-20T00:00:00.000Z" },
      ],
      nextGrantId: "grant-a",
    });
    const owner = await fixture();

    const provider = await owner.list();

    expect(provider?.subscriptionResetCredits).toBe(3);
    // The soonest deadline among redeemable grants is what the count expires by.
    expect(provider?.subscriptionResetCreditsNextExpiresAt).toBe(
      "2030-01-20T00:00:00.000Z",
    );
    expect(
      calls.usage.some((url) => {
        return url.searchParams.get("cedar_ember") === "1";
      }),
    ).toBeTruthy();
  });

  it("excludes paused and spent grants from the offered count", async () => {
    upstream({
      grants: [
        { id: "grant-paused", resets_left: 5, paused: true },
        { id: "grant-spent", resets_left: 0 },
        { id: "grant-open", resets_left: 1 },
      ],
      nextGrantId: "grant-open",
    });
    const owner = await fixture();

    expect((await owner.list())?.subscriptionResetCredits).toBe(1);
  });

  it("redeems the grant upstream nominated", async () => {
    const calls = upstream({
      grants: [{ id: "grant-open", resets_left: 1 }],
      nextGrantId: "grant-open",
    });
    const owner = await fixture();

    const result = await accept(owner.reset(), [200]);

    expect(result.body).toStrictEqual({ outcome: "reset" });
    expect(calls.reset).toStrictEqual([
      {
        program: "cedar_ember",
        grant_id: "grant-open",
        request_id: expect.any(String),
      },
    ]);
  });

  it.each([
    ["already_used", "alreadyRedeemed"],
    ["not_limited", "nothingToReset"],
    ["cooldown", "noCredit"],
    ["ineligible", "noCredit"],
    ["unavailable", "noCredit"],
  ])("maps upstream %s to %s", async (result, outcome) => {
    upstream({
      grants: [{ id: "grant-open", resets_left: 1 }],
      nextGrantId: "grant-open",
      result,
    });
    const owner = await fixture();

    expect((await accept(owner.reset(), [200])).body).toStrictEqual({
      outcome,
    });
  });

  it("does not spend a request when no grant is redeemable", async () => {
    const calls = upstream({ grants: [], nextGrantId: null });
    const owner = await fixture();

    const result = await accept(owner.reset(), [200]);

    expect(result.body).toStrictEqual({ outcome: "noCredit" });
    expect(calls.reset).toHaveLength(0);
  });

  it("does not redeem a grant upstream did not nominate", async () => {
    const calls = upstream({
      grants: [{ id: "grant-open", resets_left: 1 }],
      nextGrantId: "grant-withdrawn",
    });
    const owner = await fixture();

    expect((await accept(owner.reset(), [200])).body).toStrictEqual({
      outcome: "noCredit",
    });
    expect(calls.reset).toHaveLength(0);
  });

  it("reports no credit when the account has no organization", async () => {
    const calls = upstream({
      grants: [{ id: "grant-open", resets_left: 1 }],
      nextGrantId: "grant-open",
      organizationUuid: null,
    });
    const owner = await fixture();

    expect((await accept(owner.reset(), [200])).body).toStrictEqual({
      outcome: "noCredit",
    });
    expect(calls.reset).toHaveLength(0);
  });

  it("hides resets entirely while the feature switch is off", async () => {
    const calls = upstream({
      grants: [{ id: "grant-open", resets_left: 1 }],
      nextGrantId: "grant-open",
    });
    const owner = await fixture({ resetEnabled: false });

    const provider = await owner.list();
    expect(provider?.subscriptionResetCredits ?? null).toBeNull();
    // A disabled switch must not leak the action through the endpoint either.
    expect((await owner.reset()).status).toBe(404);
    expect(calls.reset).toHaveLength(0);
  });
});
