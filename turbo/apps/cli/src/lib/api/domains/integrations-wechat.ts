import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsWechatMessagesContract as contract,
  wechatSendErrorSchema,
  type WechatHistoryQuery,
  type WechatSendBody,
} from "@okouai/api-contracts/contracts/integrations-wechat-messages";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";
export async function listWechatChannels() {
  const client = initClient(contract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.listChannels({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list WeChat conversations");
}
export async function readWechatHistory(query: WechatHistoryQuery) {
  const client = initClient(contract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.history({ headers: {}, query });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read WeChat history");
}
export async function sendWechatMessage(body: WechatSendBody) {
  const client = initClient(contract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.sendMessage({ headers: {}, body });
  if (result.status === 200) return result.body;
  const parsed = wechatSendErrorSchema.safeParse(result.body);
  if (parsed.success) {
    const { error } = parsed.data;
    const lines = [error.message, `Operation: ${body.operationId}`];
    if (error.deliveredMessages?.length)
      lines.push(
        "Already delivered messages (do not resend these):",
        ...error.deliveredMessages.map((message) => {
          return message.id;
        }),
      );
    if (error.uncertainMessageId)
      lines.push(
        `Delivery unknown: ${error.uncertainMessageId}. Check history; do not blindly resend.`,
      );
    throw new ApiRequestError(lines.join("\n"), error.code, result.status);
  }
  handleError(result, "Failed to send WeChat message");
}
