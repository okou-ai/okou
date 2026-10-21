import { Buffer } from "node:buffer";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { commerceContract } from "@okouai/api-contracts/contracts/commerce";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { billingStatusRoutes } from "../billing-status";
import { commerceRoutes } from "../commerce";
import { usageRecordRoutes } from "../usage-record";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createPublicUnfundedProFixture } from "./helpers/public-unfunded-pro-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const BASE = "https://api.dataforseo.com/v3/merchant/amazon";
const ROUTES = Object.freeze([
  ...commerceRoutes,
  ...billingStatusRoutes,
  ...usageRecordRoutes,
]);

function client() {
  return setupApp({ context, routes: ROUTES });
}
function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}
function actor() {
  const orgId = createUniqueStaffOrgIdFixture();
  return { ...createBddApi(context).user({ orgId }), orgId };
}
async function fundedActor() {
  const user = actor();
  await createRunsApi(context).grantProEntitlement(user);
  return user;
}
function configureProvider() {
  mockEnv("OKOU_SEO_DATAFORSEO_LOGIN", "commerce-test-login");
  mockEnv("OKOU_SEO_DATAFORSEO_PASSWORD", "commerce-test-password");
}
function providerResponse(cost: number, result: unknown) {
  return {
    version: "0.1.20261001",
    status_code: 20_000,
    status_message: "Ok.",
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: "amazon-task",
        status_code: 20_000,
        status_message: "Ok.",
        cost,
        result_count: 1,
        result,
      },
    ],
  };
}
async function credits(user: ApiTestUser) {
  return (
    await accept(
      client()(billingStatusContract).get({ headers: authenticate(user) }),
      [200],
    )
  ).body.credits;
}
async function personalUsage(user: ApiTestUser) {
  return (
    await accept(
      client()(usageRecordContract).get({
        headers: authenticate(user),
        query: { scope: "mine", range: "24h", tz: "UTC" },
      }),
      [200],
    )
  ).body;
}

