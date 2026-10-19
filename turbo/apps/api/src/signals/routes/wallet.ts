import {
  walletCallbackContract,
  walletContract,
  walletUserContract,
} from "@okouai/api-contracts/contracts/wallet";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { LinkWalletError } from "../services/link-wallet-provider.service";
import { walletTransactions$ } from "../services/link-wallet-transactions.service";
import {
  completeWalletOAuth$,
  createWalletSpend$,
  disconnectWallet$,
  getWalletSpend$,
  getWalletSpendCredentials$,
  startWalletOAuth$,
  walletRunOwner$,
  walletStatus$,
  walletSettingsStatus$,
  walletConnectStatus$,
  listWalletSpends$,
  readWallet$,
} from "../services/link-wallet.service";
import { settle } from "../utils";

const walletEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  if (
    !isFeatureEnabled(FeatureSwitchKey.LinkWallet, {
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    throw new LinkWalletError(
      403,
      "WALLET_DISABLED",
      "Link wallet is not enabled",
    );
  }
});
const agentOwner$ = computed(async (get) => {
  await get(walletEnabled$);
  return await get(walletRunOwner$);
});

// Payment-capable runs may also inspect their wallet. Read access alone never
// authorizes payment operations, which continue to require wallet:write.
const readOwner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (
    auth.tokenType !== "agent" ||
    !auth.capabilities.some((capability) => {
      return capability === "wallet:read" || capability === "wallet:write";
    })
  ) {
    throw new LinkWalletError(
      403,
      "MISSING_CAPABILITY",
      "This operation requires wallet:read",
    );
  }
  return await get(agentOwner$);
});

function walletError(error: unknown) {
  if (!(error instanceof LinkWalletError)) {
    throw error;
  }
  return {
    status: error.status,
    body: { error: { code: error.code, message: error.message } },
  };
}
function walletResponse<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
) {
  return result.ok
    ? { status: 200 as const, body: result.value }
    : walletError(result.error);
}
const connectBody$ = bodyResultOf(walletContract.connect);
const spendListQuery$ = queryOf(walletContract.listSpends);
const transactionsQuery$ = queryOf(walletContract.transactions);
const userActivityQuery$ = queryOf(walletUserContract.activity);
const paymentMethodParams$ = pathParamsOf(walletContract.paymentMethod);
const createBody$ = bodyResultOf(walletContract.createSpend);
const getParams$ = pathParamsOf(walletContract.getSpend);
const cancelParams$ = pathParamsOf(walletContract.cancelSpend);
const credentialsParams$ = pathParamsOf(walletContract.spendCredentials);
const callbackQuery$ = queryOf(walletCallbackContract.callback);
const userConnectBody$ = bodyResultOf(walletUserContract.connect);
const connectStatusBody$ = bodyResultOf(walletUserContract.connectStatus);

const connectStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  const enabled = await settle(get(walletEnabled$), signal);
  signal.throwIfAborted();
  if (!enabled.ok) {
    return walletError(enabled.error);
  }
  const input = await get(connectStatusBody$);
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const auth = get(organizationAuthContext$);
  const body = await set(
    walletConnectStatus$,
    { orgId: auth.orgId, userId: auth.userId, agentId: input.data.agentId },
    input.data.state,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

const status$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(get(walletStatus$), signal);
  signal.throwIfAborted();
  return walletResponse(result);
});
const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const input = await get(connectBody$);
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const auth = get(organizationAuthContext$);
  if (
    !input.data.readOnly &&
    (auth.tokenType !== "agent" || !auth.capabilities.includes("wallet:write"))
  ) {
    return walletError(
      new LinkWalletError(
        403,
        "MISSING_CAPABILITY",
        "Connecting Link requires wallet:write; wallet:read only permits reads using existing consent",
      ),
    );
  }
  const result = await settle(
    set(startWalletOAuth$, owner.value, input.data, signal),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});
