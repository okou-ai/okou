import { settleIncludingAbort } from "../utils";
import { z } from "zod";
import type { IntroVideoRenderRequest } from "@okouai/api-contracts/contracts/intro-video-render";

const RENDERS_URL = "https://api.heygen.com/v3/hyperframes/renders";
const detailSchema = z.object({
  render_id: z.string().optional(),
  callback_id: z.string().nullable().optional(),
  status: z.enum(["queued", "rendering", "completed", "failed"]),
  video_url: z.url().nullable().optional(),
  duration: z.number().positive().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  fps: z.number().positive().nullable().optional(),
  failure_message: z.string().nullable().optional(),
});
export type HeyGenHyperframesDetail = z.infer<typeof detailSchema>;

export class HeyGenHyperframesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HeyGenHyperframesError";
  }
}

function sanitizeHyperframesError(message: string, apiKey: string): string {
  return message
    .replaceAll(apiKey, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[provider URL]")
    .slice(0, 500);
}

async function readResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  apiKey: string,
): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(body);
    throw new HeyGenHyperframesError(
      response.status,
      error.success
        ? sanitizeHyperframesError(error.data.error.code, apiKey)
        : "HEYGEN_RENDER_REQUEST_FAILED",
      error.success
        ? sanitizeHyperframesError(error.data.error.message, apiKey)
        : `HeyGen render request returned HTTP ${response.status}`,
    );
  }
  return z.object({ data: schema }).parse(body).data;
}

export function hyperframesPayload(
  input: IntroVideoRenderRequest,
  projectUrl: string,
  callbackUrl: string,
) {
  return {
    project: { type: "url" as const, url: projectUrl },
    composition: input.composition,
    fps: input.output.fps,
    quality: input.output.quality,
    format: input.output.format,
    resolution: input.output.resolution,
    aspect_ratio: input.output.aspectRatio,
    ...(input.title ? { title: input.title } : {}),
    callback_id: input.requestId,
    callback_url: callbackUrl,
  };
}
type HyperframesPayload = ReturnType<typeof hyperframesPayload>;

export async function submitHyperframesRender(
  payload: HyperframesPayload,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(RENDERS_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      "Idempotency-Key": `okou:hf:${payload.callback_id}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  return (
    await readResponse(
      response,
      z.object({ render_id: z.string().min(1) }),
      apiKey,
    )
  ).render_id;
}

export async function getHyperframesRender(
  renderId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenHyperframesDetail> {
  const response = await fetch(
    `${RENDERS_URL}/${encodeURIComponent(renderId)}`,
    {
      headers: { "x-api-key": apiKey },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    },
  );
  const detail = await readResponse(response, detailSchema, apiKey);
  if (detail.render_id && detail.render_id !== renderId) {
    throw new Error("HeyGen returned a different render identity");
  }
  return {
    ...detail,
    ...(detail.failure_message
      ? {
          failure_message: sanitizeHyperframesError(
            detail.failure_message,
            apiKey,
          ),
        }
      : {}),
  };
}

export async function downloadHyperframesVideo(
  sourceUrl: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const url = new URL(sourceUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
    /\.(local|internal|localhost)$/i.test(url.hostname)
  ) {
    throw new Error("HeyGen returned an invalid video address");
  }
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok || !response.body) {
    throw new Error("Cloud video download is temporarily unavailable");
  }
  const limit = 512 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    throw new Error("Cloud video exceeds the output size limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const downloaded = await settleIncludingAbort(
    (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        size += chunk.value.byteLength;
        if (size > limit) {
          throw new Error("Cloud video exceeds the output size limit");
        }
        chunks.push(chunk.value);
      }
    })(),
  );
  await reader.cancel();
  if (!downloaded.ok) {
    throw downloaded.error;
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") {
    throw new Error("HeyGen returned an invalid MP4");
  }
  return bytes;
}
