import chalk from "chalk";
import { Command } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getPlatformOrigin } from "../../lib/platform-url";
import { connectorActionUrl } from "../connector/action-url";
import {
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
} from "../connector/run-account-context";
import {
  MAIL_CONNECTOR_SLUG_BY_PROVIDER,
  currentAgentId,
  parseMailProvider,
} from "./shared";

interface ConnectOptions {
  readonly json?: boolean;
}

type MailProvider = ReturnType<typeof parseMailProvider>;

function printRunUnavailable(
  provider: MailProvider,
  options: ConnectOptions,
  message: string,
  connectionId: string | null,
): void {
  if (options.json) {
    console.log(
      JSON.stringify({
        provider,
        action: "unavailable",
        url: null,
        context: "run",
        connectionId,
      }),
    );
    return;
  }
  console.log(message);
}

async function printRunConnect(
  provider: MailProvider,
  connectorSlug: (typeof MAIL_CONNECTOR_SLUG_BY_PROVIDER)[MailProvider],
  options: ConnectOptions,
): Promise<void> {
  const [view, origin] = await Promise.all([
    resolveRunConnectorAccountView(),
    getPlatformOrigin(),
  ]);
  if (view.state === "unavailable") {
    printRunUnavailable(
      provider,
      options,
      runConnectorAccountUnavailableMessage(view.reason),
      null,
    );
    return;
  }
  const connector = view.connectors.find((candidate) => {
    return candidate.slug === connectorSlug;
  });
  if (connector?.account.state !== "available") {
    printRunUnavailable(
      provider,
      options,
      "Account used by this run is unavailable. Reconnect or change the thread selection, then start a new run.",
      connector?.account.connectionId ?? null,
    );
    return;
  }
  const account = connector.account;
  const reconnect = account.metadata.connectionStatus === "reconnect-required";
  const url = reconnect
    ? connectorActionUrl({
        origin,
        path: `/connectors/${connectorSlug}/reconnect/${account.connectionId}`,
        agentId: currentAgentId(),
      })
    : null;
  if (options.json) {
    console.log(
      JSON.stringify({
        provider,
        action: reconnect ? "reconnect" : "ready",
        url,
        context: "run",
        connectionId: account.connectionId,
      }),
    );
    return;
  }
  if (url) {
    console.log(
      `Reconnect ${connector.connectorLabel}: [Reconnect ${connector.connectorLabel}](${url})`,
    );
    return;
  }
  console.log(chalk.green(`✓ ${connector.connectorLabel} is ready`));
  console.log(chalk.dim(`  Sender: ${account.metadata.externalEmail ?? "-"}`));
  console.log(
    chalk.dim(
      `  After creating a draft: okou mail link <draft-id>${provider === "outlook" ? " --provider outlook" : ""}`,
    ),
  );
}

export const connectCommand = new Command()
  .name("connect")
  .description("Get a connect or authorization link for a mail provider")
  .argument("<provider>", "Mail provider: gmail or outlook")
  .option("--json", "Print machine-readable JSON")
  .action(
    withErrorHandler(async (providerValue: string, options: ConnectOptions) => {
      const provider = parseMailProvider(providerValue);
      const connectorSlug = MAIL_CONNECTOR_SLUG_BY_PROVIDER[provider];
      currentAgentId();
      await printRunConnect(provider, connectorSlug, options);
    }),
  );
