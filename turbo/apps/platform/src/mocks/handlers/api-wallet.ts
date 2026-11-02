import { walletUserContract } from "@okouai/api-contracts/contracts/wallet";
import { mockApi } from "../msw-contract.ts";

export const apiWalletHandlers = [
  mockApi(walletUserContract.spendStatus, ({ respond }) => {
    return respond(200, { status: "unavailable" });
  }),
];