const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(disconnectWallet$, owner.value, signal),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});
const userStatus$ = command(async ({ get }, signal: AbortSignal) => {
  const enabled = await settle(get(walletEnabled$), signal);
  signal.throwIfAborted();
  if (!enabled.ok) {
    return walletError(enabled.error);
  }
  const result = await settle(get(walletSettingsStatus$), signal);
  signal.throwIfAborted();
  return walletResponse(result);
});
const userTransactions$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const enabled = await settle(get(walletEnabled$), signal);
  signal.throwIfAborted();
  if (!enabled.ok) {
    return walletError(enabled.error);
  }
  const body = await get(walletTransactions$);
  signal.throwIfAborted();
  return { status: 200 as const, body };
});
const userActivity$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const enabled = await settle(get(walletEnabled$), signal);
  signal.throwIfAborted();
  if (!enabled.ok) {
    return walletError(enabled.error);
  }
  const { orgId, userId } = get(organizationAuthContext$);
  const query = get(userActivityQuery$);
  const result = await settle(
    set(
      readWallet$,
      { orgId, userId },
      {
        operation: "transactions_read",
        query: {
          limit: query.limit ?? 20,
          starting_after: query.startingAfter,
          start_date: query.startDate,
          end_date: query.endDate,
          category: query.category,
        },
      },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return walletError(result.error);
  }
  return {
    status: 200 as const,
    body: walletUserContract.activity.responses[200].parse(result.value),
  };
});
const userPaymentMethods$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    const enabled = await settle(get(walletEnabled$), signal);
    signal.throwIfAborted();
    if (!enabled.ok) {
      return walletError(enabled.error);
    }
    const { orgId, userId } = get(organizationAuthContext$);
    const result = await settle(
      set(
        readWallet$,
        { orgId, userId },
        { operation: "payment_methods_read" },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      return walletError(result.error);
    }
    return {
      status: 200 as const,
      body: walletUserContract.paymentMethods.responses[200].parse(
        result.value,
      ),
    };
  },
);
const userConnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const enabled = await settle(get(walletEnabled$), signal);
  signal.throwIfAborted();
  if (!enabled.ok) {
    return walletError(enabled.error);
  }
  const input = await get(userConnectBody$);
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const { orgId, userId } = get(organizationAuthContext$);
  const result = await settle(
    set(startWalletOAuth$, { orgId, userId }, input.data, signal),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});
const userDisconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const enabled = await settle(get(walletEnabled$), signal);
  signal.throwIfAborted();
  if (!enabled.ok) {
    return walletError(enabled.error);
  }
  const { orgId, userId } = get(organizationAuthContext$);
  const result = await settle(
    set(disconnectWallet$, { orgId, userId }, signal),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});
