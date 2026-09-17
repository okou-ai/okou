import { z } from "zod";
import {
  findManagedSocialKitTool,
  socialKitDownloadRequestSchema,
  socialKitSummaryFieldsSchema,
  SOCIALKIT_MAX_INPUT_VALUE_CHARS,
  type ManagedSocialKitTool,
} from "@okouai/api-contracts/contracts/social";
import {
  socialOperationBindings,
  socialPlatformSchema,
  SOCIAL_DEFAULT_COLLECTION_LIMIT,
  SOCIAL_MAX_COLLECTION_PAGES,
  SOCIAL_INSTAGRAM_POST_KINDS,
  type SocialPlatform,
} from "@okouai/api-contracts/contracts/social-discovery";
import { socialExportCapabilities } from "./output";

const SUMMARY_FIELDS_NOTE =
  'Summarize accepts --fields JSON or --fields-file PATH, e.g. {"audience":"Who this video helps"}, plus optional --prompt guidance (not strict JSON Schema)';

const notes: Partial<Record<SocialPlatform, readonly string[]>> = {
  linkedin: [
    "Inspect supports member profiles, companies, and posts",
    "Posts requires a company URL",
  ],
  twitter: ["Inspect supports profiles, posts, and threads"],
  facebook: [SUMMARY_FIELDS_NOTE],
  instagram: [
    "Posts supports posts and reels",
    "Search supports keywords and hashtags (up to 100 trimmed characters)",
    "Search returns one anonymous batch of up to 12 reels; additional pages and exhaustive results are unavailable",
    "Inspect preserves unavailable views as null, distinct from zero",
    "Inspect --require-views requires verified video views for posts/reels; unavailable views fail without a charge and are not retried automatically",
    SUMMARY_FIELDS_NOTE,
  ],
  tiktok: [
    "Search supports keywords and hashtags",
    "Hashtag search does not accept sort or date filters",
    SUMMARY_FIELDS_NOTE,
  ],
  youtube: [
    "Posts supports channels and playlists",
    "Posts --full-details requests exact dates and descriptions (slower; --limit at most 30)",
    "Unavailable publication dates and descriptions remain null, empty, or missing",
    "Transcript and summarize support --refresh to bypass extraction caches, including cached caption absence; captions may still be unavailable",
    "Summary-result caching is separate and unchanged by --refresh",
    SUMMARY_FIELDS_NOTE,
  ],
};

function inputConstraints(
  schema: z.ZodType,
  inputs: Readonly<Record<string, string>>,
) {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" });
  return Object.fromEntries(
    Object.entries(inputs).map(([flag, field]) => {
      const property = jsonSchema.properties?.[field];
      if (!property || typeof property === "boolean") {
        throw new Error(
          `Social discovery input ${field} has no reviewed schema`,
        );
      }
      return [
        flag,
        {
          type: property.type,
          ...(property.enum ? { choices: property.enum } : {}),
          ...(property.minimum === undefined
            ? {}
            : { minimum: property.minimum }),
          ...(property.maximum === undefined
            ? {}
            : { maximum: property.maximum }),
          ...(property.exclusiveMinimum === undefined
            ? {}
            : { exclusiveMinimum: property.exclusiveMinimum }),
          ...(property.minLength === undefined
            ? {}
            : { minLength: property.minLength }),
          ...(property.maxLength === undefined
            ? {}
            : { maxLength: property.maxLength }),
          ...(property.default === undefined
            ? {}
            : { default: property.default }),
          required: jsonSchema.required?.includes(field) === true,
        },
      ];
    }),
  );
}

