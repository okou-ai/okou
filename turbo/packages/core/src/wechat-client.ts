import {
  wechatUpdatesSchema,
  wechatMessageSchema,
} from "@okouai/api-contracts/contracts/wechat-protocol";
import * as z from "zod";
import { parseWechatJson } from "./wechat-json";
export const WECHAT_ORIGIN = "https://ilinkai.weixin.qq.com";
const REQUEST_TIMEOUT_MS = 40_000;
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
export class WechatRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly ret?: number,
    readonly errcode?: number,
  ) {
    super(
      ret === undefined && errcode === undefined
        ? `WeChat request failed (${statusCode})`
        : `WeChat rejected the request (ret=${ret ?? 0}, errcode=${errcode ?? 0})`,
    );
    this.name = "WechatRequestError";
  }
}
export function wechatRequest(
  baseUrl: string,
  path: string,
  body: unknown | undefined,
  token: string | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  return requestWechat(
    baseUrl,
    path,
    body,
    token,
    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  );
}
async function requestWechat(
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
    headers["X-WECHAT-UIN"] = btoa(
      String(
        new DataView(
          crypto.getRandomValues(new Uint8Array(4)).buffer,
        ).getUint32(0),
      ),
    );
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${wechatOrigin(baseUrl)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "manual",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new WechatRequestError(response.status);
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
    throw new WechatRequestError(response.status, result.ret, result.errcode);
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
const providerUpdatesSchema = wechatUpdatesSchema.extend({
  // One malformed provider input must not discard the rest of its batch.
  msgs: z
    .array(z.unknown())
    .transform((values) => {
      return values.flatMap((value) => {
        const parsed = wechatMessageSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
    })
    .optional(),
});
export async function getWechatUpdates(
  baseUrl: string,
  token: string,
  cursor: string,
  signal: AbortSignal,
) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const result = await requestWechat(
      baseUrl,
      "/ilink/bot/getupdates",
      { get_updates_buf: cursor, base_info: baseInfo },
      token,
      AbortSignal.any([signal, timeoutSignal]),
    );
    signal.throwIfAborted();
    return providerUpdatesSchema.parse(result);
  } catch (error) {
    signal.throwIfAborted();
    if (
      timeoutSignal.aborted &&
      (error === timeoutSignal.reason ||
        (error instanceof Error && error.name === "AbortError") ||
        (error instanceof DOMException && error.name === "TimeoutError"))
    ) {
      // An idle long poll ends without advancing the cursor. Only this
      // request's deadline is expected; caller cancellation remains an error.
      // workerd clones the timeout DOMException instead of preserving identity.
      return null;
    }
    throw error;
  }
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
    contextToken?: string;
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
