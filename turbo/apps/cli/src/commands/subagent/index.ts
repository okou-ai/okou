import { readFile } from "node:fs/promises";
import { Command } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { requirePiSession } from "../../lib/pi-session-env";
import {
  inspectSubagent,
  killSubagent,
  listSubagents,
  startSubagent,
  steerSubagent,
  type SubagentLaunchOptions,
} from "../../lib/pi-subagents";

async function readPrompt(
  prompt: string | undefined,
  file: string | undefined,
): Promise<string> {
  if ((prompt === undefined) === (file === undefined)) {
    throw new Error("Provide either PROMPT or -f PROMPT_FILE, but not both.");
  }
  const text = file === undefined ? prompt : await readFile(file, "utf8");
  if (!text?.trim()) throw new Error("The prompt must not be empty.");
  return text;
}

export function createSubagentCommand(
  options: SubagentLaunchOptions = {},
): Command {
  const command = new Command("subagent")
    .description("Manage background Pi subagents in the current Run")
    .addHelpText(
      "after",
      "\nPi sessions only. All subagents belong to the Run, not their creator. Any Pi session in this Run can stop a subagent by ID without stopping other subagents. Run teardown stops all remaining processes. Temporary logs are deleted best effort on completion; write deliverables to the workspace. IDs are not reused within a Run. Start confirms process launch, not model readiness; inspect stderr for later failures. Steering is fire-and-forget (4096-byte frame limit).\n",
    )
    .hook("preAction", () => {
      return requirePiSession();
    });

  command
    .command("list")
    .description("List running subagents in this Run")
    .action(
      withErrorHandler(async () => {
        const items = await listSubagents();
        if (items.length === 0) {
          console.log(
            "No running subagents. Start one with: okou subagent start -f PROMPT_FILE",
          );
          return;
        }
        console.log("ID\tPID\tSTDOUT\tSTDERR");
        for (const item of items)
          console.log(
            `${item.id}\t${item.pid}\t${item.stdout}\t${item.stderr}`,
          );
      }),
    );

  command
    .command("inspect <subagent-id>")
    .description("Show a subagent's PID, status and stdout/stderr paths")
    .action(
      withErrorHandler(async (id: string) => {
        console.log(JSON.stringify(await inspectSubagent(id), null, 2));
      }),
    );

  command
    .command("start [prompt]")
    .description(
      "Launch an independent Pi process without waiting for model readiness",
    )
    .option("-f, --file <prompt-file>", "Read the prompt from a UTF-8 file")
    .action(
      withErrorHandler(
        async (prompt: string | undefined, flags: { file?: string }) => {
          const item = await startSubagent(
            await readPrompt(prompt, flags.file),
            options,
          );
          console.log(JSON.stringify(item, null, 2));
          console.log(`Inspect: okou subagent inspect ${item.id}`);
        },
      ),
    );

  command
    .command("steer [prompt]")
    .description(
      "Write an instruction without waiting for child acknowledgement",
    )
    .requiredOption(
      "-p, --process <subagent-id>",
      "Subagent ID (not the OS PID)",
    )
    .option(
      "-f, --file <prompt-file>",
      "Read the instruction from a UTF-8 file",
    )
    .action(
      withErrorHandler(
        async (
          prompt: string | undefined,
          flags: { process: string; file?: string },
        ) => {
          await steerSubagent(
            flags.process,
            await readPrompt(prompt, flags.file),
          );
          console.log(
            `Instruction written to subagent ${flags.process}; execution is not acknowledged.`,
          );
        },
      ),
    );

  command
    .command("kill <subagent-id>")
    .description(
      "Stop a child and its tools, then best-effort remove its directory",
    )
    .action(
      withErrorHandler(async (id: string) => {
        await killSubagent(id);
        console.log(
          `Subagent ${id} stopped. Temporary directory removal was best effort.`,
        );
      }),
    );
  return command;
}

export const subagentCommand = createSubagentCommand();
