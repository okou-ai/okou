import { getCurrentMember } from "../lib/api/domains/auth";
import { modeHelp, resolveCommandMode } from "../lib/command/single-agent";
import { Command } from "commander";
import chalk from "chalk";
import {
  getApiUrl,
  getActiveOrg,
  getToken,
  decodeSandboxTokenPayload,
} from "../lib/api/config";
import {
  getAgentUserBuiltinConnectors,
  listUserPermissionGrants,
} from "../lib/api/domains/agents";
import { getOrg } from "../lib/api/domains/orgs";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { getOkouAgentId } from "../lib/okou-env";
import {
  chatConnectorAccountsEnabled,
  listRunConnectorAccounts,
} from "../lib/api/domains/run-connector-accounts";
import { connectorAccountTargetKey } from "@okouai/api-contracts/contracts/connector-accounts";
import { policyIcon } from "../lib/utils/format-utils";
import {
  loadConnectorPermissionInfos,
  connectorPermissionGrantsToFirewallPolicies,
  type ConnectorPermissionInfo,
} from "./shared/firewall-permissions";
import {
  loadCustomConnectorPermissionInfos,
  type CustomConnectorPermissionInfo,
} from "./shared/custom-connector-permissions";
import {
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountEntry,
} from "./connector/run-account-context";

/**
 * Detect if running inside an agent sandbox.
 * Uses OKOU_AGENT_ID (not OKOU_RUN_ID) because the Okou CLI operates in the
 * okou agent context where OKOU_AGENT_ID is the canonical sandbox indicator.
 */
function isInsideSandbox(): boolean {
  return !!getOkouAgentId();
}

function formatRunConnectorIdentity(
  connector: RunConnectorAccountEntry,
): string {
  const account = connector.account;
  if (account.state === "not-admitted") {
    return chalk.dim("(unavailable for this run)");
  }
  if (account.state === "metadata-unavailable") {
    return chalk.dim(
      `${account.connectionId} (metadata unavailable or deleted)`,
    );
  }

  const metadata = account.metadata;
  let identity = account.label;
  if (metadata.externalUsername && metadata.externalEmail) {
    identity = `@${metadata.externalUsername} (${metadata.externalEmail})`;
  } else if (metadata.externalUsername) {
    identity = `@${metadata.externalUsername}`;
  } else if (metadata.externalEmail) {
    identity = metadata.externalEmail;
  }
  if (metadata.connectionStatus === "reconnect-required") {
    identity += ` ${chalk.yellow("(needs reconnect)")}`;
  }
  return identity;
}

function printConnectorPermissions(info: ConnectorPermissionInfo): void {
  if (!info.hasPermissions) return;

  if (!info.hasPolicyEntry) {
    console.log(chalk.dim("    full access — no permission rules configured"));
    return;
  }

  if (
    info.permissions.length === 0 &&
    (!info.policies || Object.keys(info.policies).length === 0)
  ) {
    const unknownIcon = policyIcon(info.unknownPolicy);
    console.log(`    ${unknownIcon} unknown endpoints`);
    return;
  }

  const nameWidth = Math.max(
    "unknown endpoints".length,
    ...info.permissions.map((p) => {
      return p.name.length;
    }),
  );

  for (const perm of info.permissions) {
    const policy = info.policies?.[perm.name] ?? "deny";
    const icon = policyIcon(policy);
    const desc = perm.description ?? "";
    console.log(`    ${icon} ${perm.name.padEnd(nameWidth)}  ${desc}`);
  }

  const unknownIcon = policyIcon(info.unknownPolicy);
  console.log(
    `    ${unknownIcon} ${"unknown endpoints".padEnd(nameWidth)}  Endpoints not matching any rule`,
  );
}

