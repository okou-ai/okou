import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  appId,
  checkBuild,
} from "../../../ios/scripts/distribution-availability.mjs";
import { readAvailability } from "../checks/read-ios-availability.mjs";
import {
  candidateIdentity,
  GitHub,
  isSha,
  latestRequest,
  nativeRun,
  policyPath,
  proofWorkflow,
  qaAttestation,
  registration,
  requestKey,
  sameCandidate,
} from "./ios-app-review-github.mjs";

const prefix = "automation/ios-app-review/";
export function checkedProof(receipt, expected, latest, now = Date.now()) {
  if (
    receipt.channel !== "testflight" ||
    receipt.platform !== "IOS" ||
    receipt.appId !== appId ||
    receipt.version !== expected.version ||
    receipt.build !== expected.build ||
    !isSha(receipt.commit) ||
    typeof receipt.appleBuildId !== "string" ||
    !/^[a-zA-Z0-9-]+$/u.test(receipt.appleBuildId) ||
    !sameCandidate(receipt, latest) ||
    !(Date.parse(receipt.expiresAt) > now) ||
    !(
      Date.parse(receipt.verifiedAt) <= now &&
      Date.parse(receipt.verifiedAt) > now - 86400000
    )
  )
    throw new Error(
      "The exact build has no current, matching protected TestFlight proof",
    );
  return {
    ...candidateIdentity(receipt),
    appId,
    appleBuildId: receipt.appleBuildId,
  };
}

export async function verify(repo, version, build) {
  const dispatch = await repo.api(
    `actions/workflows/${proofWorkflow}/dispatches`,
    "POST",
    {
      ref: "main",
      inputs: { channel: "testflight", version, build },
      return_run_details: true,
    },
  );
  const runId = dispatch?.workflow_run_id;
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error(
      "GitHub did not identify the dispatched TestFlight verification; inspect Actions before retrying",
    );
  const output = `${repo.url}/actions/runs/${runId}`;
  console.log(`Verifying TestFlight: ${output}`);
  let run;
  do {
    run = await repo.api(`actions/runs/${runId}`);
    if (
      !nativeRun(run, repo.name, proofWorkflow, "workflow_dispatch") ||
      run.display_title !== "Verify iOS testflight availability"
    )
      throw new Error("Unexpected proof workflow identity");
    if (run.status !== "completed") await sleep(12000);
  } while (run.status !== "completed");
  if (run.conclusion !== "success")
    throw new Error(`TestFlight verification ${run.conclusion}: ${output}`);
  const receipt = repo.artifact(
    run,
    `ios-availability-testflight-${run.run_attempt}`,
    "availability.json",
  );
  const available = await readAvailability(
    (path) => repo.api(path),
    repo.name,
    "",
  );
  return {
    ...checkedProof(receipt, { version, build }, available.testflight),
    proof: `${output}/attempts/${run.run_attempt}`,
  };
}

// A resumed automation branch may have been edited since the initial dispatch.
async function checkCandidateChange(repo, main, head, target) {
  const diff = await repo.api(`compare/${main}...${head}?per_page=1`);
  const { policy: base } = await repo.policy(diff.merge_base_commit.sha);
  const { policy: proposed } = await repo.policy(head);
  if (
    diff.files?.length !== 1 ||
    diff.files[0].filename !== policyPath ||
    !isDeepStrictEqual(proposed, {
      ...base,
      reviewCandidate: candidateIdentity(target),
    })
  ) {
    throw new Error(
      "The candidate PR contains other changes or a different build; inspect its branch",
    );
  }
}

