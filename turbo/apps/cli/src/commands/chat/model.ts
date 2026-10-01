import { isMemberModelPolicyAvailable } from "@okouai/api-contracts/contracts/member-model-policy";
import chalk from "chalk";
import { Command } from "commander";
import type { ChatThreadMetadata } from "@okouai/api-contracts/contracts/chat-threads";
import type { ModelCatalogResponse } from "@okouai/api-contracts/contracts/model-catalog";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import {
  getChatThread,
  updateChatThreadModelSelection,
} from "../../lib/api/domains/chat";
import { getModelCatalog } from "../../lib/api/domains/model-catalog";
import { listModelPolicies } from "../../lib/api/domains/model-policies";
import {
  formatCatalogThreadModel,
  getCatalogModelDisplayName,
  getCatalogModelEfforts,
  isCatalogModelActive,
  isCatalogSystemDefaultModel,
  resolveCatalogModel,
  sortByCatalogOrder,
} from "../../lib/domain/model-catalog-display";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  formatModelProviderRoute,
  formatModelPolicyStatus,
} from "../../lib/domain/model-policy-display";
import { isUuid } from "../../lib/utils/uuid";
import { getOkouChatThreadId } from "../../lib/okou-env";
import { parseChatEffort } from "./shared";

interface ModelOptions {
  readonly help?: boolean;
  readonly thread?: string;
  readonly effort?: string;
}

function getCurrentChatThreadId(): string | undefined {
  return getOkouChatThreadId()?.trim() || undefined;
}

function printUsageError(message: string, hint: string): never {
  console.error(chalk.red(`✗ ${message}`));
  console.error(chalk.dim(`  ${hint}`));
  process.exit(1);
}

/** Pickers only offer active catalog models the member can use. */
function switchablePolicies(
  catalog: ModelCatalogResponse,
  policies: readonly OrgModelPolicy[],
) {
  return sortByCatalogOrder(
    catalog,
    policies.filter((policy) => {
      return (
        isCatalogModelActive(catalog, policy.model) &&
        isMemberModelPolicyAvailable(policy)
      );
    }),
  );
}

function formatModelName(catalog: ModelCatalogResponse, model: string): string {
  return `${getCatalogModelDisplayName(catalog, model)} ${chalk.dim(`(${model})`)}`;
}

function printSwitchableModels(
  catalog: ModelCatalogResponse,
  policies: readonly OrgModelPolicy[],
): void {
  const switchable = switchablePolicies(catalog, policies);
  if (switchable.length === 0) {
    console.log(chalk.dim("No switchable models are available for this user"));
    return;
  }

  for (const policy of switchable) {
    const defaultMarker = isCatalogSystemDefaultModel(catalog, policy.model)
      ? chalk.dim(" (default)")
      : "";
    const efforts = getCatalogModelEfforts(catalog, policy.model);
    console.log(
      `  - ${formatModelName(catalog, policy.model)}${defaultMarker}`,
    );
    console.log(`    provider: ${formatModelProviderRoute(policy)}`);
    console.log(
      `    efforts: ${efforts.length > 0 ? efforts.join(", ") : "none"}`,
    );
  }
}

function printCurrentModel(
  thread: ChatThreadMetadata,
  catalog: ModelCatalogResponse,
): void {
  console.log(chalk.green("✓ Chat thread loaded"));
  console.log(chalk.dim(`  Thread: ${thread.id}`));
  console.log(chalk.dim(`  Title:  ${thread.title ?? "(untitled)"}`));
  console.log(
    chalk.dim(
      `  Model:  ${formatCatalogThreadModel(catalog, thread.selectedModel, thread.modelSettings)}`,
    ),
  );
}

async function printModelHelp(command: Command): Promise<void> {
  const [result, catalog] = await Promise.all([
    listModelPolicies(),
    getModelCatalog(),
  ]);
  console.log(command.helpInformation().trimEnd());
  console.log();
  console.log(chalk.bold("Switchable models:"));
  printSwitchableModels(catalog, result.policies);
  console.log();
  console.log(
    "Effort levels depend on the model; Claude uses extra where Codex uses xhigh.",
  );
  console.log("Use the model id in parentheses:");
  console.log(
    chalk.cyan(
      "  okou chat model [--thread <thread-id>] <model> [--effort <level>]",
    ),
  );
  console.log(
    chalk.cyan("  okou chat model [--thread <thread-id>] --effort <level>"),
  );
}

async function printCurrentModelAndChoices(threadId: string): Promise<void> {
  const [thread, result, catalog] = await Promise.all([
    getChatThread({ threadId }),
    listModelPolicies(),
    getModelCatalog(),
  ]);

  printCurrentModel(thread, catalog);
  console.log();
  console.log(chalk.bold("Switchable models:"));
  printSwitchableModels(catalog, result.policies);
  console.log();
  console.log("Switch models:");
  console.log(chalk.cyan(`  okou chat model --thread ${threadId} <model>`));
}

