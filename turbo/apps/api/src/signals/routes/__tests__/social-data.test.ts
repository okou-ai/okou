import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import {
  socialDataContract,
  type SocialDataCreateRequest,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { testUsageStateContract } from "@okouai/api-contracts/contracts/test-usage-state";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { useSingleConnectionPoolFixture } from "../../../test-fixtures/database-pool";
import {
  createUsagePricingFixture,
  type UsagePricingFixture,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { socialDataRoutes } from "../social-data";
import { testUsageStateRoutes } from "../test-usage-state";
import { usageRecordRoutes } from "../usage-record";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const ROUTES = Object.freeze([
  ...socialDataRoutes,
  ...billingStatusRoutes,
  ...usageRecordRoutes,
]);
const SOURCE_BASE = "https://api.monid.ai/v1";
const COMMENTS_ENDPOINT = "/streamers/youtube-comments-scraper";
const X_ENDPOINT = "/apidojo/tweet-scraper";
const COMMENT_REQUEST = {
  platform: "youtube",
  operation: "comments",
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  limit: 2,
} as const satisfies SocialDataRequest;

type SocialActor = ApiTestUser & {
  readonly orgId: string;
  readonly usagePricingResolution: UsagePricingFixture["resolution"];
};

function authenticate(actor: ApiTestUser | null) {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function client(actor: SocialActor) {
  return setupApp({
    context,
    routes: ROUTES,
    usagePricingResolution: actor.usagePricingResolution,
  });
}

async function pricing(unitPrice = 7): Promise<UsagePricingFixture> {
  const configured = ["youtube", "x", "instagram", "wechat", "threads"].map(
    (platform) => {
      return {
        kind: "social",
        provider: `monid/${platform}`,
        category: "provider_cost_usd_micros",
        unitPrice,
        unitSize: 1000,
      } satisfies UsagePricingRow;
    },
  );
  const fixture = await createUsagePricingFixture({ configured });
  onTestFinished(fixture.cleanup);
  return fixture;
}

async function enable(actor: ApiTestUser & { readonly orgId: string }) {
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.SocialDataJobs]: true,
  });
}

async function seedActor({
  enabled = true,
  singleConnection = false,
}: {
  readonly enabled?: boolean;
  readonly singleConnection?: boolean;
} = {}): Promise<SocialActor> {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Social data tests require an organization");
  }
  const orgActor = { ...actor, orgId: actor.orgId };
  await createRunsApi(context).grantProEntitlement(orgActor);
  if (enabled) {
    await enable(orgActor);
  }
  mockEnv("OKOU_SOCIAL_MONID_API_KEY", "test-social-source-key");
  if (singleConnection) {
    await flushWaitUntilForTest();
    await useSingleConnectionPoolFixture();
  }
  const fixture = await pricing();
  return { ...orgActor, usagePricingResolution: fixture.resolution };
}

async function credits(actor: SocialActor): Promise<number> {
  const response = await accept(
    client(actor)(billingStatusContract).get({ headers: authenticate(actor) }),
    [200],
  );
  return response.body.credits;
}

async function readJob(actor: SocialActor, jobId: string) {
  await flushWaitUntilForTest();
  return await accept(
    client(actor)(socialDataContract).get({
      headers: authenticate(actor),
      params: { jobId },
    }),
    [200],
  );
}

function createBody(
  overrides: Partial<SocialDataCreateRequest> = {},
): SocialDataCreateRequest {
  return { ...COMMENT_REQUEST, requestId: randomUUID(), ...overrides };
}

