import { setTimeout as delay } from "node:timers/promises";
import type {
  ComputerUseCommandResponse,
  ComputerUseCommandCreateResponse,
} from "@okouai/api-contracts/contracts/computer-use";
import { getComputerUseCommand } from "../../lib/api/domains/computer-use";
import {
  createRealtimeNotifier,
  type RealtimeNotifier,
} from "../../lib/realtime-notifier";

export async function waitForComputerUseCommand(
  created: ComputerUseCommandCreateResponse,
  timeoutSeconds: number,
  format: (
    command: ComputerUseCommandResponse,
    signal: AbortSignal,
  ) => Promise<string>,
  options: {
    readonly progress?: boolean;
    readonly timeoutGuidance?: string;
  } = {},
): Promise<void> {
  const progress = options.progress ?? true;
  const commandId = created.commandId;
  const deadline = Date.now() + timeoutSeconds * 1000;
  const owner = new AbortController();
  const deadlineTimer = setTimeout(() => {
    return owner.abort();
  }, timeoutSeconds * 1000);
  const signal = owner.signal;
  let notifier: RealtimeNotifier | undefined;
  try {
    while (Date.now() <= deadline) {
      const command = await getComputerUseCommand(commandId, signal);
      if (command.status === "queued" || command.status === "running") {
        if (progress && process.stdout.isTTY) {
          process.stdout.write(".");
        }
        // #38733: old serving/rollback APIs and unavailable token issuance omit metadata.
        // Retire the old-API obligation after those targets drain; delivery recovery remains.
        if (!notifier && created.realtime) {
          notifier = createRealtimeNotifier(created.realtime, signal);
        }
        await waitForResultChange(notifier, deadline, signal);
        continue;
      }

      if (progress && process.stdout.isTTY) {
        process.stdout.write("\n");
      }

      if (command.status === "failed") {
        throw new Error(
          commandFailureMessage(command.error, options.timeoutGuidance),
        );
      }

      const text = await format(command, signal);
      if (text) {
        console.log(text);
      }
      return;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    clearTimeout(deadlineTimer);
    owner.abort();
    await notifier?.close();
  }
  throw new Error(
    `Computer-use command timed out: ${commandId}${options.timeoutGuidance ?? ""}`,
  );
}

async function waitForResultChange(
  notifier: RealtimeNotifier | undefined,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  const waitMs = Math.max(
    0,
    Math.min(notifier?.active ? 2000 : 500, deadline - Date.now()),
  );
  // Setup or a disconnected transport must not block fast HTTP completions.
  if (notifier && !notifier.closed) await notifier.wait(waitMs);
  else await delay(waitMs, undefined, { signal });
}

function commandFailureMessage(
  error: ComputerUseCommandResponse["error"],
  timeoutGuidance: string | undefined,
): string {
  if (!error) return "Computer-use command failed";
  const message = `${error.code}: ${error.message}`;
  if (error.code === "timeout" || error.code === "command_timeout")
    return message + (timeoutGuidance ?? "");
  return message;
}
