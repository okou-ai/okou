import { accept, HttpStatusError } from "@okouai/connectors/accept";
import {
  settle,
  safeSync,
  settleIncludingAbort,
  startUntrackedBestEffortCleanup,
} from "../utils";
// Tencent iLink's AES-128-ECB wire format; see wechat-MIT.txt for upstream license.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { object, string, type infer as zInfer } from "zod";

import type { WechatAttachment } from "@okouai/db/jsonb-contracts/wechat";
import { MAX_WECHAT_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-wechat-files";
import { wechatItemSchema } from "@okouai/api-contracts/contracts/wechat-protocol";
import {
  wechatRequest,
  wechatSendReceiptSchema,
} from "@okouai/core/wechat-client";

type Item = zInfer<typeof wechatItemSchema>;
export class WechatMediaDownloadError extends Error {
  constructor(
    readonly code: "invalid-media" | "too-large" | "download-failed",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "WechatMediaDownloadError";
  }
}
export class WechatMediaUploadError extends Error {
  constructor(readonly statusCode?: number) {
    super(
      statusCode === undefined
        ? "WeChat CDN upload did not complete"
        : `WeChat CDN upload failed (HTTP ${statusCode})`,
    );
    this.name = "WechatMediaUploadError";
  }
}
const CDN_ORIGIN = "https://novac2c.cdn.weixin.qq.com";
function cdnUrl(
  full: string | undefined,
  query: string | undefined,
  operation: "upload" | "download",
  filekey?: string,
) {
  if (!full && !query) {
    throw new Error("WeChat media reference is missing");
  }
  const url = full ? new URL(full) : new URL(`/c2c/${operation}`, CDN_ORIGIN);
  if (
    url.origin !== CDN_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/c2c/${operation}`
  ) {
    throw new Error("WeChat returned an invalid media origin");
  }
  if (!full && query) {
    url.searchParams.set("encrypted_query_param", query);
  }
  if (!full && filekey) {
    url.searchParams.set("filekey", filekey);
  }
  return url;
}
function mediaOf(item: Item) {
  switch (item.type) {
    case 2: {
      return item.image_item?.media;
    }
    case 3: {
      return item.voice_item?.media;
    }
    case 4: {
      return item.file_item?.media;
    }
    case 5: {
      return item.video_item?.media;
    }
    default: {
      return undefined;
    }
  }
}
export function wechatAttachments(items: readonly Item[]): WechatAttachment[] {
  return items.flatMap((item, index) => {
    const kind =
      item.type === 2
        ? "image"
        : item.type === 3
          ? "audio"
          : item.type === 4
            ? "file"
            : item.type === 5
              ? "video"
              : undefined;
    if (!kind || !mediaOf(item)) {
      return [];
    }
    const length =
      item.type === 4 && item.file_item?.len !== undefined
        ? Number(item.file_item.len)
        : Number.NaN;
    return [
      {
        id: String(index),
        kind,
        filename: item.file_item?.file_name ?? kind,
        size: Number.isSafeInteger(length) && length >= 0 ? length : null,
      },
    ];
  });
}
function mediaKey(item: Item): Buffer {
  const rawHex = item.type === 2 ? item.image_item?.aeskey : undefined;
  if (rawHex !== undefined) {
    if (!/^[a-fA-F0-9]{32}$/u.test(rawHex)) {
      throw new Error("Invalid WeChat media key");
    }
    return Buffer.from(rawHex, "hex");
  }
  const encoded = mediaOf(item)?.aes_key;
  if (!encoded) {
    throw new Error("WeChat media encryption key is missing");
  }
  const key = Buffer.from(encoded, "base64");
  if (
    key.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")
  ) {
    throw new Error("Invalid WeChat media key encoding");
  }
  if (key.length === 16) {
    return key;
  }
  if (key.length === 32 && /^[a-fA-F0-9]{32}$/u.test(key.toString("ascii"))) {
    return Buffer.from(key.toString("ascii"), "hex");
  }
  throw new Error("Invalid WeChat media key");
}
function downloadSource(item: Item) {
  const media = mediaOf(item);
  // The upstream image contract also permits a plain CDN body when no key is supplied.
  const plainImage =
    item.type === 2 &&
    !item.image_item?.aeskey &&
    !media?.aes_key &&
    (media?.encrypt_type === undefined || media.encrypt_type === 0);
  if (
    !media ||
    (!plainImage &&
      media.encrypt_type !== undefined &&
      media.encrypt_type !== 1)
  ) {
    throw new Error("Unsupported WeChat attachment encryption");
  }
  const key = plainImage ? null : mediaKey(item);
  return { media, key };
}
export async function downloadWechatMedia(
  item: Item,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = safeSync(() => {
    const { media, key } = downloadSource(item);
    return {
      key,
      url: cdnUrl(media.full_url, media.encrypt_query_param, "download"),
    };
  });
  if ("error" in source) {
    throw new WechatMediaDownloadError(
      "invalid-media",
      source.error instanceof Error
        ? source.error.message
        : "Invalid WeChat media reference",
    );
  }
  const { key, url } = source.ok;
  const controller = new AbortController();
  const fetched = await settle(
    accept(
      fetch(url, {
        signal: AbortSignal.any([signal, controller.signal]),
      }),
      [200],
    ),
    signal,
  );
  if (!fetched.ok) {
    controller.abort();
    if (fetched.error instanceof HttpStatusError) {
      throw new WechatMediaDownloadError(
        "download-failed",
        "WeChat attachment is unavailable or expired",
        fetched.error.status,
      );
    }
    throw fetched.error;
  }
  const response = fetched.value;
  if (!response.body) {
    controller.abort();
    throw new WechatMediaDownloadError(
      "download-failed",
      "WeChat attachment is unavailable or expired",
      response.status,
    );
  }
  const reader = response.body.getReader();
  const result = await settleIncludingAbort(readMediaBody(reader, signal));
  controller.abort();
  if (!result.ok) {
    startUntrackedBestEffortCleanup(reader.cancel());
  }
  reader.releaseLock();
  signal.throwIfAborted();
  if (!result.ok) {
    throw result.error;
  }
  let bytes = result.value;
  if (key) {
    const decrypted = safeSync(() => {
      const decipher = createDecipheriv("aes-128-ecb", key, null);
      return Buffer.concat([decipher.update(bytes), decipher.final()]);
    });
    if ("error" in decrypted) {
      throw new WechatMediaDownloadError(
        "invalid-media",
        "Invalid WeChat encrypted media",
      );
    }
    bytes = decrypted.ok;
  }
  if (bytes.byteLength > MAX_WECHAT_FILE_SIZE_BYTES) {
    throw new WechatMediaDownloadError(
      "too-large",
      "WeChat attachment exceeds 10 MiB",
    );
  }
  if (
    item.type === 4 &&
    item.file_item?.len !== undefined &&
    String(bytes.byteLength) !== item.file_item.len
  ) {
    throw new WechatMediaDownloadError(
      "invalid-media",
      "WeChat attachment size does not match its metadata",
    );
  }
  return new Uint8Array(bytes);
}
async function readMediaBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    signal.throwIfAborted();
    if (chunk.done) {
      break;
    }
    size += chunk.value.byteLength;
    if (size > MAX_WECHAT_FILE_SIZE_BYTES + 16) {
      throw new WechatMediaDownloadError(
        "too-large",
        "WeChat attachment exceeds 10 MiB",
      );
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}
export async function uploadWechatMedia(
  args: {
    baseUrl: string;
    token: string;
    senderId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  },
  signal: AbortSignal,
): Promise<Item> {
  if (
    args.bytes.byteLength < 1 ||
    args.bytes.byteLength > MAX_WECHAT_FILE_SIZE_BYTES
  ) {
    throw new Error("WeChat file must be between 1 byte and 10 MiB");
  }
  const key = randomBytes(16);
  const filekey = randomBytes(16).toString("hex");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(args.bytes), cipher.final()]);
  const image = args.contentType.startsWith("image/");
  const video = args.contentType.startsWith("video/");
  const target = object({
    upload_full_url: string().optional(),
    upload_param: string().optional(),
  }).parse(
    await wechatRequest(
      args.baseUrl,
      "/ilink/bot/getuploadurl",
      {
        filekey,
        media_type: image ? 1 : video ? 2 : 3,
        to_user_id: args.senderId,
        rawsize: args.bytes.byteLength,
        rawfilemd5: createHash("md5").update(args.bytes).digest("hex"),
        filesize: encrypted.byteLength,
        no_need_thumb: true,
        aeskey: key.toString("hex"),
        base_info: { channel_version: "2.4.10", bot_agent: "Okou" },
      },
      args.token,
      signal,
    ),
  );
  const downloadParam = await uploadEncryptedMedia(
    cdnUrl(
      target.upload_full_url?.trim(),
      target.upload_param,
      "upload",
      filekey,
    ),
    encrypted,
    signal,
  );
  const media = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(key.toString("hex")).toString("base64"),
    encrypt_type: 1,
  };
  return image
    ? { type: 2, image_item: { media, mid_size: encrypted.byteLength } }
    : video
      ? { type: 5, video_item: { media, video_size: encrypted.byteLength } }
      : {
          type: 4,
          file_item: {
            media,
            file_name: args.filename,
            len: String(args.bytes.byteLength),
          },
        };
}

/** Retrying the same CDN object is safe; message delivery is never retried here. */
async function uploadEncryptedMedia(
  url: URL,
  encrypted: Uint8Array,
  signal: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await settle(
      accept(
        fetch(url, {
          method: "POST",
          body: new Uint8Array(encrypted),
          headers: { "Content-Type": "application/octet-stream" },
          signal,
        }),
        [200],
      ),
      signal,
    );
    signal.throwIfAborted();
    const response = result.ok
      ? result.value
      : result.error instanceof HttpStatusError
        ? result.error.response
        : undefined;
    const downloadParam = response?.headers.get("x-encrypted-param");
    if (response?.body) {
      await response.body.cancel();
      signal.throwIfAborted();
    }
    if (result.ok && downloadParam) {
      return downloadParam;
    }
    if (
      attempt === 2 ||
      (response &&
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429)
    ) {
      throw new WechatMediaUploadError(response?.status);
    }
  }
  throw new WechatMediaUploadError();
}
export async function sendWechatMedia(
  args: {
    baseUrl: string;
    token: string;
    senderId: string;
    contextToken: string;
    clientId: string;
    item: Item;
  },
  signal: AbortSignal,
) {
  return wechatSendReceiptSchema.parse(
    await wechatRequest(
      args.baseUrl,
      "/ilink/bot/sendmessage",
      {
        base_info: { channel_version: "2.4.10", bot_agent: "Okou" },
        msg: {
          from_user_id: "",
          to_user_id: args.senderId,
          client_id: args.clientId,
          message_type: 2,
          message_state: 2,
          context_token: args.contextToken,
          item_list: [args.item],
        },
      },
      args.token,
      signal,
    ),
  );
}
