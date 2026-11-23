// Only protected main workflows produce the proof and manual request artifacts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appId,
  checkBuild,
} from "../../../ios/scripts/distribution-availability.mjs";

export const policyPath =
  "turbo/apps/api/src/lib/ios-client-compatibility.json";
export const requestWorkflow = "ios-app-review.yml";
export const proofWorkflow = "ios-distribution-availability.yml";
export const qaAttestation =
  "I verified production sign-in, sending a message and viewing the result on this exact iOS build.";
export const isSha = (value) => /^[0-9a-f]{40}$/u.test(value);
export const sameCandidate = (a, b) =>
  Boolean(
    a &&
    b &&
    a.version === b.version &&
    a.build === b.build &&
    a.commit === b.commit,
  );
export const candidateIdentity = ({ version, build, commit }) => ({
  version,
  build,
  commit,
});
export class GitHub {
  constructor(name, token) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(name) || !token)
      throw new Error("GitHub repository and token are required");
    this.name = name;
    this.token = token;
    this.url = `https://github.com/${name}`;
  }
  async api(path, method = "GET", data) {
    const response = await fetch(
      `https://api.github.com/repos/${this.name}/${path}`,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      },
    );
    if (!response.ok)
      throw Object.assign(
        new Error(`GitHub ${method} ${path}: HTTP ${response.status}`),
        { status: response.status },
      );
    return response.status === 204 ? undefined : response.json();
  }
  async *pages(path, key) {
    for (let page = 1; ; page++) {
      const data = await this.api(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const entries = key ? data[key] : data;
      yield* entries;
      if (entries.length < 100) return;
    }
  }
  async policy(ref) {
    const blob = await this.api(
      `contents/${policyPath}?ref=${encodeURIComponent(ref)}`,
    );
    return {
      sha: blob.sha,
      policy: JSON.parse(Buffer.from(blob.content, "base64").toString("utf8")),
    };
  }
  artifact(run, name, file) {
    const dir = mkdtempSync(join(tmpdir(), "ios-app-review-"));
    try {
      execFileSync(
        "gh",
        [
          "run",
          "download",
          String(run.id),
          "-R",
          this.name,
          "--name",
          name,
          "--dir",
          dir,
        ],
        {
          stdio: ["ignore", "ignore", "inherit"],
          env: { ...process.env, GH_TOKEN: this.token },
        },
      );
      return JSON.parse(readFileSync(join(dir, file), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export function nativeRun(run, repo, workflow, event) {
  return (
    run?.path === `.github/workflows/${workflow}` &&
    run.head_repository?.full_name === repo &&
    run.head_branch === "main" &&
    run.event === event
  );
}

export async function latestRequest(repo) {
  const { workflow_runs: runs } = await repo.api(
    `actions/workflows/${requestWorkflow}/runs?branch=main&event=workflow_dispatch&per_page=1`,
  );
  const run = runs[0];
  return nativeRun(run, repo.name, requestWorkflow, "workflow_dispatch")
    ? run
    : undefined;
}

export function requestKey(run) {
  return `${run.id}.${run.run_attempt}`;
}

export function checkRequest(request, run) {
  checkBuild(request.version, request.build);
  if (
    request.request !== requestKey(run) ||
    request.appId !== appId ||
    !isSha(request.commit) ||
    typeof request.appleBuildId !== "string" ||
    !/^[a-zA-Z0-9-]+$/u.test(request.appleBuildId) ||
    !Number.isSafeInteger(request.pr) ||
    request.pr < 1
  )
    throw new Error("Invalid manual review request");
  return request;
}

// Find the change that started this uninterrupted registration. A clear and
// later re-registration of the same binary must invalidate the old request.
export async function registration(repo, mainSha, target) {
  let start;
  for await (const entry of repo.pages(
    `commits?sha=${mainSha}&path=${policyPath}`,
  )) {
    const { policy } = await repo.policy(entry.sha);
    if (!sameCandidate(policy.reviewCandidate, target)) break;
    start = entry.sha;
  }
  if (!start) throw new Error("Cannot identify the candidate registration");
  const matches = [];
  for await (const pr of repo.pages(`commits/${start}/pulls`)) {
    if (
      pr.merged_at &&
      pr.base.ref === "main" &&
      pr.base.repo.full_name === repo.name
    )
      matches.push(pr);
  }
  if (matches.length !== 1)
    throw new Error("Expected one merged candidate registration PR on main");
  return matches[0];
}

export async function productionSha() {
  const response = await fetch("https://api.okou.ai/api/build-info", {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`Production build-info: HTTP ${response.status}`);
  const { commitSha } = await response.json();
  if (!isSha(commitSha))
    throw new Error("Production did not return its API commit");
  return commitSha;
}

// Both endpoints can advance independently of the commit that built the IPA.
export async function readiness(repo, request, serving = productionSha) {
  const pr = await repo.api(`pulls/${request.pr}`);
  if (
    !pr.merged_at ||
    pr.base.ref !== "main" ||
    pr.base.repo.full_name !== repo.name
  )
    return "Candidate PR has not merged into main";
  if (
    !pr.body
      ?.split(/\r?\n/u)
      .some(
        (line) =>
          line === `- [x] ${qaAttestation}` ||
          line === `- [X] ${qaAttestation}`,
      )
  )
    return "Confirm production build QA in the candidate PR";
  const main = (await repo.api("git/ref/heads/main")).object.sha;
  const { policy } = await repo.policy(main);
  if (!sameCandidate(policy.reviewCandidate, request))
    return "The candidate on main was cleared or replaced";
  if ((await registration(repo, main, request)).number !== pr.number)
    return "The request belongs to an earlier candidate registration";
  const prod = await serving();
  if (!sameCandidate((await repo.policy(prod)).policy.reviewCandidate, request))
    return "Production has not deployed this candidate";
  const merge = pr.merge_commit_sha;
  if (
    !isSha(merge) ||
    (prod !== merge &&
      (await repo.api(`compare/${merge}...${prod}?per_page=1`))
        .merge_base_commit?.sha !== merge)
  )
    return "Production does not contain the candidate PR";
  return null;
}
