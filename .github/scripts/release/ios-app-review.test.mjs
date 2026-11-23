import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { draftReceipt } from "./ios-app-review.mjs";

const target = { version: "0.54.0", build: "196", commit: "a".repeat(40) };
const context = "ios-app-review-draft/0.54.0-196";
const run = "https://github.com/okou-ai/okou/actions/runs/123/attempts/1";
test("persists a new Apple draft once and recovers only this build's bot-issued receipt", () => {
  const writes = [];
  const statuses = [
    { context, description: "foreign", creator: { login: "someone" } },
    {
      context: "ios-app-review-draft/0.54.0-197",
      description: "another-build",
      creator: { login: "github-actions[bot]" },
    },
  ];
  const api = (path, data) => {
    if (!data) {
      assert.equal(
        path,
        `commits/${target.commit}/statuses?per_page=100&page=1`,
      );
      return statuses;
    }
    assert.equal(path, `statuses/${target.commit}`);
    writes.push(data);
    statuses.unshift({ ...data, creator: { login: "github-actions[bot]" } });
  };
  const receipt = draftReceipt(api, target, run);
  assert.equal(receipt.knownSubmissionId, undefined);
  receipt.saveSubmission("draft-42");
  receipt.saveSubmission("draft-42");
  const again = draftReceipt(api, target, run);
  assert.equal(again.knownSubmissionId, "draft-42");
  again.saveSubmission("draft-42");
  assert.deepEqual(writes, [
    { context, state: "success", description: "draft-42", target_url: run },
  ]);
});
test("reads older pages and stops on a malformed receipt", () => {
  const api = (path) =>
    path.endsWith("page=1")
      ? Array(100).fill({})
      : [
          {
            context,
            creator: { login: "github-actions[bot]" },
            state: "success",
            description: "invalid ID",
          },
        ];
  assert.throws(
    () => draftReceipt(api, target, run),
    /Invalid Apple draft receipt/,
  );
});

test("the manual entry point rejects an invalid build before looking up a release or contacting Apple", () => {
  const command = fileURLToPath(
    new URL("./ios-app-review.mjs", import.meta.url),
  );
  const run = spawnSync(process.execPath, [command], {
    encoding: "utf8",
    env: { IOS_VERSION: "1.0.0", IOS_BUILD_NUMBER: "1.5" },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /integer Apple build number/);
});
