import { randomUUID } from "node:crypto";
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
import { flushWaitUntilForTest } from "../../context/wait-until";
import { dataSearchRoutes } from "../data-search";
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
  mockEnv("OKOU_SOCIAL_MONID_API_KEY", "data-provider-test-key");
  return { actor, run: billing.run, data: app(dataSearchContract) };
}
const profileProperties = Object.freeze({
  id: { type: "string" },
  linkedin_url: { type: "string" },
  name: { type: "string" },
  domain: { type: "string" },
  reveal_personal_emails: { type: "boolean" },
  reveal_phone_number: { type: "boolean" },
});
const hunterProperties = Object.freeze({
  domain: { type: "string" },
  full_name: { type: "string" },
  first_name: { type: "string" },
  last_name: { type: "string" },
  max_duration: { type: "integer", minimum: 3, maximum: 20 },
});
function monid(options: {
  provider: string;
  endpoint: string;
  properties: Record<string, unknown>;
  output: unknown;
  usd: number;
  expectedInput?: unknown;
  tiered?: boolean;
}) {
  server.use(
    http.post("https://api.monid.ai/v1/inspect", async ({ request }) => {
      await expect(request.json()).resolves.toStrictEqual({
        provider: options.provider,
        endpoint: options.endpoint,
      });
      const base = {
        type: options.provider === "hunterio" ? "PER_RESULT" : "PER_CALL",
        amount: { value: options.usd, currency: "USD" },
      };
      return HttpResponse.json({
        provider: options.provider,
        endpoint: options.endpoint,
        input: {
          queryParams: {
            type: "object",
            properties: options.properties,
            additionalProperties: false,
          },
        },
        price: options.tiered
          ? {
              ...base,
              type: "TIERED",
              default: base,
              tiers: [
                {
                  label: "Private email",
                  when: { reveal_personal_emails: "true" },
                  price: {
                    type: "PER_CALL",
                    amount: { value: 0.026, currency: "USD" },
                  },
                },
              ],
            }
          : base,
      });
    }),
    http.post("https://api.monid.ai/v1/run", async ({ request }) => {
      const body: unknown = await request.json();
      if (options.expectedInput) {
        expect(body).toStrictEqual({
          provider: options.provider,
          endpoint: options.endpoint,
          input: options.expectedInput,
        });
      }
      return HttpResponse.json({
        runId: `data_${randomUUID()}`,
        provider: options.provider,
        endpoint: options.endpoint,
        status: "COMPLETED",
        providerResponse: { httpStatus: 200 },
        output: options.output,
        billing: {
          actualCost: {
            value: Math.round(options.usd * 1_000_000),
            currency: "USD",
            unit: "MICRO_DOLLAR",
          },
        },
      });
    }),
  );
}
async function execute(
  setup: Awaited<ReturnType<typeof scenario>>,
  request: DataSearchRequest,
) {
  const created = await accept(
    setup.data.create({
      headers: authenticate(setup.actor),
      body: { ...request, requestId: randomUUID(), maxCredits: 100 },
    }),
    [202],
  );
  await flushWaitUntilForTest();
  return accept(
    setup.data.get({
      headers: authenticate(setup.actor),
      params: { jobId: created.body.jobId },
    }),
    [200],
  );
}

