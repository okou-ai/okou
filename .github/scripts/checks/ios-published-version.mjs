#!/usr/bin/env node
// Read-only TestFlight publication oracle. Requires GH_TOKEN and GITHUB_REPOSITORY;
// GITHUB_API_URL defaults to GitHub. Prints one available x.y.z version, or an
// empty stdout with a warning when unavailable. No Apple credentials are used.
import { pathToFileURL } from "node:url";

const availabilityStep = "Wait for processing and verify internal availability";
const testFlightLifetimeMs = 90 * 24 * 60 * 60 * 1000;

export async function publishedIosVersion({
  repository,
  token,
  apiUrl = "https://api.github.com",
  now = Date.now(),
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
  const refs = await read("git/matching-refs/tags/ios-v");
  const versions = (refs ?? [])
    .flatMap((ref) => {
      const match = /^refs\/tags\/ios-v(\d+\.\d+\.\d+)$/u.exec(ref.ref);
      if (!match || ref.object.type !== "commit") return [];
      const parts = match[1].split(".").map(Number);
      if (!parts.every(Number.isSafeInteger)) return [];
      return [{ version: match[1], parts, sha: ref.object.sha }];
    })
    .sort(
      (a, b) =>
        b.parts[0] - a.parts[0] ||
        b.parts[1] - a.parts[1] ||
        b.parts[2] - a.parts[2],
    );

  // Bound work even when the repository has years of release tags.
  for (const { version, sha } of versions.slice(0, 20)) {
    if (!/^[a-f0-9]{40}$/u.test(sha)) continue;
    const release = await read(`releases/tags/ios-v${version}`);
    if (
      !release ||
      release.tag_name !== `ios-v${version}` ||
      release.draft !== false ||
      release.prerelease !== false
    )
      continue;
    const source = await read(`contents/ios/Config/Shared.xcconfig?ref=${sha}`);
    if (!source || source.encoding !== "base64") continue;
    const config = Buffer.from(source.content, "base64").toString("utf8");
    // Bind the version to the publisher's exact source, not just a movable tag.
    const marketing =
      /^MARKETING_VERSION\s*=\s*(\d+\.\d+\.\d+)[\t ]*(?:\/\/[^\n]*)?$/mu.exec(
        config,
      )?.[1];
    if (marketing !== version) continue;
    const runs = await read(
      `actions/workflows/release-please.yml/runs?head_sha=${sha}&event=push&per_page=5`,
    );
    for (const run of runs?.workflow_runs ?? []) {
      if (
        run.head_sha !== sha ||
        run.head_branch !== "main" ||
        run.event !== "push"
      )
        continue;
      const jobs = await read(
        `actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      );
      const publisher = jobs?.jobs.find(
        (job) => job.name === "publish-ios-testflight",
      );
      const verified = publisher?.steps.find(
        (step) => step.name === availabilityStep,
      );
      const verifiedAt = Date.parse(verified?.completed_at ?? "");
      if (
        publisher?.conclusion === "success" &&
        verified?.conclusion === "success" &&
        verifiedAt <= now &&
        verifiedAt > now - testFlightLifetimeMs
      )
        return version;
    }
  }
  return undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const version = await publishedIosVersion({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    });
    if (version) console.log(version);
    else
      console.error(
        "::warning::No unexpired, internally available iOS TestFlight release could be verified.",
      );
  } catch (error) {
    console.error(
      `::warning::Published iOS version unavailable: ${error.message}`,
    );
  }
}