function printCustomConnectorPermissions(
  info: CustomConnectorPermissionInfo | undefined,
  personal: boolean,
): void {
  const authorization = info?.authorization;
  const enablement =
    authorization?.state === "enabled"
      ? "enabled"
      : authorization?.state === "not-enabled"
        ? "not enabled"
        : "unavailable";
  console.log(
    `    ${personal ? "Okou access" : "Agent enablement"}: ${enablement}`,
  );

  if (!info || info.model.kind === "unavailable") {
    console.log(chalk.dim("    Permission information unavailable"));
    return;
  }
  if (info.model.kind === "connector") {
    console.log(
      chalk.dim("    Connector-level authorization (no named permissions)"),
    );
    return;
  }

  const { bundle } = info.model;
  const selected =
    authorization?.state === "enabled"
      ? new Set(authorization.permissionNames)
      : null;
  const nameWidth = Math.max(
    "unknown endpoints".length,
    ...bundle.permissions.map((permission) => {
      return permission.name.length;
    }),
  );
  console.log(chalk.dim("    Named permissions:"));
  for (const permission of bundle.permissions) {
    const name = permission.name.padEnd(nameWidth);
    const description = permission.description ?? "";
    if (selected === null) {
      console.log(`      ${name}  ${description}`);
      continue;
    }
    const isSelected = selected.has(permission.name);
    const policy = isSelected
      ? "allow"
      : (bundle.defaultPolicies[permission.name] ?? "deny");
    const source = isSelected ? "selected" : "default";
    console.log(
      `    ${policyIcon(policy)} ${name}  ${description} (${source})`,
    );
  }
  if (selected !== null) {
    console.log(
      `    ${policyIcon("deny")} ${"unknown endpoints".padEnd(nameWidth)}  Endpoints not matching any rule`,
    );
  }
}

function printRunConnectorPermissions(
  connector: RunConnectorAccountEntry,
  builtinPermissions: ReadonlyMap<string, ConnectorPermissionInfo>,
  customPermissions: ReadonlyMap<string, CustomConnectorPermissionInfo>,
  personal: boolean,
): void {
  if (connector.target.kind === "custom") {
    printCustomConnectorPermissions(
      customPermissions.get(connector.target.customConnectorId),
      personal,
    );
    return;
  }
  const info = builtinPermissions.get(connector.slug);
  if (info) {
    printConnectorPermissions(info);
  }
}

/**
 * Workspace identity is supplementary: whoami must still print the agent
 * identity, capabilities, and connectors when the org lookup fails or 404s.
 */
async function printWorkspace(): Promise<void> {
  try {
    const org = await getOrg();
    console.log(`Workspace:  ${org.name}`);
    if (org.tier) {
      console.log(`Tier:       ${org.tier}`);
    }
  } catch {
    // Silently skip — workspace info is supplementary
  }
}

async function resolveSandboxConnectorData(
  showPermissions: boolean,
  agentId: string,
) {
  if (!showPermissions) {
    return {
      view: await resolveRunConnectorAccountView(),
      permissionSources: null,
    };
  }

  const [viewResult, grantsResult, enabledResult] = await Promise.allSettled([
    resolveRunConnectorAccountView(),
    listUserPermissionGrants(agentId),
    getAgentUserBuiltinConnectors(agentId),
  ]);
  if (viewResult.status === "rejected") {
    throw viewResult.reason;
  }
  return {
    view: viewResult.value,
    permissionSources: [grantsResult, enabledResult] as const,
  };
}

