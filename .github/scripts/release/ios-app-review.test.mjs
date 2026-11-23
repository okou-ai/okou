import assert from "node:assert/strict";
import test from "node:test";
import {
  qaAttestation,
  readiness,
  requestWorkflow,
  policyPath,
  checkRequest,
} from "./ios-app-review-github.mjs";
import { checkedProof, register, verify } from "./ios-app-review-request.mjs";
import {
  pendingRequest,
  processRequest,
  triggerEligible,
} from "./ios-app-review-submit.mjs";

const repoName = "okou-ai/okou";
const sha = (digit) => digit.repeat(40);
const before = sha("1"),
  merge = sha("2"),
  main = sha("3"),
  production = sha("4");
const candidate = { version: "0.54.0", build: "196", commit: sha("a") };
const target = {
  ...candidate,
  appId: "6815550027",
  appleBuildId: "apple-build-196",
  proof: "https://github.com/okou-ai/okou/actions/runs/10/attempts/1",
};
const manual = {
  id: 12,
  display_title: "Request App Review for iOS 0.54.0 (196)",
  run_attempt: 1,
  path: `.github/workflows/${requestWorkflow}`,
  event: "workflow_dispatch",
  head_branch: "main",
  head_repository: { full_name: repoName },
  status: "completed",
  conclusion: "success",
};
const request = { ...target, pr: 42, request: "12.1" };
const qaBody = `- [x] ${qaAttestation}`;
const policy = (selected) => ({
  appStoreMinimumSupportedVersion: null,
  testFlightMinimumSupportedVersion: "0.51.12",
  reviewCandidate: selected,
});

test("selects the exact build and rejects stale, expired, foreign and superseded evidence", () => {
  const now = Date.now();
  const receipt = {
    ...target,
    platform: "IOS",
    channel: "testflight",
    verifiedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString(),
  };
  const { proof, ...verified } = target;
  assert.deepEqual(checkedProof(receipt, candidate, candidate, now), verified);
  for (const patch of [
    { build: "197" },
    { appId: "other" },
    { channel: "app-store" },
    { platform: "MAC_OS" },
    { verifiedAt: new Date(now - 86400000).toISOString() },
    { expiresAt: new Date(now).toISOString() },
    { appleBuildId: "" },
  ]) {
    assert.throws(
      () => checkedProof({ ...receipt, ...patch }, candidate, candidate, now),
      /TestFlight proof/,
    );
  }
  assert.throws(() =>
    checkedProof(receipt, candidate, { ...candidate, commit: sha("f") }, now),
  );
  assert.throws(() => checkRequest({ ...request, request: "12.2" }, manual));
});

