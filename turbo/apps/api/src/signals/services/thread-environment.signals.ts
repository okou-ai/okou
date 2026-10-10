import { FirewallBaseUrlResolutionError } from "@okouai/connectors/firewall-types";
import { expandVariables } from "@okouai/core/variable-expander";
import { computed, type Computed } from "ccstate";
import { badRequestMessage } from "../../lib/error";
import { safeSync } from "../utils";
import { compactRecord } from "./connector-runtime-preparation.service";
import { modelProviderPermissionManifest } from "./permission-manifest.service";
import { createRunBodyEnvironmentSignal } from "./run-body-environment";
import {
  emptyEnvironment,
  type Environment,
  mergeEnvironments,
} from "./run-environment";
import type { ThreadContext } from "./thread-context.signals";
import type { ThreadModelError } from "./thread-model.signals";

type EnvironmentError = ThreadModelError | ReturnType<typeof badRequestMessage>;

function isEnvironmentError(value: unknown): value is EnvironmentError {
  return typeof value === "object" && value !== null && "status" in value;
}

/** The selected model provider's environment, secrets and firewall. */
export function createModelProviderEnvironmentSignals(
  threadContext: ThreadContext,
) {
  const bodyEnvironment$ = createRunBodyEnvironmentSignal(
    threadContext.executionBootstrap$,
  );
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [modelProvider, body] = await Promise.all([
      get(threadContext.modelRoute$),
      get(bodyEnvironment$),
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
 * The Run environment before its Okou token: connector and model-provider
 * sources merged in one place. Model-provider secrets and environment entries
 * override connector ones; its firewall is matched first.
 */
export function createEnvironmentSignals(
  threadContext: ThreadContext,
  connectorEnvironment$: Computed<Promise<Environment | EnvironmentError>>,
) {
  const modelProviderEnvironment$ =
    createModelProviderEnvironmentSignals(threadContext);
  return computed(async (get): Promise<Environment | EnvironmentError> => {
    const [connector, modelProvider] = await Promise.all([
      get(connectorEnvironment$),
      get(modelProviderEnvironment$),
    ]);
    if (isEnvironmentError(connector)) {
      return connector;
    }
    if (isEnvironmentError(modelProvider)) {
      return modelProvider;
    }
    return mergeEnvironments(
      [connector, modelProvider],
      [modelProvider, connector],
    );
  });
}
