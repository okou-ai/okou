import { randomUUID } from "node:crypto";

import {
  acquisitionAttributionContract,
  type GoogleAdsConversionMilestone,
} from "@okouai/api-contracts/contracts/acquisition-attribution";
import {
  testUsageStateContract,
  type TestUsageStateActionBody,
  type TestUsageStateFixture,
} from "@okouai/api-contracts/contracts/test-usage-state";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { readOrgAcquisitionAttributionFixture } from "../../../test-fixtures/org-metadata";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";
import { acquisitionAttributionRoutes } from "../acquisition-attribution";
import { testUsageStateRoutes } from "../test-usage-state";
import {
  testUsagePackSubscriptionStateContract,
  testUsagePackSubscriptionStateRoutes,
} from "../test-usage-pack-subscription-state";

const context = testContext();
const mocks = createRouteMocks(context);

const RECORDED_AT_ISO = "2026-05-30T12:00:00.000Z";

class ClerkApiResponseTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly status = 429;

  constructor(readonly retryAfter: number) {
    super("Clerk Backend API rate limit exceeded");
  }
}

function client() {
  return setupApp({ context, routes: acquisitionAttributionRoutes })(
    acquisitionAttributionContract,
  );
}

async function usageStateAction(body: TestUsageStateActionBody) {
  return await accept(
    setupApp({ context, routes: testUsageStateRoutes })(
      testUsageStateContract,
    ).action({ body }),
    [200],
  );
}

async function cleanupAcquisitionFixture(
  fixture: TestUsageStateFixture,
): Promise<void> {
  await accept(
    setupApp({ context, routes: testUsagePackSubscriptionStateRoutes })(
      testUsagePackSubscriptionStateContract,
    ).action({ body: { action: "cleanup-migration", orgId: fixture.org_id } }),
    [200],
  );
  await usageStateAction({ action: "delete-fixture", fixture });
}

async function seedAcquisitionFixture(): Promise<TestUsageStateFixture> {
  const response = await usageStateAction({ action: "seed-fixture" });
  if (!response.body.fixture) {
    throw new Error("Expected an acquisition fixture");
  }
  const fixture = response.body.fixture;
  onTestFinished(async () => {
    await cleanupAcquisitionFixture(fixture);
  });
  return fixture;
}

function actorForFixture(fixture: TestUsageStateFixture): ApiTestUser {
  return {
    userId: fixture.user_id,
    orgId: fixture.org_id,
    orgRole: "org:admin",
    email: `${fixture.user_id}@example.test`,
  };
}

