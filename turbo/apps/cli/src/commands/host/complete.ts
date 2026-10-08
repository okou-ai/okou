import { Command } from "commander";
import { z } from "zod";
import { completeHostedSite } from "../../lib/api/domains/host";
import { withErrorHandler } from "../../lib/command/with-error-handler";

export const completeHostedSiteCommand = new Command("complete")
  .description(
    "Retry finalizing an already uploaded deployment without creating a new version",
  )
  .argument(
    "<deployment-id>",
    "Deployment ID returned by a previous publish attempt",
  )
  .option("--json", "Output the completed deployment as JSON")
  .action(
    withErrorHandler(
      async (
        deploymentId: string,
        _options: { readonly json?: boolean },
        command: Command,
      ) => {
        const options = command.optsWithGlobals<{ readonly json?: boolean }>();
        const result = await completeHostedSite(z.uuid().parse(deploymentId));
        console.log(
          options.json
            ? JSON.stringify(result)
            : `Hosted site deployed: ${result.aliasUrl ?? result.url}`,
        );
      },
    ),
  );
