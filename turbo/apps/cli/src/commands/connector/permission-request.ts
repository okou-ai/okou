import { Command, Option } from "commander";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import type { ConnectorCheckPolicy } from "@okouai/api-contracts/contracts/connector-check";
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
import { diagnoseConnectorCheck } from "../../lib/api/domains/connectors";
import { getOkouToken } from "../../lib/okou-env";
import { resolveConnectorAgentId } from "./agent-context";
import {
  connectorActionCallbackAvailable,
  finalizeActionUrl,
  printCallbackTurnInstruction,
} from "./action-url";
import {
  buildConnectorUrlDiagnosticRequest,
  resolveConnectorCheckDiagnostic,
  validateDiagnosticUrl,
  type ResolvedDiagnostic,
} from "./check-diagnostic";
import {
  customConnectorIdFromSelector,
  customConnectorSettingsGuidance,
} from "./custom-connector-guidance";
import { resolveDiagnosticConnectorSelector } from "./diagnostic-connector-selector";

function permissionDescription(permission: string): string {
  return permission === UNKNOWN_PERMISSION_GRANT
    ? "unknown endpoints"
    : `the "${permission}" permission`;
}

function permissionPolicyForDiagnostic(args: {
  readonly result: ResolvedDiagnostic;
  readonly permission: string;
  readonly method: string;
  readonly url: string;
}): ConnectorCheckPolicy {
  if (args.result.mode !== "url") {
    throw new Error(
      "Connector diagnostic returned an environment result for a URL request.",
    );
  }

  if (args.permission === UNKNOWN_PERMISSION_GRANT) {
    if (args.result.permission.kind === "unknown-endpoint") {
      return args.result.permission.policy;
    }
    throw permissionMismatchError({
      permission: args.permission,
      method: args.method,
      url: args.url,
      matchedPermissions: args.result.permission.permissions.map(
        (permission) => {
          return permission.name;
        },
      ),
    });
  }

  if (args.result.permission.kind === "unknown-endpoint") {
    throw permissionMismatchError({
      permission: args.permission,
      method: args.method,
      url: args.url,
      matchedPermissions: [UNKNOWN_PERMISSION_GRANT],
    });
  }

  const matchedPermission = args.result.permission.permissions.find(
    (permission) => {
      return permission.name === args.permission;
    },
  );
  if (matchedPermission === undefined) {
    throw permissionMismatchError({
      permission: args.permission,
      method: args.method,
      url: args.url,
      matchedPermissions: args.result.permission.permissions.map(
        (permission) => {
          return permission.name;
        },
      ),
    });
  }
  return matchedPermission.policy;
}

function permissionMismatchError(args: {
  readonly permission: string;
  readonly method: string;
  readonly url: string;
  readonly matchedPermissions: readonly string[];
}): Error {
  return new Error(
    `Permission "${args.permission}" does not match ${args.method} ${args.url}. The request maps to: ${args.matchedPermissions.join(", ")}. Use the exact permission-request command printed by okou connector check; provider OAuth scopes and missing_scope/needed values cannot be granted here.`,
  );
}

function assertRequestablePolicy(args: {
  readonly policy: ConnectorCheckPolicy;
  readonly permission: string;
  readonly method: string;
  readonly url: string;
}): void {
  switch (args.policy.outcome) {
    case "deny":
    case "ask":
      return;
    case "allow":
      throw new Error(
        `${permissionDescription(args.permission)} is already allowed by Okou for ${args.method} ${args.url}. Provider authorization failures cannot be fixed with an Okou permission request.`,
      );
    case "unavailable":
      throw new Error(
        `Okou permission policy is unavailable for ${args.method} ${args.url}. Retry okou connector check from an active run before requesting access.`,
      );
  }
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
      "Use `okou slack message send -c <channel> -t <text>` to send messages as the bot instead — this is the recommended approach for most use cases.",
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
  "Start the next web chat round with this prompt after the permission is granted",
);
const callbackPromptAvailable = connectorActionCallbackAvailable();
if (!callbackPromptAvailable) {
  callbackPromptOption.hideHelp();
}
const callbackPromptExample = callbackPromptAvailable
  ? '  okou connector permission-request github --permission contents:write --url https://api.github.com/repos/vm0-ai/vm0 --method POST --callback-prompt "Re-check the permission, then continue the previous task"\n'
  : "";
