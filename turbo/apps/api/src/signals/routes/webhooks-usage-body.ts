import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";

import { badRequest, badRequestMessage } from "../../lib/error";
import { safeJsonParse } from "../utils";

const MAX_USAGE_BODY_BYTES = 256 * 1024;

/** Count received bytes even when Content-Length is absent or inaccurate. */
export async function readUsageEventBody(
  request: Request,
  signal: AbortSignal,
) {
  const tooLarge = {
    ok: false as const,
    response: {
      status: 413 as const,
      body: {
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Usage payload exceeds 256 KiB",
        },
      },
    },
  };
  if (Number(request.headers.get("content-length")) > MAX_USAGE_BODY_BYTES) {
    return tooLarge;
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    const read = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) {
          return true;
        }
        size += value.byteLength;
        if (size > MAX_USAGE_BODY_BYTES) {
          await reader.cancel();
          return false;
        }
        chunks.push(value);
      }
    };
    const withinLimit = await read().finally(() => {
      reader.releaseLock();
    });
    if (!withinLimit) {
      return tooLarge;
    }
  }
  const parsed = safeJsonParse(Buffer.concat(chunks, size).toString("utf8"));
  if (parsed === undefined) {
    return {
      ok: false as const,
      response: badRequestMessage("Invalid JSON in request body"),
    };
  }
  const result = webhookUsageEventContract.send.body.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false as const,
      response: badRequest(result.error.issues[0]!),
    };
  }
  return { ok: true as const, data: result.data };
}
