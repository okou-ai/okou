import {
  PI_MEMORY_TRIGGER_SOURCE_CLASSES,
  triggerSourceSchema,
} from "@okouai/api-contracts/contracts/logs";

export type PiMemoryStage1AdmissionSkipReason =
  | "generation_disabled"
  | "history_not_hash_backed"
  | "missing_chat_thread"
  | "non_interactive_source"
  | "not_completed"
  | "not_pi"
  | "not_owned_chat_thread"
  | "pi_memory_disabled"
  | "invalid_source"
  | "synthetic_source"
  | "stale_source";

export interface AdmitPiMemoryStage1CandidateArgs {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: "completed" | "failed";
  readonly framework: "claude-code" | "codex" | "pi" | null;
  readonly generationEnabled: boolean;
  readonly triggerSource: string | null;
  readonly chatThreadId: string | null;
  readonly completedAt: Date;
  readonly idleDelayMs: number;
}

export function getPiMemoryStage1AdmissionPrerequisiteSkipReason(
  args: AdmitPiMemoryStage1CandidateArgs,
): PiMemoryStage1AdmissionSkipReason | null {
  if (args.status !== "completed") {
    return "not_completed";
  }
  if (args.framework !== "pi") {
    return "not_pi";
  }
  if (!args.generationEnabled) {
    return "generation_disabled";
  }
  const triggerSource = triggerSourceSchema.safeParse(args.triggerSource);
  if (!triggerSource.success) {
    return "invalid_source";
  }
  // The source class is decided before the Chat Thread check so a threadless
  // maintenance run or a thread-bound automation run reports its real reason
  // rather than a misleading missing_chat_thread.
  const sourceClass = PI_MEMORY_TRIGGER_SOURCE_CLASSES[triggerSource.data];
  if (sourceClass === "synthetic") {
    return "synthetic_source";
  }
  if (sourceClass === "non_interactive") {
    return "non_interactive_source";
  }
  if (args.chatThreadId === null) {
    return "missing_chat_thread";
  }
  return null;
}