async function readGoogleAdsMilestones(
  actor: ApiTestUser,
): Promise<readonly GoogleAdsConversionMilestone[]> {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: actor.userId,
        privateMetadata: {
          signup_attribution: { vm0_campaign_id: "24220469665" },
        },
      },
    ],
  });
  const response = await accept(
    client().googleAdsMilestones({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(response.body.googleAdsAccountId).toBe("7935750692");
  return response.body.milestones;
}

describe("POST /api/attribution/signup", () => {
  it("accepts Okou IDs while keeping first-touch storage readable by older APIs", async () => {
    mockNow(new Date(RECORDED_AT_ISO));
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: userId, privateMetadata: {} }],
    });
    const response = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            gclid: "original-click",
            okou_campaign_id: "24220469665",
            okou_ad_group_id: "123456",
          },
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      recorded: true,
      googleAdsAccountId: "7935750692",
    });
    expect(context.mocks.clerk.users.updateUserMetadata).toHaveBeenCalledWith(
      userId,
      {
        privateMetadata: {
          signup_attribution: {
            gclid: "original-click",
            vm0_campaign_id: "24220469665",
            vm0_ad_group_id: "123456",
            recorded_at: RECORDED_AT_ISO,
          },
        },
      },
    );
  });

  it("requires a Clerk session", async () => {
    const response = await client().recordSignup({
      body: {
        attribution: {
          vm0_source: "presentation",
        },
      },
    });

    expect(response.status).toBe(401);
  });

  it.each([
    { label: "null", userId: null },
    { label: "empty", userId: "" },
  ] as const)(
    "rejects an authenticated Clerk session with a $label user id",
    async ({ userId }) => {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: true,
        toAuth: () => {
          return { userId, orgId: null, orgRole: null };
        },
      });

      const response = await accept(
        client().recordSignup({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            attribution: {
              vm0_source: "presentation",
            },
          },
        }),
        [401],
      );

      expect(response.body).toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
      expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
      expect(
        context.mocks.clerk.users.updateUserMetadata,
      ).not.toHaveBeenCalled();
    },
  );

  it("writes first-touch attribution to Clerk private metadata", async () => {
    mockNow(new Date(RECORDED_AT_ISO));
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: userId,
          privateMetadata: {
            existing: "value",
          },
        },
      ],
    });
    context.mocks.clerk.users.updateUserMetadata.mockResolvedValue({});

    const response = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            vm0_source: "presentation",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "presentation_search_en",
            vm0_experiment: "presentation_lp",
            vm0_variant: "a",
            gclid: "test-gclid",
            gclid_present: "true",
          },
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      recorded: true,
      googleAdsAccountId: null,
    });
    expect(context.mocks.clerk.users.updateUserMetadata).toHaveBeenCalledWith(
      userId,
      {
        privateMetadata: {
          existing: "value",
          signup_attribution: {
            vm0_source: "presentation",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "presentation_search_en",
            vm0_experiment: "presentation_lp",
            vm0_variant: "a",
            gclid: "test-gclid",
            gclid_present: "true",
            recorded_at: RECORDED_AT_ISO,
          },
        },
      },
    );
  });

  it("stops at the first Clerk rate limit without writing attribution", async () => {
    mockNow(new Date(RECORDED_AT_ISO));
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.users.getUserList
      .mockRejectedValueOnce(new ClerkApiResponseTestError(2))
      .mockResolvedValue({
        data: [{ id: userId, privateMetadata: {} }],
      });
    context.mocks.clerk.users.updateUserMetadata.mockResolvedValue({});

    const response = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            vm0_source: "presentation",
          },
        },
      }),
      [500],
    );

    expect(response.body).toStrictEqual({ error: "Internal server error" });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    expect(context.mocks.clerk.users.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not overwrite existing signup attribution", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: userId,
          privateMetadata: {
            signup_attribution: {
              vm0_source: "existing",
            },
          },
        },
      ],
    });

    const response = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            vm0_source: "presentation",
          },
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      recorded: false,
      googleAdsAccountId: null,
    });
    expect(context.mocks.clerk.users.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("records a returning user's Impact click without replacing acquisition first touch", async () => {
    mockNow(new Date(RECORDED_AT_ISO));
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: userId,
          privateMetadata: { signup_attribution: { vm0_source: "existing" } },
        },
      ],
    });
    context.mocks.clerk.users.updateUserMetadata.mockResolvedValue({});
    const impactAttribution = {
      clickId: "new-partner-click",
      capturedAt: RECORDED_AT_ISO,
    };
    const response = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: { attribution: {}, impactAttribution },
      }),
      [200],
    );
    expect(response.body.recorded).toBeFalsy();
    expect(
      context.mocks.clerk.users.updateUserMetadata,
    ).toHaveBeenCalledExactlyOnceWith(userId, {
      privateMetadata: { impact_attribution: impactAttribution },
    });
  });

  it.each(["2025-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"])(
    "ignores an ineligible Impact click captured at %s without creating an empty first touch",
    async (capturedAt) => {
      mockNow(new Date(RECORDED_AT_ISO));
      const userId = `user_${randomUUID()}`;
      mocks.clerk.session(userId, null);
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [{ id: userId, privateMetadata: {} }],
      });
      const response = await accept(
        client().recordSignup({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            attribution: {},
            impactAttribution: { clickId: "partner-click", capturedAt },
          },
        }),
        [200],
      );
      expect(response.body.recorded).toBeFalsy();
      expect(
        context.mocks.clerk.users.updateUserMetadata,
      ).not.toHaveBeenCalled();
    },
  );

  it("does not replace a more recent Impact click with an older browser session", async () => {
    mockNow(new Date(RECORDED_AT_ISO));
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: userId,
          privateMetadata: {
            impact_attribution: {
              clickId: "latest",
              capturedAt: RECORDED_AT_ISO,
            },
          },
        },
      ],
    });
    await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {},
          impactAttribution: {
            clickId: "older",
            capturedAt: "2026-05-29T12:00:00.000Z",
          },
        },
      }),
      [200],
    );
    expect(context.mocks.clerk.users.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("persists trimmed org first-touch attribution once", async () => {
    const fixture = await seedAcquisitionFixture();
    const actor = actorForFixture(fixture);
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    context.mocks.clerk.users.getUserList
      .mockResolvedValueOnce({
        data: [{ id: actor.userId, privateMetadata: {} }],
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: actor.userId,
            privateMetadata: {
              signup_attribution: {
                vm0_source: "presentation",
                utm_source: "google",
              },
            },
          },
        ],
      });
    context.mocks.clerk.users.updateUserMetadata.mockResolvedValue({});

    const first = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            vm0_source: " presentation ",
            utm_source: " google ",
          },
        },
      }),
      [200],
    );
    expect(first.body).toStrictEqual({
      recorded: true,
      googleAdsAccountId: null,
    });

    // There is no public org-attribution read API, so the focused fixture
    // verifies the persisted first-touch boundary exercised by this route.
    await expect(
      readOrgAcquisitionAttributionFixture(fixture.org_id),
    ).resolves.toMatchObject({
      acquisitionFirstPartySource: "presentation",
      acquisitionUtmSource: "google",
      acquisitionRecordedAt: expect.any(Date),
    });

    const replay = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            vm0_source: "marketing",
            utm_source: "newsletter",
          },
        },
      }),
      [200],
    );
    expect(replay.body).toStrictEqual({
      recorded: false,
      googleAdsAccountId: null,
    });
    await expect(
      readOrgAcquisitionAttributionFixture(fixture.org_id),
    ).resolves.toMatchObject({
      acquisitionFirstPartySource: "presentation",
      acquisitionUtmSource: "google",
    });
  });
});

