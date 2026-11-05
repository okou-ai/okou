import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import { getClientConfig, handleError } from "../core/client-factory";

export async function getCurrentMember() {
  const client = initClient(authContract, await getClientConfig());
  const result = await client.me({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read the current member");
}
