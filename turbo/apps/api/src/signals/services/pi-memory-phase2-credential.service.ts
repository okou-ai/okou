import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { storages } from "@okouai/db/schema/storage";
import { PI_MEMORY_STAGE1_BUILT_IN_MODEL } from "@okouai/pi-agent-runtime/api";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { AgentRunModelPin } from "./agent-run-contracts";
import { resolvePiMemoryBuiltinRoute$ } from "./pi-memory-builtin-config";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";

type CredentialFailure =
  | "source_credentials_missing"
  | "model_route_unavailable"
  | "pi_memory_disabled"
  | "storage_binding_changed";

export class PiMemoryPhase2CredentialError extends Error {
  constructor(readonly errorClass: CredentialFailure) {
    super("Pi memory Phase 2 credential admission failed");
    this.name = "PiMemoryPhase2CredentialError";
  }
}

function reject(reason: CredentialFailure): never {
  throw new PiMemoryPhase2CredentialError(reason);
}

export interface PiMemoryPhase2CredentialProof {
  readonly storage: {
    readonly memoryStorageId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly baseVersionId: string;
  };
}

export function requirePiMemoryPhase2CredentialStorage(
  storage: { readonly id: string } | undefined,
) {
  if (!storage) {
    reject("storage_binding_changed");
  }
}

/** Revalidate ownership, the claimed base and the feature before publication. */
export function piMemoryPhase2CredentialValidationPlan(
  proof: PiMemoryPhase2CredentialProof,
) {
  return {
    storage: {
      fields: { id: storages.id },
      where: and(
        eq(storages.id, proof.storage.memoryStorageId),
        eq(storages.orgId, proof.storage.orgId),
        eq(storages.userId, proof.storage.userId),
        eq(storages.headVersionId, proof.storage.baseVersionId),
      ),
    },
    features: {
      fields: {
        userId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      },
      where: userFeatureSwitchRowCondition(
        proof.storage.orgId,
        proof.storage.userId,
      ),
    },
  };
}

export function piMemoryPhase2FeatureContext(
  proof: PiMemoryPhase2CredentialProof,
  rows: readonly Pick<
    typeof userFeatureSwitches.$inferSelect,
    "userId" | "switches"
  >[],
) {
  return featureSwitchContextFromRows(
    proof.storage.orgId,
    proof.storage.userId,
    rows,
  );
}

export function requirePiMemoryPhase2FeatureEnabled(
  context: FeatureSwitchContext,
) {
  if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, context)) {
    reject("pi_memory_disabled");
  }
}

/** Source runs supply evidence and ownership; the platform funds every attempt. */
export const resolvePiMemoryPhase2Credential$ = command(
  async ({ set }, claim: ClaimedPiMemoryPhase2Job, signal: AbortSignal) => {
    if (claim.selected.length === 0) {
      reject("source_credentials_missing");
    }
    const route = await set(resolvePiMemoryBuiltinRoute$, signal);
    signal.throwIfAborted();
    if (!route) {
      reject("model_route_unavailable");
    }
    return {
      pin: {
        modelProvider: "built-in",
        modelProviderId: null,
        modelProviderCredentialScope: "org",
        selectedModel: PI_MEMORY_STAGE1_BUILT_IN_MODEL,
      } as const satisfies AgentRunModelPin,
      route,
      proof: {
        storage: {
          memoryStorageId: claim.memoryStorageId,
          orgId: claim.orgId,
          userId: claim.userId,
          baseVersionId: claim.baseVersion.versionId,
        },
      } satisfies PiMemoryPhase2CredentialProof,
    };
  },
);
