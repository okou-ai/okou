import type { unifiedRunRequestSchema } from "@okouai/api-contracts/contracts/runs";
import type { z } from "zod";
import { compactRecord } from "./connector-runtime-preparation.service";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";

export type RunRequestBody = z.infer<typeof unifiedRunRequestSchema>;

export function pendingOkouTokenSecrets(secrets: RunRequestBody["secrets"]) {
  return {
    ...withoutLegacyAgentRunEnvironmentEntries(secrets),
    OKOU_TOKEN: "__pending_okou_token__",
  };
}

export function withoutLegacyAgentRunEnvironmentEntries<T>(
  values: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  if (!values) {
    return undefined;
  }
  const canonical: Record<string, T> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("ZERO_")) {
      canonical[key] = value;
    }
  }
  return compactRecord(canonical);
}

interface PersistedRunEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly userId: string;
}

export interface PersistedRunEnvironmentSnapshot {
  readonly variables: readonly PersistedRunEnvironmentVariable[];
}

function buildMergedVariables(args: {
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly runVars: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const orgVars: Record<string, string> = {};
  const userVars: Record<string, string> = {};
  for (const row of args.persistedEnvironment.variables) {
    if (row.userId === ORG_SENTINEL_USER_ID) {
      orgVars[row.name] = row.value;
    } else {
      userVars[row.name] = row.value;
    }
  }

  const merged = { ...orgVars, ...userVars, ...args.runVars };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export type RunBodyEnvironment = Pick<RunRequestBody, "vars" | "secrets">;

export function resolveRunBodyEnvironment(args: {
  readonly runVars: RunRequestBody["vars"];
  readonly runSecrets: RunRequestBody["secrets"];
  readonly persistedEnvironment: PersistedRunEnvironmentSnapshot;
  readonly canonicalOkouRuntime: boolean;
}): RunBodyEnvironment {
  const mergedVars = buildMergedVariables({
    persistedEnvironment: args.persistedEnvironment,
    runVars: args.runVars,
  });
  // Inject only current Run credentials and authorized provider/connector
  // bindings; unreferenced org/user secrets remain outside the sandbox.
  const mergedSecrets = args.runSecrets;

  return {
    vars: args.canonicalOkouRuntime
      ? withoutLegacyAgentRunEnvironmentEntries(mergedVars)
      : mergedVars,
    secrets: args.canonicalOkouRuntime
      ? withoutLegacyAgentRunEnvironmentEntries(mergedSecrets)
      : mergedSecrets,
  };
}

export function selectedAgentRunVariables(agentId: string) {
  return { OKOU_AGENT_ID: agentId };
}
