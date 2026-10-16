import type { z } from "zod";

import {
  LinkWalletError,
  linkCredentialsSchema,
} from "./link-wallet-provider.service";

type Credentials = z.infer<typeof linkCredentialsSchema>;
export type WalletPermission =
  "payments" | "spendHistory" | "paymentMethods" | "userInfo" | "transactions";

export function walletAuthorization(credentials?: Credentials) {
  const scopes = credentials?.scope?.split(/[ ,]+/).filter(Boolean) ?? [];
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
  // Legacy credentials were accepted only after validating the payment scope.
  // They establish no financial-data or profile grant until refreshed.
  // Remove once old API writers/rollback targets and unrefreshed credentials
  // are gone, together with linkCredentialsSchema's tolerance; cleanup #40206.
  const payments =
    Boolean(credentials && credentials.scope === undefined) ||
    scopes.includes("payment_methods.agentic");
  const userInfo = scopes.includes("userinfo:read");
  const transactions = sourceActions.includes("read_link_transactions");
  return {
    known: credentials?.scope !== undefined,
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