async function printChatConnectorPermissions() {
  const inventory = await listRunConnectorAccounts();
  const targets = new Map(
    inventory.accounts.map((account) => {
      return [connectorAccountTargetKey(account.target), account.target];
    }),
  );
  const slugs = [...targets.values()].flatMap((target) => {
    return target.kind === "builtin" ? [target.connectorSlug] : [];
  });
  const policies = connectorPermissionGrantsToFirewallPolicies(
    inventory.permissionGrants.flatMap((grant) => {
      return grant.target.kind === "builtin"
        ? [
            {
              connectorSlug: grant.target.connectorSlug,
              permission: grant.permission,
              action: grant.action,
            },
          ]
        : [];
    }),
  );
  const infos = new Map(
    (
      await loadConnectorPermissionInfos({
        displayConnectorSlugs: slugs,
        defaultPolicyConnectorSlugs: slugs,
        storedPolicies: policies,
      })
    ).map((info) => {
      return [info.connectorSlug, info];
    }),
  );
  console.log();
  console.log(
    chalk.bold(
      "Chat connectors (member permissions shared across Chats and accounts):",
    ),
  );
  for (const [key, target] of targets) {
    const accounts = inventory.accounts.filter((account) => {
      return connectorAccountTargetKey(account.target) === key;
    });
    const current = accounts.find((account) => {
      return account.isCurrent;
    });
    console.log(
      `  ${key}: ${current ? (current.displayName ?? current.connectionId) : "no allowed account"}`,
    );
    if (target.kind === "builtin") {
      const info = infos.get(target.connectorSlug);
      if (info) printConnectorPermissions(info);
    } else console.log("    Unlisted permissions use connector defaults.");
    for (const rule of inventory.permissionGrants.filter((grant) => {
      return connectorAccountTargetKey(grant.target) === key;
    }))
      console.log(
        `    ${rule.permission}: ${rule.action}${rule.expiresAt ? ` until ${rule.expiresAt}` : ""}`,
      );
  }
}

async function printRunIdentity(
  agentId: string | undefined,
  payload: ReturnType<typeof decodeSandboxTokenPayload>,
): Promise<boolean> {
  const personal = await resolveCommandMode();
  if (personal) {
    console.log(`User ID:    ${payload?.userId ?? chalk.dim("unavailable")}`);
    console.log(
      `Chat ID:    ${process.env.OKOU_CHAT_THREAD_ID ?? chalk.dim("unavailable")}`,
    );
  } else console.log(`Agent ID:   ${agentId}`);
  console.log(`Run ID:     ${payload?.runId ?? chalk.dim("unavailable")}`);
  console.log(`Org ID:     ${payload?.orgId ?? chalk.dim("unavailable")}`);
  await printWorkspace();

  return personal;
}

async function showSandboxInfo(showPermissions: boolean): Promise<void> {
  const agentId = getOkouAgentId();
  const payload = decodeSandboxTokenPayload();

  const personal = await printRunIdentity(agentId, payload);

  // Capabilities section
  if (payload?.capabilities?.length) {
    console.log();
    console.log(chalk.bold("Capabilities:"));
    console.log(`  ${payload.capabilities.join(", ")}`);
  }

  // Connected Services section
  if (showPermissions && chatConnectorAccountsEnabled()) {
    await printChatConnectorPermissions();
    return;
  }
  try {
    const { view, permissionSources } = await resolveSandboxConnectorData(
      showPermissions,
      agentId!,
    );
    if (view.state === "unavailable") {
      console.log();
      console.log(chalk.bold("Connectors:"));
      console.log(
        `  ${chalk.dim(runConnectorAccountUnavailableMessage(view.reason))}`,
      );
      return;
    }
    if (view.connectors.length === 0) return;

    let permissionInfoBySlug = new Map<string, ConnectorPermissionInfo>();
    let customPermissionInfoById = new Map<
      string,
      CustomConnectorPermissionInfo
    >();
    if (permissionSources) {
      const [grantsResult, enabledResult] = permissionSources;
      const [builtinResult, customResult] = await Promise.allSettled([
        grantsResult.status === "fulfilled" &&
        enabledResult.status === "fulfilled"
          ? loadConnectorPermissionInfos({
              displayConnectorSlugs: view.connectors.flatMap((connector) => {
                return connector.target.kind === "builtin"
                  ? [connector.slug]
                  : [];
              }),
              defaultPolicyConnectorSlugs: enabledResult.value,
              storedPolicies: connectorPermissionGrantsToFirewallPolicies(
                grantsResult.value,
              ),
            })
          : Promise.resolve([]),
        loadCustomConnectorPermissionInfos({
          agentId: agentId!,
          customConnectorIds: view.connectors.flatMap((connector) => {
            return connector.target.kind === "custom"
              ? [connector.target.customConnectorId]
              : [];
          }),
        }),
      ]);
      if (builtinResult.status === "fulfilled") {
        permissionInfoBySlug = new Map(
          builtinResult.value.map((info) => {
            return [info.connectorSlug, info];
          }),
        );
      }
      if (customResult.status === "fulfilled") {
        customPermissionInfoById = customResult.value;
      }
    }

    console.log();
    console.log(chalk.bold("Connectors:"));
    for (const connector of view.connectors) {
      const identity = formatRunConnectorIdentity(connector);
      console.log(`  ${connector.slug.padEnd(14)}${identity}`);

      if (showPermissions) {
        printRunConnectorPermissions(
          connector,
          permissionInfoBySlug,
          customPermissionInfoById,
          personal,
        );
      }
    }
  } catch {
    // Silently skip — connector info is supplementary
  }
}

