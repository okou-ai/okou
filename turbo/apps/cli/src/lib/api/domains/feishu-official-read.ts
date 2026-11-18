import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  feishuOfficialReadContract,
  type FeishuChatListQuery,
  type FeishuMessageHistoryQuery,
} from "@okouai/api-contracts/contracts/feishu-official-read";
import { getClientConfig, handleError } from "../core/client-factory";

export async function listOfficialFeishuChats(query: FeishuChatListQuery) {
  const client = initClient(
    feishuOfficialReadContract,
    await getClientConfig(),
  );
  const result = await client.listChats({ query, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to list Feishu group chats");
}
export async function readOfficialFeishuHistory(
  query: FeishuMessageHistoryQuery,
) {
  const client = initClient(
    feishuOfficialReadContract,
    await getClientConfig(),
  );
  const result = await client.history({ query, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to read Feishu group chat history");
}
