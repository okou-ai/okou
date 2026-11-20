import { ApiRequestError } from "../lib/api/core/client-factory";
import { getCurrentMember } from "../lib/api/domains/auth";
import { modeHelp } from "../lib/command/single-agent";
import { isPersonalExecution } from "../lib/personal-execution";
import { Command } from "commander";
import chalk from "chalk";
import {
  getApiUrl,
  getActiveOrg,
  getToken,
  decodeSandboxTokenPayload,
} from "../lib/api/config";
import { getOrg } from "../lib/api/domains/orgs";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { getOkouAgentId } from "../lib/okou-env";
import { listRunConnectorAccounts } from "../lib/api/domains/run-connector-accounts";
import { connectorAccountTargetKey } from "@okouai/api-contracts/contracts/connector-accounts";
import { policyIcon } from "../lib/utils/format-utils";
import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import {
  loadConnectorPermissionInfos,
  type ConnectorPermissionInfo,
} from "./shared/firewall-permissions";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountView,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountEntry,
} from "./connector/run-account-context";

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
  const policies = permissionGrantsToFirewallPolicies(
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
): Promise<void> {
  const personal = isPersonalExecution();
  if (personal) {
    console.log(`User ID:    ${payload?.userId ?? chalk.dim("unavailable")}`);
    console.log(
      `Chat ID:    ${process.env.OKOU_CHAT_THREAD_ID ?? chalk.dim("unavailable")}`,
    );
  } else console.log(`Agent ID:   ${agentId}`);
  console.log(`Run ID:     ${payload?.runId ?? chalk.dim("unavailable")}`);
  console.log(`Org ID:     ${payload?.orgId ?? chalk.dim("unavailable")}`);
  await printWorkspace();
}

async function showSandboxInfo(showPermissions: boolean): Promise<void> {
  const agentId = getOkouAgentId();
  const payload = decodeSandboxTokenPayload();

  await printRunIdentity(agentId, payload);

  // Capabilities section
  if (payload?.capabilities?.length) {
    console.log();
    console.log(chalk.bold("Capabilities:"));
    console.log(`  ${payload.capabilities.join(", ")}`);
  }

  // Connected Services section
  if (showPermissions) {
    await printChatConnectorPermissions();
    return;
  }
  try {
    const view = await resolveRunConnectorAccountView();
    if (view.state === "unavailable") {
      console.log();
      console.log(chalk.bold("Connectors:"));
      console.log(
        `  ${chalk.dim(runConnectorAccountUnavailableMessage(view.reason))}`,
      );
      return;
    }
    if (view.connectors.length === 0) return;

    console.log();
    console.log(chalk.bold("Connectors:"));
    for (const connector of view.connectors) {
      const identity = formatRunConnectorIdentity(connector);
      console.log(`  ${connector.slug.padEnd(14)}${identity}`);
    }
  } catch {
    // Silently skip — connector info is supplementary
  }
}

async function showLocalInfo(): Promise<void> {
  const token = await getToken();
  if (token && isPersonalExecution()) {
    const member = await getCurrentMember().catch((error: unknown) => {
      if (error instanceof ApiRequestError && error.status === 401)
        return undefined;
      throw error;
    });
    if (member) {
      console.log(`User ID:    ${member.userId}`);
      console.log(`Email:      ${member.email}`);
      console.log(`Org ID:     ${member.orgId ?? chalk.dim("unavailable")}`);
      console.log(`API:        ${await getApiUrl()}`);
      await printWorkspace();
      return;
    }
  }
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
    "Show Chat account allowance and active member permissions inside a Run",
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
  - --permissions shows current Chat account allowance and shared member rules,
    including absolute expiry. These rules apply across your Chats and accounts.
  - Outside a Run, shows authentication and workspace information
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
      if (isRunBoundConnectorContext()) {
        await showSandboxInfo(options.permissions ?? false);
      } else {
        await showLocalInfo();
      }
    }),
  );
