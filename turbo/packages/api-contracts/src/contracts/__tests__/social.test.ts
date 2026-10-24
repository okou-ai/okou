import { describe, expect, it } from "vitest";

import {
  projectPublicSocialResponse,
  publicSocialErrorCode,
  publicSocialErrorMessage,
  redactSocialProviderIdentity,
  socialKitResponseSchema,
} from "../social";

describe("Social Router response projection", () => {
  it.each([0, 3, 12])(
    "preserves canonical Instagram source limits for %s items",
    (count) => {
      const response = socialKitResponseSchema.parse({
        tool: "instagram_reels_search",
        billingCategory: "request",
        billingQuantity: 1,
        creditsCharged: 3,
        collection: {
          state: "provider_limited",
          itemsReturned: count,
          reason: "provider_ceiling",
          sourceLimit: { kind: "single_batch", maxItems: 12 },
        },
        result: {
          items: Array.from({ length: count }, (_, id) => {
            return { id: String(id) };
          }),
          count,
          hasMore: false,
        },
      });
      const projected = projectPublicSocialResponse(response);

      expect(projected).toStrictEqual({
        ok: true,
        response,
      });
    },
  );

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

  it("marks unreliable empty searches uncertain", () => {
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
});
