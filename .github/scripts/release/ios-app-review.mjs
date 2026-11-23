// Run from the manual production workflow after the owner has tested this build.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  appId,
  checkBuild,
  publishedReleaseCommit,
  verifyDistribution,
} from "../../../ios/scripts/distribution-availability.mjs";
import { submitForReview } from "../../../ios/scripts/app-review.mjs";
import {
  appleClientFromEnvironment,
  required,
} from "../../../ios/scripts/testflight.mjs";

function github(path, data) {
  const args = ["api", `repos/${required("GITHUB_REPOSITORY")}/${path}`];
  if (data) args.push("--method", "POST", "--input", "-");
  return JSON.parse(
    execFileSync("gh", args, {
      encoding: "utf8",
      input: data && JSON.stringify(data),
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
}

// A newly created, empty Apple draft has no build relationship yet. Remember
// its ID on the immutable release commit before adding any review item.
export function draftReceipt(api, { version, build, commit }, runUrl) {
  const context = `ios-app-review-draft/${version}-${build}`;
  let knownSubmissionId;
  for (let page = 1; ; page++) {
    const statuses = api(
      `commits/${commit}/statuses?per_page=100&page=${page}`,
    );
    const saved = statuses.find(
      (status) =>
        status.context === context &&
        status.creator?.login === "github-actions[bot]",
    );
    if (saved) {
      if (
        saved.state !== "success" ||
        !/^[a-zA-Z0-9-]+$/u.test(saved.description ?? "")
      )
        throw new Error("Invalid Apple draft receipt on the release commit");
      knownSubmissionId = saved.description;
      break;
    }
    if (statuses.length < 100) break;
  }
  return {
    knownSubmissionId,
    saveSubmission(id) {
      if (id !== knownSubmissionId) {
        api(`statuses/${commit}`, {
          state: "success",
          context,
          description: id,
          target_url: runUrl,
        });
        knownSubmissionId = id;
      }
    },
  };
}

async function main() {
  const version = required("IOS_VERSION");
  const build = required("IOS_BUILD_NUMBER");
  checkBuild(version, build);
  const commit = publishedReleaseCommit(version, build);
  const client = appleClientFromEnvironment();
  const { appleBuildId } = await verifyDistribution(client, {
    channel: "testflight",
    version,
    build,
    requireAppStoreEligible: true,
    internalGroup: required("IOS_INTERNAL_GROUP_NAME"),
    externalGroups: process.env.IOS_EXTERNAL_GROUP_NAMES,
  });
  const runUrl = `https://github.com/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}/attempts/${required("GITHUB_RUN_ATTEMPT")}`;
  const receipt = draftReceipt(github, { version, build, commit }, runUrl);
  const result = await submitForReview(
    client,
    { version, appId, appleBuildId },
    receipt,
  );
  const summary = `**iOS ${version} (${build})** · Apple build \`${appleBuildId}\` · submission \`${result.id}\` · **${result.state}** · manual release. [App Store Connect](https://appstoreconnect.apple.com/apps/${appId})\n`;
  console.log(summary);
  appendFileSync(required("GITHUB_STEP_SUMMARY"), summary);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
