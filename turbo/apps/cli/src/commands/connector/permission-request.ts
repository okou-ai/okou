import { Command, Option } from "commander";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  isComputerUsePermissionTarget,
  printComputerUsePermissionGuidance,
} from "./computer-use-guidance";
import {
  isBrowserPermissionTarget,
  printBrowserPermissionGuidance,
} from "./browser-guidance";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { createBrowserAuthorizationRequest } from "../../lib/api/domains/browser";
import { createComputerUseAuthorizationRequest } from "../../lib/api/domains/computer-use";
import { getOkouToken } from "../../lib/okou-env";
import { permissionActionUrl } from "./permission-action-url";
import {
  CALLBACK_PROMPT_MAX_LENGTH,
  connectorActionCallbackAvailable,
  finalizeActionUrl,
  printCallbackTurnInstruction,
} from "./action-url";
import {
  addAwsDiagnosticOptions,
  validateDiagnosticUrl,
} from "./check-diagnostic";
import {
  diagnosePermissionRequest,
  printAwsPermissionDiagnosticGuidance,
} from "./permission-request-diagnostic";
import { resolvePermissionRequestBatch } from "./permission-request-batch";

interface AwsDiagnosticOptionValues {
  readonly awsService?: string;
  readonly awsAction?: string;
  readonly awsTarget?: string;
  readonly awsQueryParam?: readonly string[];
  readonly awsHeaderPresent?: readonly string[];
}

function assertAwsDiagnosticOptionsSupported(args: {
  readonly selector: string;
  readonly permission: string;
  readonly url: string | undefined;
  readonly options: AwsDiagnosticOptionValues;
}): void {
  const { options } = args;
  const awsSelectorsSupplied =
    options.awsService !== undefined ||
    options.awsAction !== undefined ||
    options.awsTarget !== undefined ||
    (options.awsQueryParam?.length ?? 0) > 0 ||
    (options.awsHeaderPresent?.length ?? 0) > 0;
  if (!awsSelectorsSupplied) return;
  if (args.url === undefined) {
    throw new Error("AWS diagnostic selectors can only be used with --url.");
  }
  if (
    isBrowserPermissionTarget({
      connectorSlug: args.selector,
      permission: args.permission,
    }) ||
    isComputerUsePermissionTarget({
      connectorSlug: args.selector,
      permission: args.permission,
    })
  ) {
    throw new Error(
      "AWS diagnostic selectors are only supported for connector URL permission checks.",
    );
  }
}

function permissionDescription(permission: string): string {
  return permission === UNKNOWN_PERMISSION_GRANT
    ? "unknown endpoints"
    : `the "${permission}" permission`;
}

function printSensitivePermissionGuidance(
  connectorSlug: string,
  permission: string,
): void {
  // Slack chat:write: strongly recommend bot-based messaging over user identity
  if (connectorSlug === "slack" && permission === "chat:write") {
    console.log("");
    console.log(
      "IMPORTANT: Granting chat:write allows sending messages AS THE USER's identity, not as a bot.",
    );
    console.log(
      "Use `okou slack message send --to <channel> -t <text>` to send messages as the bot instead — this is the recommended approach for most use cases.",
    );
    console.log(
      "Only allow this permission below if acting as the user is specifically required.",
    );
    console.log("");
  }

  // Gmail send permissions: strongly recommend draft-based workflow over direct send.
  if (
    connectorSlug === "gmail" &&
    (permission === "messages.send" || permission === "drafts.send")
  ) {
    console.log("");
    console.log(
      "IMPORTANT: Granting Gmail send permissions allows the agent to send emails directly as the user.",
    );
    console.log(
      "Consider keeping messages.send and drafts.send disabled and using drafts.write instead — the agent can create drafts for the user to review and send manually.",
    );
    console.log(
      "Only allow this permission below if direct sending is specifically required.",
    );
    console.log("");
  }
}

function printPermissionRequestMessage(args: {
  readonly permission: string;
  readonly label: string;
  readonly url: string;
}): void {
  console.log(
    `You can allow ${permissionDescription(args.permission)} for your connector access: [Manage ${args.label} permissions](${args.url})`,
  );
}

function printComputerUseAuthorizationLink(args: {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}): void {
  console.log(
    "Computer Use needs an Okou Desktop host selected before a run starts.",
  );
  console.log(
    "Ask the user to authorize a host for future runs in this chat or Slack thread:",
  );
  console.log(args.authorizationUrl);
  console.log(
    `This link expires at ${args.expiresAt}. Existing run tokens cannot be upgraded in place; start a new run after authorization.`,
  );
}

