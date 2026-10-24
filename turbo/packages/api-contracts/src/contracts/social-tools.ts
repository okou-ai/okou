import { z } from "zod";

export const SOCIALKIT_MAX_INPUT_VALUE_CHARS = 4_096;
export const MANAGED_SOCIALKIT_BILLING_CATEGORY = "request";

export const socialKitTranscriptErrorReasonSchema = z.enum([
  "transcript_unavailable",
  "availability_unknown",
  "access_denied",
]);

export type ManagedSocialKitResultField =
  "comments" | "items" | "posts" | "results" | "tweets";

export type ManagedSocialKitPagination =
  | { readonly kind: "cursor" }
  | { readonly kind: "next_cursor" }
  | { readonly kind: "none" }
  | { readonly kind: "page"; readonly maxPage: number };

export interface ManagedSocialKitUnreliableEmptyResult {
  readonly reliability: "unreliable";
}

export interface ManagedSocialKitProviderControlledPageSize {
  readonly kind: "provider_controlled";
}

export interface ManagedSocialKitPublicResult {
  readonly kind: "tiktok_video_collection";
}

export const socialKitCollectionSourceLimitSchema = z
  .object({
    kind: z.literal("single_batch"),
    maxItems: z.number().int().positive(),
  })
  .strict();

export type SocialKitCollectionSourceLimit = z.infer<
  typeof socialKitCollectionSourceLimitSchema
>;

export interface ManagedSocialKitCollection {
  readonly resultField: ManagedSocialKitResultField;
  readonly defaultLimit?: number;
  readonly effectiveLimit?: number;
  readonly pagination: ManagedSocialKitPagination;
  readonly emptyResult?: ManagedSocialKitUnreliableEmptyResult;
  readonly pageSize?: ManagedSocialKitProviderControlledPageSize;
  readonly sourceLimit?: SocialKitCollectionSourceLimit;
}

export interface ManagedSocialKitToolDefinition<
  Name extends string = string,
  InputSchema extends z.ZodType = z.ZodType,
  ResultSchema extends z.ZodType = z.ZodType,
> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly resultSchema: ResultSchema;
  readonly maxLimit?: number;
  readonly collection?: ManagedSocialKitCollection;
  readonly publicResult?: ManagedSocialKitPublicResult;
}

function defineTool<
  const Name extends string,
  InputSchema extends z.ZodType,
  ResultSchema extends z.ZodType,
>(
  definition: ManagedSocialKitToolDefinition<Name, InputSchema, ResultSchema>,
): ManagedSocialKitToolDefinition<Name, InputSchema, ResultSchema> {
  return definition;
}

function hasNoEmbeddedCredentials(value: string): boolean {
  const url = new URL(value);
  return !url.username && !url.password;
}

const inputStringSchema = z
  .string()
  .min(1)
  .max(SOCIALKIT_MAX_INPUT_VALUE_CHARS);
const urlSchema = z
  .url({ protocol: /^https?$/ })
  .min(1)
  .max(SOCIALKIT_MAX_INPUT_VALUE_CHARS)
  .refine(hasNoEmbeddedCredentials, {
    message: "url must be an HTTP(S) URL without embedded credentials",
  });
const cursorInputSchema = inputStringSchema;
const cacheInputShape = {
  cache: z
    .boolean()
    .optional()
    .describe("Whether the provider may cache the result"),
  cache_ttl: z
    .number()
    .int()
    .min(3_600)
    .max(2_592_000)
    .optional()
    .describe("Cache lifetime in seconds"),
};

function urlInput() {
  return z
    .object({
      url: urlSchema.describe("Public social content URL"),
      ...cacheInputShape,
    })
    .strict();
}

function urlCollectionInput(maxLimit: number) {
  return z
    .object({
      url: urlSchema.describe("Public social content or profile URL"),
      limit: z.number().int().min(1).max(maxLimit).optional(),
      cursor: cursorInputSchema.optional(),
    })
    .strict();
}

function cachedUrlCollectionInput(maxLimit: number) {
  return z
    .object({
      url: urlSchema.describe("Public social content or profile URL"),
      limit: z.number().int().min(1).max(maxLimit).optional(),
      cursor: cursorInputSchema.optional(),
      ...cacheInputShape,
    })
    .strict();
}

