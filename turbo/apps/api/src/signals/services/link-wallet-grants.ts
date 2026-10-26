import type { infer as zInfer } from "zod";

import {
  LinkWalletError,
  linkCredentialsSchema,
} from "./link-wallet-provider.service";

type Credentials = zInfer<typeof linkCredentialsSchema>;
export type WalletPermission =
  "payments" | "spendHistory" | "paymentMethods" | "userInfo" | "transactions";

export function walletAuthorization(credentials?: Credentials) {
  const scopes = credentials?.scope.split(/[ ,]+/).filter(Boolean) ?? [];
  const sourceActions = [
    ...new Set(
      credentials?.authorizationDetails
        ?.filter((detail) => {
          return detail.type === "source";
        })
        .flatMap((detail) => {
          return detail.actions;
        }) ?? [],
    ),
  ];
  const payments = scopes.includes("payment_methods.agentic");
  const userInfo = scopes.includes("userinfo:read");
  const transactions = sourceActions.includes("read_link_transactions");
  return {
    known: Boolean(credentials),
    scopes,
    sourceActions,
    capabilities: {
      payments,
      spendHistory: Boolean(credentials),
      paymentMethods: payments,
      userInfo,
      transactions,
    },
    missingPermissions: [
      ...(!payments ? ["payment_methods.agentic"] : []),
      ...(!userInfo ? ["userinfo:read"] : []),
      ...(!transactions ? ["read_link_transactions"] : []),
    ],
  };
}

export function requireWalletPermission(
  credentials: Credentials,
  permission: WalletPermission,
) {
  const authorization = walletAuthorization(credentials);
  if (!authorization.capabilities[permission]) {
    throw new LinkWalletError(
      403,
      "WALLET_SCOPE_REQUIRED",
      `Link has not granted ${permission} access. Request user consent with: okou wallet connect --json`,
    );
  }
}
