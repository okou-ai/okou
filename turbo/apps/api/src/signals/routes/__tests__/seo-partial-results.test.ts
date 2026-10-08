import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { seoContract } from "@okouai/api-contracts/contracts/seo";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { billingStatusRoutes } from "../billing-status";
import { seoRoutes } from "../seo";

const context = testContext();
const DATAFORSEO_BASE_URL = "https://api.dataforseo.com";
const GOOGLE_SERP_URL = `${DATAFORSEO_BASE_URL}/v3/serp/google/organic/live/advanced`;

async function setupPartialResultsTest() {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("SEO test actor must belong to an organization");
  }
  await createRunsApi(context).grantProEntitlement({
    ...actor,
    orgId: actor.orgId,
  });
  mockEnv("OKOU_SEO_DATAFORSEO_LOGIN", "test-dataforseo-login");
  mockEnv("OKOU_SEO_DATAFORSEO_PASSWORD", "test-dataforseo-password");
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const app = setupApp({
    context,
    routes: [...seoRoutes, ...billingStatusRoutes],
    rethrowErrors: true,
  });
  return {
    client: app(seoContract),
    headers,
    async credits() {
      const response = await accept(
        app(billingStatusContract).get({ headers }),
        [200],
      );
      return response.body.credits;
    },
  };
}

