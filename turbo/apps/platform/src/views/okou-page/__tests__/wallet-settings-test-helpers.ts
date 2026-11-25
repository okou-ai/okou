import {
  walletUserContract,
  type WalletConnectionStatus,
  type WalletPaymentMethod,
} from "@okouai/api-contracts/contracts/wallet";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function linkStatus(
  connectionStatus: WalletConnectionStatus["connectionStatus"],
  revocationPending = false,
): WalletConnectionStatus {
  const connected =
    connectionStatus === "connected" || connectionStatus === "scope-mismatch";
  const paymentScope = "payment_methods.agentic";
  const profileScope = "userinfo:read";
  const activity = "read_link_transactions";
  const userInfo = connectionStatus === "connected";
  const scopes = connected ? [paymentScope] : [];
  if (userInfo) {
    scopes.push(profileScope);
  }
  return {
    connected,
    connectionStatus,
    revocationPending,
    nextAction: connected ? "create_spend" : "connect",
    checkoutAvailable: false,
    authorization: {
      known: connected,
      scopes,
      sourceActions: connected ? [activity] : [],
      missingPermissions: userInfo
        ? []
        : connected
          ? [profileScope]
          : [paymentScope, profileScope, activity],
      capabilities: {
        payments: connected,
        transactions: connected,
        paymentMethods: connected,
        spendHistory: connected,
        userInfo,
      },
    },
    scopeChange:
      connectionStatus === "scope-mismatch"
        ? {
            reason: "permissions_changed",
            addedScopes: [profileScope],
            removedScopes: ["legacy"],
            currentScopes: [paymentScope, activity, profileScope],
            storedScopes: [paymentScope, activity, "legacy"],
          }
        : null,
  };
}

export function serveWallet(
  context: TestContext,
  readStatus: () => WalletConnectionStatus,
  methods: WalletPaymentMethod[] = [],
) {
  context.mocks.data.org({ id: "org_default", role: "member" });
  context.mocks.api(walletUserContract.status, ({ respond }) => {
    return respond(200, readStatus());
  });
  context.mocks.api(walletUserContract.paymentMethods, ({ respond }) => {
    return respond(200, { data: methods });
  });
  context.mocks.api(walletUserContract.transactions, ({ respond }) => {
    return respond(200, { transactions: [], nextCursor: null });
  });
  context.mocks.api(walletUserContract.activity, ({ respond }) => {
    return respond(200, { data: [], hasMore: false, nextCursor: null });
  });
}
