import { Command, Option } from "commander";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorRuntimeTarget } from "@okouai/api-contracts/contracts/runners";
import type { ConnectorCheckPolicy } from "@okouai/api-contracts/contracts/connector-check";

import {
  buildDiagnosticRequest,
  connectorCheckRetryCommand,
  connectorPermissionRequestCommand,
  diagnosticEnvironmentNames,
  isComputerUseCheckTarget,
  printDiagnosticSummary,
  requireUrlRequest,
  resolveConnectorCheckDiagnostic,
  validateCheckConnectorOptions,
  type CheckConnectorOptions,
  type ResolvedDiagnostic,
  type ResolvedEnvironmentDiagnostic,
  type ResolvedUrlDiagnostic,
  type UrlDiagnosticRequest,
} from "./check-diagnostic";

import { getApiUrl } from "../../lib/api/config";
import {
  loadCustomConnectorCheckContext,
  printCustomConnectorCheckStatus,
} from "./check-custom";
import { customConnectorSettingsGuidance } from "./custom-connector-guidance";
import { printConnectorCheckJson } from "./check-json";
import { resolveDiagnosticConnectorSelector } from "./diagnostic-connector-selector";
import {
  diagnoseConnectorCheck,
  getConnector,
} from "../../lib/api/domains/connectors";
import { getAgentUserConnectors } from "../../lib/api/domains/agents";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getOkouAgentId } from "../../lib/okou-env";
import { toPlatformUrl } from "../doctor/platform-url";
import {
  computerUsePermissionGuidance,
  printComputerUsePermissionGuidance,
} from "./computer-use-guidance";
import {
  CALLBACK_PROMPT_PLACEHOLDER,
  connectorActionUrl,
  currentChatSupportsActionCallback,
  printCallbackActionUrlExample,
} from "./action-url";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountLookup,
} from "./run-account-context";

interface DiagContext {
  readonly environmentNames: readonly string[] | null;
  readonly label: string;
  readonly connectorAvailable: boolean;
  readonly credentialResolution: "network-boundary" | "none";
  readonly run: ResolvedDiagnostic["run"];
  readonly platformOrigin: string;
  readonly agentId: string | undefined;
  readonly runBound: boolean;
}

interface BuiltinDiagContext extends DiagContext {
  readonly connectorSlug: ConnectorSlug;
}

interface ConnectorConfigurationStatus {
  readonly isConnected: boolean;
  readonly isExpired: boolean;
  readonly runAccount: RunConnectorAccountLookup | null;
}

function printConnectorConnectionStatus(
  ctx: BuiltinDiagContext,
  status: ConnectorConfigurationStatus,
  hasPermission: boolean,
): void {
  console.log(
    "### 2a: Connector status (user must configure via OAuth login or API key)",
  );
  console.log("");
  if (!ctx.connectorAvailable) {
    console.log(
      `The ${ctx.label} connector is not available for this account.`,
    );
  } else if (status.runAccount?.state === "context-unavailable") {
    console.log(
      runConnectorAccountUnavailableMessage(status.runAccount.reason),
    );
  } else if (status.runAccount?.state === "not-admitted") {
    console.log(`No ${ctx.label} account was admitted for this run.`);
    console.log(
      "Connect or change the thread selection, then start a new run.",
    );
  } else if (status.runAccount?.state === "metadata-unavailable") {
    console.log(`Account used by this run: ${status.runAccount.connectionId}`);
    console.log("Current account metadata is unavailable or deleted.");
    console.log("Select an available account, then start a new run.");
  } else if (!status.isConnected) {
    console.log(`The ${ctx.label} connector is not connected.`);
    if (ctx.agentId && hasPermission) {
      const connectUrl = connectorActionUrl({
        origin: ctx.platformOrigin,
        path: `/connectors/${ctx.connectorSlug}/connect`,
        agentId: ctx.agentId,
      });
      console.log(`Connect it at: [Connect ${ctx.label}](${connectUrl})`);
      printCallbackActionUrlExample(connectUrl, ctx.agentId);
    } else if (!ctx.agentId) {
      const connectUrl = connectorActionUrl({
        origin: ctx.platformOrigin,
        path: `/connectors/${ctx.connectorSlug}/connect`,
      });
      console.log(`Connect it at: [Connect ${ctx.label}](${connectUrl})`);
    }
  } else if (status.isExpired) {
    const url = connectorActionUrl({
      origin: ctx.platformOrigin,
      path:
        status.runAccount?.state === "available"
          ? `/connectors/${ctx.connectorSlug}/reconnect/${status.runAccount.connectionId}`
          : `/connectors/${ctx.connectorSlug}/connect`,
      agentId: ctx.agentId,
    });
    if (status.runAccount?.state === "available") {
      console.log(`Account used by this run: ${status.runAccount.label}`);
      console.log(`Connection ID: ${status.runAccount.connectionId}`);
    }
    console.log(
      `The ${ctx.label} connector is connected but has expired and needs to be reconnected.`,
    );
    console.log(`Reconnect it at: [Reconnect ${ctx.label}](${url})`);
    printCallbackActionUrlExample(url, ctx.agentId);
    if (ctx.runBound) {
      console.log("After reconnecting, start a new run.");
    }
  } else {
    if (status.runAccount?.state === "available") {
      console.log(`Account used by this run: ${status.runAccount.label}`);
      console.log(`Connection ID: ${status.runAccount.connectionId}`);
    }
    console.log(`The ${ctx.label} connector is connected and active.`);
  }
  console.log("");
}

