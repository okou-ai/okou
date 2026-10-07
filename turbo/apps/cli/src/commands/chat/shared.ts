import chalk from "chalk";
import type { ModelCatalogResponse } from "@okouai/api-contracts/contracts/model-catalog";
import {
  reasoningEffortSchema,
  type ReasoningEffort,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  AUTO_MODEL_LABEL,
  getCatalogModelEfforts,
  resolveCatalogModel,
} from "../../lib/domain/model-catalog-display";

import { isUuid } from "../../lib/utils/uuid";
import { getOkouChatThreadId } from "../../lib/okou-env";

export function printChatUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

/**
 * Parse `--effort`. With a target model, the catalog routes of that model are
 * the authority for which efforts it accepts; Auto (null) uses the routes of
 * the model it runs.
 */
export function parseChatEffort(
  value: string,
  target?: {
    readonly catalog: ModelCatalogResponse;
    readonly model: string | null;
  },
): ReasoningEffort {
  const effort = reasoningEffortSchema.safeParse(value);
  const supported = target
    ? getCatalogModelEfforts(
        target.catalog,
        target.model ?? resolveCatalogModel(target.catalog, null),
      )
    : undefined;
  if (!effort.success || (supported && !supported.includes(effort.data))) {
    if (target) {
      const name = target.model ?? AUTO_MODEL_LABEL;
      const choices = supported?.length ? supported.join(", ") : "none";
      printChatUsageError(
        `Unsupported reasoning effort "${value}" for ${name}`,
        `${name} supports: ${choices}`,
      );
    }
    printChatUsageError(
      `Unsupported reasoning effort "${value}"`,
      "Pass --model <id> to select a model and its supported effort level.",
    );
  }
  return effort.data;
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
