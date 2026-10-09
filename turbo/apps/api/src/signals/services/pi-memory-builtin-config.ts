import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import {
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  PI_MEMORY_PRESET,
} from "@okouai/pi-agent-runtime/api";
import { eq } from "drizzle-orm";
import { db$ } from "../external/db";
import { command } from "ccstate";
import type { ResolvedModelProviderEnvironment } from "./agent-run-contracts";
import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { compileModelRuntime } from "./execution-model-runtime";
import type { ModelSourceSnapshot } from "./execution-model-source.service";

/** Internal maintenance binding. This is never a foreground model candidate. */
export const PI_MEMORY_BUILTIN_BINDING = {
  selectedModel: PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  providerType: "openrouter-codex",
  upstreamModel: PI_MEMORY_PRESET,
} as const;

/** Fixed read owner for the internal route, without foreground default selection. */
export const resolvePiMemoryBuiltinRoute$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<BuiltInModelRuntimeRoute | null> => {
    const [key] = await get(db$)
      .select({ id: builtInModelKeys.id, apiKey: builtInModelKeys.apiKey })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.vendor, "openrouter"))
      .limit(1);
    signal.throwIfAborted();
    return key?.apiKey.trim()
      ? { ...PI_MEMORY_BUILTIN_BINDING, modelKeyId: key.id }
      : null;
  },
);

export function preparePiMemoryBuiltinEnvironment(
  source: ModelSourceSnapshot,
  route: BuiltInModelRuntimeRoute | undefined,
): ResolvedModelProviderEnvironment | null {
  if (
    source.identity.kind !== "built-in" ||
    !route ||
    route.modelKeyId !== source.identity.modelKeyId ||
    route.selectedModel !== PI_MEMORY_BUILTIN_BINDING.selectedModel ||
    route.providerType !== PI_MEMORY_BUILTIN_BINDING.providerType ||
    route.upstreamModel !== PI_MEMORY_BUILTIN_BINDING.upstreamModel
  ) {
    return null;
  }
  const credential = source.credentials.find((item) => {
    return (
      item.kind === "managed-key" &&
      item.modelKeyId === route.modelKeyId &&
      item.name === "OPENROUTER_API_KEY"
    );
  });
  if (
    !credential ||
    credential.kind !== "managed-key" ||
    !credential.apiKey.trim()
  ) {
    return null;
  }
  const compiled = compileModelRuntime({
    source,
    selection: { kind: "built-in", ...route },
    credentials: { OPENROUTER_API_KEY: credential.apiKey },
  });
  return {
    id: null,
    type: "built-in",
    credentialOwner: "builtin",
    concreteType: route.providerType,
    selectedModel: route.selectedModel,
    upstreamModel: route.upstreamModel,
    builtInModelRuntimeRoute: route,
    environment: { ...compiled.environment },
    secrets: { ...compiled.secrets },
  };
}
