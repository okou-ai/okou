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
import {
  isJobOnlyPlatform,
  SOCIAL_JOB_ONLY_PLATFORMS,
  type SocialCommandPlatform,
} from "./intents";
import { socialExportCapabilities } from "./output";
import {
  SOCIAL_DATA_MAX_RESULTS,
  type SocialDataOperation,
} from "@okouai/api-contracts/contracts/social-data";

interface JobCapability {
  readonly operation: SocialDataOperation;
  readonly targets: readonly string[];
  readonly inputs?: Readonly<Record<string, readonly string[]>>;
  readonly maxResults?: number;
  readonly note?: string;
}

const jobCapabilities: Partial<
  Record<SocialCommandPlatform, readonly JobCapability[]>
> = {
  threads: [
    {
      operation: "inspect",
      targets: ["profile"],
      note: "Resolves the exact handle through Threads profile search and returns identity fields, not follower counts",
    },
    {
      operation: "search",
      targets: ["query"],
      note: "Returns matching profiles; Threads post search is unavailable",
    },
  ],
  wechat: [
    { operation: "inspect", targets: ["official_account_article"] },
    {
      operation: "search",
      targets: ["query"],
      inputs: { "--type": ["article", "account", "video"] },
      note: "Defaults to every result type; one query on a single line",
    },
    {
      operation: "comments",
      targets: ["official_account_article"],
      note: "Returns one bounded batch of elected comments with their replies counted",
    },
  ],
  xiaohongshu: [
    { operation: "inspect", targets: ["profile", "note", "share_link"] },
    { operation: "posts", targets: ["profile"] },
    {
      operation: "search",
      targets: ["query"],
      inputs: {
        "--sort": ["general", "popularity_descending", "time_descending"],
      },
    },
    { operation: "comments", targets: ["note"] },
  ],
  instagram: [
    { operation: "inspect", targets: ["profile", "post", "reel"] },
    {
      operation: "posts",
      targets: ["profile"],
      inputs: { "--kind": ["posts", "reels"] },
      maxResults: 12,
      note: "One profile request returns the most recent items of the selected kind",
    },
    {
      operation: "comments",
      targets: ["post", "reel"],
      note: "Returns one bounded batch; the requested limit does not guarantee that many available comments",
    },
  ],
  tiktok: [
    { operation: "inspect", targets: ["video", "photo"] },
    { operation: "posts", targets: ["profile"] },
    { operation: "search", targets: ["query"] },
    {
      operation: "comments",
      targets: ["video", "photo"],
      note: "Returns one bounded batch; the requested limit does not guarantee that many available comments",
    },
  ],
  youtube: [
    { operation: "inspect", targets: ["video", "short"] },
    {
      operation: "posts",
      targets: ["channel"],
      inputs: {
        "--sort": ["newest", "popular", "oldest"],
        "--type": ["video", "shorts"],
      },
    },
    {
      operation: "search",
      targets: ["query"],
      inputs: {
        "--sort": ["relevance", "rating", "date", "views"],
        "--date": ["hour", "today", "week", "month", "year"],
        "--type": ["video", "shorts"],
      },
    },
    {
      operation: "comments",
      targets: ["video", "short"],
      inputs: { "--sort": ["top", "newest"] },
    },
    {
      operation: "transcript",
      targets: ["video", "short"],
      note: "--language accepts a two-letter language code; availability depends on the source",
    },
  ],
  facebook: [
    { operation: "inspect", targets: ["public_page"] },
    { operation: "posts", targets: ["public_profile"] },
    { operation: "search", targets: ["query"] },
    {
      operation: "comments",
      targets: ["post", "video", "reel", "photo"],
      inputs: { "--sort": ["newest", "relevant", "all"] },
      note: "Nested replies are excluded",
    },
  ],
  twitter: [
    { operation: "inspect", targets: ["post"] },
    {
      operation: "posts",
      targets: ["profile"],
      inputs: { "--sort": ["latest", "top"] },
    },
    {
      operation: "search",
      targets: ["query"],
      inputs: { "--sort": ["latest", "top"] },
    },
    {
      operation: "comments",
      targets: ["conversation"],
      inputs: { "--sort": ["latest", "top"] },
    },
  ],
};

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

function jobSection(selected: SocialCommandPlatform) {
  return {
    platform: selected === "twitter" ? "x" : selected,
    controls: ["--dry-run", "--max-credits", "--async", "--request-id"],
    maxResults: SOCIAL_DATA_MAX_RESULTS,
    details: jobCapabilities[selected] ?? [],
    note: "Explicit job controls select these capabilities. Existing commands without them use the standard capabilities above. Deployment availability is checked by the free quote API; unsupported inputs fail before execution.",
    recovery: "okou social jobs get <job-id> --wait --json",
  };
}

export function socialCapabilities(platform?: SocialCommandPlatform) {
  const platforms: readonly SocialCommandPlatform[] = platform
    ? [platform]
    : [...socialPlatformSchema.options, ...SOCIAL_JOB_ONLY_PLATFORMS];
  return platforms.map((selected) => {
    if (isJobOnlyPlatform(selected)) {
      return {
        platform: selected,
        operations: [],
        notes: [
          "Saved data jobs are the only protocol for this platform; the standard Social commands have no tool for it",
        ],
        details: [],
        jobs: jobSection(selected),
      };
    }
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
      jobs: jobSection(selected),
    };
  });
}
