import { z } from "zod";
import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  personalSubscriptionsContract,
  type ResetPersonalModelProviderSubscriptionUsageResponse,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { resetPersonalCodexAccountSubscriptionUsage$ } from "../external/personal-model-providers.ts";
import { personalModelProviderAccountRevision$ } from "../external/third-party-subscriptions.ts";
import { withCleanup } from "../utils.ts";
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
  readonly operation$: Computed<Promise<ResetOutcome> | undefined>;
  readonly refresh$: Command<void, []>;
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
  const accountId = z.uuid().safeParse(match[1]);
  const idempotencyKey = z
    .uuid()
    .safeParse(url.searchParams.get("idempotencyKey"));
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
  const revision$ = state(0);
  const internalOperation$ = state<Promise<ResetOutcome> | undefined>(
    undefined,
  );
  const running$ = state<Promise<ResetOutcome> | null>(null);
  const terminalOutcome$ = state<ResetOutcome | null>(null);
  const status$ = computed(async (get): Promise<SubscriptionResetStatus> => {
    get(revision$);
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
  const refresh$ = command(({ set }) => {
    set(revision$, (revision) => {
      return revision + 1;
    });
  });
  const reset$ = command(
    async (
      { get, set },
      retry: boolean,
      signal: AbortSignal,
    ): Promise<ResetOutcome> => {
      signal.throwIfAborted();
      const status = await get(status$);
      signal.throwIfAborted();
      if (
        status.kind !== "ready" ||
        status.account.type !== "codex-oauth-token" ||
        status.account.subscriptionResetSupported !== true ||
        status.account.needsReconnect ||
        (!retry &&
          !(
            status.account.subscriptionResetCredits &&
            status.account.subscriptionResetCredits > 0
          ))
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
      // Every service outcome is terminal for this request, not only a reset.
      set(terminalOutcome$, result.outcome);
      return result.outcome;
    },
  );
  const confirm$ = command(
    ({ get, set }, signal: AbortSignal): Promise<ResetOutcome> => {
      const previous = get(internalOperation$);
      const running = get(running$);
      if (running) {
        return running;
      }
      if (get(terminalOutcome$) !== null && previous) {
        return previous;
      }
      // A failed attempt may have spent the last credit before its response was
      // lost. Retry the same key even at zero/unknown credits. Eligibility and
      // reconnect checks still apply, including after a failed precondition read.
      const operation = withCleanup(
        set(reset$, previous !== undefined, signal),
        () => {
          set(running$, null);
          if (!signal.aborted) {
            set(refresh$);
          }
        },
      );
      set(running$, operation);
      set(internalOperation$, operation);
      return operation;
    },
  );
  return {
    ...descriptor,
    status$,
    operation$: computed((get) => {
      return get(internalOperation$);
    }),
    refresh$,
    confirm$,
  };
}

export function createSubscriptionResetCardSignalsRegistry() {
  return createCardSignalsRegistry(
    subscriptionResetResourceKey,
    createSubscriptionResetSignals,
  );
}
