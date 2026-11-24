interface AgentRunVariable {
  readonly name: string;
  readonly value: string;
  readonly isOrg: boolean;
}

export function buildAgentRunVariables(args: {
  readonly variables: readonly AgentRunVariable[];
}): Record<string, string> {
  const orgVars: Record<string, string> = {};
  const userVars: Record<string, string> = {};
  for (const row of args.variables) {
    if (row.name.startsWith("ZERO_")) {
      continue;
    }
    if (row.isOrg) {
      orgVars[row.name] = row.value;
    } else {
      userVars[row.name] = row.value;
    }
  }

  return { ...orgVars, ...userVars };
}
