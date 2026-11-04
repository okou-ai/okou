import { uuid } from "zod";
import { command, computed, type Command, type Computed } from "ccstate";
import { personalSubscriptionsContract } from "@okouai/api-contracts/client/personal-model-providers";
import type { ResetPersonalModelProviderSubscriptionUsageResponse } from "@okouai/api-contracts/contracts/personal-model-providers";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { resetPersonalCodexAccountSubscriptionUsage$ } from "../external/personal-model-providers.ts";
import { personalModelProviderAccountRevision$ } from "../external/third-party-subscriptions.ts";
import type { ChatActionParseResult } from "./chat-action-context.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";

export interface SubscriptionResetDescriptor {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly originalUrl: string;
}

export type SubscriptionResetStatus =
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly account: ModelProviderResponse };

export type ResetOutcome =
  ResetPersonalModelProviderSubscriptionUsageResponse["outcome"];

export interface SubscriptionResetSignals extends SubscriptionResetDescriptor {
  readonly status$: Computed<Promise<SubscriptionResetStatus>>;
  readonly confirm$: Command<Promise<ResetOutcome>, [AbortSignal]>;
}

export function parseSubscriptionResetUrl(
  value: string,
): ChatActionParseResult<SubscriptionResetDescriptor> {
  const url = parseTrustedPlatformUrl(value);
  const match = url?.pathname.match(/^\/subscriptions\/([^/]+)\/reset$/u);
  if (!url || !match) {
    return { status: "unrelated" };
  }
  const accountId = uuid().safeParse(match[1]);
  const idempotencyKey = uuid().safeParse(
    url.searchParams.get("idempotencyKey"),
  );
  if (
    !accountId.success ||
    !idempotencyKey.success ||
    url.searchParams.getAll("idempotencyKey").length !== 1
  ) {
    return { status: "invalid", originalUrl: value };
  }
  return {
    status: "valid",
    descriptor: {
      accountId: accountId.data.toLowerCase(),
      idempotencyKey: idempotencyKey.data.toLowerCase(),
      originalUrl: value,
    },
  };
}

export function subscriptionResetResourceKey(
  descriptor: SubscriptionResetDescriptor,
): string {
  return `/subscriptions/${descriptor.accountId}/reset?idempotencyKey=${descriptor.idempotencyKey}`;
}

export function createSubscriptionResetSignals(
  descriptor: SubscriptionResetDescriptor,
): SubscriptionResetSignals {
  const status$ = computed(async (get): Promise<SubscriptionResetStatus> => {
    get(personalModelProviderAccountRevision$);
    const result = await accept(
      get(apiClient$)(personalSubscriptionsContract).get({
        params: { id: descriptor.accountId },
      }),
      [200, 404],
    );
    if (result.status === 404 || result.body.id !== descriptor.accountId) {
      return { kind: "unavailable" };
    }
    return { kind: "ready", account: result.body };
  });
  const confirm$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<ResetOutcome> => {
      signal.throwIfAborted();
      const status = await get(status$);
      signal.throwIfAborted();
      if (
        status.kind !== "ready" ||
        status.account.type !== "codex-oauth-token" ||
        status.account.subscriptionResetSupported !== true ||
        status.account.needsReconnect ||
        !(
          status.account.subscriptionResetCredits &&
          status.account.subscriptionResetCredits > 0
        )
      ) {
        throw new Error("This subscription is not eligible for a usage reset");
      }
      const result = await set(
        resetPersonalCodexAccountSubscriptionUsage$,
        {
          id: descriptor.accountId,
          idempotencyKey: descriptor.idempotencyKey,
        },
        signal,
      );
      signal.throwIfAborted();
      return result.outcome;
    },
  );
  return {
    ...descriptor,
    status$,
    confirm$,
  };
}

export function createSubscriptionResetCardSignalsRegistry() {
  return createCardSignalsRegistry(
    subscriptionResetResourceKey,
    createSubscriptionResetSignals,
  );
}
