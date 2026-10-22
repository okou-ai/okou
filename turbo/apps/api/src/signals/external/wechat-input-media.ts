import { fileTypeFromBuffer } from "file-type/core";
import { inferMimetype } from "../../lib/mimetype";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";
import { downloadWechatMedia, WechatMediaDownloadError } from "./wechat-media";
import { settle } from "../utils";

/** Tencent image items have no filename or MIME type; inspect decrypted bytes. */
export async function downloadWechatInputMedia(
  item: NonNullable<WechatMessage["item_list"]>[number],
  signal: AbortSignal,
): Promise<Response> {
  const bytes = await downloadWechatMedia(item, signal);
  signal.throwIfAborted();
  let contentType = inferMimetype(item.file_item?.file_name ?? "");
  if (item.type === 2) {
    const detected = await settle(fileTypeFromBuffer(bytes), signal);
    signal.throwIfAborted();
    if (!detected.ok || !detected.value?.mime.startsWith("image/")) {
      throw new WechatMediaDownloadError(
        "invalid-media",
        "WeChat image format is not supported",
      );
    }
    contentType = detected.value.mime;
  } else if (item.type === 5) {
    contentType = "video/mp4";
  }
  return new Response(bytes, {
    headers: { "Content-Type": contentType },
  });
}
