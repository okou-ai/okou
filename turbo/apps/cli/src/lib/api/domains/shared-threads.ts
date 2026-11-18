import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { getClientConfig, handleError } from "../core/client-factory";

export async function getSharedThread(id: string) {
  const client = initClient(sharedThreadsContract, await getClientConfig());
  const result = await client.get({ params: { id } });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to read shared conversation");
}
