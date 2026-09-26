import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("runner behavioral E2E tests select the mock Codex profile", async () => {
  const directory = fileURLToPath(
    new URL("../tests/03-runner/", import.meta.url),
  );
  // These files intentionally cover real model/provider behavior or mock Claude.
  const providerTests = new Set([
    "run-t09-real-codex-steer.bats",
    "run-t10-real-claude-pi-smoke.bats",
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
    if (!/^\s*runner_e2e_use_mock_codex_profile\s*$/m.test(source)) {
      violations.push(`${file}: select the mock Codex profile in setup`);
    }
    if (/\bdeepseek-v4-flash\b/.test(source)) {
      violations.push(`${file}: do not select the real default model`);
    }
  }

  assert.deepEqual(violations, []);
});

test("mock Codex start helpers reject missing or incorrect profiles before dispatch", () => {
  const chatHelper = fileURLToPath(
    new URL("../helpers/runner-chat.bash", import.meta.url),
  );
  const apiHelper = fileURLToPath(
    new URL("../helpers/runner-api.bash", import.meta.url),
  );
  const helpers = [
    "runner_e2e_start_mock_shell_chat_run",
    "runner_e2e_start_mock_checkpointed_chat_run",
    "runner_chat_start_mock_codex",
  ];
  const invalidProfiles = [
    { name: "missing profile", profile: "", model: "" },
    { name: "wrong profile", profile: "real-codex", model: "gpt-6-astra" },
    { name: "real model", profile: "mock-codex", model: "deepseek-v4-flash" },
  ];

  for (const helper of helpers) {
    const script = [
      `source "${chatHelper}"`,
      `source "${apiHelper}"`,
      'runner_chat_send() { printf "CHAT_REQUEST:%s\\n" "$4"; }',
      '_runner_chat_execute() { printf "CHAT_REQUEST:%s\\n" "$4"; }',
      `${helper} test-agent 'echo hello' 'echo continue'`,
    ].join("\n");

    for (const { name, profile, model } of invalidProfiles) {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          E2E_RUNNER_PROFILE: profile,
          E2E_MOCK_CODEX_MODEL: model,
        },
      });
      assert.equal(result.status, 1, `${helper}: ${name}: ${result.stderr}`);
      assert.match(result.stderr, /Select the mock Codex profile/);
      assert.doesNotMatch(result.stdout, /CHAT_REQUEST:/);
    }

    const selected = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        E2E_RUNNER_PROFILE: "mock-codex",
        E2E_MOCK_CODEX_MODEL: "gpt-6-astra",
      },
    });
    assert.equal(selected.status, 0, `${helper}: ${selected.stderr}`);
    assert.equal(selected.stdout.trim(), "CHAT_REQUEST:gpt-6-astra");
  }
});

test("failed mock profile selection clears the model marker", () => {
  const apiHelper = fileURLToPath(
    new URL("../helpers/runner-api.bash", import.meta.url),
  );
  const script = [
    `source "${apiHelper}"`,
    'jq() { if [[ "$2" == *.apiUrl* ]]; then return 1; fi; printf "synthetic-token\\n"; }',
    "if runner_e2e_use_mock_codex_profile; then exit 42; fi",
    'printf "PROFILE=%s MODEL=%s\\n" "${E2E_RUNNER_PROFILE:-}" "${E2E_MOCK_CODEX_MODEL:-}"',
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      E2E_RUNNER_PROFILE: "mock-codex",
      E2E_MOCK_CODEX_MODEL: "gpt-6-astra",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "PROFILE= MODEL=");
});
