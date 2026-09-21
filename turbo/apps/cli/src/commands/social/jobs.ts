import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  socialDataCreateRequestSchema,
  socialDataListQuerySchema,
  socialDataPlatformSchema,
  socialDataRequestSchema,
  type SocialDataJobResponse,
  type SocialDataOperation,
  type SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import type { SocialCommandPlatform } from "./intents";
import { Command, InvalidArgumentError } from "commander";

import {
  cancelSocialDataJob,
  createSocialDataJob,
  getSocialDataJob,
  listSocialDataJobs,
  quoteSocialData,
  SocialDataRecoveryError,
} from "../../lib/api/domains/social-data";
import {
  parseJobOnlyTarget,
  parseSocialTarget,
  SOCIAL_JOB_ONLY_PLATFORMS,
} from "./intents";
import { withSocialOutput, type SocialExportOptions } from "./output";

export interface SocialJobOptions extends SocialExportOptions {
  readonly dryRun?: boolean;
  readonly maxCredits?: number;
  readonly async?: boolean;
  readonly requestId?: string;
  readonly checkpoint?: string;
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
    .option("--dry-run", "Quote this bounded data operation without billing")
    .option(
      "--max-credits <credits>",
      "Hard maximum credits for a saved data job",
      positiveInteger,
    )
    .option("--async", "Start a saved data job and return its ID immediately")
    .option(
      "--request-id <uuid>",
      "Recover or deduplicate the same data job submission",
      uuid,
    )
    .addHelpText(
      "after",
      `
Saved data jobs:
  --dry-run, --max-credits, --async, or --request-id select the saved data job API.
  Without these controls, existing Social command behavior is unchanged.
  Job capabilities differ by platform; unsupported operations and inputs fail before execution.
  --limit bounds the total results (maximum 1000); quotes show the reserved credit ceiling.
  --dry-run is free. --max-credits is enforced by the server before starting work.
  --stream and --checkpoint are unavailable for saved jobs. --dry-run and --async do not accept export options.
  Synchronous saved jobs support the command's existing export formats.
  Reuse --request-id only with identical inputs to recover a submission without starting another job.
  Read a saved job with okou social jobs get <job-id> --wait --json; reading does not start another collection.
  Interrupting the CLI leaves server work running. Cancel explicitly with okou social jobs cancel <job-id>.`,
    );
}

export function usesSocialJobs(options: SocialJobOptions): boolean {
  return (
    options.dryRun === true ||
    options.maxCredits !== undefined ||
    options.async === true ||
    options.requestId !== undefined
  );
}

function validateOptions(options: SocialJobOptions): void {
  if (options.stream || options.checkpoint !== undefined) {
    throw new InvalidArgumentError(
      "Saved data jobs do not support --stream or --checkpoint; use okou social jobs get to recover saved results",
    );
  }
  if (options.dryRun && (options.async || options.requestId !== undefined)) {
    throw new InvalidArgumentError(
      "--dry-run cannot be combined with --async or --request-id",
    );
  }
  if (
    (options.dryRun || options.async) &&
    (options.output !== undefined ||
      options.select !== undefined ||
      options.format !== undefined ||
      options.overwrite)
  ) {
    throw new InvalidArgumentError(
      "--dry-run and --async do not support --output, --select, --format, or --overwrite",
    );
  }
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
  });
  if (!parsed.success) {
    throw new InvalidArgumentError(
      parsed.error.issues[0]?.message ?? "Invalid Social data job input",
    );
  }
  return parsed.data;
}

function printJson(value: unknown, compact: boolean): void {
  console.log(JSON.stringify(value, null, compact ? 0 : 2));
}

function recoveryCommand(jobId: string): string {
  return `okou social jobs get ${jobId} --wait --json`;
}

function terminal(job: SocialDataJobResponse): boolean {
  return (
    job.status !== "pending" &&
    job.status !== "running" &&
    (job.status !== "completed" || job.billing.state === "settled")
  );
}

