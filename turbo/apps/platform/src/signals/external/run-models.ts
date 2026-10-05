import type { AvailableRunModelsResponse } from "@okouai/api-contracts/contracts/model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { command, computed, state } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { settle } from "../utils.ts";

const internalReloadAvailableRunModels$ = state(0);

/** Retain the last successful projection only within its authenticated identity. */
const runModelResource$ = computed(async (get) => {
  const { userId, orgId } = await get(runtimeAuthenticatedIdentity$);
  return {
    identity: { userId, orgId },
    generation: 0,
    lastResolved: undefined as AvailableRunModelsResponse | undefined,
  };
});

export const availableRunModels$ = computed(async (get) => {
  const revision = get(internalReloadAvailableRunModels$);
  const pendingResource = get(runModelResource$);
  const client = get(apiClient$)(runModelsMainContract, { apiBase: "api" });
  const resource = await pendingResource;
  const generation = ++resource.generation;
  const result = await settle(accept(client.list(), [200]));
  if (result.ok) {
    if (
      pendingResource === get(runModelResource$) &&
      revision === get(internalReloadAvailableRunModels$) &&
      generation === resource.generation
    ) {
      resource.lastResolved = result.value.body;
    }
    return result.value.body;
  }
  if (resource.lastResolved !== undefined) {
    return resource.lastResolved;
  }
  throw result.error;
});

export const invalidateAvailableRunModels$ = command(({ set }) => {
  set(internalReloadAvailableRunModels$, (value) => {
    return value + 1;
  });
});

export const refreshAvailableRunModels$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(invalidateAvailableRunModels$);
    const response = await get(availableRunModels$);
    signal.throwIfAborted();
    return response;
  },
);
