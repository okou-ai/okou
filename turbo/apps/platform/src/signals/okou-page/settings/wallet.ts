import { walletUserContract } from "@okouai/api-contracts/contracts/wallet";
import { walletChangedPayloadSchema } from "@okouai/api-contracts/contracts/realtime";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";
import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../../auth-context.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { setAblyPayloadLoop$ } from "../../realtime.ts";
import { generateRouterPath } from "../../route.ts";
import { ROUTES } from "../../route-paths.ts";
import { onRef, withCleanup } from "../../utils.ts";

export const walletSettingsEnabled$ = computed((get) => {
  const features = get(featureSwitch$);
  return (
    features[FeatureSwitchKey.LinkWallet] &&
    features[FeatureSwitchKey.WalletSettings]
  );
});

const version$ = state(0);
const cardsVersion$ = state(0);
export const walletCards$ = computed(async (get) => {
  get(cardsVersion$);
  if (!get(walletSettingsEnabled$)) {
    return [];
  }
  const connection = await get(walletConnection$);
  if (
    !connection.connected ||
    connection.revocationPending ||
    !connection.authorization?.capabilities.paymentMethods
  ) {
    return [];
  }
  const result = await accept(
    get(apiClient$)(walletUserContract).paymentMethods({ query: {} }),
    [200],
  );
  return result.body.data
    .filter((method) => {
      return method.type === "card";
    })
    .sort((a, b) => {
      return Number(b.isDefault) - Number(a.isDefault);
    });
});
export const refreshWalletCards$ = command(({ set }) => {
  set(cardsVersion$, (version) => {
    return version + 1;
  });
});
export const observeWalletCards$ = onRef(
  command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        set(refreshWalletCards$);
      }
    };
    window.addEventListener("focus", refresh, { signal });
    document.addEventListener("visibilitychange", refresh, { signal });
  }),
);
const transactionsVersion$ = state(0);
export const walletTransactions$ = computed(async (get) => {
  get(transactionsVersion$);
  if (!get(walletSettingsEnabled$)) {
    return null;
  }
  const connection = await get(walletConnection$);
  if (
    connection.connected &&
    connection.authorization?.capabilities.transactions
  ) {
    const result = await accept(
      get(apiClient$)(walletUserContract).activity({ query: { limit: 24 } }),
      [200],
    );
    return { source: "link" as const, transactions: result.body.data };
  }
  const result = await accept(
    get(apiClient$)(walletUserContract).transactions({
      query: { limit: 24 },
    }),
    [200],
  );
  return {
    source: "requests" as const,
    transactions: result.body.transactions,
  };
});
export const refreshWalletTransactions$ = command(({ set }) => {
  set(transactionsVersion$, (version) => {
    return version + 1;
  });
});
export const walletConnection$ = computed(async (get) => {
  get(version$);
  const result = await accept(
    get(apiClient$)(walletUserContract).status(),
    [200],
  );
  return result.body;
});
export const refreshWalletConnection$ = command(({ set }) => {
  set(refreshWalletTransactions$);
  set(version$, (version) => {
    return version + 1;
  });
  return false;
});
const onWalletChanged$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    const parsed = walletChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    const identity = await get(runtimeAuthenticatedIdentity$);
    signal.throwIfAborted();
    if (parsed.data.orgId === identity.orgId) {
      set(refreshWalletConnection$);
    }
    return false;
  },
);
export const observeWalletConnection$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "wallet:changed",
        loopCommand$: onWalletChanged$,
        initializeCommand$: refreshWalletConnection$,
      },
      signal,
    );
  },
);

export const connectWallet$ = command(async ({ get }, signal: AbortSignal) => {
  signal.throwIfAborted();
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  const redirectingPath = generateRouterPath(ROUTES.connectorRedirecting, {
    connectorSlug: "link",
  });
  const authWindow = window.open(
    `${redirectingPath}?label=Link`,
    "_blank",
    standalone ? undefined : "width=600,height=700",
  );
  if (!authWindow && !standalone) {
    throw new Error(
      i18n.t(($) => {
        return $.connectors.connectDialog.errors.authorizationWindow;
      }),
    );
  }
  if (authWindow) {
    authWindow.opener = null;
  }
  const close = () => {
    authWindow?.close();
  };
  signal.addEventListener("abort", close, { once: true });
  let navigated = false;
  await withCleanup(
    (async () => {
      const result = await accept(
        get(apiClient$)(walletUserContract).connect({
          body: {},
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      if (authWindow) {
        authWindow.location.href = result.body.url;
      } else {
        window.location.assign(result.body.url);
      }
      navigated = true;
    })(),
    () => {
      signal.removeEventListener("abort", close);
      if (!navigated) {
        authWindow?.close();
      }
    },
  );
});

export const disconnectWallet$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await withCleanup(
      accept(
        get(apiClient$)(walletUserContract).disconnect({
          body: {},
          fetchOptions: { signal },
        }),
        [200],
      ),
      () => {
        // A provider error can still mean local access was revoked.
        if (!signal.aborted) {
          set(refreshWalletConnection$);
        }
      },
    );
    signal.throwIfAborted();
  },
);
