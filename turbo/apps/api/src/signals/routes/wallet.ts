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
import {
  completeWalletOAuth$,
  createWalletSpend$,
  disconnectWallet$,
  getWalletSpend$,
  getWalletSpendCredentials$,
  startWalletOAuth$,
  walletRunOwner$,
  walletStatus$,
  walletConnectStatus$,
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
const createBody$ = bodyResultOf(walletContract.createSpend);
const getParams$ = pathParamsOf(walletContract.getSpend);
const cancelParams$ = pathParamsOf(walletContract.cancelSpend);
const credentialsParams$ = pathParamsOf(walletContract.spendCredentials);
const callbackQuery$ = queryOf(walletCallbackContract.callback);
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

const status$ = command(async ({ get }, signal: AbortSignal) => {
  const owner = await settle(get(agentOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(get(walletStatus$), signal);
  signal.throwIfAborted();
  return walletResponse(result);
});
const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await settle(get(agentOwner$), signal);
  signal.throwIfAborted();
  if (!owner.ok) {
    return walletError(owner.error);
  }
  const result = await settle(
    set(startWalletOAuth$, owner.value, signal),
    signal,
  );
  signal.throwIfAborted();
  return walletResponse(result);
});
const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const owner = await settle(get(agentOwner$), signal);
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
  const owner = await settle(get(agentOwner$), signal);
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
    route: walletUserContract.connectStatus,
    handler: authRoute(userAuth, connectStatus$),
  },
  { route: walletContract.status, handler: authRoute(agentAuth, status$) },
  { route: walletContract.connect, handler: authRoute(agentAuth, connect$) },
  {
    route: walletContract.disconnect,
    handler: authRoute(agentAuth, disconnect$),
  },
  {
    route: walletContract.createSpend,
    handler: authRoute(agentAuth, createSpend$),
  },
  { route: walletContract.getSpend, handler: authRoute(agentAuth, getSpend$) },
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
