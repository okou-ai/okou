#!/usr/bin/env node
// Read-only publication check through the same public discovery used by Android.
// ANDROID_UPDATES_URL defaults to the production API. Prints its available
// stable release version, or leaves stdout empty and warns on stderr.
import { pathToFileURL } from "node:url";

export async function publishedAndroidVersion({
  updatesUrl = "https://api.okou.ai/api/android/updates",
} = {}) {
  const origin = new URL(updatesUrl);
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")
  ) {
    throw new Error("Android update discovery must use HTTPS");
  }
  const response = await fetch(updatesUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
    cache: "no-store",
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    if (response.status === 404 || response.status === 503) return undefined;
    throw new Error(
      `Android update discovery returned HTTP ${response.status}`,
    );
  }
  if (response.body === null)
    throw new Error("Android update discovery is empty");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 65_536)
      throw new Error("Android update discovery exceeds its limit");
    chunks.push(chunk);
  }
  // A successful canonical response validates the R2 manifest and its release identity.
  const { release } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const version = release?.version;
  if (
    typeof version !== "string" ||
    version.length > 64 ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?![\s\S])/u.test(version)
  )
    throw new Error("Android update discovery has no stable release version");
  return version;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const version = await publishedAndroidVersion({
      updatesUrl: process.env.ANDROID_UPDATES_URL,
    });
    if (version) console.log(version);
    else
      console.error(
        "::warning::No Android release is available through public update discovery.",
      );
  } catch (error) {
    console.error(
      `::warning::Published Android version unavailable: ${error.message.replaceAll("\r", " ").replaceAll("\n", " ")}`,
    );
  }
}
