import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { submitForReview } from "../../../ios/scripts/app-review.mjs";
import { verifyDistribution } from "../../../ios/scripts/distribution-availability.mjs";
import { appleClientFromEnvironment } from "../../../ios/scripts/testflight.mjs";
import {
  checkRequest,
  GitHub,
  latestRequest,
  nativeRun,
  readiness,
  requestKey,
  requestWorkflow,
} from "./ios-app-review-github.mjs";

const context = (request) =>
  `ios-app-review/${request.version}-${request.build}`;

export async function checkpoint(repo, request) {
  for await (const status of repo.pages(`commits/${request.commit}/statuses`)) {
    if (
      status.context !== context(request) ||
      status.creator?.login !== "github-actions[bot]"
    )
      continue;
    const match = /^(\d+\.\d+) (-|[a-zA-Z0-9-]+)$/u.exec(status.description);
    if (!match)
      throw new Error(
        "Unexpected App Review checkpoint; inspect commit statuses",
      );
    return {
      request: match[1],
      id: match[2] === "-" ? undefined : match[2],
      state: status.state,
      url: status.target_url,
    };
  }
}

export async function triggerEligible(repo, source) {
  if (nativeRun(source, repo.name, requestWorkflow, "workflow_dispatch"))
    return source.conclusion === "success";
  if (!nativeRun(source, repo.name, "release-please.yml", "push")) return false;
  for await (const job of repo.pages(
    `actions/runs/${source.id}/attempts/${source.run_attempt}/jobs`,
    "jobs",
  )) {
    if (
      job.name === "promote-api-production" &&
      job.head_sha === source.head_sha &&
      job.conclusion === "success"
    )
      return true;
  }
  return false;
}

export async function pendingRequest(repo, source, serving) {
  const target = (await repo.policy("main")).policy.reviewCandidate;
  if (!target) return { reason: "There is no active candidate on main" };
  if (!(await triggerEligible(repo, source)))
    return { reason: "No successful API promotion or manual review request" };
  const run = await latestRequest(repo, target);
  if (run?.status !== "completed" || run.conclusion !== "success")
    return { reason: "No completed current manual request for the candidate" };
  if (
    source.event === "workflow_dispatch" &&
    requestKey(source) !== requestKey(run)
  )
    return { reason: "This manual request does not own the active candidate" };
  const name = `ios-app-review-request-${run.run_attempt}`;
  const { artifacts } = await repo.api(
    `actions/runs/${run.id}/artifacts?name=${name}&per_page=100`,
  );
  if (
    !artifacts.some((artifact) => artifact.name === name && !artifact.expired)
  )
    return {
      reason: "Request record unavailable; dispatch the selected build again",
    };
  const request = checkRequest(repo.artifact(run, name, "request.json"), run);
  const previous = await checkpoint(repo, request);
  if (previous?.request === request.request)
    return {
      reason: `Request already attempted (${previous.state}): ${previous.url}`,
    };
  const reason = await readiness(repo, request, serving);
  return { request, previous, reason };
}

// Ordinary deployments can wake a request, but only another explicit manual
// request may retry an Apple write, including after a cancelled runner.
export async function processRequest(
  repo,
  request,
  previous,
  runUrl,
  apple,
  assertCurrent,
) {
  let submissionId = previous?.id;
  const record = (state) =>
    repo.api(`statuses/${request.commit}`, "POST", {
      state,
      context: context(request),
      description: `${request.request} ${submissionId ?? "-"}`,
      target_url: runUrl,
    });
  await assertCurrent();
  await record("pending");
  let result;
  try {
    result = await apple({
      knownSubmissionId: submissionId,
      assertCurrent,
      saveSubmission: async (id) => {
        submissionId = id;
        await record("pending");
      },
    });
    submissionId = result.id;
  } catch (error) {
    await record("error");
    throw error;
  }
  await record("success");
  return result;
}

async function main() {
  const repo = new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  const source = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  ).workflow_run;
  const summary = (line) => {
    console.log(line);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n");
  };
  const { request, previous, reason } = await pendingRequest(repo, source);
  if (reason) return summary(reason);
  if (process.argv[2] === "discover") {
    appendFileSync(process.env.GITHUB_OUTPUT, `request=${request.request}\n`);
    return summary(
      `Production protects iOS ${request.version} (${request.build}) from candidate PR #${request.pr}.`,
    );
  }
  if (
    process.argv[2] !== "submit" ||
    request.request !== process.env.EXPECTED_REQUEST
  )
    throw new Error("Manual request changed before submission");
  const assertCurrent = async () => {
    const latest = await latestRequest(repo, request);
    if (
      latest?.conclusion !== "success" ||
      latest.status !== "completed" ||
      requestKey(latest) !== request.request
    )
      throw new Error("Manual request changed before Apple write");
    const changed = await readiness(repo, request);
    if (changed) throw new Error(changed);
  };
  const runUrl = `${repo.url}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`;
  const client = appleClientFromEnvironment();
  const result = await processRequest(
    repo,
    request,
    previous,
    runUrl,
    async (hooks) => {
      const verified = await verifyDistribution(client, {
        channel: "testflight",
        requireAppStoreEligible: true,
        version: request.version,
        build: request.build,
        internalGroup: process.env.IOS_INTERNAL_GROUP_NAME,
        externalGroups: process.env.IOS_EXTERNAL_GROUP_NAMES,
      });
      if (verified.appleBuildId !== request.appleBuildId)
        throw new Error(
          "The Apple build differs from the protected TestFlight receipt",
        );
      return submitForReview(client, request, hooks);
    },
    assertCurrent,
  );
  const receipt = `**iOS ${request.version} (${request.build})** · Apple submission \`${result.id}\` · **${result.state}** · manual release. [App Store Connect](https://appstoreconnect.apple.com/apps/${request.appId}) · [Actions run](${runUrl})`;
  summary(receipt);
  await repo.api(`issues/${request.pr}/comments`, "POST", { body: receipt });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
