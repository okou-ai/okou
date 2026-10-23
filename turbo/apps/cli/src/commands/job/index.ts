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

const JOB_HANDOFF_HELP = `Execution handoff:
  Tasks are saved delegations executed asynchronously by Okou's background Tasks loop.
  The loop advances saved work when background execution is enabled; if background execution is paused, Tasks remain saved.
  In the creating chat, successful create is the handoff: confirm the Task ID and end the turn.
  Do not also perform the objective, mark it completed, start another worker/workflow, or poll for completion.
  Creation and status active do not prove that work is running or complete.
  Read saved progress and Results later with okou task get <id> --json.`;

async function inputFile(path: string): Promise<unknown> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 262144)
    throw new Error("Task input must be a JSON file of at most 262144 bytes.");
  return JSON.parse(await readFile(path, "utf8"));
}
function jsonError(error: unknown, options: { readonly json?: boolean }) {
  if (!options.json) return false;
  console.error(
    JSON.stringify({
      error: {
        code: error instanceof ApiRequestError ? error.code : "INVALID_INPUT",
        message: error instanceof Error ? error.message : "Task command failed",
      },
    }),
  );
  return true;
}
const jobId = z.uuid().toLowerCase();
export function createJobCommand() {
  const job = new Command("task")
    .description(
      "Delegate explicitly entrusted work to Okou's background Tasks loop",
    )
    .addHelpText(
      "after",
      `
Create Tasks only when the user explicitly asks to entrust work as an Okou Task.
Ordinary chat requests and Suggestions do not automatically become Tasks.

${JOB_HANDOFF_HELP}

Usage:
  1. Put a stable UUID, title and self-contained objective in task.json.
     Include the authorized scope, delivery target, necessary inputs and completion criteria.
     Background runs use saved Task details rather than inheriting the creating chat.
  2. Run okou task create --file task.json --json, confirm the saved ID, and end the creating turn.
  3. When the user asks for status, read okou task get <id> --json and report the saved state.

Background executor:
  The Proactive tasks run uses list --runnable, get, ordinary tools, and update to do the work.
  update persists inspected progress and verified Results; it does not start a worker.
  User replies and permission responses belong to Task details.
`,
    );
  job
    .command("list")
    .description("List your Tasks; follow nextAfter to read every page")
    .option(
      "--filter <filter>",
      "home, history, archived, runnable, or all",
      "home",
    )
    .option(
      "--runnable",
      "Include active work and unprocessed input on waiting or completed Tasks",
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
                "No Tasks in this view. Create a Task only when the user explicitly delegates it: okou task create --file task.json",
              );
            if (result.nextAfter)
              console.log(
                `Next page: okou task list --filter ${query.filter} --after ${result.nextAfter}`,
              );
          }
        },
        jsonError,
      ),
    );
  job
    .command("get <id>")
    .description(
      "Read saved progress, inputs and Results; does not start execution",
    )
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
      "Save an explicit delegation for background execution and hand it off",
    )
    .requiredOption(
      "--file <path>",
      "JSON with id, title, objective, and optional sourceReferences",
    )
    .option("--json", "Output JSON")
    .addHelpText(
      "after",
      `
Input file example (replace the UUID and delivery target for a new delegation):
  {
    "id": "a0000000-0000-4000-a000-000000000001",
    "title": "Share a short story",
    "objective": "Send one short story to Slack channel C0123456789 once, then save the confirmed message reference as the Result."
  }

The objective must contain the authorized scope, target, necessary inputs and completion criteria.
sourceReferences may include durable references needed by a separate background run.

${JOB_HANDOFF_HELP}

Retries:
  Reuse the same UUID and exact creation file after an uncertain response.
  A new UUID creates a separate Task and can duplicate the work.
`,
    )
    .action(
      withErrorHandler(
        async (options: { readonly file: string; readonly json?: boolean }) => {
          const result = await createJob(
            jobCreateSchema.parse(await inputFile(options.file)),
          );
          console.log(
            options.json
              ? JSON.stringify(result)
              : `Task saved: ${result.id}\nStatus: ${result.status}\nBackground execution is managed by the Tasks loop when enabled.\nIn the creating chat, confirm this ID and end the turn; do not also perform the objective.\nLater status: okou task get ${result.id} --json`,
          );
        },
        jsonError,
      ),
    );
  job
    .command("update <id>")
    .description(
      "Background executor: save progress or Results using inspected status/work as expected",
    )
    .requiredOption(
      "--file <path>",
      "JSON with expected {status, work}, status, work, and optional result",
    )
    .option("--json", "Output JSON")
    .addHelpText(
      "after",
      `
Use this from the background Tasks executor after reading the current Task.
Copy its inspected status and work into expected and preserve unchanged work fields.
Completion requires a verified Result and matching work.currentResultId in the same update.
On a conflict, read current state before deciding; never blindly repeat an external action.
The creating chat hands off after create rather than doing the work and completing it here.
`,
    )
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
              : `Task ${result.id}: ${result.status}\nInspect: okou task get ${result.id} --json`,
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
