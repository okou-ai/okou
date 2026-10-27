import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { json, record, string } from "zod";
import { dataRouterFamilyText } from "@okouai/api-contracts/contracts/data-router-tools";
import {
  callDataRouterTool,
  listDataRouterCatalog,
} from "../../lib/api/data-router-client";
import { isDataRouterToolEnabled } from "../../lib/command/paid-tools";
import { withErrorHandler } from "../../lib/command/with-error-handler";

/** Larger bodies go to a file so agent shells do not truncate them. */
const INLINE_BODY_MAX_BYTES = 32 * 1024;
const SHAPE_MAX_KEYS = 50;

function valueKind(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length} items)`;
  if (typeof value === "string") return `string(${value.length} chars)`;
  if (typeof value === "object" && value !== null)
    return `object(${Object.keys(value).length} keys)`;
  return valueKind(value);
}

function topLevelShape(body: unknown) {
  if (Array.isArray(body))
    return {
      type: describeValue(body),
      items: [...new Set(body.map(valueKind))],
    };
  if (typeof body !== "object" || body === null)
    return { type: describeValue(body) };
  const entries = Object.entries(body);
  return {
    type: describeValue(body),
    keys: Object.fromEntries(
      entries.slice(0, SHAPE_MAX_KEYS).map(([key, value]) => {
        return [key, describeValue(value)];
      }),
    ),
    ...(entries.length > SHAPE_MAX_KEYS && {
      omittedKeys: entries.length - SHAPE_MAX_KEYS,
    }),
  };
}

async function printBody(status: number, body: unknown, compact?: boolean) {
  const indent = compact ? undefined : 2;
  const text = JSON.stringify(body, null, indent);
  // The file holds exactly what console.log would print, including its newline.
  const content = `${text}\n`;
  const bytes = Buffer.byteLength(content);
  if (bytes <= INLINE_BODY_MAX_BYTES) {
    console.log(text);
    return;
  }
  // The body can contain sensitive results, so only the owner can read it.
  const directory = await mkdtemp(join(tmpdir(), "okou-data-"));
  const bodyFile = join(directory, "body.json");
  await writeFile(bodyFile, content, { mode: 0o600, flag: "wx" });
  console.log(
    JSON.stringify(
      {
        status,
        bodyFile,
        bytes,
        shape: topLevelShape(body),
        hint: "The response exceeds 32 KB and was written to bodyFile. Read the fields you need from it, for example with jq, instead of printing the whole file.",
      },
      null,
      indent,
    ),
  );
}

function inputObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError("--input must contain a JSON object");
  }
  const result = record(string(), json()).safeParse(parsed);
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
    .option("--family <id>", "Filter by a family ID reported by Router")
    .action(
      withErrorHandler(async (options: { json?: boolean; family?: string }) => {
        const catalog = await listDataRouterCatalog();
        const tools = catalog.tools
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
        const listed = new Set(
          tools.map((tool) => {
            return tool.family;
          }),
        );
        const families = catalog.families
          .filter((family) => {
            return listed.has(family.id);
          })
          .map((family) => {
            return {
              id: family.id,
              title: dataRouterFamilyText(family.title, "en-US", family.id),
              summary: family.summary,
            };
          });
        console.log(
          JSON.stringify(
            { families, tools },
            null,
            options.json ? undefined : 2,
          ),
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
        const tool = (await listDataRouterCatalog()).tools.find((entry) => {
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
          await printBody(result.status, result.body, options.json);
          if (result.status >= 400) process.exitCode = 1;
        },
      ),
    );
  command.addHelpText(
    "after",
    '\nDiscover tools with okou data tools, then inspect parameters with okou data describe <tool>.\nCall tools with okou data call <tool> --input \'{"parameter":"value"}\'. Responses are printed as JSON; a response over 32 KB is written to a private temporary file, and its path and top-level shape are printed instead.\nCalls can consume credits, which are totaled when the Run ends. Do not automatically repeat a paid request whose outcome is uncertain.',
  );
  return command;
}
