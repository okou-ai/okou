import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { create as createTar } from "tar";

import rawDevSeedSkillVolumes from "../scripts/dev-seed-skill-volumes.json";
import seededSkillBundles from "../scripts/dev-seed-skill-bundles.json";

interface SeededSystemSkillVolume {
  readonly name: string;
  readonly s3Key: string;
  readonly versionSize: number;
  readonly frontmatter: {
    readonly name?: unknown;
    readonly description?: unknown;
  };
}

function representativeSkillMarkdown(volume: SeededSystemSkillVolume): string {
  const { name, description } = volume.frontmatter;
  if (typeof name !== "string" || typeof description !== "string") {
    throw new Error(`Seeded system skill ${volume.name} needs frontmatter`);
  }
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`;
}

function createArchive(volume: SeededSystemSkillVolume): Buffer {
  const root = mkdtempSync(join(tmpdir(), "okou-api-seeded-skill-"));
  const skillPath = join(root, "SKILL.md");
  const archivePath = join(root, "archive.tar.gz");
  writeFileSync(skillPath, representativeSkillMarkdown(volume));
  chmodSync(skillPath, 0o644);
  createTar(
    {
      cwd: root,
      file: archivePath,
      gzip: { portable: true },
      mtime: new Date(0),
      portable: true,
      sync: true,
    },
    ["SKILL.md"],
  );
  const archive = readFileSync(archivePath);
  rmSync(root, { recursive: true, force: true });
  if (archive.length > volume.versionSize) {
    throw new Error(
      `Seeded system skill ${volume.name} archive exceeds ${volume.versionSize.toString()} bytes`,
    );
  }
  return Buffer.concat(
    [archive, Buffer.alloc(volume.versionSize - archive.length)],
    volume.versionSize,
  );
}

export function seededSkillBundleArchive(
  archiveKey: string,
): Buffer | undefined {
  const bundle = seededSkillBundles.find((skill) => {
    return `bundles/v1/${skill.contentBundle.sha256}.tar.gz` === archiveKey;
  });
  if (bundle) {
    return readFileSync(
      new URL(`./seed-skill-bundles/${bundle.name}.tar.gz`, import.meta.url),
    );
  }
  return undefined;
}

export function seededSystemSkillArchive(
  archiveKey: string,
): Buffer | undefined {
  const bundle = seededSkillBundleArchive(archiveKey);
  if (bundle) {
    return bundle;
  }
  const volume = rawDevSeedSkillVolumes.find((candidate) => {
    return (
      SEED_SKILLS.includes(candidate.name) &&
      `${candidate.s3Key}/archive.tar.gz` === archiveKey
    );
  });
  if (!volume) {
    return undefined;
  }
  return createArchive(volume);
}