export const socialKitSummaryFieldsSchema = z
  .record(z.string().min(1).max(64), inputStringSchema)
  .refine(
    (value) => {
      return JSON.stringify(value).length <= SOCIALKIT_MAX_INPUT_VALUE_CHARS;
    },
    { message: "custom_response is too large" },
  );

const summaryInputSchema = z
  .object({
    url: urlSchema.describe("Public social video URL to summarize"),
    custom_response: z
      .union([inputStringSchema, socialKitSummaryFieldsSchema])
      .optional()
      .describe("Custom response fields, as instructions or a field map"),
    custom_prompt: inputStringSchema
      .optional()
      .describe("Additional instructions for the summary"),
    ...cacheInputShape,
  })
  .strict();

function providerObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).partial().catchall(z.json());
}

const countSchema = z.number().int().nonnegative();
const metricSchema = z.number().nonnegative();
const paginationCursorResultSchema = z.union([
  z.string(),
  z.number().int().nonnegative(),
]);

const transcriptSegmentSchema = providerObject({
  text: z.string(),
  start: metricSchema,
  duration: metricSchema,
  timestamp: z.string(),
});

const transcriptResultShape = {
  transcript: z.string(),
  transcriptSegments: z.array(transcriptSegmentSchema),
  wordCount: countSchema,
  segments: countSchema,
  language: z.string(),
};

const videoTranscriptResultSchema = providerObject({
  url: z.string(),
  videoId: z.string(),
  ...transcriptResultShape,
});

const facebookTranscriptResultSchema = providerObject({
  postUrl: z.string(),
  ...transcriptResultShape,
});

const linkedinTranscriptResultSchema = providerObject({
  transcript: z.string(),
  transcriptSegments: z.array(transcriptSegmentSchema),
  wordCount: countSchema,
});

const summaryResultSchema = providerObject({
  url: z.string(),
  summary: z.string(),
  mainTopics: z.array(z.string()),
  keyPoints: z.array(z.string()),
  tone: z.string(),
  targetAudience: z.string(),
  quotes: z.array(z.string()),
});

const tiktokSummaryResultSchema = summaryResultSchema.extend({
  summarySource: z.enum(["transcript", "visual"]).optional(),
});

const linkedinAuthorSchema = providerObject({
  name: z.string(),
  headline: z.string(),
  profileUrl: z.string(),
});

const linkedinPostSchema = providerObject({
  id: z.string(),
  text: z.string(),
  likes: countSchema,
  comments: countSchema,
  shares: countSchema,
  imageUrl: z.string(),
  images: z.array(z.string()),
  videoUrl: z.string(),
  publishedAt: z.string(),
  author: linkedinAuthorSchema,
});

const linkedinProfileResultSchema = providerObject({
  url: z.string(),
  name: z.string(),
  headline: z.string(),
  followers: countSchema,
  connections: z.string(),
  profileImage: z.string(),
  recentArticles: z.array(
    providerObject({
      title: z.string(),
      url: z.string(),
      date: z.string(),
    }),
  ),
});

const linkedinCompanyResultSchema = providerObject({
  url: z.string(),
  name: z.string(),
  description: z.string(),
  followers: countSchema,
  employees: z.string(),
  logo: z.string(),
});

const linkedinCompanyPostsResultSchema = providerObject({
  posts: z.array(linkedinPostSchema),
});

const linkedinPostResultSchema = providerObject({
  post: linkedinPostSchema,
});

const twitterAuthorSchema = providerObject({
  name: z.string(),
  headline: z.string(),
  profileUrl: z.string(),
});

const tweetSchema = providerObject({
  id: z.string(),
  text: z.string(),
  likes: countSchema,
  retweets: countSchema,
  replies: countSchema,
  views: countSchema,
  createdAt: z.string(),
  author: twitterAuthorSchema,
  hashtags: z.array(z.string()),
  urls: z.array(z.string()),
});

const twitterProfileResultSchema = providerObject({
  url: z.string(),
  id: z.string(),
  name: z.string(),
  username: z.string(),
  bio: z.string(),
  followers: countSchema,
  following: countSchema,
  tweets: countSchema,
  verified: z.boolean(),
  profileImage: z.string(),
  bannerImage: z.string(),
  location: z.string(),
  website: z.string(),
  joinedAt: z.string(),
});

