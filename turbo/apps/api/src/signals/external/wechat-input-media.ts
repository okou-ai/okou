import sharp from "sharp";
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
    const metadata = await settle(sharp(bytes).metadata(), signal);
    signal.throwIfAborted();
    if (!metadata.ok) {
      throw new WechatMediaDownloadError(
        "invalid-media",
        "WeChat image format is not supported",
      );
    }
    contentType = inferMimetype(`image.${metadata.value.format}`);
  } else if (item.type === 5) {
    contentType = "video/mp4";
  }
  return new Response(bytes, {
    headers: { "Content-Type": contentType },
  });
}
