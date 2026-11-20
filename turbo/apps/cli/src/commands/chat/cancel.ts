import { randomUUID } from "node:crypto";

import chalk from "chalk";
import { Command } from "commander";

import { sendChatEvent } from "../../lib/api/domains/chat";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { isUuid } from "../../lib/utils/uuid";
import { printChatUsageError, resolveChatThreadId } from "./shared";

interface CancelOptions {
  readonly eventId?: string;
  readonly json?: boolean;
  readonly runId?: string;
  readonly threadId?: string;
}

function resolveTarget(
  options: CancelOptions,
):
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "event"; readonly id: string } {
  const runId = options.runId?.trim();
  const eventId = options.eventId?.trim();
  if (runId && eventId) {
    printChatUsageError(
      "Exactly one of --run-id or --event-id is required",
      "Use --run-id for an active run or --event-id for a queued event.",
    );
  }

  if (runId) {
    if (!isUuid(runId)) {
      printChatUsageError(
        `Invalid run ID "${runId}" — expected a UUID`,
        "Pass a valid UUID with --run-id.",
      );
    }
    return { kind: "run", id: runId };
  }
  if (eventId) {
    if (!isUuid(eventId)) {
      printChatUsageError(
        `Invalid event ID "${eventId}" — expected a UUID`,
        "Pass a valid UUID with --event-id.",
      );
    }
    return { kind: "event", id: eventId };
  }

  printChatUsageError(
    "Exactly one of --run-id or --event-id is required",
    "Use --run-id for an active run or --event-id for a queued event.",
  );
}

export const cancelCommand = new Command()
  .name("cancel")
  .description("Cancel one active run or queued chat event")
  .option(
    "--thread-id <id>",
    "Chat thread ID (defaults to OKOU_CHAT_THREAD_ID)",
  )
  .option("--run-id <id>", "Queued, pending, or running run ID to interrupt")
  .option("--event-id <id>", "Queued chat event ID to revoke")
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Cancel a run:      okou chat cancel --thread-id <thread-id> --run-id <run-id>
  Cancel a message:  okou chat cancel --thread-id <thread-id> --event-id <event-id>

Notes:
  - --run-id and --event-id are mutually exclusive
  - Authenticates via OKOU_TOKEN (requires chat-thread:read and chat-event:write capabilities)`,
  )
  .action(
    withErrorHandler(async (options: CancelOptions) => {
      const threadId = resolveChatThreadId(options.threadId);
      const target = resolveTarget(options);
      const controlEventId = randomUUID();
      const result = await sendChatEvent(
        target.kind === "run"
          ? {
              threadId,
              interruptsRunId: target.id,
              clientEventId: controlEventId,
            }
          : {
              threadId,
              revokesEventId: target.id,
              clientEventId: controlEventId,
            },
      );

      const output = {
        threadId: result.threadId,
        controlEventId,
        targetType: target.kind,
        targetId: target.id,
        createdAt: result.createdAt ?? null,
      };
      if (options.json) {
        console.log(JSON.stringify(output));
        return;
      }

      console.log(
        chalk.green(
          target.kind === "run"
            ? "✓ Chat run cancelled"
            : "✓ Queued chat event cancelled",
        ),
      );
      console.log(chalk.dim(`  Thread: ${output.threadId}`));
      console.log(
        chalk.dim(
          `  ${target.kind === "run" ? "Run" : "Event"}:    ${target.id}`,
        ),
      );
      console.log(chalk.dim(`  Control: ${controlEventId}`));
    }),
  );