describe("GET /api/attribution/google-ads-milestones", () => {
  it("requires a Clerk session", async () => {
    const response = await client().googleAdsMilestones();

    expect(response.status).toBe(401);
  });

  it("returns no milestones for a user without acquisition activity", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: userId, privateMetadata: {} }],
    });

    const response = await accept(
      client().googleAdsMilestones({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      milestones: [],
      googleAdsAccountId: null,
    });
  });

  it("returns stable run and connector milestones through the public route", async () => {
    const fixture = await seedAcquisitionFixture();
    const actor = actorForFixture(fixture);
    const compose = await usageStateAction({
      action: "seed-compose",
      org_id: fixture.org_id,
      user_id: fixture.user_id,
    });
    if (!compose.body.compose_id) {
      throw new Error("Expected a seeded acquisition Agent");
    }

    // Production has no endpoint for constructing exact historical run
    // timestamps, so the scoped test API supplies the cross-day fixture while
    // the assertion remains at the production attribution route boundary.
    await usageStateAction({
      action: "seed-run",
      org_id: fixture.org_id,
      user_id: fixture.user_id,
      compose_id: compose.body.compose_id,
      status: "completed",
      created_at: "2026-08-23T07:55:00.000Z",
      started_at: "2026-08-23T07:56:00.000Z",
      completed_at: "2026-08-23T08:00:00.000Z",
    });
    await usageStateAction({
      action: "seed-run",
      org_id: fixture.org_id,
      user_id: fixture.user_id,
      compose_id: compose.body.compose_id,
      status: "completed",
      created_at: "2026-08-24T07:55:00.000Z",
      started_at: "2026-08-24T07:56:00.000Z",
      completed_at: "2026-08-24T08:00:00.000Z",
    });
    const connectors = createConnectorBddApi(context);
    await connectors.connectManualGrant(
      actor,
      "gitlab",
      "api-token",
      { accessToken: "gitlab-acquisition-token" },
      compose.body.compose_id,
    );
    await connectors.connectManualGrant(
      actor,
      "figma",
      "api-token",
      { accessToken: "figma-acquisition-token" },
      compose.body.compose_id,
    );

    const milestones = await readGoogleAdsMilestones(actor);
    expect(milestones).toStrictEqual([
      {
        kind: "first_run_completed",
        transactionId: `gdm-first_run_completed-${fixture.user_id}`,
      },
      {
        kind: "second_run_completed",
        transactionId: `gdm-second_run_completed-${fixture.user_id}`,
      },
      {
        kind: "multi_day_run_completed",
        transactionId: `gdm-multi_day_run_completed-${fixture.user_id}`,
      },
      {
        kind: "one_connector_connected",
        transactionId: `gdm-one_connector_connected-${fixture.user_id}`,
      },
      {
        kind: "two_connectors_connected",
        transactionId: `gdm-two_connectors_connected-${fixture.user_id}`,
      },
    ]);
    await expect(readGoogleAdsMilestones(actor)).resolves.toStrictEqual(
      milestones,
    );
  });

  it("returns the stable milestone for the user who exhausts a free trial", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped acquisition actor");
    }
    const fixture = { org_id: actor.orgId, user_id: actor.userId };
    onTestFinished(async () => {
      await cleanupAcquisitionFixture(fixture);
    });
    bdd.acceptAgentStorageWrites();
    await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Acquisition Milestone Agent",
    });

    const usageProvider = `acquisition-${randomUUID()}`;
    await seedUsagePricingRows([
      {
        kind: "model",
        provider: usageProvider,
        category: "tokens.input",
        unitPrice: 1000,
        unitSize: 1_000_000,
      },
    ]);
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "model",
        provider: usageProvider,
        categories: ["tokens.input"],
      });
    });

    // Usage settlement is the production mechanism that exhausts the grant;
    // the scoped API only inserts the otherwise runner-owned usage event.
    await usageStateAction({
      action: "insert-usage-event",
      org_id: actor.orgId,
      user_id: actor.userId,
      kind: "model",
      provider: usageProvider,
      category: "tokens.input",
      quantity: 1_000_000,
      status: "pending",
    });
    const billing = createBillingMediaApi(context);
    await billing.processOrgUsageEvents(actor);
    await expect(billing.readBillingStatus(actor)).resolves.toMatchObject({
      credits: 0,
    });

    const milestones = await readGoogleAdsMilestones(actor);
    expect(milestones).toStrictEqual([
      {
        kind: "free_trial_completed",
        transactionId: expect.stringMatching(
          /^gdm-free-trial-completed-[0-9a-f-]{36}$/,
        ),
      },
    ]);
    await expect(readGoogleAdsMilestones(actor)).resolves.toStrictEqual(
      milestones,
    );
  });

  it("excludes activity from internal organizations", async () => {
    const fixture = {
      org_id: "org_3AW2PMh2ZLwsNXJAH6rufx2HUQu",
      user_id: `user_${randomUUID()}`,
    };
    onTestFinished(async () => {
      await cleanupAcquisitionFixture(fixture);
    });
    const compose = await usageStateAction({
      action: "seed-compose",
      org_id: fixture.org_id,
      user_id: fixture.user_id,
    });
    if (!compose.body.compose_id) {
      throw new Error("Expected a seeded internal acquisition Agent");
    }
    await usageStateAction({
      action: "seed-run",
      org_id: fixture.org_id,
      user_id: fixture.user_id,
      compose_id: compose.body.compose_id,
      status: "completed",
      completed_at: "2026-08-25T08:00:00.000Z",
    });

    await expect(
      readGoogleAdsMilestones(actorForFixture(fixture)),
    ).resolves.toStrictEqual([]);
  });
});

