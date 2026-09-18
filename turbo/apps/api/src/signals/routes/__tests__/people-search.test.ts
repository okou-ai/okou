import { randomUUID } from "node:crypto";

import {
  peopleSearchContract,
  type PeopleSearchRequest,
} from "@okouai/api-contracts/contracts/people-search";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { webSearchContract } from "@okouai/api-contracts/contracts/web-search";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingKey,
  type UsagePricingRow,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../../lib/time";
import type { RouteEntry } from "../../route-entry";
import { billingStatusRoutes } from "../billing-status";
import { peopleSearchRoutes } from "../people-search";
import { webSearchRoutes } from "../web-search";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { usageRecordRoutes } from "../usage-record";

const context = testContext();
const PERPLEXITY_AGENT_URL = "https://api.perplexity.ai/v1/agent";
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;

const peopleSearchTestRoutes: readonly RouteEntry[] = [
  ...billingStatusRoutes,
  ...peopleSearchRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function authenticate(actor: ApiTestUser | null): AuthHeaders {
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
  return authHeaders(actor);
}

function client(usagePricingResolution?: UsagePricingFixture["resolution"]) {
  return setupAppWithRoutes({
    context,
    routes: peopleSearchTestRoutes,
    usagePricingResolution,
  });
}

function webSearchClient(
  usagePricingResolution?: UsagePricingFixture["resolution"],
) {
  return setupAppWithRoutes({
    context,
    routes: webSearchRoutes,
    usagePricingResolution,
  });
}

async function bootstrapOnboarding(actor: ApiTestUser): Promise<void> {
  const completed = await createBddApi(context).completeOnboarding(actor);
  expect(completed.status).toBe(200);
}

async function setActorCredits(
  actor: ApiTestUser,
  credits: number,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("People Search test actor must have an organization");
  }
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits });
}

async function fundActor(actor: ApiTestUser): Promise<void> {
  await bootstrapOnboarding(actor);
  await setActorCredits(actor, 1000);
}

function peopleSearchPricingKey(): UsagePricingKey {
  return {
    kind: "people-search",
    provider: "perplexity",
    category: "request",
  };
}

function peopleSearchPricing(): UsagePricingRow {
  return {
    ...peopleSearchPricingKey(),
    unitPrice: 20,
    unitSize: 1,
  };
}

function webSearchPricing(): UsagePricingRow {
  return {
    kind: "web-search",
    provider: "perplexity",
    category: "request",
    unitPrice: 5,
    unitSize: 1,
  };
}

async function createPricingFixture(
  configured: readonly UsagePricingRow[],
  missing: readonly UsagePricingKey[] = [],
): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({ configured, missing });
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

async function credits(actor: ApiTestUser): Promise<number> {
  const response = await accept(
    client()(billingStatusContract).get({
      headers: authenticate(actor),
    }),
    [200],
  );
  return response.body.credits;
}

function configureProvider(): void {
  mockEnv("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN", "test-people-search-token");
}

function defaultRequest(
  overrides: Partial<PeopleSearchRequest> = {},
): PeopleSearchRequest {
  return {
    query: "platform engineering leaders at Notion",
    limit: 5,
    ...overrides,
  };
}

function providerResult(
  overrides: Partial<{
    readonly id: number;
    readonly url: string;
    readonly title: string;
  }> = {},
) {
  return {
    id: 1,
    url: "https://example.com/profile",
    title: "Example professional profile",
    snippet: "Public professional context.",
    source: "web",
    ...overrides,
  };
}

function structuredProfile(
  overrides: Partial<{
    readonly name: string;
    readonly title: string | null;
    readonly company: string | null;
    readonly location: string | null;
    readonly summary: string | null;
    readonly sourceIds: readonly number[];
  }> = {},
) {
  return {
    name: "Jordan Lee",
    title: "VP of Platform",
    company: "Example",
    location: "San Francisco",
    summary: "Leads public platform engineering work.",
    sourceIds: [1],
    ...overrides,
  };
}

function providerResponse(args?: {
  readonly profiles?: readonly ReturnType<typeof structuredProfile>[];
  readonly results?: readonly ReturnType<typeof providerResult>[];
  readonly invocation?: number;
  readonly extraOutput?: readonly unknown[];
}) {
  return {
    id: "agent-response-id",
    status: "completed",
    output: [
      ...(args?.extraOutput ?? []),
      {
        type: "people_search_results",
        queries: ["platform engineering leaders at Notion"],
        results: args?.results ?? [providerResult()],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              profiles: args?.profiles ?? [structuredProfile()],
            }),
          },
        ],
      },
    ],
    usage: {
      tool_calls_details: {
        search_people: { invocation: args?.invocation ?? 1 },
      },
    },
  };
}

