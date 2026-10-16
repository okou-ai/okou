import { z } from "zod";
export function wechatChannelId(value: string) {
  return z.uuid().parse(value.startsWith("chat:") ? value.slice(5) : value);
}