async function showLocalInfo(): Promise<void> {
  if (await resolveCommandMode()) {
    const member = await getCurrentMember();
    console.log(`User ID:    ${member.userId}`);
    console.log(`Email:      ${member.email}`);
    console.log(`Org ID:     ${member.orgId ?? chalk.dim("unavailable")}`);
    console.log(`API:        ${await getApiUrl()}`);
    await printWorkspace();
    return;
  }
  const token = await getToken();
  const apiUrl = await getApiUrl();
  const payload = token ? decodeSandboxTokenPayload(token) : undefined;
  const isExpired = payload ? payload.exp * 1000 <= Date.now() : false;
  const activeOrg = !isExpired ? await getActiveOrg() : undefined;

  // Auth section
  console.log(chalk.bold("Auth:"));
  if (!token) {
    console.log(`  Status:     ${chalk.dim("Not authenticated")}`);
  } else if (!payload) {
    console.log(`  Status:     ${chalk.red("Invalid OKOU_TOKEN")}`);
  } else if (isExpired) {
    console.log(`  Status:     ${chalk.red("Expired OKOU_TOKEN")}`);
  } else {
    console.log(
      `  Status:     ${chalk.green("Authenticated")} (via OKOU_TOKEN env var)`,
    );
  }
  console.log(`  API:        ${apiUrl}`);
  console.log();

  // Org section
  if (activeOrg) {
    console.log(chalk.bold("Org:"));
    console.log(`  Active:     ${activeOrg}`);
  }
}

export const whoamiCommand = new Command()
  .name("whoami")
  .description("Show agent identity, run ID, and capabilities")
  .option(
    "--permissions",
    "Show connector enablement and permission details in a sandbox",
  )
  .addHelpText(
    "after",
    modeHelp(
      `
Examples:
  okou whoami
  okou whoami --permissions

Notes:
  - Inside sandbox: shows agent ID, run ID, org ID, and granted capabilities
  - Connector account identity comes from the current run's admitted accounts
  - ${chatConnectorAccountsEnabled() ? "--permissions shows shared member/connector rules and original absolute expiry across all Chats and accounts" : "--permissions shows builtin permission rules and custom connector Agent enablement"}
  - Custom HTTP permission bundles also show selections and effective policies
    when available. MCP connectors and custom HTTP connectors without bundles
    use connector-level authorization. Missing details do not establish access.
  - ${chatConnectorAccountsEnabled() ? "Shared connector permission configuration requires a saved account; Agent grants are not used" : "Manage custom HTTP permissions in Connectors > agent access > Permissions"}
  - Outside a sandbox, shows authentication and org information;
    --permissions does not expand connector permissions
  - Your agent ID is also available as $OKOU_AGENT_ID`,
      `
Shows your authenticated user, workspace, Chat and Run, plus effective capabilities.
Use --permissions for connector enablement, fine-grained permissions and original expiry.
Accounts admitted to this Run remain authoritative; missing details grant nothing.
Switching accounts does not reset permissions. Inspect saved personal Instructions
with okou instructions view; editing them applies to the next start of work.
Outside a Run, --permissions does not expand connector permissions.`,
    ),
  )
  .action(
    withErrorHandler(async (options: { permissions?: boolean }) => {
      if (isInsideSandbox()) {
        await showSandboxInfo(options.permissions ?? false);
      } else {
        await showLocalInfo();
      }
    }),
  );
