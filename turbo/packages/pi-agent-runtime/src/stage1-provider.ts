import type { PiAgentModelConfig } from "./types";

export const PI_MEMORY_STAGE1_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    raw_memory: { type: "string" },
    rollout_summary: { type: "string" },
    rollout_slug: { type: ["string", "null"] },
  },
  required: ["raw_memory", "rollout_summary", "rollout_slug"],
  additionalProperties: false,
} as const;

export interface PiMemoryStage1ProviderUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface PiMemoryStage1ProviderResult {
  readonly responseText: string;
  readonly responseId: string | undefined;
  readonly usage: PiMemoryStage1ProviderUsage;
}

export class PiMemoryStage1ProviderError extends Error {
  constructor(
    readonly status?: number,
    readonly result?: PiMemoryStage1ProviderResult,
  ) {
    super("Pi memory Stage 1 provider request failed");
    this.name = "PiMemoryStage1ProviderError";
  }
}

/** Plain measured request data; it contains no graph or transport capabilities. */
export interface PiMemoryStage1PreparedRequest {
  readonly model: PiAgentModelConfig;
  readonly requestId: string;
  readonly payload: unknown;
}

/** Retain actual provider consumption through unsuccessful terminal results. */
export function piMemoryStage1TerminalResult(
  result: PiMemoryStage1ProviderResult,
  terminal: {
    readonly stopReason: string;
    readonly hasToolCall: boolean;
    readonly responseStatus?: number;
  },
): PiMemoryStage1ProviderResult {
  if (terminal.stopReason !== "stop" || terminal.hasToolCall) {
    // SDK-generated sentinels have zero usage. Only actual usage-bearing terminal
    // responses carry consumption through failure.
    const hasUsage = Object.values(result.usage).some((value) => {
      return value !== 0;
    });
    throw new PiMemoryStage1ProviderError(
      terminal.responseStatus,
      hasUsage ? result : undefined,
    );
  }
  return result;
}
