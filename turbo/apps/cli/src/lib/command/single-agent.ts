import { EventEmitter } from "node:events";
import { Command } from "commander";
import { singleAgentEnabled } from "../api/single-agent";
import { decodeSandboxTokenPayload } from "../api/sandbox-token";
import { getOkouToken } from "../okou-env";
import { listAgents } from "../api/domains/agents";
import { withErrorHandler } from "./with-error-handler";

// One invocation's resolved context, shared by its help and dispatch. This does
// not cache feature API responses across commands, users or workspaces.
const contexts = new WeakMap<Command, boolean>();
const guarded = new WeakSet<Command>();

export function personalCommandMode(command: Command): boolean {
  for (
    let current: Command | null = command;
    current;
    current = current.parent
  ) {
    const mode = contexts.get(current);
    if (mode !== undefined) return mode;
  }
  return decodeSandboxTokenPayload()?.singleAgent === true;
}

export async function resolveCommandMode(): Promise<boolean> {
  return getOkouToken() ? singleAgentEnabled() : false;
}

export async function personalExecutorId(): Promise<string> {
  const agent = (await listAgents()).find((entry) => {
    return entry.isDefaultAgent;
  });
  if (!agent)
    throw new Error(
      "This workspace has no available Okou executor. Check workspace access before retrying.",
    );
  return agent.agentId;
}

export const AGENT_UNAVAILABLE =
  "Agent management is unavailable in My Okou. Use okou instructions view/edit for your personal Instructions, or okou workflow --help for workspace Workflows. Explicit Agent writes are not redirected.";

export function configureCommandMode(command: Command, enabled: boolean): void {
  contexts.set(command, enabled);
  // Command groups own their nested mode configuration without adding eager
  // imports or a consumer-to-consumer merge dependency at the root.
  if (!(command instanceof EventEmitter)) {
    throw new Error("CLI command mode requires Commander event support");
  }
  command.emit("single-agent-mode", enabled);
  if (command.name() === "project")
    command.description(
      enabled
        ? "Manage your private workspace Projects"
        : "Manage your private cross-agent Projects",
    );
  if (command.name() === "whoami")
    command.description(
      enabled
        ? "Show your user, workspace, Run and capabilities"
        : "Show agent identity, run ID, and capabilities",
    );
  if (command.name() === "mcp")
    command.description(
      enabled
        ? "Use MCP connectors authorized for this Run"
        : "Use MCP connectors authorized for this Agent",
    );
  // Workflow-specific argument handling belongs to the Workflow command owner.
  if (["chat", "search", "connector"].includes(command.name())) {
    const visit = (node: Command) => {
      if (command.name() === "chat" && node.name() === "move")
        node.description(
          enabled
            ? "Join, move, or leave a Project without changing execution context or history"
            : "Join, move, or leave a Project without changing Agent or history",
        );
      for (const option of node.options) {
        if (["agent", "allAgents"].includes(option.attributeName()))
          option.hideHelp(enabled);
      }
      for (const child of node.commands) visit(child);
    };
    visit(command);
    if (guarded.has(command)) return;
    guarded.add(command);
    command.hook(
      "preAction",
      withErrorHandler(async (_parent: Command, action: Command) => {
        if (!personalCommandMode(action)) return;
        const options = action.optsWithGlobals<{
          agent?: string;
          allAgents?: boolean;
        }>();
        if (options.agent !== undefined || options.allAgents !== undefined) {
          throw new Error(
            "Agent selection is unavailable in My Okou. Remove --agent/--all-agents to use your current workspace context.",
          );
        }
      }),
    );
  }
}

export function modeHelp(legacy: string, personal: string) {
  return ({ command }: { command: Command }): string => {
    return personalCommandMode(command) ? personal : legacy;
  };
}

export const PERSONAL_CONNECTOR_HELP = `
Your own accounts and Okou access in the current workspace are selected automatically.
A connected account alone does not grant access. Inspect connector status --json,
connector account list --json and okou whoami --permissions before acting.
Preserve fine-grained allow/deny rules, original expiry and revocation. Switching
accounts does not reset permissions. Account consent is not purchase approval.
Chat-specific account allowances and selections apply only when that capability
is enabled; this command does not enable it. Unavailable admitted accounts never
fall back to another account. Disconnect removes the saved account; unauthorize
only narrows your Okou access while retaining the account where supported.

Use connector check --url <failed-url> --method <method> before requesting access.
Use only the exact permission-request command from a deny/ask diagnosis, not provider
OAuth scopes. Custom connector permissions are managed in Connectors settings.
A batch file contains diagnosed { connector, permission, url, method } entries;
AWS selectors must match the diagnosis. Already allowed permissions are skipped.

Use --callback-prompt only for one access action in the current web chat, including
one batch approval. Keep it concise and free of secrets. Return every action URL
verbatim and end the turn for approval. For multiple access actions, return all
ordinary links and wait for completion. A callback requires this Chat's execution
context; it does not grant another member's access.

Inspect exact connectionIds with connector account list; do not invent them.
Changes retain the command's documented account/Chat scope and effective grants.
Use each subcommand's options for supported selectors, file and JSON formats.
`;
