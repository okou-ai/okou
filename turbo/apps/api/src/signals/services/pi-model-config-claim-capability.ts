import {
  PI_MODEL_CONFIG_CURRENT_GENERATION,
  PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
  PI_MODEL_CONFIG_LEGACY_GENERATION,
  piModelConfigLegacySchema,
  piModelConfigSchema,
  piModelConfigV2Schema,
  piModelConfigV3Schema,
  type PiModelConfig,
  type RunnerClaimCapabilities,
} from "@okouai/api-contracts/contracts/runners";
import { z } from "zod";

type PiModelConfigClaimResolution =
  | {
      readonly status: "compatible";
      readonly modelConfig: PiModelConfig | undefined;
    }
  | { readonly status: "unsupported" }
  | { readonly status: "invalid"; readonly error: z.ZodError };

function configuredGeneration(value: unknown): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (!("schemaVersion" in value)) {
    return PI_MODEL_CONFIG_LEGACY_GENERATION;
  }
  const generation = value.schemaVersion;
  return typeof generation === "number" &&
    Number.isInteger(generation) &&
    generation > 0 &&
    generation <= 255
    ? generation
    : null;
}

function supportsGeneration(
  generation: number,
  capabilities: RunnerClaimCapabilities,
): boolean {
  return capabilities.piModelConfigGenerations.includes(generation);
}

function invalidModelConfig(value: unknown): PiModelConfigClaimResolution {
  const parsed = piModelConfigSchema.safeParse(value);
  if (parsed.success) {
    throw new Error("Pi model config generation resolution drifted");
  }
  return { status: "invalid", error: parsed.error };
}

/** Resolve a stored Pi route only when both this API and the claimant support it. */
export function resolvePiModelConfigForClaim(args: {
  readonly cliAgentType: string;
  readonly modelConfig: unknown;
  readonly capabilities: RunnerClaimCapabilities;
}): PiModelConfigClaimResolution {
  if (args.cliAgentType !== "pi") {
    return { status: "compatible", modelConfig: undefined };
  }
  const generation = configuredGeneration(args.modelConfig);
  if (generation === null) {
    return invalidModelConfig(args.modelConfig);
  }
  if (!supportsGeneration(generation, args.capabilities)) {
    return { status: "unsupported" };
  }
  if (generation === PI_MODEL_CONFIG_LEGACY_GENERATION) {
    const parsed = piModelConfigLegacySchema.safeParse(args.modelConfig);
    return parsed.success
      ? { status: "compatible", modelConfig: parsed.data }
      : { status: "invalid", error: parsed.error };
  }
  if (generation === PI_MODEL_CONFIG_CURRENT_GENERATION) {
    const parsed = piModelConfigV2Schema.safeParse(args.modelConfig);
    return parsed.success
      ? { status: "compatible", modelConfig: parsed.data }
      : { status: "invalid", error: parsed.error };
  }
  if (generation === PI_MODEL_CONFIG_DIALECT_TIER_GENERATION) {
    const parsed = piModelConfigV3Schema.safeParse(args.modelConfig);
    return parsed.success
      ? { status: "compatible", modelConfig: parsed.data }
      : { status: "invalid", error: parsed.error };
  }
  // A future Runner may advertise a future generation, but this API cannot
  // validate or serialize it yet. Leave the job queued for a matching API.
  return { status: "unsupported" };
}
