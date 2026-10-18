import {
  getModelProviderPiEndpoint,
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_TYPES,
} from "@okouai/api-contracts/contracts/model-providers";
import type { StoredExecutionContext } from "@okouai/api-contracts/contracts/runners";
import {
  AUTO_RUN_PROVIDER,
  isAutoRunPreset,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import { isBuiltInModelRuntimeRoutePermitted } from "./built-in-model-runtime-route.service";

export type ClaimModelCapture = Pick<
  typeof agentRuns.$inferSelect,
  | "modelProvider"
  | "modelProviderId"
  | "selectedModel"
  | "modelRuntimeProvider"
  | "modelRuntimeModel"
  | "builtInModelKeyId"
>;

/** Contradictory managed hints must not downgrade a claim to user-owned work. */
export function capturedModelRequiresOfficialRunner(
  run: ClaimModelCapture,
): boolean {
  return (
    run.modelProvider === "built-in" ||
    run.builtInModelKeyId !== null ||
    run.modelRuntimeProvider === AUTO_RUN_PROVIDER ||
    isAutoSelectedModel(run.selectedModel)
  );
}

function hasManagedModelContext(context: StoredExecutionContext): boolean {
  return (
    (context.cliAgentType === "pi" &&
      context.piModelConfig?.provider === "openrouter") ||
    (context.cliAgentType === "codex" &&
      context.codexRuntimeConfig?.providerId === AUTO_RUN_PROVIDER) ||
    ((context.cliAgentType === "pi" || context.cliAgentType === "codex") &&
      isAutoRunPreset(context.environment?.OPENAI_MODEL))
  );
}

function isConsistentPiModelCapture(
  run: ClaimModelCapture,
  context: StoredExecutionContext,
): boolean {
  const config = context.piModelConfig;
  if (!config || config.provider !== "openrouter") {
    return false;
  }
  const endpoint = getModelProviderPiEndpoint(
    AUTO_RUN_PROVIDER,
    config.dialect,
  );
  return (
    endpoint !== undefined &&
    config.baseUrl === endpoint.baseUrl &&
    config.model === run.modelRuntimeModel &&
    (config.catalogModel === undefined ||
      config.catalogModel === run.selectedModel) &&
    config.credentialBindings.length === 1 &&
    config.credentialBindings[0]?.kind === "api-key" &&
    config.credentialBindings[0].environment === "OPENAI_API_KEY" &&
    config.credentialBindings[0].secretName ===
      MODEL_PROVIDER_TYPES[AUTO_RUN_PROVIDER].secretName
  );
}

function isConsistentCodexModelCapture(
  run: ClaimModelCapture,
  context: StoredExecutionContext,
): boolean {
  const config = context.codexRuntimeConfig;
  if (!config) {
    return false;
  }
  return (
    config.providerId === run.modelRuntimeProvider &&
    config.baseUrl ===
      MODEL_PROVIDER_TYPES[AUTO_RUN_PROVIDER].envBindings.OPENAI_BASE_URL &&
    config.envKey === "OPENAI_API_KEY" &&
    config.wireApi === "responses" &&
    !config.requiresOpenaiAuth
  );
}

/** Validate the captured owner/route without loading keys or mutable catalog state. */
export function isCapturedModelClaimConsistent(
  run: ClaimModelCapture,
  context: StoredExecutionContext,
): boolean {
  if (
    !capturedModelRequiresOfficialRunner(run) &&
    !hasManagedModelContext(context)
  ) {
    return true;
  }
  if (
    run.modelProvider !== "built-in" ||
    run.modelProviderId !== null ||
    run.selectedModel === null ||
    run.modelRuntimeProvider !== AUTO_RUN_PROVIDER ||
    run.modelRuntimeModel === null ||
    !run.builtInModelKeyId ||
    !isBuiltInModelRuntimeRoutePermitted({
      selectedModel: run.selectedModel,
      providerType: run.modelRuntimeProvider,
      upstreamModel: run.modelRuntimeModel,
      modelKeyId: run.builtInModelKeyId,
    })
  ) {
    return false;
  }
  const provider = MODEL_PROVIDER_TYPES[AUTO_RUN_PROVIDER];
  const baseUrl = provider.envBindings.OPENAI_BASE_URL;
  if (
    context.environment?.OPENAI_MODEL !== run.modelRuntimeModel ||
    context.environment.OPENAI_BASE_URL !== baseUrl ||
    context.environment.OPENAI_API_KEY !==
      MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY
  ) {
    return false;
  }
  if (context.cliAgentType === "pi") {
    return isConsistentPiModelCapture(run, context);
  }
  if (context.cliAgentType === "codex") {
    return isConsistentCodexModelCapture(run, context);
  }
  return false;
}