// GitHub fixtures model the public REST responses and the file at each commit.
// Apple is only invoked by the state-changing handoff after discovery succeeds.
function repository(options = {}) {
  const calls = [],
    statuses = [];
  const pr = {
    number: 42,
    merged_at: 42,
    base: { ref: "main", repo: { full_name: repoName } },
    merge_commit_sha: merge,
    body: qaBody,
    ...options.pr,
  };
  const run = options.run ?? manual;
  const refs = { main, ...options.refs };
  const policies = {
    main: policy(candidate),
    [before]: policy(null),
    [merge]: policy(candidate),
    [main]: policy(candidate),
    [production]: policy(candidate),
    ...options.policies,
  };
  const repo = {
    name: repoName,
    url: `https://github.com/${repoName}`,
    async api(path, method = "GET", data) {
      calls.push({ path, method, data });
      if (path.includes("/artifacts?"))
        return {
          artifacts: [
            {
              name: `ios-app-review-request-${run.run_attempt}`,
              expired: options.expired ?? false,
            },
          ],
        };
      if (path === "pulls/42") return pr;
      if (path.startsWith("git/ref/heads/")) {
        const ref = path.slice("git/ref/heads/".length);
        if (!refs[ref])
          throw Object.assign(new Error("missing ref"), { status: 404 });
        return { object: { sha: refs[ref] } };
      }
      if (path.startsWith("compare/")) {
        if (path.startsWith(`compare/${main}...${merge}?`))
          return {
            merge_base_commit: { sha: before },
            files: options.files ?? [{ filename: policyPath }],
          };
        assert.ok(path.startsWith(`compare/${merge}...${production}?`));
        return { merge_base_commit: { sha: options.ancestor ?? merge } };
      }
      if (path === "pulls" && method === "POST") return { number: 43 };
      if (path.startsWith("statuses/")) {
        assert.equal(path, `statuses/${candidate.commit}`);
        statuses.unshift({
          ...data,
          creator: { login: "github-actions[bot]" },
        });
        return {};
      }
      if (
        path.endsWith("/comments") ||
        path === "git/refs" ||
        path === `contents/${policyPath}`
      )
        return {};
      assert.fail(path);
    },
    async policy(ref) {
      assert.ok(ref in policies, `no fixture for ${ref}`);
      return { sha: "blob", policy: policies[ref] };
    },
    async *pages(path) {
      if (path.startsWith("actions/workflows/")) {
        yield* options.runs ?? [run];
        return;
      }
      if (path.startsWith("commits?")) {
        for (const id of options.changes ?? [main, merge, before])
          yield { sha: id };
      } else if (path.startsWith(`commits/${candidate.commit}/statuses`))
        yield* statuses;
      else if (path.endsWith("/pulls"))
        yield { ...pr, number: options.registration ?? 42 };
      else if (path === "pulls?state=open&base=main") yield* options.open ?? [];
      else if (path.includes("/attempts/") && path.endsWith("/jobs"))
        yield* options.jobs ?? [];
      else assert.fail(path);
    },
    artifact(source, name, file) {
      assert.equal(source.id, run.id);
      assert.equal(file, "request.json");
      assert.equal(name, `ios-app-review-request-${run.run_attempt}`);
      return options.record ?? request;
    },
  };
  return { repo, calls, pr, statuses };
}

test("registers one candidate-only change without altering either floor or marking human QA complete", async () => {
  const { repo, calls } = repository({ policies: { [main]: policy(null) } });
  assert.equal(await register(repo, target, manual), 43);
  const writes = calls.filter((c) => c.method !== "GET");
  assert.deepEqual(
    writes.map((c) => [c.path, c.method]),
    [
      ["git/refs", "POST"],
      [`contents/${policyPath}`, "PUT"],
      ["pulls", "POST"],
    ],
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(writes[1].data.content, "base64").toString()),
    policy(candidate),
  );
  assert.equal(writes[0].data.sha, main);
  assert.ok(writes[2].data.body.includes(`- [ ] ${qaAttestation}`));
  assert.ok(writes[2].data.body.includes(target.proof));
});
test("reuses open and continuously registered candidates and stops on another build", async () => {
  const open = [
    {
      number: 77,
      head: {
        ref: "automation/ios-app-review/other-run",
        sha: merge,
        repo: { full_name: repoName },
      },
    },
  ];
  for (const options of [{ open, policies: { [main]: policy(null) } }, {}]) {
    const { repo, calls } = repository(options);
    const num = await register(repo, target, manual);
    assert.equal(num, options.open ? 77 : 42);
    assert.deepEqual(
      calls.filter((c) => c.method !== "GET").map((c) => c.path),
      [`issues/${num}/comments`],
    );
  }
  for (const options of [
    { policies: { [main]: policy({ ...candidate, build: "197" }) } },
    {
      open,
      policies: {
        [main]: policy(null),
        [merge]: policy({ ...candidate, build: "197" }),
      },
    },
  ]) {
    const { repo, calls } = repository(options);
    await assert.rejects(
      register(repo, target, manual),
      /already protected|different open candidate/,
    );
    assert.ok(calls.every((c) => c.method === "GET"));
  }
});
test("a serving API descendant of the registration can differ from both main and the iOS binary", async () => {
  const { repo } = repository();
  assert.equal(await readiness(repo, request, () => production), null);
});
for (const [why, options, expected] of [
  ["PR open", { pr: { merged_at: null } }, /not merged/],
  [
    "production QA outstanding",
    { pr: { body: `- [ ] ${qaAttestation}` } },
    /Confirm production/,
  ],
  [
    "candidate cleared",
    { policies: { [main]: policy(null) } },
    /cleared or replaced/,
  ],
  [
    "candidate replaced",
    { policies: { [main]: policy({ ...candidate, commit: sha("b") }) } },
    /cleared or replaced/,
  ],
  [
    "same binary registered a second time",
    { changes: [main, before, merge], registration: 99 },
    /earlier candidate registration/,
  ],
  [
    "production behind",
    { policies: { [production]: policy(null) } },
    /has not deployed/,
  ],
  ["unrelated production history", { ancestor: before }, /does not contain/],
])
  test(`waits or stops when ${why}`, async () => {
    assert.match(
      await readiness(repository(options).repo, request, () => production),
      expected,
    );
  });
