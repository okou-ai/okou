import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  larkOfficialReadContract,
  type LarkChatListQuery,
  type LarkMessageHistoryQuery,
} from "@okouai/api-contracts/contracts/lark-official-read";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listOfficialLarkChats(query: LarkChatListQuery) {
  const client = initClient(larkOfficialReadContract, await getClientConfig());
  const result = await client.listChats({ query, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to list Lark group chats");
}
export async function readOfficialLarkHistory(query: LarkMessageHistoryQuery) {
  const client = initClient(larkOfficialReadContract, await getClientConfig());
  const result = await client.history({ query, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to read Lark group chat history");
}
