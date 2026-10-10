import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import { FirewallBaseUrlResolutionError } from "@okouai/connectors/firewall-types";
import { expandVariables } from "@okouai/core/variable-expander";
import { computed } from "ccstate";
import { badRequestMessage } from "../../lib/error";
import { safeSync } from "../utils";
import { compactRecord } from "./connector-runtime-preparation.service";
import { modelProviderPermissionManifest } from "./permission-manifest.service";
import {
  emptyEnvironment,
  type Environment,
  mergeEnvironments,
} from "./run-environment";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { createConnectorEnvironmentSignals } from "./thread-connector-environment.signals";
import type { ThreadContext } from "./thread-context.signals";
import type { ThreadModelError } from "./thread-model.signals";

type EnvironmentError = ThreadModelError | ReturnType<typeof badRequestMessage>;

function isEnvironmentError(value: unknown): value is EnvironmentError {
  return typeof value === "object" && value !== null && "status" in value;
}

/** The selected model provider's environment, secrets and firewall. */
export function createModelProviderEnvironmentSignals(
  bootstrap: AgentRunContextSignals,
  threadContext: ThreadContext,
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

/**
 * Paid-tool switches: the tools the user disabled, and whether a framework's
 * native web search replaces Okou web search. That needs Claude Code or Codex
 * outside Pi, billed to the user's own key or subscription.
 */
export function createPaidToolEnvironmentSignals(
  bootstrap: AgentRunContextSignals,
  threadContext: ThreadContext,
) {
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [disabledTools, framework, modelProvider, selection] =
      await Promise.all([
        get(bootstrap.disabledPaidTools$),
        get(threadContext.providerFramework$),
        get(threadContext.modelRoute$),
        get(threadContext.subscriptionSelection$),
      ]);
    if (isEnvironmentError(framework)) {
      return framework;
    }
    if (isEnvironmentError(modelProvider)) {
      return modelProvider;
    }
    if (isEnvironmentError(selection)) {
      return selection;
    }
    const frameworkWebSearch =
      !selection.piExecution &&
      disabledTools.includes("web-search") &&
      (framework === "claude-code" || framework === "codex") &&
      (modelProvider === null ||
        !isBuiltInModelProviderType(modelProvider.type));
    return {
      ...emptyEnvironment(),
      platformEnvironment: {
        [DISABLED_PAID_TOOLS_ENV_VAR]: JSON.stringify(disabledTools),
        ...(frameworkWebSearch
          ? { [ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR]: "true" }
          : {}),
      },
    };
  });
}

/**
 * The Run environment before its Okou token: connector and model-provider
 * sources merged in one place. Model-provider secrets and environment entries
 * override connector ones; its firewall is matched first.
 */
export function createEnvironmentSignals(
  bootstrap: AgentRunContextSignals,
  threadContext: ThreadContext,
) {
  const connectorEnvironment$ = createConnectorEnvironmentSignals(
    bootstrap,
    threadContext,
  );
  const modelProviderEnvironment$ = createModelProviderEnvironmentSignals(
    bootstrap,
    threadContext,
  );
  const paidToolEnvironment$ = createPaidToolEnvironmentSignals(
    bootstrap,
    threadContext,
  );
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [connector, modelProvider, paidTools] = await Promise.all([
      get(connectorEnvironment$),
      get(modelProviderEnvironment$),
      get(paidToolEnvironment$),
    ]);
    if (isEnvironmentError(paidTools)) {
      return paidTools;
    }
    if (isEnvironmentError(connector)) {
      return connector;
    }
    if (isEnvironmentError(modelProvider)) {
      return modelProvider;
    }
    return mergeEnvironments(
      [connector, modelProvider, paidTools],
      [modelProvider, connector, paidTools],
    );
  });
}
