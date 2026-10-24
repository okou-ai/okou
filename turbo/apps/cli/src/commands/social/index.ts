import { readFile } from "node:fs/promises";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import {
  socialDownloadRequestSchema,
  socialDownloadListQuerySchema,
  socialSummaryFieldsSchema,
  SOCIAL_MAX_INPUT_VALUE_CHARS,
} from "@okouai/api-contracts/contracts/social";
import { SOCIAL_DEFAULT_COLLECTION_LIMIT as DEFAULT_COLLECTION_LIMIT } from "@okouai/api-contracts/contracts/social-discovery";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { printDataRouterTool } from "../data/print-result";
import { socialCapabilities } from "./capabilities";
import {
  addSocialJobOptions,
  createSocialJobsCommand,
  printSocialJob,
  usesSocialJobs,
  type SocialJobOptions,
} from "./jobs";
import {
  commentsIntent,
  downloadPlatform,
  inspectIntent,
  isJobOnlyPlatform,
  parseSearchPlatform,
  parseSocialPlatform,
  parseSocialTarget,
  SOCIAL_JOB_ONLY_PLATFORMS,
  postsIntent,
  searchIntent,
  summarizeIntent,
  transcriptIntent,
  type SocialCommandPlatform,
  type SocialIntent,
} from "./intents";
function printJson(value: unknown, compact: boolean): void {
  console.log(JSON.stringify(value, null, compact ? undefined : 2));
}
async function runSocialAction(action: () => Promise<void>): Promise<void> {
  await withErrorHandler(action)();
}
async function printIntent(
  intent: SocialIntent,
  options: SocialJobOptions,
): Promise<void> {
  await printDataRouterTool(intent.tool, intent.input, options.json);
}
interface OutputOptions {
  readonly json?: boolean;
}

interface InspectOptions extends SocialJobOptions {
  readonly requireViews?: boolean;
  readonly thread?: boolean;
}

interface CollectionOptions extends SocialJobOptions {
  readonly limit: number;
}

interface PostsOptions extends CollectionOptions {
  readonly fullDetails?: boolean;
  readonly kind?: string;
}

interface SearchOptions extends CollectionOptions {
  readonly date?: string;
  readonly hashtag?: boolean;
  readonly platform: SocialCommandPlatform;
  readonly sort?: string;
  readonly type?: string;
}

interface CommentsOptions extends CollectionOptions {
  readonly sort?: string;
}

interface TranscriptOptions extends SocialJobOptions {
  readonly refresh?: boolean;
}

interface SummarizeOptions extends TranscriptOptions {
  readonly fields?: string;
  readonly fieldsFile?: string;
  readonly prompt?: string;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}

const capabilitiesCommand = new Command()
  .name("capabilities")
  .description("List offline capabilities and supported inputs")
  .argument("[platform]", "Optional platform filter", parseSearchPlatform)
  .option("--json", "Print compact JSON")
  .action(
    (platform: SocialCommandPlatform | undefined, options: OutputOptions) => {
      printJson(
        { capabilities: socialCapabilities(platform) },
        options.json === true,
      );
    },
  );

const inspectCommand = new Command()
  .name("inspect")
  .description("Inspect one public social profile, channel, post, or video")
  .argument("<url>", "Public social URL")
  .option("--thread", "Inspect an X post as a thread")
  .option(
    "--require-views",
    "Require verified Instagram post/reel views; unavailable views fail without a charge",
  )
  .option("--json", "Print compact JSON")
  .action(async (url: string, options: InspectOptions) => {
    await runSocialAction(async () => {
      if (usesSocialJobs(options)) {
        await printSocialJob("inspect", url, options);
        return;
      }
      const target = parseSocialTarget(url);
      await printIntent(
        inspectIntent(target, {
          thread: options.thread,
          requireViews: options.requireViews,
        }),
        options,
      );
    });
  });