const createSpend$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await settle(get(agentOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const input = await get(createBody$);
  signal.throwIfAborted();
  if (!input.ok) {
    return input.response;
  }
  const result = await settle(
    set(createWalletSpend$, owner.value, input.data, signal),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});
const getSpend$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(getWalletSpend$, owner.value, get(getParams$).id, false, signal),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});
const cancelSpend$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await settle(get(agentOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(getWalletSpend$, owner.value, get(cancelParams$).id, true, signal),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});
const spendCredentials$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(agentOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(
      getWalletSpendCredentials$,
      owner.value,
      get(credentialsParams$).id,
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return walletError(result.error);
  }
  // Deliver a file: the Runner omits binary download bodies from network logs,
  // including when diagnostic body capture is enabled. Never serve this as JSON.
  return new Response(JSON.stringify(result.value), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition":
        'attachment; filename="link-payment-credentials.json"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
const callback$ = command(async ({ get, set }, signal: AbortSignal) => {
  const enabled = await settle(get(walletEnabled$), signal);
  signal.throwIfAborted();
  if (!enabled.ok) {
    return walletError(enabled.error);
  }
  const auth = get(organizationAuthContext$);
  const result = await settle(
    set(
      completeWalletOAuth$,
      { orgId: auth.orgId, userId: auth.userId, ...get(callbackQuery$) },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});

const listSpends$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(listWalletSpends$, owner.value, get(spendListQuery$), signal),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return walletError(result.error);
  }
  return {
    status: 200 as const,
    body: walletContract.listSpends.responses[200].parse(result.value),
  };
});
const transactions$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const query = get(transactionsQuery$);
  const result = await settle(
    set(
      readWallet$,
      owner.value,
      {
        operation: "transactions_read",
        query: {
          limit: query.limit ?? 20,
          starting_after: query.startingAfter,
          start_date: query.startDate,
          end_date: query.endDate,
          category: query.category,
        },
      },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return walletError(result.error);
  }
  return {
    status: 200 as const,
    body: walletContract.transactions.responses[200].parse(result.value),
  };
});
const paymentMethods$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(
      readWallet$,
      owner.value,
      { operation: "payment_methods_read" },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return walletError(result.error);
  }
  return {
    status: 200 as const,
    body: walletContract.paymentMethods.responses[200].parse(result.value),
  };
});
const paymentMethod$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(
      readWallet$,
      owner.value,
      { operation: "payment_method_read", id: get(paymentMethodParams$).id },
      signal,
    ),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return walletError(result.error);
  }
  return {
    status: 200 as const,
    body: walletContract.paymentMethod.responses[200].parse(result.value),
  };
});
const userInfo$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = await settle(get(readOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(readWallet$, owner.value, { operation: "user_info_read" }, signal),
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return walletError(result.error);
  }
  return {
    status: 200 as const,
    body: walletContract.userInfo.responses[200].parse(result.value),
  };
});

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  acceptAnySandboxCapability: true,
  accept: ["agent"],
} as const;
const agentAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "wallet:write",
  accept: ["agent"],
} as const;
const userAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

export const walletRoutes: readonly RouteEntry[] = [
  {
    route: walletUserContract.paymentMethods,
    handler: authRoute(userAuth, userPaymentMethods$),
  },
  {
    route: walletUserContract.activity,
    handler: authRoute(userAuth, userActivity$),
  },
  {
    route: walletUserContract.transactions,
    handler: authRoute(userAuth, userTransactions$),
  },
  {
    route: walletUserContract.status,
    handler: authRoute(userAuth, userStatus$),
  },
  {
    route: walletUserContract.connect,
    handler: authRoute(userAuth, userConnect$),
  },
  {
    route: walletUserContract.disconnect,
    handler: authRoute(userAuth, userDisconnect$),
  },
  {
    route: walletContract.listSpends,
    handler: authRoute(readAuth, listSpends$),
  },
  {
    route: walletContract.transactions,
    handler: authRoute(readAuth, transactions$),
  },
  {
    route: walletContract.paymentMethods,
    handler: authRoute(readAuth, paymentMethods$),
  },
  {
    route: walletContract.paymentMethod,
    handler: authRoute(readAuth, paymentMethod$),
  },
  { route: walletContract.userInfo, handler: authRoute(readAuth, userInfo$) },
  {
    route: walletUserContract.connectStatus,
    handler: authRoute(userAuth, connectStatus$),
  },
  { route: walletContract.status, handler: authRoute(readAuth, status$) },
  { route: walletContract.connect, handler: authRoute(readAuth, connect$) },
  {
    route: walletContract.disconnect,
    handler: authRoute(readAuth, disconnect$),
  },
  {
    route: walletContract.createSpend,
    handler: authRoute(agentAuth, createSpend$),
  },
  { route: walletContract.getSpend, handler: authRoute(readAuth, getSpend$) },
  {
    route: walletContract.cancelSpend,
    handler: authRoute(agentAuth, cancelSpend$),
  },
  {
    route: walletContract.spendCredentials,
    handler: authRoute(agentAuth, spendCredentials$),
  },
  // Register this literal before the generic /connectors/:connectorSlug/callback.
  {
    route: walletCallbackContract.callback,
    handler: authRoute(userAuth, callback$),
  },
];
