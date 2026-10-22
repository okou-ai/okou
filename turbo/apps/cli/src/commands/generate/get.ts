import { Command } from "commander";
import {
  downloadWebFile,
  getBuiltInGeneration,
} from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const getGenerationCommand = new Command()
  .name("get")
  .description(
    "Query a built-in generation job once, without waiting or submitting another job",
  )
  .argument("<generation-id>", "Generation ID returned by image submission")
  .option("--json", "Print the complete job status and result as JSON")
  .option(
    "--refresh",
    "Advance this job once before querying (file:write); never submits another job",
  )
  .option(
    "--out <path>",
    "Download the image to this path only if the job is completed",
  )
  .action(
    withErrorHandler(
      async (
        generationId: string,
        options: { json?: boolean; out?: string; refresh?: boolean },
      ) => {
        const job = await getBuiltInGeneration(generationId, {
          refresh: options.refresh,
        });
        let download: Awaited<ReturnType<typeof downloadWebFile>> | undefined;
        if (options.out && job.status === "completed") {
          if (job.type !== "image" || typeof job.result?.id !== "string") {
            throw new Error(
              "--out requires a completed image job with a file result",
            );
          }
          download = await downloadWebFile(job.result.id, options.out);
        }
        if (options.json) {
          console.log(
            JSON.stringify({ ...job, ...(download ? { download } : {}) }),
          );
          return;
        }
        console.log(`Generation: ${job.generationId}`);
        console.log(`Type: ${job.type}`);
        console.log(`Status: ${job.status}`);
        if (job.result) {
          console.log(JSON.stringify(job.result, null, 2));
        }
        if (job.error) {
          console.log(`Error: ${job.error.code}: ${job.error.message}`);
        }
        if (download) {
          console.log(`Downloaded: ${download.path}`);
        } else if (job.status === "queued" || job.status === "running") {
          console.log(
            `Query again: okou generate get ${job.generationId} --refresh${options.out ? ` --out ${JSON.stringify(options.out)}` : " --json"}`,
          );
        }
      },
    ),
  );
