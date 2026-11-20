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