const postsCommand = new Command()
  .name("posts")
  .description(
    "List public posts or videos from a profile, channel, or playlist",
  )
  .argument("<url>", "Public profile, channel, company, or playlist URL")
  .option("--kind <kind>", "Instagram content kind: posts or reels")
  .option(
    "--sort <sort>",
    "Saved jobs only: YouTube newest/popular/oldest; X latest/top",
  )
  .option("--type <type>", "Saved YouTube jobs only: video or shorts")
  .option(
    "--full-details",
    "YouTube channel/playlist exact dates and descriptions (slower; --limit at most 30)",
  )
  .option(
    "--limit <count>",
    "Maximum total items to return",
    positiveInteger,
    DEFAULT_COLLECTION_LIMIT,
  )
  .option("--json", "Print compact JSON")
  .action(async (url: string, options: PostsOptions) => {
    await runSocialAction(async () => {
      if (usesSocialJobs(options)) {
        await printSocialJob("posts", url, options);
        return;
      }
      if (options.sort !== undefined || options.type !== undefined) {
        throw new InvalidArgumentError(
          "Posts --sort and --type require a saved data job control such as --dry-run or --max-credits",
        );
      }
      const target = parseSocialTarget(url);
      await printIntent(
        postsIntent(target, {
          fullDetails: options.fullDetails,
          kind: options.kind,
          limit: options.limit,
        }),
        options,
      );
    });
  });

const searchCommand = new Command()
  .name("search")
  .description("Search public social content on one platform")
  .argument("<query>", "Search query or hashtag")
  .requiredOption(
    "--platform <platform>",
    `instagram, tiktok, or youtube; saved jobs also support x, facebook, and ${SOCIAL_JOB_ONLY_PLATFORMS.join(", ")}`,
    parseSearchPlatform,
  )
  .option("--hashtag", "Treat an Instagram or TikTok query as a hashtag")
  .option("--sort <sort>", "Platform-supported sort order")
  .option("--date <date>", "Platform-supported publication window")
  .option(
    "--type <type>",
    "YouTube: video or shorts; saved WeChat jobs: article, account, or video; Douyin: account; Weibo: post",
  )
  .option(
    "--limit <count>",
    "Maximum total items to return",
    positiveInteger,
    DEFAULT_COLLECTION_LIMIT,
  )
  .option("--json", "Print compact JSON")
  .action(async (query: string, options: SearchOptions) => {
    await runSocialAction(async () => {
      if (usesSocialJobs(options)) {
        await printSocialJob("search", query, options);
        return;
      }
      const { platform } = options;
      if (isJobOnlyPlatform(platform)) {
        throw new InvalidArgumentError(
          `${platform} search runs as a saved data job; add --dry-run, --max-credits, or --request-id`,
        );
      }
      await printIntent(
        searchIntent(query, {
          platform,
          limit: options.limit,
          hashtag: options.hashtag,
          sort: options.sort,
          date: options.date,
          type: options.type,
        }),
        options,
      );
    });
  });

const commentsCommand = new Command()
  .name("comments")
  .description("List comments on one public social post or video")
  .argument("<url>", "Public post or video URL")
  .option("--sort <sort>", "Instagram: popular/recent; YouTube: top/new")
  .option(
    "--limit <count>",
    "Maximum total comments to return",
    positiveInteger,
    DEFAULT_COLLECTION_LIMIT,
  )
  .option("--json", "Print compact JSON")
  .action(async (url: string, options: CommentsOptions) => {
    await runSocialAction(async () => {
      if (usesSocialJobs(options)) {
        await printSocialJob("comments", url, options);
        return;
      }
      const target = parseSocialTarget(url);
      await printIntent(
        commentsIntent(target, {
          limit: options.limit,
          sort: options.sort,
        }),
        options,
      );
    });
  });

function jobOnlyCollectionCommand(
  operation: "replies" | "followers" | "following",
): Command {
  const command = new Command(operation)
    .description(
      operation === "replies"
        ? "List one bounded page of replies to a selected public comment"
        : `List one bounded page of public ${operation} (Douyin only)`,
    )
    .argument(
      "<url>",
      operation === "replies" ? "Public post URL" : "Public profile URL",
    )
    .option(
      "--limit <count>",
      "Maximum total items across this collection (1-1000)",
      positiveInteger,
      DEFAULT_COLLECTION_LIMIT,
    )
    .option("--json", "Print compact JSON")
    .action(async (url: string, options: SocialJobOptions) => {
      await runSocialAction(async () => {
        if (!usesSocialJobs(options)) {
          throw new InvalidArgumentError(
            `${operation} requires a saved data job control: --dry-run, --max-credits, or --request-id`,
          );
        }
        await printSocialJob(operation, url, options);
      });
    });
  if (operation === "replies") {
    command.requiredOption(
      "--comment-id <id>",
      "Decimal ID of the parent comment (not the post ID); no recursive collection",
    );
  }
  addSocialJobOptions(command);
  return command;
}

