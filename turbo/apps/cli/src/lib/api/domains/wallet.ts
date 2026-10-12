import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  walletContract,
  walletSpendSchema,
  type WalletCreateSpend,
} from "@okouai/api-contracts/contracts/wallet";

import { getClientConfig, handleError } from "../core/client-factory";

async function client() {
  return initClient(walletContract, await getClientConfig());
}
export async function walletStatus() {
  const response = await (await client()).status();
  if (response.status !== 200) {
    handleError(response, "Could not read wallet status");
  }
  return walletContract.status.responses[200].parse(response.body);
}
export async function walletConnect() {
  const response = await (await client()).connect({ body: {} });
  if (response.status !== 200) {
    handleError(response, "Could not connect the Link wallet");
  }
  return walletContract.connect.responses[200].parse(response.body);
}
export async function walletDisconnect() {
  const response = await (await client()).disconnect({ body: {} });
  if (response.status !== 200) {
    handleError(response, "Could not revoke the Link wallet");
  }
  return walletContract.disconnect.responses[200].parse(response.body);
}
export async function walletCreateSpend(body: WalletCreateSpend) {
  const response = await (await client()).createSpend({ body });
  if (response.status !== 200) {
    handleError(
      response,
      "Could not create the spend request; retain the same intent ID",
    );
  }
  return walletSpendSchema.parse(response.body);
}
export async function walletGetSpend(id: string) {
  const response = await (await client()).getSpend({ params: { id } });
  if (response.status !== 200) {
    handleError(response, "Could not read the existing spend request");
  }
  return walletSpendSchema.parse(response.body);
}
export async function walletCancelSpend(id: string) {
  const response = await (
    await client()
  ).cancelSpend({ params: { id }, body: {} });
  if (response.status !== 200) {
    handleError(response, "Could not cancel the spend request");
  }
  return walletSpendSchema.parse(response.body);
}