function collectionDetails(tool: ManagedSocialKitTool) {
  const collection = tool.collection;
  if (!collection) {
    return {};
  }
  return {
    collection: {
      totalLimit: {
        default: SOCIAL_DEFAULT_COLLECTION_LIMIT,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      requestPageLimit: tool.maxLimit ?? null,
      effectivePageLimit: collection.effectiveLimit ?? null,
      pageSize:
        collection.pageSize?.kind ??
        (tool.maxLimit === undefined
          ? "source_controlled"
          : "up_to_request_limit"),
      pagination:
        collection.pagination.kind === "next_cursor"
          ? "cursor"
          : collection.pagination.kind,
      maxPages:
        collection.pagination.kind === "none"
          ? 1
          : collection.pagination.kind === "page"
            ? collection.pagination.maxPage
            : SOCIAL_MAX_COLLECTION_PAGES,
      stream: true,
      continuation:
        collection.pagination.kind === "none"
          ? { supported: false }
          : {
              supported: true,
              checkpoint: "--checkpoint <file>",
              resume:
                "okou social resume <file> --limit <count> [--json|--stream]",
              version: 1,
              lifetimeHours: 24,
              context: "same OKOU_TOKEN and API endpoint",
              limit: "additional items per invocation; buffered items first",
            },
      ...(collection.sourceLimit
        ? { sourceLimit: collection.sourceLimit }
        : {}),
      ...(collection.emptyResult
        ? {
            emptyResult:
              "unreliable; an empty result does not prove no matches",
          }
        : {}),
    },
  };
}

function detailsFor(entry: ReturnType<typeof socialOperationBindings>[number]) {
  const tool =
    entry.tool === null ? undefined : findManagedSocialKitTool(entry.tool);
  if (entry.tool !== null && !tool) {
    throw new Error("Social discovery has an unreviewed tool binding");
  }
  const selectors =
    entry.platform === "instagram" && entry.operation === "posts"
      ? {
          "--kind": {
            choices: SOCIAL_INSTAGRAM_POST_KINDS,
            value: entry.variant,
            default: "posts",
          },
        }
      : entry.platform === "instagram" && entry.operation === "search"
        ? { "--hashtag": { type: "boolean", required: false } }
        : entry.variant === "thread"
          ? { "--thread": { value: true } }
          : entry.variant === "hashtag"
            ? { "--hashtag": { value: true } }
            : {};
  return {
    operation: entry.operation,
    variant: entry.variant,
    command: `okou social ${entry.operation} --help`,
    inputs: {
      ...inputConstraints(
        tool?.inputSchema ?? socialKitDownloadRequestSchema,
        entry.inputs,
      ),
      ...selectors,
      ...(entry.operation === "summarize"
        ? {
            "--fields": {
              type: "string",
              format: "json_object",
              required: false,
              fieldNameMaxLength:
                socialKitSummaryFieldsSchema.keyType.maxLength,
              maxSerializedLength: SOCIALKIT_MAX_INPUT_VALUE_CHARS,
              conflictsWith: "--fields-file",
              note: "Nonempty object mapping nonblank field names to nonblank descriptions; extraction instructions, not strict JSON Schema",
            },
            "--fields-file": {
              type: "string",
              format: "path",
              required: false,
              conflictsWith: "--fields",
              note: "Read the same field-description JSON accepted by --fields from a file",
            },
          }
        : {}),
      ...(entry.operation === "download"
        ? {
            "--resume": {
              type: "string",
              format: "uuid",
              note: "Resume an existing download without a URL or new download options",
            },
          }
        : {}),
    },
    ...(tool ? collectionDetails(tool) : {}),
    ...(entry.operation !== "download"
      ? {
          export: socialExportCapabilities(
            entry.operation === "transcript"
              ? "transcript"
              : tool?.collection
                ? "collection"
                : "single",
          ),
        }
      : {}),
  };
}

export function socialCapabilities(platform?: SocialPlatform) {
  return (platform ? [platform] : socialPlatformSchema.options).map(
    (selected) => {
      const entries = socialOperationBindings(selected);
      return {
        platform: selected,
        operations: [
          ...new Set(
            entries.map((entry) => {
              return entry.operation;
            }),
          ),
        ].sort(),
        ...(notes[selected] ? { notes: notes[selected] } : {}),
        details: entries.map(detailsFor),
      };
    },
  );
}
