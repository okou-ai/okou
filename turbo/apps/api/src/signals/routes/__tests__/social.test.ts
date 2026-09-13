import { randomUUID } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  findManagedSocialKitTool,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIALKIT_TOOLS,
  SOCIALKIT_TRANSCRIPT_ERROR_CODES,
  socialContract,
  socialKitRequestSchema,
  type SocialKitRequest,
} from "@okouai/api-contracts/contracts/social";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
  type UsagePricingKey,
} from "../../../test-fixtures/system-config-seeds";
import { mockEnv } from "../../../lib/env";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { RouteEntry } from "../../route-entry";
import { createDeferredPromise } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { socialRoutes } from "../social";
import { usageRecordRoutes } from "../usage-record";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { reconcileSocialKitDownloadsForTest } from "./helpers/runtime-state";

const context = testContext();
const SOCIALKIT_BASE = "https://api.socialkit.dev";
const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_CATEGORY = MANAGED_SOCIALKIT_BILLING_CATEGORY;
const SOCIALKIT_REQUEST_CREDITS = 3;
const DEFAULT_SOCIAL_REQUEST = {
  tool: "youtube_transcript",
  input: { url: "https://youtu.be/video123" },
} as const;

const EXPECTED_SOCIALKIT_TOOLS = [
  ["linkedin_profile", "/linkedin/profile"],
  ["linkedin_company", "/linkedin/company"],
  ["linkedin_company_posts", "/linkedin/company-posts"],
  ["linkedin_post", "/linkedin/post"],
  ["linkedin_transcript", "/linkedin/transcript"],
  ["twitter_profile", "/twitter/profile"],
  ["twitter_tweets", "/twitter/tweets"],
  ["twitter_tweet", "/twitter/tweet"],
  ["twitter_thread", "/twitter/thread"],
  ["twitter_transcript", "/twitter/transcript"],
  ["facebook_stats", "/facebook/stats"],
  ["facebook_channel_stats", "/facebook/channel-stats"],
  ["facebook_transcript", "/facebook/transcript"],
  ["facebook_comments", "/facebook/comments"],
  ["facebook_summarize", "/facebook/summarize"],
  ["instagram_stats", "/instagram/stats"],
  ["instagram_channel_stats", "/instagram/channel-stats"],
  ["instagram_transcript", "/instagram/transcript"],
  ["instagram_comments", "/instagram/comments"],
  ["instagram_channel_posts", "/instagram/channel-posts"],
  ["instagram_channel_reels", "/instagram/channel-reels"],
  ["instagram_reels_search", "/instagram/reels-search"],
  ["instagram_summarize", "/instagram/summarize"],
  ["tiktok_stats", "/tiktok/stats"],
  ["tiktok_comments", "/tiktok/comments"],
  ["tiktok_transcript", "/tiktok/transcript"],
  ["tiktok_channel_stats", "/tiktok/channel-stats"],
  ["tiktok_channel_videos", "/tiktok/channel-videos"],
  ["tiktok_search", "/tiktok/search"],
  ["tiktok_hashtag_search", "/tiktok/hashtag-search"],
  ["tiktok_summarize", "/tiktok/summarize"],
  ["youtube_transcript", "/youtube/transcript"],
  ["youtube_stats", "/youtube/stats"],
  ["youtube_comments", "/youtube/comments"],
  ["youtube_channel_stats", "/youtube/channel-stats"],
  ["youtube_search", "/youtube/search"],
  ["youtube_videos", "/youtube/videos"],
  ["youtube_summarize", "/youtube/summarize"],
] as const;

const socialTestRoutes: readonly RouteEntry[] = [
  ...billingStatusRoutes,
  ...socialRoutes,
];

interface AuthHeaders {
  readonly authorization?: string;
}

interface RawRequestOptions {
  readonly authorization?: string;
  readonly requestSignal?: AbortSignal;
  readonly usagePricingResolution?: UsagePricingFixture["resolution"];
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
    routes: socialTestRoutes,
    usagePricingResolution,
  });
}

async function rawSocialRequest(
  actor: ApiTestUser | null,
  body: unknown,
  options: RawRequestOptions = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: socialTestRoutes,
    usagePricingResolution: options.usagePricingResolution,
  });
  const authorization = options.authorization;
  const request = new Request("http://api.test/api/social/request", {
    method: "POST",
    headers: {
      ...(authorization ? { authorization } : authenticate(actor)),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...(options.requestSignal ? { signal: options.requestSignal } : {}),
  });
  return await app.request(request);
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
    throw new Error("Social test actor must belong to an organization");
  }
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits });
}

async function fundActor(actor: ApiTestUser): Promise<void> {
  await bootstrapOnboarding(actor);
  await setActorCredits(actor, 10_000);
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
  mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", "test-socialkit-key");
}

function socialPricingKey(): UsagePricingKey {
  return {
    kind: "social",
    provider: "socialkit",
    category: DEFAULT_CATEGORY,
  };
}

async function setupConfiguredPricing(): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({
    configured: [
      {
        ...socialPricingKey(),
        unitPrice: SOCIALKIT_REQUEST_CREDITS,
        unitSize: 1,
      },
    ],
  });
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

async function setupMissingPricing(): Promise<UsagePricingFixture> {
  const fixture = await createUsagePricingFixture({
    missing: [socialPricingKey()],
  });
  onTestFinished(async () => {
    await fixture.cleanup();
  });
  return fixture;
}

function providerResponse(data: unknown = { value: "provider result" }) {
  return { success: true, data };
}

function providerItems(count: number): { readonly marker: number }[] {
  return Array.from({ length: count }, (_, marker) => {
    return { marker };
  });
}

function validProviderData(path: string): Record<string, unknown> {
  const tool = MANAGED_SOCIALKIT_TOOLS.find((candidate) => {
    return candidate.path === path;
  });
  const collection = tool?.collection;
  if (!collection) {
    return { path };
  }
  const result: Record<string, unknown> = {
    [collection.resultField]: [],
  };
  return collection.pagination.kind === "cursor" ||
    collection.pagination.kind === "page"
    ? { ...result, hasMore: false }
    : result;
}

function toolForPath(path: string) {
  const tool = MANAGED_SOCIALKIT_TOOLS.find((candidate) => {
    return candidate.path === path;
  });
  if (!tool) {
    throw new Error(`No managed SocialKit tool for ${path}`);
  }
  return tool;
}

function requestForPath(
  path: string,
  input: Readonly<Record<string, unknown>>,
): SocialKitRequest {
  const tool = toolForPath(path);
  const normalizedInput = Object.fromEntries(
    Object.entries(input).map(([name, value]) => {
      if (
        typeof value === "string" &&
        (name === "limit" || name === "page" || name === "cache_ttl")
      ) {
        return [name, Number(value)];
      }
      if (
        typeof value === "string" &&
        (name === "cache" || name === "full_details")
      ) {
        return [name, value === "true"];
      }
      return [name, value];
    }),
  );
  return socialKitRequestSchema.parse({
    tool: tool.name,
    input: normalizedInput,
  });
}

function providerHandler(
  method: "GET" | "POST",
  path: string,
  response: () => Response = () => {
    return HttpResponse.json(providerResponse());
  },
) {
  const url = `${SOCIALKIT_BASE}${path}`;
  return method === "GET" ? http.get(url, response) : http.post(url, response);
}

