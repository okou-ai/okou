import {
  PRIVATE_VIDEO_POSTER_MAX_BYTES,
  privateVideoPosterGrantKey,
  privateVideoPosterGrantSchema,
} from "@okouai/api-contracts/contracts/artifact-video-preview";

export interface MediaBinding {
  input(body: ReadableStream): {
    transform(options: { width: number }): {
      output(options: { mode: "frame"; time: "1s"; format: "jpg" }): {
        response(): Promise<Response>;
      };
    };
  };
}

interface PrivateVideoBucket {
  get(key: string): Promise<{
    readonly size: number;
    readonly body: ReadableStream;
    writeHttpMetadata(headers: Headers): void;
  } | null>;
}

/** Only the API-issued grant can authorize input; never accept a caller URL. */
export async function servePrivateVideoPoster(
  request: Request,
  bucket: PrivateVideoBucket | undefined,
  media: MediaBinding | undefined,
): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  if (request.method !== "POST") {
    headers.set("Allow", "POST");
    return new Response("Method not allowed", { status: 405, headers });
  }
  const denied = () => {
    return new Response("Not found", { status: 404, headers });
  };
  const token = /^Bearer ([a-f0-9]{48})$/u.exec(
    request.headers.get("Authorization") ?? "",
  )?.[1];
  if (!token) return denied();
  if (!bucket) throw new Error("Private video storage is missing");
  const object = await bucket.get(privateVideoPosterGrantKey(token));
  if (!object) return denied();
  const grant = privateVideoPosterGrantSchema.safeParse(
    await new Response(object.body).json(),
  );
  if (!grant.success || Date.parse(grant.data.expiresAt) <= Date.now()) {
    return denied();
  }
  const video = await bucket.get(grant.data.sourceKey);
  if (!video) return denied();
  const metadata = new Headers();
  video.writeHttpMetadata(metadata);
  if (
    metadata.get("Content-Type") !== "video/mp4" ||
    video.size >= PRIVATE_VIDEO_POSTER_MAX_BYTES
  ) {
    return new Response("Unsupported video", { status: 415, headers });
  }
  if (!media) throw new Error("Private video Media binding is missing");
  const frame = await media
    .input(video.body)
    .transform({ width: 640 })
    .output({ mode: "frame", time: "1s", format: "jpg" })
    .response();
  if (!frame.ok || frame.headers.get("Content-Type") !== "image/jpeg") {
    throw new Error("Private video frame extraction failed");
  }
  if (Date.parse(grant.data.expiresAt) <= Date.now()) return denied();
  headers.set("Content-Type", "image/jpeg");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(frame.body, { headers });
}
