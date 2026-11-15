import {
  androidReleaseManifestSchema,
  type AndroidRelease,
} from "@okouai/api-contracts/contracts/android-updates";
import {
  readBoundedResponseText,
  safeJsonParse,
  settle,
  startUntrackedBestEffortCleanup,
} from "../utils";

const MANIFEST_URL = "https://static.okou.io/android-updates/manifest.json";

export class AndroidUpdateUnavailable extends Error {
  constructor() {
    super("Android release information is temporarily unavailable");
  }
}

async function readManifest(signal: AbortSignal): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  const response = await fetch(MANIFEST_URL, {
    signal: deadline,
    redirect: "error",
  });
  if (!response.ok) {
    if (response.body) startUntrackedBestEffortCleanup(response.body.cancel());
    throw new AndroidUpdateUnavailable();
  }
  const body = await readBoundedResponseText(response, 65_536, deadline);
  if (body.kind !== "text")
    throw new Error("Android release manifest exceeds its limit");
  return body.text;
}

/** Public release bytes have no dependency on session credentials or GitHub API limits. */
export async function loadAndroidRelease(
  signal: AbortSignal,
): Promise<AndroidRelease> {
  const loaded = await settle(readManifest(signal), signal);
  if (!loaded.ok) {
    if (
      loaded.error instanceof TypeError ||
      loaded.error instanceof DOMException
    )
      throw new AndroidUpdateUnavailable();
    throw loaded.error;
  }
  const { release } = androidReleaseManifestSchema.parse(
    safeJsonParse(loaded.value),
  );
  const [major, minor, patch] = release.version.split(".").map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    minor >= 1_000 ||
    patch >= 1_000 ||
    major * 1_000_000 + minor * 1_000 + patch !== release.versionCode ||
    release.url !==
      `https://static.okou.io/android-updates/releases/${release.version}/${release.sha256}.apk`
  )
    throw new Error("Android release identity is inconsistent");
  return release;
}