const callbackPromptNotes = callbackPromptAvailable
  ? "  - Use --callback-prompt only when this turn needs exactly one connector or permission action\n  - Callback prompts are included in the URL; keep them concise and do not include secrets\n"
  : "";

export const permissionRequestCommand = new Command()
  .name("permission-request")
  .description(
    "Request builtin permissions or Browser/Computer Use authorization",
  )
  .argument(
    "<selector>",
    "Connector slug, custom UUID, unique display name, browser, or computer-use; builtin:/custom: prefixes accepted",
  )
  .addOption(
    new Option(
      "--permission <name>",
      "The permission name to request",
    ).makeOptionMandatory(),
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
  )
  .addOption(callbackPromptOption)
  .addHelpText(
    "after",
    `
Examples:
  okou connector permission-request github --permission contents:read --url https://api.github.com/repos/vm0-ai/vm0 --method GET
${callbackPromptExample}  okou connector permission-request gmail --permission messages.write --url https://gmail.googleapis.com/gmail/v1/users/me/messages --method POST --agent <agent-id>
  okou connector permission-request cloudflare --permission __unknown__ --url https://api.cloudflare.com/client/v4/example --method POST
  okou connector permission-request computer-use --permission computer-use:write
  okou connector permission-request browser --permission browser:write

Notes:
  - Plan the concrete connector operations needed for this task; do not request hypothetical future access
  - Check okou whoami --permissions first and skip permissions already allowed
  - First run okou connector check --url <FAILED_URL> --method <METHOD>; use its firewall-denial URL and omit secret query strings or fragments
  - Use the exact permission-request command printed by connector check, one command per permission
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
${callbackPromptNotes}  - When multiple connector or permission actions are needed, do not use callbacks; return each ordinary action URL on its own line and wait for all confirmations
  - Return every generated action URL verbatim with all query parameters
  - Builtin permission requests update the current user's connector grants after confirmation`,
  )
  .action(
    withErrorHandler(
      async (
        selector: string,
        opts: {
          permission: string;
          agent?: string;
          url?: string;
          method: string;
          callbackPrompt?: string;
        },
      ) => {
        const agentId = resolveConnectorAgentId(opts.agent);
        if (opts.url !== undefined) {
          validateDiagnosticUrl(opts.url);
        }
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

        const connectorSlug =
          await resolveDiagnosticConnectorSelector(selector);
        const customConnectorId = customConnectorIdFromSelector(connectorSlug);
        if (customConnectorId !== undefined) {
          throw new Error(
            customConnectorSettingsGuidance(
              customConnectorId,
              await getPlatformOrigin(),
              opts.permission,
            ),
          );
        }
        if (opts.url === undefined) {
          throw new Error(
            "--url is required for connector permission requests. Run okou connector check --url <FAILED_URL> --method <METHOD> and use the permission-request command it prints.",
          );
        }

        const diagnosticRequest = buildConnectorUrlDiagnosticRequest({
          url: opts.url,
          method: opts.method,
          connector: connectorSlug,
        });
        const diagnostic = await diagnoseConnectorCheck(diagnosticRequest);
        const result = resolveConnectorCheckDiagnostic(
          diagnosticRequest,
          diagnostic,
        );
        if (result.connector.target.kind !== "builtin") {
          throw new Error(
            "Builtin permission requests require a builtin diagnostic target.",
          );
        }
        const policy = permissionPolicyForDiagnostic({
          result,
          permission: opts.permission,
          method: diagnosticRequest.method,
          url: diagnosticRequest.url,
        });
        assertRequestablePolicy({
          policy,
          permission: opts.permission,
          method: diagnosticRequest.method,
          url: diagnosticRequest.url,
        });

        await outputPermissionRequestMessage(
          result.connector.target.connectorSlug,
          result.connector.label,
          opts.permission,
          agentId,
          opts.callbackPrompt,
        );
      },
    ),
  );