const twitterTweetsResultSchema = providerObject({
  tweets: z.array(tweetSchema),
  nextCursor: paginationCursorResultSchema.nullable(),
});

const twitterTweetResultSchema = providerObject({ tweet: tweetSchema });

const twitterThreadResultSchema = providerObject({
  conversationId: z.string(),
  tweetCount: countSchema,
  isThread: z.boolean(),
  combinedText: z.string(),
  author: providerObject({}),
  tweets: z.array(providerObject({})),
});

const facebookReactionSchema = providerObject({
  name: z.string(),
  count: countSchema,
  formatted: z.string(),
});

const facebookStatsResultSchema = providerObject({
  postUrl: z.string(),
  id: z.string(),
  description: z.string(),
  views: countSchema,
  likes: countSchema,
  comments: countSchema,
  shares: countSchema,
  reactions: z.array(facebookReactionSchema),
  author: z.string(),
  authorLink: z.string(),
  isVideo: z.boolean(),
});

const facebookChannelStatsResultSchema = providerObject({
  profileUrl: z.string(),
  id: z.string(),
  fullName: z.string(),
  bio: z.string(),
  avatar: z.string(),
  coverPhoto: z.string(),
  verified: z.boolean(),
  followers: countSchema,
  category: z.string(),
});

const facebookCommentUserSchema = providerObject({
  id: z.string(),
  name: z.string(),
  profileUrl: z.string(),
  profilePicUrl: z.string(),
});

const facebookCommentSchema = providerObject({
  id: z.string(),
  text: z.string(),
  likeCount: countSchema,
  replyCount: countSchema,
  user: facebookCommentUserSchema,
});

const facebookCommentsResultSchema = providerObject({
  postUrl: z.string(),
  comments: z.array(facebookCommentSchema),
  commentCount: countSchema,
  hasMore: z.boolean(),
  cursor: paginationCursorResultSchema.nullable(),
});

const instagramStatsResultSchema = providerObject({
  postUrl: z.string(),
  id: z.string(),
  shortcode: z.string(),
  title: z.string(),
  description: z.string(),
  views: countSchema.nullable(),
  likes: countSchema,
  comments: countSchema,
  shares: countSchema.nullable(),
  publishedAt: z.string(),
  author: z.string(),
  authorLink: z.string(),
  duration: z.string().nullable(),
  thumbnail: z.string(),
  isVideo: z.boolean(),
  contentType: z.string(),
});

export const socialKitInstagramCommentsOutcomeSchema = z
  .object({
    collectionStatus: z.enum(["partial", "exhausted", "unknown"]),
    stopReason: z.enum([
      "requested_limit",
      "upstream_exhausted",
      "repeated_cursor",
      "no_progress",
      "page_limit",
      "unknown",
    ]),
  })
  .strict();

export type SocialKitInstagramCommentsOutcome = z.infer<
  typeof socialKitInstagramCommentsOutcomeSchema
>;

const instagramChannelStatsResultSchema = providerObject({
  profileUrl: z.string(),
  userId: z.string(),
  username: z.string(),
  fullName: z.string(),
  verified: z.boolean(),
  followers: countSchema,
  following: countSchema,
  totalPosts: countSchema,
  bio: z.string(),
  avatar: z.string(),
});

const instagramAuthorSchema = providerObject({
  id: z.string(),
  username: z.string(),
  fullName: z.string(),
  isVerified: z.boolean(),
  profilePicUrl: z.string(),
});

const instagramCommentSchema = providerObject({
  id: z.string(),
  text: z.string(),
  likeCount: countSchema,
  replyCount: countSchema,
  user: instagramAuthorSchema,
});

const instagramCommentsResultSchema = providerObject({
  postUrl: z.string(),
  comments: z.array(instagramCommentSchema),
  commentCount: countSchema.nullable(),
  ...socialKitInstagramCommentsOutcomeSchema.shape,
  hasMore: z.boolean(),
  cursor: paginationCursorResultSchema.nullable(),
});

const instagramPostSchema = providerObject({
  id: z.string(),
  shortcode: z.string(),
  url: z.string(),
  type: z.string(),
  caption: z.string(),
  likes: countSchema,
  comments: countSchema,
  views: countSchema,
  timestamp: countSchema,
  thumbnailUrl: z.string(),
  author: instagramAuthorSchema,
});

