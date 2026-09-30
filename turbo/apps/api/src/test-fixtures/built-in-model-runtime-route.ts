import {
  withBuiltInModelRuntimeRouteCandidateUnavailableForTest as withRuntimeRouteCandidateUnavailable,
  withBuiltInModelRuntimeRouteUnavailableForTest as withRuntimeRouteUnavailable,
} from "../signals/services/built-in-model-runtime-route.service";

interface BuiltInModelRuntimeRouteFixtureIdentity {
  readonly selectedModel: string;
  readonly providerType: string;
  readonly upstreamModel: string;
}

/**
 * Missing operator-managed keys are global infrastructure state and cannot be
 * isolated through a user-facing API. This fixture scopes that state to one
 * async request chain so route tests never delete or restore shared key rows.
 */
export function withBuiltInModelRuntimeRouteUnavailableForTest<T>(
  selectedModel: string,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteUnavailable(selectedModel, work);
}

/**
 * A candidate cooldown is global infrastructure state. Scope the unavailable
 * candidate to one async test flow while preserving normal route selection.
 */
export function withBuiltInModelRuntimeRouteCandidateUnavailableForTest<T>(
  candidate: BuiltInModelRuntimeRouteFixtureIdentity,
  work: () => Promise<T>,
): Promise<T> {
  return withRuntimeRouteCandidateUnavailable(candidate, work);
}
