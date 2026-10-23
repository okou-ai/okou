import { randomUUID } from "node:crypto";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
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
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingStatusRoutes } from "../billing-status";
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
  const app = await setupApp({
    context,
    routes: [...dataSearchRoutes, ...billingStatusRoutes],
  });
  const actor = createBddApi(context).user({
    orgId: createUniqueStaffOrgIdFixture(),
  });
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
  return {
    actor,
    run: billing.run,
    data: app(dataSearchContract),
    billing: app(billingStatusContract),
  };
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
  sourceStatus?: number;
  inspectUsd?: number;
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
        amount: { value: options.inspectUsd ?? options.usd, currency: "USD" },
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
        providerResponse: { httpStatus: options.sourceStatus ?? 200 },
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
  it("returns a profile with source identity while excluding contact data and nested employment contacts by default", async () => {
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
      const serialized = JSON.stringify(result.body.data);
      expect(serialized).not.toContain("alex@business.test");
      expect(serialized).not.toContain("consumer.test");
      expect(serialized).not.toContain("+1999000000");
    });
  });

  it("finds one explicitly requested Hunter work email with confidence and source URLs, not a domain-wide contact list", async () => {
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
      expect(JSON.stringify(result.body.data)).not.toContain("+19990000001");
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

  it("rejects unreviewed paid modifiers and private-email-only identifiers before obtaining a provider quote", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      const inputs: DataSearchRequest["input"][] = [
        { email: "private@consumer.test" },
        { id: "professional_123", reveal_phone_number: true },
        { fields: ["work-email"], domain: "business.test" },
      ];
      for (const input of inputs) {
        const response = await accept(
          setup.data.quote({
            headers: authenticate(setup.actor),
            body: { capability: "people.enrich", input, limit: 1 },
          }),
          [422],
        );
        expect(response.body.error.code).toBe("DATA_SEARCH_INVALID_INPUT");
      }
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

  it("searches Apollo organizations through the public company search route", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid({
        provider: "apollo",
        endpoint: "/mixed_companies/search",
        properties: {
          q_organization_name: { type: "string" },
          page: { type: "integer" },
          per_page: { type: "integer" },
        },
        usd: 0.026,
        expectedInput: {
          queryParams: {
            q_organization_name: "Business",
            page: 1,
            per_page: 2,
          },
        },
        output: {
          organizations: [
            {
              id: "company_search_123",
              name: "Business",
              primary_domain: "business.test",
              industry: "Software",
              estimated_num_employees: 42,
              phone: "+19990000001",
              internal_trace: "not-a-public-company-field",
            },
          ],
          pagination: { page: 1, per_page: 2, total_entries: 1 },
        },
      });
      const result = await execute(setup, {
        capability: "company.search",
        input: { name: "Business" },
        limit: 2,
      });
      expect(result.body).toMatchObject({
        status: "completed",
        data: {
          items: [
            {
              id: "company_search_123",
              name: "Business",
              primary_domain: "business.test",
              industry: "Software",
              estimated_num_employees: 42,
              source: { provider: "apollo", capability: "company.search" },
            },
          ],
        },
        billing: { state: "settled", creditsCharged: 33, reservedCredits: 0 },
      });
      expect(result.body.data?.items).toHaveLength(1);
      expect(JSON.stringify(result.body.data)).not.toContain("+19990000001");
      expect(JSON.stringify(result.body.data)).not.toContain(
        "not-a-public-company-field",
      );
    });
  });

  it("retains a valid source receipt without exposing the raw provider failure payload", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid({
        provider: "apollo",
        endpoint: "/people/match",
        properties: profileProperties,
        tiered: true,
        usd: 0.026,
        sourceStatus: 403,
        output: { error: "private-provider-trace-and-credential-material" },
      });
      const result = await execute(setup, {
        capability: "people.enrich",
        input: { id: "professional_123" },
        limit: 1,
      });
      expect(result.body).toMatchObject({
        status: "failed",
        data: null,
        billing: { state: "settled", creditsCharged: 33 },
        error: {
          code: "DATA_SEARCH_SOURCE_FAILED",
          message: "The data source could not complete this operation.",
        },
      });
      expect(JSON.stringify(result.body)).not.toContain(
        "private-provider-trace-and-credential-material",
      );
    });
  });

  it("fails closed when the live inspected source price changes", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      monid({
        provider: "apollo",
        endpoint: "/people/match",
        properties: profileProperties,
        usd: 0.026,
        inspectUsd: 0.03,
        tiered: true,
        output: { person: null },
      });
      const result = await accept(
        setup.data.quote({
          headers: authenticate(setup.actor),
          body: {
            capability: "people.enrich",
            input: { id: "professional_123" },
            limit: 1,
          },
        }),
        [422],
      );
      expect(result.body.error.code).toBe("DATA_SEARCH_CONTRACT_CHANGED");
    });
  });

  it("fails closed before a Firecrawl paid call when its USD source conversion rate is missing", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      mockEnv("OKOU_SCRAPE_FIRECRAWL_TOKEN", "data-firecrawl-test-key");
      mockEnv("OKOU_DATA_FIRECRAWL_USD_MICROS_PER_CREDIT", undefined);
      const result = await accept(
        setup.data.quote({
          headers: authenticate(setup.actor),
          body: {
            capability: "apps.profile",
            input: { package: "com.business.example" },
            limit: 1,
          },
        }),
        [503],
      );
      expect(result.body.error.code).toBe("DATA_SEARCH_PRICING_UNAVAILABLE");
    });
  });

  it("keeps an unparseable paid synchronous Firecrawl response unknown without replaying or refunding on recovery, reads or cancellation", async () => {
    const setup = await scenario();
    await setup.run(async () => {
      mockEnv("OKOU_SCRAPE_FIRECRAWL_TOKEN", "data-firecrawl-test-key");
      mockEnv("OKOU_DATA_FIRECRAWL_USD_MICROS_PER_CREDIT", 1000);
      const requestId = randomUUID();
      let paidScrapes = 0;
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
            paidScrapes++;
            expect(request.headers.get("x-request-id")).toBe(requestId);
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
            // The paid POST returns, but neither a receipt nor a recoverable ID
            // can be established from its response. It must never be retried.
            return new HttpResponse("{truncated-paid-response", {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        ),
      );
      const before = await accept(
        setup.billing.get({ headers: authenticate(setup.actor) }),
        [200],
      );
      expect(before.body.credits).toBeGreaterThanOrEqual(100);
      const body = {
        capability: "apps.profile",
        input: { package: "com.business.example" },
        limit: 1,
        requestId,
        maxCredits: 100,
      } as const;
      const created = await accept(
        setup.data.create({ headers: authenticate(setup.actor), body }),
        [202],
      );
      await flushWaitUntilForTest();
      const held = {
        jobId: created.body.jobId,
        requestId,
        status: "unknown",
        data: null,
        billing: {
          state: "pending",
          creditsCharged: 0,
          reservedCredits: 100,
          maxCredits: 100,
        },
        error: { code: "DATA_SEARCH_START_UNKNOWN" },
      };
      async function expectHeld() {
        const saved = await accept(
          setup.data.get({
            headers: authenticate(setup.actor),
            params: { jobId: created.body.jobId },
          }),
          [200],
        );
        expect(saved.body).toMatchObject(held);
        await flushWaitUntilForTest();
        const wallet = await accept(
          setup.billing.get({ headers: authenticate(setup.actor) }),
          [200],
        );
        // Pending zero charged is not a settled zero-cost receipt or refund.
        expect(wallet.body.credits).toBe(before.body.credits);
        expect(paidScrapes).toBe(1);
      }
      await expectHeld();
      const recovered = await accept(
        setup.data.create({ headers: authenticate(setup.actor), body }),
        [202],
      );
      expect(recovered.body).toMatchObject(held);
      await flushWaitUntilForTest();
      await expectHeld();
      const cancelled = await accept(
        setup.data.cancel({
          headers: authenticate(setup.actor),
          params: { jobId: created.body.jobId },
          body: {},
        }),
        [200],
      );
      expect(cancelled.body).toMatchObject(held);
      await flushWaitUntilForTest();
      await expectHeld();
    });
  });

  it.each([
    {
      name: "the live envelope without per-item success",
      outcome: {},
      status: "completed",
      clearConfiguredRate: false,
    },
    {
      name: "an explicit per-item success",
      outcome: { success: true },
      status: "completed",
      clearConfiguredRate: false,
    },
    {
      name: "an explicit per-item failure",
      outcome: { success: false },
      status: "failed",
      clearConfiguredRate: false,
    },
    {
      name: "a per-item error without a success flag",
      outcome: {
        error: { message: "The provider could not complete the operation." },
      },
      status: "failed",
      clearConfiguredRate: false,
    },
    {
      name: "the frozen quoted rate after configured rate disappears",
      outcome: {},
      status: "completed",
      clearConfiguredRate: true,
    },
  ])(
    "settles Firecrawl $name",
    async ({ outcome, status, clearConfiguredRate }) => {
      const setup = await scenario();
      await setup.run(async () => {
        mockEnv("OKOU_SCRAPE_FIRECRAWL_TOKEN", "data-firecrawl-test-key");
        mockEnv("OKOU_DATA_FIRECRAWL_USD_MICROS_PER_CREDIT", 1000);
        let schemaReads = 0;
        server.use(
          http.get(
            "https://www.firecrawl.dev/alexandria/agents/providers/play-google-com/openapi.json",
            () => {
              schemaReads++;
              if (clearConfiguredRate && schemaReads === 2) {
                mockEnv("OKOU_DATA_FIRECRAWL_USD_MICROS_PER_CREDIT", undefined);
              }
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
          status,
          data:
            status === "completed"
              ? {
                  items: [
                    {
                      package: "com.business.example",
                      title: "Business Example",
                      installs_min: 1000,
                      source: { provider: "play-google-com" },
                    },
                  ],
                }
              : null,
          ...(status === "failed"
            ? { error: { code: "DATA_SEARCH_SOURCE_FAILED" } }
            : {}),
          billing: {
            state: "settled",
            creditsCharged: 7,
            reservedCredits: 0,
          },
        });
        expect(JSON.stringify(result.body.data)).not.toContain(
          "not-a-public-field",
        );
      });
    },
  );
});
