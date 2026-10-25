import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import {
  callDataRouterTool,
  listDataRouterTools,
} from "../../lib/api/data-router-client";
import { isDataRouterToolEnabled } from "../../lib/command/paid-tools";
import { withErrorHandler } from "../../lib/command/with-error-handler";

function inputObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError("--input must contain a JSON object");
  }
  const result = z.record(z.string(), z.json()).safeParse(parsed);
  if (!result.success)
    throw new InvalidArgumentError("--input must contain a JSON object");
  return result.data;
}

export function createDataCommand(): Command {
  const command = new Command("data").description(
    "Discover and call managed research tools from Data Router",
  );
  command
    .command("tools")
    .description("List currently enabled tools from Data Router")
    .option("--json", "Print compact JSON")
    .option("--family <family>", "Filter by the family reported by Router")
    .action(
      withErrorHandler(async (options: { json?: boolean; family?: string }) => {
        const tools = (await listDataRouterTools())
          .filter(isDataRouterToolEnabled)
          .filter((tool) => {
            return (
              !options.family ||
              tool._meta?.["ai.okou/data"]?.family === options.family
            );
          })
          .map(({ name, title, description, _meta }) => {
            return {
              name,
              title,
              description,
              family: _meta?.["ai.okou/data"]?.family,
            };
          });
        console.log(
          JSON.stringify({ tools }, null, options.json ? undefined : 2),
        );
      }),
    );
  command
    .command("describe")
    .description("Read a tool's current input schema and instructions")
    .argument("<tool>", "Tool name from okou data tools")
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(async (name: string, options: { json?: boolean }) => {
        const tool = (await listDataRouterTools()).find((entry) => {
          return entry.name === name && isDataRouterToolEnabled(entry);
        });
        if (!tool)
          throw new InvalidArgumentError(
            `Data tool ${name} is unavailable. Use okou data tools to discover enabled tools.`,
          );
        console.log(JSON.stringify(tool, null, options.json ? undefined : 2));
      }),
    );
  command
    .command("call")
    .description("Call a Data Router tool with its current JSON input")
    .argument("<tool>", "Data Router tool name")
    .requiredOption(
      "--input <json>",
      "Tool arguments as a JSON object",
      inputObject,
    )
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(
        async (
          name: string,
          options: { input: Record<string, unknown>; json?: boolean },
        ) => {
          const result = await callDataRouterTool(name, options.input);
          console.log(
            JSON.stringify(result.body, null, options.json ? undefined : 2),
          );
          if (result.status >= 400) process.exitCode = 1;
        },
      ),
    );
  command.addHelpText(
    "after",
    '\nDiscover tools with okou data tools, then inspect parameters with okou data describe <tool>.\nCall tools with okou data call <tool> --input \'{"parameter":"value"}\'. Results are printed as JSON.\nCalls can consume credits. Follow the tool description for quotes and job status; do not automatically repeat an uncertain paid call.',
  );
  return command;
}
