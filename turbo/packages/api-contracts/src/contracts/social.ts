import { z } from "zod";

import {
  findManagedSocialKitTool,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIALKIT_TOOLS,
  socialKitTranscriptErrorReasonSchema,
  socialKitCollectionSourceLimitSchema,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolName,
  socialKitRequestSchema,
} from "./social-tools";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  socialPlatformSchema,
  socialStatusResponseSchema,
} from "./social-discovery";

export {
  findManagedSocialKitTool,
  managedSocialKitToolCatalog,
  MANAGED_SOCIALKIT_BILLING_CATEGORY,
  MANAGED_SOCIAL_UNSUPPORTED_CAPABILITIES,
  MANAGED_SOCIALKIT_TOOLS,
  SOCIALKIT_MAX_INPUT_VALUE_CHARS,
  SOCIALKIT_TRANSCRIPT_ERROR_CODES,
  socialKitTranscriptErrorReasonSchema,
  socialKitRequestSchema,
  socialKitSummaryFieldsSchema,
  type ManagedSocialKitCollection,
  type ManagedSocialKitCatalogBilling,
  type ManagedSocialKitCatalogProviderLimit,
  type ManagedSocialKitCatalogRetrieval,
  type ManagedSocialKitPagination,
  type ManagedSocialKitProviderControlledPageSize,
  type ManagedSocialKitPublicResult,
  type ManagedSocialKitReportedTotalField,
  type ManagedSocialKitResultField,
  type ManagedSocialKitUnreliableEmptyResult,
  type ManagedSocialKitTool,
  type ManagedSocialKitToolAvailability,
  type ManagedSocialKitToolDefinition,
  type ManagedSocialKitToolCatalogEntry,
  type ManagedSocialKitToolName,
  type ManagedSocialUnsupportedCapability,
  type SocialKitTranscriptErrorCode,
  type SocialKitTranscriptErrorReason,
  type SocialKitRequest,
  type SocialKitCollectionSourceLimit,
} from "./social-tools";

const c = initContract();

export const socialErrorReasonSchema = z.enum([
  ...socialKitTranscriptErrorReasonSchema.options,
  "content_restricted",
  "content_unavailable",
  "no_transcript",
  "transcript_not_ready",
  "media_not_ready",
  "upstream_failure",
  "rate_limited",
  "provider_quota_exhausted",
  "provider_authentication",
  "invalid_input",
]);

export type SocialErrorReason = z.infer<typeof socialErrorReasonSchema>;

export const socialRetryAfterSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647);

export const socialKitErrorSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    reason: socialErrorReasonSchema.optional(),
    retryable: z.boolean().optional(),
    retryAfterSeconds: socialRetryAfterSecondsSchema.optional(),
  }),
});

export type SocialKitErrorResponse = z.infer<typeof socialKitErrorSchema>;

/**
 * Keep upstream implementation details out of agent-visible diagnostics.
 *
 * The API still accepts and stores the internal provider codes for server-side
 * accounting and backwards-compatible handling. Callers that render data to
 * an agent should pass codes and messages through these projections first.
 */
export function publicSocialErrorCode(code: string): string {
  return code.replace(/socialkit/giu, "SOCIAL");
}

export function publicSocialErrorMessage(message: string): string {
  return message
    .replace(
      /\b(?:https?:\/\/)?(?:api\.)?socialkit\.dev\b/giu,
      "the social data service",
    )
    .replace(/\bokou\s+socialkit\b/giu, "Okou Social")
    .replace(/\bsocialkit\b/giu, "Okou Social");
}

const SOCIAL_PROVIDER_IDENTITY_KEYS = ["backend", "service", "source"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSocialProviderIdentityKey(key: string): boolean {
  const normalized = key.replace(/[\s_-]/gu, "").toLowerCase();
  return (
    normalized.includes("provider") ||
    normalized.includes("vendor") ||
    SOCIAL_PROVIDER_IDENTITY_KEYS.some((candidate) => {
      return candidate === normalized;
    })
  );
}

/**
 * Remove provider identity extensions from JSON-shaped agent output without
 * rewriting arbitrary social content that happens to mention the provider.
 */
export function redactSocialProviderIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSocialProviderIdentity);
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      isSocialProviderIdentityKey(key) &&
      typeof nested === "string" &&
      /socialkit(?:\.dev)?/iu.test(nested)
    ) {
      continue;
    }
    redacted[key] = redactSocialProviderIdentity(nested);
  }
  return redacted;
}

export const socialKitDownloadPlatformSchema = z.enum([
  "youtube",
  "tiktok",
  "instagram",
  "facebook",
]);

export const socialKitDownloadQualitySchema = z.enum([
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
]);

export const socialKitDownloadFormatSchema = z.enum(["mp4", "m4a", "mp3"]);

