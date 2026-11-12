#!/usr/bin/env node
// Read-only GitHub Release publication check. Requires GH_TOKEN and
// GITHUB_REPOSITORY; GITHUB_API_URL defaults to GitHub. Prints the highest
// stable android-vX.Y.Z release with an uploaded APK, or warns on stderr.
import { pathToFileURL } from "node:url";

export async function publishedAndroidVersion({
  repository,
  token,
  apiUrl = "https://api.github.com",
}) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !token) {
    throw new Error("GH_TOKEN and a valid GITHUB_REPOSITORY are required");
  }
  const origin = new URL(apiUrl);
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && origin.hostname === "127.0.0.1")
  ) {
    throw new Error("GitHub API must use HTTPS");
  }
  const read = async (path) => {
    const response = await fetch(`${apiUrl}/repos/${repository}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw new Error(
        `GitHub publication evidence returned HTTP ${response.status}`,
      );
    return response.json();
  };
  const refs = await read("git/matching-refs/tags/android-v");
  const versions = (refs ?? [])
    .flatMap((ref) => {
      const match = /^refs\/tags\/android-v(\d+\.\d+\.\d+)$/u.exec(ref.ref);
      if (!match) return [];
      const parts = match[1].split(".").map(Number);
      if (!parts.every(Number.isSafeInteger)) return [];
      return [{ version: match[1], parts }];
    })
    .sort(
      (a, b) =>
        b.parts[0] - a.parts[0] ||
        b.parts[1] - a.parts[1] ||
        b.parts[2] - a.parts[2],
    );

  // Match the native publication checks' bounded candidate search.
  for (const { version } of versions.slice(0, 20)) {
    const release = await read(`releases/tags/android-v${version}`);
    if (
      release?.tag_name === `android-v${version}` &&
      release.draft === false &&
      release.prerelease === false &&
      release.assets.some(
        (asset) =>
          /\.apk$/iu.test(asset.name) &&
          asset.state === "uploaded" &&
          asset.size > 0,
      )
    )
      return version;
  }
  return undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const version = await publishedAndroidVersion({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    if (version) console.log(version);
    else
      console.error(
        "::warning::No published Android GitHub Release with an uploaded APK could be verified.",
      );
  } catch (error) {
    console.error(
      `::warning::Published Android version unavailable: ${error.message}`,
    );
  }
}
