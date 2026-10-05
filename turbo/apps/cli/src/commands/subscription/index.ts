import { randomUUID } from "node:crypto";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import {
  getSubscription,
  listSubscriptions,
  switchSubscription,
} from "../../lib/api/domains/subscriptions";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getPlatformOrigin } from "../../lib/platform-url";

const SWITCH_EFFECT =
  "This changes the default subscription for this provider in the current organization. It applies to subsequent runs that do not explicitly pin an account; running runs keep their captured subscription. The model and other providers are unchanged.";

function subscriptionId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError(
      "Use an exact subscription ID from `okou subscription list`.",
    );
  }
  return result.data;
}

function summary(account: ModelProviderResponse) {
  return {
    id: account.id,
    provider: account.type,
    active: account.isActive ?? false,
    email: account.accountEmail ?? null,
    workspace: account.workspaceName ?? null,
    plan: account.planType ?? null,
    needsReconnect: account.needsReconnect,
    usage: account.subscriptionUsage ?? null,
    nextResetAt: account.subscriptionNextResetAt ?? null,
    resetSupported: account.subscriptionResetSupported ?? false,
    resetCredits: account.subscriptionResetCredits ?? null,
    resetCreditsNextExpiresAt:
      account.subscriptionResetCreditsNextExpiresAt ?? null,
  };
}

function printWindow(
  label: string,
  window:
    | NonNullable<ModelProviderResponse["subscriptionUsage"]>["fiveHour"]
    | undefined,
) {
  const used =
    window?.usedPercent === null || window?.usedPercent === undefined
      ? "unknown"
      : `${window.usedPercent}%`;
  const remaining =
    window?.remainingPercent === null || window?.remainingPercent === undefined
      ? "unknown"
      : `${window.remainingPercent}%`;
  console.log(
    `  ${label}: used ${used}, remaining ${remaining}; reset ${window?.resetAt ?? "unknown"}`,
  );
}

function printSubscription(account: ModelProviderResponse) {
  const provider =
    account.type === "codex-oauth-token" ? "Codex" : "Claude Code";
  console.log(
    `${account.id} — ${provider}${account.isActive ? " (active)" : ""}`,
  );
  console.log(
    `  account: ${account.accountEmail ?? "unknown"}; workspace: ${account.workspaceName ?? "unknown"}; plan: ${account.planType ?? "unknown"}`,
  );
  printWindow("5-hour", account.subscriptionUsage?.fiveHour);
  printWindow("Weekly", account.subscriptionUsage?.weekly);
  if (account.subscriptionNextResetAt) {
    console.log(`  Next reset: ${account.subscriptionNextResetAt}`);
  }
  console.log(
    `  Reset supported: ${account.subscriptionResetSupported === true ? "yes" : "no"}; remaining reset credits: ${account.subscriptionResetCredits ?? "unknown"}`,
  );
  if (account.subscriptionResetCreditsNextExpiresAt) {
    console.log(
      `  Reset credits next expire: ${account.subscriptionResetCreditsNextExpiresAt}`,
    );
  }
  if (account.needsReconnect) {
    console.log(
      "  Reconnect this subscription in Preferences / Personal Models.",
    );
  }
}

const listCommand = new Command("list")
  .alias("ls")
  .description(
    "List your connected Claude Code and Codex subscriptions and live usage",
  )
  .option("--json", "Output structured JSON")
  .action(
    withErrorHandler(async (options: { json?: boolean }) => {
      const subscriptions = await listSubscriptions();
      const counts = {
        total: subscriptions.length,
        claudeCode: subscriptions.filter((account) => {
          return account.type === "claude-code-oauth-token";
        }).length,
        codex: subscriptions.filter((account) => {
          return account.type === "codex-oauth-token";
        }).length,
      };
      if (options.json) {
        console.log(
          JSON.stringify(
            { counts, subscriptions: subscriptions.map(summary) },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `Subscriptions: ${counts.total} (${counts.claudeCode} Claude Code, ${counts.codex} Codex)`,
      );
      for (const account of subscriptions) {
        printSubscription(account);
      }
      console.log(
        subscriptions.length
          ? "Use `okou subscription show <id>`, `reset-link <id>`, or `switch <id>`."
          : "Connect a subscription in Preferences / Personal Models.",
      );
    }),
  );

const showCommand = new Command("show")
  .description("Read one personal subscription and its live usage")
  .argument("<subscription-id>", "Exact subscription ID", subscriptionId)
  .option("--json", "Output structured JSON")
  .action(
    withErrorHandler(async (id: string, options: { json?: boolean }) => {
      const account = await getSubscription(id);
      if (options.json) {
        console.log(JSON.stringify(summary(account), null, 2));
      } else {
        printSubscription(account);
      }
    }),
  );

const resetLinkCommand = new Command("reset-link")
  .description(
    "Create a user-confirmed Codex Reset Card link; does not reset usage",
  )
  .argument("<subscription-id>", "Exact subscription ID", subscriptionId)
  .option("--json", "Output structured JSON")
  .action(
    withErrorHandler(async (id: string, options: { json?: boolean }) => {
      const account = await getSubscription(id);
      if (
        account.type !== "codex-oauth-token" ||
        account.subscriptionResetSupported !== true
      ) {
        throw new Error(
          "Manual reset is unavailable for this subscription. Use `okou subscription show` to check its natural reset time.",
        );
      }
      const url = new URL(
        `/subscriptions/${id}/reset`,
        await getPlatformOrigin(),
      );
      url.searchParams.set("idempotencyKey", randomUUID());
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              subscriptionId: id,
              url: url.toString(),
              requiresUserConfirmation: true,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          "Share this link with the user. Opening it does not reset usage; the user must click Reset.",
        );
        console.log(url.toString());
      }
    }),
  );

const switchCommand = new Command("switch")
  .description(
    "Switch the default subscription for this provider for subsequent runs",
  )
  .argument("<subscription-id>", "Exact subscription ID", subscriptionId)
  .option("--json", "Output structured JSON")
  .action(
    withErrorHandler(async (id: string, options: { json?: boolean }) => {
      const account = await switchSubscription(id);
      if (options.json) {
        console.log(
          JSON.stringify(
            { subscription: summary(account), effect: SWITCH_EFFECT },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `Active subscription: ${account.id} (${account.accountEmail ?? account.type})`,
        );
        console.log(SWITCH_EFFECT);
      }
    }),
  );

export const subscriptionCommand = new Command("subscription")
  .description(
    "Inspect and switch personal subscriptions; create user-confirmed reset links",
  )
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(resetLinkCommand)
  .addCommand(switchCommand);
