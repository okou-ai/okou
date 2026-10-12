import {
  walletCallbackContract,
  walletContract,
} from "@okouai/api-contracts/contracts/wallet";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command, type Command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { LinkWalletError } from "../services/link-wallet-provider.service";
import {
  completeWalletOAuth$,
  createWalletSpend$,
  disconnectWallet$,
  getWalletSpend$,
  startWalletOAuth$,
  walletRunOwner$,
  walletStatus$,
} from "../services/link-wallet.service";
import { settle } from "../utils";

const requireWalletEnabled$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
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
const agentOwner$ = command(async ({ set }, signal: AbortSignal) => {
  await set(requireWalletEnabled$, signal);
  signal.throwIfAborted();
  return await set(walletRunOwner$);
});

function guardedWalletRoute<T>(handler: Command<Promise<T>, [AbortSignal]>) {
  return command(async ({ set }, signal: AbortSignal) => {
    const result = await settle(set(handler, signal), signal);
    signal.throwIfAborted();
    if (result.ok) {
      return result.value;
    }
    if (!(result.error instanceof LinkWalletError)) {
      throw result.error;
    }
    return {
      status: result.error.status,
      body: {
        error: { code: result.error.code, message: result.error.message },
      },
    };
  });
}
const createBody$ = bodyResultOf(walletContract.createSpend);
const getParams$ = pathParamsOf(walletContract.getSpend);
const cancelParams$ = pathParamsOf(walletContract.cancelSpend);
const callbackQuery$ = queryOf(walletCallbackContract.callback);

const status$ = guardedWalletRoute(
  command(async ({ set }, signal: AbortSignal) => {
    const owner = await set(agentOwner$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body: await set(walletStatus$, owner) };
  }),
);
const connect$ = guardedWalletRoute(
  command(async ({ set }, signal: AbortSignal) => {
    const owner = await set(agentOwner$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body: await set(startWalletOAuth$, owner) };
  }),
);
const disconnect$ = guardedWalletRoute(
  command(async ({ set }, signal: AbortSignal) => {
    const owner = await set(agentOwner$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: await set(disconnectWallet$, owner, signal),
    };
  }),
);
const createSpend$ = guardedWalletRoute(
  command(async ({ get, set }, signal: AbortSignal) => {
    const owner = await set(agentOwner$, signal);
    signal.throwIfAborted();
    const body = await get(createBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return {
      status: 200 as const,
      body: await set(createWalletSpend$, owner, body.data, signal),
    };
  }),
);
const getSpend$ = guardedWalletRoute(
  command(async ({ get, set }, signal: AbortSignal) => {
    const owner = await set(agentOwner$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: await set(
        getWalletSpend$,
        owner,
        get(getParams$).id,
        false,
        signal,
      ),
    };
  }),
);
const cancelSpend$ = guardedWalletRoute(
  command(async ({ get, set }, signal: AbortSignal) => {
    const owner = await set(agentOwner$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: await set(
        getWalletSpend$,
        owner,
        get(cancelParams$).id,
        true,
        signal,
      ),
    };
  }),
);
const callback$ = guardedWalletRoute(
  command(async ({ get, set }, signal: AbortSignal) => {
    await set(requireWalletEnabled$, signal);
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    return {
      status: 200 as const,
      body: await set(
        completeWalletOAuth$,
        { orgId: auth.orgId, userId: auth.userId, ...get(callbackQuery$) },
        signal,
      ),
    };
  }),
);

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
  // Register this literal before the generic /connectors/:connectorSlug/callback.
  {
    route: walletCallbackContract.callback,
    handler: authRoute(userAuth, callback$),
  },
];
