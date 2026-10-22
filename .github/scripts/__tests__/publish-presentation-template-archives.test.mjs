import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { computeVersionId } from "../release/presentation-template-release/shared.mjs";

const execFileAsync = promisify(execFile);
const defaultTool = fileURLToPath(
  new URL(
    "../release/publish-presentation-template-archives.mjs",
    import.meta.url,
  ),
);
const releaseTool =
  process.env.PRESENTATION_TEMPLATE_RELEASE_TOOL ?? defaultTool;
const configUrl = new URL(
  "../release/presentation-template-release.json",
  import.meta.url,
);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createTemplateFixture(sourceDir, release) {
  const templateDir = path.join(sourceDir, release.slug);
  await Promise.all([
    mkdir(path.join(templateDir, "color-systems"), { recursive: true }),
    mkdir(path.join(templateDir, "layouts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(templateDir, "SKILL.md"),
      `# ${release.slug}\n${"Use this presentation guidance.\n".repeat(64)}`,
    ),
    writeFile(path.join(templateDir, "design-system.md"), "# Design system\n"),
    writeFile(
      path.join(templateDir, "layouts/shared-shell.html"),
      `<link rel="stylesheet" href="../color-systems/${release.defaultColorSystem}.css">\n`,
    ),
    writeFile(
      path.join(templateDir, `color-systems/${release.defaultColorSystem}.css`),
      ":root { --background: white; }\n",
    ),
  ]);
}

async function runTool(...args) {
  return await execFileAsync(process.execPath, [releaseTool, ...args], {
    maxBuffer: 5 * 1024 * 1024,
  });
}

test("content version ids are independent of manifest order", () => {
  const files = [
    { path: "example/b.txt", hash: digest("b") },
    { path: "example/a.txt", hash: digest("a") },
  ];
  assert.equal(
    computeVersionId("storage-id", files),
    computeVersionId("storage-id", [...files].reverse()),
  );
});

test(
  "build and verify commands produce and validate the configured archives",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "presentation-release-test-"),
    );
    const sourceDir = path.join(root, "source");
    const outputDir = path.join(root, "output");
    try {
      const config = JSON.parse(await readFile(configUrl, "utf8"));
      await mkdir(sourceDir, { recursive: true });
      await Promise.all(
        config.templates.map(async (release) => {
          await createTemplateFixture(sourceDir, release);
        }),
      );

      const sourceCommit = "a".repeat(40);
      await runTool(
        "build",
        "--source-dir",
        sourceDir,
        "--source-commit",
        sourceCommit,
        "--output-dir",
        outputDir,
      );
      await runTool("verify", "--output-dir", outputDir);

      const publication = JSON.parse(
        await readFile(path.join(outputDir, "publication.json"), "utf8"),
      );
      assert.equal(publication.source.commit, sourceCommit);
      assert.equal(publication.packages.length, config.templates.length);
      for (const pkg of publication.packages) {
        assert.equal(pkg.fileCount, 4);
        assert.ok(
          (await stat(path.join(outputDir, pkg.archive.path))).size > 0,
        );
      }

      const firstArchive = path.join(
        outputDir,
        publication.packages[0].archive.path,
      );
      await appendFile(firstArchive, "tampered");
      await assert.rejects(
        runTool("verify", "--output-dir", outputDir),
        (error) => {
          assert.match(error.stderr, /archive bytes do not match/u);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
