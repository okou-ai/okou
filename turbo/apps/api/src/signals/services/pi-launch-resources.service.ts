/**
 * Pi launch resources (launch config, memory recall, stable system prompt
 * binding). Moved verbatim out of the legacy execution graph.
 */
import type {
  PiModelConfig,
  PiLaunchConfig,
  PiMemoryRecallSelection,
  StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";

/** Producer-supplied Pi runtime options, independent of the thread context. */
export type PiLaunchConfigOverrides = Omit<
  PiLaunchConfig,
  "schemaVersion" | "memoryRecall"
>;

export interface PreparedPiLaunchResources {
  readonly modelConfig: PiModelConfig;
  readonly launchConfig: PiLaunchConfig;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly resumeSession: StoredExecutionContext["resumeSession"] | undefined;
  readonly sessionId: string;
}

export function assemblePiLaunchResources(args: {
  readonly modelConfig: PiModelConfig;
  readonly piLaunchConfig: PiLaunchConfigOverrides | undefined;
  readonly memoryRecall: PiMemoryRecallSelection | undefined;
  readonly resumeSession: PreparedPiLaunchResources["resumeSession"];
  readonly sessionId: string;
}): PreparedPiLaunchResources {
  const { memoryRecall, resumeSession, sessionId } = args;
  return {
    modelConfig: args.modelConfig,
    launchConfig: {
      schemaVersion: 2,
      ...(memoryRecall === undefined ? {} : { memoryRecall }),
      ...args.piLaunchConfig,
    },
    ...(memoryRecall === undefined ? {} : { memoryRecall }),
    resumeSession,
    sessionId,
  };
}
