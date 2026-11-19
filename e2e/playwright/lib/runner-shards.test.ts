import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface RunnerShard {
  readonly files: readonly string[];
  readonly index: number;
  readonly weight: number;
  readonly timeoutMinutes: number;
}

interface RunnerShardMatrix {
  readonly include: readonly RunnerShard[];
}

test("discovers and deterministically balances non-empty runner shards", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "runner-shards-test-"));
  const testDirectory = join(testRoot, "03-runner");
  await mkdir(testDirectory);
  try {
    const expectedFiles: string[] = [];
    for (let index = 1; index <= 15; index += 1) {
      const name = `runner-${String(index).padStart(2, "0")}.bats`;
      const path = join(testDirectory, name);
      const testCount = index === 1 ? 5 : index <= 4 ? 2 : 1;
      const tests = Array.from(
        { length: testCount },
        (_, testIndex) => `@test "case ${testIndex + 1}" {\n  true\n}`,
      ).join("\n\n");
      const retrySetting = index === 5 ? "BATS_TEST_RETRIES=1\n\n" : "";
      await writeFile(
        path,
        `#!/usr/bin/env bats\n\n${retrySetting}${tests}\n`,
        "utf8",
      );
      expectedFiles.push(relativeToWorkingDirectory(path));
    }

    const first = await runShardPlanner(testDirectory);
    const second = await runShardPlanner(testDirectory);

    assert.deepEqual(first, second);
    assert.equal(first.include.length, 12);
    assert.deepEqual(
      first.include.map((shard) => shard.index),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    assert(first.include.every((shard) => shard.files.length > 0));
    const retryingFile = expectedFiles[4];
    assert(retryingFile);
    for (const shard of first.include) {
      assert.equal(
        shard.timeoutMinutes,
        shard.files.includes(retryingFile) ? 35 : 15,
      );
    }
    assert.deepEqual(
      first.include.flatMap((shard) => shard.files).sort(),
      expectedFiles.sort(),
    );
    assert.deepEqual(
      first.include.map((shard) => shard.weight),
      [5, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1],
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("rejects a runner test directory without executable BATS files", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "runner-shards-empty-test-"));
  try {
    await assert.rejects(runShardPlanner(testRoot), {
      message: /No runner E2E test files found/u,
    });

    await writeFile(
      join(testRoot, "empty.bats"),
      "#!/usr/bin/env bats\n",
      "utf8",
    );
    await assert.rejects(runShardPlanner(testRoot), {
      message: /Runner E2E test file has no tests/u,
    });
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

async function runShardPlanner(
  testDirectory: string,
): Promise<RunnerShardMatrix> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "playwright/runner-shards.ts", testDirectory],
    { cwd: process.cwd() },
  );
  return parseMatrix(stdout);
}

function parseMatrix(output: string): RunnerShardMatrix {
  const value: unknown = JSON.parse(output);
  if (
    typeof value !== "object" ||
    value === null ||
    !("include" in value) ||
    !Array.isArray(value.include)
  ) {
    throw new Error("Runner shard planner returned an invalid matrix");
  }
  return { include: value.include.map(parseShard) };
}

function parseShard(value: unknown): RunnerShard {
  if (
    typeof value !== "object" ||
    value === null ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    !("index" in value) ||
    typeof value.index !== "number" ||
    !("weight" in value) ||
    typeof value.weight !== "number" ||
    !("timeoutMinutes" in value) ||
    typeof value.timeoutMinutes !== "number"
  ) {
    throw new Error("Runner shard planner returned an invalid shard");
  }
  const files = value.files.map((file) => {
    if (typeof file !== "string") {
      throw new Error("Runner shard planner returned an invalid file path");
    }
    return file;
  });
  return {
    files,
    index: value.index,
    weight: value.weight,
    timeoutMinutes: value.timeoutMinutes,
  };
}

function relativeToWorkingDirectory(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}
