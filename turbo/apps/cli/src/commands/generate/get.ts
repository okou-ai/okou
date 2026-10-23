import { Command } from "commander";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { getPlatformOrigin } from "../../lib/platform-url";
import {
  downloadWebFile,
  getBuiltInGeneration,
} from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { isPaidToolEnabled } from "../../lib/command/paid-tools";

export function createGetGenerationCommand(): Command {
  const imageEnabled = isPaidToolEnabled("image-generation");
  const command = new Command()
    .name("get")
    .description(
      "Query a built-in generation job once, without waiting or submitting another job",
    )
    .argument("<generation-id>", "Generation ID returned by image submission")
    .option("--json", "Print the complete job status and result as JSON");
  // Reconciliation can submit a queued image to its provider for the first time.
  if (imageEnabled) {
    command.option(
      "--refresh",
      "Advance this job once before querying (file:write); never submits another job",
    );
  }
  return command
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
            refresh: imageEnabled && options.refresh,
          });
          let download: Awaited<ReturnType<typeof downloadWebFile>> | undefined;
          if (options.out && job.status === "completed") {
            if (job.type !== "image" || typeof job.result?.id !== "string") {
              throw new Error(
                "--out requires a completed image job with a file result",
              );
            }
            const reference =
              typeof job.result.url === "string" &&
              parseArtifactReference(job.result.url, await getPlatformOrigin())
                ? job.result.url
                : job.result.id;
            download = await downloadWebFile(reference, options.out);
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
            const refreshFlag = imageEnabled ? " --refresh" : "";
            console.log(
              `Query again: okou generate get ${job.generationId}${refreshFlag}${options.out ? ` --out ${JSON.stringify(options.out)}` : " --json"}`,
            );
          }
        },
      ),
    );
}
