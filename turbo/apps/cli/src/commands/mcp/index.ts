import chalk from "chalk";
import { Command, Option } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { callMcpTool, listMcpTools } from "./client";
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

function printCleanupWarning(cleanupWarning: boolean): void {
  if (cleanupWarning) {
    console.error(
      chalk.yellow("Warning: MCP session cleanup did not complete"),
    );
  }
}

const listCommand = new Command()
  .name("list")
  .description(
    "List builtin and custom MCP connectors authorized for this Agent",
  )
  .option("--json", "Print compact JSON")
  .action(
    withErrorHandler(async (options: JsonOptions) => {
      const connectors = (await listRunMcpConnectors()).map((connector) => {
        return {
          kind: connector.kind,
          ...(connector.kind === "custom" ? { id: connector.id } : {}),
          slug: connector.slug,
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
            "KIND".padEnd(7),
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
            connector.kind.padEnd(7),
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
        const connector = await resolveRunMcpConnector(connectorSlug);
        const input = await resolveMcpToolInput(options);
        const result = await callMcpTool(
          connector,
          toolName,
          input,
          options.timeout,
        );
        printCleanupWarning(result.cleanupWarning);
        console.log(
          JSON.stringify(result.value, null, options.json ? undefined : 2),
        );
      },
    ),
  );

export const mcpCommand = new Command()
  .name("mcp")
  .description("Use MCP Custom Connectors authorized for this Agent")
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
  - Select by full slug, UUID, custom:<selector>, or an exact unique display name
  - Available only inside an Agent Run and scoped to its Agent's current authorization
  - Runner remains execution authority; authorization changes may require a new Run
  - Runner applies endpoint policy and injects connector credentials
  - Tool calls are never automatically retried`,
  );