async function switchModel(
  threadId: string,
  model: string,
  effort?: string,
): Promise<void> {
  const [result, catalog] = await Promise.all([
    listModelPolicies(),
    getModelCatalog(),
  ]);
  const resolved = resolveCatalogModel(catalog, model);
  if (resolved !== model) {
    printUsageError(
      `Model is retired: ${model}`,
      `Use its replacement: okou chat model ${resolved}`,
    );
  }
  const policy = result.policies.find((candidate) => {
    return candidate.model === model;
  });

  if (!policy) {
    printUsageError(`Unknown model: ${model}`, "Run: okou chat model --help");
  }

  if (!isMemberModelPolicyAvailable(policy)) {
    const status = formatModelPolicyStatus(policy);
    const reason = status ? ` (${status})` : "";
    printUsageError(
      `Model is not switchable: ${model}${reason}`,
      "Run: okou chat model --help",
    );
  }

  const reasoningEffort =
    effort === undefined
      ? undefined
      : parseChatEffort(effort, { catalog, model });
  const updated = await updateChatThreadModelSelection({
    threadId,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });

  console.log(chalk.green("✓ Chat model updated"));
  console.log(chalk.dim(`  Thread: ${updated.threadId}`));
  console.log(
    chalk.dim(
      `  Model:  ${getCatalogModelDisplayName(catalog, model)} (${model})${reasoningEffort ? ` · effort ${reasoningEffort}` : ""}`,
    ),
  );
}

async function updateCurrentEffort(
  threadId: string,
  effort: string,
): Promise<void> {
  const [thread, catalog] = await Promise.all([
    getChatThread({ threadId }),
    getModelCatalog(),
  ]);
  if (!thread.selectedModel) {
    printUsageError(
      "This chat thread has no selected model",
      "Pass a model: okou chat model --thread <thread-id> <model> --effort <level>",
    );
  }
  // A retired selection runs as its replacement, so the effort applies there.
  const model = resolveCatalogModel(catalog, thread.selectedModel);
  const reasoningEffort = parseChatEffort(effort, { catalog, model });
  await updateChatThreadModelSelection({
    threadId,
    model,
    reasoningEffort,
  });
  console.log(chalk.green("✓ Chat model updated"));
  console.log(chalk.dim(`  Thread: ${threadId}`));
  console.log(
    chalk.dim(
      `  Model:  ${getCatalogModelDisplayName(catalog, model)} (${model}) · effort ${reasoningEffort}`,
    ),
  );
}

export const modelCommand = new Command()
  .name("model")
  .description("Show or switch the current web chat thread model")
  .argument("[model]", "Model id to use for this chat thread")
  .helpOption(false)
  .option("--thread <id>", "Chat thread ID (defaults to OKOU_CHAT_THREAD_ID)")
  .option("--effort <level>", "Set reasoning effort for the selected model")
  .option("-h, --help", "Show help with switchable models")
  .addHelpText(
    "after",
    `
Examples:
  Show this chat model:     okou chat model
  Show another chat model:  okou chat model --thread <thread-id>
  Switch this model:        okou chat model claude-sonnet-5
  Switch another model:     okou chat model --thread <thread-id> claude-sonnet-5
  Switch with effort:       okou chat model claude-opus-5-5 --effort extra
  Change only effort:      okou chat model --effort max

Notes:
  - Defaults --thread to OKOU_CHAT_THREAD_ID
  - Effort levels depend on the model; Claude uses extra where Codex uses xhigh
  - Authenticates via OKOU_TOKEN (requires chat-thread:write capability to switch)`,
  )
  .action(
    withErrorHandler(
      async (model: string | undefined, options: ModelOptions) => {
        if (options.help) {
          await printModelHelp(modelCommand);
          return;
        }

        const threadId = options.thread?.trim() || getCurrentChatThreadId();
        if (!threadId) {
          printUsageError(
            "OKOU_CHAT_THREAD_ID is not set",
            "Pass --thread <thread-id> or run inside a web chat thread.",
          );
        }
        if (!isUuid(threadId)) {
          printUsageError(
            `Invalid thread ID "${threadId}" — expected a UUID`,
            "Pass a valid UUID with --thread <thread-id>.",
          );
        }

        if (!model) {
          if (options.effort !== undefined) {
            await updateCurrentEffort(threadId, options.effort);
          } else {
            await printCurrentModelAndChoices(threadId);
          }
          return;
        }

        await switchModel(threadId, model, options.effort);
      },
    ),
  );