function printAgentAuthorizationStatus(
  ctx: BuiltinDiagContext,
  status: ConnectorConfigurationStatus,
  hasPermission: boolean,
): void {
  if (!ctx.agentId) {
    console.log("OKOU_AGENT_ID is not set — cannot check agent authorization.");
  } else if (status.isExpired) {
    console.log(
      `Skipped — agent authorization can only be checked once the ${ctx.label} connector is reconnected (see 2a).`,
    );
  } else if (hasPermission) {
    console.log(
      status.isConnected
        ? `The ${ctx.label} connector is authorized for this agent.`
        : ctx.runBound
          ? `The ${ctx.label} connector is authorized for this agent, but an account is not available for this run.`
          : `The ${ctx.label} connector is authorized for this agent, but it is not connected.`,
    );
  } else {
    const url = connectorActionUrl({
      origin: ctx.platformOrigin,
      path: `/connectors/${ctx.connectorSlug}/authorize`,
      agentId: ctx.agentId,
    });
    console.log(
      status.isConnected
        ? `The ${ctx.label} connector is not authorized for this agent (${ctx.agentId}).`
        : ctx.runBound
          ? `The ${ctx.label} connector is not authorized for this agent (${ctx.agentId}), and an account is not available for this run.`
          : `The ${ctx.label} connector needs to be connected and authorized for this agent (${ctx.agentId}).`,
    );
    console.log(`Authorize it at: [Authorize ${ctx.label}](${url})`);
    printCallbackActionUrlExample(url, ctx.agentId);
    if (ctx.runBound) {
      console.log("After authorizing it, start a new run.");
    }
  }
}

function printConnectorAuthorizationStatus(
  ctx: BuiltinDiagContext,
  status: ConnectorConfigurationStatus,
  hasPermission: boolean,
): void {
  console.log(
    "### 2b: Agent authorization (user must authorize agent to use this connector)",
  );
  console.log("");
  if (!ctx.connectorAvailable) {
    console.log(
      `Skipped — the ${ctx.label} connector is not available for this account.`,
    );
  } else {
    printAgentAuthorizationStatus(ctx, status, hasPermission);
  }
  console.log(
    `This run uses agent-scoped connector authorization for ${ctx.label} access.`,
  );
  console.log("");
}

function checkEnvironmentNames(ctx: DiagContext): void {
  console.log("## Step 1: Sandbox environment name");
  console.log("");
  if (ctx.environmentNames === null) {
    console.log(
      "Environment metadata is unavailable for this run's sanitized firewall entry, so no environment name was guessed.",
    );
    console.log("");
    return;
  }
  if (ctx.environmentNames.length === 0) {
    console.log(
      "The matched API route does not use a sandbox environment name.",
    );
    console.log("");
    return;
  }

  let environmentPresent = false;
  for (const environmentName of ctx.environmentNames) {
    const present = Boolean(process.env[environmentName]);
    environmentPresent ||= present;
    console.log(
      `Checking process.env.${environmentName}: ${present ? "present" : "not present"}`,
    );
  }
  if (environmentPresent) {
    console.log(
      "At least one connector value is present in the sandbox environment. These values may be non-secret connector settings or credential placeholders; real credentials are never injected and are resolved at the network boundary for registered base URLs.",
    );
  } else {
    console.log(
      "No value found for these environment names. Note: credential replacement at the network boundary is independent of these names — the proxy injects auth headers based on the destination URL.",
    );
  }
  console.log("");
}

