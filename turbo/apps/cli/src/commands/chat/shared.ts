import chalk from "chalk";
import {
  getModelReasoningEfforts,
  isModelReasoningEffortSupported,
  modelReasoningEffort,
  reasoningEffortSchema,
  type ModelSettings,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";

import { isUuid } from "../../lib/utils/uuid";
import { getOkouChatThreadId } from "../../lib/okou-env";

export function printChatUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

export function parseChatEffort(
  value: string,
  model?: string,
): ReasoningEffort {
  const effort = reasoningEffortSchema.safeParse(value);
  if (
    !effort.success ||
    (model && !isModelReasoningEffortSupported(model, effort.data))
  ) {
    if (model) {
      printChatUsageError(
        `Unsupported reasoning effort "${value}" for ${model}`,
        `${model} supports: ${getModelReasoningEfforts(model).join(", ")}`,
      );
    }
    printChatUsageError(
      `Unsupported reasoning effort "${value}"`,
      "Pass --model <id> to select a model and its supported effort level.",
    );
  }
  return effort.data;
}

export function formatChatEffort(
  model: string | null,
  modelSettings: ModelSettings | undefined,
): string {
  const effort = modelReasoningEffort(model, modelSettings);
  return effort ? ` · effort ${effort}` : "";
}

export function resolveChatThreadId(flagThreadId: string | undefined): string {
  const threadId = flagThreadId?.trim() || getOkouChatThreadId()?.trim();
  if (!threadId) {
    printChatUsageError(
      "OKOU_CHAT_THREAD_ID is not set",
      "Pass --thread-id <thread-id> or run inside a web chat thread.",
    );
  }
  if (!isUuid(threadId)) {
    printChatUsageError(
      `Invalid thread ID "${threadId}" — expected a UUID`,
      "Pass a valid UUID with --thread-id <thread-id>.",
    );
  }
  return threadId;
}
