import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";

interface AgentRunVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

export function buildAgentRunVariables(args: {
  readonly agentId: string;
  readonly variables: readonly AgentRunVariable[];
}): Record<string, string> {
  const orgVars: Record<string, string> = {};
  const userVars: Record<string, string> = {};
  for (const row of args.variables) {
    if (row.name.startsWith("ZERO_")) {
      continue;
    }
    if (row.userId === ORG_SENTINEL_USER_ID) {
      orgVars[row.name] = row.value;
    } else {
      userVars[row.name] = row.value;
    }
  }

  return { ...orgVars, ...userVars, OKOU_AGENT_ID: args.agentId };
}