async function checkConnectorStatus(ctx: BuiltinDiagContext): Promise<{
  readonly isConnected: boolean;
  readonly isExpired: boolean;
  readonly hasPermission: boolean;
}> {
  console.log("## Step 2: Connector configuration");
  console.log("");
  console.log(
    "A Connector holds the real credentials (OAuth tokens or API keys) for an external service. These credentials are never injected into the sandbox. Instead, when the sandbox sends an HTTP request to a base URL registered by the Connector, the network boundary intercepts the request and replaces the auth headers with real credentials. For this to work, three conditions must be met:",
  );
  console.log("");

  const [configuration, enabledConnectorSlugs] = await Promise.all([
    ctx.runBound
      ? resolveRunConnectorAccountLookups([
          { kind: "builtin", connectorSlug: ctx.connectorSlug },
        ]).then((lookups) => {
          const runAccount = lookups[0];
          if (!runAccount) {
            throw new Error("Missing run account lookup for connector");
          }
          return {
            isConnected: runAccount.state === "available",
            isExpired:
              runAccount.state === "available" &&
              runAccount.metadata.connectionStatus === "reconnect-required",
            runAccount,
          } satisfies ConnectorConfigurationStatus;
        })
      : getConnector(ctx.connectorSlug).then((connector) => {
          return {
            isConnected: connector !== null,
            isExpired: connector?.connectionStatus === "reconnect-required",
            runAccount: null,
          } satisfies ConnectorConfigurationStatus;
        }),
    ctx.agentId ? getAgentUserConnectors(ctx.agentId) : Promise.resolve(null),
  ]);

  const hasPermission =
    enabledConnectorSlugs !== null &&
    enabledConnectorSlugs.includes(ctx.connectorSlug);

  printConnectorConnectionStatus(ctx, configuration, hasPermission);
  printConnectorAuthorizationStatus(ctx, configuration, hasPermission);

  return {
    isConnected: configuration.isConnected,
    isExpired: configuration.isExpired,
    hasPermission,
  };
}

function checkConnectorDomains(ctx: DiagContext): boolean | null {
  console.log(
    "### 2c: Registered base URLs (credential replacement only applies to URLs matching these prefixes)",
  );
  console.log("");

  switch (ctx.run.status) {
    case "not-scoped":
      console.log(
        "This diagnostic is not scoped to a run — skipping the run base URL check.",
      );
      console.log("");
      return null;
    case "not-configured":
      console.log(
        `No configuration found for the ${ctx.label} connector in this run.`,
      );
      console.log(
        "This means no base URLs are registered for credential replacement for this connector.",
      );
      console.log("");
      return false;
    case "configured":
      console.log(
        `The ${ctx.label} connector is configured for this run with the following base URLs:`,
      );
      for (const base of ctx.run.bases) {
        console.log(`  - ${base}`);
      }
      console.log("");
      if (ctx.credentialResolution === "network-boundary") {
        console.log(
          "Credentials are resolved at the network boundary for requests matching these registered base URLs.",
        );
      }
      console.log("");
      return true;
  }
}

function printUnavailablePolicy(
  policy: Extract<
    ConnectorCheckPolicy,
    {
      readonly outcome: "unavailable";
    }
  >,
): void {
  switch (policy.basis) {
    case "not-run-scoped":
      console.log(
        "Result: Permission policy is unavailable because this diagnostic is not scoped to a run.",
      );
      return;
    case "policies-unavailable":
      console.log(
        "Result: Network policies are unavailable for this run, so the permission status cannot be determined.",
      );
      return;
    case "connector-not-configured":
      console.log(
        "Result: The connector is not configured for this run, so requests cannot receive credentials.",
      );
      return;
  }
}

