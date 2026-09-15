import { z } from "zod";

import type { ManagedSocialKitToolName } from "./social-tools";

export const socialPlatformSchema = z.enum([
  "linkedin",
  "twitter",
  "facebook",
  "instagram",
  "tiktok",
  "youtube",
]);

export type SocialPlatform = z.infer<typeof socialPlatformSchema>;

const socialOperationSchema = z.enum([
  "comments",
  "download",
  "inspect",
  "posts",
  "search",
  "summarize",
  "transcript",
]);

export type SocialOperation = z.infer<typeof socialOperationSchema>;

export const SOCIAL_DEFAULT_COLLECTION_LIMIT = 10;
export const SOCIAL_MAX_COLLECTION_PAGES = 100;
export const SOCIAL_INSTAGRAM_POST_KINDS = ["posts", "reels"] as const;

interface SocialOperationBinding {
  readonly operation: SocialOperation;
  readonly variant: string;
  readonly tool: ManagedSocialKitToolName | null;
  /** Only input fields actually exposed by the intent-oriented CLI. */
  readonly inputs: Readonly<Record<string, string>>;
}

function binding(
  tool: ManagedSocialKitToolName,
  operation: SocialOperation,
  variant: string,
  inputs: Readonly<Record<string, string>> = {},
): SocialOperationBinding {
  return { tool, operation, variant, inputs };
}

const download: SocialOperationBinding = {
  tool: null,
  operation: "download",
  variant: "video",
  inputs: {
    "--max-duration": "maxDuration",
    "--quality": "quality",
    "--format": "format",
  },
};

// This registry covers implemented CLI variants, not the upstream catalog.
// Add a binding together with its intent routing and command boundary coverage.
const bindings: Readonly<
  Record<SocialPlatform, readonly SocialOperationBinding[]>
> = {
  linkedin: [
    binding("linkedin_profile", "inspect", "profile"),
    binding("linkedin_company", "inspect", "company"),
    binding("linkedin_post", "inspect", "post"),
    binding("linkedin_company_posts", "posts", "company"),
    binding("linkedin_transcript", "transcript", "video"),
  ],
  twitter: [
    binding("twitter_profile", "inspect", "profile"),
    binding("twitter_tweet", "inspect", "post"),
    binding("twitter_thread", "inspect", "thread"),
    binding("twitter_tweets", "posts", "profile"),
    binding("twitter_transcript", "transcript", "video"),
  ],
  facebook: [
    binding("facebook_stats", "inspect", "post"),
    binding("facebook_channel_stats", "inspect", "channel"),
    binding("facebook_comments", "comments", "post"),
    binding("facebook_transcript", "transcript", "video"),
    binding("facebook_summarize", "summarize", "video", {
      "--prompt": "custom_prompt",
    }),
    download,
  ],
  instagram: [
    binding("instagram_stats", "inspect", "post", {
      "--require-views": "requireViews",
    }),
    binding("instagram_channel_stats", "inspect", "profile"),
    binding("instagram_comments", "comments", "post", { "--sort": "sortBy" }),
    binding("instagram_channel_posts", "posts", "posts"),
    binding("instagram_channel_reels", "posts", "reels"),
    binding("instagram_reels_search", "search", "keyword", {
      "<query>": "query",
    }),
    binding("instagram_transcript", "transcript", "video"),
    binding("instagram_summarize", "summarize", "video", {
      "--prompt": "custom_prompt",
    }),
    download,
  ],
  tiktok: [
    binding("tiktok_stats", "inspect", "video"),
    binding("tiktok_channel_stats", "inspect", "profile"),
    binding("tiktok_comments", "comments", "video"),
    binding("tiktok_channel_videos", "posts", "profile"),
    binding("tiktok_search", "search", "keyword", {
      "--sort": "sortBy",
      "--date": "datePosted",
    }),
    binding("tiktok_hashtag_search", "search", "hashtag"),
    binding("tiktok_transcript", "transcript", "video"),
    binding("tiktok_summarize", "summarize", "video", {
      "--prompt": "custom_prompt",
    }),
    download,
  ],
  youtube: [
    binding("youtube_stats", "inspect", "video"),
    binding("youtube_channel_stats", "inspect", "channel"),
    binding("youtube_comments", "comments", "video", { "--sort": "sortBy" }),
    binding("youtube_videos", "posts", "channel_or_playlist", {
      "--full-details": "full_details",
    }),
    binding("youtube_search", "search", "keyword", {
      "--sort": "sortBy",
      "--date": "uploadDate",
      "--type": "type",
    }),
    binding("youtube_transcript", "transcript", "video", {
      "--refresh": "no_cache",
    }),
    binding("youtube_summarize", "summarize", "video", {
      "--prompt": "custom_prompt",
      "--refresh": "no_cache",
    }),
    download,
  ],
};

export function socialOperationBindings(platform?: SocialPlatform) {
  const platforms = platform ? [platform] : socialPlatformSchema.options;
  return platforms.flatMap((selected) => {
    return bindings[selected].map((entry) => {
      return { platform: selected, ...entry };
    });
  });
}

const socialHealthSchema = z.enum([
  "healthy",
  "degraded",
  "unavailable",
  "unknown",
]);

const socialStatusReasonSchema = z.enum([
  "status_unavailable",
  "network_error",
  "invalid_response",
  "missing_entry",
  "duplicate_entry",
  "stale",
  "invalid_timestamp",
]);

const socialHealthObservationSchema = z.object({
  status: socialHealthSchema,
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  reason: socialStatusReasonSchema.nullable(),
});

export const socialStatusResponseSchema = z.object({
  observedAt: z.iso.datetime(),
  staleAfterSeconds: z.number().int().positive(),
  overall: socialHealthObservationSchema,
  operations: z.array(
    socialHealthObservationSchema.extend({
      platform: socialPlatformSchema,
      operation: socialOperationSchema,
      variant: z.string(),
    }),
  ),
});

export type SocialStatusResponse = z.infer<typeof socialStatusResponseSchema>;
