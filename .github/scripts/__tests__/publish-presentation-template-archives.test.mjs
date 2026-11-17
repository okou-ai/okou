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

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createTemplateFixture(sourceDir, release, outputFormat) {
  const templateDir = path.join(sourceDir, release.slug);
  if (outputFormat === "pptx") {
    const bloom = release.resourceId === "template:pptx-bloom-runbook";
    const palettePath = bloom
      ? "assets/bloom/palettes.json"
      : "assets/palettes.json";
    await mkdir(path.dirname(path.join(templateDir, palettePath)), {
      recursive: true,
    });
    await mkdir(path.join(templateDir, "scripts"), { recursive: true });
    const palettes = {
      [release.defaultColorSystem]: { bg: "#FFFFFF", ink: "#000000" },
    };
    const files = {
      "SKILL.md": `# ${release.slug}\n${"Use this native PowerPoint guidance.\n".repeat(64)}`,
      "deck.types.ts": "export interface Deck { title: string; }\n",
      [palettePath]: JSON.stringify(
        bloom
          ? { defaultPalette: release.defaultColorSystem, palettes }
          : palettes,
      ),
      "scripts/generate.mjs": "export const nativePowerPoint = true;\n",
      "scripts/package.json": JSON.stringify({ private: true }),
      "scripts/package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
    };
    await Promise.all(
      Object.entries(files).map(([name, contents]) => {
        return writeFile(path.join(templateDir, name), contents);
      }),
    );
    return;
  }
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

test("commands reject ambiguous format arguments", async () => {
  const cases = [
    [["build", "--format=pptx"], /Unsupported option: --format=pptx/u],
    [
      ["build", "--format", "pptx", "--format", "html"],
      /Duplicate option: --format/u,
    ],
    [["build", "--format"], /--format requires a value/u],
    [["verify", "--initialize-missing-heads"], /Unsupported option/u],
    [
      ["verify", "--format", "pdf", "--output-dir", tmpdir()],
      /Unsupported presentation output format: pdf/u,
    ],
  ];
  for (const [args, expected] of cases) {
    await assert.rejects(runTool(...args), (error) => {
      assert.match(error.stderr, expected);
      return true;
    });
  }
});

for (const outputFormat of ["html", "pptx"]) {
  test(
    `build and verify commands validate the configured ${outputFormat} archives`,
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "presentation-release-test-"),
      );
      const sourceDir = path.join(root, "source");
      const outputDir = path.join(root, "output");
      const formatArgs =
        outputFormat === "html" ? [] : ["--format", outputFormat];
      const configUrl = new URL(
        outputFormat === "html"
          ? "../release/presentation-template-release.json"
          : "../release/presentation-template-release-pptx.json",
        import.meta.url,
      );
      try {
        const config = JSON.parse(await readFile(configUrl, "utf8"));
        await mkdir(sourceDir, { recursive: true });
        await Promise.all(
          config.templates.map(async (release) => {
            await createTemplateFixture(sourceDir, release, outputFormat);
          }),
        );

        const sourceCommit = "a".repeat(40);
        const buildArgs = [
          "build",
          ...formatArgs,
          "--source-dir",
          sourceDir,
          "--source-commit",
          sourceCommit,
          "--output-dir",
          outputDir,
        ];
        await runTool(...buildArgs);
        await runTool("verify", ...formatArgs, "--output-dir", outputDir);

        const publication = JSON.parse(
          await readFile(path.join(outputDir, "publication.json"), "utf8"),
        );
        assert.equal(publication.schemaVersion, 2);
        assert.deepEqual(publication.source, {
          ...config.source,
          commit: sourceCommit,
        });
        assert.equal(publication.packages.length, config.templates.length);
        for (const pkg of publication.packages) {
          assert.equal(pkg.fileCount, outputFormat === "html" ? 4 : 6);
          assert.ok(
            (await stat(path.join(outputDir, pkg.archive.path))).size > 0,
          );
          const archive = await readFile(
            path.join(outputDir, pkg.archive.path),
          );
          assert.deepEqual(pkg.registryArchive, {
            format: "registry-tar-gzip-v1",
            sha256: digest(archive),
            archiveBytes: archive.length,
            objectKey: `registry-archives/v1/${digest(archive)}.tar.gz`,
          });
        }

        if (outputFormat === "pptx") {
          await assert.rejects(
            runTool("verify", "--output-dir", outputDir),
            (error) => {
              assert.match(
                error.stderr,
                /Publication metadata does not match/u,
              );
              return true;
            },
          );
        }

        const metadataPath = path.join(outputDir, "publication.json");
        const originalMetadata = await readFile(metadataPath);
        publication.packages[0].registryArchive.objectKey =
          "foreign/archive.tar.gz";
        await writeFile(metadataPath, JSON.stringify(publication));
        await assert.rejects(
          runTool("verify", ...formatArgs, "--output-dir", outputDir),
          (error) => {
            assert.match(
              error.stderr,
              /registry archive descriptor does not match/u,
            );
            return true;
          },
        );
        await writeFile(metadataPath, originalMetadata);

        const firstArchive = path.join(
          outputDir,
          publication.packages[0].archive.path,
        );
        await appendFile(firstArchive, "tampered");
        await assert.rejects(
          runTool("verify", ...formatArgs, "--output-dir", outputDir),
          (error) => {
            assert.match(error.stderr, /archive bytes do not match/u);
            return true;
          },
        );

        if (outputFormat === "pptx") {
          const firstTemplate = path.join(sourceDir, config.templates[0].slug);
          const bloom =
            config.templates[0].resourceId === "template:pptx-bloom-runbook";
          const palettes = path.join(
            firstTemplate,
            bloom ? "assets/bloom/palettes.json" : "assets/palettes.json",
          );
          const originalPalettes = await readFile(palettes);
          const invalidPalettes = { unrelated_palette: {} };
          await writeFile(
            palettes,
            JSON.stringify(
              bloom ? { palettes: invalidPalettes } : invalidPalettes,
            ),
          );
          await assert.rejects(runTool(...buildArgs), (error) => {
            assert.match(error.stderr, /default palette .* is missing/u);
            return true;
          });
          await writeFile(palettes, originalPalettes);
          await rm(path.join(firstTemplate, "scripts/generate.mjs"));
          await assert.rejects(runTool(...buildArgs), (error) => {
            assert.match(error.stderr, /ENOENT.*generate\.mjs/u);
            return true;
          });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
