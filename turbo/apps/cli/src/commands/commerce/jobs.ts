import { setTimeout as sleep } from "node:timers/promises";

import {
  commerceJobSchema,
  type CommerceJob,
  type CommerceResponse,
} from "@okouai/api-contracts/contracts/commerce";
import { Command, InvalidArgumentError } from "commander";

import { getCommerceJob } from "../../lib/api/domains/commerce";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { withSocialOutput, type SocialExportOptions } from "../social/output";

export interface CommerceJobOptions extends SocialExportOptions {
  readonly async?: boolean;
}

function recoveryCommand(id: string): string {
  return `okou data commerce job ${id} --wait --json`;
}

function printJob(job: CommerceJob, compact: boolean): void {
  console.log(
    JSON.stringify(
      { ...job, recoveryCommand: recoveryCommand(job.id) },
      null,
      compact ? 0 : 2,
    ),
  );
}

async function waitForJob(
  initial: CommerceJob,
  signal: AbortSignal,
): Promise<CommerceJob> {
  let job = initial;
  for (
    let attempt = 0;
    job.status === "pending" || job.status === "running";
    attempt += 1
  ) {
    signal.throwIfAborted();
    if (attempt === 900) {
      throw new ApiRequestError(
        `The job is still running. Read it with: ${recoveryCommand(job.id)}`,
        "COMMERCE_JOB_PENDING",
        503,
      );
    }
    if (attempt > 0) await sleep(2_000, undefined, { signal });
    try {
      job = await getCommerceJob(job.id, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new ApiRequestError(
        `The job status could not be read. Recover it with: ${recoveryCommand(job.id)}. ${error instanceof Error ? error.message : "Commerce request failed"}`,
        "COMMERCE_JOB_READ_FAILED",
        503,
      );
    }
  }
  return job;
}

async function withJobInterruption(
  job: CommerceJob,
  compact: boolean,
  action: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted = true;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    const message = "The saved Commerce job continues on the server";
    console.error(
      compact
        ? JSON.stringify({
            status: "interrupted",
            jobId: job.id,
            recoveryCommand: recoveryCommand(job.id),
            message,
          })
        : `${message}. Read it with: ${recoveryCommand(job.id)}`,
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

export async function printCommerceResult(
  options: CommerceJobOptions,
  submit: () => Promise<CommerceJob>,
): Promise<void> {
  if (
    options.async &&
    (options.output !== undefined ||
      options.select !== undefined ||
      options.format !== undefined ||
      options.overwrite)
  ) {
    throw new InvalidArgumentError(
      "--async does not support --output, --select, --format, or --overwrite; retrieve the job with okou data commerce job <id> --wait --json",
    );
  }
  await withSocialOutput(
    options,
    "collection",
    async (write) => {
      const submitted = await submit();
      const writeResult = async (response: CommerceResponse) => {
        const { result, ...metadata } = response;
        await write({ kind: "result", ...metadata, data: result });
      };
      if (options.async) {
        if (submitted.status === "failed") process.exitCode = 1;
        printJob(submitted, options.json === true);
        return;
      }
      await withJobInterruption(
        submitted,
        options.json === true,
        async (signal) => {
          const job = await waitForJob(submitted, signal);
          if (job.status === "failed") {
            throw new ApiRequestError(
              `${job.error?.message ?? "Commerce job failed"}. Read it with: ${recoveryCommand(job.id)}`,
              job.error?.code ?? "COMMERCE_JOB_FAILED",
              502,
            );
          }
          if (job.result === null) {
            throw new ApiRequestError(
              `The completed Commerce job has no result. Read it with: ${recoveryCommand(job.id)}`,
              "COMMERCE_JOB_RESULT_MISSING",
              502,
            );
          }
          await writeResult(job.result);
        },
      );
    },
    "Commerce",
  );
}

type RunAction = (
  compact: boolean,
  action: () => Promise<void>,
) => Promise<void>;

export function createCommerceJobCommand(runAction: RunAction): Command {
  return new Command("job")
    .description(
      "Read a saved Commerce job without starting another paid operation",
    )
    .argument("<id>", "Commerce job UUID", (value: string) => {
      const parsed = commerceJobSchema.shape.id.safeParse(value);
      if (!parsed.success)
        throw new InvalidArgumentError("value must be a valid UUID");
      return parsed.data;
    })
    .option("--wait", "Wait for the saved job to finish")
    .option("--json", "Print compact JSON")
    .addHelpText(
      "after",
      "\nReading or waiting never submits another paid operation. Interrupting the CLI leaves server work running. Failed jobs exit with status 1; do not resubmit an uncertain provider submission.",
    )
    .action(async (id: string, options: { wait?: boolean; json?: boolean }) => {
      await runAction(options.json === true, async () => {
        const job = await getCommerceJob(id, new AbortController().signal);
        if (!options.wait) {
          if (job.status === "failed") process.exitCode = 1;
          printJob(job, options.json === true);
          return;
        }
        await withJobInterruption(
          job,
          options.json === true,
          async (signal) => {
            const result = await waitForJob(job, signal);
            if (result.status === "failed") process.exitCode = 1;
            printJob(result, options.json === true);
          },
        );
      });
    });
}
