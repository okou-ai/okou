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
        if (model !== "gpt-5.6-luna") {
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
    `Use gpt-5.6-luna for GPT E2E coverage:\n${violations.join("\n")}`,
  );
});
