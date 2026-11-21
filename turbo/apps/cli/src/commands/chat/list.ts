import { listProjectThreads } from "../../lib/api/domains/projects";
import chalk from "chalk";
import { Command } from "commander";
import type { EventDrivenChatThread } from "@okouai/core/chat-thread-event-replay";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getChatIndicators } from "../../lib/api/domains/chat";
import { formatIsoTimestamp } from "../../lib/utils/time-format";
import { parseBoundedLogCount } from "../../lib/utils/log-pagination";
import { isUuid } from "../../lib/utils/uuid";
import { syncCachedChatThreads } from "./chat-thread-cache";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface ListOptions {
  readonly projectId?: string;
  readonly project?: boolean;
  readonly archived?: boolean;
  readonly json?: boolean;
  readonly limit?: string;
  readonly unread?: boolean;
}

type UnreadChatThread = EventDrivenChatThread & {
  readonly unreadAt: string;
};

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

function listLimit(options: ListOptions): number {
  if (
    options.projectId &&
    (options.project === false || !isUuid(options.projectId))
  ) {
    throw new Error("Use a valid --project-id without --no-project");
  }
  return options.limit === "all"
    ? Infinity
    : options.limit === undefined
      ? DEFAULT_LIMIT
      : parseBoundedLogCount(options.limit, "--limit", 1, MAX_LIMIT);
}

export const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List web chat threads")
  .option("--project-id <id>", "List chats in this Project")
  .option("--no-project", "List only chats without a Project")
  .option("--unread", "List the latest 50 unread threads from the past 7 days")
  .option("--archived", "List only archived threads")
  .option(
    "--limit <n|all>",
    `Maximum number of threads to print (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  okou chat list
  okou chat list --unread
  okou chat list --project-id <id> --limit all --json

Lists your chats in the current workspace. Supports archived, unread, Project and pagination filters.
`,
  )
  .action(
    withErrorHandler(async (options: ListOptions) => {
      const limit = listLimit(options);
      const allThreads = options.projectId
        ? await listProjectThreads(options.projectId)
        : await syncCachedChatThreads();
      const visibleThreads = allThreads.filter((thread) => {
        return (
          !thread.hidden &&
          (options.project !== false || thread.projectId === null) &&
          (!options.archived || thread.archived)
        );
      });
      let matchingThreads: readonly (
        EventDrivenChatThread | UnreadChatThread
      )[];
      if (options.unread) {
        const indicators = await getChatIndicators();
        matchingThreads = visibleThreads
          .flatMap((thread): UnreadChatThread[] => {
            const unreadAt = indicators.unreadAt[thread.id];
            return indicators.threads[thread.id] === "unread" &&
              unreadAt !== undefined
              ? [{ ...thread, unreadAt }]
              : [];
          })
          .sort(compareUnreadThreads);
      } else {
        matchingThreads = visibleThreads;
      }
      const threads = matchingThreads.slice(0, limit);

      if (options.json) {
        console.log(
          JSON.stringify({
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