async function printComputerUsePermissionRequestMessage(
  callbackPrompt: string | undefined,
): Promise<void> {
  finalizeActionUrl(new URL("https://app.okou.ai"), callbackPrompt);
  if (!getOkouToken()) {
    printComputerUsePermissionGuidance();
    return;
  }

  try {
    const request = await createComputerUseAuthorizationRequest();
    printComputerUseAuthorizationLink({
      authorizationUrl: finalizeActionUrl(
        new URL(request.authorizationUrl),
        callbackPrompt,
      ),
      expiresAt: request.expiresAt,
    });
    if (callbackPrompt !== undefined) printCallbackTurnInstruction();
  } catch (error) {
    if (error instanceof ApiRequestError) {
      console.log(
        `Computer Use authorization link unavailable: ${error.message}`,
      );
      printComputerUsePermissionGuidance();
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.log(`Computer Use authorization link unavailable: ${message}`);
    printComputerUsePermissionGuidance();
  }
}

function printBrowserAuthorizationLink(args: {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}): void {
  console.log(
    "Cloud browser needs to be enabled for this chat thread before a run starts.",
  );
  console.log(
    "Ask the user to enable the cloud browser for future runs in this thread:",
  );
  console.log(args.authorizationUrl);
  console.log(
    `This link expires at ${args.expiresAt}. Existing run tokens cannot be upgraded in place; start a new run after authorization.`,
  );
}

async function printBrowserPermissionRequestMessage(
  callbackPrompt: string | undefined,
): Promise<void> {
  finalizeActionUrl(new URL("https://app.okou.ai"), callbackPrompt);
  if (!getOkouToken()) {
    printBrowserPermissionGuidance();
    return;
  }
  try {
    const request = await createBrowserAuthorizationRequest();
    printBrowserAuthorizationLink({
      ...request,
      authorizationUrl: finalizeActionUrl(
        new URL(request.authorizationUrl),
        callbackPrompt,
      ),
    });
    if (callbackPrompt !== undefined) printCallbackTurnInstruction();
  } catch (error) {
    if (error instanceof ApiRequestError) {
      console.log(
        `Cloud browser authorization link unavailable: ${error.message}`,
      );
      printBrowserPermissionGuidance();
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.log(`Cloud browser authorization link unavailable: ${message}`);
    printBrowserPermissionGuidance();
  }
}

async function outputPermissionRequestMessage(
  connectorSlug: string,
  label: string,
  permission: string,
  callbackPrompt: string | undefined,
): Promise<void> {
  const actionUrl = await permissionActionUrl("single");
  actionUrl.searchParams.set("connectorSlug", connectorSlug);
  actionUrl.searchParams.set("permission", permission);
  actionUrl.searchParams.set("action", "allow");
  const url = finalizeActionUrl(actionUrl, callbackPrompt);

  printSensitivePermissionGuidance(connectorSlug, permission);
  printPermissionRequestMessage({
    permission,
    label,
    url,
  });
  if (callbackPrompt !== undefined) {
    printCallbackTurnInstruction();
  }
}

const callbackPromptOption = new Option(
  "--callback-prompt <prompt>",
  `Start the next web chat round with this prompt after the permission is granted (max ${CALLBACK_PROMPT_MAX_LENGTH} characters)`,
);
const callbackPromptAvailable = connectorActionCallbackAvailable();
if (!callbackPromptAvailable) {
  callbackPromptOption.hideHelp();
}
export const permissionRequestCommand = addAwsDiagnosticOptions(
  new Command()
    .name("permission-request")
    .description(
      "Request builtin permissions or Browser/Computer Use authorization",
    )
    .argument(
      "[selector]",
      "Connector slug, custom UUID, unique display name, browser, or computer-use; builtin:/custom: prefixes accepted",
    )
    .addOption(
      new Option("--permission <name>", "The permission name to request"),
    )
    .addOption(
      new Option(
        "--url <URL>",
        "The failed request URL reported to okou connector check",
      ),
    )
    .addOption(
      new Option("--method <METHOD>", "The failed request HTTP method").default(
        "GET",
      ),
    ),
)
  .option(
    "--batch-file <path>",
    "Request 1–20 builtin HTTP permissions from a strict JSON array",
  )
  .addOption(callbackPromptOption)
  .addHelpText(
    "after",
    `
Request only the concrete builtin permission diagnosed by connector check.
Inspect okou whoami --permissions first; already-allowed permissions need no approval.
Supply a selector, --permission, the failed --url and --method, plus observed AWS
selectors when applicable. Provider OAuth scope names are not Okou permissions.
Custom HTTP permissions use Connectors settings; MCP has connector-level access.
An unknown-endpoint has no named permission match. An unknown-policy supplies its
fallback. Neither label alone means access was denied. Follow policy.outcome:
allow needs no additional permission approval; unavailable means permission status could not be determined.
For custom unknown endpoints, only deny/ask outcomes need an administrator to review the connector definition.

For several diagnosed operations use --batch-file <path>. The JSON array contains
{ connector, permission, url, method } and optional AWS diagnostic selectors.
The CLI rechecks every item, skips already allowed grants and returns one batch link.
The user chooses the grant duration on the confirmation page.

Use --callback-prompt only for this turn's sole access action (one batch counts as
one action), in the current web chat. Keep it concise and free of secrets. Return
the URL verbatim with all query parameters and end the turn. With multiple actions,
do not use callbacks; return the ordinary links.
Accounts and authorization resolve from your workspace execution context; switching
accounts never resets permissions. Browser/Computer Use consent remains separate.
`,
  )
  .action(
    withErrorHandler(
      async (
        selector: string | undefined,
        opts: {
          permission?: string;
          batchFile?: string;
          url?: string;
          method: string;
          awsService?: string;
          awsAction?: string;
          awsTarget?: string;
          awsQueryParam?: string[];
          awsHeaderPresent?: string[];
          callbackPrompt?: string;
        },
        command: Command,
      ) => {
        if (opts.batchFile !== undefined) {
          const singleOnlyOptions = [
            "permission",
            "url",
            "method",
            "awsService",
            "awsAction",
            "awsTarget",
            "awsQueryParam",
            "awsHeaderPresent",
          ];
          if (
            selector !== undefined ||
            singleOnlyOptions.some((name) => {
              return command.getOptionValueSource(name) === "cli";
            })
          ) {
            throw new Error(
              "--batch-file cannot be combined with a selector or single-request diagnostic options (including --method).",
            );
          }
          const batch = await resolvePermissionRequestBatch({
            batchFile: opts.batchFile,
            callbackPrompt: opts.callbackPrompt,
          });
          for (const summary of batch.summaries) console.log(summary);
          if (batch.hasAws) printAwsPermissionDiagnosticGuidance();
          if (
            batch.summaries.some((summary) => {
              return summary.endsWith("skipped");
            })
          ) {
            console.log(
              "Already-allowed permissions need no Okou approval; provider authorization failures require provider-side diagnosis.",
            );
          }
          if (batch.url === undefined) {
            console.log(
              "All requested permissions are already allowed. No approval is needed.",
            );
            return;
          }
          for (const item of batch.items)
            printSensitivePermissionGuidance(
              item.connectorSlug,
              item.permission,
            );
          console.log(
            `Request approval for ${batch.items.length} permission(s). The user chooses the duration on the confirmation page:`,
          );
          console.log(batch.url);
          if (opts.callbackPrompt !== undefined) printCallbackTurnInstruction();
          return;
        }
        if (selector === undefined || opts.permission === undefined) {
          throw new Error(
            "Supply a selector and --permission for a single request, or use --batch-file <path>.",
          );
        }
        if (opts.url !== undefined) {
          validateDiagnosticUrl(opts.url);
        }
        assertAwsDiagnosticOptionsSupported({
          selector,
          permission: opts.permission,
          url: opts.url,
          options: opts,
        });
        if (
          isBrowserPermissionTarget({
            connectorSlug: selector,
            permission: opts.permission,
          })
        ) {
          await printBrowserPermissionRequestMessage(opts.callbackPrompt);
          return;
        }
        if (
          isComputerUsePermissionTarget({
            connectorSlug: selector,
            permission: opts.permission,
          })
        ) {
          await printComputerUsePermissionRequestMessage(opts.callbackPrompt);
          return;
        }

        const result = await diagnosePermissionRequest(
          selector,
          opts.permission,
          opts,
        );
        if (result.policy.outcome === "allow") {
          throw new Error(
            `${permissionDescription(opts.permission)} is already allowed by Okou for ${result.request.method} ${result.request.url}. Provider authorization failures cannot be fixed with an Okou permission request.`,
          );
        }
        if (result.request.aws !== undefined)
          printAwsPermissionDiagnosticGuidance();

        await outputPermissionRequestMessage(
          result.connectorSlug,
          result.label,
          opts.permission,
          opts.callbackPrompt,
        );
      },
    ),
  );
