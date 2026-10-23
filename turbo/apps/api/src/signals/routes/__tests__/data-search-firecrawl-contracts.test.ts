import {
  dataSearchContract,
  type DataSearchRequest,
} from "@okouai/api-contracts/contracts/data-search";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { dataSearchRoutes } from "../data-search";
import affiliate from "./fixtures/data-search/affiliate-com-openapi.json";
import trends from "./fixtures/data-search/firecrawl-trends-openapi.json";
import finance from "./fixtures/data-search/fiscal-ai-openapi.json";
import creators from "./fixtures/data-search/oriane-openapi.json";
import podcasts from "./fixtures/data-search/particle-openapi.json";
import apps from "./fixtures/data-search/play-google-com-openapi.json";
import traffic from "./fixtures/data-search/similarweb-openapi.json";
import ads from "./fixtures/data-search/upspring-openapi.json";
import history from "./fixtures/data-search/web-archive-org-openapi.json";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicBillingScenario } from "./helpers/public-billing-scenario";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function scenario() {
  const app = await setupApp({ context, routes: dataSearchRoutes });
  const actor = createBddApi(context).user();
  const billing = createPublicBillingScenario(context);
  let restoreSetup: (() => void) | undefined;
  billing.releaseBeforeDrain(() => {
    return restoreSetup?.();
  });
  await billing.run(() => {
    return createRunsApi(context).grantProEntitlement(actor, {
      run: billing.run,
      onExternalStateReady(restore) {
        restoreSetup = restore;
        billing.captureExternalState();
      },
    });
  });
  restoreSetup = undefined;
  mockEnv(
    "OKOU_SCRAPE_FIRECRAWL_TOKEN",
    "firecrawl-contract-test-not-a-real-token",
  );
  mockEnv("OKOU_DATA_FIRECRAWL_USD_MICROS_PER_CREDIT", 1000);
  return { actor, run: billing.run, data: app(dataSearchContract) };
}

// Immutable excerpts of saved public guides, not application-owned schema mocks.
// _review is provenance only; no runtime schema or pricing is derived from it.
interface FirecrawlQuoteCase {
  readonly capability: string;
  readonly fixture: { readonly _review: { readonly sourceUrl: string } };
  readonly input: DataSearchRequest["input"];
  readonly limit?: number;
  readonly credits: number;
  readonly unit: "request" | "metric";
}
const cases = Object.freeze<readonly FirecrawlQuoteCase[]>([
  {
    capability: "traffic.overview",
    fixture: traffic,
    input: { domain: "example.com", month: "2026-09", metrics: ["visits"] },
    limit: 1,
    credits: 138,
    unit: "metric",
  },
  {
    capability: "ads.search",
    fixture: ads,
    input: { query: "productivity software" },
    credits: 63,
    unit: "request",
  },
  {
    capability: "trends.related",
    fixture: trends,
    input: { keyword: "AI assistant" },
    credits: 7,
    unit: "request",
  },
  {
    capability: "creators.search",
    fixture: creators,
    input: { handle: "mrbeast" },
    credits: 50,
    unit: "request",
  },
  {
    capability: "web.history",
    fixture: history,
    input: { url: "https://example.com/" },
    credits: 7,
    unit: "request",
  },
  {
    capability: "affiliate.search",
    fixture: affiliate,
    input: { query: "walmart.com" },
    credits: 32,
    unit: "request",
  },
  {
    capability: "apps.profile",
    fixture: apps,
    input: { package: "com.whatsapp" },
    limit: 1,
    credits: 7,
    unit: "request",
  },
  {
    capability: "podcasts.search",
    fixture: podcasts,
    input: { query: "business productivity" },
    credits: 7,
    unit: "request",
  },
  {
    capability: "finance.company-profile",
    fixture: finance,
    input: { ticker: "MSFT", exchange: "NASDAQ" },
    limit: 1,
    credits: 38,
    unit: "request",
  },
]);

describe("Data Search free Firecrawl public contract quotes", () => {
  it.each(cases)(
    "quotes $capability against its reviewed public guide",
    async ({ capability, fixture, input, limit, credits, unit }) => {
      const setup = await scenario();
      await setup.run(async () => {
        let publicGuideGets = 0;
        server.use(
          http.get(fixture._review.sourceUrl, ({ request }) => {
            publicGuideGets += 1;
            expect(request.headers.get("authorization")).toBeNull();
            return HttpResponse.json(fixture);
          }),
        );
        const before = await accept(
          setup.data.list({
            headers: authenticate(setup.actor),
            query: {},
          }),
          [200],
        );
        expect(before.body).toStrictEqual({ jobs: [], nextCursor: null });

        const quote = await accept(
          setup.data.quote({
            headers: authenticate(setup.actor),
            body: {
              capability,
              input,
              // Search capabilities exercise the production request default of 10.
              ...(limit === undefined ? {} : { limit }),
            },
          }),
          [200],
        );
        expect(quote.body).toStrictEqual({
          capability,
          estimatedCredits: credits,
          maxCredits: credits,
          quantity: 1,
          unit,
        });
        const after = await accept(
          setup.data.list({
            headers: authenticate(setup.actor),
            query: {},
          }),
          [200],
        );
        expect(after.body).toStrictEqual(before.body);
        expect(publicGuideGets).toBeGreaterThan(0);
      });
    },
  );
});
