import { walletUserContract } from "@okouai/api-contracts/client/wallet";
import { walletChangedPayloadSchema } from "@okouai/api-contracts/validators/realtime";
import { command, computed, state } from "ccstate";
import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../../auth-context.ts";
import { setAblyPayloadLoop$ } from "../../realtime.ts";
import { generateRouterPath } from "../../route.ts";
import { ROUTES } from "../../route-paths.ts";
import { withCleanup } from "../../utils.ts";

const version$ = state(0);
export const walletCards$ = computed(async (get) => {
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
      return method.type === "CARD";
    })
    .sort((a, b) => {
      return Number(b.isDefault) - Number(a.isDefault);
    });
});
export const walletTransactions$ = computed(async (get) => {
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
export const walletConnection$ = computed(async (get) => {
  get(version$);
  const result = await accept(
    get(apiClient$)(walletUserContract).status(),
    [200],
  );
  return result.body;
});
export const refreshWalletConnection$ = command(({ set }) => {
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
  // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
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
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
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
