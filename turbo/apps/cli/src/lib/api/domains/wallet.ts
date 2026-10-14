import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import {
  walletContract,
  walletSpendSchema,
  type WalletCreateSpend,
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
export async function walletConnect() {
  const response = await (await client()).connect({ body: {} });
  if (response.status !== 200) {
    walletError(response, "Could not connect the Link wallet", "connect");
  }
  return walletContract.connect.responses[200].parse(response.body);
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
