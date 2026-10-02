import { getInstructionsFilename } from "@okouai/core/frameworks";
import { extractAndGroupVariables } from "@okouai/core/variable-expander";

import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "./agent-execution-plan";

export interface AgentExecutionDefinition {
  readonly framework?: string;
  readonly instructions?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly volumes?: readonly string[];
  readonly experimental_runner?: { readonly group?: string };
  readonly experimental_profile?: string;
}

export interface AgentExecutionVolume {
  readonly name: string;
  readonly version: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

export interface AgentExecutionConfig {
  readonly version?: string;
  readonly agent?: AgentExecutionDefinition;
  readonly agents?: Readonly<
    Record<string, AgentExecutionDefinition | undefined>
  >;
  readonly volumes?: Readonly<Record<string, AgentExecutionVolume>>;
}

export function buildAgentExecutionConfig(
  agentName: string,
): AgentExecutionConfig {
  const plan = APPLICATION_OWNED_AGENT_EXECUTION_PLAN;
  const environment: Record<string, string> = {
    [plan.environment.legacySerializedBindings.agentId]:
      `\${{ vars.OKOU_AGENT_ID }}`,
    [plan.environment.legacySerializedBindings.token]:
      `\${{ secrets.OKOU_TOKEN }}`,
  };

  const agentDefinition: AgentExecutionDefinition = {
    framework: plan.framework.fallback,
    instructions: getInstructionsFilename(plan.framework.fallback),
    environment,
  };

  return {
    version: "1",
    agents: { [agentName]: agentDefinition },
  };
}

function isApplicationRuntimeEnvironmentKey(name: string): boolean {
  return APPLICATION_OWNED_AGENT_EXECUTION_PLAN.environment.runtimeOverrideKeys.some(
    (runtimeKey) => {
      return runtimeKey === name;
    },
  );
}

export function userConfiguredAgentEnvironmentRequirements(agentName: string): {
  readonly secrets: string[];
  readonly vars: string[];
} {
  const grouped = extractAndGroupVariables(
    buildAgentExecutionConfig(agentName),
  );
  return {
    secrets: grouped.secrets
      .map((secret) => {
        return secret.name;
      })
      .filter((name) => {
        return !isApplicationRuntimeEnvironmentKey(name);
      }),
    vars: grouped.vars
      .map((variable) => {
        return variable.name;
      })
      .filter((name) => {
        return !isApplicationRuntimeEnvironmentKey(name);
      }),
  };
}