describe("POST /api/attribution/google-ads-account", () => {
  it("requires authentication before resolving attribution", async () => {
    const response = await client().resolveGoogleAdsAccount({
      body: { attribution: { vm0_campaign_id: "24220469665" } },
    });
    expect(response.status).toBe(401);
  });
  it.each([
    {
      saved: { vm0_campaign_id: "24154967178" },
      supplied: "24220469665",
      expected: "1001302527",
    },
    {
      saved: { vm0_campaign_id: "24220469665" },
      supplied: "24154967178",
      expected: "7935750692",
    },
    {
      saved: { okou_campaign_id: "24154967178" },
      supplied: "24220469665",
      expected: "1001302527",
    },
    {
      saved: {
        okou_campaign_id: "24220469665",
        vm0_campaign_id: "24220469665",
      },
      supplied: "24154967178",
      expected: "7935750692",
    },
    {
      saved: {
        okou_campaign_id: "24220469665",
        vm0_campaign_id: "24154967178",
      },
      supplied: "24220469665",
      expected: null,
    },
    {
      saved: {
        okou_campaign_id: "24220469665",
        vm0_ad_group_id: "1",
        okou_ad_group_id: "2",
      },
      supplied: "24220469665",
      expected: null,
    },
    {
      saved: { vm0_campaign_id: " 24220469665 " },
      supplied: "24220469665",
      expected: null,
    },
    {
      saved: { gclid: "original-click" },
      supplied: "24220469665",
      expected: null,
    },
    { saved: null, supplied: "24220469665", expected: null },
    {
      saved: { vm0_campaign_id: "24220469665,24154967178" },
      supplied: "24220469665",
      expected: null,
    },
    {
      saved: { vm0_campaign_id: "99999999999" },
      supplied: "24220469665",
      expected: null,
    },
  ])(
    "preserves the saved first touch: $saved",
    async ({ saved, supplied, expected }) => {
      const userId = `user_${randomUUID()}`;
      mocks.clerk.session(userId, null);
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [{ id: userId, privateMetadata: { signup_attribution: saved } }],
      });
      const response = await accept(
        client().resolveGoogleAdsAccount({
          headers: { authorization: "Bearer clerk-session" },
          body: { attribution: { vm0_campaign_id: supplied } },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({ googleAdsAccountId: expected });
      const milestones = await accept(
        client().googleAdsMilestones({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      if (expected !== "7935750692") {
        expect(milestones.body).toStrictEqual({
          googleAdsAccountId: expected,
          milestones: [],
        });
      }
    },
  );
  it.each(["vm0_campaign_id", "okou_campaign_id"] as const)(
    "resolves %s only before a first touch has been saved",
    async (key) => {
      const userId = `user_${randomUUID()}`;
      mocks.clerk.session(userId, null);
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [{ id: userId, privateMetadata: {} }],
      });
      const response = await accept(
        client().resolveGoogleAdsAccount({
          headers: { authorization: "Bearer clerk-session" },
          body: { attribution: { [key]: "24220469665" } },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({ googleAdsAccountId: "7935750692" });
    },
  );
});
