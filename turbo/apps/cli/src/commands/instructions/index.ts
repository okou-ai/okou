import { readFile } from "node:fs/promises";
import { Command, Option } from "commander";
import { instructionsRequestSchema } from "@okouai/api-contracts/contracts/instructions";
import {
  getInstructions,
  updateInstructions,
} from "../../lib/api/domains/instructions";
import { singleAgentEnabled } from "../../lib/api/single-agent";
import { withErrorHandler } from "../../lib/command/with-error-handler";

async function requirePersonalInstructions() {
  if (!(await singleAgentEnabled())) {
    throw new Error(
      "Personal Instructions are unavailable in this context. Use okou agent --help for the current experience.",
    );
  }
}

async function readContent(file: string): Promise<string> {
  if (file !== "-") {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(file),
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(chunks),
  );
}

export function createInstructionsCommand(): Command {
  return new Command("instructions")
    .description("Read or replace your personal Instructions in this workspace")
    .addHelpText(
      "after",
      "\nSaved Instructions apply the next time Okou starts working. Work in progress won't change.\nNo user or Agent target is accepted. An empty file intentionally clears the document.",
    )
    .addCommand(
      new Command("view")
        .description(
          "Read the latest saved personal document, not work in progress",
        )
        .addOption(
          new Option("--raw", "Write only the exact content bytes").conflicts(
            "json",
          ),
        )
        .option(
          "--json",
          "Print orgId, userId, content, updatedAt and opaque version",
        )
        .action(
          withErrorHandler(
            async (options: { raw?: boolean; json?: boolean }) => {
              await requirePersonalInstructions();
              const saved = await getInstructions();
              if (options.raw) process.stdout.write(saved.content);
              else if (options.json) console.log(JSON.stringify(saved));
              else {
                console.log(
                  `Personal Instructions — user ${saved.userId}, workspace ${saved.orgId}`,
                );
                console.log(
                  `Saved version: ${saved.version} (${saved.updatedAt})`,
                );
                console.log(
                  "Used the next time Okou starts working. Work in progress won't change.\n",
                );
                process.stdout.write(saved.content);
              }
            },
          ),
        ),
    )
    .addCommand(
      new Command("edit")
        .description(
          "Replace the saved document with exact file or stdin content",
        )
        .requiredOption(
          "--file <path>",
          "UTF-8 file, or - to read stdin (empty is valid)",
        )
        .option(
          "--if-version <version>",
          "Save only if this opaque version is still current",
        )
        .option("--json", "Print the saved document as JSON")
        .addHelpText(
          "after",
          "\nOmitting --if-version explicitly replaces the document unconditionally.\nExample: okou instructions edit --file - --if-version <version> < instructions.md",
        )
        .action(
          withErrorHandler(
            async (options: {
              file: string;
              ifVersion?: string;
              json?: boolean;
            }) => {
              await requirePersonalInstructions();
              const body = instructionsRequestSchema.parse({
                content: await readContent(options.file),
                ...(options.ifVersion === undefined
                  ? {}
                  : { ifVersion: options.ifVersion }),
              });
              const saved = await updateInstructions(body);
              if (options.json) console.log(JSON.stringify(saved));
              else
                console.log(
                  "Instructions saved. Used the next time Okou starts working. Work in progress won't change.",
                );
            },
          ),
        ),
    );
}
