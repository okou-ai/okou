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

export type SubscriptionResetOutcome =
  ResetPersonalModelProviderSubscriptionUsageResponse["outcome"];

export type SubscriptionResetActionState =
  "idle" | "loading" | "error" | SubscriptionResetOutcome;

export interface SubscriptionResetSignals extends SubscriptionResetDescriptor {
  readonly status$: Computed<Promise<SubscriptionResetStatus>>;
  /** The latest reset attempt, shared by every card for this request. */
  readonly attempt$: Computed<Promise<SubscriptionResetOutcome> | null>;
  readonly refresh$: Command<void, []>;
  readonly confirm$: Command<Promise<SubscriptionResetOutcome>, [AbortSignal]>;
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
  const internalAttempt$ = state<Promise<SubscriptionResetOutcome> | null>(
    null,
  );
  const attempt$ = computed((get) => {
    return get(internalAttempt$);
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
  // Cards repeating this request read progress, failure and outcome from the
  // same attempt; the idempotency key makes a retry safe.
  const confirm$ = command(
    ({ get, set }, signal: AbortSignal): Promise<SubscriptionResetOutcome> => {
      const attempt = (async () => {
        const status = await get(status$);
        signal.throwIfAborted();
        if (
          status.kind !== "ready" ||
          status.account.type !== "codex-oauth-token" ||
          status.account.subscriptionResetSupported !== true ||
          status.account.needsReconnect
        ) {
          set(refresh$);
          throw new Error("Subscription reset is no longer available");
        }
        const result = await withCleanup(
          set(
            resetPersonalCodexAccountSubscriptionUsage$,
            {
              id: descriptor.accountId,
              idempotencyKey: descriptor.idempotencyKey,
            },
            signal,
          ),
          () => {
            set(refresh$);
          },
        );
        signal.throwIfAborted();
        return result.outcome;
      })();
      set(internalAttempt$, attempt);
      return attempt;
    },
  );
  return { ...descriptor, status$, attempt$, refresh$, confirm$ };
}

export function createSubscriptionResetCardSignalsRegistry() {
  return createCardSignalsRegistry(
    subscriptionResetResourceKey,
    createSubscriptionResetSignals,
  );
}
