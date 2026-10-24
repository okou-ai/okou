import {
  printDataRouterTool,
  printDataRouterSubmission,
} from "../data/print-result";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { randomUUID } from "node:crypto";

import {
  socialDataCreateRequestSchema,
  socialDataListQuerySchema,
  socialDataPlatformSchema,
  socialDataRequestSchema,
  type SocialDataOperation,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import type { SocialCommandPlatform } from "./intents";
import { Command, InvalidArgumentError } from "commander";
import {
  parseJobOnlyTarget,
  parseSocialTarget,
  SOCIAL_JOB_ONLY_PLATFORMS,
} from "./intents";

export interface SocialJobOptions {
  readonly json?: boolean;
  readonly dryRun?: boolean;
  readonly maxCredits?: number;
  readonly requestId?: string;
  readonly platform?: SocialCommandPlatform;
  readonly limit?: number;
  readonly kind?: string;
  readonly sort?: string;
  readonly date?: string;
  readonly type?: string;
  readonly hashtag?: boolean;
  readonly fullDetails?: boolean;
  readonly refresh?: boolean;
  readonly thread?: boolean;
  readonly requireViews?: boolean;
  readonly language?: string;
  readonly commentId?: string;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("value must be a positive integer");
  }
  return parsed;
}

function uuid(value: string): string {
  const parsed = socialDataCreateRequestSchema.shape.requestId.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError("value must be a valid UUID");
  }
  return parsed.data;
}
export function addSocialJobOptions(command: Command): void {
  command
    .option("--dry-run", "Quote without submitting")
    .option(
      "--max-credits <credits>",
      "Maximum quote accepted before submission",
      positiveInteger,
    )
    .option(
      "--request-id <uuid>",
      "Client request label; not a replay guarantee",
      uuid,
    )
    .addHelpText(
      "after",
      "\nSaved jobs return the Router receipt unchanged. Read results with okou data social jobs get <job-id>. Quotes are estimates; Router owns final pricing. Do not repeat an uncertain paid submission.",
    );
}
export function usesSocialJobs(options: SocialJobOptions): boolean {
  return (
    options.dryRun === true ||
    options.maxCredits !== undefined ||
    options.requestId !== undefined
  );
}

function dataRequest(
  operation: SocialDataOperation,
  input: string,
  options: SocialJobOptions,
): SocialDataRequest {
  const jobOnly = operation === "search" ? null : parseJobOnlyTarget(input);
  const target =
    operation === "search" || jobOnly ? undefined : parseSocialTarget(input);
  const platform = jobOnly?.platform ?? target?.platform ?? options.platform;
  const parsedPlatform = socialDataPlatformSchema.safeParse(
    platform === "twitter" ? "x" : platform,
  );
  if (!parsedPlatform.success) {
    throw new InvalidArgumentError(
      `Saved Social data jobs support x, instagram, tiktok, youtube, facebook, and ${SOCIAL_JOB_ONLY_PLATFORMS.join(", ")}`,
    );
  }
  const parsed = socialDataRequestSchema.safeParse({
    operation,
    platform: parsedPlatform.data,
    ...(jobOnly
      ? { url: jobOnly.url }
      : target
        ? { url: target.canonicalUrl }
        : { query: input }),
    limit:
      options.limit ??
      (operation === "inspect" || operation === "transcript" ? 1 : 10),
    kind: options.kind,
    sort: options.sort,
    date: options.date,
    type: options.type,
    hashtag: options.hashtag,
    fullDetails: options.fullDetails,
    refresh: options.refresh,
    thread: options.thread,
    requireViews: options.requireViews,
    language: options.language,
    commentId: options.commentId,
  });
  if (!parsed.success) {
    throw new InvalidArgumentError(
      parsed.error.issues[0]?.message ?? "Invalid Social data job input",
    );
  }
  return parsed.data;
}
export async function printSocialJob(
  operation: SocialDataOperation,
  input: string,
  options: SocialJobOptions,
): Promise<void> {
  const request = dataRequest(operation, input, options);
  if (options.dryRun) {
    await printDataRouterTool("social_data_quote", request, options.json);
    return;
  }
  const body = socialDataCreateRequestSchema.parse({
    ...request,
    requestId: options.requestId ?? randomUUID(),
    maxCredits: options.maxCredits,
  });
  await printDataRouterSubmission(
    "social_data_create",
    body,
    options.json === true,
    options.maxCredits === undefined
      ? undefined
      : {
          name: "social_data_quote",
          input: request,
          maxCredits: options.maxCredits,
        },
  );
}
export function createSocialJobsCommand(): Command {
  const jobs = new Command("jobs").description(
    "Read and manage saved Social jobs",
  );
  jobs
    .command("list")
    .option("--limit <count>", "Maximum jobs", positiveInteger, 20)
    .option("--cursor <uuid>", "Page cursor", uuid)
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(async (options) => {
        await printDataRouterTool(
          "social_data_list",
          socialDataListQuerySchema.parse(options),
          options.json,
        );
      }),
    );
  for (const operation of ["get", "cancel"]) {
    jobs
      .command(operation)
      .argument("<job-id>", "Saved job UUID", uuid)
      .option("--json", "Print compact JSON")
      .action(
        withErrorHandler(async (jobId: string, options: { json?: boolean }) => {
          await printDataRouterTool(
            `social_data_${operation}`,
            { jobId },
            options.json,
          );
        }),
      );
  }
  const continuation = jobs
    .command("continue")
    .argument("<job-id>", "Saved job UUID", uuid)
    .option("--json", "Print compact JSON");
  addSocialJobOptions(continuation);
  continuation.action(
    withErrorHandler(async (jobId: string, options: SocialJobOptions) => {
      if (options.dryRun) {
        await printDataRouterTool(
          "social_data_quote_continuation",
          { jobId },
          options.json,
        );
        return;
      }
      if (options.maxCredits === undefined)
        throw new InvalidArgumentError(
          "Continuation requires --max-credits; use --dry-run for a quote",
        );
      await printDataRouterSubmission(
        "social_data_continue",
        {
          jobId,
          requestId: options.requestId ?? randomUUID(),
          maxCredits: options.maxCredits,
        },
        options.json === true,
        {
          name: "social_data_quote_continuation",
          input: { jobId },
          maxCredits: options.maxCredits,
        },
      );
    }),
  );
  return jobs;
}