function partialSearchResultsResponse(cost: number) {
  return {
    version: "0.1.20260810",
    status_code: 20_000,
    status_message: "Ok.",
    time: "0.1000 sec.",
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: "seo-task",
        status_code: 40_106,
        status_message:
          "Task completed with partial results. Some pages could not be retrieved after several retry attempts. You have not been charged for the pages that were not returned.",
        time: "0.1000 sec.",
        cost,
        result_count: 1,
        result: [
          {
            keyword: "technical seo",
            type: "organic",
            location_code: 2840,
            language_code: "en",
            pages_count: 1,
            items_count: 1,
            items: [
              {
                type: "organic",
                rank_absolute: 1,
                title: "Technical SEO guide",
                url: "https://example.com/seo",
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("SEO partial SERP results", () => {
  it.each([
    { engine: "google", cost: 0.002, billingQuantity: 2000, creditsCharged: 3 },
    {
      engine: "google_news",
      cost: 0.004,
      billingQuantity: 4000,
      creditsCharged: 5,
    },
    { engine: "bing", cost: 0, billingQuantity: 0, creditsCharged: 0 },
  ] as const)(
    "returns $engine partial results at cost $cost without retrying",
    async ({ engine, cost, billingQuantity, creditsCharged }) => {
      const { client, headers, credits } = await setupPartialResultsTest();
      const beforeCredits = await credits();
      const providerResponse = partialSearchResultsResponse(cost);
      let providerRequests = 0;
      const endpoint =
        engine === "google_news" ? "google/news" : `${engine}/organic`;
      server.use(
        http.post(
          `${DATAFORSEO_BASE_URL}/v3/serp/${endpoint}/live/advanced`,
          () => {
            providerRequests += 1;
            return HttpResponse.json(providerResponse);
          },
        ),
      );

      const response = await accept(
        client.serp({
          headers,
          body: { query: "technical seo", engine, limit: 100 },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        operation: "serp",
        provider: "dataforseo",
        billingCategory: "provider_cost_usd_micros",
        billingQuantity,
        providerCostUsd: cost,
        creditsCharged,
        result: providerResponse,
        partialResults: true,
      });
      expect(providerRequests).toBe(1);
      expect(beforeCredits - (await credits())).toBe(creditsCharged);
    },
  );

  it("returns partial results after a transient 40101 retry and charges only the completed result", async () => {
    const { client, headers, credits } = await setupPartialResultsTest();
    const beforeCredits = await credits();
    const providerResponse = partialSearchResultsResponse(0.002);
    let providerRequests = 0;
    server.use(
      http.post(GOOGLE_SERP_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(
          providerRequests === 1
            ? {
                ...providerResponse,
                tasks: providerResponse.tasks.map((task) => {
                  return {
                    ...task,
                    status_code: 40_101,
                    status_message: "Internal SE Server Error.",
                    result_count: 0,
                    result: null,
                  };
                }),
              }
            : providerResponse,
        );
      }),
    );

    const response = await accept(
      client.serp({
        headers,
        body: { query: "technical seo", engine: "google", limit: 100 },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      partialResults: true,
      billingQuantity: 2000,
      providerCostUsd: 0.002,
      creditsCharged: 3,
      result: providerResponse,
    });
    expect(providerRequests).toBe(2);
    expect(beforeCredits - (await credits())).toBe(3);
  });

  it.each([
    {
      failure: "HTTP error",
      httpStatus: 500,
      statusCode: 20_000,
      tasksError: 0,
    },
    {
      failure: "provider error",
      httpStatus: 200,
      statusCode: 50_000,
      tasksError: 0,
    },
    {
      failure: "task envelope error",
      httpStatus: 200,
      statusCode: 20_000,
      tasksError: 1,
    },
  ])(
    "does not hide a $failure behind partial results",
    async ({ httpStatus, statusCode, tasksError }) => {
      const { client, headers, credits } = await setupPartialResultsTest();
      const beforeCredits = await credits();
      let providerRequests = 0;
      server.use(
        http.post(GOOGLE_SERP_URL, () => {
          providerRequests += 1;
          return HttpResponse.json(
            {
              ...partialSearchResultsResponse(0.002),
              status_code: statusCode,
              tasks_error: tasksError,
            },
            { status: httpStatus },
          );
        }),
      );

      const response = await accept(
        client.serp({
          headers,
          body: { query: "technical seo", engine: "google", limit: 100 },
        }),
        [502],
      );

      expect(response.body.error.code).toBe("DATAFORSEO_UPSTREAM_ERROR");
      expect(providerRequests).toBe(1);
      await expect(credits()).resolves.toBe(beforeCredits);
    },
  );

  it.each([
    { failure: "missing results", result: null, tasksCount: 1 },
    { failure: "empty results", result: [], tasksCount: 1 },
    { failure: "missing items", result: [{}], tasksCount: 1 },
    { failure: "empty items", result: [{ items: [] }], tasksCount: 1 },
    { failure: "malformed items", result: [{ items: [null] }], tasksCount: 1 },
    {
      failure: "inconsistent task count",
      result: [{ items: [{ title: "SEO" }] }],
      tasksCount: 0,
    },
  ])(
    "rejects partial results with $failure without charging or retrying",
    async ({ result, tasksCount }) => {
      const { client, headers, credits } = await setupPartialResultsTest();
      const beforeCredits = await credits();
      const providerResponse = partialSearchResultsResponse(0.002);
      let providerRequests = 0;
      server.use(
        http.post(GOOGLE_SERP_URL, () => {
          providerRequests += 1;
          return HttpResponse.json({
            ...providerResponse,
            tasks_count: tasksCount,
            tasks: providerResponse.tasks.map((task) => {
              return { ...task, result };
            }),
          });
        }),
      );

      const response = await accept(
        client.serp({
          headers,
          body: { query: "technical seo", engine: "google", limit: 100 },
        }),
        [502],
      );

      expect(response.body.error.code).toBe("DATAFORSEO_INVALID_RESPONSE");
      expect(providerRequests).toBe(1);
      await expect(credits()).resolves.toBe(beforeCredits);
    },
  );

  it("does not treat partial results as success outside SERP", async () => {
    const { client, headers, credits } = await setupPartialResultsTest();
    const beforeCredits = await credits();
    server.use(
      http.post(`${DATAFORSEO_BASE_URL}/v3/backlinks/summary/live`, () => {
        return HttpResponse.json(partialSearchResultsResponse(0.002));
      }),
    );

    const response = await accept(
      client.backlinksSummary({
        headers,
        body: { target: "example.com", includeSubdomains: false },
      }),
      [502],
    );

    expect(response.body.error.code).toBe("DATAFORSEO_UPSTREAM_ERROR");
    await expect(credits()).resolves.toBe(beforeCredits);
  });
});
