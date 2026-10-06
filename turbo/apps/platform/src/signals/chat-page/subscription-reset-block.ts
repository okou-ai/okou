import { z } from "zod";
import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  personalSubscriptionsContract,
  type ResetPersonalModelProviderSubscriptionUsageResponse,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  personalModelProviderAccountRevision$,
  resetPersonalCodexAccountSubscriptionUsage$,
} from "../external/personal-model-providers.ts";
import { settle, withCleanup } from "../utils.ts";
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

type ResetOutcome =
  ResetPersonalModelProviderSubscriptionUsageResponse["outcome"];

export type SubscriptionResetActionState =
  | "idle"
  | "loading"
  | "error"
  | ResetOutcome;

export interface SubscriptionResetSignals extends SubscriptionResetDescriptor {
  readonly status$: Computed<Promise<SubscriptionResetStatus>>;
  readonly actionState$: Computed<SubscriptionResetActionState>;
  readonly refresh$: Command<void, []>;
  readonly confirm$: Command<Promise<void>, [AbortSignal]>;
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
  const internalActionState$ = state<SubscriptionResetActionState>("idle");
  const actionState$ = computed((get) => {
    return get(internalActionState$);
  });
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
  const confirm$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const state = get(internalActionState$);
      if (state !== "idle" && state !== "error") {
        return;
      }
      set(internalActionState$, "loading");
      await withCleanup(
        (async () => {
          const status = await get(status$);
          signal.throwIfAborted();
          if (
            status.kind !== "ready" ||
            status.account.type !== "codex-oauth-token" ||
            status.account.subscriptionResetSupported !== true ||
            status.account.needsReconnect ||
            (state !== "error" &&
              !(
                status.account.subscriptionResetCredits &&
                status.account.subscriptionResetCredits > 0
              ))
          ) {
            set(internalActionState$, "error");
            set(refresh$);
            return;
          }
          const result = await settle(
            set(
              resetPersonalCodexAccountSubscriptionUsage$,
              {
                id: descriptor.accountId,
                idempotencyKey: descriptor.idempotencyKey,
              },
              signal,
            ),
            signal,
          );
          signal.throwIfAborted();
          set(internalActionState$, result.ok ? result.value.outcome : "error");
          set(refresh$);
        })(),
        () => {
          set(internalActionState$, (current) => {
            return current === "loading" ? "error" : current;
          });
        },
      );
    },
  );
  return { ...descriptor, status$, actionState$, refresh$, confirm$ };
}

export function createSubscriptionResetCardSignalsRegistry() {
  return createCardSignalsRegistry(
    subscriptionResetResourceKey,
    createSubscriptionResetSignals,
  );
}
