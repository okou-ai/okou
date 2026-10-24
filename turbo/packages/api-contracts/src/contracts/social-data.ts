import { z } from "zod";

export const SOCIAL_DATA_MAX_RESULTS = 1_000;

export const socialDataPlatformSchema = z.enum([
  "x",
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "xiaohongshu",
  "threads",
  "wechat",
  "douyin",
  "weibo",
]);

export const socialDataOperationSchema = z.enum([
  "inspect",
  "posts",
  "search",
  "comments",
  "transcript",
  "replies",
  "followers",
  "following",
]);

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const positiveInteger = safeInteger.min(1);

const publicUrl = z
  .url()
  .max(4_096)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.port
    );
  }, "Use a public HTTPS social URL without credentials or a port");

const socialDataInputSchema = z
  .object({
    operation: socialDataOperationSchema,
    platform: socialDataPlatformSchema,
    url: publicUrl.optional(),
    query: z.string().trim().min(1).max(1_000).optional(),
    limit: positiveInteger.max(SOCIAL_DATA_MAX_RESULTS).default(10),
    kind: z.enum(["posts", "reels"]).optional(),
    sort: z.string().trim().min(1).max(32).optional(),
    date: z.string().trim().min(1).max(64).optional(),
    type: z.enum(["video", "shorts", "article", "account", "post"]).optional(),
    commentId: z
      .string()
      .regex(/^\d{1,128}$/u)
      .optional(),
    hashtag: z.boolean().optional(),
    fullDetails: z.boolean().optional(),
    refresh: z.boolean().optional(),
    thread: z.boolean().optional(),
    requireViews: z.boolean().optional(),
    language: z
      .string()
      .regex(/^[a-z]{2}$/u)
      .optional(),
  })
  .strict();

function validateTarget(
  input: z.infer<typeof socialDataInputSchema>,
  context: z.RefinementCtx,
) {
  if ((input.operation === "replies") !== (input.commentId !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "commentId is required only for replies",
      path: ["commentId"],
    });
  }
  if (input.operation === "search") {
    if (input.query === undefined || input.url !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Search requires a query and does not accept a URL",
      });
    }
  } else if (input.url === undefined || input.query !== undefined) {
    context.addIssue({
      code: "custom",
      message: "This operation requires a URL and does not accept a query",
    });
  }
}

export const socialDataRequestSchema =
  socialDataInputSchema.superRefine(validateTarget);

export const socialDataCreateRequestSchema = socialDataInputSchema
  .extend({
    requestId: z.uuid(),
    maxCredits: positiveInteger.optional(),
  })
  .superRefine(validateTarget);

export const socialDataContinueRequestSchema = z
  .object({
    requestId: z.uuid(),
    maxCredits: positiveInteger.optional(),
  })
  .strict();

export type SocialDataContinueRequest = z.infer<
  typeof socialDataContinueRequestSchema
>;

export const socialDataListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

export type SocialDataPlatform = z.infer<typeof socialDataPlatformSchema>;

export type SocialDataOperation = z.infer<typeof socialDataOperationSchema>;

export type SocialDataRequest = z.infer<typeof socialDataRequestSchema>;

export type SocialDataCreateRequest = z.infer<
  typeof socialDataCreateRequestSchema
>;

export type SocialDataListQuery = z.infer<typeof socialDataListQuerySchema>;
