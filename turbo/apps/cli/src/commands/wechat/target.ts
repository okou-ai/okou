import { z } from "zod";
import { listWechatChannels } from "../../lib/api/domains/integrations-wechat";

export async function wechatChannelId(value: string): Promise<string> {
  if (value !== "me") {
    return z.uuid().parse(value.startsWith("chat:") ? value.slice(5) : value);
  }
  const { channels } = await listWechatChannels();
  const [channel] = channels;
  if (!channel) {
    throw new Error(
      "No WeChat connection in the current workspace. Run okou wechat connect.",
    );
  }
  if (channels.length !== 1) {
    throw new Error(
      "More than one WeChat conversation is available. Use an explicit ID from okou wechat channel list.",
    );
  }
  if (channel.status !== "active") {
    throw new Error(
      "Your WeChat connection needs to be renewed. Run okou wechat connect.",
    );
  }
  return channel.id;
}