function printNamedPolicyResult(
  target: ConnectorRuntimeTarget,
  permission: string,
  policy: ConnectorCheckPolicy,
  agentId: string | undefined,
  request: UrlDiagnosticRequest | undefined,
  platformOrigin: string,
): void {
  switch (policy.outcome) {
    case "allow": {
      switch (policy.basis) {
        case "allow-list":
          console.log(
            `Result: "${permission}" is in the allow list — allowed.`,
          );
          return;
        case "not-blocked":
          console.log(
            `Result: "${permission}" is not blocked by the deny or ask list — allowed.`,
          );
          return;
        case "no-policy":
          console.log(
            `Result: No policy entry exists for this connector — "${permission}" is allowed.`,
          );
          return;
        case "unknown-policy":
          console.log(
            `Result: The server policy allows "${permission}" through the unknown-endpoint policy.`,
          );
          return;
      }
      break;
    }
    case "deny":
      console.log(
        policy.basis === "deny-list"
          ? `Result: "${permission}" is in the deny list — denied.`
          : `Result: The unknown-endpoint policy denies "${permission}".`,
      );
      printPermissionRequestCommands(
        target,
        permission,
        agentId,
        "To request this permission, run",
        request,
        platformOrigin,
      );
      return;
    case "ask":
      console.log(
        policy.basis === "ask-list"
          ? `Result: "${permission}" is in the ask list — blocked until approval.`
          : `Result: The unknown-endpoint policy blocks "${permission}" until approval.`,
      );
      printPermissionRequestCommands(
        target,
        permission,
        agentId,
        "To request this permission, run",
        request,
        platformOrigin,
      );
      return;
    case "unavailable":
      printUnavailablePolicy(policy);
      return;
  }
}

function printPermissionRequestCommands(
  target: ConnectorRuntimeTarget,
  permission: string,
  agentId: string | undefined,
  introduction: string,
  request: UrlDiagnosticRequest | undefined,
  platformOrigin: string,
): void {
  if (target.kind === "custom") {
    console.log(
      customConnectorSettingsGuidance(
        target.customConnectorId,
        platformOrigin,
        permission,
      ),
    );
    return;
  }
  if (request === undefined) {
    console.log(
      "Diagnose the failed request with okou connector check --url <FAILED_URL> --method <METHOD> before requesting this permission.",
    );
    return;
  }
  const command = connectorPermissionRequestCommand(
    target.connectorSlug,
    permission,
    request,
  );
  console.log(`${introduction}: ${command}`);
  if (!currentChatSupportsActionCallback(agentId)) {
    return;
  }

  console.log("");
  console.log(
    "Or, if this is the only connector or permission action needed, run the callback command below. After the user completes this action, Okou will automatically start the next round with the callback prompt:",
  );
  console.log(`${command} --callback-prompt "${CALLBACK_PROMPT_PLACEHOLDER}"`);
}

function printUnknownEndpointPolicy(
  target: ConnectorRuntimeTarget,
  policy: ConnectorCheckPolicy,
  agentId: string | undefined,
  request: UrlDiagnosticRequest,
  platformOrigin: string,
): void {
  switch (policy.outcome) {
    case "allow":
      console.log(
        policy.basis === "no-policy"
          ? "Result: No policy entry exists for this connector, so the request is allowed."
          : "Result: No permission matched. The unknown endpoint policy allows this request.",
      );
      return;
    case "deny":
      console.log(
        "Result: No permission matched. The unknown endpoint policy denies this request.",
      );
      printPermissionRequestCommands(
        target,
        "__unknown__",
        agentId,
        "To request access to unknown endpoints, run",
        request,
        platformOrigin,
      );
      return;
    case "ask":
      console.log(
        "Result: No permission matched. The unknown endpoint policy requires approval.",
      );
      printPermissionRequestCommands(
        target,
        "__unknown__",
        agentId,
        "To request access to unknown endpoints, run",
        request,
        platformOrigin,
      );
      return;
    case "unavailable":
      printUnavailablePolicy(policy);
      return;
  }
}

