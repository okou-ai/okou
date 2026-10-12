import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import { seoContract } from "@okouai/api-contracts/contracts/seo";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { seoRoutes } from "../../seo";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

/** A normal SEO request settles the provider-reported cost at migration 1078's tariff. */
export async function chargePublicSeoUsage(
  context: TestContext,
  actor: ApiTestUser,
  credits: number,
): Promise<void> {
  mockEnv("OKOU_SEO_DATAFORSEO_LOGIN", "billing-lifecycle-provider");
  mockEnv("OKOU_SEO_DATAFORSEO_PASSWORD", "billing-lifecycle-provider-secret");
  const cost = credits / 1250;
  const providerResponse = {
    version: "0.1.20260810",
    status_code: 20_000,
    status_message: "Ok.",
    time: "0.1000 sec.",
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: "billing-seo-task",
        status_code: 20_000,
        status_message: "Ok.",
        time: "0.1000 sec.",
        cost,
        result_count: 1,
        result: [{ keyword: "site:example.com", items: [], items_count: 0 }],
      },
    ],
  };
  let requests = 0;
  server.use(
    http.post(
      "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
      () => {
        requests += 1;
        return HttpResponse.json(providerResponse);
      },
    ),
  );
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const response = await accept(
    setupApp({ context, routes: seoRoutes })(seoContract).serp({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        query: "site:example.com",
        provider: "dataforseo",
        engine: "google",
        location: "United States",
        languageCode: "en",
        device: "desktop",
        limit: 10,
      },
    }),
    [200],
  );
  expect(response.body).toMatchObject({
    providerCostUsd: cost,
    creditsCharged: credits,
  });
  expect(requests).toBe(1);
}
