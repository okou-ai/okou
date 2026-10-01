/**
 * Pi launch resources (launch config, memory recall, stable system prompt
 * binding). Moved verbatim out of the legacy execution graph.
 */
import type { ReadonlyDb } from "../external/db";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import type { PersistedStorageMount } from "@okouai/db/types";
import {
  type PiModelConfig,
  type PiLaunchConfig,
  type PiMemoryRecallSelection,
  type StoredExecutionContext,
  piMemoryRecallSelectionSchema,
} from "@okouai/api-contracts/contracts/runners";
import type { PiStableContextPromptProjection } from "@okouai/db/jsonb-contracts/pi-stable-context";
import { CreateAgentRunArgs } from "./execution-launch-persistence.service";
import {
  ResolvedAgentRunStorage,
  StorageMountMetadata,
  canonicalPiMemoryMount,
} from "./execution-storage-manifest.service";

export interface PreparedPiLaunchResources {
  readonly modelConfig: PiModelConfig;
  readonly launchConfig: PiLaunchConfig;
  readonly memoryRecall?: PiMemoryRecallSelection;
  readonly resumeSession: StoredExecutionContext["resumeSession"] | undefined;
  readonly sessionId: string;
}

export function noContentPiMemoryRecall(args: {
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
}): PiMemoryRecallSelection {
  return { ...args, status: "no-content" };
}

interface PriorPiMemoryRecall {
  readonly recall: PiMemoryRecallSelection;
  readonly mismatchReason?: "identity_mismatch" | "invalid_epoch";
}

export function priorPiMemoryRecall(args: {
  readonly currentMemoryMount: Pick<
    StorageMountMetadata,
    "storageId" | "versionId"
  >;
  readonly previousRunStorageMounts:
    | readonly PersistedStorageMount[]
    | undefined;
  readonly persistedStorageMounts: readonly PersistedStorageMount[] | undefined;
}): PriorPiMemoryRecall | undefined {
  const priorMount =
    canonicalPiMemoryMount(args.previousRunStorageMounts) ??
    canonicalPiMemoryMount(args.persistedStorageMounts);
  if (priorMount?.piMemoryRecall === undefined) {
    return undefined;
  }
  const parsed = piMemoryRecallSelectionSchema.safeParse(
    priorMount.piMemoryRecall,
  );
  if (
    parsed.success &&
    parsed.data.memoryStorageId === args.currentMemoryMount.storageId &&
    parsed.data.storageVersionId === args.currentMemoryMount.versionId
  ) {
    return { recall: parsed.data };
  }
  return {
    recall: noContentPiMemoryRecall({
      memoryStorageId: args.currentMemoryMount.storageId,
      storageVersionId: args.currentMemoryMount.versionId,
    }),
    mismatchReason: parsed.success ? "identity_mismatch" : "invalid_epoch",
  };
}

export function assemblePiLaunchResources(args: {
  readonly modelConfig: PiModelConfig;
  readonly piLaunchConfig: CreateAgentRunArgs["piLaunchConfig"];
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

export interface PreparePiLaunchResourcesArgs {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly piMemoryEnabled: boolean;
  readonly runId: string;
  readonly resumeSession: StoredExecutionContext["resumeSession"] | undefined;
  readonly storagePlan: Promise<ResolvedAgentRunStorage>;
  readonly previousRunStorageMounts:
    | readonly PersistedStorageMount[]
    | undefined;
  readonly piSandbox: PiModelConfig | undefined;
  readonly chatThreadId: string | undefined;
  readonly timing: ApiDispatchTimingCollector;
  readonly piLaunchConfig: CreateAgentRunArgs["piLaunchConfig"];
}

export function bindStableAppendSystemPrompt(
  prompt: PiStableContextPromptProjection,
  dynamicAppendSystemPrompt: string,
): string {
  return [
    prompt.agentIdentity,
    prompt.executionLimit,
    prompt.tools,
    dynamicAppendSystemPrompt,
  ]
    .filter((part) => {
      return Boolean(part);
    })
    .join("\n\n");
}
