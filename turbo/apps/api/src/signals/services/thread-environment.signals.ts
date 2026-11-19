import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-provider-types";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import { expandVariables } from "@okouai/core/variable-expander";
import { computed, type Computed } from "ccstate";
import { compactRecord } from "./connector-runtime-preparation.service";
import type { Environment } from "./run-environment";
import type {
  PermissionManifest,
  ResolvedModelProviderEnvironment,
} from "./agent-run-contracts";

/** The selected model provider's placeholders, source metadata and firewall. */
export function createModelProviderEnvironmentSignals(
  runVariables$: Computed<Promise<Record<string, string> | undefined>>,
  modelRoute$: Computed<Promise<ResolvedModelProviderEnvironment>>,
  modelPermissions$: Computed<Promise<PermissionManifest | undefined>>,
) {
  return computed(async (get): Promise<Environment> => {
    const [modelProvider, vars, manifest] = await Promise.all([
      get(modelRoute$),
      get(runVariables$),
      get(modelPermissions$),
    ]);
    return {
      vars: undefined,
      environment: compactRecord(
        expandVariables(modelProvider.environment, {
          vars,
          secrets: manifest?.environmentSecretPlaceholders,
        }).result,
      ),
      platformEnvironment: undefined,
      secretConnectorMap: modelProvider.secretConnectorMap,
      secretConnectorMetadataMap: modelProvider.secretConnectorMetadataMap,
      firewalls: manifest?.firewalls ?? [],
      networkPolicies: manifest?.networkPolicies ?? {},
      environmentSecretPlaceholders: manifest?.environmentSecretPlaceholders,
      billableFirewalls: manifest?.billableFirewalls ?? [],
      runtimeTargets: [],
      // Managed model names belong to the Run even without a startup value.
      reservedSecretAliases:
        modelProvider.credentialOwner === "builtin"
          ? Object.keys(manifest?.environmentSecretPlaceholders ?? {})
          : [],
    };
  });
}

export function paidToolPlatformEnvironment(args: {
  readonly disabledTools: readonly string[];
  readonly framework: string;
  readonly modelProviderType: string;
  readonly piExecution: boolean;
}): Record<string, string> {
  const { disabledTools, framework, modelProviderType, piExecution } = args;
  const allowFrameworkTools =
    !piExecution && !isBuiltInModelProviderType(modelProviderType);
  return {
    [DISABLED_PAID_TOOLS_ENV_VAR]: JSON.stringify(disabledTools),
    ...(allowFrameworkTools &&
    disabledTools.includes("web-search") &&
    (framework === "claude-code" || framework === "codex")
      ? { [ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR]: "true" }
      : {}),
    ...(allowFrameworkTools &&
    disabledTools.includes("image-generation") &&
    framework === "codex"
      ? { [ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR]: "true" }
      : {}),
  };
}
