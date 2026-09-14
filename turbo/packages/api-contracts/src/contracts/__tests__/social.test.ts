import { describe, expect, expectTypeOf, it } from "vitest";

import {
  managedSocialKitToolCatalog,
  MANAGED_SOCIAL_UNSUPPORTED_CAPABILITIES,
  MANAGED_SOCIALKIT_TOOLS,
  projectPublicSocialResponse,
  publicSocialErrorCode,
  publicSocialErrorMessage,
  redactSocialProviderIdentity,
  socialKitErrorSchema,
  socialKitRequestSchema,
  socialKitResponseSchema,
  SOCIALKIT_TRANSCRIPT_ERROR_CODES,
  type SocialKitInput,
} from "../social";

describe("managed SocialKit contract", () => {
  it("publishes one typed input and output schema per reviewed tool", () => {
    const catalog = managedSocialKitToolCatalog();

    expect(catalog).toHaveLength(38);
    expect(
      new Set(
        catalog.map((tool) => {
          return tool.name;
        }),
      ).size,
    ).toBe(38);
    expect(MANAGED_SOCIALKIT_TOOLS).toHaveLength(38);
    expect(
      catalog.find((tool) => {
        return tool.name === "youtube_search";
      }),
    ).toMatchObject({
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cache: { type: "boolean" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          results: {
            type: "array",
            items: {
              properties: {
                title: { type: "string" },
                views: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    });
    expect(
      MANAGED_SOCIALKIT_TOOLS.find((tool) => {
        return tool.name === "tiktok_comments";
      })?.collection,
    ).toMatchObject({
      resultField: "comments",
      reportedTotalField: "commentCount",
    });
    const transcriptTools = catalog.filter((tool) => {
      return tool.name.endsWith("_transcript");
    });
    expect(transcriptTools).toHaveLength(6);
    expect(
      transcriptTools.every((tool) => {
        return tool.availability === "transcript";
      }),
    ).toBe(true);
    expect(
      catalog.find((tool) => {
        return tool.name === "youtube_transcript";
      }),
    ).toMatchObject({ availability: "transcript" });
  });

  it("publishes reviewed TikTok collection constraints and capability boundaries", () => {
    const catalog = managedSocialKitToolCatalog();

    expect(
      catalog.find((tool) => {
        return tool.name === "tiktok_search";
      }),
    ).toMatchObject({
      collection: {
        resultField: "results",
        retrieval: { kind: "cursor" },
        defaultLimit: 10,
        requestMaxLimit: 100,
        effectiveLimit: 10,
        itemContract: "tiktok_video",
        pageSize: {
          kind: "provider_controlled",
          mayDifferFromRequestLimit: true,
        },
        emptyResult: {
          reliability: "unreliable",
          outcome: "provider_limited",
          retry: "none",
          billing: "successful_request",
        },
      },
      billing: {
        kind: "items",
        itemsPerUnit: 50,
        quantityBasis: "effective_request_limit",
      },
      outputSchema: {
        properties: {
          results: {
            items: {
              properties: {
                videoId: { type: "string" },
                description: { type: "string" },
                thumbnail: { type: "string" },
                views: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    });
    expect(
      catalog.find((tool) => {
        return tool.name === "tiktok_hashtag_search";
      })?.collection,
    ).toMatchObject({ defaultLimit: 20, effectiveLimit: 20 });
    expect(
      catalog.find((tool) => {
        return tool.name === "tiktok_channel_videos";
      })?.collection,
    ).toMatchObject({ defaultLimit: 30, effectiveLimit: 30 });
    expect(MANAGED_SOCIAL_UNSUPPORTED_CAPABILITIES).toStrictEqual([
      expect.objectContaining({ capability: "follower_list" }),
      expect.objectContaining({ capability: "following_list" }),
      expect.objectContaining({ capability: "comment_replies" }),
    ]);
    expect(
      JSON.stringify({
        tools: catalog,
        unsupportedCapabilities: MANAGED_SOCIAL_UNSUPPORTED_CAPABILITIES,
      }),
    ).not.toMatch(/socialkit/iu);
  });

  it("projects TikTok collections to stable provider-neutral video fields", () => {
    const rawSearch = socialKitResponseSchema.parse({
      provider: "socialkit",
      tool: "tiktok_search",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: {
        state: "more",
        itemsReturned: 1,
        nextInput: { cursor: "next" },
      },
      result: {
        query: "launch",
        results: [
          {
            id: "video-1",
            desc: "Launch day",
            url: "https://www.tiktok.com/@example/video/1",
            createTime: 1_700_000_000,
            textLanguage: "en",
            subtitleInfos: [{ languageCode: "eng-US", title: "English" }],
            author: {
              id: "author-1",
              uniqueId: "example",
              nickname: "Example",
              avatar: "https://example.com/avatar.jpg",
              verified: true,
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
        hasMore: true,
        cursor: "next",
      },
    });

    const projection = projectPublicSocialResponse(rawSearch);
    expect(projection.ok).toBe(true);
    if (!projection.ok || projection.response.tool !== "tiktok_search") {
      throw new Error("Expected a projected TikTok search response");
    }
    expect(projection.response).not.toHaveProperty("provider");
    expect(projection.response.result.results?.[0]).toMatchObject({
      videoId: "video-1",
      description: "Launch day",
      url: "https://www.tiktok.com/@example/video/1",
      thumbnail: "https://example.com/cover.jpg",
      duration: 12,
      publishedAt: "2023-11-14T22:13:20.000Z",
      views: 100,
      likes: 20,
      comments: 3,
      shares: 4,
      collects: 5,
      language: "en",
      subtitles: [{ languageCode: "eng-US", title: "English" }],
      author: {
        id: "author-1",
        username: "example",
        displayName: "Example",
      },
    });
    expect(projection.response.result.results?.[0]).not.toHaveProperty(
      "providerName",
    );
    expect(JSON.stringify(projection.response)).not.toMatch(/socialkit/iu);

    const rawChannel = socialKitResponseSchema.parse({
      provider: "socialkit",
      tool: "tiktok_channel_videos",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: { state: "complete", itemsReturned: 1 },
      result: {
        results: [
          {
            videoId: "video-2",
            description: "Channel video",
            url: "https://www.tiktok.com/@example/video/2",
            thumbnail: "https://example.com/channel.jpg",
            duration: 9,
            createTime: "2026-08-31T00:00:00Z",
            views: 9,
          },
        ],
        hasMore: false,
        cursor: null,
      },
    });
    const channelProjection = projectPublicSocialResponse(rawChannel);
    expect(channelProjection.ok).toBe(true);
    if (
      !channelProjection.ok ||
      channelProjection.response.tool !== "tiktok_channel_videos"
    ) {
      throw new Error("Expected a projected TikTok channel response");
    }
    expect(channelProjection.response.result.results?.[0]).toMatchObject({
      videoId: "video-2",
      description: "Channel video",
      publishedAt: "2026-08-31T00:00:00Z",
    });
  });

  it("marks unreliable empty searches uncertain and rejects conflicting aliases", () => {
    const emptyResponse = socialKitResponseSchema.parse({
      provider: "socialkit",
      tool: "tiktok_hashtag_search",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: { state: "complete", itemsReturned: 0 },
      result: {
        hashtag: "launch",
        results: [],
        hasMore: false,
        cursor: null,
      },
    });
    const emptyProjection = projectPublicSocialResponse(emptyResponse);
    expect(emptyProjection).toMatchObject({
      ok: true,
      response: {
        collection: {
          state: "provider_limited",
          itemsReturned: 0,
          uncertainty: { reason: "unreliable_empty_result" },
        },
      },
    });

    const conflictingResponse = socialKitResponseSchema.parse({
      provider: "socialkit",
      tool: "tiktok_search",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: { state: "complete", itemsReturned: 1 },
      result: {
        results: [
          {
            id: "source-id",
            videoId: "contradictory-id",
            desc: "Result",
          },
        ],
        hasMore: false,
        cursor: null,
      },
    });
    expect(projectPublicSocialResponse(conflictingResponse)).toStrictEqual({
      ok: false,
    });
  });

  it("validates additive transcript error semantics", () => {
    for (const reason of [
      "transcript_unavailable",
      "availability_unknown",
      "access_denied",
    ] as const) {
      expect(
        socialKitErrorSchema.safeParse({
          error: {
            message: "stable message",
            code: "SOCIALKIT_TRANSCRIPT_ERROR",
            reason,
          },
        }).success,
      ).toBe(true);
    }
    expect(
      socialKitErrorSchema.safeParse({
        error: {
          message: "legacy message",
          code: "SOCIALKIT_CONTENT_UNAVAILABLE",
        },
      }).success,
    ).toBe(true);
    expect(
      socialKitErrorSchema.safeParse({
        error: {
          message: "invalid reason",
          code: SOCIALKIT_TRANSCRIPT_ERROR_CODES.AVAILABILITY_UNKNOWN,
          reason: "no_speech",
        },
      }).success,
    ).toBe(false);
  });

  it("projects provider diagnostics to provider-neutral values", () => {
    expect(publicSocialErrorCode("SOCIALKIT_TRANSCRIPT_UNAVAILABLE")).toBe(
      "SOCIAL_TRANSCRIPT_UNAVAILABLE",
    );
    expect(publicSocialErrorCode("SOCIALKIT_PROVIDER_timeout")).toBe(
      "SOCIAL_PROVIDER_timeout",
    );
    expect(publicSocialErrorMessage("SocialKit request failed")).toBe(
      "Okou Social request failed",
    );
    expect(
      publicSocialErrorMessage("Okou SocialKit provider is not configured"),
    ).toBe("Okou Social provider is not configured");
    expect(
      publicSocialErrorMessage("request failed at https://api.socialkit.dev"),
    ).toBe("request failed at the social data service");
  });

  it("removes provider identity extensions without rewriting social content", () => {
    expect(
      redactSocialProviderIdentity({
        provider: "socialkit",
        providerName: "SocialKit",
        nested: {
          providerCode: "socialkit",
          items: [{ upstreamProvider: "socialkit" }],
        },
        source: { provider: "youtube" },
        transcript: "This post compares SocialKit with another service.",
      }),
    ).toStrictEqual({
      nested: { items: [{}] },
      source: { provider: "youtube" },
      transcript: "This post compares SocialKit with another service.",
    });
  });

  it.each([
    {
      tool: "linkedin_profile",
      input: { url: "https://linkedin.com/in/example" },
      result: { headline: "Engineer", followers: 10 },
    },
    {
      tool: "twitter_tweets",
      input: { url: "https://x.com/example", cache: false },
      result: { tweets: [{ text: "Hello" }], nextCursor: null },
    },
    {
      tool: "facebook_comments",
      input: { url: "https://facebook.com/example/posts/1", limit: 10 },
      result: { comments: [{ text: "Hello", user: { name: "A" } }] },
    },
    {
      tool: "instagram_reels_search",
      input: { query: "launch", page: 2 },
      result: { items: [{ author: { username: "example" } }] },
    },
    {
      tool: "tiktok_hashtag_search",
      input: { hashtag: "launch" },
      result: { results: [{ stats: { shares: 10 } }] },
    },
    {
      tool: "youtube_search",
      input: { query: "launch" },
      result: { results: [{ title: "Launch", views: 10 }] },
    },
  ])(
    "validates representative $tool input and output",
    ({ tool, input, result }) => {
      expect(
        socialKitRequestSchema.safeParse({ tool, input }).success,
      ).toBeTruthy();
      expect(
        socialKitResponseSchema.safeParse({
          provider: "socialkit",
          tool,
          billingCategory: "request",
          billingQuantity: 1,
          creditsCharged: 3,
          collection: null,
          result,
        }).success,
      ).toBeTruthy();
    },
  );

  it.each([
    { billingQuantity: 0, creditsCharged: 0 },
    { billingQuantity: 1, creditsCharged: 3 },
  ])(
    "preserves billing $billingQuantity across response projections",
    (billing) => {
      const responseWithProvider = socialKitResponseSchema.parse({
        provider: "socialkit",
        tool: "youtube_summarize",
        billingCategory: "request",
        ...billing,
        collection: null,
        result: { summary: "A summary" },
      });
      expect(responseWithProvider.provider).toBe("socialkit");

      const responseWithoutProvider = socialKitResponseSchema.parse({
        tool: "youtube_summarize",
        billingCategory: "request",
        ...billing,
        collection: null,
        result: { summary: "A summary" },
      });
      expect(responseWithoutProvider).not.toHaveProperty("provider");
      expect(responseWithoutProvider).toMatchObject({
        ...billing,
        result: { summary: "A summary" },
      });
      expect(projectPublicSocialResponse(responseWithProvider)).toStrictEqual({
        ok: true,
        response: responseWithoutProvider,
      });
      expect(
        projectPublicSocialResponse(responseWithoutProvider),
      ).toStrictEqual({
        ok: true,
        response: responseWithoutProvider,
      });
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid billing quantity %s",
    (billingQuantity) => {
      expect(
        socialKitResponseSchema.safeParse({
          tool: "youtube_summarize",
          billingCategory: "request",
          billingQuantity,
          creditsCharged: 0,
          collection: null,
          result: { summary: "A summary" },
        }).success,
      ).toBe(false);
    },
  );

  it("validates real JSON scalar and enum input types", () => {
    const input: SocialKitInput<"youtube_search"> = {
      query: "typed tools",
      limit: 10,
      sortBy: "views",
      cache: false,
      cache_ttl: 3_600,
    };

    expect(
      socialKitRequestSchema.safeParse({ tool: "youtube_search", input })
        .success,
    ).toBeTruthy();
    expect(
      socialKitRequestSchema.safeParse({
        tool: "youtube_search",
        input: { query: "typed tools", limit: "10" },
      }).success,
    ).toBeFalsy();
    expect(
      socialKitRequestSchema.safeParse({
        tool: "youtube_transcript",
        input: { query: "wrong input family" },
      }).success,
    ).toBeFalsy();
  });

  it("narrows standard result fields and preserves JSON extensions", () => {
    const response = socialKitResponseSchema.parse({
      provider: "socialkit",
      tool: "youtube_search",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: { state: "provider_limited", itemsReturned: 1 },
      result: {
        query: "typed tools",
        results: [
          {
            videoId: "video-1",
            title: "Typed result",
            views: 10,
            providerRanking: 0.98,
          },
        ],
        providerTrace: { source: "search" },
      },
    });

    if (response.tool !== "youtube_search") {
      throw new Error("Expected a narrowed YouTube search response");
    }
    const title: string | undefined = response.result.results?.[0]?.title;
    expectTypeOf(title).toEqualTypeOf<string | undefined>();
    expect(title).toBe("Typed result");
    expect(response.result.results?.[0]?.providerRanking).toBe(0.98);
    expect(response.result.providerTrace).toStrictEqual({ source: "search" });
  });

  it("rejects incompatible values for documented output fields", () => {
    expect(
      socialKitResponseSchema.safeParse({
        provider: "socialkit",
        tool: "youtube_search",
        billingCategory: "request",
        billingQuantity: 1,
        creditsCharged: 3,
        collection: { state: "provider_limited", itemsReturned: 1 },
        result: {
          results: [{ title: "Typed result", views: "ten" }],
        },
      }).success,
    ).toBeFalsy();
  });

  it("validates additive collection evidence and rejects unsafe relationships", () => {
    const base = {
      provider: "socialkit",
      tool: "tiktok_comments",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      result: { comments: [{ id: "comment-1" }], commentCount: 100 },
    } as const;

    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "more",
          itemsReturned: 1,
          reportedTotal: 100,
          nextInput: { cursor: "next" },
        },
      }).success,
    ).toBeTruthy();
    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "provider_limited",
          itemsReturned: 1,
          reason: "reported_total_exceeds_page",
          reportedTotal: 100,
        },
      }).success,
    ).toBeTruthy();
    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "provider_limited",
          itemsReturned: 1,
          reason: "not-a-reason",
        },
      }).success,
    ).toBeFalsy();
    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "complete",
          itemsReturned: 1,
          reportedTotal: -1,
        },
      }).success,
    ).toBeFalsy();
    expect(
      socialKitResponseSchema.safeParse({
        ...base,
        collection: {
          state: "complete",
          itemsReturned: 1,
          reportedTotal: Number.MAX_SAFE_INTEGER + 1,
        },
      }).success,
    ).toBeFalsy();
  });

  it("preserves dynamic custom summary fields beside typed standards", () => {
    const response = socialKitResponseSchema.parse({
      provider: "socialkit",
      tool: "youtube_summarize",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: null,
      result: {
        summary: "A typed standard summary",
        title: "Caller-defined title",
        isMusic: true,
      },
    });

    if (response.tool !== "youtube_summarize") {
      throw new Error("Expected a narrowed YouTube summary response");
    }
    const summary: string | undefined = response.result.summary;
    expect(summary).toBe("A typed standard summary");
    expect(response.result.title).toBe("Caller-defined title");
    expect(response.result.isMusic).toBeTruthy();
  });
});
