// The compatibility job has read-only GitHub access and no Apple credentials.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const channels = ["app-store", "testflight"];
const receiptName =
  /^iOS availability receipt (app-store|testflight) ((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}) ([1-9]\d{0,3}) ([a-f0-9]{40}) ([a-f0-9]{64}) (\d+)$/u;
const day = 24 * 60 * 60 * 1000;

export async function readAvailability(
  read,
  repository,
  configuredCountries,
  now = Date.now(),
) {
  const result = {};
  const { workflow_runs: runs } = await read(
    "actions/workflows/ios-distribution-availability.yml/runs?branch=main&event=workflow_dispatch&per_page=100",
  );
  for (const channel of channels) {
    // Never fall back past a newer unsuccessful check, withdrawal or pending rerun.
    const latest = runs.find(
      (run) =>
        run.head_branch === "main" &&
        run.event === "workflow_dispatch" &&
        run.head_repository?.full_name === repository &&
        run.display_title === `Verify iOS ${channel} availability`,
    );
    if (latest?.conclusion !== "success" || latest.status !== "completed")
      continue;
    try {
      const { jobs } = await read(
        `actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs?per_page=100`,
      );
      const job = jobs.find(
        (entry) =>
          entry.name === "verify" &&
          entry.head_sha === latest.head_sha &&
          entry.conclusion === "success",
      );
      for (const step of job?.steps ?? []) {
        const match = receiptName.exec(step.name);
        if (step.conclusion !== "success" || !match || match[1] !== channel)
          continue;
        const verified = Date.parse(step.completed_at);
        if (!(verified <= now && verified > now - day)) continue;
        const [, , version, build, commit, scope, expiry] = match;
        if (channel === "testflight" && Number(expiry) <= now) continue;
        if (channel === "app-store") {
          const countries = configuredCountries
            .split(",")
            .map((country) => country.trim().toUpperCase())
            .sort();
          if (
            countries.some((country) => !/^[A-Z]{2}$/u.test(country)) ||
            createHash("sha256").update(countries.join(",")).digest("hex") !==
              scope ||
            expiry !== "0"
          )
            continue;
        }
        result[channel] = { version, build, commit };
      }
    } catch (error) {
      console.error(
        `::warning::iOS ${channel} verification unavailable: ${error.message}`,
      );
    }
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let records = {};
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !process.env.GH_TOKEN)
      throw new Error("Missing GitHub repository or token");
    const read = async (path) => {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/${path}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GH_TOKEN}`,
            Accept: "application/vnd.github+json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok)
        throw new Error(`GitHub returned HTTP ${response.status}`);
      return response.json();
    };
    records = await readAvailability(
      read,
      repository,
      process.env.IOS_APP_STORE_STOREFRONTS ?? "",
    );
  } catch (error) {
    console.error(
      `::warning::iOS distribution verification unavailable: ${error.message}`,
    );
  }
  console.log(JSON.stringify(records));
}
