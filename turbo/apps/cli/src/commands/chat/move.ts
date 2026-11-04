import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { moveChatToProject } from "../../lib/api/domains/projects";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { isUuid } from "../../lib/utils/uuid";
import { resolveChatThreadId } from "./shared";
export const moveCommand = new Command("move")
  .description(
    "Join, move, or leave a Project without changing Agent or history",
  )
  .option("--thread-id <id>", "Conversation to move")
  .option("--project-id <id>", "Destination Project")
  .option("--no-project", "Remove the conversation from its Project")
  .option("--json", "Print JSON")
  .action(
    withErrorHandler(
      async (options: {
        threadId?: string;
        projectId?: string;
        project?: boolean;
      }) => {
        if ((options.project === false) === (options.projectId !== undefined)) {
          throw new Error("Choose exactly one of --project-id or --no-project");
        }
        if (options.projectId !== undefined && !isUuid(options.projectId)) {
          throw new Error("Expected a Project UUID");
        }
        const result = await moveChatToProject(
          resolveChatThreadId(options.threadId),
          options.projectId ?? null,
          createProjectOperationId(new Date().getTime(), randomUUID()),
        );
        console.log(JSON.stringify(result));
      },
    ),
  );