// Delivered resolutions include source renditions such as TikTok's 576p.
export const socialKitDownloadDeliveredQualitySchema = z
  .string()
  .regex(/^[1-9]\d{0,3}p$/u);

const socialKitDownloadArtifactFormatSchema = z.enum(["mp4", "m4a", "mp3"]);

export const socialKitDownloadRequestSchema = z
  .object({
    platform: socialKitDownloadPlatformSchema,
    url: z
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === ""
        );
      }, "URL must use HTTPS without embedded credentials"),
    maxDuration: z.number().int().positive().max(86_400),
    quality: socialKitDownloadQualitySchema.default("720p"),
    format: socialKitDownloadFormatSchema.default("mp4"),
  })
  .strict();

export const socialKitDownloadStatusSchema = z.enum([
  "queued",
  "processing",
  "materializing",
  "artifact_failed",
  "provider_failed",
  "completed",
]);

const socialKitDownloadProviderResultSchema = z.object({
  durationSeconds: z.number().int().nonnegative(),
  fileSizeMB: z.number().nonnegative(),
  creditsCost: z.number().int().positive(),
  quality: socialKitDownloadDeliveredQualitySchema.optional(),
  format: socialKitDownloadFormatSchema.optional(),
  title: z.string().max(1000).optional(),
  thumbnail: z.url().max(4096).optional(),
});

const socialKitDownloadArtifactSchema = z.object({
  id: z.string().uuid(),
  url: z.url(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  format: socialKitDownloadArtifactFormatSchema.nullable().optional(),
});

export const socialKitDownloadResponseSchema = z.object({
  downloadId: z.string().uuid(),
  status: socialKitDownloadStatusSchema,
  platform: socialKitDownloadPlatformSchema,
  // Retain the request aliases for already selected commit-addressed CLIs.
  quality: socialKitDownloadQualitySchema,
  format: socialKitDownloadFormatSchema,
  // Optional while older API artifacts remain supported rollout/rollback targets.
  requested: z
    .object({
      quality: socialKitDownloadQualitySchema,
      format: socialKitDownloadFormatSchema,
    })
    .optional(),
  delivered: z
    .object({
      quality: socialKitDownloadDeliveredQualitySchema.nullable(),
      format: socialKitDownloadArtifactFormatSchema.nullable(),
    })
    .optional(),
  maxDuration: z.number().int().positive(),
  billingCategory: z.literal(MANAGED_SOCIALKIT_BILLING_CATEGORY),
  provider: socialKitDownloadProviderResultSchema.nullable(),
  billing: z
    .object({
      quantity: z.number().int().positive(),
      creditsCharged: z.number().int().nonnegative(),
    })
    .nullable(),
  artifact: socialKitDownloadArtifactSchema.nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      billed: z.boolean(),
      reason: socialErrorReasonSchema.optional(),
      retryAfterSeconds: socialRetryAfterSecondsSchema.optional(),
      // A terminal job cannot resume; this advice applies to a new submission.
      resubmitRetryable: z.boolean().optional(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export type SocialKitDownloadRequest = z.infer<
  typeof socialKitDownloadRequestSchema
>;
export type SocialKitDownloadResponse = z.infer<
  typeof socialKitDownloadResponseSchema
>;

export const socialKitDownloadListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
  status: z
    .enum([...socialKitDownloadStatusSchema.options, "active"])
    .optional(),
});

export const socialKitDownloadListResponseSchema = z.object({
  downloads: z.array(
    socialKitDownloadResponseSchema.extend({
      request: socialKitDownloadRequestSchema,
      resumeCommand: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().uuid().nullable(),
});

export const socialKitDownloadConflictSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    recovery: z
      .object({
        downloadId: z.string().uuid(),
        resumeCommand: z.string(),
      })
      .optional(),
  }),
});

export type SocialKitDownloadListQuery = z.infer<
  typeof socialKitDownloadListQuerySchema
>;
export type SocialKitDownloadListResponse = z.infer<
  typeof socialKitDownloadListResponseSchema
>;

export const socialKitCollectionProviderLimitedReasonSchema = z.enum([
  "reported_total_exceeds_page",
  "provider_ceiling",
  "no_pagination",
]);

export type SocialKitCollectionProviderLimitedReason = z.infer<
  typeof socialKitCollectionProviderLimitedReasonSchema
>;

export const socialKitCollectionUncertaintySchema = z
  .object({ reason: z.literal("unreliable_empty_result") })
  .strict();

export type SocialKitCollectionUncertainty = z.infer<
  typeof socialKitCollectionUncertaintySchema
>;

const reportedTotalSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "reported total must be a safe integer");

