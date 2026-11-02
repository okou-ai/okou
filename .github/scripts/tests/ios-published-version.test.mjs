import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { publishedIosVersion } from "../checks/ios-published-version.mjs";

const now = Date.parse("2026-11-01T00:00:00Z");
const oldSha = "a".repeat(40);
const newSha = "b".repeat(40);

async function withGithub(evidence, action) {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    const key = request.url.replace("/repos/okou-ai/okou/", "");
    const body = evidence[key];
    response.writeHead(body === undefined ? 404 : 200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    await action({
      repository: "okou-ai/okou",
      token: "fixture-token",
      apiUrl: `http://127.0.0.1:${address.port}`,
      now,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function evidence() {
  const data = {
    "git/matching-refs/tags/ios-v": [
      { ref: "refs/tags/ios-v0.22.6", object: { sha: newSha, type: "commit" } },
      { ref: "refs/tags/ios-v0.22.5", object: { sha: oldSha, type: "commit" } },
    ],
  };
  for (const [version, sha, id] of [
    ["0.22.5", oldSha, 1],
    ["0.22.6", newSha, 2],
  ]) {
    data[`releases/tags/ios-v${version}`] = {
      tag_name: `ios-v${version}`,
      draft: false,
      prerelease: false,
    };
    data[`contents/ios/Config/Shared.xcconfig?ref=${sha}`] = {
      encoding: "base64",
      content: Buffer.from(
        `MARKETING_VERSION = ${version} // x-release-please-version\n`,
      ).toString("base64"),
    };
    data[
      `actions/workflows/release-please.yml/runs?head_sha=${sha}&event=push&per_page=5`
    ] = {
      workflow_runs: [
        { id, head_sha: sha, head_branch: "main", event: "push" },
      ],
    };
    data[`actions/runs/${id}/jobs?filter=latest&per_page=100`] = {
      jobs: [
        {
          name: "publish-ios-testflight",
          conclusion: "success",
          steps: [
            {
              name: "Wait for processing and verify internal availability",
              conclusion: "success",
              completed_at: "2026-10-30T00:00:00Z",
            },
          ],
        },
      ],
    };
  }
  return data;
}

test("selects the highest internally available version, not an upload-only tag", async () => {
  const data = evidence();
  data[
    "actions/runs/2/jobs?filter=latest&per_page=100"
  ].jobs[0].steps[0].conclusion = "skipped";
  await withGithub(data, async (options) =>
    assert.equal(await publishedIosVersion(options), "0.22.5"),
  );
});

test("binds a release version to its publisher's exact source commit", async () => {
  const data = evidence();
  data[`contents/ios/Config/Shared.xcconfig?ref=${newSha}`].content =
    Buffer.from("MARKETING_VERSION = 0.22.5\n").toString("base64");
  await withGithub(data, async (options) =>
    assert.equal(await publishedIosVersion(options), "0.22.5"),
  );
});

test("does not accept failed publishers, non-main runs, or expired TestFlight builds", async () => {
  for (const invalid of ["failed", "branch", "expired"]) {
    const data = evidence();
    for (const [sha, id] of [
      [oldSha, 1],
      [newSha, 2],
    ]) {
      const publisher =
        data[`actions/runs/${id}/jobs?filter=latest&per_page=100`].jobs[0];
      if (invalid === "failed") publisher.conclusion = "failure";
      if (invalid === "branch")
        data[
          `actions/workflows/release-please.yml/runs?head_sha=${sha}&event=push&per_page=5`
        ].workflow_runs[0].head_branch = "feature/example";
      if (invalid === "expired")
        publisher.steps[0].completed_at = "2026-01-01T00:00:00Z";
    }
    await withGithub(data, async (options) =>
      assert.equal(await publishedIosVersion(options), undefined),
    );
  }
});
