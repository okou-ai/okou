import { readFile, stat } from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import {
  jobCreateSchema,
  jobListQuerySchema,
  jobUpdateSchema,
} from "@okouai/api-contracts/contracts/jobs";
import {
  createJob,
  getJob,
  listJobs,
  updateJob,
} from "../../lib/api/domains/jobs";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { withErrorHandler } from "../../lib/command/with-error-handler";

async function inputFile(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 262144)
    throw new Error("Job input must be a JSON file of at most 262144 bytes.");
  return JSON.parse(await readFile(path, "utf8"));
}
function jsonError(error: unknown, options: { readonly json?: boolean }) {
  if (!options.json) return false;
  console.error(
    JSON.stringify({
      error: {
        code: error instanceof ApiRequestError ? error.code : "INVALID_INPUT",
        message: error instanceof Error ? error.message : "Job command failed",
      },
    }),
  );
  return true;
}
const jobId = z.uuid().toLowerCase();
export function createJobCommand() {
  const job = new Command("job").description(
    "Manage work explicitly entrusted to Okou; ordinary chat tasks are not Jobs",
  );
  job
    .command("list")
    .description("List your Jobs; follow nextAfter to read every page")
    .option(
      "--filter <filter>",
      "home, history, archived, runnable, or all",
      "home",
    )
    .option(
      "--runnable",
      "Include active work and unprocessed input on waiting or completed Jobs",
    )
    .option("--after <id>", "Continue after the returned nextAfter identity")
    .option("--limit <count>", "Page size from 1 to 100", "50")
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(
        async (options: {
          readonly filter: string;
          readonly runnable?: boolean;
          readonly after?: string;
          readonly limit: string;
          readonly json?: boolean;
        }) => {
          const query = jobListQuerySchema.parse({
            filter: options.runnable ? "runnable" : options.filter,
            after: options.after,
            limit: options.limit,
          });
          const result = await listJobs(query);
          if (options.json) console.log(JSON.stringify(result));
          else {
            for (const item of result.jobs)
              console.log(
                `${item.id}  ${item.status}  ${item.title}${item.hasPendingInput ? "  (new input)" : ""}`,
              );
            if (result.jobs.length === 0)
              console.log(
                "No Jobs in this view. Create a Job only when the user explicitly delegates it: okou job create --file job.json",
              );
            if (result.nextAfter)
              console.log(
                `Next page: okou job list --filter ${query.filter} --after ${result.nextAfter}`,
              );
          }
        },
        jsonError,
      ),
    );
  job
    .command("get <id>")
    .description("Read objective, business snapshot, inputs and Results")
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(
        async (id: string, options: { readonly json?: boolean }) => {
          const result = await getJob(jobId.parse(id));
          console.log(
            JSON.stringify(result, null, options.json ? undefined : 2),
          );
        },
        (error, _id, options) => {
          return jsonError(error, options);
        },
      ),
    );
  job
    .command("create")
    .description(
      "Persist explicit delegation; reuse its UUID and exact file when retrying",
    )
    .requiredOption(
      "--file <path>",
      "JSON with id, title, objective, and optional sourceReferences",
    )
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(
        async (options: { readonly file: string; readonly json?: boolean }) => {
          const result = await createJob(
            jobCreateSchema.parse(await inputFile(options.file)),
          );
          console.log(
            options.json
              ? JSON.stringify(result)
              : `Job saved: ${result.id}\nInspect: okou job get ${result.id} --json`,
          );
        },
        jsonError,
      ),
    );
  job
    .command("update <id>")
    .description(
      "Update a Job using its inspected status/work as expected; never blindly retry actions",
    )
    .requiredOption(
      "--file <path>",
      "JSON with expected {status, work}, status, work, and optional result",
    )
    .option("--json", "Output JSON")
    .action(
      withErrorHandler(
        async (
          id: string,
          options: { readonly file: string; readonly json?: boolean },
        ) => {
          const result = await updateJob(
            jobId.parse(id),
            jobUpdateSchema.parse(await inputFile(options.file)),
          );
          console.log(
            options.json
              ? JSON.stringify(result)
              : `Job ${result.id}: ${result.status}\nInspect: okou job get ${result.id} --json`,
          );
        },
        (error, _id, options) => {
          return jsonError(error, options);
        },
      ),
    );
  return job;
}
export const jobCommand = createJobCommand();