test("only the protected successful manual run or an actual main API promotion can wake the request", async () => {
  const release = {
    ...manual,
    path: ".github/workflows/release-please.yml",
    event: "push",
    head_sha: main,
  };
  const success = {
    name: "promote-api-production",
    head_sha: main,
    conclusion: "success",
  };
  assert.equal(
    await triggerEligible(repository({ jobs: [success] }).repo, release),
    true,
  );
  for (const job of [
    { ...success, conclusion: "skipped" },
    { ...success, head_sha: before },
    { ...success, name: "release-please" },
  ])
    assert.equal(
      await triggerEligible(repository({ jobs: [job] }).repo, release),
      false,
    );
  for (const source of [
    { ...manual, head_branch: "feature" },
    { ...manual, head_repository: { full_name: "other/fork" } },
    { ...manual, event: "pull_request" },
    { ...manual, conclusion: "failure" },
  ])
    assert.equal(await triggerEligible(repository().repo, source), false);
});
test("a newer incomplete request, an expired artifact or registration alone never submits", async () => {
  for (const options of [
    { run: { ...manual, id: 13, conclusion: "failure" } },
    { run: { ...manual, id: 13, status: "in_progress", conclusion: null } },
    { run: { ...manual, id: 13 } },
    { expired: true },
    { record: { ...request, request: "11.1" } },
  ]) {
    const result = pendingRequest(
      repository(options).repo,
      manual,
      () => production,
    );
    if (options.record)
      await assert.rejects(result, /Invalid manual review request/);
    else assert.ok((await result).reason);
  }
});
test("journals an attempt before Apple, persists the draft ID, and does not repeat on a later deployment", async () => {
  const { repo, statuses } = repository();
  const release = {
    ...manual,
    id: 23,
    event: "push",
    path: ".github/workflows/release-please.yml",
    head_sha: main,
  };
  let attempts = 0;
  const url = "https://github.com/okou-ai/okou/actions/runs/100";
  const current = await pendingRequest(repo, manual, () => production);
  assert.equal(current.reason, null);
  await assert.rejects(
    processRequest(
      repo,
      request,
      current.previous,
      url,
      async (hooks) => {
        attempts++;
        assert.equal(statuses[0].state, "pending");
        await hooks.saveSubmission("review-id");
        throw new Error("metadata missing");
      },
      async () => {},
    ),
    /metadata missing/,
  );
  assert.deepEqual(
    statuses.map((s) => [s.state, s.description]),
    [
      ["error", "12.1 review-id"],
      ["pending", "12.1 review-id"],
      ["pending", "12.1 -"],
    ],
  );
  assert.match(
    (await pendingRequest(repo, manual, () => production)).reason,
    /already attempted/,
  );
  const retryRun = { ...manual, id: 15 },
    retryRecord = { ...request, request: "15.1" };
  const retry = repository({
    run: retryRun,
    record: retryRecord,
    jobs: [
      { name: "promote-api-production", head_sha: main, conclusion: "success" },
    ],
  });
  retry.statuses.push(...statuses);
  const next = await pendingRequest(retry.repo, release, () => production);
  assert.equal(next.reason, null);
  await processRequest(
    retry.repo,
    next.request,
    next.previous,
    url,
    async (hooks) => {
      assert.equal(hooks.knownSubmissionId, "review-id");
      attempts++;
      return { id: "review-id", state: "IN_REVIEW" };
    },
    async () => {},
  );
  assert.equal(attempts, 2);
  assert.match(
    (await pendingRequest(retry.repo, release, () => production)).reason,
    /already attempted \(success\)/,
  );
});

