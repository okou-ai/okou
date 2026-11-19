import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "tar";
import { http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { server } from "../../../../mocks/server";

export async function sourceArchive(revision = "first") {
  const files = new Map<string, Buffer>();
  for (const name of [...BUILT_IN_SKILLS, "ordinary-skill"]) {
    files.set(
      `${name}/SKILL.md`,
      Buffer.from(
        `---\nname: ${name}\ndescription: ${name}\n---\n${name === "gen" ? revision : "stable"}\n`,
      ),
    );
  }
  files.set(
    "workflow-setup/references/guide.md",
    Buffer.from("Complete guide\n"),
  );
  const root = await mkdtemp(join(tmpdir(), "seed-skills-provider-"));
  onTestFinished(() => {
    return rm(root, { recursive: true, force: true });
  });
  for (const [path, content] of files) {
    const target = join(root, "okou-skills-main", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archivePath = join(root, "source.tar.gz");
  await create({ cwd: root, file: archivePath, gzip: true }, [
    "okou-skills-main",
  ]);
  return { archive: await readFile(archivePath), files };
}

export function githubSource(sha: string, archive: Buffer) {
  server.use(
    http.get("https://github.com/okou-ai/okou-skills.git/info/refs", () => {
      return new HttpResponse(`${sha} refs/heads/main\n`);
    }),
    http.get(
      "https://codeload.github.com/okou-ai/okou-skills/tar.gz/refs/heads/main",
      () => {
        return new HttpResponse(new Uint8Array(archive));
      },
    ),
  );
}