describe("Commerce Amazon routes", () => {
  it("requires authentication before accessing commerce", async () => {
    const response = await accept(
      client()(commerceContract).search({
        headers: {},
        body: { query: "coffee" },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("keeps the staff rollout closed even with a non-staff user override", async () => {
    const user = createBddApi(context).user();
    if (!user.orgId) {
      throw new Error("Expected an organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: user.userId, orgId: user.orgId },
      { [FeatureSwitchKey.Commerce]: true },
    );
    let calls = 0;
    server.use(
      http.post(`${BASE}/products/live/advanced`, () => {
        calls += 1;
        return HttpResponse.json(providerResponse(0.0033, []));
      }),
    );
    const response = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee" },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FEATURE_UNAVAILABLE");
    expect(calls).toBe(0);
  });

  it("lets staff disable commerce without contacting the provider", async () => {
    const user = actor();
    await updateFeatureSwitchesForUser(
      context,
      { userId: user.userId, orgId: user.orgId },
      { [FeatureSwitchKey.Commerce]: false },
    );
    const response = await accept(
      client()(commerceContract).inspect({
        headers: authenticate(user),
        body: { target: "B085RFFC9Q" },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FEATURE_UNAVAILABLE");
  });

  it("searches a bounded US page, normalizes items and settles actual reported cost", async () => {
    const user = await fundedActor();
    configureProvider();
    const beforeCredits = await credits(user);
    const beforeUsage = await personalUsage(user);
    const observed: unknown[] = [];
    const products = [
      { type: "amazon_serp", title: "Coffee Maker", data_asin: "B085RFFC9Q" },
    ];
    const source = providerResponse(0.003301, [
      { type: "products", items_count: 1, items: products },
    ]);
    // The documented top-level total cost, not a result count or nested price,
    // is the source of truth for settlement.
    const sourceTask = source.tasks[0];
    if (!sourceTask) {
      throw new Error("Expected one provider task");
    }
    sourceTask.cost = 0.0033;
    server.use(
      http.post(`${BASE}/products/live/advanced`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from("commerce-test-login:commerce-test-password").toString("base64")}`,
        );
        observed.push(await request.json());
        return HttpResponse.json(source);
      }),
    );
    const response = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee maker" },
      }),
      [200],
    );
    expect(observed).toStrictEqual([
      [
        {
          keyword: "coffee maker",
          se_domain: "amazon.com",
          location_code: 2840,
          language_code: "en_US",
          depth: 48,
          max_crawl_pages: 1,
        },
      ],
    ]);
    expect(response.body).toMatchObject({
      operation: "search",
      provider: "dataforseo",
      marketplace: "amazon.com",
      billingCategory: "provider_cost_usd_micros",
      billingQuantity: 3301,
      providerCostUsd: 0.003301,
      result: { items: products, source },
    });
    expect(response.body.creditsCharged).toBeGreaterThan(0);
    const charged = response.body.creditsCharged;
    if (charged === null) {
      throw new Error("Expected settled commerce usage");
    }
    await expect(credits(user)).resolves.toBe(beforeCredits - charged);
    const mine = await personalUsage(user);
    expect(mine.totalCredits).toBe(beforeUsage.totalCredits + charged);
    expect(
      mine.rows
        .flatMap((row) => {
          return row.breakdown;
        })
        .flatMap((kind) => {
          return kind.providers;
        }),
    ).toContainEqual(
      expect.objectContaining({
        provider: "dataforseo",
        usageKinds: expect.arrayContaining([
          expect.objectContaining({ kind: "commerce" }),
        ]),
      }),
    );
    const colleague = createBddApi(context).user({ orgId: user.orgId });
    expect((await personalUsage(colleague)).totalCredits).toBe(0);
  });

  it("preserves an inspect URL marketplace instead of silently defaulting to US", async () => {
    const user = await fundedActor();
    configureProvider();
    const product = {
      type: "amazon_product_info",
      data_asin: "B085RFFC9Q",
      title: "Coffee Maker",
      se_domain: "amazon.co.uk",
    };
    const observed: unknown[] = [];
    server.use(
      http.post(`${BASE}/asin/live/advanced`, async ({ request }) => {
        observed.push(await request.json());
        return HttpResponse.json(
          providerResponse(0.005, [
            { type: "asin", asin: "B085RFFC9Q", items: [product] },
          ]),
        );
      }),
    );
    const response = await accept(
      client()(commerceContract).inspect({
        headers: authenticate(user),
        body: {
          target:
            "https://www.amazon.co.uk/Coffee-Maker/dp/B085RFFC9Q?tag=ignored",
        },
      }),
      [200],
    );
    expect(observed).toStrictEqual([
      [
        {
          asin: "B085RFFC9Q",
          se_domain: "amazon.co.uk",
          location_code: 2826,
          language_code: "en_GB",
        },
      ],
    ]);
    expect(response.body).toMatchObject({
      operation: "inspect",
      marketplace: "amazon.co.uk",
      billingQuantity: 5000,
      result: { items: [product] },
    });
  });

  it("normalizes a bare ASIN and applies an explicit marketplace", async () => {
    const user = await fundedActor();
    configureProvider();
    const observed: unknown[] = [];
    server.use(
      http.post(`${BASE}/asin/live/advanced`, async ({ request }) => {
        observed.push(await request.json());
        return HttpResponse.json(
          providerResponse(0, [
            {
              type: "asin",
              items: [{ type: "amazon_product_info", data_asin: "B085RFFC9Q" }],
            },
          ]),
        );
      }),
    );
    const response = await accept(
      client()(commerceContract).inspect({
        headers: authenticate(user),
        body: { target: "b085rffc9q", marketplace: "amazon.de" },
      }),
      [200],
    );
    expect(observed).toStrictEqual([
      [
        {
          asin: "B085RFFC9Q",
          se_domain: "amazon.de",
          location_code: 2276,
          language_code: "de_DE",
        },
      ],
    ]);
    expect(response.body).toMatchObject({
      marketplace: "amazon.de",
      billingQuantity: 0,
      creditsCharged: 0,
    });
  });

  it("bounds normalized search items even when the upstream returns extra entries", async () => {
    const user = await fundedActor();
    configureProvider();
    const observed: unknown[] = [];
    server.use(
      http.post(`${BASE}/products/live/advanced`, async ({ request }) => {
        observed.push(await request.json());
        return HttpResponse.json(
          providerResponse(0.0033, [
            {
              items: [
                { type: "related_searches", items: ["coffee mugs"] },
                {
                  type: "editorial_recommendations",
                  items: [
                    { type: "amazon_serp", title: "Nested recommendation" },
                  ],
                },
                { type: "amazon_serp", title: "First" },
                { type: "amazon_paid", title: "Second" },
              ],
            },
            { items: [{ type: "amazon_serp", title: "Third" }] },
          ]),
        );
      }),
    );
    const response = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee", marketplace: "amazon.ca", limit: 1 },
      }),
      [200],
    );
    expect(response.body.result.items).toStrictEqual([
      { type: "amazon_serp", title: "First" },
    ]);
    expect(observed).toStrictEqual([
      [
        {
          keyword: "coffee",
          se_domain: "amazon.ca",
          location_code: 2124,
          language_code: "en_US",
          depth: 1,
          max_crawl_pages: 1,
        },
      ],
    ]);
  });

  it("rejects generic scrape URLs, mismatched marketplaces and unbounded search input before provider access", async () => {
    const user = actor();
    configureProvider();
    let calls = 0;
    server.use(
      http.post(`${BASE}/:operation/live/advanced`, () => {
        calls += 1;
        return HttpResponse.json(providerResponse(0, []));
      }),
    );
    const commerce = client()(commerceContract);
    for (const target of [
      "https://example.com/dp/B085RFFC9Q",
      "https://www.amazon.com/s?k=coffee",
      "https://amazon.com.evil.test/dp/B085RFFC9Q",
    ]) {
      await accept(
        commerce.inspect({ headers: authenticate(user), body: { target } }),
        [400],
      );
    }
    await accept(
      commerce.inspect({
        headers: authenticate(user),
        body: {
          target: "https://amazon.co.uk/dp/B085RFFC9Q",
          marketplace: "amazon.com",
        },
      }),
      [400],
    );
    await accept(
      commerce.search({
        headers: authenticate(user),
        body: { query: "https://amazon.com/dp/B085RFFC9Q" },
      }),
      [400],
    );
    await accept(
      commerce.search({
        headers: authenticate(user),
        body: { query: "coffee", limit: 49 },
      }),
      [400],
    );
    expect(calls).toBe(0);
  });

  it("requires managed credit preflight before sending a billable provider task", async () => {
    const user = actor();
    const fixture = createPublicUnfundedProFixture(context, user);
    await fixture.initialize();
    configureProvider();
    let calls = 0;
    server.use(
      http.post(`${BASE}/products/live/advanced`, () => {
        calls += 1;
        return HttpResponse.json(providerResponse(0.0033, []));
      }),
    );
    await fixture.run(async () => {
      const response = await accept(
        client()(commerceContract).search({
          headers: authenticate(user),
          body: { query: "coffee" },
        }),
        [402],
      );
      expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
      expect(calls).toBe(0);
    });
  });

  it("returns a billable empty search when DataForSEO reports no results", async () => {
    const user = await fundedActor();
    configureProvider();
    const source = providerResponse(0.0033, null);
    const task = source.tasks[0];
    if (!task) {
      throw new Error("Expected one provider task");
    }
    task.status_code = 40_102;
    task.status_message = "No Search Results.";
    source.tasks_error = 1;
    server.use(
      http.post(`${BASE}/products/live/advanced`, () => {
        return HttpResponse.json(source);
      }),
    );
    const response = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "no matching product" },
      }),
      [200],
    );
    expect(response.body.result.items).toStrictEqual([]);
    expect(response.body.billingQuantity).toBe(3300);
    expect(response.body.creditsCharged).toBeGreaterThan(0);
  });

  it("reports provider task failures without a successful usage charge or paid retry", async () => {
    const user = await fundedActor();
    configureProvider();
    const before = await credits(user);
    let calls = 0;
    const source = providerResponse(0, null);
    source.tasks_error = 1;
    source.tasks[0] = {
      ...source.tasks[0],
      id: "failed-task",
      status_code: 50_401,
      status_message: "Task timeout",
      cost: 0,
      result_count: 0,
      result: null,
    };
    server.use(
      http.post(`${BASE}/asin/live/advanced`, () => {
        calls += 1;
        return HttpResponse.json(source);
      }),
    );
    const response = await accept(
      client()(commerceContract).inspect({
        headers: authenticate(user),
        body: { target: "B085RFFC9Q" },
      }),
      [502],
    );
    expect(response.body.error.code).toBe("COMMERCE_TASK_ERROR");
    expect(calls).toBe(1);
    await expect(credits(user)).resolves.toBe(before);
  });

  it("rejects an invalid provider cost rather than returning or settling untrusted usage", async () => {
    const user = await fundedActor();
    configureProvider();
    const before = await credits(user);
    server.use(
      http.post(`${BASE}/products/live/advanced`, () => {
        return HttpResponse.json({
          ...providerResponse(0, [{ items: [] }]),
          cost: -1,
        });
      }),
    );
    const response = await accept(
      client()(commerceContract).search({
        headers: authenticate(user),
        body: { query: "coffee" },
      }),
      [502],
    );
    expect(response.body.error.code).toBe("COMMERCE_INVALID_RESPONSE");
    await expect(credits(user)).resolves.toBe(before);
  });
});
