import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, onTestFinished } from "vitest";

/**
 * Return true after the owned child has executed this test's assertions.
 * @type {typeof import("./run-isolated-test.d.mts").runInIsolatedProcess}
 */
export async function runInIsolatedProcess(testFileUrl) {
  const fullName = expect.getState().currentTestName;
  if (!fullName) {
    throw new Error("Expected an active isolated test");
  }
  if (process.env.OKOU_ISOLATED_TEST_NAME === fullName) {
    onTestFinished(() => {
      process.stdout.write("OKOU_ISOLATED_TEST_COMPLETED\n");
    });
    return false;
  }
  const testFile = fileURLToPath(testFileUrl);
  let cwd = dirname(testFile);
  while (!existsSync(join(cwd, "vitest.config.ts"))) {
    const parent = dirname(cwd);
    if (parent === cwd) {
      throw new Error("Isolated test has no workspace Vitest config");
    }
    cwd = parent;
  }
  // Vitest 5 filters the same " > "-joined full name shown by reporters.
  const pattern = fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A same-thread timeout cannot interrupt synchronous traversal. Threads
  // keep the probe in one child process, fully stopped by its kill deadline.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
      ),
      "run",
      testFile,
      "--pool=threads",
      "--maxWorkers=1",
      "--testNamePattern",
      `^${pattern}$`,
    ],
    {
      cwd,
      env: { ...process.env, OKOU_ISOLATED_TEST_NAME: fullName },
      timeout: 120_000,
      killSignal: "SIGKILL",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  // Nonzero exits/timeouts throw; a probe that selects no tests fails too.
  expect(stdout).toContain("OKOU_ISOLATED_TEST_COMPLETED");
  return true;
}
