import type {
  PiLaunchConfig,
  PiApiFirstTurnConfig,
  PiModelConfig,
  PiResourceSnapshot,
  StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";

type PiApiFirstTurnLaunchConfig = Pick<
  PiLaunchConfig,
  "schemaVersion" | "memoryRecall"
> & {
  readonly apiFirstTurn: Pick<
    PiApiFirstTurnConfig,
    | "schemaVersion"
    | "resourceSnapshotDigest"
    | "deadlineAt"
    | "baseSession"
    | "sandboxEventSequenceStart"
  >;
};

/** Only model-visible inputs and the selected credential namespace cross the
 * direct-inference boundary. The durable variant never manufactures a Runner
 * environment, signed URL, executable job, or Sandbox notification. */
interface PiApiFirstTurnExecutionContext {
  readonly apiStartTime: number;
  readonly billableFirewalls: readonly string[];
  readonly encryptedSecrets: StoredExecutionContext["encryptedSecrets"];
  readonly modelUsageProvider: StoredExecutionContext["modelUsageProvider"];
  readonly platformEnvironment: StoredExecutionContext["platformEnvironment"];
  readonly secretConnectorMap: StoredExecutionContext["secretConnectorMap"];
  readonly secretConnectorMetadataMap: StoredExecutionContext["secretConnectorMetadataMap"];
  readonly piLaunchConfig: PiApiFirstTurnLaunchConfig;
  readonly piModelConfig: PiModelConfig;
  readonly piSessionId: string;
  readonly resumeSession?: StoredExecutionContext["resumeSession"];
  readonly storageMounts?: StoredExecutionContext["storageMounts"];
  readonly resourceSnapshot?: PiResourceSnapshot;
  readonly h0SessionHistory?: string;
}

export interface PiApiFirstTurnActivationBase {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly executionContext: PiApiFirstTurnExecutionContext;
}

export type PiApiFirstTurnActivation = PiApiFirstTurnActivationBase &
  (
    | {
        readonly executionMode: "legacy-sandbox-race";
        readonly runnerGroup: string;
      }
    | {
        readonly executionMode: "durable-inference";
        readonly inference: {
          readonly ownerEpoch: number;
          readonly providerAttemptId: string;
          readonly configurationHash: string;
          readonly contextHash: string;
        };
      }
  );

export function isDurablePiApiFirstTurnActivation(
  activation: PiApiFirstTurnActivation,
): activation is Extract<
  PiApiFirstTurnActivation,
  { readonly executionMode: "durable-inference" }
> {
  return activation.executionMode === "durable-inference";
}

export const PI_API_FIRST_TURN_API_OWNERSHIP_TIMEOUT_MS = 45_000;
export const PI_API_FIRST_TURN_URL_TTL_SECONDS = PRESIGNED_URL_TTL_SECONDS;
const PI_API_FIRST_TURN_HANDOFF_SETTLEMENT_TIMEOUT_MS = 10_000;
export const PI_API_FIRST_TURN_COORDINATION_TIMEOUT_MS =
  PI_API_FIRST_TURN_API_OWNERSHIP_TIMEOUT_MS +
  PI_API_FIRST_TURN_HANDOFF_SETTLEMENT_TIMEOUT_MS;

export function requirePiApiFirstTurnExecutionContext(
  context: Pick<
    StoredExecutionContext,
    | "apiStartTime"
    | "billableFirewalls"
    | "encryptedSecrets"
    | "modelUsageProvider"
    | "piLaunchConfig"
    | "platformEnvironment"
    | "piModelConfig"
    | "piSessionId"
    | "resumeSession"
    | "secretConnectorMap"
    | "secretConnectorMetadataMap"
    | "storageMounts"
  >,
): PiApiFirstTurnActivation["executionContext"] {
  if (
    context.apiStartTime === undefined ||
    context.billableFirewalls === undefined ||
    context.piLaunchConfig === undefined ||
    context.piLaunchConfig.apiFirstTurn.schemaVersion !== 1 ||
    context.piModelConfig === undefined ||
    context.piSessionId === undefined
  ) {
    throw new Error("Pi API first-turn execution context is incomplete");
  }
  return {
    apiStartTime: context.apiStartTime,
    billableFirewalls: context.billableFirewalls,
    encryptedSecrets: context.encryptedSecrets,
    modelUsageProvider: context.modelUsageProvider,
    piLaunchConfig: {
      schemaVersion: context.piLaunchConfig.schemaVersion,
      ...(context.piLaunchConfig.memoryRecall
        ? { memoryRecall: context.piLaunchConfig.memoryRecall }
        : {}),
      apiFirstTurn: {
        schemaVersion: context.piLaunchConfig.apiFirstTurn.schemaVersion,
        resourceSnapshotDigest:
          context.piLaunchConfig.apiFirstTurn.resourceSnapshotDigest,
        deadlineAt: context.piLaunchConfig.apiFirstTurn.deadlineAt,
        baseSession: context.piLaunchConfig.apiFirstTurn.baseSession,
        sandboxEventSequenceStart:
          context.piLaunchConfig.apiFirstTurn.sandboxEventSequenceStart,
      },
    },
    platformEnvironment: context.platformEnvironment,
    piModelConfig: context.piModelConfig,
    piSessionId: context.piSessionId,
    resumeSession: context.resumeSession,
    secretConnectorMap: context.secretConnectorMap,
    secretConnectorMetadataMap: context.secretConnectorMetadataMap,
    storageMounts: context.storageMounts,
  };
}

export function piApiFirstTurnObjectKey(
  runId: string,
  object: "manifest" | "session",
): string {
  return `pi-api-first-turn/${runId}/${object}.json${
    object === "session" ? "l" : ""
  }`;
}

export function refreshPiApiFirstTurnDeadline<
  T extends {
    readonly apiStartTime?: number;
    readonly piLaunchConfig?: PiLaunchConfig;
  },
>(context: T, apiStartTime: number): T {
  const launchConfig = context.piLaunchConfig;
  if (!launchConfig) {
    return { ...context, apiStartTime } as T;
  }
  const slot = launchConfig.apiFirstTurn;
  if (slot.schemaVersion !== 1) {
    throw new Error("Deferred Pi work cannot enter legacy queue promotion");
  }
  return {
    ...context,
    apiStartTime,
    piLaunchConfig: {
      ...launchConfig,
      apiFirstTurn: {
        ...slot,
        // The wire deadline is the absolute API-to-Sandbox coordination cap.
        // API ownership ends earlier and is derived from apiStartTime.
        deadlineAt: apiStartTime + PI_API_FIRST_TURN_COORDINATION_TIMEOUT_MS,
      },
    },
  } as T;
}