describe("Data Search reviewed providers", () => {
  it("returns the professional profile projection with source identity", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid({
        provider: "apollo",
        endpoint: "/people/match",
        properties: profileProperties,
        tiered: true,
        usd: 0.026,
        expectedInput: {
          queryParams: {
            id: "apollo_professional_123",
            reveal_personal_emails: false,
            reveal_phone_number: false,
          },
        },
        output: {
          person: {
            id: "apollo_professional_123",
            first_name: "Alex",
            last_name: "Jones",
            title: "Marketing Director",
            email: "alex@business.test",
            personal_emails: ["private@consumer.test"],
            phone_numbers: ["+19990000001"],
            organization: {
              id: "org1",
              name: "Business",
              primary_domain: "business.test",
              phone: "+19990000002",
            },
            employment_history: [
              {
                title: "Director",
                organization_name: "Business",
                email: "private-nested@consumer.test",
                phone: "+19990000003",
              },
            ],
          },
        },
      });
      const result = await execute(setup, {
        capability: "people.enrich",
        input: { id: "apollo_professional_123" },
        limit: 1,
      });
      expect(result.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: "apollo_professional_123",
              title: "Marketing Director",
              preview: false,
              source: { provider: "apollo", capability: "people.enrich" },
              organization: { name: "Business" },
              employment_history: [
                { title: "Director", organization_name: "Business" },
              ],
            },
          ],
        },
        billing: { state: "settled" },
      });
      expect(result.body.data).toStrictEqual({
        items: [
          {
            id: "apollo_professional_123",
            first_name: "Alex",
            last_name: "Jones",
            title: "Marketing Director",
            preview: false,
            source: { provider: "apollo", capability: "people.enrich" },
            organization: {
              id: "org1",
              name: "Business",
              primary_domain: "business.test",
            },
            employment_history: [
              { title: "Director", organization_name: "Business" },
            ],
          },
        ],
      });
    });
  });

  it("finds one explicitly requested Hunter work email with confidence and source URLs", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid({
        provider: "hunterio",
        endpoint: "/email-finder",
        properties: hunterProperties,
        usd: 0.0245,
        expectedInput: {
          queryParams: {
            domain: "business.test",
            first_name: "Alex",
            last_name: "Jones",
            max_duration: 10,
          },
        },
        output: {
          data: {
            email: "alex@business.test",
            score: 97,
            first_name: "Alex",
            last_name: "Jones",
            position: "Marketing Director",
            phone_number: "+19990000001",
            verification: { status: "valid", date: "2026-10-22" },
            sources: [
              {
                domain: "business.test",
                uri: "https://business.test/team",
                extracted_on: "2026-09-01",
                last_seen_on: "2026-10-20",
                still_on_page: true,
              },
            ],
          },
          meta: { params: { domain: "business.test" } },
        },
      });
      const result = await execute(setup, {
        capability: "people.enrich",
        input: {
          fields: ["work-email"],
          domain: "business.test",
          firstName: "Alex",
          lastName: "Jones",
        },
        limit: 1,
      });
      expect(result.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              email: "alex@business.test",
              score: 97,
              domain: "business.test",
              sources: [
                { uri: "https://business.test/team", still_on_page: true },
              ],
              verification: { status: "valid" },
              source: { provider: "hunterio", capability: "people.enrich" },
            },
          ],
        },
        billing: { state: "settled" },
      });
      expect(result.body.data).toStrictEqual({
        items: [
          {
            email: "alex@business.test",
            score: 97,
            first_name: "Alex",
            last_name: "Jones",
            position: "Marketing Director",
            domain: "business.test",
            verification: { status: "valid", date: "2026-10-22" },
            sources: [
              {
                domain: "business.test",
                uri: "https://business.test/team",
                extracted_on: "2026-09-01",
                last_seen_on: "2026-10-20",
                still_on_page: true,
              },
            ],
            source: { provider: "hunterio", capability: "people.enrich" },
          },
        ],
      });
    });
  });

  it("retains the confirmed source charge when a valid Apollo result is empty", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid({
        provider: "apollo",
        endpoint: "/people/match",
        properties: profileProperties,
        usd: 0.026,
        tiered: true,
        output: { person: null },
      });
      const result = await execute(setup, {
        capability: "people.enrich",
        input: { name: "Alex Jones", domain: "business.test" },
        limit: 1,
      });
      expect(result.body).toMatchObject({
        status: "completed",
        data: { items: [] },
        billing: { state: "settled", creditsCharged: 33 },
      });
    });
  });

  it("resolves a company by its reviewed domain-only enrichment contract", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid({
        provider: "apollo",
        endpoint: "/organizations/enrich",
        properties: { domain: { type: "string" } },
        usd: 0.026,
        expectedInput: { queryParams: { domain: "business.test" } },
        output: {
          organization: {
            id: "company_123",
            name: "Business",
            primary_domain: "business.test",
            industry: "Software",
            estimated_num_employees: 42,
            phone: "+19990000001",
          },
        },
      });
      const result = await execute(setup, {
        capability: "company.inspect",
        input: { domain: "business.test" },
        limit: 1,
      });
      expect(result.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: "company_123",
              name: "Business",
              industry: "Software",
              estimated_num_employees: 42,
              source: { provider: "apollo", capability: "company.inspect" },
            },
          ],
        },
        billing: { state: "settled", creditsCharged: 33 },
      });
    });
  });

  it.each([
    {
      name: "the live envelope without per-item success",
      outcome: {},
      status: "completed",
    },
    {
      name: "an explicit per-item success",
      outcome: { success: true },
      status: "completed",
    },
  ])("settles Firecrawl $name", async ({ outcome }) => {
    const setup = await scenario();
    await setup.run(async () => {
      mockEnv("OKOU_SCRAPE_FIRECRAWL_TOKEN", "data-firecrawl-test-key");
      mockEnv("OKOU_DATA_FIRECRAWL_USD_MICROS_PER_CREDIT", 1000);
      server.use(
        http.get(
          "https://www.firecrawl.dev/alexandria/agents/providers/play-google-com/openapi.json",
          () => {
            return HttpResponse.json({
              "x-firecrawl-capabilities": [
                {
                  key: "media/app",
                  credits_per_unit: 5,
                  billing: { maxCredits: 5 },
                },
              ],
              paths: {
                "/v2/scrape": {
                  post: {
                    requestBody: {
                      content: {
                        "application/json": {
                          schema: {
                            properties: {
                              alexandria: {
                                oneOf: [
                                  {
                                    properties: {
                                      capability: { const: "media/app" },
                                      options: {
                                        type: "object",
                                        properties: {
                                          package: { type: "string" },
                                          country: { type: "string" },
                                          language: { type: "string" },
                                        },
                                        required: ["package"],
                                        additionalProperties: false,
                                      },
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            });
          },
        ),
        http.post(
          "https://api.firecrawl.dev/v2/scrape",
          async ({ request }) => {
            expect(request.headers.get("x-request-id")).toMatch(
              /^[0-9a-f-]{36}$/,
            );
            await expect(request.json()).resolves.toStrictEqual({
              alexandria: {
                provider: "play-google-com",
                capability: "media/app",
                options: {
                  package: "com.business.example",
                  country: "US",
                  language: "en_US",
                },
              },
            });
            return HttpResponse.json({
              success: true,
              data: {
                alexandria: [
                  {
                    ...outcome,
                    provider: "play-google-com",
                    capability: "media/app",
                    creditsCost: 5,
                    data: {
                      package: "com.business.example",
                      title: "Business Example",
                      installs_min: 1000,
                      rating: { average: 4.5, count: 25 },
                      internal_trace: "not-a-public-field",
                    },
                  },
                ],
              },
            });
          },
        ),
      );
      const result = await execute(setup, {
        capability: "apps.profile",
        input: { package: "com.business.example" },
        limit: 1,
      });
      expect(result.body).toMatchObject({
        status: "completed",
        billing: { state: "settled", creditsCharged: 7, reservedCredits: 0 },
      });
      expect(result.body.data).toStrictEqual({
        items: [
          {
            package: "com.business.example",
            title: "Business Example",
            installs_min: 1000,
            rating: { average: 4.5, count: 25 },
            source: { provider: "play-google-com", capability: "apps.profile" },
          },
        ],
      });
    });
  });
});