function webSearchProviderResponse() {
  return {
    id: "search-request-id",
    server_time: "2026-07-14T10:00:00Z",
    results: [
      {
        title: "AI regulation update",
        url: "https://example.com/update",
        snippet: "A relevant public-web excerpt.",
        date: "2026-07-13",
        last_updated: "2026-07-14",
      },
    ],
  };
}

async function successfulRequest(
  actor: ApiTestUser,
  pricing: UsagePricingFixture,
  body: PeopleSearchRequest = defaultRequest(),
) {
  return await accept(
    client(pricing.resolution)(peopleSearchContract).search({
      headers: authenticate(actor),
      body,
    }),
    [200],
  );
}

describe("okou people-search route", () => {
  it("rejects agent tokens without people-search capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("People Search test actor must have an organization");
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_missing_people_search_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(peopleSearchContract).search({
        headers: { authorization: `Bearer ${token}` },
        body: defaultRequest(),
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: people-search:read",
    );
  });

  it("sends one bounded tool request and returns provider-backed profiles", async () => {
    const actor = createBddApi(context).user();
    let requestBody: unknown;
    let authorization: string | null = null;
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, async ({ request }) => {
        requestBody = await request.json();
        authorization = request.headers.get("authorization");
        return HttpResponse.json(
          providerResponse({
            profiles: [
              structuredProfile({
                name: "Jordan\u001b Lee",
                summary: "Leads platform work.\nPublic data.",
                sourceIds: [1, 3],
              }),
              structuredProfile({
                name: "Jordan\u001b Lee",
                summary: "Alternate extraction from the same source.",
                sourceIds: [3, 1],
              }),
            ],
            results: [
              providerResult({
                title: "Example\u0007 leadership",
              }),
              providerResult({
                id: 2,
                url: "file:///unreferenced",
              }),
              providerResult({
                id: 3,
                title: "Duplicate provider result",
              }),
            ],
            extraOutput: [{ type: "future_provider_item", detail: "ignored" }],
          }),
        );
      }),
    );

    const response = await successfulRequest(
      actor,
      pricing,
      defaultRequest({ limit: 3 }),
    );
    const afterCredits = await credits(actor);

    expect(requestBody).toMatchObject({
      model: "openai/gpt-5-mini",
      reasoning: { effort: "low" },
      tools: [
        {
          type: "people_search",
        },
      ],
      max_steps: 2,
      max_output_tokens: 4000,
      store: false,
      input: "platform engineering leaders at Notion",
      instructions: expect.stringContaining(
        "do not return email addresses, phone numbers, home addresses, or other personal contact details",
      ),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "PeopleSearchProfiles",
          schema: {
            properties: {
              profiles: {
                maxItems: 20,
                items: {
                  properties: {
                    sourceIds: {
                      type: "array",
                      minItems: 1,
                      maxItems: 5,
                      items: { type: "integer", minimum: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(requestBody).toHaveProperty(
      "instructions",
      expect.stringContaining(
        "Use only distinct positive integer result IDs from people_search_results in sourceIds.",
      ),
    );
    expect(requestBody).not.toHaveProperty(
      "response_format.json_schema.schema.properties.profiles.items.properties.sourceIds.uniqueItems",
    );
    expect(authorization).toBe("Bearer test-people-search-token");
    expect(response.body).toStrictEqual({
      query: "platform engineering leaders at Notion",
      limit: 3,
      provider: "perplexity",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 20,
      profiles: [
        {
          name: "Jordan  Lee",
          title: "VP of Platform",
          company: "Example",
          location: "San Francisco",
          summary: "Leads platform work. Public data.",
          sources: [
            {
              title: "Example  leadership",
              url: "https://example.com/profile",
            },
          ],
        },
      ],
    });
    expect(beforeCredits - afterCredits).toBe(20);
  });

  it("accepts a CLI token", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await fundActor(actor);
    const { token } = await createRunsApi(context).createCliToken(actor);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: { authorization: `Bearer ${token}` },
        body: defaultRequest(),
      }),
      [200],
    );

    expect(response.body.profiles[0]?.name).toBe("Jordan Lee");
    expect(response.body.creditsCharged).toBe(20);
  });

  it("deduplicates by validated source identity before enforcing the response budget", async () => {
    const actor = createBddApi(context).user();
    const sourceIds = [1, 2, 3, 4, 5];
    const profiles = Array.from({ length: 7 }, (_, index) => {
      return structuredProfile({
        name: "n".repeat(256),
        title: index === 0 ? "t".repeat(512) : `alternate ${String(index)}`,
        company: "c".repeat(256),
        location: "l".repeat(256),
        summary: "s".repeat(1000),
        sourceIds,
      });
    });
    const results = sourceIds.map((id) => {
      return providerResult({
        id,
        title: "r".repeat(512),
        url: `https://example.com/${"u".repeat(900)}?id=${String(id)}`,
      });
    });
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await fundActor(actor);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        return HttpResponse.json(providerResponse({ profiles, results }));
      }),
    );

    const response = await successfulRequest(
      actor,
      pricing,
      defaultRequest({ limit: 7 }),
    );

    expect(response.body.profiles).toHaveLength(1);
    expect(response.body.profiles[0]?.title).toBe("t".repeat(512));
    expect(response.body.profiles[0]?.sources).toHaveLength(5);
  });

  it("returns twenty profiles at the supported maximum", async () => {
    const actor = createBddApi(context).user();
    const profiles = Array.from({ length: 20 }, (_, index) => {
      return structuredProfile({
        name: `Professional ${String(index + 1)}`,
        summary: `Public professional profile ${String(index + 1)}.`,
      });
    });
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await fundActor(actor);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        return HttpResponse.json(providerResponse({ profiles }));
      }),
    );

    const response = await successfulRequest(
      actor,
      pricing,
      defaultRequest({ limit: 20 }),
    );

    expect(response.body.profiles).toHaveLength(20);
    expect(response.body.profiles.at(0)?.name).toBe("Professional 1");
    expect(response.body.profiles.at(-1)?.name).toBe("Professional 20");
  });

  it("bills a valid search with no matching profiles", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        return HttpResponse.json(providerResponse({ profiles: [] }));
      }),
    );

    const response = await successfulRequest(actor, pricing);
    const afterCredits = await credits(actor);

    expect(response.body.profiles).toStrictEqual([]);
    expect(response.body.creditsCharged).toBe(20);
    expect(beforeCredits - afterCredits).toBe(20);
  });

  it("rejects invalid provider/model output without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await fundActor(actor);
    const valid = providerResponse();
    const invalidBodies: readonly JsonBodyType[] = [
      { ...valid, status: "incomplete" },
      { ...valid, output: valid.output.slice(1) },
      {
        ...valid,
        output: [...valid.output, valid.output[0]],
      },
      {
        ...valid,
        output: [
          valid.output[0],
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "not-json" }],
          },
        ],
      },
      providerResponse({
        profiles: [structuredProfile({ sourceIds: [999] })],
      }),
      providerResponse({
        profiles: [structuredProfile({ sourceIds: [1, 1] })],
      }),
      providerResponse({
        results: [providerResult(), providerResult()],
      }),
      providerResponse({
        results: [providerResult({ url: "javascript:alert(1)" })],
      }),
      providerResponse({
        results: [
          providerResult({ url: "https://user:secret@example.com/profile" }),
        ],
      }),
      providerResponse({ invocation: 2 }),
      providerResponse({
        profiles: [
          structuredProfile({ name: "One" }),
          structuredProfile({ name: "Two" }),
        ],
      }),
    ];

    for (const body of invalidBodies) {
      const beforeCredits = await credits(actor);
      server.use(
        http.post(PERPLEXITY_AGENT_URL, () => {
          return HttpResponse.json(body);
        }),
      );
      const response = await accept(
        client(pricing.resolution)(peopleSearchContract).search({
          headers: authenticate(actor),
          body: defaultRequest({ limit: 1 }),
        }),
        [502],
      );
      const afterCredits = await credits(actor);
      expectApiError(response.body);
      expect(response.body.error.code).toBe("PERPLEXITY_INVALID_RESPONSE");
      expect(afterCredits).toBe(beforeCredits);
    }
  });

  it("fails before provider work when configuration or pricing is absent", async () => {
    const actor = createBddApi(context).user();
    const pricing = await createPricingFixture([], [peopleSearchPricingKey()]);
    await fundActor(actor);
    let providerRequests = 0;
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );
    mockEnv("OKOU_WEB_SEARCH_PERPLEXITY_TOKEN", undefined);
    const noCredential = await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [503],
    );
    expectApiError(noCredential.body);
    expect(noCredential.body.error.code).toBe("NOT_CONFIGURED");

    configureProvider();
    const noPrice = await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [503],
    );
    expectApiError(noPrice.body);
    expect(noPrice.body.error.code).toBe("PRICING_NOT_CONFIGURED");
    expect(providerRequests).toBe(0);
  });

  it("rejects insufficient credits before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, 0);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("maps provider failures without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        return HttpResponse.json({ message: "slow down" }, { status: 429 });
      }),
    );
    const rateLimited = await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    expectApiError(rateLimited.body);
    expect(rateLimited.body.error.code).toBe("PERPLEXITY_RATE_LIMITED");

    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException("timed out", "TimeoutError"));
          },
        });
        return new HttpResponse(stream);
      }),
    );
    const timedOut = await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    expectApiError(timedOut.body);
    expect(timedOut.body.error.code).toBe("PEOPLE_SEARCH_TIMEOUT");

    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        return HttpResponse.text("{}", {
          headers: {
            "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
          },
        });
      }),
    );
    const oversized = await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);
    expectApiError(oversized.body);
    expect(oversized.body.error.code).toBe("PEOPLE_SEARCH_OUTPUT_TOO_LARGE");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("maps and bounds nested provider errors without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await createPricingFixture([peopleSearchPricing()]);
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: `\u001b]52;c;clipboard\u0007${"x".repeat(5000)}`,
            },
          },
          { status: 400 },
        );
      }),
    );

    const response = await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: authenticate(actor),
        body: defaultRequest(),
      }),
      [502],
    );
    const afterCredits = await credits(actor);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PERPLEXITY_ERROR");
    expect(response.body.error.message).toHaveLength(4096);
    expect(response.body.error.message.endsWith("...")).toBeTruthy();
    expect(response.body.error.message).not.toContain("\u001b");
    expect(response.body.error.message).not.toContain("\u0007");
    expect(afterCredits).toBe(beforeCredits);
  });

  it("preserves People Search and Web Search attribution for one run", async () => {
    const actor = createBddApi(context).user();
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    await fundActor(actor);
    const pricing = await createPricingFixture([
      peopleSearchPricing(),
      webSearchPricing(),
    ]);
    configureProvider();
    const compose = await api.createDirectAgent(actor, {
      version: "1.0",
      agents: {
        [`people-search-${randomUUID().slice(0, 8)}`]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });
    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "Find a public professional profile",
    });
    const token = api.okouTokenForRunWithCapabilities(actor, run.runId, [
      "people-search:read",
      "web-search:read",
    ]);
    server.use(
      http.post(PERPLEXITY_AGENT_URL, () => {
        return HttpResponse.json(providerResponse());
      }),
      http.post(PERPLEXITY_SEARCH_URL, () => {
        return HttpResponse.json(webSearchProviderResponse());
      }),
    );

    await accept(
      client(pricing.resolution)(peopleSearchContract).search({
        headers: { authorization: `Bearer ${token}` },
        body: defaultRequest(),
      }),
      [200],
    );
    await accept(
      webSearchClient(pricing.resolution)(webSearchContract).search({
        headers: { authorization: `Bearer ${token}` },
        body: { query: "latest AI regulation", limit: 5 },
      }),
      [200],
    );
    const usage = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        {
          headers: authenticate(actor),
          query: {
            page: 1,
            pageSize: 100,
            scope: "mine",
            range: "today",
            tz: "UTC",
          },
        },
      ),
      [200],
    );
    const usageRow = usage.body.rows.find((row) => {
      return row.threadId === null;
    });

    expect(usageRow).toMatchObject({
      title: "Unavailable thread",
      runId: null,
    });
    expect(usageRow?.breakdown).toContainEqual({
      kind: "other",
      credits: 25,
      providers: [
        {
          provider: "perplexity",
          credits: 25,
          usageKinds: [
            {
              kind: "people-search",
              credits: 20,
            },
            {
              kind: "web-search",
              credits: 5,
            },
          ],
        },
      ],
    });
  });
});
