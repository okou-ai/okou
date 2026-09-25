import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsDiscordReadContract,
  type DiscordChannelListQuery,
  type DiscordChannelListResponse,
  type DiscordHistoryQuery,
  type DiscordHistoryResponse,
  type DiscordRepliesQuery,
  type DiscordRepliesResponse,
} from "@okouai/api-contracts/contracts/integrations-discord-read";
import {
  integrationsDiscordMessageContract,
  discordSendErrorSchema,
  type SendDiscordMessageBody,
  type SendDiscordMessageResponse,
} from "@okouai/api-contracts/contracts/integrations-discord-message";
import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

export async function listDiscordChannels(
  query: DiscordChannelListQuery,
): Promise<DiscordChannelListResponse> {
  const client = initClient(
    integrationsDiscordReadContract,
    await getClientConfig(),
  );
  const result = await client.listChannels({ query, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list Discord channels");
}

export async function readDiscordHistory(
  query: DiscordHistoryQuery,
): Promise<DiscordHistoryResponse> {
  const client = initClient(
    integrationsDiscordReadContract,
    await getClientConfig(),
  );
  const result = await client.history({ query, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read Discord history");
}

export async function readDiscordReplies(
  query: DiscordRepliesQuery,
): Promise<DiscordRepliesResponse> {
  const client = initClient(
    integrationsDiscordReadContract,
    await getClientConfig(),
  );
  const result = await client.replies({ query, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read Discord thread replies");
}

export async function sendDiscordMessage(
  body: SendDiscordMessageBody,
): Promise<SendDiscordMessageResponse> {
  const client = initClient(
    integrationsDiscordMessageContract,
    await getClientConfig(),
  );
  const result = await client.sendMessage({ body, headers: {} });
  if (result.status === 200) return result.body;
  const error = discordSendErrorSchema.safeParse(result.body);
  if (error.success && error.data.error.deliveredMessages?.length) {
    const delivered = error.data.error.deliveredMessages
      .map((message) => {
        return `${message.id}: ${message.url}`;
      })
      .join("\n");
    throw new ApiRequestError(
      `${error.data.error.message}\nAlready delivered messages (do not resend these):\n${delivered}`,
      error.data.error.code,
      result.status,
    );
  }
  handleError(result, "Failed to send Discord message");
}
