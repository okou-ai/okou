import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { withPackageSource } from "../release/presentation-template-release/composition.mjs";
import {
  buildFileManifest,
  computeVersionId,
} from "../release/presentation-template-release/shared.mjs";

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
const sourceCommit = "a".repeat(40);
const guidance =
  "Use the selected presentation guidance and original visual references.\n".repeat(
    32,
  );

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFixture(directory, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, relativePath)), {
      recursive: true,
    });
    await writeFile(path.join(directory, relativePath), contents);
  }
}

async function createTemplateFixture(sourceDir, release) {
  await writeFixture(path.join(sourceDir, release.slug), {
    "SKILL.md": `# ${release.slug}\n${guidance}`,
    "design-system.md": "# Design system\n",
    "layouts/shared-shell.html": `<link rel="stylesheet" href="../color-systems/${release.defaultColorSystem}.css">\n`,
    [`color-systems/${release.defaultColorSystem}.css`]:
      ":root { --background: white; }\n",
  });
}

async function createRuntimeFixture(runtimeDir) {
  await writeFixture(runtimeDir, {
    "start.py": "# Source preparation entrypoint\n",
    "tools/bootstrap.py": "# Bootstrap helper\n",
    "tools/runtime.py": "# Runtime helper\n",
    "tools/prepare.py": "# Source preparation helper\n",
    "tools/delivery.py": "# Delivery helper\n",
    "tools/run.sh": "#!/bin/sh\n# Shared QA entrypoint\n",
    "tools/audit.js": "// Shared QA implementation\n",
    "parallel/tools/pipeline.py": "# Parallel pipeline\n",
    "parallel/tools/page_queue.py": "# Parallel queue\n",
    "parallel/worker.md": "# Worker guide\n",
    "parallel/worker-handoff.md": "# Resolved worker handoff\n",
    "html-authoring.md": "# HTML authoring guide\n",
    "input-modes.md": "# Input modes\n",
    "recovery.md": "# Recovery guide\n",
    "guides/source notes.md": "# Source notes\n",
    "guides/figure(1).svg": "<svg></svg>\n",
    "SKILL.md": `---\nname: presentation\n---\n# Shared workflow\n${guidance}\nComplete source research and establish the narrative before starting workers.\n\npython3 RUNTIME/start.py --local-template TEMPLATE --source REF --directory TASK/source --deck-workspace TASK/deck\n\nAfter research, initialize streaming authoring:\n\npython3 RUNTIME/tools/bootstrap.py --template TEMPLATE --workspace TASK/deck\n\n[Authoring](html-authoring.md#pages)\n[Worker](parallel/worker.md)\n[Input](<./input-modes.md>)\n[Tools](tools/)\n[Source](<guides/source notes.md> "Source notes")\n![Figure](guides/figure(1).svg?raw=1#preview)\n[Recovery][recover]\n\n[recover]: ./recovery.md "Recovery guide"\n\n[External](https://example.com/guide) [Section](#shared-workflow)\n`,
    "__pycache__/ignored.pyc": "runtime cache",
    ".pytest_cache/lastfailed": "test cache",
    "tools/ignored.pyc": "runtime bytecode",
  });
}

async function createFixture(t, { external = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "presentation-release-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const fixture = {
    root,
    sourceDir: path.join(root, "source", "Template-Presentation"),
    runtimeDir: path.join(root, "source", "presentation"),
    outputDir: path.join(root, "output"),
    config: JSON.parse(await readFile(configUrl, "utf8")),
  };
  await mkdir(fixture.sourceDir, { recursive: true });
  await Promise.all(
    fixture.config.templates.map((release) =>
      createTemplateFixture(fixture.sourceDir, release),
    ),
  );
  fixture.pilotDir = path.join(fixture.sourceDir, "data-report");
  await writeFixture(
    path.join(fixture.sourceDir, fixture.config.templates[0].slug),
    {
      "parallel/SKILL.md": guidance,
      "parallel/__pycache__/retained.pyc": "legacy cache must be retained",
    },
  );
  if (external) {
    await writeFixture(fixture.pilotDir, {
      "presentation-template.json": JSON.stringify({
        version: 1,
        runtime: "external",
        styleGuide: "SKILL.md",
      }),
      "qa-config.json": JSON.stringify({ template: "data-report" }),
      "__pycache__/ignored.pyc": "visual cache",
      "reference/ignored.pyc": "visual bytecode",
    });
    await createRuntimeFixture(fixture.runtimeDir);
  }
  return fixture;
}

