import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

test("client-003 Losing the watched tab releases its late child on the original parent while the sibling accepts typing", async () => {
  const env = { ...process.env, NODE_ENV: "development" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) delete env[key];
  }
  const { stdout } = await promisify(execFile)(
    "bash",
    [join(env.REPLAY_BUNDLE, "parent", "replay.sh")],
    { cwd: env.REPLAY_CHECKOUT, env, timeout: 180_000 },
  );
  const location = /^Receipts directory (.+)$/m.exec(stdout)?.[1];
  assert.ok(location);
  console.info("Native child receipts", location);
  const receipt = JSON.parse(
    await readFile(join(location, "parent.json"), "utf8"),
  );
  assert.equal(receipt.originalParent, true);
  assert.equal(receipt.siblingInitiallyLive, true);
  assert.equal(receipt.targetLossDelivered, true);
  assert.equal(receipt.noEarlyDetach, true);
  assert.equal(receipt.replyDelivered, true);
  assert.deepEqual(receipt.detaches, [
    {
      op: "detach",
      correctChild: true,
      correctParent: true,
      correctConnection: true,
    },
  ]);
  assert.equal(receipt.sameConnectionHello, true);
  assert.equal(receipt.sameConnectionInput, true);
  assert.equal(receipt.siblingText, true);
  assert.deepEqual(receipt.closeBeforeFinish, []);
}, 190_000);
