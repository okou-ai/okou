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
export async function wechatRequest(
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
    await wechatRequest(
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
    await wechatRequest(
      baseUrl,
      `/ilink/bot/get_qrcode_status?${query}`,
      undefined,
      undefined,
      signal,
    ),
  );
}
const wechatCdnMediaSchema = z.object({
  encrypt_query_param: z.string().optional(),
  aes_key: z.string().optional(),
  full_url: z.string().optional(),
  encrypt_type: z.number().optional(),
});
export const wechatItemSchema = z.object({
  type: z.number(),
  text_item: z.object({ text: z.string() }).optional(),
  image_item: z
    .object({
      media: wechatCdnMediaSchema.optional(),
      aeskey: z.string().optional(),
      mid_size: z.number().optional(),
    })
    .optional(),
  voice_item: z
    .object({
      media: wechatCdnMediaSchema.optional(),
      text: z.string().optional(),
    })
    .optional(),
  file_item: z
    .object({
      media: wechatCdnMediaSchema.optional(),
      file_name: z.string().optional(),
      len: z.string().optional(),
    })
    .optional(),
  video_item: z
    .object({
      media: wechatCdnMediaSchema.optional(),
      video_size: z.number().optional(),
    })
    .optional(),
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
  item_list: z.array(wechatItemSchema).optional(),
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
    await wechatRequest(
      baseUrl,
      "/ilink/bot/getupdates",
      { get_updates_buf: cursor, base_info: baseInfo },
      token,
      signal,
    ),
  );
}
const wechatConfigSchema = z.object({
  typing_ticket: z.string().optional(),
});

export async function getWechatTypingTicket(
  args: {
    readonly baseUrl: string;
    readonly token: string;
    readonly senderId: string;
    readonly contextToken: string;
  },
  signal: AbortSignal,
): Promise<string | undefined> {
  const config = wechatConfigSchema.parse(
    await wechatRequest(
      args.baseUrl,
      "/ilink/bot/getconfig",
      {
        ilink_user_id: args.senderId,
        context_token: args.contextToken,
        base_info: baseInfo,
      },
      args.token,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    ),
  );
  return config.typing_ticket;
}

export async function sendWechatTyping(
  args: {
    readonly baseUrl: string;
    readonly token: string;
    readonly senderId: string;
    readonly typingTicket: string;
    readonly status: 1 | 2;
  },
  signal: AbortSignal,
): Promise<void> {
  await wechatRequest(
    args.baseUrl,
    "/ilink/bot/sendtyping",
    {
      ilink_user_id: args.senderId,
      typing_ticket: args.typingTicket,
      status: args.status,
      base_info: baseInfo,
    },
    args.token,
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  );
}

export const wechatSendReceiptSchema = z.object({
  message_id: z.string().optional(),
});
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
  return wechatSendReceiptSchema.parse(
    await wechatRequest(
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
    ),
  );
}