function source(
  options: {
    readonly start?: "sync" | "async" | "failed" | "conflicting-receipt";
    readonly endpoint?: string;
    readonly actualCostMicros?: number;
    readonly beforeRunResponse?: () => Promise<void>;
  } = {},
) {
  const endpoint = options.endpoint ?? COMMENTS_ENDPOINT;
  const runId = `source-${randomUUID()}`;
  const actualCostMicros = options.actualCostMicros ?? 1000;
  const observed = {
    runRequests: 0,
    stopRequests: 0,
    pollStatus: "running" as "running" | "completed" | "failed",
  };
  const output =
    endpoint === X_ENDPOINT
      ? [
          {
            id: "1234567890123456789",
            text: "A public product update",
            url: "https://x.com/example/status/1234567890123456789",
            likeCount: 4,
          },
        ]
      : [
          {
            cid: "comment-source-id",
            comment: "Please add a team dashboard.",
            author: "@viewer",
            voteCount: 2,
            replyCount: 0,
            pageUrl: COMMENT_REQUEST.url,
          },
        ];

  function result(
    status: "running" | "completed" | "failed",
    synchronous = false,
  ) {
    return {
      runId,
      provider: "apify",
      endpoint,
      status: status === "running" ? "RUNNING" : "COMPLETED",
      ...(status === "running"
        ? {}
        : {
            providerResponse: { httpStatus: status === "failed" ? 429 : 200 },
            ...(synchronous
              ? {
                  billing: {
                    actualCost: {
                      value: actualCostMicros,
                      unit: "MICRO_DOLLAR",
                      currency: "USD",
                    },
                  },
                }
              : {
                  cost: {
                    value: actualCostMicros / 1_000_000,
                    currency: "USD",
                  },
                }),
            billedUnits: 1,
            output,
          }),
    };
  }

  server.use(
    http.post(`${SOURCE_BASE}/inspect`, () => {
      return HttpResponse.json({
        provider: "apify",
        endpoint,
        input: {
          body: {
            type: "object",
            properties: {
              startUrls: { type: "array" },
              maxItems: { type: "integer" },
              maxComments: { type: "integer" },
              sortCommentsBy: {
                type: "string",
                enum: ["TOP_COMMENTS", "NEWEST_FIRST"],
              },
            },
            required: ["startUrls"],
          },
        },
        price: {
          type: "PER_RESULT",
          amount: { value: 0.002, currency: "USD" },
        },
      });
    }),
    http.post(`${SOURCE_BASE}/run`, async () => {
      observed.runRequests += 1;
      await options.beforeRunResponse?.();
      if (options.start === "async") {
        return HttpResponse.json(
          { runId, provider: "apify", endpoint, status: "READY" },
          { status: 202 },
        );
      }
      return HttpResponse.json({
        ...result(options.start === "failed" ? "failed" : "completed", true),
        ...(options.start === "conflicting-receipt"
          ? { cost: { value: 0.002, currency: "USD" } }
          : {}),
      });
    }),
    http.get(`${SOURCE_BASE}/runs/${runId}`, () => {
      return HttpResponse.json(result(observed.pollStatus));
    }),
    http.post(`${SOURCE_BASE}/runs/${runId}/stop`, () => {
      observed.stopRequests += 1;
      return HttpResponse.json(
        { error: "Run cannot be stopped" },
        { status: 409 },
      );
    }),
  );
  return observed;
}

/**
 * TikHub endpoints are priced per call and read either a JSON body or query
 * parameters, so their admission and settlement differ from the Apify Actors
 * covered above.
 */
function tikhubPlanSource(options: {
  readonly endpoint: string;
  readonly location: "body" | "queryParams";
  readonly properties: Readonly<Record<string, { readonly type: string }>>;
  readonly required: readonly string[];
  readonly output: unknown;
}) {
  const runId = `source-${randomUUID()}`;
  const observed: {
    runRequests: number;
    runInput?: unknown;
  } = { runRequests: 0 };
  server.use(
    http.post(`${SOURCE_BASE}/inspect`, () => {
      return HttpResponse.json({
        provider: "tikhub",
        endpoint: options.endpoint,
        input: {
          [options.location]: {
            type: "object",
            properties: options.properties,
            required: options.required,
          },
        },
        price: { type: "PER_CALL", amount: { value: 0.015, currency: "USD" } },
      });
    }),
    http.post(`${SOURCE_BASE}/run`, async ({ request }) => {
      observed.runRequests += 1;
      observed.runInput = await request.json();
      return HttpResponse.json({
        runId,
        provider: "tikhub",
        endpoint: options.endpoint,
        status: "COMPLETED",
        providerResponse: { httpStatus: 200 },
        billing: {
          actualCost: { value: 15_000, unit: "MICRO_DOLLAR", currency: "USD" },
        },
        billedUnits: 1,
        output: options.output,
      });
    }),
  );
  return observed;
}