test("dispatches the native proof once and never guesses a run or consumes another attempt", async () => {
  const writes = [];
  const repo = {
    name: repoName,
    url: `https://github.com/${repoName}`,
    async api(path, method, data) {
      if (method === "POST") {
        writes.push({ path, data });
        return this.dispatch;
      }
      assert.equal(path, "actions/runs/171");
      return {
        ...manual,
        id: 171,
        path: ".github/workflows/ios-distribution-availability.yml",
        display_title: "Verify iOS testflight availability",
        run_attempt: 3,
      };
    },
    artifact(run, name, file) {
      assert.equal(run.id, 171);
      assert.equal(name, "ios-availability-testflight-3");
      assert.equal(file, "availability.json");
      throw new Error("reached exact proof artifact");
    },
  };
  await assert.rejects(
    verify(repo, target.version, target.build),
    /did not identify/,
  );
  assert.equal(writes.length, 1);
  repo.dispatch = { workflow_run_id: 171 };
  await assert.rejects(
    verify(repo, target.version, target.build),
    /reached exact proof artifact/,
  );
  assert.deepEqual(writes[1], {
    path: "actions/workflows/ios-distribution-availability.yml/dispatches",
    data: {
      ref: "main",
      inputs: {
        channel: "testflight",
        version: target.version,
        build: target.build,
      },
      return_run_details: true,
    },
  });
});

test("an existing candidate branch with an unrelated change or floor edit cannot be reused", async () => {
  const open = [
    {
      number: 77,
      head: {
        ref: "automation/ios-app-review/12",
        sha: merge,
        repo: { full_name: repoName },
      },
    },
  ];
  for (const change of [
    { files: [{ filename: policyPath }, { filename: "other-file" }] },
    {
      policies: {
        [main]: policy(null),
        [merge]: {
          ...policy(candidate),
          testFlightMinimumSupportedVersion: "0.54.0",
        },
      },
    },
  ]) {
    const { repo, calls } = repository({
      open,
      policies: { [main]: policy(null) },
      ...change,
    });
    await assert.rejects(register(repo, target, manual), /other changes/);
    assert.ok(calls.every((call) => call.method === "GET"));
  }
});

test("a conflicting request for a different build cannot cancel or authorize the deployed candidate", async () => {
  const other = {
    ...manual,
    id: 13,
    display_title: "Request App Review for iOS 0.54.0 (197)",
    conclusion: "failure",
  };
  const release = {
    ...manual,
    id: 14,
    event: "push",
    path: ".github/workflows/release-please.yml",
    head_sha: main,
  };
  const jobs = [
    { name: "promote-api-production", head_sha: main, conclusion: "success" },
  ];
  assert.equal(
    (
      await pendingRequest(
        repository({ jobs, runs: [other, manual] }).repo,
        release,
        () => production,
      )
    ).reason,
    null,
  );
  assert.match(
    (
      await pendingRequest(
        repository({ jobs, runs: [other] }).repo,
        release,
        () => production,
      )
    ).reason,
    /No completed current manual request/,
  );
});