const repliesCommand = jobOnlyCollectionCommand("replies");

const followersCommand = jobOnlyCollectionCommand("followers");

const followingCommand = jobOnlyCollectionCommand("following");

const transcriptCommand = new Command()
  .name("transcript")
  .description("Extract the transcript from one public social video")
  .argument("<url>", "Public social video URL")
  .option(
    "--language <code>",
    "Two-letter language for supported saved data jobs",
  )
  .option(
    "--refresh",
    "Bypass YouTube extraction caches; captions may still be unavailable",
  )
  .option("--json", "Print compact JSON")
  .addHelpText(
    "after",
    "\nFor YouTube, use --refresh when extraction caches may be stale, for example after captions were added. It bypasses cached caption absence but does not guarantee captions exist.",
  )
  .action(async (url: string, options: TranscriptOptions) => {
    await runSocialAction(async () => {
      if (usesSocialJobs(options)) {
        await printSocialJob("transcript", url, options);
        return;
      }
      if (options.language !== undefined) {
        throw new InvalidArgumentError(
          "--language requires a saved data job control such as --dry-run or --max-credits",
        );
      }
      const target = parseSocialTarget(url);
      await printIntent(
        transcriptIntent(target, { refresh: options.refresh }),
        options,
      );
    });
  });

async function summaryFields(
  options: SummarizeOptions,
): Promise<Record<string, string> | undefined> {
  if (options.fields !== undefined && options.fieldsFile !== undefined) {
    throw new InvalidArgumentError(
      "Use either --fields or --fields-file, not both",
    );
  }
  let json = options.fields;
  if (options.fieldsFile !== undefined) {
    try {
      json = await readFile(options.fieldsFile, "utf8");
    } catch (error) {
      throw new InvalidArgumentError(
        `Cannot read --fields-file ${JSON.stringify(options.fieldsFile)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (json === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidArgumentError(
      `${options.fieldsFile === undefined ? "--fields" : "--fields-file"} must contain valid JSON`,
    );
  }
  const parsed = socialSummaryFieldsSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(
      `Summary fields must be a JSON object with field names of 1-64 characters and nonempty string descriptions; compact JSON must not exceed ${SOCIAL_MAX_INPUT_VALUE_CHARS} characters`,
    );
  }
  const fields = Object.entries(parsed.data);
  if (
    fields.length === 0 ||
    fields.some(([name, description]) => {
      return name.trim().length === 0 || description.trim().length === 0;
    })
  ) {
    throw new InvalidArgumentError(
      "Summary fields must contain at least one field with a nonblank name and description",
    );
  }
  return parsed.data;
}

const summarizeCommand = new Command()
  .name("summarize")
  .description("Summarize one public social video")
  .argument("<url>", "Public social video URL")
  .option("--prompt <text>", "Additional summary instructions")
  .option(
    "--refresh",
    "Bypass YouTube extraction caches; summary-result caching is unchanged",
  )
  .option("--fields <json>", "JSON object mapping field names to descriptions")
  .option(
    "--fields-file <path>",
    "Read the field-description JSON object from a file",
  )
  .option("--json", "Print compact JSON")
  .addHelpText(
    "after",
    "\nRefresh bypasses cached caption absence but does not guarantee captions exist.\nExtraction refresh and summary-result caching are separate controls.",
  )
  .addHelpText(
    "after",
    `
Examples:
  okou data social summarize https://youtu.be/<id> --fields '{"audience":"Who this video helps","actionItems":"Practical next steps"}' --json
  okou data social summarize https://youtu.be/<id> --fields-file summary-fields.json --prompt "Focus on small business owners" --json

Notes:
  - Supported on Facebook, Instagram, TikTok, and YouTube
  - Use either --fields or --fields-file with a nonempty JSON object
  - Field names must be nonblank and 1-64 characters; descriptions must be nonblank strings
  - Compact serialized JSON must not exceed ${SOCIAL_MAX_INPUT_VALUE_CHARS} characters
  - --prompt adds analysis instructions alongside the requested field descriptions
  - Field descriptions guide extraction; they do not enforce strict JSON Schema
  - Returned custom fields are preserved in data; this does not select output columns`,
  )
  .action(async (url: string, options: SummarizeOptions) => {
    await runSocialAction(async () => {
      const target = parseSocialTarget(url);
      const fields = await summaryFields(options);
      await printIntent(
        summarizeIntent(target, {
          fields,
          prompt: options.prompt,
          refresh: options.refresh,
        }),
        options,
      );
    });
  });
const statusCommand = new Command("status")
  .argument("[platform]", "Optional platform", parseSocialPlatform)
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(
      async (platform: string | undefined, options: OutputOptions) => {
        await printDataRouterTool("social_status", { platform }, options.json);
      },
    ),
  );
const downloadsCommand = new Command("downloads")
  .description("Read saved downloads")
  .option("--limit <count>", "Page size", positiveInteger, 20)
  .option("--cursor <uuid>", "Page cursor")
  .option("--status <status>", "Download status or active")
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(
      async (options: {
        limit: number;
        cursor?: string;
        status?: string;
        json?: boolean;
      }) => {
        await printDataRouterTool(
          "social_download_list",
          socialDownloadListQuerySchema.parse(options),
          options.json,
        );
      },
    ),
  );
const downloadCommand = new Command("download")
  .description("Submit media extraction or read an existing download")
  .argument("[url]", "Public media URL")
  .option(
    "--max-duration <seconds>",
    "Maximum accepted duration",
    positiveInteger,
  )
  .option("--quality <quality>", "Requested rendition")
  .option("--format <format>", "Requested media format: mp4, m4a, mp3")
  .option("--resume <uuid>", "Read the existing download once")
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(
      async (
        url: string | undefined,
        options: {
          maxDuration?: number;
          quality?: string;
          format?: string;
          resume?: string;
          json?: boolean;
        },
      ) => {
        if (options.resume !== undefined) {
          if (
            url !== undefined ||
            options.maxDuration !== undefined ||
            options.quality !== undefined ||
            options.format !== undefined
          )
            throw new InvalidArgumentError(
              "--resume cannot be combined with a new download request",
            );
          await printDataRouterTool(
            "social_download_get",
            { downloadId: z.uuid().parse(options.resume) },
            options.json,
          );
          return;
        }
        if (!url)
          throw new InvalidArgumentError(
            "Provide a media URL or --resume <download-id>",
          );
        const target = parseSocialTarget(url);
        const request = socialDownloadRequestSchema.parse({
          platform: downloadPlatform(target),
          url: target.canonicalUrl,
          maxDuration: options.maxDuration,
          quality: options.quality,
          format: options.format,
        });
        await printDataRouterTool(
          "social_download_create",
          request,
          options.json,
        );
      },
    ),
  );
for (const command of [
  inspectCommand,
  postsCommand,
  searchCommand,
  commentsCommand,
  transcriptCommand,
])
  addSocialJobOptions(command);
export const socialCommand = new Command("social")
  .description("Call Social tools and print the Router JSON unchanged")
  .addCommand(capabilitiesCommand)
  .addCommand(statusCommand)
  .addCommand(inspectCommand)
  .addCommand(postsCommand)
  .addCommand(searchCommand)
  .addCommand(commentsCommand)
  .addCommand(repliesCommand)
  .addCommand(followersCommand)
  .addCommand(followingCommand)
  .addCommand(transcriptCommand)
  .addCommand(summarizeCommand)
  .addCommand(downloadCommand)
  .addCommand(downloadsCommand)
  .addCommand(createSocialJobsCommand())
  .addHelpText(
    "after",
    `
Each command prints one Router response without interpreting its result fields. Jobs return receipts; read them with jobs get <job-id>. Downloads return Router data and links; --resume reads a saved download once. Use okou data call <tool> --input '<json>' for explicit pagination inputs. Use shell redirection to save JSON. Paid submissions are never retried automatically.`,
  );
