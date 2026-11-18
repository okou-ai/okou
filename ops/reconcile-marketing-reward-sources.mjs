// Run from the repository root with Node 22. EXPECTED_API_SHA is the reviewed
// deployed revision; CRON_SECRET is supplied only to this operation. No packages
// are required. Writes aggregate reward-source-report.json; exits 0 only after
// both queues converge, otherwise 1. Uncertain requests are never replayed.
import { writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

const report = { startedAt: new Date().toISOString(), verified: false, batches: [] };
const reportPath = "reward-source-report.json";

async function run() {
  const expected = process.env.EXPECTED_API_SHA;
  const secret = process.env.CRON_SECRET;
  if (!/^[0-9a-f]{40}$/.test(expected ?? "") || !secret) {
    throw new Error("A reviewed API revision and cron credential are required");
  }
  const build = await fetch("https://api.okou.ai/api/build-info", {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!build.ok || (await build.json()).commitSha !== expected) {
    throw new Error("The deployed API is not the reviewed source-only revision");
  }
  report.apiCommit = expected;
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline && report.batches.length < 150) {
    // Stop on any uncertain response. A subsequent run reclaims durable leases.
    const response = await fetch(
      "https://api.okou.ai/api/cron/process-background-jobs?marketingRewardsOnly=true&maxRewardEvents=25",
      {
        redirect: "error",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) throw new Error("The source preparation request failed");
    const result = await response.json();
    const keys = ["processed", "sourcePending", "unobservedInvitations"];
    if (keys.some((key) => !Number.isSafeInteger(result[key]) || result[key] < 0)) {
      throw new Error("The source preparation response is incomplete");
    }
    const aggregate = Object.fromEntries(keys.map((key) => [key, result[key]]));
    report.batches.push({ observedAt: new Date().toISOString(), ...aggregate });
    console.log(JSON.stringify(aggregate));
    report.verified = result.sourcePending === 0 && result.unobservedInvitations === 0;
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    if (report.verified) return;
    if (result.processed === 0) await wait(15_000);
  }
  throw new Error("Source preparation did not converge within its work budget");
}

try {
  await run();
} catch {
  report.failed = true;
  console.error("Source preparation stopped; inspect the retained aggregate report.");
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