const socialKitCollectionSchema = z
  .discriminatedUnion("state", [
    z.object({
      state: z.literal("more"),
      itemsReturned: z.number().int().nonnegative(),
      reportedTotal: reportedTotalSchema.optional(),
      nextInput: z.union([
        z.object({ cursor: z.string().min(1) }).strict(),
        z.object({ page: z.number().int().positive() }).strict(),
      ]),
    }),
    z.object({
      state: z.literal("complete"),
      itemsReturned: z.number().int().nonnegative(),
      reportedTotal: reportedTotalSchema.optional(),
    }),
    z.object({
      state: z.literal("provider_limited"),
      itemsReturned: z.number().int().nonnegative(),
      reason: socialKitCollectionProviderLimitedReasonSchema.optional(),
      uncertainty: socialKitCollectionUncertaintySchema.optional(),
      sourceLimit: socialKitCollectionSourceLimitSchema.optional(),
      reportedTotal: reportedTotalSchema.optional(),
    }),
  ])
  .nullable();

type ToolByName<Name extends ManagedSocialKitToolName> = Extract<
  ManagedSocialKitTool,
  { readonly name: Name }
>;

export type SocialKitInput<Name extends ManagedSocialKitToolName> = z.infer<
  ToolByName<Name>["inputSchema"]
>;

export type SocialKitResult<Name extends ManagedSocialKitToolName> = z.infer<
  ToolByName<Name>["resultSchema"]
>;

type SocialKitResponseFor<Tool extends ManagedSocialKitTool> =
  Tool extends ManagedSocialKitTool
    ? {
        /**
         * The provider discriminator is retained for session/API compatibility.
         * Agent-facing routes project it out before serialization.
         */
        readonly provider?: "socialkit";
        readonly tool: Tool["name"];
        readonly billingCategory: typeof MANAGED_SOCIALKIT_BILLING_CATEGORY;
        readonly billingQuantity: number;
        readonly creditsCharged: number;
        readonly collection: z.infer<typeof socialKitCollectionSchema>;
        readonly result: z.infer<Tool["resultSchema"]>;
      }
    : never;

export type SocialKitResponse = SocialKitResponseFor<ManagedSocialKitTool>;

function responseVariant<Tool extends ManagedSocialKitTool>(tool: Tool) {
  return z.object({
    // Optional so the agent boundary can remove the internal discriminator
    // while older session clients may continue sending/receiving it.
    provider: z.literal("socialkit").optional(),
    tool: z.literal(tool.name),
    billingCategory: z.literal(MANAGED_SOCIALKIT_BILLING_CATEGORY),
    billingQuantity: z.number().int().positive(),
    creditsCharged: z.number().int().nonnegative(),
    collection: socialKitCollectionSchema,
    result: tool.resultSchema,
  });
}

type SocialKitResponseSchemaFor<Tool extends ManagedSocialKitTool> = z.ZodType<
  SocialKitResponseFor<Tool>
>;

type SocialKitResponseSchemas<Tools extends readonly ManagedSocialKitTool[]> = {
  readonly [Index in keyof Tools]: SocialKitResponseSchemaFor<Tools[Index]>;
};

function responseSchemas<
  const Tools extends readonly [
    ManagedSocialKitTool,
    ManagedSocialKitTool,
    ...ManagedSocialKitTool[],
  ],
>(tools: Tools): SocialKitResponseSchemas<Tools> {
  // Array.map cannot retain a const tuple's per-index generic relationship.
  return tools.map(responseVariant) as SocialKitResponseSchemas<Tools>;
}

export const socialKitResponseSchema = z.union(
  responseSchemas(MANAGED_SOCIALKIT_TOOLS),
);

export type PublicSocialResponseProjection =
  | { readonly ok: true; readonly response: SocialKitResponse }
  | { readonly ok: false };

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addCanonicalAlias(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (value === undefined) {
    return true;
  }
  if (
    Object.prototype.hasOwnProperty.call(target, key) &&
    !jsonValuesEqual(target[key], value)
  ) {
    return false;
  }
  target[key] = value;
  return true;
}

