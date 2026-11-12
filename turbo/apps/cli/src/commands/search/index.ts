import { singleAgentEnabled } from "../../lib/api/single-agent";
import { personalExecutorId } from "../../lib/command/single-agent";
import { Command } from "commander";
import chalk from "chalk";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { searchChat } from "../../lib/api/domains/chat";
import type {
  ChatSearchMessage,
  ChatSearchResponse,
} from "@okouai/api-contracts/contracts/chat-threads";
import { formatIsoTimestamp } from "../../lib/utils/time-format";
import { parseSearchQuery } from "../../lib/utils/search-query";
import { isUuid } from "../../lib/utils/uuid";

const SUPPORTED_SOURCES = ["agent-session", "chat", "slack"] as const;
type Source = (typeof SUPPORTED_SOURCES)[number];

export const SEARCH_EXPLAINER = `
Available sources:
  agent-session  locates local Claude Code and Codex session files for direct analysis
  chat           user/assistant text messages from web chat (up to 25 newest matches)
  slack          returns a recipe for calling the Slack API directly; requires the Slack connector

Usage: okou search <query> --source <agent-session|chat|slack> [flags]
Run 'okou search --help' for all flags.`;

function buildAgentSessionGuidance(query: string): string {
  return `Agent session files are available at both locations:

  Claude Code: /home/user/.claude/projects/-home-user-workspace/
  Codex:       /home/user/.codex/sessions/

A single thread may use both Claude Code and Codex, so inspect both locations.
You can analyze these session files directly for: ${query}`;
}

export function buildSlackRecipe(query: string): string {
  const encoded = encodeURIComponent(query);
  return `The \`slack\` source does not call Slack from this CLI. Run the
following inside an agent sandbox that has $SLACK_TOKEN available:

  curl -H "Authorization: Bearer $SLACK_TOKEN" \\
    "https://slack.com/api/search.messages?query=${encoded}"

If you don't have $SLACK_TOKEN, check the connector status:
  okou connector status slack

To verify the token and network policy end-to-end:
  okou connector check --env-name SLACK_TOKEN

Slack API docs: https://api.slack.com/methods/search.messages

Note: --agent is ignored for the slack source.
Add time filters directly to the Slack search query.`;
}

interface SearchOptions {
  source: string[];
  agent?: string;
}

function collectSource(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function formatTimestamp(iso: string): string {
  return formatIsoTimestamp(iso);
}

function renderChatMessage(msg: ChatSearchMessage): void {
  const header = `${chalk.yellow("▸")} ${chalk.dim(msg.role)} ${chalk.dim(formatTimestamp(msg.createdAt))}`;
  console.log(header);
  console.log(msg.content);
}

function renderChatResults(
  response: ChatSearchResponse,
  personal: boolean,
): void {
  let isFirst = true;
  for (const result of response.results) {
    if (!isFirst) console.log();
    isFirst = false;

    console.log(
      chalk.bold(
        `── Thread ${result.chatThreadId}${personal ? "" : ` (${result.agentName})`} ──────────`,
      ),
    );
    renderChatMessage(result.matchedMessage);
  }
}

async function runChatSource(
  query: string,
  options: SearchOptions,
): Promise<void> {
  const personal = await singleAgentEnabled();
  if (personal && options.agent !== undefined)
    throw new Error(
      "Agent selection is unavailable in My Okou. Remove --agent.",
    );
  if (options.agent !== undefined && !isUuid(options.agent)) {
    console.error(
      chalk.red(`✗ Invalid agent ID "${options.agent}" — expected a UUID`),
    );
    process.exit(1);
  }

  const response = await searchChat({
    keyword: query,
    agentId: personal ? await personalExecutorId() : options.agent,
  });

  if (response.results.length === 0) {
    console.log(chalk.dim("No matches found"));
    console.log(chalk.dim("  Try a different keyword"));
    return;
  }

  renderChatResults(response, personal);
}

async function runSlackSource(
  query: string,
  _options: SearchOptions,
): Promise<void> {
  console.log(buildSlackRecipe(query));
}

async function runAgentSessionSource(
  query: string,
  _options: SearchOptions,
): Promise<void> {
  console.log(buildAgentSessionGuidance(query));
}

export const searchCommand = new Command()
  .name("search")
  .description("Search chat or locate sources for direct analysis")
  .argument("<query>", "Search query")
  .option(
    "--source <type>",
    "Source to search: agent-session | chat | slack (pass once)",
    collectSource,
    [] as string[],
  )
  .option("--agent <id>", "Filter by agent ID")
  .addHelpText("after", SEARCH_EXPLAINER)
  .action(
    withErrorHandler(async (query: string, options: SearchOptions) => {
      const searchQuery = parseSearchQuery(query, "Query");
      const sources = options.source;

      if (sources.length === 0) {
        console.log(SEARCH_EXPLAINER);
        return;
      }

      if (sources.length > 1) {
        throw new Error("Only one --source is allowed.");
      }

      const source = sources[0]!;
      if (!SUPPORTED_SOURCES.includes(source as Source)) {
        throw new Error(
          `Unknown --source "${source}". Expected one of: ${SUPPORTED_SOURCES.join(", ")}`,
        );
      }

      switch (source as Source) {
        case "agent-session":
          await runAgentSessionSource(searchQuery, options);
          return;
        case "chat":
          await runChatSource(searchQuery, options);
          return;
        case "slack":
          await runSlackSource(searchQuery, options);
          return;
      }
    }),
  );
