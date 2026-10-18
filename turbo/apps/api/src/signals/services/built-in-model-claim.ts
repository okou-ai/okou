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
import {
  isBuiltInModelRuntimeRoutePermitted,
  type BuiltInModelRuntimeRoute,
} from "./built-in-model-runtime-route.service";
import { PI_MEMORY_BUILTIN_BINDING } from "./pi-memory-builtin-config";

export type ClaimModelCapture = Pick<
  typeof agentRuns.$inferSelect,
  | "agentId"
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
      (isAutoRunPreset(context.environment?.OPENAI_MODEL) ||
        isAutoRunPreset(context.platformEnvironment.OPENAI_MODEL)))
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

function isPermittedCapturedModelRoute(
  route: BuiltInModelRuntimeRoute,
  agentId: ClaimModelCapture["agentId"],
  context: StoredExecutionContext,
): boolean {
  if (isBuiltInModelRuntimeRoutePermitted(route)) {
    return true;
  }
  // This existing private binding is never a foreground model candidate.
  return (
    agentId === null &&
    context.cliAgentType === "pi" &&
    context.piLaunchConfig?.maintenance !== undefined &&
    context.piModelConfig?.dialect === "openai-completions" &&
    route.selectedModel === PI_MEMORY_BUILTIN_BINDING.selectedModel &&
    route.providerType === PI_MEMORY_BUILTIN_BINDING.providerType &&
    route.upstreamModel === PI_MEMORY_BUILTIN_BINDING.upstreamModel
  );
}

function isConsistentModelEnvironment(
  upstreamModel: string,
  context: StoredExecutionContext,
): boolean {
  // Runner applies the trusted platform overlay after the model environment.
  const model =
    context.platformEnvironment.OPENAI_MODEL ??
    context.environment?.OPENAI_MODEL;
  const baseUrl =
    context.platformEnvironment.OPENAI_BASE_URL ??
    context.environment?.OPENAI_BASE_URL;
  const credential =
    context.platformEnvironment.OPENAI_API_KEY ??
    context.environment?.OPENAI_API_KEY;
  return (
    model === upstreamModel &&
    baseUrl ===
      MODEL_PROVIDER_TYPES[AUTO_RUN_PROVIDER].envBindings.OPENAI_BASE_URL &&
    credential === MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY
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
    !run.builtInModelKeyId
  ) {
    return false;
  }
  if (
    !isPermittedCapturedModelRoute(
      {
        selectedModel: run.selectedModel,
        providerType: run.modelRuntimeProvider,
        upstreamModel: run.modelRuntimeModel,
        modelKeyId: run.builtInModelKeyId,
      },
      run.agentId,
      context,
    )
  ) {
    return false;
  }
  if (!isConsistentModelEnvironment(run.modelRuntimeModel, context)) {
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
