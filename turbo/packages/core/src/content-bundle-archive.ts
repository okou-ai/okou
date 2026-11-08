import {
  chmod,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "tar";
import type { ContentBundleFile } from "./content-bundle";

/** Shared canonical byte encoding; callers own their distinct package limits. */
export async function prepareCanonicalBundleArchive(
  files: readonly ContentBundleFile[],
): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "content-bundle-"));
  try {
    const directory = join(root, "files");
    for (const file of files) {
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content, { mode: 0o600 });
      await chmod(path, file.mode ?? 0o600);
    }
    const archivePath = join(root, "archive.tar.gz");
    await create(
      {
        cwd: directory,
        file: archivePath,
        gzip: { portable: true },
        portable: true,
        mtime: new Date(0),
        noDirRecurse: true,
      },
      files.map((file) => {
        return file.path;
      }),
    );
    return await readFile(archivePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