function printUrlPermissionDiagnostic(
  request: UrlDiagnosticRequest,
  result: ResolvedUrlDiagnostic,
  agentId: string | undefined,
  platformOrigin: string,
): void {
  console.log("## Step 3: Permission policy check (auto-detected from URL)");
  console.log("");
  console.log(
    `Matching ${result.method} ${result.relativePath} (relative to base URL ${result.base}) against the ${result.connector.label} connector's permission rules.`,
  );
  console.log("");

  if (result.permission.kind === "matched") {
    console.log(
      `Matched permissions: [${result.permission.permissions
        .map((permission) => {
          return permission.name;
        })
        .join(", ")}]`,
    );
    console.log("");
    for (const permission of result.permission.permissions) {
      printNamedPolicyResult(
        result.connector.target,
        permission.name,
        permission.policy,
        agentId,
        request,
        platformOrigin,
      );
    }
  } else {
    console.log(
      `No named permission matches ${result.method} ${result.relativePath}. This request falls through to the unknown-endpoint policy.`,
    );
    console.log("");
    printUnknownEndpointPolicy(
      result.connector.target,
      result.permission.policy,
      agentId,
      request,
      platformOrigin,
    );
  }
  console.log("");
}

function printEnvironmentPermissionDiagnostic(
  result: ResolvedEnvironmentDiagnostic,
  permissionName: string | undefined,
  agentId: string | undefined,
  platformOrigin: string,
): void {
  if (result.permission === null) {
    return;
  }
  if (permissionName === undefined) {
    throw new Error(
      "Connector diagnostic returned a permission outcome without a requested permission.",
    );
  }
  console.log("## Step 3: Permission policy check");
  console.log("");
  console.log(
    `Checking permission: "${permissionName}" for the ${result.connector.label} connector.`,
  );
  console.log("");
  printNamedPolicyResult(
    result.connector.target,
    permissionName,
    result.permission,
    agentId,
    undefined,
    platformOrigin,
  );
  console.log("");
}

