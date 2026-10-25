import { walletUserContract } from "@okouai/api-contracts/contracts/wallet";
import { walletChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";
import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyPayloadLoop$, waitAblyPayloadLoopUntil$ } from "../realtime.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRef } from "../utils.ts";
import { runChatActionCallback$ } from "./action-callback.ts";
import { createCardSignalsRegistry } from "./card-signal-map.ts";
import type { ChatActionContext } from "./chat-action-context.ts";

export interface WalletActionDescriptor {
  readonly action: "connect" | "approve" | "continue";
  readonly hostname: string;
  readonly originalUrl: string;
}

/** These cards navigate to the provider; a URL never proves approval or payment. */
export function parseWalletActionUrl(
  url: URL,
  originalUrl: string,
): WalletActionDescriptor | null {
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }

  let action: WalletActionDescriptor["action"];
  if (
    url.hostname === "login.link.com" &&
    url.pathname === "/auth" &&
    url.searchParams
      .get("scope")
      ?.split(/\s+/u)
      .some((scope) => {
        return (
          scope === "payment_methods.agentic" ||
          scope === "userinfo:read" ||
          scope === "financial_insights.transactions.read"
        );
      })
  ) {
    action = "connect";
  } else if (url.hostname === "app.link.com") {
    // Link's wallet app also hosts payment-method updates, verification and
    // other requires_action destinations. Keep those provider-owned routes
    // navigable without guessing an action type or a completion state.
    action = /^\/(?:activity\/)?approve(?:\/|$)/u.test(url.pathname)
      ? "approve"
      : "continue";
  } else if (
    url.hostname === "hooks.stripe.com" &&
    /^\/(?:redirect\/authenticate|3d_secure_2\/hosted)(?:\/|$)/u.test(
      url.pathname,
    )
  ) {
    action = "continue";
  } else {
    return null;
  }

  return { action, hostname: url.hostname, originalUrl };
}

function createWalletConnectSignals(
  oauthState: string,
  context: ChatActionContext,
) {
  const reload$ = state(0);
  const continued$ = state(false);
  const status$ = computed(async (get) => {
    get(reload$);
    const result = await accept(
      get(apiClient$)(walletUserContract).connectStatus({
        body: { agentId: context.agentId, state: oauthState },
      }),
      [200, 403],
    );
    return result.status === 200
      ? result.body
      : { status: "unavailable" as const };
  });
  const refreshCompletion$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      set(reload$, (version) => {
        return version + 1;
      });
      const status = await get(status$);
      signal.throwIfAborted();
      return status.status !== "pending";
    },
  );
  const onWalletChanged$ = command(
    async ({ get, set }, payload: unknown, signal: AbortSignal) => {
      const parsed = walletChangedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return false;
      }
      const identity = await get(runtimeAuthenticatedIdentity$);
      signal.throwIfAborted();
      if (parsed.data.orgId !== identity.orgId) {
        return false;
      }
      return await set(refreshCompletion$, signal);
    },
  );
  const continueAfterAuthorization$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (get(continued$)) {
        return;
      }
      // Refresh for this user action so stale consent and failed reads can
      // recover before waiting for future notifications.
      if (!(await set(refreshCompletion$, signal))) {
        await set(
          waitAblyPayloadLoopUntil$,
          {
            topic: "wallet:changed",
            loopCommand$: onWalletChanged$,
            initializeCommand$: refreshCompletion$,
            options: { runOnSubscribe: false },
          },
          signal,
        );
      }
      const status = await get(status$);
      signal.throwIfAborted();
      if (status.status !== "authorized") {
        return;
      }
      await set(
        runChatActionCallback$,
        {
          ...context,
          callbackPrompt: i18n.t(($) => {
            return $.chat.walletAction.callbackPrompt;
          }),
          // The authorization identifies this continuation in both event
          // tables, so retries and other tabs cannot create another run.
          callbackIds: {
            clientEventId: status.authorizationId,
            chatThreadSortEventId: status.authorizationId,
          },
        },
        signal,
      );
      signal.throwIfAborted();
      set(continued$, true);
    },
  );
  return {
    status$,
    continued$,
    start$: continueAfterAuthorization$,
  };
}

export type WalletConnectSignals = ReturnType<
  typeof createWalletConnectSignals
>;

function createWalletApprovalSignals(
  approvalUrl: string,
  context: ChatActionContext,
) {
  const reload$ = state(0);
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.LinkWalletApprovalContinuation];
  });
  const status$ = computed(async (get) => {
    get(reload$);
    if (!get(enabled$)) {
      return { status: "unavailable" as const };
    }
    const response = await accept(
      get(apiClient$)(walletUserContract).spendStatus({
        body: { ...context, approvalUrl },
      }),
      [200, 403],
    );
    return response.status === 200
      ? response.body
      : { status: "unavailable" as const };
  });
  const refresh$ = command(async ({ get, set }, signal: AbortSignal) => {
    set(reload$, (value) => {
      return value + 1;
    });
    const result = await get(status$);
    signal.throwIfAborted();
    return !["pending", "approved"].includes(result.status);
  });
  const changed$ = command(
    async ({ get, set }, payload: unknown, signal: AbortSignal) => {
      const parsed = walletChangedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return false;
      }
      const identity = await get(runtimeAuthenticatedIdentity$);
      signal.throwIfAborted();
      if (identity.orgId !== parsed.data.orgId) {
        return false;
      }
      return await set(refresh$, signal);
    },
  );
  const mounted$ = onRef(
    command(
      async ({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
        if (!get(enabled$)) {
          return;
        }
        await set(
          setAblyPayloadLoop$,
          {
            topic: "wallet:changed",
            loopCommand$: changed$,
            initializeCommand$: refresh$,
            options: { runOnSubscribe: false },
          },
          signal,
        );
        signal.throwIfAborted();
      },
    ),
  );
  return { status$, mounted$ };
}

export type WalletApprovalSignals = ReturnType<
  typeof createWalletApprovalSignals
>;
export type WalletActionSignals = WalletActionDescriptor & {
  readonly connect: WalletConnectSignals | null;
  readonly approval: WalletApprovalSignals | null;
};

export function createWalletCardSignalsRegistry(context: ChatActionContext) {
  return createCardSignalsRegistry(
    (descriptor: WalletActionDescriptor) => {
      return descriptor.originalUrl;
    },
    (descriptor): WalletActionSignals => {
      const oauthState = new URL(descriptor.originalUrl).searchParams.get(
        "state",
      );
      return {
        ...descriptor,
        approval:
          descriptor.action === "approve"
            ? createWalletApprovalSignals(descriptor.originalUrl, context)
            : null,
        connect:
          descriptor.action === "connect" &&
          oauthState &&
          oauthState.length >= 43 &&
          oauthState.length <= 128
            ? createWalletConnectSignals(oauthState, context)
            : null,
      };
    },
  );
}
