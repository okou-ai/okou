import {
  androidReleaseManifestSchema,
  type AndroidRelease,
} from "@okouai/api-contracts/contracts/android-updates";
import { command } from "ccstate";
import { env } from "../../lib/env";
import {
  downloadS3BufferWithMaxBytes$,
  isS3NotFoundError,
} from "../external/s3";
import { safeJsonParse, settleIncludingAbort } from "../utils";

const MANIFEST_KEY = "android-updates/manifest.json";

export class AndroidUpdateUnavailable extends Error {
  constructor() {
    super("Android release information is temporarily unavailable");
  }
}

function isStorageUnavailable(error: unknown): boolean {
  if (error instanceof TypeError || error instanceof DOMException) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (
    isS3NotFoundError(error) ||
    error.name === "TimeoutError" ||
    error.name === "NetworkingError"
  ) {
    return true;
  }
  if (
    "code" in error &&
    typeof error.code === "string" &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
    ].includes(error.code)
  ) {
    return true;
  }
  if (
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    typeof error.$metadata.httpStatusCode === "number"
  ) {
    const status = error.$metadata.httpStatusCode;
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }
  return false;
}

/** Resolve the publisher's current pointer without a public delivery cache. */
export const loadAndroidRelease$ = command(
  async ({ set }, signal: AbortSignal): Promise<AndroidRelease> => {
    const bucket = env("R2_STATIC_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Android release storage is not configured");
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    // S3 reports AbortError for an owned timeout too. Preserve caller aborts,
    // while the five-second storage deadline remains a retryable check failure.
    const loaded = await settleIncludingAbort(
      set(
        downloadS3BufferWithMaxBytes$,
        { bucket, key: MANIFEST_KEY, maxBytes: 65_536 },
        deadline,
      ),
    );
    signal.throwIfAborted();
    if (!loaded.ok) {
      if (deadline.aborted || isStorageUnavailable(loaded.error)) {
        throw new AndroidUpdateUnavailable();
      }
      throw loaded.error;
    }
    const { release } = androidReleaseManifestSchema.parse(
      safeJsonParse(loaded.value.toString("utf8")),
    );
    if (
      release.url !==
      `https://static.okou.io/android-updates/releases/${release.version}/${release.sha256}.apk`
    ) {
      throw new Error("Android release identity is inconsistent");
    }
    return release;
  },
);