const instagramReelSchema = providerObject({
  id: z.string(),
  shortcode: z.string(),
  url: z.string(),
  caption: z.string(),
  likes: countSchema,
  comments: countSchema,
  views: countSchema,
  duration: metricSchema,
  thumbnailUrl: z.string(),
  author: instagramAuthorSchema,
});

function instagramFeedResult<ItemSchema extends z.ZodType>(
  itemSchema: ItemSchema,
) {
  return providerObject({
    profileUrl: z.string(),
    username: z.string(),
    items: z.array(itemSchema),
    count: countSchema,
    hasMore: z.boolean(),
    cursor: paginationCursorResultSchema.nullable(),
  });
}

const instagramReelsSearchItemSchema = providerObject({
  id: z.string(),
  url: z.string(),
  caption: z.string(),
  likes: countSchema,
  comments: countSchema,
  views: countSchema,
  author: instagramAuthorSchema,
});

const instagramReelsSearchResultSchema = providerObject({
  query: z.string(),
  items: z.array(instagramReelsSearchItemSchema),
  count: countSchema,
  hasMore: z.boolean(),
}).required({ hasMore: true });

const tiktokStatsResultSchema = providerObject({
  url: z.string(),
  videoId: z.string(),
  title: z.string(),
  channelName: z.string(),
  channelLink: z.string(),
  likes: countSchema,
  comments: countSchema,
  collects: countSchema,
  shares: countSchema,
  views: countSchema,
  description: z.string(),
  duration: z.string(),
  thumbnailUrl: z.string(),
  publishedAt: z.string(),
  contentType: z.string(),
  isShortForm: z.boolean(),
});

const tiktokCommentSchema = providerObject({
  id: z.string(),
  author: z.string(),
  username: z.string(),
  text: z.string(),
  likes: countSchema,
  avatar: z.string(),
  createTime: z.string(),
  replyCount: countSchema,
});

const tiktokCommentsResultSchema = providerObject({
  videoId: z.string(),
  comments: z.array(tiktokCommentSchema),
  commentCount: countSchema,
  hasMore: z.boolean(),
  cursor: paginationCursorResultSchema.nullable(),
});

const tiktokChannelStatsResultSchema = providerObject({
  profileUrl: z.string(),
  username: z.string(),
  nickname: z.string(),
  signature: z.string(),
  verified: z.boolean(),
  avatar: z.string(),
  followers: countSchema,
  following: countSchema,
  totalLikes: countSchema,
  totalVideos: countSchema,
  bioLink: z.string(),
});

const tiktokChannelVideoSchema = providerObject({
  videoId: z.string(),
  description: z.string(),
  url: z.string(),
  thumbnail: z.string(),
  duration: metricSchema,
  createTime: z.string(),
  views: countSchema,
  likes: countSchema,
  comments: countSchema,
  shares: countSchema,
  collects: countSchema,
});

const tiktokChannelVideosResultSchema = providerObject({
  profileUrl: z.string(),
  channelName: z.string(),
  results: z.array(tiktokChannelVideoSchema),
  hasMore: z.boolean(),
  cursor: paginationCursorResultSchema.nullable(),
});

const tiktokAuthorSchema = providerObject({
  id: z.string(),
  uniqueId: z.string(),
  nickname: z.string(),
  avatar: z.string(),
  verified: z.boolean(),
});

const tiktokVideoStatsSchema = providerObject({
  views: countSchema,
  likes: countSchema,
  comments: countSchema,
  shares: countSchema,
  saves: countSchema,
});

const tiktokSearchItemShape = {
  id: z.string(),
  desc: z.string(),
  url: z.string(),
  author: tiktokAuthorSchema,
  stats: tiktokVideoStatsSchema,
};

const tiktokSearchItemSchema = providerObject({
  ...tiktokSearchItemShape,
  createTime: countSchema,
});

const tiktokHashtagSearchItemSchema = providerObject(tiktokSearchItemShape);

const tiktokSearchResultSchema = providerObject({
  query: z.string(),
  results: z.array(tiktokSearchItemSchema),
  hasMore: z.boolean(),
  cursor: paginationCursorResultSchema.nullable(),
});

const tiktokHashtagSearchResultSchema = providerObject({
  hashtag: z.string(),
  results: z.array(tiktokHashtagSearchItemSchema),
  hasMore: z.boolean(),
  cursor: paginationCursorResultSchema.nullable(),
});

