import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const tool =
  process.env.PRESENTATION_EXTRACT_TEMPLATE_RELEASE_TOOL ??
  fileURLToPath(
    new URL("../publish-presentation-extract-template.mjs", import.meta.url),
  );
const source = fileURLToPath(
  new URL(
    "./fixtures/presentation-extract-template-source.tar.gz",
    import.meta.url,
  ),
);

async function runTool(...args) {
  return await execFileAsync(process.execPath, [tool, ...args]);
}

test("publication cannot start without an explicit execute flag", async () => {
  await assert.rejects(
    runTool("publish", "--output-dir", "/missing"),
    (error) => {
      assert.match(error.stderr, /requires the explicit --execute flag/u);
      return true;
    },
  );
});

test("prepare and verify pin the source, package layout, and publication metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "extract-release-test-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  try {
    for (const output of [first, second]) {
      await runTool(
        "prepare",
        "--source-archive",
        source,
        "--output-dir",
        output,
      );
      await runTool("verify", "--output-dir", output);
    }
    const archiveName = "presentation-extract-template.tar.gz";
    assert.deepEqual(
      await readFile(path.join(first, archiveName)),
      await readFile(path.join(second, archiveName)),
    );
    assert.deepEqual(
      await readFile(path.join(first, "manifest.json")),
      await readFile(path.join(second, "manifest.json")),
    );
    const publicationPath = path.join(first, "publication.json");
    const original = await readFile(publicationPath, "utf8");
    const publication = JSON.parse(original);
    assert.deepEqual(publication.files.map((file) => file.path).sort(), [
      "extract-template/SKILL.md",
      "extract-template/scripts/libreoffice.mjs",
      "extract-template/scripts/render-pages.mjs",
    ]);
    publication.storageId = "11111111-1111-4111-8111-111111111111";
    await writeFile(publicationPath, JSON.stringify(publication));
    await assert.rejects(runTool("verify", "--output-dir", first), (error) => {
      assert.match(error.stderr, /Publication metadata does not match/u);
      return true;
    });
    await writeFile(publicationPath, original);
    await appendFile(path.join(first, "manifest.json"), "changed");
    await assert.rejects(runTool("verify", "--output-dir", first), (error) => {
      assert.match(error.stderr, /Storage manifest does not match/u);
      return true;
    });
    await appendFile(path.join(second, archiveName), "changed");
    await assert.rejects(
      runTool("publish", "--output-dir", second, "--execute"),
      (error) => {
        assert.match(error.stderr, /Archive bytes do not match/u);
        return true;
      },
    );
    const badSource = path.join(root, "bad-source.tar.gz");
    await cp(source, badSource);
    await appendFile(badSource, "changed");
    await assert.rejects(
      runTool("prepare", "--source-archive", badSource, "--output-dir", first),
      (error) => {
        assert.match(error.stderr, /Source archive does not match/u);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