async function waitForJob(
  initial: SocialDataJobResponse,
  signal: AbortSignal,
): Promise<SocialDataJobResponse> {
  let job = initial;
  for (let attempt = 0; attempt < 900; attempt += 1) {
    signal.throwIfAborted();
    if (terminal(job)) return job;
    await sleep(2_000, undefined, { signal });
    try {
      job = await getSocialDataJob(job.jobId, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new SocialDataRecoveryError(
        `The job status could not be read. Recover the saved job with: ${recoveryCommand(job.jobId)}`,
        { jobId: job.jobId, command: recoveryCommand(job.jobId) },
        { cause: error },
      );
    }
  }
  throw new SocialDataRecoveryError(
    `The job is still running. Read it with: ${recoveryCommand(job.jobId)}`,
    { jobId: job.jobId, command: recoveryCommand(job.jobId) },
  );
}

async function withJobInterruption(
  job: SocialDataJobResponse,
  compact: boolean,
  action: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    console.error(
      compact
        ? JSON.stringify({
            status: "interrupted",
            jobId: job.jobId,
            recoveryCommand: recoveryCommand(job.jobId),
            message: "The saved job continues on the server",
          })
        : `The saved job continues on the server. Read it with: ${recoveryCommand(job.jobId)}`,
    );
    controller.abort();
  };
  const onSigint = () => {
    return interrupt("SIGINT");
  };
  const onSigterm = () => {
    return interrupt("SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
    await action(controller.signal);
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

export async function printSocialJob(
  operation: SocialDataOperation,
  input: string,
  options: SocialJobOptions,
): Promise<void> {
  validateOptions(options);
  const request = dataRequest(operation, input, options);
  const compact = options.json === true;
  if (options.dryRun) {
    const quote = await quoteSocialData(request);
    printJson(
      {
        kind: "quote",
        ...quote,
        ...(options.maxCredits === undefined
          ? {}
          : {
              budget: {
                maxCredits: options.maxCredits,
                fits: quote.maxCredits <= options.maxCredits,
              },
            }),
      },
      compact,
    );
    return;
  }
  const createRequest = socialDataCreateRequestSchema.parse({
    ...request,
    requestId: options.requestId ?? randomUUID(),
    maxCredits: options.maxCredits,
  });
  const mode =
    operation === "transcript"
      ? "transcript"
      : operation === "inspect"
        ? "single"
        : "collection";
  await withSocialOutput(options, mode, async (write) => {
    console.error(
      compact
        ? JSON.stringify({
            kind: "submission",
            requestId: createRequest.requestId,
          })
        : `Social job request ID: ${createRequest.requestId}`,
    );
    const created = await createSocialDataJob(createRequest);
    if (options.async) {
      printJson(
        { ...created, recoveryCommand: recoveryCommand(created.jobId) },
        compact,
      );
      return;
    }
    await withJobInterruption(created, compact, async (signal) => {
      const result = await waitForJob(created, signal);
      if (result.status !== "completed") process.exitCode = 1;
      if (result.data === null) {
        printJson(result, compact);
      } else {
        await write({ kind: "result", ...result });
      }
    });
  });
}

type RunAction = (
  machineReadable: boolean,
  action: () => Promise<void>,
) => Promise<void>;

export function createSocialJobsCommand(runAction: RunAction): Command {
  const list = new Command("list")
    .description(
      "List saved data jobs without starting or billing another operation",
    )
    .option(
      "--limit <count>",
      "Maximum saved jobs (1-100)",
      positiveInteger,
      20,
    )
    .option("--cursor <uuid>", "Continue after the last job ID", uuid)
    .option("--json", "Print compact JSON")
    .action(
      async (options: { limit: number; cursor?: string; json?: boolean }) => {
        await runAction(options.json === true, async () => {
          const query = socialDataListQuerySchema.safeParse({
            limit: options.limit,
            cursor: options.cursor,
          });
          if (!query.success) {
            throw new InvalidArgumentError("--limit must be between 1 and 100");
          }
          printJson(
            await listSocialDataJobs(query.data),
            options.json === true,
          );
        });
      },
    );
  const get = new Command("get")
    .description("Read saved results; waiting never starts another operation")
    .argument("<job-id>", "Saved Social job UUID", uuid)
    .option("--wait", "Wait for the saved job to finish")
    .option("--json", "Print compact JSON")
    .action(
      async (jobId: string, options: { wait?: boolean; json?: boolean }) => {
        await runAction(options.json === true, async () => {
          const job = await getSocialDataJob(
            jobId,
            new AbortController().signal,
          );
          if (!options.wait) {
            printJson(job, options.json === true);
            return;
          }
          await withJobInterruption(
            job,
            options.json === true,
            async (signal) => {
              const result = await waitForJob(job, signal);
              if (result.status !== "completed") process.exitCode = 1;
              printJson(result, options.json === true);
            },
          );
        });
      },
    );
  const cancel = new Command("cancel")
    .description("Stop a saved data job and retain delivered results")
    .argument("<job-id>", "Saved Social job UUID", uuid)
    .option("--json", "Print compact JSON")
    .action(async (jobId: string, options: { json?: boolean }) => {
      await runAction(options.json === true, async () => {
        printJson(await cancelSocialDataJob(jobId), options.json === true);
      });
    });
  return new Command("jobs")
    .description("Find, recover, and cancel saved Social data jobs")
    .addCommand(list)
    .addCommand(get)
    .addCommand(cancel);
}