const youtubeStatsResultSchema = providerObject({
  url: z.string(),
  videoId: z.string(),
  title: z.string(),
  description: z.string(),
  channelName: z.string(),
  channelLink: z.string(),
  channelHandle: z.string(),
  views: countSchema,
  likes: countSchema,
  comments: countSchema,
  duration: z.string(),
  publishedAt: z.string(),
  thumbnailUrl: z.string(),
  contentType: z.string(),
  isShortForm: z.boolean(),
});

const youtubeCommentSchema = providerObject({
  author: z.string(),
  text: z.string(),
  likes: countSchema,
  date: z.string(),
  avatar: z.string(),
  replyCount: countSchema,
  position: countSchema,
});

const youtubeCommentsResultSchema = providerObject({
  url: z.string(),
  comments: z.array(youtubeCommentSchema),
});

const youtubeChannelStatsResultSchema = providerObject({
  profileUrl: z.string(),
  username: z.string(),
  nickname: z.string(),
  bio: z.string(),
  verified: z.boolean(),
  avatar: z.string(),
  subscribers: countSchema,
  totalVideos: countSchema,
  bioLink: z.string(),
  banner: z.string(),
});

const youtubeSearchItemSchema = providerObject({
  videoId: z.string(),
  title: z.string(),
  thumbnail: z.string(),
  channelName: z.string(),
  channelId: z.string(),
  channelUrl: z.string(),
  publishedTime: z.string(),
  duration: z.string(),
  views: countSchema,
  viewsFormatted: z.string(),
  description: z.string(),
  url: z.string(),
  verified: z.boolean(),
});

const youtubeSearchResultSchema = providerObject({
  query: z.string(),
  results: z.array(youtubeSearchItemSchema),
});

const youtubeVideoSchema = providerObject({
  videoId: z.string(),
  title: z.string(),
  thumbnail: z.string(),
  channelName: z.string(),
  duration: z.string(),
  views: countSchema,
  viewsFormatted: z.string(),
  publishedTime: z.string(),
  publishedAt: z.string().nullable(),
  description: z.string(),
  url: z.string(),
});

const youtubeVideosResultSchema = providerObject({
  type: z.enum(["channel", "playlist"]),
  url: z.string(),
  results: z.array(youtubeVideoSchema),
});

