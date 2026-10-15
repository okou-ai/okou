import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import {
  walletContract,
  walletSpendSchema,
  walletSpendCredentialsSchema,
  type WalletCreateSpend,
  type WalletConnect,
  type WalletSpendListQuery,
  type WalletTransactionsQuery,
  walletAuthorizationDetailsSchema,
} from "@okouai/api-contracts/contracts/wallet";

import { ApiRequestError, getClientConfig } from "../core/client-factory";

// A gateway can replace a provider failure with HTML or a plain error body.
// Keep an operation and caller-owned reference even when no API error survives.
function walletError(
  response: { status: number; body: unknown; headers: Headers },
  message: string,
  operation: string,
  reference?: string,
): never {
  const error = apiErrorSchema.safeParse(response.body);
  if (error.success) {
    throw new ApiRequestError(
      error.data.error.message,
      error.data.error.code,
      response.status,
    );
  }
  const contentType = response.headers.get("content-type")?.split(";")[0];
  const responseType = ["application/json", "text/html", "text/plain"].includes(
    contentType ?? "",
  )
    ? contentType
    : "unrecognized";
  throw new ApiRequestError(
    `${message} (operation: ${operation}; reference: ${reference ?? "unavailable"}; response: ${responseType}; backend diagnostic unavailable)`,
    "WALLET_DIAGNOSTIC_UNAVAILABLE",
    response.status,
  );
}

async function client() {
  return initClient(walletContract, await getClientConfig());
}
export async function walletStatus() {
  const response = await (await client()).status();
  if (response.status !== 200) {
    walletError(response, "Could not read wallet status", "status");
  }
  return walletContract.status.responses[200].parse(response.body);
}
export async function walletConnect(body: WalletConnect = {}) {
  const response = await (await client()).connect({ body });
  if (response.status !== 200) {
    walletError(response, "Could not connect the Link wallet", "connect");
  }
  const value = walletContract.connect.responses[200].parse(response.body);
  if (body.readOnly || body.transactions) {
    // Older API deployments ignore the newly introduced body fields. Never
    // show a payment-consent URL as though it were read-only authorization.
    const url = new URL(value.url);
    const scopes = url.searchParams.get("scope")?.split(/[ ,]+/) ?? [];
    let details: unknown;
    try {
      details = JSON.parse(
        url.searchParams.get("authorization_details") ?? "null",
      );
    } catch {
      details = null;
    }
    const parsed = walletAuthorizationDetailsSchema.safeParse(details);
    const hasTransactions =
      parsed.success &&
      parsed.data.some((detail) => {
        return (
          detail.type === "source" &&
          detail.actions.includes("read_link_transactions")
        );
      });
    if (
      !hasTransactions ||
      (body.readOnly &&
        (scopes.includes("payment_methods.agentic") ||
          !scopes.includes("userinfo:read")))
    ) {
      throw new Error(
        "The wallet server does not support the requested read authorization yet; update the server before reconnecting",
      );
    }
  }
  return value;
}
export async function walletDisconnect() {
  const response = await (await client()).disconnect({ body: {} });
  if (response.status !== 200) {
    walletError(response, "Could not revoke the Link wallet", "disconnect");
  }
  return walletContract.disconnect.responses[200].parse(response.body);
}
export async function walletCreateSpend(body: WalletCreateSpend) {
  const response = await (await client()).createSpend({ body });
  if (response.status !== 200) {
    walletError(
      response,
      "Could not create the spend request; retain the same intent ID",
      "spend_create",
      body.intentId,
    );
  }
  return walletSpendSchema.parse(response.body);
}
export async function walletGetSpend(id: string) {
  const response = await (await client()).getSpend({ params: { id } });
  if (response.status !== 200) {
    walletError(
      response,
      "Could not read the existing spend request",
      "spend_read",
      id,
    );
  }
  return walletSpendSchema.parse(response.body);
}
export async function walletCancelSpend(id: string) {
  const response = await (
    await client()
  ).cancelSpend({ params: { id }, body: {} });
  if (response.status !== 200) {
    walletError(
      response,
      "Could not cancel the spend request",
      "spend_cancel",
      id,
    );
  }
  return walletSpendSchema.parse(response.body);
}

export async function walletSpendCredentials(id: string) {
  const api = await client();
  const response = await api
    .spendCredentials({ params: { id }, body: {} })
    .catch(() => {
      // JSON/transport exceptions can contain fragments of the credential body.
      throw new Error(
        "Could not read payment credentials; check the existing spend request before retrying",
      );
    });
  if (response.status !== 200) {
    walletError(
      response,
      "Could not retrieve payment credentials",
      "spend_credentials",
      id,
    );
  }
  if (
    !(response.body instanceof Blob) ||
    response.headers.get("content-type") !== "application/octet-stream"
  ) {
    throw new Error(
      "The backend did not return a private credential file; no credentials were saved",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await response.body.text());
  } catch {
    throw new Error(
      "The payment credential file could not be decoded; no credentials were saved",
    );
  }
  const parsed = walletSpendCredentialsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "The backend returned invalid payment credentials; no credentials were saved",
    );
  }
  return parsed.data;
}

export async function walletListSpends(query: WalletSpendListQuery) {
  const response = await (await client()).listSpends({ query });
  if (response.status !== 200)
    walletError(
      response,
      "Could not read wallet purchase history",
      "spend_list",
    );
  return walletContract.listSpends.responses[200].parse(response.body);
}
export async function walletTransactions(query: WalletTransactionsQuery) {
  const response = await (await client()).transactions({ query });
  if (response.status !== 200)
    walletError(
      response,
      "Could not read Link transactions",
      "transactions_read",
    );
  return walletContract.transactions.responses[200].parse(response.body);
}
export async function walletPaymentMethods() {
  const response = await (await client()).paymentMethods({ query: {} });
  if (response.status !== 200)
    walletError(
      response,
      "Could not read Link payment methods",
      "payment_methods_read",
    );
  return walletContract.paymentMethods.responses[200].parse(response.body);
}
export async function walletPaymentMethod(id: string) {
  const response = await (
    await client()
  ).paymentMethod({ params: { id }, query: {} });
  if (response.status !== 200)
    walletError(
      response,
      "Could not read the Link payment method",
      "payment_method_read",
      id,
    );
  return walletContract.paymentMethod.responses[200].parse(response.body);
}
export async function walletUserInfo() {
  const response = await (await client()).userInfo({ query: {} });
  if (response.status !== 200)
    walletError(
      response,
      "Could not read Link user information",
      "user_info_read",
    );
  return walletContract.userInfo.responses[200].parse(response.body);
}
