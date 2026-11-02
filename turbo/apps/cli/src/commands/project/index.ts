import { readCachedProjects as listProjects } from "../../lib/api/domains/project-cache";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import {
  getProject,
  createProject,
  renameProject,
  deleteProject,
} from "../../lib/api/domains/projects";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { isUuid } from "../../lib/utils/uuid";

function operation() {
  return createProjectOperationId(new Date().getTime(), randomUUID());
}
function id(value: string) {
  if (!isUuid(value)) {
    throw new Error("Expected a Project or Thread UUID");
  }
  return value;
}
function name(value: string) {
  const n = value.trim();
  if (!n || n.length > 120) {
    throw new Error("Project name must contain 1 to 120 characters");
  }
  return n;
}
function output(value: unknown, json: boolean | undefined) {
  console.log(JSON.stringify(value, null, json ? undefined : 2));
}
export const projectCommand = new Command("project")
  .description("Manage your private cross-agent Projects")
  .addCommand(
    new Command("list").option("--json", "Print JSON").action(
      withErrorHandler(async (options: { json?: boolean }) => {
        output({ projects: await listProjects() }, options.json);
      }),
    ),
  )
  .addCommand(
    new Command("get")
      .argument("<project-id>")
      .option("--json", "Print JSON")
      .action(
        withErrorHandler(async (value: string, options: { json?: boolean }) => {
          output(await getProject(id(value)), options.json);
        }),
      ),
  )
  .addCommand(
    new Command("create")
      .argument("<name>")
      .option("--from-thread <id>", "Add this existing conversation")
      .option("--json", "Print JSON")
      .action(
        withErrorHandler(
          async (
            value: string,
            options: { json?: boolean; fromThread?: string },
          ) => {
            const op = operation();
            output(
              await createProject({
                id: op,
                eventId: op,
                name: name(value),
                ...(options.fromThread
                  ? { fromThreadId: id(options.fromThread) }
                  : {}),
              }),
              options.json,
            );
          },
        ),
      ),
  )
  .addCommand(
    new Command("update")
      .argument("<project-id>")
      .requiredOption("--name <name>", "New name")
      .option("--json", "Print JSON")
      .action(
        withErrorHandler(
          async (value: string, options: { json?: boolean; name: string }) => {
            output(
              await renameProject(id(value), {
                eventId: operation(),
                name: name(options.name),
              }),
              options.json,
            );
          },
        ),
      ),
  )
  .addCommand(
    new Command("delete")
      .argument("<project-id>")
      .option("--json", "Print JSON")
      .action(
        withErrorHandler(async (value: string, options: { json?: boolean }) => {
          await deleteProject(id(value), operation());
          output(
            { deleted: true, projectId: value, threadsPreserved: true },
            options.json,
          );
        }),
      ),
  );
