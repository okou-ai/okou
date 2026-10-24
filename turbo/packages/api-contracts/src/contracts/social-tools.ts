import { z } from "zod";

export const SOCIALKIT_MAX_INPUT_VALUE_CHARS = 4_096;

export interface ManagedSocialKitToolDefinition<
  Name extends string = string,
  InputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: Name;
  readonly description: string;
  readonly inputSchema: InputSchema;
}

function defineTool<const Name extends string, InputSchema extends z.ZodType>(
  definition: ManagedSocialKitToolDefinition<Name, InputSchema>,
): ManagedSocialKitToolDefinition<Name, InputSchema> {
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

export const MANAGED_SOCIALKIT_TOOLS = [
  defineTool({
    name: "linkedin_profile",
    description: "Get public profile details for a LinkedIn member.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "linkedin_company",
    description: "Get public profile details for a LinkedIn company.",
    inputSchema: urlInput(),
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
  }),
  defineTool({
    name: "linkedin_post",
    description: "Get one public LinkedIn post.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "linkedin_transcript",
    description: "Extract the transcript from a LinkedIn video post.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "twitter_profile",
    description: "Get public profile details for an X/Twitter account.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "twitter_tweets",
    description: "List public tweets from an X/Twitter account.",
    inputSchema: cachedUrlCollectionInput(100),
  }),
  defineTool({
    name: "twitter_tweet",
    description: "Get one public X/Twitter post.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "twitter_thread",
    description: "Get a public X/Twitter thread and its combined text.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "twitter_transcript",
    description: "Extract the transcript from an X/Twitter video post.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "facebook_stats",
    description: "Get engagement statistics for a public Facebook post.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "facebook_channel_stats",
    description: "Get public profile statistics for a Facebook page.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "facebook_transcript",
    description: "Extract the transcript from a Facebook video post.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "facebook_comments",
    description: "List comments on a public Facebook post.",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "facebook_summarize",
    description: "Summarize a public Facebook video post.",
    inputSchema: summaryInputSchema,
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
  }),
  defineTool({
    name: "instagram_channel_stats",
    description: "Get public profile statistics for an Instagram account.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "instagram_transcript",
    description: "Extract the transcript from an Instagram video post.",
    inputSchema: urlInput(),
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
  }),
  defineTool({
    name: "instagram_channel_posts",
    description: "List public posts from an Instagram account.",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "instagram_channel_reels",
    description: "List public reels from an Instagram account.",
    inputSchema: urlCollectionInput(100),
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
  }),
  defineTool({
    name: "instagram_summarize",
    description: "Summarize a public Instagram video post.",
    inputSchema: summaryInputSchema,
  }),
  defineTool({
    name: "tiktok_stats",
    description: "Get engagement statistics for a public TikTok video.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "tiktok_comments",
    description: "List comments on a public TikTok video.",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "tiktok_transcript",
    description: "Extract the transcript from a public TikTok video.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "tiktok_channel_stats",
    description: "Get public profile statistics for a TikTok account.",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "tiktok_channel_videos",
    description: "List recent public videos from a TikTok account.",
    inputSchema: cachedUrlCollectionInput(100),
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
  }),
  defineTool({
    name: "tiktok_summarize",
    description: "Summarize a public TikTok video.",
    inputSchema: summaryInputSchema,
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
  }),
  defineTool({
    name: "youtube_stats",
    description: "Get engagement statistics for a public YouTube video.",
    inputSchema: urlInput(),
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
  }),
  defineTool({
    name: "youtube_channel_stats",
    description: "Get public statistics for a YouTube channel.",
    inputSchema: urlInput(),
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
  }),
] as const;

export type ManagedSocialKitTool = (typeof MANAGED_SOCIALKIT_TOOLS)[number];
export type ManagedSocialKitToolName = ManagedSocialKitTool["name"];

type SocialKitRequestFor<Tool extends ManagedSocialKitTool> =
  Tool extends ManagedSocialKitToolDefinition<infer Name, infer InputSchema>
    ? { readonly tool: Name; readonly input: z.infer<InputSchema> }
    : never;

export type SocialKitRequest = SocialKitRequestFor<ManagedSocialKitTool>;

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