export const checkConnectorCommand = new Command()
  .name("check")
  .description(
    "Diagnose builtin/custom routing, account configuration, and run permissions",
  )
  .option("--json", "Output connector diagnostics and next actions as JSON")
  .addOption(
    new Option(
      "--env-name <ENV_NAME>",
      "Builtin connector environment name (e.g. GITHUB_TOKEN)",
    ),
  )
  .addOption(
    new Option(
      "--url <URL>",
      "A full URL to diagnose — matches connector ownership, route environment names, and permission (e.g. https://api.github.com/repos/owner/repo)",
    ),
  )
  .addOption(
    new Option(
      "--connector <selector>",
      "Select a unique slug, custom UUID, or display name; qualify collisions with builtin: or custom:",
    ),
  )
  .addOption(
    new Option(
      "--method <METHOD>",
      "HTTP method to use when matching permissions with --url",
    ).default("GET"),
  )
  .addOption(
    new Option(
      "--check-permission <name>",
      "Permission to check with --env-name only (e.g. contents:read)",
    ),
  )
  .addHelpText(
    "after",
    `
Scope:
  --env-name diagnoses a builtin environment binding; --check-permission can
  select a permission in this mode. Custom HTTP/MCP routes use --url; this checks
  HTTP routing, not MCP tool discovery or execution.
  URL mode discovers builtin and custom route owners. Use --connector with a
  full slug, custom UUID, or exact unique display name; qualify collisions with
  builtin: or custom:. Find UUIDs with connector custom list.
  --connector and --method require --url. URL permissions are derived from the
  request, so --check-permission cannot be combined with --url. Diagnose the
  failed request before trying ad hoc credential or permission fixes. Prefer the
  URL field returned by the firewall denial; omit query strings and fragments
  when they may contain secrets.
  Inside a run, account identity comes from that run's admitted accounts.
  Outside a run, run routing/policy checks may be unavailable. Unavailable
  policy data is not an allow decision.

Examples:
  okou connector check --env-name GITHUB_TOKEN
  okou connector check --url https://api.github.com/repos/owner/repo
  okou connector check --url https://api.accounts.nintendo.com/2.0.0/users/me --connector nintendo-store
  okou connector check --url https://api.acme.example/v1/items --connector custom:<connector-id>
  okou connector check --url https://api.acme.example/v1/items --connector _acme-search
  okou connector check --url https://slack.com/api/chat.postMessage --method POST
  okou connector check --env-name SLACK_TOKEN --check-permission chat:write

How connectors work:
  Authenticated connectors resolve credentials at the network boundary for
  matching registered URLs. No-auth connectors do not inject credentials.
  This command diagnoses configuration and intended routing/permission state;
  it does not replay the failed request or confirm the runner applied an update.

Permission recovery:
  First inspect okou whoami --permissions and skip access already granted. For
  builtin deny/ask outcomes, use the exact permission-request command printed
  for the failed URL and method, one concrete permission at a time. Do not turn
  provider OAuth errors such as missing_scope or needed into Okou permissions.
  Custom HTTP permission bundles use Connectors > agent access > Permissions.
  MCP connectors have no HTTP permission bundle.
  Custom unknown endpoints require an administrator to review routing/permission
  definitions; there is no custom approval control.
  Callback examples are for a single supported action in the current web chat
  for its current Agent. When multiple access actions are needed, use ordinary
  links and wait for all confirmations. Return every action URL verbatim. Custom
  settings guidance has no callback approval flow.`,
  )
  .action(
    withErrorHandler(async (opts: CheckConnectorOptions, command: Command) => {
      validateCheckConnectorOptions(opts, command);
      if (isComputerUseCheckTarget(opts)) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                context: isRunBoundConnectorContext() ? "run" : "current",
                diagnostic: {
                  outcome: "not-a-connector",
                  capability: "computer-use:write",
                },
                guidance: computerUsePermissionGuidance,
                actions: [{ kind: "command", command: "okou whoami" }],
              },
              null,
              2,
            ),
          );
        } else {
          printComputerUsePermissionGuidance();
        }
        return;
      }
      const method = opts.method.toUpperCase();
      const connector =
        opts.connector === undefined
          ? undefined
          : await resolveDiagnosticConnectorSelector(opts.connector);
      const request = buildDiagnosticRequest({ ...opts, connector }, method);
      const diagnostic = await diagnoseConnectorCheck(request);
      if (opts.json) {
        await printConnectorCheckJson(request, diagnostic);
        return;
      }
      const resolved = resolveConnectorCheckDiagnostic(request, diagnostic);
      const target = resolved.connector.target;
      const custom =
        target.kind === "custom"
          ? await loadCustomConnectorCheckContext(target.customConnectorId)
          : null;
      const result = custom
        ? {
            ...resolved,
            connector: { ...resolved.connector, label: custom.label },
          }
        : resolved;

      printDiagnosticSummary(request, result);
      console.log("");

      const platformUrl = toPlatformUrl(await getApiUrl());
      const ctx: DiagContext = {
        environmentNames: diagnosticEnvironmentNames(result),
        label: result.connector.label,
        connectorAvailable: result.connector.visibility === "available",
        credentialResolution: result.connector.credentialResolution,
        run: result.run,
        platformOrigin: platformUrl.origin,
        agentId: getOkouAgentId(),
        runBound: isRunBoundConnectorContext(),
      };

      checkEnvironmentNames(ctx);
      const status =
        target.kind === "builtin"
          ? await checkConnectorStatus({
              ...ctx,
              connectorSlug: target.connectorSlug,
            })
          : null;
      if (custom) {
        printCustomConnectorCheckStatus(custom, ctx.platformOrigin);
      }
      const configuredForRun = checkConnectorDomains(ctx);

      if (configuredForRun === false) {
        console.log(
          `Steps 1-2 summary: The ${ctx.label} connector is not configured for this run. Check the agent authorization settings, then start a new run after updating them.`,
        );
      } else if (
        status?.isConnected &&
        !status.isExpired &&
        status.hasPermission
      ) {
        console.log(
          `Steps 1-2 summary: The ${ctx.label} connector is connected, active, and authorized. Outbound requests to the registered base URLs will have credentials injected at the network boundary.`,
        );
      }
      console.log("");

      if (result.mode === "url") {
        printUrlPermissionDiagnostic(
          requireUrlRequest(request),
          result,
          ctx.agentId,
          ctx.platformOrigin,
        );
      } else {
        printEnvironmentPermissionDiagnostic(
          result,
          request.mode === "environment" ? request.permission : undefined,
          ctx.agentId,
          ctx.platformOrigin,
        );
      }

      console.log(
        `To re-diagnose after changes, run: ${connectorCheckRetryCommand(request)}`,
      );
    }),
  );
