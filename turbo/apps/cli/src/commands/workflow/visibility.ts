import { Command } from "commander";
import { setWorkflowVisibility } from "../../lib/api/domains/workflows";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { resolveWorkflowRef } from "./resolve-workflow-ref";

function visibilityCommand(visibility: "public" | "private") {
  const verb = visibility === "public" ? "publish" : "unpublish";
  return new Command(verb)
    .description(
      visibility === "public"
        ? "Share a workflow with the workspace (requires existing publication rights)"
        : "Make a public workflow private (requires existing management rights)",
    )
    .argument("<workflow>", "Workflow ID or name")
    .action(
      withErrorHandler(async (ref: string) => {
        const id = await resolveWorkflowRef(ref);
        const workflow = await setWorkflowVisibility(id, visibility);
        console.log(
          `Workflow "${workflow.name}" is now ${workflow.visibility}`,
        );
        console.log(`View it: okou workflow view ${workflow.id}`);
      }),
    );
}
export const publishCommand = visibilityCommand("public");
export const unpublishCommand = visibilityCommand("private");
