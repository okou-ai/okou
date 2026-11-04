import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersByTypeContract,
} from "@okouai/api-contracts/client/personal-model-providers";
import type { ResetPersonalModelProviderSubscriptionUsageResponse } from "@okouai/api-contracts/contracts/personal-model-providers";
import { command } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { reloadThirdPartySubscriptions$ } from "./third-party-subscriptions.ts";

export const activatePersonalModelProviderAccount$ = command(
  async ({ get, set }, id: string, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProviderAccountsByIdContract);
    const result = await accept(
      client.activate({
        params: { id },
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadThirdPartySubscriptions$);
    return result.body;
  },
);

export const deletePersonalModelProviderAccount$ = command(
  async ({ get, set }, id: string, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProviderAccountsByIdContract);
    await accept(
      client.delete({
        params: { id },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadThirdPartySubscriptions$);
  },
);

export const resetPersonalCodexAccountSubscriptionUsage$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly idempotencyKey: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ): Promise<ResetPersonalModelProviderSubscriptionUsageResponse> => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProviderAccountsByIdContract);
    const result = args.runId
      ? await accept(
          client.resetFailedRunSubscriptionUsage({
            params: { id: args.id, runId: args.runId },
            body: { idempotencyKey: args.idempotencyKey },
            fetchOptions: { signal },
          }),
          [200],
        )
      : await accept(
          client.resetSubscriptionUsage({
            params: { id: args.id },
            body: { idempotencyKey: args.idempotencyKey },
            fetchOptions: { signal },
          }),
          [200],
        );
    signal.throwIfAborted();
    set(reloadThirdPartySubscriptions$);
    return result.body;
  },
);

export const resetPersonalCodexSubscriptionUsage$ = command(
  async (
    { get, set },
    args: {
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<ResetPersonalModelProviderSubscriptionUsageResponse> => {
    const createClient = get(apiClient$);
    const client = createClient(personalModelProvidersByTypeContract);
    const result = await accept(
      client.resetSubscriptionUsage({
        params: { type: "codex-oauth-token" },
        body: { idempotencyKey: args.idempotencyKey },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(reloadThirdPartySubscriptions$);

    return result.body;
  },
);