export const MANAGED_SOCIALKIT_TOOLS = [
  defineTool({
    name: "linkedin_profile",
    description: "Get public profile details for a LinkedIn member.",
    inputSchema: urlInput(),
    resultSchema: linkedinProfileResultSchema,
  }),
  defineTool({
    name: "linkedin_company",
    description: "Get public profile details for a LinkedIn company.",
    inputSchema: urlInput(),
    resultSchema: linkedinCompanyResultSchema,
  }),
  defineTool({
    name: "linkedin_company_posts",
    description: "List recent public posts from a LinkedIn company.",
    inputSchema: z
      .object({
        url: urlSchema,
        limit: z.number().int().min(1).max(50).optional(),
        ...cacheInputShape,
      })
      .strict(),
    resultSchema: linkedinCompanyPostsResultSchema,
    maxLimit: 50,
    collection: {
      resultField: "posts",
      defaultLimit: 10,
      pagination: { kind: "none" },
    },
  }),
  defineTool({
    name: "linkedin_post",
    description: "Get one public LinkedIn post.",
    inputSchema: urlInput(),
    resultSchema: linkedinPostResultSchema,
  }),
  defineTool({
    name: "linkedin_transcript",
    description: "Extract the transcript from a LinkedIn video post.",
    inputSchema: urlInput(),
    resultSchema: linkedinTranscriptResultSchema,
  }),
  defineTool({
    name: "twitter_profile",
    description: "Get public profile details for an X/Twitter account.",
    inputSchema: urlInput(),
    resultSchema: twitterProfileResultSchema,
  }),
  defineTool({
    name: "twitter_tweets",
    description: "List public tweets from an X/Twitter account.",
    inputSchema: cachedUrlCollectionInput(100),
    resultSchema: twitterTweetsResultSchema,
    maxLimit: 100,
    collection: {
      resultField: "tweets",
      defaultLimit: 20,
      pagination: { kind: "next_cursor" },
    },
  }),
  defineTool({
    name: "twitter_tweet",
    description: "Get one public X/Twitter post.",
    inputSchema: urlInput(),
    resultSchema: twitterTweetResultSchema,
  }),
  defineTool({
    name: "twitter_thread",
    description: "Get a public X/Twitter thread and its combined text.",
    inputSchema: urlInput(),
    resultSchema: twitterThreadResultSchema,
  }),
  defineTool({
    name: "twitter_transcript",
    description: "Extract the transcript from an X/Twitter video post.",
    inputSchema: urlInput(),
    resultSchema: videoTranscriptResultSchema,
  }),
  defineTool({
    name: "facebook_stats",
    description: "Get engagement statistics for a public Facebook post.",
    inputSchema: urlInput(),
    resultSchema: facebookStatsResultSchema,
  }),
  defineTool({
    name: "facebook_channel_stats",
    description: "Get public profile statistics for a Facebook page.",
    inputSchema: urlInput(),
    resultSchema: facebookChannelStatsResultSchema,
  }),
  defineTool({
    name: "facebook_transcript",
    description: "Extract the transcript from a Facebook video post.",
    inputSchema: urlInput(),
    resultSchema: facebookTranscriptResultSchema,
  }),
  defineTool({
    name: "facebook_comments",
    description: "List comments on a public Facebook post.",
    inputSchema: urlCollectionInput(100),
    resultSchema: facebookCommentsResultSchema,
    maxLimit: 100,
    collection: {
      resultField: "comments",
      defaultLimit: 10,
      pagination: { kind: "cursor" },
    },
  }),
  defineTool({
    name: "facebook_summarize",
    description: "Summarize a public Facebook video post.",
    inputSchema: summaryInputSchema,
    resultSchema: summaryResultSchema,
  }),
  defineTool({
    name: "instagram_stats",
    description: "Get engagement statistics for a public Instagram post.",
    inputSchema: urlInput().extend({
      requireViews: z
        .boolean()
        .optional()
        .describe(
          "Require verified video views; unavailable views fail without a charge",
        ),
    }),
    resultSchema: instagramStatsResultSchema,
  }),
  defineTool({
    name: "instagram_channel_stats",
    description: "Get public profile statistics for an Instagram account.",
    inputSchema: urlInput(),
    resultSchema: instagramChannelStatsResultSchema,
  }),
  defineTool({
    name: "instagram_transcript",
    description: "Extract the transcript from an Instagram video post.",
    inputSchema: urlInput(),
    resultSchema: videoTranscriptResultSchema,
  }),
  defineTool({
    name: "instagram_comments",
    description: "List comments on a public Instagram post.",
    inputSchema: z
      .object({
        url: urlSchema,
        limit: z.number().int().min(1).max(100).optional(),
        cursor: cursorInputSchema.optional(),
        sortBy: z.enum(["popular", "recent"]).optional(),
      })
      .strict(),
    resultSchema: instagramCommentsResultSchema,
    maxLimit: 100,
    collection: {
      resultField: "comments",
      defaultLimit: 10,
      pagination: { kind: "cursor" },
    },
  }),
  defineTool({
    name: "instagram_channel_posts",
    description: "List public posts from an Instagram account.",
    inputSchema: urlCollectionInput(100),
    resultSchema: instagramFeedResult(instagramPostSchema),
    maxLimit: 100,
    collection: {
      resultField: "items",
      defaultLimit: 12,
      pagination: { kind: "cursor" },
    },
  }),
  defineTool({
    name: "instagram_channel_reels",
    description: "List public reels from an Instagram account.",
    inputSchema: urlCollectionInput(100),
    resultSchema: instagramFeedResult(instagramReelSchema),
    maxLimit: 100,
    collection: {
      resultField: "items",
      defaultLimit: 12,
      pagination: { kind: "cursor" },
    },
  }),
  defineTool({
    name: "instagram_reels_search",
    description:
      "Search public Instagram reels by keyword or hashtag in one anonymous batch of up to 12 results.",
    inputSchema: z
      .object({
        query: z
          .string()
          .trim()
          .max(100)
          .overwrite((query) => {
            // The provider folds case. Doing it here can expand Unicode input
            // beyond the bound before a CLI request is validated by the API.
            return query.replace(/\s/gu, "").replace(/^(?:#|%23)+/iu, "");
          })
          .min(1),
        page: z.literal(1).optional(),
      })
      .strict(),
    resultSchema: instagramReelsSearchResultSchema,
    collection: {
      resultField: "items",
      pagination: { kind: "none" },
      sourceLimit: { kind: "single_batch", maxItems: 12 },
    },
  }),
  defineTool({
    name: "instagram_summarize",
    description: "Summarize a public Instagram video post.",
    inputSchema: summaryInputSchema,
    resultSchema: summaryResultSchema,
  }),
  defineTool({
    name: "tiktok_stats",
    description: "Get engagement statistics for a public TikTok video.",
    inputSchema: urlInput(),
    resultSchema: tiktokStatsResultSchema,
  }),
  defineTool({
    name: "tiktok_comments",
    description: "List comments on a public TikTok video.",
    inputSchema: urlCollectionInput(100),
    resultSchema: tiktokCommentsResultSchema,
    maxLimit: 100,
    collection: {
      resultField: "comments",
      defaultLimit: 10,
      pagination: { kind: "cursor" },
    },
  }),
  defineTool({
    name: "tiktok_transcript",
    description: "Extract the transcript from a public TikTok video.",
    inputSchema: urlInput(),
    resultSchema: videoTranscriptResultSchema,
  }),
  defineTool({
    name: "tiktok_channel_stats",
    description: "Get public profile statistics for a TikTok account.",
    inputSchema: urlInput(),
    resultSchema: tiktokChannelStatsResultSchema,
  }),
  defineTool({
    name: "tiktok_channel_videos",
    description: "List recent public videos from a TikTok account.",
    inputSchema: cachedUrlCollectionInput(100),
    resultSchema: tiktokChannelVideosResultSchema,
    publicResult: {
      kind: "tiktok_video_collection",
    },
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 30,
      effectiveLimit: 30,
      pagination: { kind: "cursor" },
      pageSize: {
        kind: "provider_controlled",
      },
    },
  }),
  defineTool({
    name: "tiktok_search",
    description: "Search public TikTok videos by keyword.",
    inputSchema: z
      .object({
        query: inputStringSchema,
        limit: z.number().int().min(1).max(100).optional(),
        cursor: cursorInputSchema.optional(),
        sortBy: z.enum(["relevance", "likes", "date"]).optional(),
        datePosted: z
          .enum(["day", "week", "month", "3months", "6months"])
          .optional(),
        ...cacheInputShape,
      })
      .strict(),
    resultSchema: tiktokSearchResultSchema,
    publicResult: {
      kind: "tiktok_video_collection",
    },
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 10,
      effectiveLimit: 10,
      pagination: { kind: "cursor" },
      emptyResult: {
        reliability: "unreliable",
      },
      pageSize: {
        kind: "provider_controlled",
      },
    },
  }),
  defineTool({
    name: "tiktok_hashtag_search",
    description: "Search public TikTok videos by hashtag.",
    inputSchema: z
      .object({
        hashtag: inputStringSchema.refine(
          (value) => {
            return !value.startsWith("#");
          },
          {
            message: "hashtag must not include the # prefix",
          },
        ),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: cursorInputSchema.optional(),
        ...cacheInputShape,
      })
      .strict(),
    resultSchema: tiktokHashtagSearchResultSchema,
    publicResult: {
      kind: "tiktok_video_collection",
    },
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 20,
      effectiveLimit: 20,
      pagination: { kind: "cursor" },
      emptyResult: {
        reliability: "unreliable",
      },
      pageSize: {
        kind: "provider_controlled",
      },
    },
  }),
  defineTool({
    name: "tiktok_summarize",
    description: "Summarize a public TikTok video.",
    inputSchema: summaryInputSchema,
    resultSchema: tiktokSummaryResultSchema,
  }),
  defineTool({
    name: "youtube_transcript",
    description: "Extract the transcript from a public YouTube video.",
    inputSchema: urlInput().extend({
      no_cache: z
        .boolean()
        .optional()
        .describe(
          "Bypass YouTube extraction caches, including cached caption absence; captions may still be unavailable",
        ),
    }),
    resultSchema: videoTranscriptResultSchema,
  }),
  defineTool({
    name: "youtube_stats",
    description: "Get engagement statistics for a public YouTube video.",
    inputSchema: urlInput(),
    resultSchema: youtubeStatsResultSchema,
  }),
  defineTool({
    name: "youtube_comments",
    description: "List comments on a public YouTube video.",
    inputSchema: z
      .object({
        url: urlSchema,
        limit: z.number().int().min(1).max(100).optional(),
        sortBy: z.enum(["top", "new"]).optional(),
      })
      .strict(),
    resultSchema: youtubeCommentsResultSchema,
    maxLimit: 100,
    collection: {
      resultField: "comments",
      defaultLimit: 10,
      pagination: { kind: "none" },
    },
  }),
  defineTool({
    name: "youtube_channel_stats",
    description: "Get public statistics for a YouTube channel.",
    inputSchema: urlInput(),
    resultSchema: youtubeChannelStatsResultSchema,
  }),
  defineTool({
    name: "youtube_search",
    description: "Search public YouTube videos by keyword.",
    inputSchema: z
      .object({
        query: inputStringSchema,
        limit: z.number().int().min(1).max(100).optional(),
        sortBy: z.enum(["relevance", "date", "views", "rating"]).optional(),
        uploadDate: z
          .enum(["hour", "today", "week", "month", "year"])
          .optional(),
        type: z.enum(["video", "shorts"]).optional(),
        ...cacheInputShape,
      })
      .strict(),
    resultSchema: youtubeSearchResultSchema,
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 10,
      pagination: { kind: "none" },
    },
  }),
  defineTool({
    name: "youtube_videos",
    description: "List public videos from a YouTube channel or playlist.",
    inputSchema: z
      .object({
        url: urlSchema,
        limit: z.number().int().min(1).max(100).optional(),
        full_details: z.boolean().optional(),
        ...cacheInputShape,
      })
      .strict(),
    resultSchema: youtubeVideosResultSchema,
    maxLimit: 100,
    collection: {
      resultField: "results",
      defaultLimit: 10,
      pagination: { kind: "none" },
    },
  }),
  defineTool({
    name: "youtube_summarize",
    description: "Summarize a public YouTube video.",
    inputSchema: summaryInputSchema.extend({
      no_cache: z
        .boolean()
        .optional()
        .describe(
          "Bypass YouTube extraction caches, not the summary-result cache; combine with cache=false for a fresh summary. Captions may still be unavailable",
        ),
    }),
    resultSchema: summaryResultSchema,
  }),
] as const;