export async function register(repo, target, run) {
  const main = (await repo.api("git/ref/heads/main")).object.sha;
  const { policy } = await repo.policy(main);
  const current = policy.reviewCandidate;
  if (current && !sameCandidate(current, target))
    throw new Error(
      `iOS ${current.version} (${current.build}) is already protected. Resolve that review before replacing its candidate.`,
    );
  const open = [];
  for await (const pr of repo.pages("pulls?state=open&base=main")) {
    if (pr.head.repo?.full_name === repo.name && pr.head.ref.startsWith(prefix))
      open.push(pr);
  }
  for (const pr of open) {
    if (
      !sameCandidate(
        (await repo.policy(pr.head.sha)).policy.reviewCandidate,
        target,
      )
    )
      throw new Error(
        `Resolve the different open candidate PR #${pr.number} before continuing`,
      );
  }
  if (open.length > 1)
    throw new Error("Resolve duplicate open candidate PRs before continuing");
  const runLink = `${repo.url}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  const evidence = `Manual request: ${runLink}\n\nTestFlight proof: ${target.proof}\n\nApple build ID: \`${target.appleBuildId}\`. iOS release commit: \`${target.commit}\`.`;
  const existing = current ? await registration(repo, main, target) : open[0];
  if (!current && existing)
    await checkCandidateChange(repo, main, existing.head.sha, target);
  if (existing) {
    await repo.api(`issues/${existing.number}/comments`, "POST", {
      body: `App Review requested for **iOS ${target.version} (${target.build})**.\n\n${evidence}`,
    });
    return existing.number;
  }

  const branch = `${prefix}${target.version}-${target.build}-${run.id}`;
  let tip;
  try {
    tip = (await repo.api(`git/ref/heads/${branch}`)).object.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
    await repo.api("git/refs", "POST", {
      ref: `refs/heads/${branch}`,
      sha: main,
    });
    tip = main;
  }
  const base = await repo.policy(tip);
  if (!sameCandidate(base.policy.reviewCandidate, target)) {
    if (tip !== main || base.policy.reviewCandidate != null)
      throw new Error(
        "Candidate branch changed; inspect it or dispatch a fresh request",
      );
    const updated = {
      ...base.policy,
      reviewCandidate: candidateIdentity(target),
    };
    await repo.api(`contents/${policyPath}`, "PUT", {
      branch,
      sha: base.sha,
      message: `fix(api): protect ios ${target.version} (${target.build}) during app review`,
      content: Buffer.from(JSON.stringify(updated, null, 2) + "\n").toString(
        "base64",
      ),
    });
  } else {
    await checkCandidateChange(repo, main, tip, target);
  }
  const pr = await repo.api("pulls", "POST", {
    head: branch,
    base: "main",
    title: `fix(api): protect ios ${target.version} (${target.build}) during app review`,
    body: `Register the exact review candidate and deploy its compatibility protection through the normal API release.\n\n${evidence}\n\nCheck this item after exercising the selected TestFlight build against production.\n\n- [ ] ${qaAttestation}\n\nAfter merge and production deployment, the manual request can submit this build for Apple review with manual release.`,
  });
  return pr.number;
}

async function main() {
  const repo = new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  const run = {
    id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  const {
    IOS_VERSION: version,
    IOS_BUILD_NUMBER: build,
    RUNNER_TEMP: temp,
  } = process.env;
  checkBuild(version, build);
  if (requestKey((await latestRequest(repo)) ?? {}) !== requestKey(run))
    throw new Error("A newer manual request superseded this one");
  const path = join(temp, "ios-app-review-proof.json");
  if (process.argv[2] === "verify") {
    writeFileSync(path, JSON.stringify(await verify(repo, version, build)));
  } else if (process.argv[2] === "register") {
    const target = JSON.parse(readFileSync(path, "utf8"));
    const writer = new GitHub(repo.name, process.env.PR_TOKEN);
    const pr = await register(writer, target, run);
    writeFileSync(
      join(temp, "request.json"),
      JSON.stringify({ ...target, request: requestKey(run), pr }) + "\n",
    );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Selected **iOS ${version} (${build})**. [TestFlight proof](${target.proof}) · [Candidate PR #${pr}](${repo.url}/pull/${pr}). Complete production QA and merge through the normal queue.\n`,
    );
  } else throw new Error("Expected verify or register");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
