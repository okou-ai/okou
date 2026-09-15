import {
  registerSessionResourceCleanup,
  type InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import type { PiAgentModelConfig, PiAgentStreamConfig } from "./types";

export function initializePiSessionResourceRegistry(): void {
  // Vite's SSR bundle otherwise keeps Pi's registry behind only the lazy
  // Codex adapter initializer, while AgentSession.dispose() remains eager.
  // Registering and immediately removing a no-op makes the shared registry's
  // initialization explicit without changing its cleanup policy.
  const unregister = registerSessionResourceCleanup(() => {
    return undefined;
  });
  unregister();
}

/** Bootstrap only the captured model; callers own credentials and session policy. */
export async function createPiModelRuntime(
  args: {
    readonly model: NonNullable<ReturnType<typeof resolvePiAgentModel>>;
    readonly config: PiAgentModelConfig;
    readonly credentials?: InMemoryCredentialStore;
  },
  signal?: AbortSignal,
): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
    ...(args.credentials === undefined
      ? {}
      : { credentials: args.credentials }),
    ...(signal === undefined ? {} : { signal }),
  });
  // Preserve the caller's resolved model, including maintenance-only metadata
  // corrections. Resolving the catalog again would discard those corrections.
  modelRuntime.registerProvider(
    args.config.provider,
    registeredModelConfig(args.model, args.config.apiKey, args.config),
  );
  return modelRuntime;
}

export function registeredModelConfig(
  model: NonNullable<ReturnType<typeof resolvePiAgentModel>>,
  apiKey: string,
  config: PiAgentStreamConfig,
) {
  return {
    name: model.provider,
    baseUrl: model.baseUrl,
    apiKey,
    api: model.api,
    streamSimple: piAgentStreamForConfig(config),
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        headers: model.headers,
        compat: model.compat,
      },
    ],
  };
}