describe("managed SocialKit route", () => {
  it("pins the reviewed 38-tool inventory and typed inputs", () => {
    expect(
      MANAGED_SOCIALKIT_TOOLS.map((tool) => {
        return [tool.name, tool.path];
      }),
    ).toStrictEqual(EXPECTED_SOCIALKIT_TOOLS);
    expect(MANAGED_SOCIALKIT_BILLING_CATEGORY).toBe("request");
    expect(MANAGED_SOCIALKIT_TOOLS).toHaveLength(38);
    expect(
      socialKitRequestSchema.safeParse({
        tool: "youtube_search",
        input: { query: "typed tools", limit: 10, cache: false },
      }).success,
    ).toBeTruthy();
    expect(
      socialKitRequestSchema.safeParse({
        tool: "youtube_search",
        input: { query: "typed tools", limit: "10" },
      }).success,
    ).toBeFalsy();
    expect(findManagedSocialKitTool("youtube_download")).toBeUndefined();
  });

  it("rejects agent tokens without social:read capability", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Social test actor must belong to an organization");
    }
    await bootstrapOnboarding(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: "run_social_missing_capability",
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      client()(socialContract).request({
        headers: { authorization: `Bearer ${token}` },
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: social:read",
    );
  });

  it("accepts valid requests without a feature override", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [200],
    );

    expect(response.body.provider).toBe("socialkit");
    expect(providerRequests).toBe(1);
  });

  it("applies reviewed TikTok limits while preserving raw session results", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const observed: { readonly path: string; readonly limit: string | null }[] =
      [];
    server.use(
      http.get(/^https:\/\/api\.socialkit\.dev\/tiktok\//u, ({ request }) => {
        const url = new URL(request.url);
        observed.push({
          path: url.pathname,
          limit: url.searchParams.get("limit"),
        });
        const resultCount =
          url.pathname === "/tiktok/search"
            ? 16
            : url.pathname === "/tiktok/hashtag-search"
              ? 30
              : 24;
        const data = {
          results: Array.from({ length: resultCount }, (_, index) => {
            return url.pathname === "/tiktok/channel-videos"
              ? {
                  videoId: `channel-video-${index}`,
                  description: "Channel result",
                  views: 30,
                }
              : {
                  id: `${url.pathname}-video-${index}`,
                  desc: "Raw nested result",
                  stats: { views: 10 },
                };
          }),
          hasMore: false,
          cursor: null,
        };
        return HttpResponse.json(providerResponse(data));
      }),
    );

    const search = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: {
          tool: "tiktok_search",
          input: { query: "launch", limit: 100 },
        },
      }),
      [200],
    );
    const hashtag = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: {
          tool: "tiktok_hashtag_search",
          input: { hashtag: "launch" },
        },
      }),
      [200],
    );
    const channel = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: {
          tool: "tiktok_channel_videos",
          input: { url: "https://www.tiktok.com/@example", limit: 100 },
        },
      }),
      [200],
    );

    expect(observed).toStrictEqual([
      { path: "/tiktok/search", limit: "10" },
      { path: "/tiktok/hashtag-search", limit: "20" },
      { path: "/tiktok/channel-videos", limit: "30" },
    ]);
    expect(search.body).toMatchObject({
      provider: "socialkit",
      collection: { state: "complete", itemsReturned: 16 },
    });
    const searchResults = search.body.result.results;
    expect(Array.isArray(searchResults)).toBeTruthy();
    if (!Array.isArray(searchResults)) {
      throw new TypeError("Expected TikTok search results to be an array");
    }
    expect(searchResults).toHaveLength(16);
    expect(searchResults[0]).toMatchObject({
      id: "/tiktok/search-video-0",
      desc: "Raw nested result",
    });
    expect(searchResults[0]).not.toHaveProperty("videoId");
    expect(hashtag.body.provider).toBe("socialkit");
    expect(channel.body.provider).toBe("socialkit");
    expect(beforeCredits - (await credits(actor))).toBe(
      3 * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("preflights and settles against the effective TikTok request limit", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS);
    let observedLimit: string | null = null;
    server.use(
      http.get(`${SOCIALKIT_BASE}/tiktok/search`, ({ request }) => {
        observedLimit = new URL(request.url).searchParams.get("limit");
        return HttpResponse.json(
          providerResponse({
            results: Array.from({ length: 60 }, (_, index) => {
              return { id: `video-${index}`, desc: "Result" };
            }),
            hasMore: false,
            cursor: null,
          }),
        );
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: {
          tool: "tiktok_search",
          input: { query: "launch", limit: 100 },
        },
      }),
      [200],
    );

    expect(observedLimit).toBe("10");
    expect(response.body.collection).toMatchObject({
      state: "complete",
      itemsReturned: 60,
    });
    expect(response.body.billingQuantity).toBe(1);
    await expect(credits(actor)).resolves.toBe(0);
  });

  it("projects TikTok agent results and exposes unreliable empty uncertainty without retry", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Social test actor must belong to an organization");
    }
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: randomUUID(),
      capabilities: ["social:read"],
      iat: seconds,
      exp: seconds + 60,
    });
    let providerRequests = 0;
    server.use(
      http.get(`${SOCIALKIT_BASE}/tiktok/search`, ({ request }) => {
        providerRequests += 1;
        const query = new URL(request.url).searchParams.get("query");
        return HttpResponse.json(
          providerResponse(
            query === "empty"
              ? { results: [], hasMore: false, cursor: null }
              : {
                  results: [
                    {
                      id: "video-1",
                      desc: "Canonical result",
                      url: "https://www.tiktok.com/@example/video/1",
                      author: {
                        uniqueId: "example",
                        nickname: "Example",
                      },
                      stats: {
                        views: 100,
                        likes: 20,
                        comments: 3,
                        shares: 4,
                        saves: 5,
                      },
                      video: {
                        cover: "https://example.com/cover.jpg",
                        duration: 12,
                      },
                      providerName: "SocialKit",
                    },
                  ],
                  hasMore: false,
                  cursor: null,
                },
          ),
        );
      }),
    );

    const canonicalResponse = await rawSocialRequest(
      null,
      { tool: "tiktok_search", input: { query: "launch", limit: 100 } },
      {
        authorization: `Bearer ${token}`,
        usagePricingResolution: pricing.resolution,
      },
    );
    expect(canonicalResponse.status).toBe(200);
    const canonicalBody = (await canonicalResponse.json()) as Record<
      string,
      unknown
    >;
    expect(canonicalBody).not.toHaveProperty("provider");
    expect(canonicalBody).toMatchObject({
      collection: { state: "complete", itemsReturned: 1 },
      result: {
        results: [
          {
            videoId: "video-1",
            description: "Canonical result",
            thumbnail: "https://example.com/cover.jpg",
            duration: 12,
            views: 100,
            collects: 5,
            author: { username: "example", displayName: "Example" },
          },
        ],
      },
    });
    expect(JSON.stringify(canonicalBody)).not.toMatch(/socialkit/iu);
    expect(providerRequests).toBe(1);

    const emptyResponse = await rawSocialRequest(
      null,
      { tool: "tiktok_search", input: { query: "empty" } },
      {
        authorization: `Bearer ${token}`,
        usagePricingResolution: pricing.resolution,
      },
    );
    expect(emptyResponse.status).toBe(200);
    await expect(emptyResponse.json()).resolves.toMatchObject({
      collection: {
        state: "provider_limited",
        itemsReturned: 0,
        uncertainty: { reason: "unreliable_empty_result" },
      },
      result: { results: [], hasMore: false, cursor: null },
    });
    expect(providerRequests).toBe(2);
    expect(beforeCredits - (await credits(actor))).toBe(
      2 * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("rejects conflicting TikTok aliases before usage settlement", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    let providerRequests = 0;
    server.use(
      http.get(`${SOCIALKIT_BASE}/tiktok/search`, () => {
        providerRequests += 1;
        return HttpResponse.json(
          providerResponse({
            results: [
              {
                id: "source-id",
                videoId: "contradictory-id",
                desc: "Result",
              },
            ],
            hasMore: false,
            cursor: null,
          }),
        );
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: { tool: "tiktok_search", input: { query: "launch" } },
      }),
      [502],
    );

    expectApiError(response.body);
    expect(providerRequests).toBe(1);
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("accepts agent tokens and attributes usage to their run", async () => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Social test actor must belong to an organization");
    }
    const bdd = createBddApi(context);
    const api = createRunsApi(context);
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await api.grantProEntitlement(actor);
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    configureProvider();
    const name = `social-${randomUUID().slice(0, 8)}`;
    const compose = await api.createDirectAgent(actor, {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
        },
      },
    });
    const run = await api.createDirectRun(actor, {
      agentId: compose.agentId,
      prompt: "Retrieve public social data",
    });
    const token = api.okouTokenForRunWithCapabilities(actor, run.runId, [
      "social:read",
    ]);
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        return HttpResponse.json(
          providerResponse({
            provider: "socialkit",
            providerName: "SocialKit",
            nested: {
              providerCode: "socialkit",
              items: [{ upstreamProvider: "socialkit" }],
            },
            source: { provider: "youtube" },
          }),
        );
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: { authorization: `Bearer ${token}` },
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [200],
    );
    expect(response.body).not.toHaveProperty("provider");
    expect(response.body.result).toMatchObject({
      source: { provider: "youtube" },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/socialkit/iu);

    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        return HttpResponse.json(
          { message: "Video not found or transcript not available" },
          { status: 404 },
        );
      }),
    );
    const agentError = await rawSocialRequest(null, DEFAULT_SOCIAL_REQUEST, {
      authorization: `Bearer ${token}`,
      usagePricingResolution: pricing.resolution,
    });
    const agentErrorBody = (await agentError.json()) as {
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(agentError.status).toBe(404);
    expect(agentErrorBody.error.code).toBe(
      "SOCIAL_TRANSCRIPT_AVAILABILITY_UNKNOWN",
    );
    expect(agentErrorBody.error.message).not.toMatch(/socialkit/iu);

    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: actor.userId,
          primaryEmailAddressId: `email_${actor.userId}`,
          emailAddresses: [
            {
              id: `email_${actor.userId}`,
              emailAddress: `${actor.userId}@example.com`,
            },
          ],
        },
      ],
    });
    const usage = await accept(
      setupApp({ context, routes: usageRecordRoutes })(usageRecordContract).get(
        {
          headers: authenticate(actor),
          query: {
            page: 1,
            pageSize: 20,
            scope: "mine",
            range: "24h",
            tz: "UTC",
          },
        },
      ),
      [200],
    );

    expect(response.body.creditsCharged).toBe(SOCIALKIT_REQUEST_CREDITS);
    expect(usage.body.rows).toHaveLength(1);
    expect(usage.body.rows[0]?.runId).toBe(run.runId);
    expect(usage.body.rows[0]?.credits).toBe(SOCIALKIT_REQUEST_CREDITS);
  });

  it("forwards representative GET operations with only managed auth", async () => {
    const actor = createBddApi(context).user();
    const cases = [
      ["/youtube/transcript", "url"],
      ["/tiktok/search", "query"],
      ["/instagram/comments", "url"],
      ["/facebook/stats", "url"],
      ["/twitter/profile", "url"],
      ["/linkedin/company", "url"],
    ] as const;
    const observed: {
      path: string;
      queryName: string;
      queryValue: string;
      accessKey: string | null;
    }[] = [];
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    for (const [path] of cases) {
      server.use(
        providerHandler("GET", path, () => {
          return HttpResponse.json(providerResponse(validProviderData(path)));
        }),
      );
    }
    server.use(
      http.get(/^https:\/\/api\.socialkit\.dev\//u, ({ request }) => {
        const url = new URL(request.url);
        const query = [...url.searchParams.entries()];
        observed.push({
          path: url.pathname,
          queryName: query[0]?.[0] ?? "",
          queryValue: query[0]?.[1] ?? "",
          accessKey: request.headers.get("x-access-key"),
        });
        return HttpResponse.json(
          providerResponse(validProviderData(url.pathname)),
        );
      }),
    );
    const beforeCredits = await credits(actor);

    for (const [path, queryName] of cases) {
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(path, {
            [queryName]:
              queryName === "url"
                ? "https://example.com/public-content"
                : "public content",
          }),
        }),
        [200],
      );
      const tool = toolForPath(path);
      expect(response.body).toMatchObject({
        provider: "socialkit",
        tool: tool.name,
        billingCategory: DEFAULT_CATEGORY,
        billingQuantity: 1,
        creditsCharged: SOCIALKIT_REQUEST_CREDITS,
        result: validProviderData(path),
      });
    }

    expect(observed).toStrictEqual(
      cases.map(([path, queryName]) => {
        return {
          path,
          queryName,
          queryValue:
            queryName === "url"
              ? "https://example.com/public-content"
              : "public content",
          accessKey: "test-socialkit-key",
        };
      }),
    );
    expect(beforeCredits - (await credits(actor))).toBe(
      cases.length * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("maps typed tools to canonical GET requests without a body", async () => {
    const actor = createBddApi(context).user();
    let observedUrl = "";
    let observedAccessKey: string | null = null;
    let observedBody = "";
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    const beforeCredits = await credits(actor);
    server.use(
      http.get(
        `${SOCIALKIT_BASE}/instagram/reels-search`,
        async ({ request }) => {
          observedUrl = request.url;
          observedAccessKey = request.headers.get("x-access-key");
          observedBody = await request.text();
          return HttpResponse.json(
            providerResponse({ items: [], hasMore: false, page: 2 }),
          );
        },
      ),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: requestForPath("/instagram/reels-search", {
          query: "cats",
          page: 2,
        }),
      }),
      [200],
    );

    expect(observedUrl).toBe(
      `${SOCIALKIT_BASE}/instagram/reels-search?query=cats&page=2`,
    );
    expect(observedAccessKey).toBe("test-socialkit-key");
    expect(observedBody).toBe("");
    expect(response.body).toMatchObject({
      billingCategory: DEFAULT_CATEGORY,
      billingQuantity: 1,
      creditsCharged: SOCIALKIT_REQUEST_CREDITS,
      collection: { state: "complete", itemsReturned: 0 },
      result: { items: [], hasMore: false, page: 2 },
    });
    expect(beforeCredits - (await credits(actor))).toBe(
      SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("forwards documented pagination, filter, cache, and customization fields", async () => {
    const actor = createBddApi(context).user();
    const cases = [
      {
        path: "/tiktok/channel-videos",
        input: {
          url: "https://tiktok.com/@example",
          limit: 10,
          cursor: "next-page",
          cache: true,
          cache_ttl: 3600,
        },
        expectedQuery: {
          url: "https://tiktok.com/@example",
          limit: "10",
          cursor: "next-page",
          cache: "true",
          cache_ttl: "3600",
        },
      },
      {
        path: "/youtube/search",
        input: {
          query: "product launch",
          limit: 10,
          sortBy: "date",
          uploadDate: "month",
          type: "video",
          cache: false,
          cache_ttl: 2_592_000,
        },
        expectedQuery: {
          query: "product launch",
          limit: "10",
          sortBy: "date",
          uploadDate: "month",
          type: "video",
          cache: "false",
          cache_ttl: "2592000",
        },
      },
      {
        path: "/instagram/comments",
        input: {
          url: "https://instagram.com/p/example",
          limit: 10,
          cursor: "next-page",
          sortBy: "recent",
        },
        expectedQuery: {
          url: "https://instagram.com/p/example",
          limit: "10",
          cursor: "next-page",
          sortBy: "recent",
        },
      },
      {
        path: "/youtube/summarize",
        input: {
          url: "https://youtu.be/video123",
          custom_response: { title: "Video title" },
          custom_prompt: "Return only the requested fields",
          cache: true,
          cache_ttl: 3600,
        },
        expectedQuery: {
          url: "https://youtu.be/video123",
          custom_response: '{"title":"Video title"}',
          custom_prompt: "Return only the requested fields",
          cache: "true",
          cache_ttl: "3600",
        },
      },
    ] as const;
    const observed: { path: string; query: Record<string, string> }[] = [];
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    server.use(
      http.get(/^https:\/\/api\.socialkit\.dev\//u, ({ request }) => {
        const url = new URL(request.url);
        observed.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        });
        return HttpResponse.json(
          providerResponse(validProviderData(url.pathname)),
        );
      }),
    );

    for (const request of cases) {
      await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(request.path, request.input),
        }),
        [200],
      );
    }

    expect(observed).toStrictEqual(
      cases.map(({ path, expectedQuery }) => {
        return { path, query: expectedQuery };
      }),
    );
  });

  it("settles result-metered pages from validated returned item counts", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    const beforeCredits = await credits(actor);
    const cases = [
      {
        path: "/youtube/search",
        query: { query: "launch", limit: "100" },
        data: { results: providerItems(20) },
        expectedQuantity: 1,
        expectedState: "provider_limited",
      },
      {
        path: "/youtube/search",
        query: { query: "launch", limit: "100" },
        data: { results: providerItems(100) },
        expectedQuantity: 2,
        expectedState: "provider_limited",
      },
      {
        path: "/instagram/channel-posts",
        query: { url: "https://instagram.com/example", limit: "100" },
        data: {
          items: providerItems(20),
          hasMore: false,
        },
        expectedQuantity: 1,
        expectedState: "complete",
      },
      {
        path: "/instagram/channel-posts",
        query: { url: "https://instagram.com/example", limit: "100" },
        data: {
          items: providerItems(21),
          hasMore: false,
        },
        expectedQuantity: 2,
        expectedState: "complete",
      },
    ] as const;

    for (const testCase of cases) {
      server.use(
        providerHandler("GET", testCase.path, () => {
          return HttpResponse.json(providerResponse(testCase.data));
        }),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(testCase.path, testCase.query),
        }),
        [200],
      );

      expect(response.body.billingQuantity).toBe(testCase.expectedQuantity);
      expect(response.body.creditsCharged).toBe(
        testCase.expectedQuantity * SOCIALKIT_REQUEST_CREDITS,
      );
      expect(response.body.collection).toMatchObject({
        state: testCase.expectedState,
        itemsReturned:
          testCase.path === "/youtube/search"
            ? testCase.data.results.length
            : testCase.data.items.length,
      });
    }

    expect(beforeCredits - (await credits(actor))).toBe(
      6 * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("sends the reviewed default limit used for credit preflight", async () => {
    const actor = createBddApi(context).user();
    let observedLimit: string | null = null;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS);
    server.use(
      http.get(`${SOCIALKIT_BASE}/youtube/search`, ({ request }) => {
        observedLimit = new URL(request.url).searchParams.get("limit");
        return HttpResponse.json(
          providerResponse({
            results: providerItems(10),
          }),
        );
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: requestForPath("/youtube/search", { query: "launch" }),
      }),
      [200],
    );

    expect(observedLimit).toBe("10");
    expect(response.body.billingQuantity).toBe(1);
    expect(response.body.collection).toStrictEqual({
      state: "provider_limited",
      itemsReturned: 10,
      reason: "no_pagination",
    });
    await expect(credits(actor)).resolves.toBe(0);
  });

  it("normalizes every reviewed pagination shape", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    const cases = [
      {
        path: "/tiktok/search",
        query: { query: "launch", limit: "10" },
        data: { results: [{ id: "1" }], hasMore: true, cursor: 30 },
        expected: {
          state: "more",
          itemsReturned: 1,
          nextInput: { cursor: "30" },
        },
      },
      {
        path: "/twitter/tweets",
        query: { url: "https://x.com/example", limit: "20" },
        data: { tweets: [{ id: "1" }], nextCursor: "next-tweet" },
        expected: {
          state: "more",
          itemsReturned: 1,
          nextInput: { cursor: "next-tweet" },
        },
      },
      {
        path: "/instagram/reels-search",
        query: { query: "cats", page: "1" },
        data: { items: [{ id: "1" }], hasMore: true },
        expected: {
          state: "more",
          itemsReturned: 1,
          nextInput: { page: 2 },
        },
      },
      {
        path: "/instagram/reels-search",
        query: { query: "cats", page: "2" },
        data: { items: [{ id: "2" }], hasMore: true },
        expected: {
          state: "provider_limited",
          itemsReturned: 1,
          reason: "provider_ceiling",
        },
      },
      {
        path: "/linkedin/company-posts",
        query: { url: "https://linkedin.com/company/example", limit: "50" },
        data: { posts: [{ id: "1" }] },
        expected: {
          state: "provider_limited",
          itemsReturned: 1,
          reason: "no_pagination",
        },
      },
    ] as const;

    for (const testCase of cases) {
      server.use(
        providerHandler("GET", testCase.path, () => {
          return HttpResponse.json(providerResponse(testCase.data));
        }),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(testCase.path, testCase.query),
        }),
        [200],
      );

      expect(response.body.collection).toStrictEqual(testCase.expected);
    }
  });

  it("uses reported comment totals to prevent false completion", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    await fundActor(actor);
    const pricing = await setupConfiguredPricing();
    const beforeCredits = await credits(actor);
    const request = requestForPath("/tiktok/comments", {
      url: "https://tiktok.com/@example/video/123",
      limit: 10,
    });

    server.use(
      providerHandler("GET", "/tiktok/comments", () => {
        return HttpResponse.json(
          providerResponse({
            videoId: "123",
            comments: [{ id: "1" }, { id: "2" }],
            commentCount: 100,
            hasMore: false,
            cursor: null,
          }),
        );
      }),
    );
    const limited = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: request,
      }),
      [200],
    );
    expect(limited.body.collection).toStrictEqual({
      state: "provider_limited",
      itemsReturned: 2,
      reason: "reported_total_exceeds_page",
      reportedTotal: 100,
    });

    server.use(
      providerHandler("GET", "/tiktok/comments", () => {
        return HttpResponse.json(
          providerResponse({
            videoId: "123",
            comments: [{ id: "1" }, { id: "2" }],
            commentCount: 2,
            hasMore: false,
            cursor: null,
          }),
        );
      }),
    );
    const complete = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: request,
      }),
      [200],
    );
    expect(complete.body.collection).toStrictEqual({
      state: "complete",
      itemsReturned: 2,
      reportedTotal: 2,
    });

    server.use(
      providerHandler("GET", "/tiktok/comments", () => {
        return HttpResponse.json(
          providerResponse({
            videoId: "123",
            comments: [{ id: "1" }, { id: "2" }],
            commentCount: 1,
            hasMore: false,
            cursor: null,
          }),
        );
      }),
    );
    const malformed = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: request,
      }),
      [502],
    );
    expectApiError(malformed.body);
    expect(malformed.body.error.code).toBe("SOCIALKIT_INVALID_RESPONSE");

    server.use(
      providerHandler("GET", "/tiktok/comments", () => {
        return HttpResponse.json(
          providerResponse({
            videoId: "123",
            comments: [{ id: "1" }],
            commentCount: 100,
            hasMore: true,
            cursor: "next-page",
          }),
        );
      }),
    );
    const continued = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: request,
      }),
      [200],
    );
    expect(continued.body.collection).toStrictEqual({
      state: "more",
      itemsReturned: 1,
      reportedTotal: 100,
      nextInput: { cursor: "next-page" },
    });

    expect(beforeCredits - (await credits(actor))).toBe(
      3 * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("preflights the maximum result-metered quantity before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS);
    server.use(
      providerHandler("GET", "/youtube/search", () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse({ results: [] }));
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: requestForPath("/youtube/search", {
          query: "launch",
          limit: 100,
        }),
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("rejects invalid collection successes without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const cases = [
      {
        path: "/youtube/search",
        query: { query: "launch", limit: "10" },
        data: { value: "missing results" },
      },
      {
        path: "/youtube/search",
        query: { query: "launch", limit: "10" },
        data: { results: providerItems(11) },
      },
      {
        path: "/instagram/comments",
        query: { url: "https://instagram.com/p/example", limit: "10" },
        data: { comments: [], hasMore: true },
      },
      {
        path: "/instagram/reels-search",
        query: { query: "cats", page: "1" },
        data: { items: [] },
      },
    ] as const;

    for (const testCase of cases) {
      server.use(
        providerHandler("GET", testCase.path, () => {
          return HttpResponse.json(providerResponse(testCase.data));
        }),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: requestForPath(testCase.path, testCase.query),
        }),
        [502],
      );

      expectApiError(response.body);
      expect(response.body.error.code).toBe("SOCIALKIT_INVALID_RESPONSE");
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it.each([
    {
      caseName: "an unknown tool",
      body: { tool: "youtube_unknown", input: {} },
    },
    {
      caseName: "a download tool",
      body: { tool: "youtube_download", input: {} },
    },
    {
      caseName: "the removed generic request shape",
      body: { method: "GET", path: "/youtube/transcript" },
    },
    {
      caseName: "an auth input field",
      body: {
        tool: "youtube_transcript",
        input: { url: "https://youtu.be/id", access_key: "caller-key" },
      },
    },
    {
      caseName: "an input field from another tool",
      body: {
        tool: "youtube_transcript",
        input: { query: "not a transcript input" },
      },
    },
    {
      caseName: "a missing URL",
      body: { tool: "youtube_transcript", input: {} },
    },
    {
      caseName: "a missing search query",
      body: { tool: "tiktok_search", input: { limit: 1 } },
    },
    {
      caseName: "a missing hashtag",
      body: { tool: "tiktok_hashtag_search", input: { limit: 1 } },
    },
    {
      caseName: "the obsolete Instagram Reels limit field",
      body: {
        tool: "instagram_reels_search",
        input: { query: "cats", limit: 1 },
      },
    },
    {
      caseName: "an out-of-range Instagram Reels page",
      body: {
        tool: "instagram_reels_search",
        input: { query: "cats", page: 3 },
      },
    },
    {
      caseName: "an invalid cache flag",
      body: {
        tool: "youtube_stats",
        input: { url: "https://youtu.be/id", cache: "yes" },
      },
    },
    {
      caseName: "an out-of-range cache TTL",
      body: {
        tool: "youtube_stats",
        input: { url: "https://youtu.be/id", cache_ttl: 3599 },
      },
    },
    {
      caseName: "an invalid search sort order",
      body: {
        tool: "youtube_search",
        input: { query: "launch", sortBy: "popular" },
      },
    },
    {
      caseName: "a prefixed TikTok hashtag",
      body: { tool: "tiktok_hashtag_search", input: { hashtag: "#launch" } },
    },
    {
      caseName: "an invalid full-details flag",
      body: {
        tool: "youtube_videos",
        input: { url: "https://youtube.com/", full_details: "yes" },
      },
    },
    {
      caseName: "a URL with embedded credentials",
      body: {
        tool: "youtube_transcript",
        input: { url: "https://user:password@youtube.com/watch?v=id" },
      },
    },
    {
      caseName: "a bulk tool",
      body: { tool: "youtube_stats_bulk", input: {} },
    },
    {
      caseName: "a direct-video tool",
      body: {
        tool: "video_transcript",
        input: { url: "https://example.com/video.mp4" },
      },
    },
    {
      caseName: "a result limit above the provider maximum",
      body: {
        tool: "youtube_comments",
        input: { url: "https://youtu.be/id", limit: 101 },
      },
    },
    {
      caseName: "a non-integer result limit",
      body: { tool: "tiktok_search", input: { query: "launch", limit: 1.5 } },
    },
    {
      caseName: "a string result limit",
      body: { tool: "youtube_search", input: { query: "launch", limit: "10" } },
    },
  ])("rejects $caseName before provider work", async ({ body }) => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    server.use(
      http.get(/^https:\/\/api\.socialkit\.dev\//u, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
      http.post(/^https:\/\/api\.socialkit\.dev\//u, () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await rawSocialRequest(actor, body);

    expect(response.status).toBe(400);
    expect(providerRequests).toBe(0);
  });

  it("rejects requests when SocialKit is not configured", async () => {
    const actor = createBddApi(context).user();
    mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", undefined);

    const response = await accept(
      client()(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_CONFIGURED");
  });

  it("returns missing pricing before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    await fundActor(actor);
    const pricing = await setupMissingPricing();
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [503],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("PRICING_NOT_CONFIGURED");
    expect(providerRequests).toBe(0);
  });

  it("returns insufficient credits before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS - 1);
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        providerRequests += 1;
        return HttpResponse.json(providerResponse());
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("maps provider HTTP failures without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const cases = [
      [400, "raw invalid input payload", 400, "SOCIALKIT_INVALID_INPUT"],
      [401, "raw missing key payload", 502, "SOCIALKIT_AUTH_ERROR"],
      [403, "Invalid Access key", 502, "SOCIALKIT_AUTH_ERROR"],
      [
        403,
        "Request limit exceeded for this month",
        503,
        "SOCIALKIT_QUOTA_EXHAUSTED",
      ],
      [403, "unexpected forbidden response", 502, "SOCIALKIT_UPSTREAM_ERROR"],
      [
        404,
        "raw missing content payload",
        404,
        "SOCIALKIT_TRANSCRIPT_AVAILABILITY_UNKNOWN",
      ],
      [429, "raw rate limit payload", 502, "SOCIALKIT_RATE_LIMITED"],
      [500, "raw provider failure payload", 502, "SOCIALKIT_UPSTREAM_ERROR"],
    ] as const;

    for (const [providerStatus, providerMessage, apiStatus, code] of cases) {
      server.use(
        providerHandler("GET", "/youtube/transcript", () => {
          return HttpResponse.json(
            { message: providerMessage },
            { status: providerStatus },
          );
        }),
      );
      const response = await rawSocialRequest(actor, DEFAULT_SOCIAL_REQUEST, {
        usagePricingResolution: pricing.resolution,
      });
      const body: unknown = await response.json();

      expect(response.status).toBe(apiStatus);
      expect(body).toMatchObject({ error: { code } });
      expect(JSON.stringify(body)).not.toContain(providerMessage);
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("classifies documented transcript availability signals without billing or retries", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    let providerRequests = 0;
    const cases = [
      {
        status: 404,
        message: "  NO TRANSCRIPT AVAILABLE FOR THIS VIDEO  ",
        expectedStatus: 404,
        expectedCode: SOCIALKIT_TRANSCRIPT_ERROR_CODES.TRANSCRIPT_UNAVAILABLE,
        expectedReason: "transcript_unavailable",
        expectedMessage: "A transcript is not available for this video",
      },
      {
        status: 404,
        message: "Video not found or transcript not available",
        expectedStatus: 404,
        expectedCode: SOCIALKIT_TRANSCRIPT_ERROR_CODES.AVAILABILITY_UNKNOWN,
        expectedReason: "availability_unknown",
        expectedMessage:
          "SocialKit could not establish whether the source or transcript is unavailable",
      },
      {
        status: 404,
        message: "provider changed this wording",
        expectedStatus: 404,
        expectedCode: SOCIALKIT_TRANSCRIPT_ERROR_CODES.AVAILABILITY_UNKNOWN,
        expectedReason: "availability_unknown",
        expectedMessage:
          "SocialKit could not establish whether the source or transcript is unavailable",
      },
      {
        status: 403,
        message: "Access denied - transcript may be disabled",
        expectedStatus: 502,
        expectedCode: SOCIALKIT_TRANSCRIPT_ERROR_CODES.ACCESS_DENIED,
        expectedReason: "access_denied",
        expectedMessage:
          "SocialKit denied transcript access; transcript availability is unknown",
      },
      {
        status: 404,
        message: undefined,
        expectedStatus: 404,
        expectedCode: SOCIALKIT_TRANSCRIPT_ERROR_CODES.AVAILABILITY_UNKNOWN,
        expectedReason: "availability_unknown",
        expectedMessage:
          "SocialKit could not establish whether the source or transcript is unavailable",
      },
    ] as const;

    for (const testCase of cases) {
      server.use(
        providerHandler("GET", "/youtube/transcript", () => {
          providerRequests += 1;
          return HttpResponse.json(
            testCase.message === undefined
              ? { success: false }
              : { message: testCase.message },
            { status: testCase.status },
          );
        }),
      );
      const response = await rawSocialRequest(actor, DEFAULT_SOCIAL_REQUEST, {
        usagePricingResolution: pricing.resolution,
      });
      const body: unknown = await response.json();

      expect(response.status).toBe(testCase.expectedStatus);
      expect(body).toMatchObject({
        error: {
          code: testCase.expectedCode,
          reason: testCase.expectedReason,
          message: testCase.expectedMessage,
        },
      });
      const includesProviderMessage =
        testCase.message !== undefined &&
        JSON.stringify(body).includes(testCase.message.trim());
      expect(includesProviderMessage).toBeFalsy();
    }

    let nonTranscriptRequests = 0;
    server.use(
      providerHandler("GET", "/linkedin/profile", () => {
        nonTranscriptRequests += 1;
        return HttpResponse.json(
          { message: "Video not found or transcript not available" },
          { status: 404 },
        );
      }),
    );
    const nonTranscriptResponse = await rawSocialRequest(
      actor,
      requestForPath("/linkedin/profile", {
        url: "https://linkedin.com/in/example",
      }),
      { usagePricingResolution: pricing.resolution },
    );
    const nonTranscriptBody: unknown = await nonTranscriptResponse.json();
    expect(nonTranscriptResponse.status).toBe(404);
    expect(nonTranscriptBody).toMatchObject({
      error: {
        code: "SOCIALKIT_CONTENT_UNAVAILABLE",
      },
    });
    expect(nonTranscriptBody).not.toHaveProperty("error.reason");
    expect(providerRequests).toBe(cases.length);
    expect(nonTranscriptRequests).toBe(1);
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("rejects invalid or credential-leaking successes without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const invalidResponses: (() => Response)[] = [
      () => {
        return HttpResponse.text("not-json");
      },
      () => {
        return HttpResponse.json({ success: false, message: "unavailable" });
      },
      () => {
        return HttpResponse.json({ success: true });
      },
      () => {
        return HttpResponse.json(
          providerResponse({ echoed: "test-socialkit-key" }),
        );
      },
    ];

    for (const responseFactory of invalidResponses) {
      server.use(
        providerHandler("GET", "/youtube/transcript", responseFactory),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: DEFAULT_SOCIAL_REQUEST,
        }),
        [502],
      );
      expectApiError(response.body);
      expect(response.body.error.code).toBe("SOCIALKIT_INVALID_RESPONSE");
      expect(JSON.stringify(response.body)).not.toContain("test-socialkit-key");
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("rejects declared and streamed oversized responses before billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const responses: (() => Response)[] = [
      () => {
        return HttpResponse.text(JSON.stringify(providerResponse()), {
          headers: {
            "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
          },
        });
      },
      () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                "x".repeat(MAX_PROVIDER_RESPONSE_BYTES + 1),
              ),
            );
          },
        });
        return new HttpResponse(stream, {
          headers: { "content-length": "1" },
        });
      },
    ];

    for (const responseFactory of responses) {
      server.use(
        providerHandler("GET", "/youtube/transcript", responseFactory),
      );
      const response = await accept(
        client(pricing.resolution)(socialContract).request({
          headers: authenticate(actor),
          body: DEFAULT_SOCIAL_REQUEST,
        }),
        [502],
      );
      expectApiError(response.body);
      expect(response.body.error.code).toBe("SOCIALKIT_OUTPUT_TOO_LARGE");
    }
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("maps timeout and network failures without recording usage", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);

    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException("timed out", "TimeoutError"));
          },
        });
        return new HttpResponse(stream);
      }),
    );
    const timeout = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [502],
    );
    expectApiError(timeout.body);
    expect(timeout.body.error.code).toBe("SOCIALKIT_REQUEST_TIMEOUT");

    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        return HttpResponse.error();
      }),
    );
    const network = await accept(
      client(pricing.resolution)(socialContract).request({
        headers: authenticate(actor),
        body: DEFAULT_SOCIAL_REQUEST,
      }),
      [502],
    );
    expectApiError(network.body);
    expect(network.body.error.code).toBe("SOCIALKIT_UPSTREAM_ERROR");
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("does not record usage when the client aborts during provider work", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected during provider work");
    abortError.name = "AbortError";
    const providerStarted = createDeferredPromise<void>(context.signal);
    const providerRelease = createDeferredPromise<void>(context.signal);
    let providerSignalAborted = false;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      http.get(`${SOCIALKIT_BASE}/youtube/transcript`, async ({ request }) => {
        providerStarted.resolve(undefined);
        controller.abort(abortError);
        providerSignalAborted = request.signal.aborted;
        await providerRelease.promise;
        return HttpResponse.json(providerResponse());
      }),
    );

    const responsePromise = rawSocialRequest(actor, DEFAULT_SOCIAL_REQUEST, {
      requestSignal: controller.signal,
      usagePricingResolution: pricing.resolution,
    });
    await providerStarted.promise;
    providerRelease.resolve(undefined);
    const response = await responsePromise;

    expect(response.status).toBe(500);
    expect(providerSignalAborted).toBeTruthy();
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("records usage when the client disconnects after provider success", async () => {
    const actor = createBddApi(context).user();
    const controller = new AbortController();
    const abortError = new Error("client disconnected after provider success");
    abortError.name = "AbortError";
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      providerHandler("GET", "/youtube/transcript", () => {
        const payload = new TextEncoder().encode(
          JSON.stringify(providerResponse()),
        );
        let payloadSent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(streamController) {
            if (!payloadSent) {
              payloadSent = true;
              streamController.enqueue(payload);
              return;
            }
            streamController.close();
            setImmediate(() => {
              controller.abort(abortError);
            });
          },
        });
        return new HttpResponse(stream);
      }),
    );

    const response = await rawSocialRequest(actor, DEFAULT_SOCIAL_REQUEST, {
      requestSignal: controller.signal,
      usagePricingResolution: pricing.resolution,
    });

    expect(response.status).toBe(200);
    expect(controller.signal.aborted).toBeTruthy();
    expect(beforeCredits - (await credits(actor))).toBe(
      SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("records concurrent multi-unit requests exactly once each", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    server.use(
      providerHandler("GET", "/youtube/search", () => {
        providerRequests += 1;
        return HttpResponse.json(
          providerResponse({
            results: providerItems(100),
          }),
        );
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);
    const request = requestForPath("/youtube/search", {
      query: "launch",
      limit: 100,
    });

    const [first, second] = await Promise.all([
      accept(
        socialClient.request({
          headers: authenticate(actor),
          body: request,
        }),
        [200],
      ),
      accept(
        socialClient.request({
          headers: authenticate(actor),
          body: request,
        }),
        [200],
      ),
    ]);

    expect(first.body.billingQuantity).toBe(2);
    expect(second.body.billingQuantity).toBe(2);
    expect(first.body.creditsCharged).toBe(2 * SOCIALKIT_REQUEST_CREDITS);
    expect(second.body.creditsCharged).toBe(2 * SOCIALKIT_REQUEST_CREDITS);
    expect(providerRequests).toBe(2);
    expect(beforeCredits - (await credits(actor))).toBe(
      4 * SOCIALKIT_REQUEST_CREDITS,
    );
  });

  it("materializes a ready v2 download and bills provider credits once", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    mockNow(Date.UTC(2000, 0, 1));
    const payload = new TextEncoder().encode("downloaded social video");
    const providerJobId = `provider-download-${randomUUID()}`;
    let startBody: unknown;
    let providerPolls = 0;
    context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.post(
        `${SOCIALKIT_BASE}/v2/youtube/download`,
        async ({ request }) => {
          startBody = await request.json();
          return HttpResponse.json({
            success: true,
            data: {
              jobId: providerJobId,
              status: "queued",
              statusUrl: `${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`,
            },
          });
        },
      ),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        providerPolls += 1;
        if (providerPolls === 1) {
          return HttpResponse.json({
            success: true,
            data: {
              jobId: providerJobId,
              status: "processing",
            },
          });
        }
        return HttpResponse.json({
          success: true,
          data: {
            jobId: providerJobId,
            status: "ready",
            platform: "youtube",
            downloadUrl: "https://media.socialkit.test/download-1",
            durationSeconds: 61,
            fileSizeMB: "1.5 MB",
            creditsCost: 2,
            quality: "480p",
            format: "mp4",
            title: "Public / 视频.mp4",
            thumbnail: "https://media.socialkit.test/thumbnail.jpg",
          },
        });
      }),
      http.get("https://media.socialkit.test/download-1", () => {
        return new HttpResponse(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      }),
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [] });
      }
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: "socialkit-upload-1" });
      }
      if (command instanceof UploadPartCommand) {
        return Promise.resolve({ ETag: '"socialkit-etag-1"' });
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const processing = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const completed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    const creditsAfterCompletion = await credits(actor);
    await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(startBody).toStrictEqual({
      url: "https://youtu.be/public-video",
      max_duration: 120,
      quality: "720p",
      format: "mp4",
    });
    expect(created.body.status).toBe("processing");
    expect(processing.body.status).toBe("processing");
    expect(completed.body).toMatchObject({
      status: "completed",
      provider: {
        durationSeconds: 61,
        creditsCost: 2,
        thumbnail: "https://media.socialkit.test/thumbnail.jpg",
      },
      billing: { quantity: 2, creditsCharged: 6 },
      artifact: {
        id: created.body.downloadId,
        filename: "Public _ 视频.mp4",
        contentType: "video/mp4",
        sizeBytes: payload.byteLength,
      },
    });
    expect(beforeCredits - creditsAfterCompletion).toBe(6);
    await expect(credits(actor)).resolves.toBe(creditsAfterCompletion);
    expect(
      context.mocks.s3.send.mock.calls.filter(([command]) => {
        return command instanceof UploadPartCommand;
      }),
    ).toHaveLength(1);
  });

  // An ID3v2 header followed by an MPEG audio frame, which is what an upstream
  // audio-only fallback returns for a `format=mp4` request.
  const AUDIO_ONLY_PAYLOAD = new Uint8Array([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xff, 0xfb,
    0x90, 0x00,
  ]);

  // A bare MPEG frame sync with no ID3 tag in front of it.
  const MPEG_FRAME_PAYLOAD = new Uint8Array([
    0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);

  function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(
      parts.reduce((size, part) => {
        return size + part.byteLength;
      }, 0),
    );
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }

  function ascii(value: string): Uint8Array {
    return Uint8Array.from(value, (character) => {
      return character.charCodeAt(0);
    });
  }

  function isoBox(type: string, payload: Uint8Array): Uint8Array {
    const result = new Uint8Array(8 + payload.byteLength);
    const view = new DataView(result.buffer);
    view.setUint32(0, result.byteLength);
    result.set(ascii(type), 4);
    result.set(payload, 8);
    return result;
  }

  function isoTrack(handler: "soun" | "vide"): Uint8Array {
    const handlerPayload = new Uint8Array(12);
    handlerPayload.set(ascii(handler), 8);
    return isoBox("trak", isoBox("mdia", isoBox("hdlr", handlerPayload)));
  }

  // A small but structurally valid ISO base media file. Generic brands such as
  // `isom` and `mp42` need the `hdlr` boxes to distinguish audio from video.
  function isoBaseMediaPayload(
    brand: string,
    tracks: readonly ("soun" | "vide")[] = [],
  ): Uint8Array {
    const fileType = isoBox(
      "ftyp",
      concatBytes([ascii(brand), new Uint8Array(4), ascii(brand)]),
    );
    const movie = isoBox(
      "moov",
      concatBytes(
        tracks.map((handler) => {
          return isoTrack(handler);
        }),
      ),
    );
    return concatBytes([fileType, movie]);
  }

  async function completeDownloadWithPayload(
    actor: ApiTestUser,
    pricing: UsagePricingFixture,
    payload: Uint8Array,
  ) {
    const providerJobId = `provider-audio-only-${randomUUID()}`;
    const downloadPath = `/download-${providerJobId}`;
    context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "ready",
          platform: "youtube",
          downloadUrl: `https://media.socialkit.test${downloadPath}`,
          durationSeconds: 61,
          fileSizeMB: 1,
          creditsCost: 2,
          quality: "720p",
          format: "mp4",
          title: "Public clip",
        });
      }),
      http.get(`https://media.socialkit.test${downloadPath}`, () => {
        return new HttpResponse(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      }),
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [] });
      }
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: "socialkit-audio-only" });
      }
      if (command instanceof UploadPartCommand) {
        return Promise.resolve({ ETag: '"socialkit-audio-only-etag"' });
      }
      return Promise.resolve({});
    });
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const completed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    return completed.body;
  }

  it.each([
    {
      caseName: "an ID3-tagged MPEG stream",
      payload: AUDIO_ONLY_PAYLOAD,
      filename: "Public clip.mp3",
      contentType: "audio/mpeg",
    },
    {
      caseName: "a bare MPEG frame sync",
      payload: MPEG_FRAME_PAYLOAD,
      filename: "Public clip.mp3",
      contentType: "audio/mpeg",
    },
    {
      caseName: "an M4A-branded ISO container",
      payload: isoBaseMediaPayload("M4A "),
      filename: "Public clip.m4a",
      contentType: "audio/mp4",
    },
    {
      caseName: "an isom-branded ISO container with only an audio track",
      payload: isoBaseMediaPayload("isom", ["soun"]),
      filename: "Public clip.m4a",
      contentType: "audio/mp4",
    },
    {
      caseName: "an mp42-branded ISO container with a video track",
      payload: isoBaseMediaPayload("mp42", ["vide"]),
      filename: "Public clip.mp4",
      contentType: "video/mp4",
    },
    {
      caseName: "an ISO container with audio and video tracks",
      payload: isoBaseMediaPayload("isom", ["soun", "vide"]),
      filename: "Public clip.mp4",
      contentType: "video/mp4",
    },
  ])(
    "files $caseName by its detected media",
    async ({ payload, filename, contentType }) => {
      const actor = createBddApi(context).user();
      configureProvider();
      const pricing = await setupConfiguredPricing();
      await fundActor(actor);

      const body = await completeDownloadWithPayload(actor, pricing, payload);

      expect(body).toMatchObject({
        status: "completed",
        artifact: {
          filename,
          contentType,
          sizeBytes: payload.byteLength,
        },
      });
    },
  );

  it("keeps the requested format for an unrecognized container", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const payload = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00,
    ]);

    const body = await completeDownloadWithPayload(actor, pricing, payload);

    expect(body).toMatchObject({
      status: "completed",
      artifact: {
        filename: "Public clip.mp4",
        contentType: "video/mp4",
        sizeBytes: payload.byteLength,
      },
    });
  });

  it.each([
    {
      caseName: "declared oversized",
      response: () => {
        return new HttpResponse(new Uint8Array([1]), {
          headers: {
            "content-length": String(2 * 1024 * 1024 * 1024 + 1),
          },
        });
      },
      expectsMultipartAbort: false,
    },
    {
      caseName: "empty",
      response: () => {
        return new HttpResponse(new Uint8Array(0), {
          headers: { "content-length": "0" },
        });
      },
      expectsMultipartAbort: true,
    },
  ])(
    "marks $caseName artifact output billed and retryable",
    async ({ response, expectsMultipartAbort }) => {
      const actor = createBddApi(context).user();
      configureProvider();
      const pricing = await setupConfiguredPricing();
      await fundActor(actor);
      const beforeCredits = await credits(actor);
      const providerJobId = `provider-invalid-artifact-${randomUUID()}`;
      context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
        { address: "8.8.8.8", family: 4 },
      ]);
      server.use(
        http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
          return HttpResponse.json({ jobId: providerJobId, status: "queued" });
        }),
        http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
          return HttpResponse.json({
            jobId: providerJobId,
            status: "ready",
            platform: "youtube",
            downloadUrl:
              "https://media.socialkit.test/invalid-artifact-download",
            durationSeconds: 61,
            fileSizeMB: 1,
            creditsCost: 2,
            quality: "720p",
            format: "mp4",
          });
        }),
        http.get(
          "https://media.socialkit.test/invalid-artifact-download",
          response,
        ),
      );
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (command instanceof CreateMultipartUploadCommand) {
          return Promise.resolve({ UploadId: "socialkit-invalid-artifact" });
        }
        return Promise.resolve({});
      });
      const socialClient = client(pricing.resolution)(socialContract);

      const created = await accept(
        socialClient.createDownload({
          headers: authenticate(actor),
          body: {
            platform: "youtube",
            url: "https://youtu.be/public-video",
            maxDuration: 120,
            quality: "720p",
            format: "mp4",
          },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const failed = await accept(
        socialClient.getDownload({
          headers: authenticate(actor),
          params: { downloadId: created.body.downloadId },
        }),
        [200],
      );

      expect(failed.body).toMatchObject({
        status: "artifact_failed",
        billing: { quantity: 2, creditsCharged: 6 },
        artifact: null,
        error: { billed: true, retryable: true },
      });
      expect(beforeCredits - (await credits(actor))).toBe(6);
      expect(
        context.mocks.s3.send.mock.calls.some(([command]) => {
          return command instanceof AbortMultipartUploadCommand;
        }),
      ).toBe(expectsMultipartAbort);
    },
  );

  it("recovers billing after ready metadata is persisted before settlement interruption", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const payload = new TextEncoder().encode("settlement recovery video");
    const providerJobId = `provider-settlement-${randomUUID()}`;
    let interruptedSettlement = false;
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      if (milliseconds === 10_000 && !interruptedSettlement) {
        interruptedSettlement = true;
        const settlement = new AbortController();
        settlement.abort(
          new DOMException("Ready settlement timed out", "TimeoutError"),
        );
        return settlement.signal;
      }
      return undefined;
    });
    context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "ready",
          platform: "youtube",
          downloadUrl: "https://media.socialkit.test/settlement-recovery",
          durationSeconds: 61,
          fileSizeMB: 1,
          creditsCost: 2,
          quality: "720p",
          format: "mp4",
        });
      }),
      http.get("https://media.socialkit.test/settlement-recovery", () => {
        return new HttpResponse(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      }),
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return Promise.resolve({ Contents: [] });
      }
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: "socialkit-settlement-upload" });
      }
      if (command instanceof UploadPartCommand) {
        return Promise.resolve({ ETag: '"socialkit-settlement-etag"' });
      }
      return Promise.resolve({});
    });
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const interrupted = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(interruptedSettlement).toBeTruthy();
    expect(interrupted.body).toMatchObject({
      status: "processing",
      provider: { durationSeconds: 61, creditsCost: 2 },
      billing: null,
    });
    await expect(credits(actor)).resolves.toBe(beforeCredits);

    mockNow(now() + 61_000);
    await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const completed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(completed.body).toMatchObject({
      status: "completed",
      billing: { quantity: 2, creditsCharged: 6 },
      artifact: { sizeBytes: payload.byteLength },
    });
    expect(beforeCredits - (await credits(actor))).toBe(6);
  });

  it("rejects credential-bearing download URLs before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        providerRequests += 1;
        return HttpResponse.error();
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://user:password@youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [400],
    );

    expectApiError(response.body);
    expect(providerRequests).toBe(0);
  });

  it("preflights the maximum download duration before provider work", async () => {
    const actor = createBddApi(context).user();
    let providerRequests = 0;
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await bootstrapOnboarding(actor);
    await setActorCredits(actor, SOCIALKIT_REQUEST_CREDITS);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        providerRequests += 1;
        return HttpResponse.error();
      }),
    );

    const response = await accept(
      client(pricing.resolution)(socialContract).createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [402],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(providerRequests).toBe(0);
  });

  it("allows only one active download per user", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const providerStarted = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    const providerPollStarted = createDeferredPromise<void>(context.signal);
    const releaseProviderPoll = createDeferredPromise<void>(context.signal);
    const providerJobPrefix = `provider-single-download-${randomUUID()}`;
    let providerStarts = 0;
    let providerPolls = 0;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, async () => {
        providerStarts += 1;
        if (providerStarts === 1) {
          providerStarted.resolve();
          await releaseProvider.promise;
        }
        return HttpResponse.json({
          jobId: `${providerJobPrefix}-${providerStarts}`,
          status: "queued",
        });
      }),
      http.get(/^https:\/\/api\.socialkit\.dev\/v2\/downloads\//u, async () => {
        providerPolls += 1;
        if (providerPolls === 1) {
          providerPollStarted.resolve();
          await releaseProviderPoll.promise;
        }
        return HttpResponse.json({ status: "failed" });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);
    const request = {
      headers: authenticate(actor),
      body: {
        platform: "youtube" as const,
        url: "https://youtu.be/public-video",
        maxDuration: 60,
        quality: "720p" as const,
        format: "mp4" as const,
      },
    };

    const firstPromise = socialClient.createDownload(request);
    await providerStarted.promise;
    const blocked = await accept(socialClient.createDownload(request), [409]);
    releaseProvider.resolve();
    const first = await accept(firstPromise, [202]);

    expectApiError(blocked.body);
    expect(blocked.body.error).toStrictEqual({
      code: "DOWNLOAD_IN_PROGRESS",
      message: "Another social media download is already in progress",
    });
    expect(first.body.status).toBe("processing");
    expect(providerStarts).toBe(1);
    await providerPollStarted.promise;
    const blockedWhileProcessing = await accept(
      socialClient.createDownload(request),
      [409],
    );

    expectApiError(blockedWhileProcessing.body);
    expect(blockedWhileProcessing.body.error.code).toBe("DOWNLOAD_IN_PROGRESS");
    expect(providerStarts).toBe(1);

    releaseProviderPoll.resolve();
    await flushWaitUntilForTest();
    const next = await accept(socialClient.createDownload(request), [202]);

    expect(next.body.status).toBe("processing");
    expect(providerStarts).toBe(2);
    await flushWaitUntilForTest();
  });

  it("does not expose download state to another user", async () => {
    const owner = createBddApi(context).user();
    if (!owner.orgId) {
      throw new Error("Social test owner must belong to an organization");
    }
    const other = createBddApi(context).user({ orgId: owner.orgId });
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(owner);
    const providerJobId = `provider-owner-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "failed" });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);
    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(owner),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();

    const response = await accept(
      socialClient.getDownload({
        headers: authenticate(other),
        params: { downloadId: created.body.downloadId },
      }),
      [404],
    );

    expect(response.status).toBe(404);
    expectApiError(response.body);
  });

  it("keeps transient provider polling failures unbilled and retryable", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerJobId = `provider-transient-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json(
          { message: "temporary outage" },
          { status: 503 },
        );
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const pending = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(pending.body).toMatchObject({
      status: "processing",
      billing: null,
      error: { billed: false, retryable: true },
    });
    await flushWaitUntilForTest();
    await expect(credits(actor)).resolves.toBe(beforeCredits);

    mockNow(now() + 61_000);
    server.use(
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "failed" });
      }),
    );
    await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const terminal = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    expect(terminal.body.status).toBe("provider_failed");
  });

  it("defers a claimed download when its reconciliation budget expires", async () => {
    const actor = createBddApi(context).user();
    const reconciliation = new AbortController();
    const abortError = new DOMException(
      "SocialKit reconciliation timed out",
      "TimeoutError",
    );
    let suppliedReconciliationSignal = false;
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      if (milliseconds === 280_000 && !suppliedReconciliationSignal) {
        suppliedReconciliationSignal = true;
        return reconciliation.signal;
      }
      return undefined;
    });
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerJobId = `provider-timeout-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        reconciliation.abort(abortError);
        return HttpResponse.json({
          jobId: providerJobId,
          status: "processing",
        });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await expect(flushWaitUntilForTest()).rejects.toBe(abortError);
    const deferred = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(deferred.body).toMatchObject({
      status: "processing",
      billing: null,
      error: {
        code: "SOCIALKIT_RECONCILIATION_FAILED",
        billed: false,
        retryable: true,
      },
    });
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it("reconciles an expired claimed download through the bounded cron batch", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const payload = new TextEncoder().encode("cron-reconciled social video");
    const providerJobId = `provider-cron-${randomUUID()}`;
    let providerReady = false;
    context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        if (!providerReady) {
          return HttpResponse.json(
            { message: "temporary outage" },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          jobId: providerJobId,
          status: "ready",
          platform: "youtube",
          downloadUrl: "https://media.socialkit.test/cron-download",
          durationSeconds: 60,
          fileSizeMB: 1,
          creditsCost: 1,
          quality: "720p",
          format: "mp4",
        });
      }),
      http.get("https://media.socialkit.test/cron-download", () => {
        return new HttpResponse(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      }),
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: "socialkit-cron-upload" });
      }
      if (command instanceof UploadPartCommand) {
        return Promise.resolve({ ETag: '"socialkit-cron-etag"' });
      }
      return Promise.resolve({});
    });
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const blocked = await reconcileSocialKitDownloadsForTest(
      context,
      [created.body.downloadId],
      pricing.resolution,
    );
    providerReady = true;
    mockNow(now() + 61_000);

    const processed = await reconcileSocialKitDownloadsForTest(
      context,
      [created.body.downloadId],
      pricing.resolution,
    );
    const completed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(blocked).toBe(0);
    expect(processed).toBe(1);
    expect(completed.body).toMatchObject({
      status: "completed",
      billing: { quantity: 1, creditsCharged: 3 },
      artifact: { sizeBytes: payload.byteLength },
    });
    expect(beforeCredits - (await credits(actor))).toBe(3);
  });

  it("reuses a completed multipart result and bills concurrent retries once", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const payload = new TextEncoder().encode("retryable social video");
    const providerJobId = `provider-retry-${randomUUID()}`;
    let providerStarts = 0;
    let multipartAttempts = 0;
    let artifactStored = false;
    const createdDownload: { id?: string } = {};
    context.mocks.dns.lookupOverrides.set("media.socialkit.test", [
      { address: "8.8.8.8", family: 4 },
    ]);
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        providerStarts += 1;
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "ready",
          platform: "youtube",
          downloadUrl: "https://media.socialkit.test/retry-download",
          durationSeconds: 61,
          fileSizeMB: 1,
          creditsCost: 2,
          quality: "720p",
          format: "mp4",
          title: { untrusted: true },
          thumbnail: "https://media.socialkit.test/retry-download#preview",
        });
      }),
      http.get("https://media.socialkit.test/retry-download", () => {
        return new HttpResponse(payload, {
          headers: { "content-length": String(payload.byteLength) },
        });
      }),
    );
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        if (!artifactStored) {
          const error = new Error("Artifact not found");
          error.name = "NotFound";
          return Promise.reject(error);
        }
        const createdDownloadId = createdDownload.id;
        if (!createdDownloadId) {
          return Promise.reject(new Error("Missing created download id"));
        }
        const filename = `download-${createdDownloadId.slice(0, 8)}.mp4`;
        const key = buildArtifactKeyV2(
          createdDownloadId,
          filename,
          "socialkit",
        );
        if (command.input.Key !== key) {
          return Promise.reject(new Error("Unexpected artifact key"));
        }
        return Promise.resolve({
          ContentLength: payload.byteLength,
          ContentType: "video/mp4",
          LastModified: new Date("2026-08-27T00:00:00.000Z"),
          Metadata: {
            "artifact-id": createdDownloadId,
            filename: encodeURIComponent(filename),
            "user-id": encodeURIComponent(actor.userId),
            "public-brand": "vm0",
          },
        });
      }
      if (command instanceof CreateMultipartUploadCommand) {
        multipartAttempts += 1;
        return Promise.resolve({
          UploadId: `socialkit-retry-${multipartAttempts}`,
        });
      }
      if (command instanceof UploadPartCommand) {
        return Promise.resolve({ ETag: '"socialkit-retry-etag"' });
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        artifactStored = true;
        return Promise.reject(new Error("R2 completion response was lost"));
      }
      return Promise.resolve({});
    });
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    createdDownload.id = created.body.downloadId;
    await flushWaitUntilForTest();
    const failed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    const creditsAfterFailure = await credits(actor);

    expect(failed.body).toMatchObject({
      status: "artifact_failed",
      billing: { quantity: 2, creditsCharged: 6 },
      error: { billed: true, retryable: true },
    });
    expect(failed.body.provider).not.toHaveProperty("title");
    expect(failed.body.provider).not.toHaveProperty("thumbnail");
    expect(beforeCredits - creditsAfterFailure).toBe(6);
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        return command instanceof AbortMultipartUploadCommand;
      }),
    ).toBeTruthy();
    const blocked = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/another-public-video",
          maxDuration: 120,
          quality: "720p",
          format: "mp4",
        },
      }),
      [409],
    );

    expectApiError(blocked.body);
    expect(blocked.body.error.code).toBe("DOWNLOAD_IN_PROGRESS");
    expect(providerStarts).toBe(1);

    mockNow(now() + 61_000);
    await Promise.all([
      accept(
        socialClient.getDownload({
          headers: authenticate(actor),
          params: { downloadId: created.body.downloadId },
        }),
        [200],
      ),
      accept(
        socialClient.getDownload({
          headers: authenticate(actor),
          params: { downloadId: created.body.downloadId },
        }),
        [200],
      ),
    ]);
    await flushWaitUntilForTest();
    const completed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(completed.body.status).toBe("completed");
    expect(providerStarts).toBe(1);
    expect(multipartAttempts).toBe(1);
    await expect(credits(actor)).resolves.toBe(creditsAfterFailure);
  });

  it("preserves bounded provider download diagnostics", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerJobId = `provider-failed-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/tiktok/download`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "queued",
        });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "failed",
          errorCode: "duration_limit_exceeded",
          error: "Video exceeds the max_duration=60s limit",
          retryable: false,
          downloadUrl: "https://temporary.socialkit.test/private-video",
          accessKey: "test-socialkit-key",
        });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "tiktok",
          url: "https://www.tiktok.com/@public/video/1",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const failed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(failed.body).toMatchObject({
      status: "provider_failed",
      billing: null,
      error: {
        code: "SOCIALKIT_PROVIDER_duration_limit_exceeded",
        message: "Video exceeds the max_duration=60s limit",
        billed: false,
        retryable: false,
      },
    });
    expect(JSON.stringify(failed.body)).not.toContain("downloadUrl");
    expect(JSON.stringify(failed.body)).not.toContain("test-socialkit-key");
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });

  it.each([
    {
      caseName: "legacy failure without diagnostics",
      providerFailure: {
        status: "failed",
      },
      expectedCode: "SOCIALKIT_DOWNLOAD_FAILED",
    },
    {
      caseName: "malformed provider code",
      providerFailure: {
        status: "failed",
        errorCode: "invalid provider code",
        error: "The provider could not prepare the download",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_DOWNLOAD_FAILED",
    },
    {
      caseName: "oversized provider code",
      providerFailure: {
        status: "failed",
        errorCode: "x".repeat(129),
        error: "The provider could not prepare the download",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_DOWNLOAD_FAILED",
    },
    {
      caseName: "oversized provider message",
      providerFailure: {
        status: "failed",
        errorCode: "oversized_failure",
        error: "x".repeat(501),
        retryable: false,
      },
      expectedCode: "SOCIALKIT_DOWNLOAD_FAILED",
    },
    {
      caseName: "provider URL",
      providerFailure: {
        status: "failed",
        errorCode: "private_failure",
        error: "Download failed at https://temporary.socialkit.test/file",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_PROVIDER_private_failure",
    },
    {
      caseName: "configured provider credential",
      providerFailure: {
        status: "failed",
        errorCode: "credential_failure",
        error: "Provider failed with test-socialkit-key",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_PROVIDER_credential_failure",
    },
    {
      caseName: "credential assignment",
      providerFailure: {
        status: "failed",
        errorCode: "authorization_failure",
        error: "Authorization: Bearer different-provider-secret",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_PROVIDER_authorization_failure",
    },
    {
      caseName: "stack frame",
      providerFailure: {
        status: "failed",
        errorCode: "stack_failure",
        error: "Provider failed at worker (/srv/provider.js:1:2)",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_PROVIDER_stack_failure",
    },
    {
      caseName: "ASCII multiline provider message",
      providerFailure: {
        status: "failed",
        errorCode: "multiline_failure",
        error: "Provider failure\nwith hidden next line",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_PROVIDER_multiline_failure",
    },
    {
      caseName: "C1 control provider message",
      providerFailure: {
        status: "failed",
        errorCode: "control_failure",
        error: "Provider failure\u0085with hidden next line",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_PROVIDER_control_failure",
    },
    {
      caseName: "unicode multiline provider message",
      providerFailure: {
        status: "failed",
        errorCode: "multiline_failure",
        error: "Provider failure\u2028with hidden next line",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_PROVIDER_multiline_failure",
    },
    {
      caseName: "unicode paragraph separator provider message",
      providerFailure: {
        status: "failed",
        errorCode: "multiline_failure",
        error: "Provider failure\u2029with hidden next line",
        retryable: false,
      },
      expectedCode: "SOCIALKIT_PROVIDER_multiline_failure",
    },
  ])(
    "uses a safe fallback for $caseName",
    async ({ providerFailure, expectedCode }) => {
      const actor = createBddApi(context).user();
      configureProvider();
      const pricing = await setupConfiguredPricing();
      await fundActor(actor);
      const beforeCredits = await credits(actor);
      const providerJobId = `provider-safe-fallback-${randomUUID()}`;
      server.use(
        http.post(`${SOCIALKIT_BASE}/v2/tiktok/download`, () => {
          return HttpResponse.json({
            jobId: providerJobId,
            status: "queued",
          });
        }),
        http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
          return HttpResponse.json({
            jobId: providerJobId,
            ...providerFailure,
          });
        }),
      );
      const socialClient = client(pricing.resolution)(socialContract);

      const created = await accept(
        socialClient.createDownload({
          headers: authenticate(actor),
          body: {
            platform: "tiktok",
            url: "https://www.tiktok.com/@public/video/1",
            maxDuration: 60,
            quality: "720p",
            format: "mp4",
          },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const failed = await accept(
        socialClient.getDownload({
          headers: authenticate(actor),
          params: { downloadId: created.body.downloadId },
        }),
        [200],
      );

      expect(failed.body).toMatchObject({
        status: "provider_failed",
        billing: null,
        error: {
          code: expectedCode,
          message: "SocialKit could not prepare the download",
          billed: false,
          retryable: false,
        },
      });
      const serialized = JSON.stringify(failed.body);
      expect(serialized).not.toContain("temporary.socialkit.test");
      expect(serialized).not.toContain("test-socialkit-key");
      expect(serialized).not.toContain("provider.js");
      await expect(credits(actor)).resolves.toBe(beforeCredits);
    },
  );

  it("rejects a ready response for a different platform without billing", async () => {
    const actor = createBddApi(context).user();
    configureProvider();
    const pricing = await setupConfiguredPricing();
    await fundActor(actor);
    const beforeCredits = await credits(actor);
    const providerJobId = `provider-platform-${randomUUID()}`;
    server.use(
      http.post(`${SOCIALKIT_BASE}/v2/youtube/download`, () => {
        return HttpResponse.json({ jobId: providerJobId, status: "queued" });
      }),
      http.get(`${SOCIALKIT_BASE}/v2/downloads/${providerJobId}`, () => {
        return HttpResponse.json({
          jobId: providerJobId,
          status: "ready",
          platform: "facebook",
          downloadUrl: "https://media.socialkit.test/wrong-platform",
          durationSeconds: 60,
          fileSizeMB: "1 MB",
          creditsCost: 1,
          quality: "720p",
          format: "mp4",
        });
      }),
    );
    const socialClient = client(pricing.resolution)(socialContract);

    const created = await accept(
      socialClient.createDownload({
        headers: authenticate(actor),
        body: {
          platform: "youtube",
          url: "https://youtu.be/public-video",
          maxDuration: 60,
          quality: "720p",
          format: "mp4",
        },
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const failed = await accept(
      socialClient.getDownload({
        headers: authenticate(actor),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );

    expect(failed.body).toMatchObject({
      status: "provider_failed",
      billing: null,
      error: {
        code: "SOCIALKIT_INVALID_DOWNLOAD_RESPONSE",
        billed: false,
        retryable: false,
      },
    });
    await expect(credits(actor)).resolves.toBe(beforeCredits);
  });
});
