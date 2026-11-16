import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";

export interface RunBodyEnvironment {
  readonly vars?: Record<string, string>;
  readonly secrets?: Record<string, string>;
}

interface PersistedRunEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

export interface PersistedRunEnvironmentSnapshot {
  readonly variables: readonly PersistedRunEnvironmentVariable[];
}

export function buildAgentRunEnvironment(args: {
  readonly agentId: string;
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
}): RunBodyEnvironment {
  const orgVars: Record<string, string> = {};
  const userVars: Record<string, string> = {};
  for (const row of args.persistedEnvironment.variables) {
    if (row.name.startsWith("ZERO_")) {
      continue;
    }
    if (row.userId === ORG_SENTINEL_USER_ID) {
      orgVars[row.name] = row.value;
    } else {
      userVars[row.name] = row.value;
    }
  }

  return {
    vars: { ...orgVars, ...userVars, OKOU_AGENT_ID: args.agentId },
    // Only the Run token is named here; provider/connector owners add their
    // authorized secrets when preparing execution.
    secrets: { OKOU_TOKEN: "__pending_okou_token__" },
  };
}
