import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";

import platformConfig from "../i18next.config.ts";

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "platform-i18n-check-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/example.ts"),
    `
      i18n.t("greeting", { defaultValue: "Hello" });
      i18n.t("example", { defaultValue: "Example", ns: "sample" });
    `,
  );

  for (const locale of platformConfig.locales) {
    const localeDirectory = join(root, "src/i18n/locales", locale);
    await mkdir(localeDirectory, { recursive: true });
    await writeFile(
      join(localeDirectory, "common.json"),
      `${JSON.stringify({ greeting: locale === "en-US" ? "Hello" : "Translated" }, null, 2)}\n`,
    );
    await writeFile(
      join(localeDirectory, "sample.json"),
      `${JSON.stringify({ example: locale === "en-US" ? "Example" : "Translated" }, null, 2)}\n`,
    );
  }

  return root;
}

async function runCheck(cwd) {
  const checkScript = fileURLToPath(
    new URL("./check-i18n.node.ts", import.meta.url),
  );
  const tsxCli = fileURLToPath(
    new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
  );
  const executeFile = promisify(execFile);

  try {
    const { stderr, stdout } = await executeFile(
      process.execPath,
      [tsxCli, checkScript],
      { cwd, env: { ...process.env, CI: "true" } },
    );
    return { code: 0, stderr, stdout };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      "stderr" in error &&
      "stdout" in error
    ) {
      return {
        code: error.code,
        stderr: error.stderr,
        stdout: error.stdout,
      };
    }
    throw error;
  }
}

await test("passes complete resources for every locale and namespace", async (t) => {
  const root = await createFixture(t);

  const result = await runCheck(root);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No files were updated/);
  assert.match(result.stdout, /i18next Project Status/);
});

await test("fails before status when generated resources drift", async (t) => {
  const root = await createFixture(t);
  const commonResource = join(root, "src/i18n/locales/en-US/common.json");
  const resourceBeforeCheck = await readFile(commonResource, "utf8");
  await writeFile(
    join(root, "src/example.ts"),
    `
      i18n.t("greeting", { defaultValue: "Hello" });
      i18n.t("newKey", { defaultValue: "New" });
      i18n.t("example", { defaultValue: "Example", ns: "sample" });
    `,
  );

  const result = await runCheck(root);

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /Generated translation resources were out of date/,
  );
  assert.match(result.stderr, /common\.json/);
  assert.doesNotMatch(result.stdout, /i18next Project Status/);
  assert.equal(await readFile(commonResource, "utf8"), resourceBeforeCheck);
});

await test("fails for an empty required secondary translation", async (t) => {
  const root = await createFixture(t);
  await writeFile(
    join(root, "src/i18n/locales/pt-BR/sample.json"),
    `${JSON.stringify({ example: "" }, null, 2)}\n`,
  );

  const result = await runCheck(root);

  assert.equal(result.code, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Incomplete translations detected/,
  );
  assert.match(result.stdout, /i18next Project Status/);
});
