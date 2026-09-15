import { randomBytes } from "node:crypto";
import { command } from "ccstate";
import {
  PRIVATE_VIDEO_POSTER_MAX_BYTES,
  PRIVATE_VIDEO_POSTER_PATH,
  privateVideoPosterGrantKey,
  privateVideoPosterGrantSchema,
} from "@okouai/api-contracts/contracts/artifact-video-preview";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { deleteS3Objects, putS3Object } from "../external/s3";
import { onRejection } from "../utils";
import { uploadedArtifactObject } from "./uploaded-artifact.service";

/** Keep both source bytes and the extraction result out of public URL caches. */
export const extractPrivateVideoPoster$ = command(
  async (
    { get },
    args: {
      readonly id: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<Buffer | null> => {
    const video = await get(uploadedArtifactObject(args));
    signal.throwIfAborted();
    if (
      !video?.isPrivate ||
      video.contentType !== "video/mp4" ||
      video.size >= PRIVATE_VIDEO_POSTER_MAX_BYTES
    ) {
      return null;
    }
    const token = randomBytes(24).toString("hex");
    const key = privateVideoPosterGrantKey(token);
    const grant = privateVideoPosterGrantSchema.parse({
      version: 1,
      sourceKey: video.key,
      expiresAt: new Date(nowDate().getTime() + 5 * 60_000).toISOString(),
    });
    const hostDomain =
      video.publicBrand === "okou"
        ? env("OKOU_PUBLIC_HOST_DOMAIN")
        : env("ZERO_HOST_DOMAIN");
    const scheme =
      video.publicBrand === "okou"
        ? env("OKOU_HOST_SCHEME")
        : env("ZERO_HOST_SCHEME");
    // One cleanup operation is shared by success and rejection, including
    // cancellation. An interrupted cleanup leaves an inert grant after its TTL.
    const cleanup = deleteS3Objects(video.bucket, [key]);
    const render = async () => {
      await get(
        putS3Object(
          video.bucket,
          key,
          JSON.stringify(grant),
          "application/json",
          signal,
        ),
      );
      signal.throwIfAborted();
      const response = await fetch(
        `${scheme}://files.${hostDomain}${PRIVATE_VIDEO_POSTER_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            // The hosted-domain WAF admits first-party App requests. The
            // private capability above independently authorizes the bytes.
            Referer: new URL("/", env("APP_URL")).href,
          },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
      );
      if (
        !response.ok ||
        response.headers.get("Content-Type") !== "image/jpeg"
      ) {
        // Provider response bodies can contain credentials. Log only status.
        throw new Error(
          `Private video frame extraction failed (${response.status})`,
        );
      }
      const image = Buffer.from(await response.arrayBuffer());
      signal.throwIfAborted();
      await get(cleanup);
      signal.throwIfAborted();
      return image;
    };
    return await onRejection(render(), () => {
      return get(cleanup);
    });
  },
);
