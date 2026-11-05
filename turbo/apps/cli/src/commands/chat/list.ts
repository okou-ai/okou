import { singleAgentEnabled } from "../../lib/api/single-agent";
import {
  personalCommandMode,
  personalExecutorId,
} from "../../lib/command/single-agent";
import { listProjectThreads } from "../../lib/api/domains/projects";
import chalk from "chalk";
import { Command } from "commander";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getChatIndicators } from "../../lib/api/domains/chat";
import { formatIsoTimestamp } from "../../lib/utils/time-format";
import { parseBoundedLogCount } from "../../lib/utils/log-pagination";
import { isUuid } from "../../lib/utils/uuid";
import { getOkouAgentId } from "../../lib/okou-env";
import { syncCachedChatThreads } from "./chat-thread-cache";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface ListOptions {
  readonly projectId?: string;
  readonly project?: boolean;
  readonly agent?: string;
  readonly allAgents?: boolean;
  readonly archived?: boolean;
  readonly json?: boolean;
  readonly limit?: string;
  readonly unread?: boolean;
}

type UnreadChatThread = EventDrivenChatThread & {
  readonly unreadAt: string;
};

function printUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

function resolveAgentId(flagAgentId: string | undefined): string {
  const agentId = flagAgentId?.trim() || getOkouAgentId()?.trim();
  if (!agentId) {
    printUsageError(
      "OKOU_AGENT_ID is not set",
      "Pass --agent <agent-id> or run inside an agent sandbox.",
    );
  }
  if (!isUuid(agentId)) {
    printUsageError(
      `Invalid agent ID "${agentId}" — expected a UUID`,
      "Pass a valid UUID with --agent <agent-id>.",
    );
  }
  return agentId;
}

function titleForDisplay(title: string | null): string {
  return (title ?? "(untitled)").replace(/\s+/g, " ");
}

function compareUnreadThreads(
  left: UnreadChatThread,
  right: UnreadChatThread,
): number {
  return (
    right.unreadAt.localeCompare(left.unreadAt) ||
    right.id.localeCompare(left.id)
  );
}

async function listScope(options: ListOptions) {
  const personal = await singleAgentEnabled();
  if (
    personal &&
    (options.agent !== undefined || options.allAgents !== undefined)
  ) {
    throw new Error(
      "Agent selection is unavailable in My Okou. Remove --agent/--all-agents.",
    );
  }
  if (options.allAgents && options.agent !== undefined) {
    printUsageError(
      "--all-agents and --agent are mutually exclusive",
      "Choose one agent with --agent, or omit it to list all agents.",
    );
  }
  if (
    options.projectId &&
    (options.project === false || !isUuid(options.projectId))
  ) {
    throw new Error("Use a valid --project-id without --no-project");
  }
  const agentId =
    personal && options.projectId === undefined
      ? await personalExecutorId()
      : options.allAgents ||
          (options.projectId !== undefined && options.agent === undefined)
        ? undefined
        : resolveAgentId(options.agent);
  const limit =
    options.limit === "all"
      ? Infinity
      : options.limit === undefined
        ? DEFAULT_LIMIT
        : parseBoundedLogCount(options.limit, "--limit", 1, MAX_LIMIT);
  return { agentId, limit };
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List web chat threads")
  .option("--agent <id>", "Filter by agent ID (defaults to OKOU_AGENT_ID)")
  .option("--all-agents", "List threads across all agents in the current org")
  .option("--project-id <id>", "List chats in this Project")
  .option("--no-project", "List only chats without a Project")
  .option("--unread", "List the latest 50 unread threads from the past 7 days")
  .option("--archived", "List only archived threads")
  .option(
    "--limit <n|all>",
    `Maximum number of threads to print (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText("after", ({ command }) => {
    return personalCommandMode(command)
      ? `
Examples:
  okou chat list
  okou chat list --unread
  okou chat list --project-id <id> --limit all --json

Lists your chats in the current workspace executor scope. Supports archived,
unread, Project and pagination filters. Existing historical chats remain available
by their authorized thread IDs; this command does not reassign them.
`
      : `
Examples:
  List this agent's chats:  okou chat list
  List another agent:       okou chat list --agent <agent-id>
  List unread chats:        okou chat list --unread
  Unread across all agents: okou chat list --unread --all-agents
  List archived chats:      okou chat list --archived
  Limit the output:         okou chat list --limit 10
  Print JSON:               okou chat list --json

Notes:
  - Defaults --agent to OKOU_AGENT_ID
  - --all-agents and --agent are mutually exclusive
  - Listing and --unread require chat-thread:read
  - Reading a selected thread with okou chat messages requires chat-event:read
  - Authenticates via OKOU_TOKEN
  - Replays cached snapshot and incremental chat thread events`;
  })
  .action(
    withErrorHandler(async (options: ListOptions) => {
      const { agentId, limit } = await listScope(options);
      const allThreads = options.projectId
        ? await listProjectThreads(options.projectId)
        : await syncCachedChatThreads();
      const agentThreads = allThreads.filter((thread) => {
        return (
          (agentId === undefined || thread.agentId === agentId) &&
          (options.project !== false || thread.projectId === null) &&
          (!options.archived || thread.archived)
        );
      });
      let matchingThreads: readonly (
        EventDrivenChatThread | UnreadChatThread
      )[];
      if (options.unread) {
        const indicators = await getChatIndicators();
        matchingThreads = agentThreads
          .flatMap((thread): UnreadChatThread[] => {
            const unreadAt = indicators.unreadAt[thread.id];
            return indicators.threads[thread.id] === "unread" &&
              unreadAt !== undefined
              ? [{ ...thread, unreadAt }]
              : [];
          })
          .sort(compareUnreadThreads);
      } else {
        matchingThreads = agentThreads;
      }
      const threads = matchingThreads.slice(0, limit);

      if (options.json) {
        console.log(
          JSON.stringify({
            ...(agentId === undefined ? { allAgents: true } : { agentId }),
            total: matchingThreads.length,
            ...(options.projectId !== undefined || options.limit === "all"
              ? { complete: threads.length === matchingThreads.length }
              : {}),
            threads,
          }),
        );
        return;
      }

      if (threads.length === 0) {
        console.log(
          chalk.dim(
            options.unread
              ? "No unread chat threads found"
              : options.archived
                ? "No archived chat threads found"
                : "No chat threads found",
          ),
        );
        return;
      }

      const header = [
        "THREAD ID".padEnd(38),
        ...(options.allAgents ? ["AGENT ID".padEnd(38)] : []),
        ...(options.unread ? ["UNREAD AT".padEnd(20)] : []),
        "SORTED".padEnd(20),
        "PINNED".padEnd(6),
        "ARCHIVED".padEnd(8),
        "TITLE",
      ].join("  ");
      console.log(chalk.dim(header));
      for (const thread of threads) {
        console.log(
          [
            thread.id.padEnd(38),
            ...(options.allAgents ? [thread.agentId.padEnd(38)] : []),
            ...("unreadAt" in thread
              ? [formatIsoTimestamp(thread.unreadAt).padEnd(20)]
              : []),
            formatIsoTimestamp(thread.sortAt).padEnd(20),
            (thread.pinnedAt === null ? "-" : "yes").padEnd(6),
            (thread.archived ? "yes" : "-").padEnd(8),
            titleForDisplay(thread.title),
          ].join("  "),
        );
      }

      if (threads.length < matchingThreads.length) {
        console.log();
        console.log(
          chalk.dim(
            `  Showing ${threads.length} of ${matchingThreads.length} threads. Use --limit to adjust.`,
          ),
        );
      }
    }),
  );
