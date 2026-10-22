import { Command, Option } from "commander";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getPlatformOrigin } from "../../lib/platform-url";
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
import { resolveConnectorAgentId } from "./agent-context";
import {
  CALLBACK_PROMPT_GUIDANCE,
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

async function printComputerUsePermissionRequestMessage(): Promise<void> {
  if (!getOkouToken()) {
    printComputerUsePermissionGuidance();
    return;
  }

  try {
    const request = await createComputerUseAuthorizationRequest();
    printComputerUseAuthorizationLink({
      authorizationUrl: request.authorizationUrl,
      expiresAt: request.expiresAt,
    });
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

async function printBrowserPermissionRequestMessage(): Promise<void> {
  if (!getOkouToken()) {
    printBrowserPermissionGuidance();
    return;
  }
  try {
    const request = await createBrowserAuthorizationRequest();
    printBrowserAuthorizationLink(request);
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
  agentId: string | undefined,
  callbackPrompt: string | undefined,
): Promise<void> {
  const platformOrigin = await getPlatformOrigin();

  const pagePath = agentId ? `/agents/${agentId}/permissions` : "/agents";
  const actionUrl = new URL(pagePath, platformOrigin);
  actionUrl.searchParams.set("connectorSlug", connectorSlug);
  actionUrl.searchParams.set("permission", permission);
  actionUrl.searchParams.set("action", "allow");
  const url = finalizeActionUrl(actionUrl, callbackPrompt, agentId);

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
const callbackPromptExample = callbackPromptAvailable
  ? '  okou connector permission-request github --permission contents:write --url https://api.github.com/repos/okou-ai/okou --method POST --callback-prompt "Re-check the permission, then continue the previous task"\n'
  : "";
const callbackPromptNotes = callbackPromptAvailable
  ? `  - Use --callback-prompt for one single permission action or one batch link covering this turn's permissions\n  - ${CALLBACK_PROMPT_GUIDANCE}\n`
  : "";

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
        "--agent <id>",
        "Agent ID whose permission page should be opened (must match OKOU_AGENT_ID inside a run)",
      ),
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
Examples:
  okou connector permission-request github --permission contents:read --url https://api.github.com/repos/okou-ai/okou --method GET
${callbackPromptExample}  okou connector permission-request gmail --permission messages.write --url https://gmail.googleapis.com/gmail/v1/users/me/messages --method POST --agent <agent-id>
  okou connector permission-request cloudflare --permission __unknown__ --url https://api.cloudflare.com/client/v4/example --method POST
  okou connector permission-request computer-use --permission computer-use:write
  okou connector permission-request browser --permission browser:write
  okou connector permission-request --batch-file ./permissions.json --agent <agent-id>

Notes:
  - AWS options mirror connector check; they preserve the described AWS
    operation when this command rechecks a named permission. They do not verify
    a SigV4 signature or send a request to AWS; never include secrets.
  - Plan the concrete connector operations needed for this task; do not request hypothetical future access
  - Check okou whoami --permissions first and skip permissions already allowed
  - First run okou connector check --url <FAILED_URL> --method <METHOD>; use its firewall-denial URL and omit secret query strings or fragments
  - Use the exact permission and URL/method diagnosed by connector check
  - For multiple builtin HTTP permissions, --batch-file accepts a JSON array of
    1–20 strict items: {"connector":"github","permission":"contents:read","url":"https://api.github.com/repos/okou-ai/okou","method":"GET"}
    Optional item fields: awsService, awsAction, awsTarget, awsQueryParam (array),
    awsHeaderPresent (array). All single-request flags and selector are excluded.
    Every item is diagnosed before one deduplicated batch approval link is output;
    already-allowed items are skipped. A current Agent or --agent is required.
  - Provider OAuth errors such as Slack missing_scope or needed are provider scopes, not Okou permission names
  - A platform URL is output only when that request maps to a denied or approval-required permission
  - Builtin requests require --url and run-scoped policy data; an unavailable
    non-run diagnostic cannot produce a builtin permission approval
  - Use --permission __unknown__ for diagnosed builtin unknown endpoints
  - Custom HTTP connectors with permission bundles use Connectors > agent access
    > Permissions. MCP connectors have Agent access but no HTTP permission bundle.
    Custom UUIDs, full slugs, and exact unique display names, optionally prefixed
    with custom:, resolve to this settings guidance rather than a builtin approval link.
  - Custom unknown endpoints have no approval control; ask an administrator
    to review the connector's routing and permission definition
  - Inside a run, --agent must match the current Agent; omit it to use OKOU_AGENT_ID.
    Outside a run, --agent selects the Agent's permission page.
    Agent selection does not change the accounts admitted to a run.
  - The user chooses the permission duration on the confirmation page
  - --callback-prompt requires the current web chat and its current Agent;
    it is unsupported for custom, Browser, and Computer Use authorization
${callbackPromptNotes}  - One batch link may use a single callback for all included permissions
  - When multiple separate connector or permission action links are needed, do not use callbacks; return each ordinary action URL on its own line and wait for all confirmations
  - Return every generated action URL verbatim with all query parameters
  - Builtin permission requests update the current user's connector grants after confirmation`,
  )
  .action(
    withErrorHandler(
      async (
        selector: string | undefined,
        opts: {
          permission?: string;
          batchFile?: string;
          agent?: string;
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
            agentId: resolveConnectorAgentId(opts.agent),
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
        const agentId = resolveConnectorAgentId(opts.agent);
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
          if (opts.callbackPrompt !== undefined) {
            throw new Error(
              "--callback-prompt is not supported for cloud browser authorization requests",
            );
          }
          await printBrowserPermissionRequestMessage();
          return;
        }
        if (
          isComputerUsePermissionTarget({
            connectorSlug: selector,
            permission: opts.permission,
          })
        ) {
          if (opts.callbackPrompt !== undefined) {
            throw new Error(
              "--callback-prompt is not supported for Computer Use authorization requests",
            );
          }
          await printComputerUsePermissionRequestMessage();
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
          agentId,
          opts.callbackPrompt,
        );
      },
    ),
  );