export type ManagedSocialKitTool = (typeof MANAGED_SOCIALKIT_TOOLS)[number];
export type ManagedSocialKitToolName = ManagedSocialKitTool["name"];

type SocialKitRequestFor<Tool extends ManagedSocialKitTool> =
  Tool extends ManagedSocialKitToolDefinition<
    infer Name,
    infer InputSchema,
    z.ZodType
  >
    ? { readonly tool: Name; readonly input: z.infer<InputSchema> }
    : never;

export type SocialKitRequest = SocialKitRequestFor<ManagedSocialKitTool>;

export function findManagedSocialKitTool(
  name: string,
): ManagedSocialKitTool | undefined {
  return MANAGED_SOCIALKIT_TOOLS.find((tool) => {
    return tool.name === name;
  });
}

function requestVariant<Tool extends ManagedSocialKitTool>(tool: Tool) {
  return z
    .object({
      tool: z.literal(tool.name),
      input: tool.inputSchema,
    })
    .strict();
}

type SocialKitRequestSchemaFor<Tool extends ManagedSocialKitTool> = z.ZodType<
  SocialKitRequestFor<Tool>
>;

type SocialKitRequestSchemas<Tools extends readonly ManagedSocialKitTool[]> = {
  readonly [Index in keyof Tools]: SocialKitRequestSchemaFor<Tools[Index]>;
};

function requestSchemas<
  const Tools extends readonly [
    ManagedSocialKitTool,
    ManagedSocialKitTool,
    ...ManagedSocialKitTool[],
  ],
>(tools: Tools): SocialKitRequestSchemas<Tools> {
  // Array.map cannot retain a const tuple's per-index generic relationship.
  return tools.map(requestVariant) as SocialKitRequestSchemas<Tools>;
}

export const socialKitRequestSchema = z.union(
  requestSchemas(MANAGED_SOCIALKIT_TOOLS),
);
