import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-provider-types";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_IMAGE_GENERATION_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import { FirewallBaseUrlResolutionError } from "@okouai/connectors/firewall-types";
import { expandVariables } from "@okouai/core/variable-expander";
import { computed } from "ccstate";
import { badRequestMessage } from "../../lib/error";
import { safeSync } from "../utils";
import { compactRecord } from "./connector-runtime-preparation.service";
import { modelProviderPermissionManifest } from "./permission-manifest.service";
import { emptyEnvironment, type Environment } from "./run-environment";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type { ThreadContext } from "./thread-context.signals";
import type { ThreadModelError } from "./thread-model.signals";

type EnvironmentError = ThreadModelError | ReturnType<typeof badRequestMessage>;

function isEnvironmentError(value: unknown): value is EnvironmentError {
  return typeof value === "object" && value !== null && "status" in value;
}

/** The selected model provider's environment, secrets and firewall. */
export function createModelProviderEnvironmentSignals(
  bootstrap: Pick<AgentRunContextSignals, "bodyEnvironment$">,
  threadContext: Pick<ThreadContext, "modelRoute$">,
) {
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [modelProvider, body] = await Promise.all([
      get(threadContext.modelRoute$),
      get(bootstrap.bodyEnvironment$),
    ]);
    if (isEnvironmentError(modelProvider)) {
      return modelProvider;
    }
    if (!modelProvider) {
      return emptyEnvironment();
    }
    const manifestResult = safeSync(() => {
      return modelProviderPermissionManifest(modelProvider, body.vars);
    });
    if ("error" in manifestResult) {
      if (manifestResult.error instanceof FirewallBaseUrlResolutionError) {
        return badRequestMessage(manifestResult.error.message);
      }
      throw manifestResult.error;
    }
    const manifest = manifestResult.ok;
    return {
      vars: undefined,
      environment: compactRecord(
        expandVariables(modelProvider.environment, {
          vars: body.vars,
          secrets: {
            ...modelProvider.secrets,
            ...manifest?.environmentSecretPlaceholders,
          },
        }).result,
      ),
      platformEnvironment: undefined,
      secrets: compactRecord(modelProvider.secrets),
      secretConnectorMap: modelProvider.secretConnectorMap,
      secretConnectorMetadataMap: modelProvider.secretConnectorMetadataMap,
      firewalls: manifest?.firewalls ?? [],
      networkPolicies: manifest?.networkPolicies ?? {},
      environmentSecretPlaceholders: manifest?.environmentSecretPlaceholders,
      billableFirewalls: manifest?.billableFirewalls ?? [],
      runtimeTargets: [],
      reservedSecretAliases: [],
    };
  });
}

export function paidToolPlatformEnvironment(args: {
  readonly disabledTools: readonly string[];
  readonly framework: string;
  readonly modelProviderType: string | null;
  readonly piExecution: boolean;
}): Record<string, string> {
  const { disabledTools, framework, modelProviderType, piExecution } = args;
  const allowFrameworkTools =
    !piExecution &&
    (modelProviderType === null ||
      !isBuiltInModelProviderType(modelProviderType));
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
