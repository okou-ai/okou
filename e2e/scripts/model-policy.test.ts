import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("deployed E2E tests only use Luna for GPT models", async () => {
  const directory = fileURLToPath(new URL("../tests/", import.meta.url));
  const files = await readdir(directory, { recursive: true });
  const testFiles = files.filter((file) => file.endsWith(".bats"));
  assert(testFiles.length > 0, "Expected deployed E2E tests");

  const violations: string[] = [];
  for (const file of testFiles) {
    const path = join(directory, file);
    const source = await readFile(path, "utf8");
    for (const [index, line] of source.split("\n").entries()) {
      for (const [model] of line.matchAll(/\bgpt-[a-z\d][a-z\d.-]*/giu)) {
        if (model !== "gpt-5.6-luna" && model !== "gpt-6-luna") {
          violations.push(
            `${relative(directory, path)}:${index + 1}: ${model}`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Use a Luna model for GPT E2E coverage:\n${violations.join("\n")}`,
  );
});

test("runner behavioral E2E tests use the native mock account", async () => {
  const directory = fileURLToPath(
    new URL("../tests/03-runner/", import.meta.url),
  );
  // These files intentionally cover real model/provider behavior or mock Claude.
  const providerTests = new Set([
    "run-t09-real-codex-steer.bats",
    "run-t10-real-claude-smoke.bats",
    "run-t11-real-codex-billing.bats",
    "run-t21-claude-runtime-regressions.bats",
    "run-t24-built-in-provider-fallback.bats",
  ]);
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".bats"),
  );
  const violations: string[] = [];

  for (const file of files) {
    if (providerTests.has(file)) continue;
    const source = await readFile(join(directory, file), "utf8");
    if (!/^\s*runner_e2e_use_native_codex_account\s*$/m.test(source)) {
      violations.push(`${file}: select the native mock account in setup`);
    }
    if (/\bdeepseek-v4-flash\b/.test(source)) {
      violations.push(`${file}: do not select the real default model`);
    }
  }

  assert.deepEqual(violations, []);
});
