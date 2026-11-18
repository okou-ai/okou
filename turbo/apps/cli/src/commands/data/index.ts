import { Command, InvalidArgumentError } from "commander";
import { json, record, string } from "zod";
import { dataRouterFamilyText } from "@okouai/api-contracts/contracts/data-router-tools";
import {
  callDataRouterTool,
  listDataRouterCatalog,
} from "../../lib/api/data-router-client";
import { isDataRouterToolEnabled } from "../../lib/command/paid-tools";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { jsonOutline, selectJsonPath } from "./json-outline";
import {
  findReusableResponse,
  readJsonFile,
  readSavedCalls,
  saveResponse,
  savedResponsesDir,
  type SavedCall,
} from "./saved-responses";

/** `show` prints selected values inline up to this size, otherwise an outline. */
const SHOW_INLINE_MAX_BYTES = 32 * 1024;
const DEFAULT_SHOW_LIMIT = 20;
const DEFAULT_HISTORY_LIMIT = 50;

function printJson(value: unknown, compact?: boolean) {
  console.log(JSON.stringify(value, null, compact ? undefined : 2));
}

function callSummary(
  saved: SavedCall,
  body: unknown,
  reused: boolean,
): Record<string, unknown> {
  const next = reused
    ? `No request was sent: this identical call was saved at ${saved.savedAt}. Read it with okou data show ${saved.seq} <path>, or add --refresh to request new data.`
    : saved.status >= 400
      ? `The call failed with status ${saved.status}; the error body is saved in file.`
      : `Read fields with okou data show ${saved.seq} <path> or parse file locally. If parsing fails or finds nothing, fix the parsing on this file instead of calling again; okou data history lists saved responses.`;
  return {
    status: saved.status,
    ...(saved.requestId ? { requestId: saved.requestId } : {}),
    file: saved.file,
    bytes: saved.bytes,
    ...(reused ? { reused: true, savedAt: saved.savedAt } : {}),
    outline: jsonOutline(body),
    next,
  };
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new InvalidArgumentError("must be a positive integer");
  return parsed;
}

async function resolveSavedFile(ref: string): Promise<string> {
  if (!/^\d+$/.test(ref)) return ref;
  const seq = Number(ref);
  const saved = (await readSavedCalls()).find((call) => {
    return call.seq === seq;
  });
  if (!saved)
    throw new InvalidArgumentError(
      `No saved response ${ref}. Use okou data history to list saved responses.`,
    );
  return saved.file;
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
    .description(
      "Call a Data Router tool, save its full response and print an outline",
    )
    .argument("<tool>", "Data Router tool name")
    .requiredOption(
      "--input <json>",
      "Tool arguments as a JSON object",
      inputObject,
    )
    .option(
      "--refresh",
      "Send the request even when an identical call already has a saved response",
    )
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(
        async (
          name: string,
          options: {
            input: Record<string, unknown>;
            refresh?: boolean;
            json?: boolean;
          },
        ) => {
          const reusable = options.refresh
            ? undefined
            : await findReusableResponse(name, options.input);
          if (reusable) {
            printJson(
              callSummary(reusable.saved, reusable.body, true),
              options.json,
            );
            return;
          }
          const result = await callDataRouterTool(name, options.input);
          const saved = await saveResponse({
            tool: name,
            input: options.input,
            status: result.status,
            body: result.body,
            ...(result.requestId ? { requestId: result.requestId } : {}),
            requestHistory: result.requestHistory,
          });
          printJson(callSummary(saved, result.body, false), options.json);
          if (result.status >= 400) process.exitCode = 1;
        },
      ),
    );
  command
    .command("show")
    .description("Read a saved response or any JSON file, optionally at a path")
    .argument(
      "<ref>",
      "Saved response number from okou data call or history, or a JSON file path",
    )
    .argument(
      "[path]",
      "Field path such as data.items, data.items[0].title or data.items[].title",
    )
    .option(
      "--limit <count>",
      `Maximum array items to print (default: ${DEFAULT_SHOW_LIMIT})`,
      positiveInteger,
    )
    .option("--outline", "Print the field outline instead of values")
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(
        async (
          ref: string,
          path: string | undefined,
          options: { limit?: number; outline?: boolean; json?: boolean },
        ) => {
          const file = await resolveSavedFile(ref);
          const selected = selectJsonPath(await readJsonFile(file), path ?? "");
          const location = { file, path: path ?? "" };
          if (options.outline) {
            printJson(
              { ...location, outline: jsonOutline(selected) },
              options.json,
            );
            return;
          }
          const limit = options.limit ?? DEFAULT_SHOW_LIMIT;
          const truncated =
            Array.isArray(selected) && selected.length > limit
              ? { count: selected.length, shown: limit }
              : Array.isArray(selected)
                ? { count: selected.length }
                : {};
          const value = Array.isArray(selected)
            ? selected.slice(0, limit)
            : selected;
          const bytes = Buffer.byteLength(JSON.stringify(value) ?? "");
          if (bytes > SHOW_INLINE_MAX_BYTES) {
            printJson(
              {
                ...location,
                ...truncated,
                bytes,
                outline: jsonOutline(value),
                next: "The selected value exceeds 32 KB. Choose a narrower path or a lower --limit.",
              },
              options.json,
            );
            return;
          }
          printJson({ ...location, ...truncated, value }, options.json);
        },
      ),
    );
  command
    .command("history")
    .description("List responses saved by okou data call in this sandbox")
    .option("--tool <name>", "Only list calls to this tool")
    .option(
      "--limit <count>",
      `Maximum recent calls to list (default: ${DEFAULT_HISTORY_LIMIT})`,
      positiveInteger,
    )
    .option("--json", "Print compact JSON")
    .action(
      withErrorHandler(
        async (options: { tool?: string; limit?: number; json?: boolean }) => {
          const calls = (await readSavedCalls())
            .filter((call) => {
              return !options.tool || call.tool === options.tool;
            })
            .sort((left, right) => {
              return left.seq - right.seq;
            })
            .slice(-(options.limit ?? DEFAULT_HISTORY_LIMIT))
            .map(({ seq, savedAt, tool, status, bytes, file, input }) => {
              return { seq, savedAt, tool, status, bytes, file, input };
            });
          printJson({ dir: await savedResponsesDir(), calls }, options.json);
        },
      ),
    );
  command.addHelpText(
    "after",
    '\nDiscover tools with okou data tools, then inspect parameters with okou data describe <tool>.\nCall tools with okou data call <tool> --input \'{"parameter":"value"}\'. Every response is saved unchanged to a numbered private file; the call prints its path and a field outline. Read fields with okou data show <number> <path> and list saved responses with okou data history.\nAn identical call reuses its saved successful response without sending a request; add --refresh when new data is needed, such as when polling a job.\nCalls can consume credits, which are totaled when the Run ends. Do not automatically repeat a paid request whose outcome is uncertain.',
  );
  return command;
}