describe("Social data jobs", () => {
  it("requires authentication and the feature switch", async () => {
    const actor = await seedActor({ enabled: false });
    const before = await credits(actor);
    await accept(
      client(actor)(socialDataContract).quote({
        headers: authenticate(null),
        body: COMMENT_REQUEST,
      }),
      [401],
    );
    await accept(
      client(actor)(socialDataContract).quote({
        headers: authenticate(actor),
        body: COMMENT_REQUEST,
      }),
      [403],
    );
    await expect(credits(actor)).resolves.toBe(before);
  });

  it("quotes a bounded operation without starting collection or charging", async () => {
    const actor = await seedActor();
    const observed = source();
    const before = await credits(actor);

    const quote = await accept(
      client(actor)(socialDataContract).quote({
        headers: authenticate(actor),
        body: COMMENT_REQUEST,
      }),
      [200],
    );

    expect(quote.body).toMatchObject({
      platform: "youtube",
      operation: "comments",
      estimatedCredits: 28,
      quantity: 2,
      unit: "result",
    });
    expect(observed.runRequests).toBe(0);
    await expect(credits(actor)).resolves.toBe(before);
  });

  function tikhubSource() {
    const endpoint = "/api/v1/instagram/v1/fetch_user_info_by_username";
    const observed = { runRequests: 0 };
    function media(shortcode: string, views: number, likes: number) {
      return {
        node: {
          id: `media-${shortcode}`,
          shortcode,
          taken_at_timestamp: 1_789_075_224,
          is_video: true,
          video_view_count: views,
          edge_liked_by: { count: likes },
          edge_media_to_comment: { count: 7 },
          edge_media_to_caption: { edges: [{ node: { text: "Launch day" } }] },
          owner: { username: "example" },
        },
      };
    }
    server.use(
      http.post(`${SOURCE_BASE}/inspect`, () => {
        return HttpResponse.json({
          provider: "tikhub",
          endpoint,
          input: {
            queryParams: {
              type: "object",
              properties: { username: { type: "string" } },
              required: ["username"],
            },
          },
          price: {
            type: "PER_CALL",
            amount: { value: 0.0015, currency: "USD" },
          },
        });
      }),
      http.post(`${SOURCE_BASE}/run`, () => {
        observed.runRequests += 1;
        return HttpResponse.json({
          runId: `source-${randomUUID()}`,
          provider: "tikhub",
          endpoint,
          status: "COMPLETED",
          providerResponse: { httpStatus: 200 },
          billing: {
            actualCost: {
              value: 1500,
              unit: "MICRO_DOLLAR",
              currency: "USD",
            },
          },
          billedUnits: 1,
          output: {
            data: {
              user: {
                id: "528_817_151",
                username: "example",
                full_name: "Example",
                edge_owner_to_timeline_media: {
                  count: 2,
                  edges: [
                    media("AAA", 744_337, 26_815),
                    media("BBB", 872_987, 56_698),
                  ],
                },
              },
            },
          },
        });
      }),
    );
    return observed;
  }

  const INSTAGRAM_POSTS = {
    platform: "instagram",
    operation: "posts",
    url: "https://www.instagram.com/example/",
    limit: 2,
  } as const satisfies SocialDataRequest;

  it("quotes a per-call source as one request rather than per result", async () => {
    const actor = await seedActor();
    const observed = tikhubSource();

    const quote = await accept(
      client(actor)(socialDataContract).quote({
        headers: authenticate(actor),
        body: INSTAGRAM_POSTS,
      }),
      [200],
    );

    expect(quote.body).toMatchObject({
      platform: "instagram",
      operation: "posts",
      quantity: 1,
      unit: "request",
    });
    expect(observed.runRequests).toBe(0);
  });

  it("returns per-call source rows with their public engagement counts", async () => {
    const actor = await seedActor();
    tikhubSource();

    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: { ...INSTAGRAM_POSTS, requestId: randomUUID() },
      }),
      [202],
    );
    const finished = await readJob(actor, created.body.jobId);

    expect(finished.body).toMatchObject({
      platform: "instagram",
      status: "completed",
      data: {
        items: [
          {
            id: "media-AAA",
            url: "https://www.instagram.com/p/AAA/",
            text: "Launch day",
            username: "example",
            views: 744_337,
            likes: 26_815,
            comments: 7,
          },
          { id: "media-BBB", views: 872_987, likes: 56_698 },
        ],
      },
      billing: { state: "settled" },
    });
  });

  it("rejects an Instagram profile request beyond the bounded recent feed", async () => {
    const actor = await seedActor();
    const observed = tikhubSource();

    const rejected = await accept(
      client(actor)(socialDataContract).quote({
        headers: authenticate(actor),
        body: { ...INSTAGRAM_POSTS, limit: 50 },
      }),
      [422],
    );

    expect(rejected.body).toMatchObject({
      error: { code: "SOCIAL_DATA_UNSUPPORTED" },
    });
    expect(observed.runRequests).toBe(0);
  });

  it("settles a synchronous result once with one database connection across replay and repeated reads", async () => {
    const actor = await seedActor({ singleConnection: true });
    const observed = source();
    const before = await credits(actor);
    const body = createBody();

    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body,
      }),
      [202],
    );
    const finished = await readJob(actor, created.body.jobId);

    expect(finished.body).toMatchObject({
      requestId: body.requestId,
      status: "completed",
      data: {
        items: [
          {
            id: "comment-source-id",
            text: "Please add a team dashboard.",
            likes: 2,
          },
        ],
      },
      billing: { state: "settled", creditsCharged: 7, reservedCredits: 0 },
    });
    const replay = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body,
      }),
      [202],
    );
    expect(replay.body).toMatchObject({
      jobId: created.body.jobId,
      requestId: body.requestId,
      status: "completed",
      data: finished.body.data,
      billing: finished.body.billing,
    });
    for (let index = 0; index < 2; index += 1) {
      const read = await readJob(actor, created.body.jobId);
      expect(read.body).toMatchObject({
        jobId: created.body.jobId,
        status: "completed",
        data: finished.body.data,
        billing: finished.body.billing,
      });
    }
    expect(observed.runRequests).toBe(1);
    await expect(credits(actor)).resolves.toBe(before - 7);
  });

  it("finishes an asynchronous job using its captured tariff and charges once", async () => {
    const actor = await seedActor();
    const observed = source({ start: "async" });
    const before = await credits(actor);
    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody(),
      }),
      [202],
    );
    const running = await readJob(actor, created.body.jobId);
    expect(running.body.status).toBe("running");
    expect(running.body.billing.state).toBe("pending");
    expect(running.body.billing.creditsCharged).toBe(0);

    const changedPricing = await pricing(19);
    const reader = {
      ...actor,
      usagePricingResolution: changedPricing.resolution,
    };
    observed.pollStatus = "completed";
    const concurrentReads = await Promise.all(
      [0, 1].map(() => {
        return accept(
          client(reader)(socialDataContract).get({
            headers: authenticate(reader),
            params: { jobId: created.body.jobId },
          }),
          [200],
        );
      }),
    );
    expect(
      concurrentReads.map((response) => {
        return response.body.status;
      }),
    ).toContain("completed");
    const finished = await accept(
      client(reader)(socialDataContract).get({
        headers: authenticate(reader),
        params: { jobId: created.body.jobId },
      }),
      [200],
    );
    expect(finished.body).toMatchObject({
      status: "completed",
      billing: { state: "settled", creditsCharged: 7, reservedCredits: 0 },
    });
    const readAgain = await accept(
      client(reader)(socialDataContract).get({
        headers: authenticate(reader),
        params: { jobId: created.body.jobId },
      }),
      [200],
    );
    expect(readAgain.body).toMatchObject({
      jobId: created.body.jobId,
      status: "completed",
      data: finished.body.data,
      billing: finished.body.billing,
    });
    expect(observed.runRequests).toBe(1);
    await expect(credits(reader)).resolves.toBe(before - 7);
  });

  it("recovers an ambiguous settlement receipt without resubmitting the job", async () => {
    const actor = await seedActor();
    const observed = source({ start: "conflicting-receipt" });
    const before = await credits(actor);
    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody(),
      }),
      [202],
    );

    const unresolved = await readJob(actor, created.body.jobId);
    expect(unresolved.body).toMatchObject({
      status: "running",
      billing: { state: "pending", creditsCharged: 0 },
    });
    await expect(credits(actor)).resolves.toBe(before);

    observed.pollStatus = "completed";
    const recovered = await readJob(actor, created.body.jobId);
    expect(recovered.body).toMatchObject({
      status: "completed",
      billing: { state: "settled", creditsCharged: 7, reservedCredits: 0 },
    });
    await readJob(actor, created.body.jobId);
    expect(observed.runRequests).toBe(1);
    await expect(credits(actor)).resolves.toBe(before - 7);
  });

  it("rejects a budget below the quote without starting collection or charging", async () => {
    const actor = await seedActor();
    const observed = source();
    const before = await credits(actor);
    const response = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody({ maxCredits: 1 }),
      }),
      [402],
    );
    expect(response.body.error.code).toBe("BUDGET_EXCEEDED");
    expect(observed.runRequests).toBe(0);
    await expect(credits(actor)).resolves.toBe(before);
  });

  it("caps a successful settlement at the admitted budget", async () => {
    const actor = await seedActor();
    source({ actualCostMicros: 10_000 });
    const before = await credits(actor);
    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody({ maxCredits: 28 }),
      }),
      [202],
    );

    const finished = await readJob(actor, created.body.jobId);

    expect(finished.body).toMatchObject({
      status: "completed",
      billing: {
        state: "settled",
        creditsCharged: 28,
        reservedCredits: 0,
        maxCredits: 28,
      },
    });
    await expect(credits(actor)).resolves.toBe(before - 28);
  });

  it("rejects an input that would expand into unbounded source searches", async () => {
    const actor = await seedActor();
    const observed = source();
    const before = await credits(actor);
    const rejected = await accept(
      client(actor)(socialDataContract).quote({
        headers: authenticate(actor),
        body: {
          platform: "facebook",
          operation: "search",
          query: "business software\nteam productivity",
          limit: 2,
        },
      }),
      [422],
    );
    expect(rejected.body.error.code).toBe("SOCIAL_DATA_UNSUPPORTED");
    expect(observed.runRequests).toBe(0);
    await expect(credits(actor)).resolves.toBe(before);
  });

  it("does not charge when the source reports a failed collection", async () => {
    const actor = await seedActor();
    source({ start: "failed" });
    const before = await credits(actor);
    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody(),
      }),
      [202],
    );
    const failed = await readJob(actor, created.body.jobId);
    expect(failed.body).toMatchObject({
      status: "failed",
      billing: { state: "settled", creditsCharged: 0, reservedCredits: 0 },
    });
    await expect(credits(actor)).resolves.toBe(before);
  });

  it("rejects a reused request ID with different input", async () => {
    const actor = await seedActor();
    const observed = source();
    const before = await credits(actor);
    const body = createBody();
    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body,
      }),
      [202],
    );
    await readJob(actor, created.body.jobId);
    const conflict = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: { ...body, limit: 1 },
      }),
      [409],
    );
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(observed.runRequests).toBe(1);
    await expect(credits(actor)).resolves.toBe(before - 7);
  });

  it("recovers the result when the source cannot acknowledge cancellation", async () => {
    const actor = await seedActor();
    const observed = source({ start: "async" });
    const before = await credits(actor);
    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody(),
      }),
      [202],
    );
    await readJob(actor, created.body.jobId);

    const cancellation = await accept(
      client(actor)(socialDataContract).cancel({
        headers: authenticate(actor),
        params: { jobId: created.body.jobId },
        body: {},
      }),
      [200],
    );
    expect(cancellation.body).toMatchObject({
      status: "running",
      billing: { state: "pending", creditsCharged: 0 },
    });

    observed.pollStatus = "completed";
    const finished = await readJob(actor, created.body.jobId);
    expect(finished.body).toMatchObject({
      status: "completed",
      billing: { state: "settled", creditsCharged: 7, reservedCredits: 0 },
    });
    expect(observed.runRequests).toBe(1);
    expect(observed.stopRequests).toBeGreaterThan(0);
    await expect(credits(actor)).resolves.toBe(before - 7);
  });

  it.each(["different-user", "different-org"] as const)(
    "hides saved jobs from a %s on reads, cancellation, and listing",
    async (scope) => {
      const owner = await seedActor();
      source({ start: "async" });
      const created = await accept(
        client(owner)(socialDataContract).create({
          headers: authenticate(owner),
          body: createBody(),
        }),
        [202],
      );
      const identity = createBddApi(context).user(
        scope === "different-user"
          ? { orgId: owner.orgId, orgRole: "org:member" }
          : { userId: owner.userId, orgId: `org_${randomUUID()}` },
      );
      if (!identity.orgId) {
        throw new Error("Foreign test actor must have an organization");
      }
      const foreign = {
        ...identity,
        orgId: identity.orgId,
        usagePricingResolution: owner.usagePricingResolution,
      };
      await enable(foreign);
      const foreignClient = client(foreign)(socialDataContract);
      await accept(
        foreignClient.get({
          headers: authenticate(foreign),
          params: { jobId: created.body.jobId },
        }),
        [404],
      );
      await accept(
        foreignClient.cancel({
          headers: authenticate(foreign),
          params: { jobId: created.body.jobId },
          body: {},
        }),
        [404],
      );
      const listed = await accept(
        foreignClient.list({
          headers: authenticate(foreign),
          query: { limit: 20 },
        }),
        [200],
      );
      expect(listed.body.jobs).toStrictEqual([]);
      const ownJobs = await accept(
        client(owner)(socialDataContract).list({
          headers: authenticate(owner),
          query: { limit: 20 },
        }),
        [200],
      );
      expect(ownJobs.body.jobs).toStrictEqual([
        expect.objectContaining({
          jobId: created.body.jobId,
          requestId: created.body.requestId,
        }),
      ]);
    },
  );

  it("does not recreate jobs or charge after scoped cleanup during collection", async () => {
    const actor = await seedActor();
    const before = await credits(actor);
    const requestStarted = createDeferredPromise<void>(context.signal);
    const releaseResponse = createDeferredPromise<void>(context.signal);
    const observed = source({
      beforeRunResponse: async () => {
        requestStarted.resolve(undefined);
        await releaseResponse.promise;
      },
    });
    const api = client(actor)(socialDataContract);
    const created = await accept(
      api.create({
        headers: authenticate(actor),
        body: createBody(),
      }),
      [202],
    );
    await requestStarted.promise;
    await accept(
      setupApp({ context, routes: testUsageStateRoutes })(
        testUsageStateContract,
      ).action({
        body: {
          action: "delete-usage-data",
          scope: "organization",
          id: actor.orgId,
        },
      }),
      [200],
    );
    releaseResponse.resolve(undefined);
    await flushWaitUntilForTest();

    await accept(
      api.get({
        headers: authenticate(actor),
        params: { jobId: created.body.jobId },
      }),
      [404],
    );
    await accept(
      api.get({
        headers: authenticate(actor),
        params: { jobId: created.body.jobId },
      }),
      [404],
    );
    const listed = await accept(
      api.list({
        headers: authenticate(actor),
        query: { limit: 20 },
      }),
      [200],
    );
    expect(listed.body.jobs).toStrictEqual([]);
    const usage = await accept(
      client(actor)(usageRecordContract).get({
        headers: authenticate(actor),
        query: {
          page: 1,
          pageSize: 20,
          scope: "mine",
          range: "24h",
          tz: "UTC",
        },
      }),
      [200],
    );
    expect(usage.body).toMatchObject({
      totalCredits: 0,
      rows: [],
      pagination: { total: 0 },
    });
    expect(observed.runRequests).toBe(1);
    await expect(credits(actor)).resolves.toBe(before);
  });

  it("collects WeChat Official Account comments through a per-call plan", async () => {
    const actor = await seedActor();
    const observed = tikhubPlanSource({
      endpoint: "/api/v1/wechat_mp/v2/fetch_article_comments",
      location: "body",
      properties: { url: { type: "string" }, raw: { type: "boolean" } },
      required: ["url"],
      output: {
        elected_total: 1,
        comments: [
          {
            content_id: "6255846262940111556",
            nick_name: "A reader",
            content: "A clear breakdown of the launch.",
            like_num: 87,
            create_time: 1_741_148_719,
            reply_total: 2,
          },
        ],
      },
    });
    const before = await credits(actor);
    const request = {
      platform: "wechat",
      operation: "comments",
      url: "https://mp.weixin.qq.com/s/TSNQKkRpN1qbKsT7BvzqIw",
      limit: 20,
    } as const satisfies SocialDataRequest;

    const quote = await accept(
      client(actor)(socialDataContract).quote({
        headers: authenticate(actor),
        body: request,
      }),
      [200],
    );
    expect(quote.body).toMatchObject({
      platform: "wechat",
      operation: "comments",
      quantity: 1,
      unit: "request",
      estimatedCredits: 105,
    });

    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody(request),
      }),
      [202],
    );
    const finished = await readJob(actor, created.body.jobId);

    expect(observed.runInput).toStrictEqual({
      provider: "tikhub",
      endpoint: "/api/v1/wechat_mp/v2/fetch_article_comments",
      input: { body: { url: request.url, raw: false } },
    });
    expect(finished.body).toMatchObject({
      status: "completed",
      data: {
        items: [
          {
            id: "6255846262940111556",
            text: "A clear breakdown of the launch.",
            displayName: "A reader",
            likes: 87,
            replies: 2,
            publishedAt: "2025-03-05T04:25:19.000Z",
          },
        ],
      },
      billing: { state: "settled", creditsCharged: 105 },
    });
    await expect(credits(actor)).resolves.toBe(before - 105);
  });

  it("inspects one Threads profile by its exact handle", async () => {
    const actor = await seedActor();
    const observed = tikhubPlanSource({
      endpoint: "/api/v1/threads/web/search_profiles",
      location: "queryParams",
      properties: { query: { type: "string" } },
      required: ["query"],
      output: {
        xdt_api__v1__users__search_connection: {
          edges: [
            {
              node: {
                pk: "63625256886",
                username: "example",
                full_name: "Example Newsroom",
              },
            },
            {
              node: {
                pk: "63266688630",
                username: "examplejapan",
                full_name: "Example Newsroom Japan",
              },
            },
          ],
        },
      },
    });

    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody({
          platform: "threads",
          operation: "inspect",
          url: "https://www.threads.com/@example",
          limit: 1,
        }),
      }),
      [202],
    );
    const finished = await readJob(actor, created.body.jobId);

    expect(observed.runInput).toMatchObject({
      input: { queryParams: { query: "example" } },
    });
    expect(finished.body).toMatchObject({
      status: "completed",
      data: {
        items: [
          {
            id: "63625256886",
            username: "example",
            displayName: "Example Newsroom",
            url: "https://www.threads.com/@example",
          },
        ],
      },
    });
    expect(observed.runRequests).toBe(1);
  });

  it("normalizes WeChat search rows into plain text and secure links", async () => {
    const actor = await seedActor();
    const observed = tikhubPlanSource({
      endpoint: "/api/v1/wechat_search/v2/fetch_search",
      location: "body",
      properties: {
        keyword: { type: "string" },
        business_type: { type: "string" },
        raw: { type: "boolean" },
      },
      required: ["keyword"],
      output: {
        keyword: "product launch",
        items: [
          {
            docID: "6635276584364799119",
            title: 'A <em class="highlight">product launch</em> retrospective',
            desc: 'What the <em class="highlight">launch</em> week measured',
            doc_url:
              "http://mp.weixin.qq.com/s?__biz=MzA3NjM5MjIwOQ==&mid=2652281110&idx=1&sn=b58291a2183c423afa62d28107ba2958",
            date: 1_741_148_719,
            source: { title: "Example Daily" },
            thumbUrl: "https://mmbiz.qpic.cn/mmbiz_jpg/example/640",
          },
        ],
      },
    });
    const request = {
      platform: "wechat",
      operation: "search",
      query: "product launch",
      type: "article",
      limit: 5,
    } as const satisfies SocialDataRequest;

    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: { ...request, requestId: randomUUID() },
      }),
      [202],
    );
    const finished = await readJob(actor, created.body.jobId);

    expect(observed.runInput).toStrictEqual({
      provider: "tikhub",
      endpoint: "/api/v1/wechat_search/v2/fetch_search",
      input: {
        body: {
          keyword: "product launch",
          business_type: "article",
          raw: false,
        },
      },
    });
    expect(finished.body).toMatchObject({
      status: "completed",
      data: {
        items: [
          {
            id: "6635276584364799119",
            title: "A product launch retrospective",
            text: "What the launch week measured",
            url: "https://mp.weixin.qq.com/s?__biz=MzA3NjM5MjIwOQ==&mid=2652281110&idx=1&sn=b58291a2183c423afa62d28107ba2958",
            displayName: "Example Daily",
            publishedAt: "2025-03-05T04:25:19.000Z",
            mediaUrls: ["https://mmbiz.qpic.cn/mmbiz_jpg/example/640"],
          },
        ],
      },
    });
  });

  it("inspects one WeChat Official Account article", async () => {
    const actor = await seedActor();
    const observed = tikhubPlanSource({
      endpoint: "/api/v1/wechat_mp/v2/fetch_article_detail_h5",
      location: "body",
      properties: { url: { type: "string" }, raw: { type: "boolean" } },
      required: ["url"],
      output: {
        url: "https://mp.weixin.qq.com/s/TSNQKkRpN1qbKsT7BvzqIw",
        content: {
          title: "Launch day results",
          nick_name: "Example Daily",
          user_name: "gh_114e76fd6e5d",
          desc: "What changed this week",
          content_text: "The full article text.",
          create_timestamp: 1_741_148_529,
          cdn_url: "https://mmbiz.qpic.cn/mmbiz_jpg/example/0",
          sn: "24a33e0bf7a46cd28911be93eff3b531",
        },
      },
    });
    const request = {
      platform: "wechat",
      operation: "inspect",
      url: "https://mp.weixin.qq.com/s/TSNQKkRpN1qbKsT7BvzqIw",
      limit: 1,
    } as const satisfies SocialDataRequest;

    const created = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: { ...request, requestId: randomUUID() },
      }),
      [202],
    );
    const finished = await readJob(actor, created.body.jobId);

    expect(observed.runInput).toStrictEqual({
      provider: "tikhub",
      endpoint: "/api/v1/wechat_mp/v2/fetch_article_detail_h5",
      input: { body: { url: request.url, raw: false } },
    });
    expect(finished.body).toMatchObject({
      status: "completed",
      data: {
        items: [
          {
            id: "24a33e0bf7a46cd28911be93eff3b531",
            url: request.url,
            title: "Launch day results",
            description: "What changed this week",
            text: "The full article text.",
            username: "gh_114e76fd6e5d",
            displayName: "Example Daily",
            publishedAt: "2025-03-05T04:22:09.000Z",
            mediaUrls: ["https://mmbiz.qpic.cn/mmbiz_jpg/example/0"],
          },
        ],
      },
    });
  });

  it("rejects unsupported new-platform targets before execution", async () => {
    const actor = await seedActor();
    const observed = source();
    for (const body of [
      {
        platform: "threads",
        operation: "posts",
        url: "https://www.threads.com/@example",
        limit: 10,
      },
      {
        platform: "wechat",
        operation: "inspect",
        url: "https://mp.weixin.qq.com/mp/homepage",
        limit: 1,
      },
    ] as const satisfies readonly SocialDataRequest[]) {
      await accept(
        client(actor)(socialDataContract).quote({
          headers: authenticate(actor),
          body,
        }),
        [422],
      );
    }
    expect(observed.runRequests).toBe(0);
  });

  it("retains separate platform identifiers in the public usage breakdown", async () => {
    const actor = await seedActor();
    source();
    const youtubeJob = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody(),
      }),
      [202],
    );
    await readJob(actor, youtubeJob.body.jobId);
    source({ endpoint: X_ENDPOINT });
    const xJob = await accept(
      client(actor)(socialDataContract).create({
        headers: authenticate(actor),
        body: createBody({
          platform: "x",
          operation: "inspect",
          url: "https://x.com/example/status/1234567890123456789",
          limit: 1,
        }),
      }),
      [202],
    );
    await readJob(actor, xJob.body.jobId);
    const usage = await accept(
      client(actor)(usageRecordContract).get({
        headers: authenticate(actor),
        query: {
          page: 1,
          pageSize: 20,
          scope: "mine",
          range: "24h",
          tz: "UTC",
        },
      }),
      [200],
    );
    expect(usage.body.totalCredits).toBe(14);
    expect(usage.body.rows).toStrictEqual([
      expect.objectContaining({
        credits: 14,
        breakdown: [
          {
            kind: "other",
            credits: 14,
            providers: expect.arrayContaining([
              {
                provider: "monid/x",
                credits: 7,
                usageKinds: [{ kind: "social", credits: 7 }],
              },
              {
                provider: "monid/youtube",
                credits: 7,
                usageKinds: [{ kind: "social", credits: 7 }],
              },
            ]),
          },
        ],
      }),
    ]);
  });
});
