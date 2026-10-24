import { z } from "zod";

export const SOCIALKIT_MAX_INPUT_VALUE_CHARS = 4_096;

export interface ManagedSocialKitToolDefinition<
  Name extends string = string,
  InputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: Name;
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

function urlInput() {
  return z
    .object({
      url: urlSchema,
    })
    .strict();
}

function urlCollectionInput(maxLimit: number) {
  return z
    .object({
      url: urlSchema,
      limit: z.number().int().min(1).max(maxLimit).optional(),
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
    url: urlSchema,
    custom_response: socialKitSummaryFieldsSchema.optional(),
    custom_prompt: inputStringSchema.optional(),
  })
  .strict();

export const MANAGED_SOCIALKIT_TOOLS = [
  defineTool({
    name: "linkedin_profile",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "linkedin_company",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "linkedin_company_posts",
    inputSchema: urlCollectionInput(50),
  }),
  defineTool({
    name: "linkedin_post",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "linkedin_transcript",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "twitter_profile",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "twitter_tweets",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "twitter_tweet",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "twitter_thread",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "twitter_transcript",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "facebook_stats",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "facebook_channel_stats",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "facebook_transcript",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "facebook_comments",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "facebook_summarize",
    inputSchema: summaryInputSchema,
  }),
  defineTool({
    name: "instagram_stats",
    inputSchema: urlInput().extend({
      requireViews: z.boolean().optional(),
    }),
  }),
  defineTool({
    name: "instagram_channel_stats",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "instagram_transcript",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "instagram_comments",
    inputSchema: z
      .object({
        url: urlSchema,
        limit: z.number().int().min(1).max(100).optional(),
        sortBy: z.enum(["popular", "recent"]).optional(),
      })
      .strict(),
  }),
  defineTool({
    name: "instagram_channel_posts",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "instagram_channel_reels",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "instagram_reels_search",
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
      })
      .strict(),
  }),
  defineTool({
    name: "instagram_summarize",
    inputSchema: summaryInputSchema,
  }),
  defineTool({
    name: "tiktok_stats",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "tiktok_comments",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "tiktok_transcript",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "tiktok_channel_stats",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "tiktok_channel_videos",
    inputSchema: urlCollectionInput(100),
  }),
  defineTool({
    name: "tiktok_search",
    inputSchema: z
      .object({
        query: inputStringSchema,
        limit: z.number().int().min(1).max(100).optional(),
        sortBy: z.enum(["relevance", "likes", "date"]).optional(),
        datePosted: z
          .enum(["day", "week", "month", "3months", "6months"])
          .optional(),
      })
      .strict(),
  }),
  defineTool({
    name: "tiktok_hashtag_search",
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
      })
      .strict(),
  }),
  defineTool({
    name: "tiktok_summarize",
    inputSchema: summaryInputSchema,
  }),
  defineTool({
    name: "youtube_transcript",
    inputSchema: urlInput().extend({
      no_cache: z.boolean().optional(),
    }),
  }),
  defineTool({
    name: "youtube_stats",
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "youtube_comments",
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
    inputSchema: urlInput(),
  }),
  defineTool({
    name: "youtube_search",
    inputSchema: z
      .object({
        query: inputStringSchema,
        limit: z.number().int().min(1).max(100).optional(),
        sortBy: z.enum(["relevance", "date", "views", "rating"]).optional(),
        uploadDate: z
          .enum(["hour", "today", "week", "month", "year"])
          .optional(),
        type: z.enum(["video", "shorts"]).optional(),
      })
      .strict(),
  }),
  defineTool({
    name: "youtube_videos",
    inputSchema: z
      .object({
        url: urlSchema,
        limit: z.number().int().min(1).max(100).optional(),
        full_details: z.boolean().optional(),
      })
      .strict(),
  }),
  defineTool({
    name: "youtube_summarize",
    inputSchema: summaryInputSchema.extend({
      no_cache: z.boolean().optional(),
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
