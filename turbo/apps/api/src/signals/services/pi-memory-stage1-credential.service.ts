import { getModelProviderPiEndpoint } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import {
  isPiAgentModelSupported,
  type PiAgentModelConfig,
} from "@okouai/pi-agent-runtime";
import {
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  piMemorySessionAffinityKey,
  type PiMemoryStage1Model,
} from "@okouai/pi-agent-runtime/api";
import { eq } from "drizzle-orm";
import { command } from "ccstate";
import { db$ } from "../external/db";
import { resolvePiMemoryBuiltinRoute$ } from "./pi-memory-builtin-config";

export type PiMemoryStage1CredentialSkip =
  | "source_missing"
  | "source_owner_mismatch"
  | "credential_unavailable"
  | "provider_model_unsupported";

export class PiMemoryStage1CredentialError extends Error {
  constructor(readonly errorClass: PiMemoryStage1CredentialSkip) {
    super("Pi memory Stage 1 credential unavailable");
    this.name = "PiMemoryStage1CredentialError";
  }
}

export interface PiMemoryStage1Billing {
  readonly mode: "builtin" | "subscription" | "free";
  readonly orgId: string;
  readonly userId: string;
}

interface SourceIdentity {
  readonly sourceRunId: string;
  readonly orgId: string;
  readonly userId: string;
}

interface PiMemoryStage1CredentialProof {
  readonly source: SourceIdentity;
  readonly binding: { readonly orgId: string; readonly userId: string };
  readonly credential: { readonly modelKeyId: string; readonly apiKey: string };
}

export type PiMemoryStage1CredentialResult =
  | { readonly status: "skip"; readonly reason: PiMemoryStage1CredentialSkip }
  | {
      readonly status: "available";
      readonly model: PiAgentModelConfig;
      readonly selectedModel: PiMemoryStage1Model;
      readonly billing: PiMemoryStage1Billing;
      readonly longContextMinTotalInputTokens: number | null;
      readonly proof: PiMemoryStage1CredentialProof;
    };

const readSourceBinding$ = command(async ({ get }, source: SourceIdentity) => {
  const [binding] = await get(db$)
    .select({ orgId: agentRuns.orgId, userId: agentRuns.userId })
    .from(agentRuns)
    .where(eq(agentRuns.id, source.sourceRunId))
    .limit(1);
  return binding;
});

const readBuiltinKey$ = command(async ({ get }, modelKeyId: string) => {
  const [key] = await get(db$)
    .select({ apiKey: builtInModelKeys.apiKey })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.id, modelKeyId))
    .limit(1);
  return key?.apiKey;
});

/** Source ownership remains authority; memory always uses the platform preset. */
export const resolvePiMemoryStage1Credential$ = command(
  async (
    { set },
    source: SourceIdentity,
    signal: AbortSignal,
  ): Promise<PiMemoryStage1CredentialResult> => {
    const binding = await set(readSourceBinding$, source);
    signal.throwIfAborted();
    if (!binding) {
      return { status: "skip", reason: "source_missing" };
    }
    if (binding.orgId !== source.orgId || binding.userId !== source.userId) {
      return { status: "skip", reason: "source_owner_mismatch" };
    }
    const route = await set(resolvePiMemoryBuiltinRoute$, signal);
    signal.throwIfAborted();
    const endpoint = getModelProviderPiEndpoint(
      "openrouter-codex",
      "openai-completions",
    );
    if (!route || !endpoint) {
      return { status: "skip", reason: "provider_model_unsupported" };
    }
    const apiKey = await set(readBuiltinKey$, route.modelKeyId);
    signal.throwIfAborted();
    if (!apiKey?.trim()) {
      return { status: "skip", reason: "credential_unavailable" };
    }
    const model: PiAgentModelConfig = {
      provider: "openrouter",
      apiKey,
      model: route.upstreamModel,
      catalogModel: PI_MEMORY_STAGE1_BUILT_IN_MODEL,
      baseUrl: endpoint.baseUrl,
      dialect: "openai-completions",
      transport: "sse",
      sessionAffinityKey: piMemorySessionAffinityKey(
        source.userId,
        source.orgId,
      ),
    };
    if (!isPiAgentModelSupported(model)) {
      return { status: "skip", reason: "provider_model_unsupported" };
    }
    return {
      status: "available",
      model,
      selectedModel: PI_MEMORY_STAGE1_BUILT_IN_MODEL,
      longContextMinTotalInputTokens: null,
      billing: { mode: "free", orgId: source.orgId, userId: source.userId },
      proof: {
        source,
        binding,
        credential: { modelKeyId: route.modelKeyId, apiKey },
      },
    };
  },
);

/** Revalidate exact captured ownership and key without choosing another route. */
export const validatePiMemoryStage1Credential$ = command(
  async (
    { set },
    proof: PiMemoryStage1CredentialProof,
    signal: AbortSignal,
  ): Promise<void> => {
    const current = await set(readSourceBinding$, proof.source);
    signal.throwIfAborted();
    if (!current) {
      throw new PiMemoryStage1CredentialError("source_missing");
    }
    if (
      current.orgId !== proof.binding.orgId ||
      current.userId !== proof.binding.userId
    ) {
      throw new PiMemoryStage1CredentialError("source_owner_mismatch");
    }
    const key = await set(readBuiltinKey$, proof.credential.modelKeyId);
    signal.throwIfAborted();
    if (key !== proof.credential.apiKey) {
      throw new PiMemoryStage1CredentialError("credential_unavailable");
    }
  },
);
