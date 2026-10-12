import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { signPresignedGetUrl$ } from "../external/s3";

/** Call after authorization. Download grants never reuse the preview cache. */
export const resolveArtifactDownloadUrl$ = command(
  async (
    { set },
    args: {
      readonly bucket: string;
      readonly key: string;
      readonly filename: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    signal.throwIfAborted();
    const url = await set(signPresignedGetUrl$, {
      ...args,
      publicEndpoint: true,
      signingDate: nowDate(),
      responseCacheControl: "private, no-store",
    });
    signal.throwIfAborted();
    return url;
  },
);
