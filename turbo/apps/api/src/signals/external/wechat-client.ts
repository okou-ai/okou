import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseWechatJson } from "./wechat-json";
export const WECHAT_ORIGIN = "https://ilinkai.weixin.qq.com";
/** Only Tencent iLink HTTPS origins may receive credentials. */
export function wechatOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/u.test(url.hostname)
  ) {
    throw new Error("Invalid WeChat service origin");
  }
  return url.origin;
}
const baseInfo = Object.freeze({
  channel_version: "2.4.10",
  bot_agent: "Okou",
});
const resultSchema = z.object({
  ret: z.number().optional(),
  errcode: z.number().optional(),
});
export class WechatSessionExpiredError extends Error {}
async function request(
  baseUrl: string,
  path: string,
  body: unknown | undefined,
  token: string | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 10),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.AuthorizationType = "ilink_bot_token";
    headers["X-WECHAT-UIN"] = Buffer.from(
      String(randomBytes(4).readUInt32BE()),
    ).toString("base64");
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${wechatOrigin(baseUrl)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
  });
  if (!response.ok) {
    throw new Error(`WeChat request failed (${response.status})`);
  }
  const text = await response.text();
  if (text.length > 2_000_000) {
    throw new Error("WeChat response exceeded the size limit");
  }
  const data = parseWechatJson(text);
  const result = resultSchema.parse(data);
  if (result.ret === -14 || result.errcode === -14) {
    throw new WechatSessionExpiredError("WeChat session expired");
  }
  if ((result.ret ?? 0) !== 0 || (result.errcode ?? 0) !== 0) {
    throw new Error("WeChat rejected the request");
  }
  return data;
}
const qrSchema = z.object({
  qrcode: z.string().min(1),
  qrcode_img_content: z.string().min(1),
});
export async function createWechatQr(signal: AbortSignal) {
  return qrSchema.parse(
    await request(
      WECHAT_ORIGIN,
      "/ilink/bot/get_bot_qrcode?bot_type=3",
      { local_token_list: [] },
      undefined,
      signal,
    ),
  );
}
const qrStatusSchema = z.object({
  status: z.enum([
    "wait",
    "scaned",
    "need_verifycode",
    "verify_code_blocked",
    "expired",
    "scaned_but_redirect",
    "binded_redirect",
    "confirmed",
  ]),
  bot_token: z.string().optional(),
  ilink_bot_id: z.string().optional(),
  ilink_user_id: z.string().optional(),
  baseurl: z.string().optional(),
  redirect_host: z.string().optional(),
});
export async function pollWechatQr(
  baseUrl: string,
  qr: string,
  verifyCode: string | undefined,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ qrcode: qr });
  if (verifyCode) {
    query.set("verify_code", verifyCode);
  }
  return qrStatusSchema.parse(
    await request(
      baseUrl,
      `/ilink/bot/get_qrcode_status?${query}`,
      undefined,
      undefined,
      signal,
    ),
  );
}
const itemSchema = z.object({
  type: z.number(),
  text_item: z.object({ text: z.string() }).optional(),
  ref_msg: z
    .object({
      title: z.string().optional(),
      message_item: z
        .object({
          type: z.number(),
          text_item: z.object({ text: z.string() }).optional(),
        })
        .optional(),
    })
    .optional(),
});
export const wechatMessageSchema = z.object({
  message_id: z.string().min(1),
  from_user_id: z.string(),
  to_user_id: z.string().optional(),
  group_id: z.string().optional(),
  message_type: z.number(),
  message_state: z.number().optional(),
  context_token: z.string().optional(),
  item_list: z.array(itemSchema).optional(),
});
export const wechatUpdatesSchema = z.object({
  get_updates_buf: z.string().optional(),
  msgs: z.array(wechatMessageSchema).optional(),
});
export type WechatMessage = z.infer<typeof wechatMessageSchema>;
export async function getWechatUpdates(
  baseUrl: string,
  token: string,
  cursor: string,
  signal: AbortSignal,
) {
  return wechatUpdatesSchema.parse(
    await request(
      baseUrl,
      "/ilink/bot/getupdates",
      { get_updates_buf: cursor, base_info: baseInfo },
      token,
      signal,
    ),
  );
}
export async function sendWechatText(
  args: {
    baseUrl: string;
    token: string;
    senderId: string;
    contextToken: string;
    clientId: string;
    text: string;
  },
  signal: AbortSignal,
) {
  await request(
    args.baseUrl,
    "/ilink/bot/sendmessage",
    {
      base_info: baseInfo,
      msg: {
        from_user_id: "",
        to_user_id: args.senderId,
        client_id: args.clientId,
        message_type: 2,
        message_state: 2,
        context_token: args.contextToken,
        item_list: [{ type: 1, text_item: { text: args.text } }],
      },
    },
    args.token,
    signal,
  );
}
