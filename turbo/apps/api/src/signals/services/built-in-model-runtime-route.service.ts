import { AsyncLocalStorage } from "node:async_hooks";

import {
  getBuiltInModelRouteCandidates,
  type BuiltInModelRouteProviderType,
  type BuiltInModelRouteTarget,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  getOpenRouterBaseUrl,
  OPENROUTER_US_ORIGIN,
} from "@okouai/api-contracts/contracts/openrouter-routing";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { and, eq, gt } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

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
  featureSwitchContext?: FeatureSwitchContext,
): readonly BuiltInModelRouteTarget[] {
  const candidates = getBuiltInModelRouteCandidates(selectedModel);
  const requireOpenRouterUs =
    featureSwitchContext !== undefined &&
    isFeatureEnabled(
      FeatureSwitchKey.OpenRouterUsRouting,
      featureSwitchContext,
    ) &&
    candidates.some((candidate) => {
      return candidate.providerType === "deepseek";
    });
  if (!requireOpenRouterUs) {
    return candidates;
  }
  return candidates.filter((candidate) => {
    return (
      candidate.providerType === "openrouter-codex" &&
      getOpenRouterBaseUrl("responses", {
        credentialOwner: "builtin",
        model: candidate.upstreamModel,
        usRoutingEnabled: true,
      }).startsWith(`${OPENROUTER_US_ORIGIN}/`)
    );
  });
}

export function isBuiltInModelRuntimeRoutePermitted(
  route: BuiltInModelRuntimeRoute,
  featureSwitchContext: FeatureSwitchContext,
): boolean {
  return eligibleBuiltInModelRouteCandidates(
    route.selectedModel,
    featureSwitchContext,
  ).some((candidate) => {
    return (
      candidate.providerType === route.providerType &&
      candidate.upstreamModel === route.upstreamModel
    );
  });
}

export async function resolveBuiltInModelRuntimeRoute(
  db: Db,
  selectedModel: string,
  featureSwitchContext?: FeatureSwitchContext,
): Promise<BuiltInModelRuntimeRoute | null> {
  const timestamp = nowDate();
  for (const target of eligibleBuiltInModelRouteCandidates(
    selectedModel,
    featureSwitchContext,
  )) {
    if (runtimeRouteUnavailableForTest(target)) {
      continue;
    }
    const [key] = await db
      .select({ id: builtInModelKeys.id })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.vendor, target.vendor))
      .limit(1);
    if (!key) {
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
          eq(builtInModelCandidateCooldown.providerType, target.providerType),
          eq(builtInModelCandidateCooldown.upstreamModel, target.upstreamModel),
          gt(builtInModelCandidateCooldown.unavailableUntil, timestamp),
        ),
      )
      .limit(1);
    if (builtInCooldowns.length > 0) {
      continue;
    }

    return routeFromTarget(target, key);
  }
  return null;
}
