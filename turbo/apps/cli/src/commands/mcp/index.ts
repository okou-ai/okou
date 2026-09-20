import chalk from "chalk";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  mcpToolErrorContentSchema,
  type McpToolErrorIssue,
} from "@okouai/api-contracts/contracts/mcp-tool-errors";
import { Command, Option } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { callMcpTool, listMcpTools, McpCallFailure } from "./client";
import {
  DEFAULT_TIMEOUT_SECONDS,
  parseMcpTimeoutSeconds,
  resolveMcpToolInput,
} from "./input";
import { listRunMcpConnectors, resolveRunMcpConnector } from "./run-connectors";

interface JsonOptions {
  readonly json?: boolean;
}

interface CallOptions extends JsonOptions {
  readonly input?: string;
  readonly inputFile?: string;
  readonly timeout: number;
}

interface McpJsonFailure {
  readonly status: "error";
  readonly error: {
    readonly kind: "client" | "tool" | "protocol" | "transport";
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly issues?: readonly McpToolErrorIssue[];
  };
  readonly result?: CallToolResult;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "MCP command failed";
}

function toolFailure(result: CallToolResult): McpJsonFailure {
  const structured = mcpToolErrorContentSchema.safeParse(
    result.structuredContent,
  );
  const error = structured.success
    ? structured.data.error
    : {
        code: "tool_error",
        message: "MCP tool returned an error",
        retryable: false,
      };
  return {
    status: "error",
    error: { kind: "tool", ...error },
    result,
  };
}

function commandFailure(error: McpCallFailure): McpJsonFailure {
  return {
    status: "error",
    error: {
      kind: error.kind,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  };
}

function printCleanupWarning(cleanupWarning: boolean): void {
  if (cleanupWarning) {
    console.error(
      chalk.yellow("Warning: MCP session cleanup did not complete"),
    );
  }
}

const listCommand = new Command()
  .name("list")
  .description("List MCP connectors authorized for this Agent")
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(async (options: JsonOptions) => {
      const connectors = (await listRunMcpConnectors()).map((connector) => {
        return {
          slug: connector.slug,
          target: connector.target,
          connectionId: connector.connectionId,
          displayName: connector.displayName,
          transport: connector.transport,
          endpoint: connector.endpoint,
          connected: connector.connected,
        };
      });

      if (options.json) {
        console.log(JSON.stringify({ connectors }));
        return;
      }
      if (connectors.length === 0) {
        console.log(
          chalk.dim("No MCP connectors are authorized for this Agent"),
        );
        return;
      }

      const slugWidth = Math.max(
        "SLUG".length,
        ...connectors.map((connector) => {
          return connector.slug.length;
        }),
      );
      const statusWidth = "DISCONNECTED".length;
      console.log(
        chalk.dim(
          [
            "SLUG".padEnd(slugWidth),
            "STATUS".padEnd(statusWidth),
            "TRANSPORT",
            "ENDPOINT",
          ].join("  "),
        ),
      );
      for (const connector of connectors) {
        const status = connector.connected ? "connected" : "disconnected";
        console.log(
          [
            connector.slug.padEnd(slugWidth),
            status.padEnd(statusWidth),
            connector.transport,
            connector.endpoint,
          ].join("  "),
        );
      }
    }),
  );

const listToolsCommand = new Command()
  .name("list-tools")
  .description("List tools exposed by an authorized MCP connector")
  .argument(
    "<selector>",
    "MCP connector slug, custom UUID, or unique display name; builtin: and custom: prefixes accepted",
  )
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(async (connectorSlug: string, options: JsonOptions) => {
      const connector = await resolveRunMcpConnector(connectorSlug);
      const result = await listMcpTools(connector, DEFAULT_TIMEOUT_SECONDS);
      printCleanupWarning(result.cleanupWarning);

      if (options.json) {
        console.log(
          JSON.stringify({
            connectorSlug: connector.slug,
            tools: result.value,
          }),
        );
        return;
      }
      if (result.value.length === 0) {
        console.log(
          chalk.dim(`MCP connector "${connector.slug}" exposes no tools`),
        );
        return;
      }

      for (const tool of result.value) {
        console.log(chalk.cyan(`Tool: ${JSON.stringify(tool.name)}`));
        if (tool.description !== undefined) {
          console.log(`  Description: ${JSON.stringify(tool.description)}`);
        }
        console.log("  Input schema:");
        const schema = JSON.stringify(tool.inputSchema, null, 2)
          .split("\n")
          .map((line) => {
            return `    ${line}`;
          })
          .join("\n");
        console.log(schema);
      }
    }),
  );

const inputOption = new Option(
  "--input <json>",
  "Tool input as a JSON object",
).conflicts("inputFile");
const inputFileOption = new Option(
  "--input-file <path>",
  "Read the tool input JSON object from a file",
).conflicts("input");

const callCommand = new Command()
  .name("call")
  .description("Call one tool on an authorized MCP connector")
  .argument(
    "<selector>",
    "MCP connector slug, custom UUID, or unique display name; builtin: and custom: prefixes accepted",
  )
  .argument("<tool-name>", "Exact MCP tool name")
  .addOption(inputOption)
  .addOption(inputFileOption)
  .option(
    "--timeout <duration>",
    "Overall timeout from 1s to 15m",
    parseMcpTimeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  )
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(
      async (connectorSlug: string, toolName: string, options: CallOptions) => {
        let clientFailureCode = "connector_resolution_failed";
        try {
          const connector = await resolveRunMcpConnector(connectorSlug);
          clientFailureCode = "invalid_input";
          const input = await resolveMcpToolInput(options);
          clientFailureCode = "command_failed";
          const result = await callMcpTool(
            connector,
            toolName,
            input,
            options.timeout,
          );
          printCleanupWarning(result.cleanupWarning);
          if (result.value.isError === true) {
            console.log(
              JSON.stringify(
                options.json ? toolFailure(result.value) : result.value,
                null,
                options.json ? undefined : 2,
              ),
            );
            process.exitCode = 1;
            return;
          }
          console.log(
            JSON.stringify(result.value, null, options.json ? undefined : 2),
          );
        } catch (error) {
          if (!options.json) {
            throw error;
          }
          const failure =
            error instanceof McpCallFailure
              ? error
              : new McpCallFailure(
                  "client",
                  clientFailureCode,
                  safeErrorMessage(error),
                  false,
                );
          console.log(JSON.stringify(commandFailure(failure)));
          process.exitCode = 1;
        }
      },
    ),
  );

export const mcpCommand = new Command()
  .name("mcp")
  .description("Use MCP connectors authorized for this Agent")
  .addCommand(listCommand)
  .addCommand(listToolsCommand)
  .addCommand(callCommand)
  .addHelpText(
    "after",
    `
Examples:
  List authorized MCP connectors: okou mcp list
  List connector tools:          okou mcp list-tools _acme-mcp --json
  Select by display name:        okou mcp list-tools "Acme MCP" --json
  Call a tool:                   okou mcp call _acme-mcp search --input '{"query":"okou"}' --json
  Pipe tool input:               printf '{"query":"okou"}' | okou mcp call _acme-mcp search

Notes:
  - Select by full slug, custom UUID, builtin:<selector>, custom:<selector>, or an exact unique display name
  - Available only inside an Agent Run and scoped to its Agent's current authorization
  - Runner remains execution authority; authorization changes may require a new Run
  - Runner applies endpoint policy and injects connector credentials
  - Successful call JSON is the raw MCP result; failed --json calls use a stable error envelope
  - Tool errors preserve the raw MCP result and exit nonzero; Okou structured details are used when present
  - Tool calls are never automatically retried`,
  );
