import {
  getBuiltInModelRouteCandidates,
  type BuiltInModelRouteProviderType,
  type BuiltInModelRouteTarget,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { computed, type Computed } from "ccstate";
import { and, eq, gt } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import { db$, type ReadonlyDb } from "../external/db";

export interface BuiltInModelRuntimeRoute {
  readonly selectedModel: string;
  readonly providerType: BuiltInModelRouteProviderType;
  readonly upstreamModel: string;
  readonly modelKeyId: string;
}

interface BuiltInModelRuntimeRouteIdentity {
  readonly selectedModel: string;
  readonly providerType: string;
  readonly upstreamModel: string;
}

interface UnavailableRuntimeRoutesForTest {
  readonly selectedModels: ReadonlySet<string>;
  readonly candidates: readonly BuiltInModelRuntimeRouteIdentity[];
}

const unavailableRuntimeRoutesForTest = singleton(() => {
  return new AsyncLocalStorage<UnavailableRuntimeRoutesForTest>();
});

/**
 * Operator-managed model keys are global rows, so a missing-key API test cannot
 * safely delete them while other test workers are running. Keep that impossible
 * external state scoped to the calling async chain instead of mutating shared
 * database state.
 */
export async function withBuiltInModelRuntimeRouteUnavailableForTest<T>(
  selectedModel: string,
  work: () => Promise<T>,
): Promise<T> {
  const inherited = unavailableRuntimeRoutesForTest.peek()?.getStore();
  return await unavailableRuntimeRoutesForTest().run(
    {
      selectedModels: new Set([
        ...(inherited?.selectedModels ?? []),
        selectedModel,
      ]),
      candidates: inherited?.candidates ?? [],
    },
    work,
  );
}

export async function withBuiltInModelRuntimeRouteCandidateUnavailableForTest<
  T,
>(
  candidate: BuiltInModelRuntimeRouteIdentity,
  work: () => Promise<T>,
): Promise<T> {
  const inherited = unavailableRuntimeRoutesForTest.peek()?.getStore();
  return await unavailableRuntimeRoutesForTest().run(
    {
      selectedModels: inherited?.selectedModels ?? new Set(),
      candidates: [...(inherited?.candidates ?? []), candidate],
    },
    work,
  );
}

function runtimeRouteUnavailableForTest(
  target: BuiltInModelRouteTarget,
): boolean {
  const unavailable = unavailableRuntimeRoutesForTest.peek()?.getStore();
  return (
    unavailable?.selectedModels.has(target.selectedModel) === true ||
    unavailable?.candidates.some((candidate) => {
      return (
        candidate.selectedModel === target.selectedModel &&
        candidate.providerType === target.providerType &&
        candidate.upstreamModel === target.upstreamModel
      );
    }) === true
  );
}

function routeFromTarget(
  target: BuiltInModelRouteTarget,
  key: { readonly id: string },
): BuiltInModelRuntimeRoute {
  return {
    selectedModel: target.selectedModel,
    providerType: target.providerType,
    upstreamModel: target.upstreamModel,
    modelKeyId: key.id,
  };
}

function eligibleBuiltInModelRouteCandidates(
  selectedModel: string,
  featureSwitchContext: FeatureSwitchContext,
): readonly BuiltInModelRouteTarget[] {
  const candidates = getBuiltInModelRouteCandidates(selectedModel);
  const useAlternativeRouting =
    isFeatureEnabled(
      FeatureSwitchKey.DeepSeekAlternativeRouting,
      featureSwitchContext,
    ) &&
    candidates.some((candidate) => {
      return candidate.providerType === "deepseek";
    });
  if (!useAlternativeRouting) {
    return candidates;
  }
  return candidates.filter((candidate) => {
    return candidate.providerType !== "deepseek";
  });
}

export function isBuiltInModelRuntimeRoutePermitted(
  route: BuiltInModelRuntimeRoute,
): boolean {
  return getBuiltInModelRouteCandidates(route.selectedModel).some(
    (candidate) => {
      return (
        candidate.providerType === route.providerType &&
        candidate.upstreamModel === route.upstreamModel
      );
    },
  );
}

/** Operator-managed key id for each vendor; the vendor column is unique. */
export type BuiltInModelKeyIdsByVendor = ReadonlyMap<string, string>;

async function loadBuiltInModelKeyIdsByVendor(
  db: ReadonlyDb,
): Promise<BuiltInModelKeyIdsByVendor> {
  const rows = await db
    .select({ id: builtInModelKeys.id, vendor: builtInModelKeys.vendor })
    .from(builtInModelKeys);
  return new Map(
    rows.map((row) => {
      return [row.vendor, row.id];
    }),
  );
}

/** Request-scoped, so resolving many policies reads the key table once. */
export const builtInModelKeyIdsByVendor$: Computed<
  Promise<BuiltInModelKeyIdsByVendor>
> = computed(async (get) => {
  return await loadBuiltInModelKeyIdsByVendor(get(db$));
});

export async function resolveBuiltInModelRuntimeRoute(
  db: ReadonlyDb,
  selectedModel: string,
  featureSwitchContext: FeatureSwitchContext,
): Promise<BuiltInModelRuntimeRoute | null> {
  return await resolveBuiltInModelRuntimeRouteWithKeys(
    db,
    selectedModel,
    featureSwitchContext,
    await loadBuiltInModelKeyIdsByVendor(db),
  );
}

export async function resolveBuiltInModelRuntimeRouteWithKeys(
  db: ReadonlyDb,
  selectedModel: string,
  featureSwitchContext: FeatureSwitchContext,
  keyIdsByVendor: BuiltInModelKeyIdsByVendor,
): Promise<BuiltInModelRuntimeRoute | null> {
  const timestamp = nowDate();
  for (const target of eligibleBuiltInModelRouteCandidates(
    selectedModel,
    featureSwitchContext,
  )) {
    if (runtimeRouteUnavailableForTest(target)) {
      continue;
    }
    const keyId = keyIdsByVendor.get(target.vendor);
    if (keyId === undefined) {
      continue;
    }

    const builtInCooldowns = await db
      .select({
        unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
      })
      .from(builtInModelCandidateCooldown)
      .where(
        and(
          eq(builtInModelCandidateCooldown.selectedModel, target.selectedModel),
          eq(
            builtInModelCandidateCooldown.modelRuntimeProvider,
            target.providerType,
          ),
          eq(
            builtInModelCandidateCooldown.modelRuntimeModel,
            target.upstreamModel,
          ),
          gt(builtInModelCandidateCooldown.unavailableUntil, timestamp),
        ),
      )
      .limit(1);
    if (builtInCooldowns.length > 0) {
      continue;
    }

    return routeFromTarget(target, { id: keyId });
  }
  return null;
}

/** Choose the same first eligible route from one batched cooldown snapshot. */
export function builtInModelRuntimeRouteFromSnapshot(args: {
  readonly selectedModel: string;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly keyIdsByVendor: BuiltInModelKeyIdsByVendor;
  readonly cooldowns: readonly {
    readonly modelRuntimeProvider: string;
    readonly modelRuntimeModel: string;
  }[];
}): BuiltInModelRuntimeRoute | null {
  for (const target of eligibleBuiltInModelRouteCandidates(
    args.selectedModel,
    args.featureSwitchContext,
  )) {
    if (runtimeRouteUnavailableForTest(target)) {
      continue;
    }
    const id = args.keyIdsByVendor.get(target.vendor);
    if (
      id === undefined ||
      args.cooldowns.some((cooldown) => {
        return (
          cooldown.modelRuntimeProvider === target.providerType &&
          cooldown.modelRuntimeModel === target.upstreamModel
        );
      })
    ) {
      continue;
    }
    return routeFromTarget(target, { id });
  }
  return null;
}