function publicTikTokPublishedAt(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function projectPublicTikTokAuthor(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const author = { ...value };
  if (
    !addCanonicalAlias(author, "username", value.uniqueId) ||
    !addCanonicalAlias(author, "displayName", value.nickname)
  ) {
    return undefined;
  }
  return author;
}

function projectPublicTikTokVideoItem(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const item = { ...value };
  const stats = isRecord(value.stats) ? value.stats : undefined;
  const video = isRecord(value.video) ? value.video : undefined;
  const aliases: readonly (readonly [string, unknown])[] = [
    ["videoId", value.id],
    ["description", value.desc],
    ["thumbnail", video?.cover],
    ["duration", video?.duration],
    ["publishedAt", publicTikTokPublishedAt(value.createTime)],
    ["views", stats?.views],
    ["likes", stats?.likes],
    ["comments", stats?.comments],
    ["shares", stats?.shares],
    ["collects", stats?.saves],
    ["language", value.textLanguage],
    ["subtitles", value.subtitleInfos],
  ];
  for (const [key, alias] of aliases) {
    if (!addCanonicalAlias(item, key, alias)) {
      return undefined;
    }
  }
  if (value.author !== undefined) {
    const author = projectPublicTikTokAuthor(value.author);
    if (!author) {
      return undefined;
    }
    item.author = author;
  }
  return item;
}

function projectPublicTikTokVideoCollection(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return undefined;
  }
  const results: Record<string, unknown>[] = [];
  for (const item of value.results) {
    const projected = projectPublicTikTokVideoItem(item);
    if (!projected) {
      return undefined;
    }
    results.push(projected);
  }
  return { ...value, results };
}

/**
 * Build the permanent provider-neutral response used by agent, sandbox, and
 * CLI callers. Raw session/PAT responses remain unchanged.
 */
export function projectPublicSocialResponse(
  response: SocialKitResponse,
): PublicSocialResponseProjection {
  const tool = findManagedSocialKitTool(response.tool);
  if (!tool) {
    return { ok: false };
  }
  let result: unknown = response.result;
  if (tool.publicResult?.kind === "tiktok_video_collection") {
    result = projectPublicTikTokVideoCollection(result);
    if (!result) {
      return { ok: false };
    }
  }

  let collection = response.collection;
  // New CLI -> old API compatibility. Remove this projection once every serving
  // API and retained rollback target emits the fixed batch metadata (#34053).
  if (tool.collection?.sourceLimit && collection) {
    collection = {
      state: "provider_limited",
      itemsReturned: collection.itemsReturned,
      reason: "provider_ceiling",
      sourceLimit: tool.collection.sourceLimit,
    };
  }
  if (
    tool.collection?.emptyResult?.reliability === "unreliable" &&
    collection?.state === "complete" &&
    collection.itemsReturned === 0
  ) {
    collection = {
      state: "provider_limited",
      itemsReturned: 0,
      ...(collection.reportedTotal === undefined
        ? {}
        : { reportedTotal: collection.reportedTotal }),
      uncertainty: { reason: "unreliable_empty_result" },
    };
  }

  const publicValue = redactSocialProviderIdentity({
    tool: response.tool,
    billingCategory: response.billingCategory,
    billingQuantity: response.billingQuantity,
    creditsCharged: response.creditsCharged,
    collection,
    result,
  });
  const parsed = socialKitResponseSchema.safeParse(publicValue);
  return parsed.success
    ? { ok: true, response: parsed.data as SocialKitResponse }
    : { ok: false };
}

export const socialContract = c.router({
  status: {
    method: "GET",
    path: "/api/social/status",
    headers: authHeadersSchema,
    query: z.object({ platform: socialPlatformSchema.optional() }).strict(),
    responses: {
      200: socialStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get reported Social service health without billing",
  },
  request: {
    method: "POST",
    path: "/api/social/request",
    headers: authHeadersSchema,
    body: socialKitRequestSchema,
    responses: {
      200: socialKitResponseSchema,
      400: socialKitErrorSchema,
      401: socialKitErrorSchema,
      402: socialKitErrorSchema,
      403: socialKitErrorSchema,
      404: socialKitErrorSchema,
      422: socialKitErrorSchema,
      429: socialKitErrorSchema,
      502: socialKitErrorSchema,
      503: socialKitErrorSchema,
    },
    summary: "Call a typed Okou Social tool",
  },
  createDownload: {
    method: "POST",
    path: "/api/social/downloads",
    headers: authHeadersSchema,
    body: socialKitDownloadRequestSchema,
    responses: {
      202: socialKitDownloadResponseSchema,
      400: socialKitErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: socialKitErrorSchema,
      409: socialKitDownloadConflictSchema,
      422: socialKitErrorSchema,
      429: socialKitErrorSchema,
      500: apiErrorSchema,
      502: socialKitErrorSchema,
      503: socialKitErrorSchema,
    },
    summary: "Start an Okou Social artifact download",
  },
  listDownloads: {
    method: "GET",
    path: "/api/social/downloads",
    headers: authHeadersSchema,
    query: socialKitDownloadListQuerySchema,
    responses: {
      200: socialKitDownloadListResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List saved downloads for the current user and organization",
  },
  getDownload: {
    method: "GET",
    path: "/api/social/downloads/:downloadId",
    headers: authHeadersSchema,
    pathParams: z.object({ downloadId: z.string().uuid() }),
    responses: {
      200: socialKitDownloadResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get an Okou Social artifact download",
  },
});

export type SocialContract = typeof socialContract;