async function runTool(...args) {
  return await execFileAsync(process.execPath, [releaseTool, ...args], {
    maxBuffer: 5 * 1024 * 1024,
  });
}

async function buildFixture(fixture) {
  await runTool(
    "build",
    "--source-dir",
    fixture.sourceDir,
    "--source-commit",
    sourceCommit,
    "--output-dir",
    fixture.outputDir,
  );
  return JSON.parse(
    await readFile(path.join(fixture.outputDir, "publication.json"), "utf8"),
  );
}

async function fileManifest(directory, prefix = "") {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await fileManifest(path.join(directory, entry.name), relativePath)),
      );
    } else {
      assert.ok(entry.isFile(), `Regular file expected: ${relativePath}`);
      const bytes = await readFile(path.join(directory, entry.name));
      files.push({
        path: relativePath,
        hash: digest(bytes),
        size: bytes.length,
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function rejectsTool(pattern) {
  return (error) => {
    assert.match(error.stderr, pattern);
    return true;
  };
}

async function extractPackage(fixture, pkg, destination) {
  await mkdir(destination, { recursive: true });
  await execFileAsync("tar", [
    "-xzf",
    path.join(fixture.outputDir, pkg.archive.path),
    "-C",
    destination,
  ]);
  return path.join(destination, pkg.slug);
}

async function rewritePilotArchive(
  fixture,
  publication,
  originalArchive,
  change,
  updateFiles,
) {
  const pkg = publication.packages.find(
    (entry) => entry.slug === "data-report",
  );
  const archivePath = path.join(fixture.outputDir, pkg.archive.path);
  await writeFile(archivePath, originalArchive);
  const extracted = await mkdtemp(path.join(fixture.root, "tampered-"));
  const packageDir = await extractPackage(fixture, pkg, extracted);
  await change(packageDir);
  await execFileAsync("tar", ["-czf", archivePath, "-C", extracted, pkg.slug]);
  const archive = await readFile(archivePath);
  pkg.archive.sha256 = digest(archive);
  pkg.archive.byteSize = archive.length;
  if (updateFiles) {
    pkg.files = await buildFileManifest(extracted, pkg.slug);
    pkg.versionId = computeVersionId(pkg.storageId, pkg.files);
    pkg.fileCount = pkg.files.length;
    pkg.totalSize = pkg.files.reduce((sum, file) => sum + file.size, 0);
  }
  await writeFile(
    path.join(fixture.outputDir, "publication.json"),
    JSON.stringify(publication),
  );
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
  "legacy bundles preserve source contents without a sibling runtime",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await createFixture(t);
    const baseline = new Map(
      await Promise.all(
        fixture.config.templates.map(async ({ slug }) => [
          slug,
          await fileManifest(path.join(fixture.sourceDir, slug), slug),
        ]),
      ),
    );
    const publication = await buildFixture(fixture);
    await runTool("verify", "--output-dir", fixture.outputDir);
    assert.equal(publication.source.commit, sourceCommit);
    assert.equal(publication.packages.length, fixture.config.templates.length);
    for (const release of fixture.config.templates) {
      const pkg = publication.packages.find(
        (entry) => entry.slug === release.slug,
      );
      const sourceFiles = baseline.get(release.slug);
      assert.deepEqual(
        await fileManifest(
          path.join(fixture.sourceDir, release.slug),
          release.slug,
        ),
        sourceFiles,
      );
      const extracted = await extractPackage(
        fixture,
        pkg,
        path.join(fixture.root, "extracted"),
      );
      assert.deepEqual(
        await fileManifest(extracted, release.slug),
        sourceFiles,
      );
      assert.deepEqual(pkg.files, sourceFiles);
      assert.equal(
        pkg.versionId,
        computeVersionId(release.storageId, sourceFiles),
      );
      assert.equal(pkg.resourceId, release.resourceId);
      assert.equal(pkg.storageId, release.storageId);
    }
    await appendFile(
      path.join(fixture.outputDir, publication.packages[0].archive.path),
      "tampered",
    );
    await assert.rejects(
      runTool("verify", "--output-dir", fixture.outputDir),
      rejectsTool(/archive bytes do not match/u),
    );
  },
);

test(
  "external archives compose one bound workflow with sibling visual and runtime directories",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await createFixture(t, { external: true });
    const originalTemplate = await fileManifest(fixture.pilotDir);
    const originalRuntime = await fileManifest(fixture.runtimeDir);
    const legacyBaseline = new Map(
      await Promise.all(
        fixture.config.templates
          .filter(({ slug }) => slug !== "data-report")
          .map(async ({ slug }) => [
            slug,
            await fileManifest(path.join(fixture.sourceDir, slug), slug),
          ]),
      ),
    );
    const runtimeSkill = await readFile(
      path.join(fixture.runtimeDir, "SKILL.md"),
      "utf8",
    );
    const publication = await buildFixture(fixture);
    await runTool("verify", "--output-dir", fixture.outputDir);
    const pkg = publication.packages.find(
      (entry) => entry.slug === "data-report",
    );
    const extracted = await extractPackage(
      fixture,
      pkg,
      path.join(fixture.root, "extracted"),
    );
    assert.deepEqual(
      (await readdir(extracted)).sort(),
      [
        "SKILL.md",
        "presentation-package.json",
        "presentation",
        "template",
      ].sort(),
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(extracted, "presentation-package.json"),
          "utf8",
        ),
      ),
      {
        version: 1,
        template: "template",
        runtime: "presentation",
      },
    );
    const withoutCaches = (files) =>
      files.filter(
        (file) =>
          !file.path.includes("__pycache__/") &&
          !file.path.includes(".pytest_cache/") &&
          !file.path.endsWith(".pyc"),
      );
    assert.deepEqual(
      await fileManifest(path.join(extracted, "template")),
      withoutCaches(originalTemplate),
    );
    assert.deepEqual(
      await fileManifest(path.join(extracted, "presentation")),
      withoutCaches(originalRuntime),
    );
    const rootSkill = await readFile(path.join(extracted, "SKILL.md"), "utf8");
    assert.match(rootSkill, /^---\nname: presentation\n---\n/u);
    assert.match(rootSkill, /RUNTIME=PACKAGE\/presentation`/u);
    assert.match(rootSkill, /TEMPLATE=PACKAGE\/template/u);
    assert.match(rootSkill, /TASK.*new, separate workspace outside/u);
    assert.match(
      rootSkill,
      /\[Authoring\]\(presentation\/html-authoring\.md#pages\)/u,
    );
    assert.match(
      rootSkill,
      /\[Worker\]\(presentation\/parallel\/worker\.md\)/u,
    );
    assert.match(rootSkill, /\[Input\]\(<presentation\/input-modes\.md>\)/u);
    assert.match(
      rootSkill,
      /\[recover\]: presentation\/recovery\.md "Recovery guide"/u,
    );
    assert.match(
      rootSkill,
      /\[External\]\(https:\/\/example\.com\/guide\) \[Section\]\(#shared-workflow\)/u,
    );
    const files = await fileManifest(extracted, pkg.slug);
    assert.deepEqual(
      pkg.files.toSorted((left, right) => left.path.localeCompare(right.path)),
      files,
    );
    assert.equal(pkg.versionId, computeVersionId(pkg.storageId, files));
    assert.equal(pkg.fileCount, files.length);
    assert.equal(
      pkg.totalSize,
      files.reduce((sum, file) => sum + file.size, 0),
    );
    assert.match(
      rootSkill,
      /\[Source\]\(<presentation\/guides\/source notes\.md> "Source notes"\)/u,
    );
    assert.match(
      rootSkill,
      /!\[Figure\]\(presentation\/guides\/figure\(1\)\.svg\?raw=1#preview\)/u,
    );
    const runtimeBody = runtimeSkill.slice(
      runtimeSkill.indexOf("# Shared workflow"),
    );
    assert.equal(
      rootSkill
        .slice(rootSkill.indexOf("# Shared workflow"))
        .replaceAll("presentation/", ""),
      runtimeBody
        .replaceAll("./input-modes.md", "input-modes.md")
        .replaceAll("./recovery.md", "recovery.md"),
    );
    assert.ok(
      rootSkill.indexOf("RUNTIME/start.py") <
        rootSkill.indexOf("RUNTIME/tools/bootstrap.py"),
    );
    assert.equal(pkg.colorSystemCount, 1);
    assert.ok(pkg.skillBytes >= 1024);
    assert.deepEqual(await fileManifest(fixture.pilotDir), originalTemplate);
    assert.deepEqual(await fileManifest(fixture.runtimeDir), originalRuntime);
    for (const other of publication.packages.filter(
      (entry) => entry.slug !== pkg.slug,
    )) {
      const original = legacyBaseline.get(other.slug);
      assert.deepEqual(other.files, original);
      assert.deepEqual(
        await fileManifest(
          path.join(fixture.sourceDir, other.slug),
          other.slug,
        ),
        original,
      );
    }
    const rebuilt = await buildFixture(fixture);
    assert.deepEqual(rebuilt, publication);
  },
);

test(
  "build rejects invalid metadata, mixed runtimes and unsupported source entries",
  { timeout: 30_000 },
  async (t) => {
    const cases = [
      [
        "malformed marker",
        async (f) =>
          writeFile(path.join(f.pilotDir, "presentation-template.json"), "{"),
        /JSON/u,
      ],
      [
        "invalid marker contract",
        async (f) =>
          writeFile(
            path.join(f.pilotDir, "presentation-template.json"),
            JSON.stringify({
              version: 1,
              runtime: "external",
              styleGuide: "../SKILL.md",
              extra: true,
            }),
          ),
        /invalid presentation-template.json/u,
      ],
      [
        "duplicate marker fields",
        async (f) =>
          writeFile(
            path.join(f.pilotDir, "presentation-template.json"),
            '{"version":0,"version":1,"runtime":"external","styleGuide":"SKILL.md"}',
          ),
        /invalid presentation-template.json/u,
      ],
      [
        "metadata directory",
        async (f) => {
          await rm(path.join(f.pilotDir, "presentation-template.json"));
          await mkdir(path.join(f.pilotDir, "presentation-template.json"));
        },
        /invalid presentation-template.json/u,
      ],
      [
        "missing root QA configuration",
        async (f) => rm(path.join(f.pilotDir, "qa-config.json")),
        /ENOENT.*qa-config.json/u,
      ],
      [
        "malformed QA configuration",
        async (f) => writeFile(path.join(f.pilotDir, "qa-config.json"), "{"),
        /JSON/u,
      ],
      [
        "non-object QA configuration",
        async (f) => writeFile(path.join(f.pilotDir, "qa-config.json"), "[]"),
        /invalid qa-config.json/u,
      ],
      [
        "QA configuration directory",
        async (f) => {
          await rm(path.join(f.pilotDir, "qa-config.json"));
          await mkdir(path.join(f.pilotDir, "qa-config.json"));
        },
        /invalid qa-config.json/u,
      ],
      [
        "missing runtime",
        async (f) => rm(f.runtimeDir, { recursive: true }),
        /ENOENT.*presentation/u,
      ],
      [
        "missing source preparation entrypoint",
        async (f) => rm(path.join(f.runtimeDir, "start.py")),
        /runtime file start.py/u,
      ],
      [
        "missing worker handoff",
        async (f) => rm(path.join(f.runtimeDir, "parallel/worker-handoff.md")),
        /runtime file parallel\/worker-handoff.md/u,
      ],
      [
        "missing runtime tool",
        async (f) => rm(path.join(f.runtimeDir, "tools/bootstrap.py")),
        /runtime file tools\/bootstrap.py/u,
      ],
      [
        "missing shared QA implementation",
        async (f) => rm(path.join(f.runtimeDir, "tools/audit.js")),
        /runtime file tools\/audit.js/u,
      ],
      [
        "missing parallel pipeline",
        async (f) => rm(path.join(f.runtimeDir, "parallel/tools/pipeline.py")),
        /runtime file parallel\/tools\/pipeline.py/u,
      ],
      [
        "mixed embedded runtime",
        async (f) => mkdir(path.join(f.pilotDir, "parallel")),
        /mixed or nested runtime/u,
      ],
      [
        "nested embedded runtime",
        async (f) =>
          mkdir(path.join(f.pilotDir, "nested/parallel"), {
            recursive: true,
          }),
        /mixed or nested runtime/u,
      ],
      [
        "nested shared runtime",
        async (f) => mkdir(path.join(f.runtimeDir, "presentation")),
        /mixed or nested runtime/u,
      ],
      [
        "visual symlink",
        async (f) => symlink("SKILL.md", path.join(f.pilotDir, "linked.md")),
        /Unsupported template entry/u,
      ],
      [
        "runtime symlink",
        async (f) => symlink("SKILL.md", path.join(f.runtimeDir, "linked.md")),
        /Unsupported template entry/u,
      ],
      [
        "runtime directory symlink",
        async (f) => {
          await rm(f.runtimeDir, { recursive: true });
          await symlink(f.pilotDir, f.runtimeDir);
        },
        /regular template directory/u,
      ],
      [
        "nonregular input",
        async (f) => execFileAsync("mkfifo", [path.join(f.pilotDir, "pipe")]),
        /Unsupported template entry/u,
      ],
      [
        "nonregular runtime input",
        async (f) => execFileAsync("mkfifo", [path.join(f.runtimeDir, "pipe")]),
        /Unsupported template entry/u,
      ],
      [
        "dangling runtime guide",
        async (f) =>
          appendFile(
            path.join(f.runtimeDir, "SKILL.md"),
            "\n[Missing](missing.md)\n",
          ),
        /reference does not resolve/u,
      ],
      [
        "escaping runtime guide",
        async (f) =>
          appendFile(
            path.join(f.runtimeDir, "SKILL.md"),
            "\n[Escape](../SKILL.md)\n",
          ),
        /reference escapes/u,
      ],
      [
        "dangling palette",
        async (f) =>
          appendFile(
            path.join(f.pilotDir, "SKILL.md"),
            "\ncolor-systems/missing.css\n",
          ),
        /colour-system references/u,
      ],
      [
        "missing default palette",
        async (f) => rm(path.join(f.pilotDir, "color-systems/prism.css")),
        /ENOENT.*prism.css/u,
      ],
    ];
    for (const [name, change, pattern] of cases) {
      await t.test(name, async (subtest) => {
        const fixture = await createFixture(subtest, { external: true });
        await change(fixture);
        await assert.rejects(buildFixture(fixture), rejectsTool(pattern));
      });
    }
  },
);

test("composition rejects snapshot mutations and cleans staging on failure", async (t) => {
  const cases = [
    [
      "visual source mutation",
      async (f) =>
        appendFile(path.join(f.pilotDir, "design-system.md"), "changed"),
      /Source visual template: files changed/u,
    ],
    [
      "runtime source mutation",
      async (f) =>
        appendFile(path.join(f.runtimeDir, "tools/bootstrap.py"), "changed"),
      /Source runtime: files changed/u,
    ],
    [
      "final staged content mutation",
      async (_f, staged) =>
        appendFile(path.join(staged, "data-report/SKILL.md"), "changed"),
      /Staged package: files changed/u,
    ],
    [
      "consumer failure",
      async () => {
        throw new Error("Package consumer failed");
      },
      /Package consumer failed/u,
    ],
  ];
  for (const [name, change, pattern] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest, { external: true });
      let staged;
      await assert.rejects(
        withPackageSource(
          fixture.sourceDir,
          "data-report",
          async (packageSource) => {
            staged = packageSource;
            await change(fixture, packageSource);
          },
        ),
        pattern,
      );
      assert.ok(staged);
      await assert.rejects(readdir(staged), { code: "ENOENT" });
    });
  }
});

test(
  "verify rechecks extracted runtime hashes and composed layout",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await createFixture(t, { external: true });
    const publication = await buildFixture(fixture);
    const originalArchive = await readFile(
      path.join(fixture.outputDir, "data-report.tar.gz"),
    );
    const cases = [
      [
        "runtime changed behind the archive digest",
        async (dir) =>
          appendFile(
            path.join(dir, "presentation/tools/bootstrap.py"),
            "# changed\n",
          ),
        false,
        /extracted file manifest does not match/u,
      ],
      [
        "missing runtime despite consistent manifests",
        async (dir) => rm(path.join(dir, "presentation/tools/bootstrap.py")),
        true,
        /runtime file tools\/bootstrap.py/u,
      ],
      [
        "unsafe package paths despite consistent manifests",
        async (dir) =>
          writeFile(
            path.join(dir, "presentation-package.json"),
            JSON.stringify({
              version: 1,
              template: "../template",
              runtime: "presentation",
            }),
          ),
        true,
        /invalid presentation-package.json/u,
      ],
      [
        "wrong template contract despite consistent manifests",
        async (dir) =>
          writeFile(
            path.join(dir, "template/presentation-template.json"),
            JSON.stringify({
              version: 2,
              runtime: "external",
              styleGuide: "SKILL.md",
            }),
          ),
        true,
        /invalid presentation-template.json/u,
      ],
      [
        "missing QA configuration despite consistent manifests",
        async (dir) => rm(path.join(dir, "template/qa-config.json")),
        true,
        /ENOENT.*qa-config.json/u,
      ],
      [
        "non-object QA configuration despite consistent manifests",
        async (dir) =>
          writeFile(path.join(dir, "template/qa-config.json"), "null"),
        true,
        /invalid qa-config.json/u,
      ],
      [
        "symlink in archive",
        async (dir) =>
          symlink("SKILL.md", path.join(dir, "presentation/linked.md")),
        false,
        /Unsupported template archive entry/u,
      ],
      [
        "nonregular archive entry",
        async (dir) => execFileAsync("mkfifo", [path.join(dir, "pipe")]),
        false,
        /Unsupported template archive entry/u,
      ],
      [
        "mixed runtime despite consistent manifests",
        async (dir) => mkdir(path.join(dir, "template/parallel")),
        true,
        /mixed or nested runtime/u,
      ],
      [
        "unbound root guide despite consistent manifests",
        async (dir) => writeFile(path.join(dir, "SKILL.md"), guidance),
        true,
        /root SKILL.md does not match/u,
      ],
    ];
    for (const [name, change, updateFiles, pattern] of cases) {
      await t.test(name, async () => {
        await rewritePilotArchive(
          fixture,
          structuredClone(publication),
          originalArchive,
          change,
          updateFiles,
        );
        await assert.rejects(
          runTool("verify", "--output-dir", fixture.outputDir),
          rejectsTool(pattern),
        );
      });
    }
  },
);
