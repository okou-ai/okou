import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create as createTar } from "tar";

import { ApiRequestError } from "../core/client-factory";

/**
 * The two file-shaping steps every compiled template publish performs before it
 * touches an endpoint: putting page images into page order, and turning the
 * guidance directory into one archive. Both template families do this
 * identically, so neither owns a private copy.
 */
/**
 * Page order is the order the files are published in, so it has to come from
 * something stable. The renderer writes zero-padded names, which sort
 * lexicographically into page order.
 *
 * The comparison is code-unit order rather than `localeCompare`, because
 * `localeCompare` follows the host locale: the same directory could publish in
 * a different order on a different machine, and a silently reordered deck
 * misaligns every page against the wrong analysis.
 */
export async function orderedPagePaths(
  pagesDir: string,
): Promise<readonly string[]> {
  const entries = await readdir(pagesDir);
  const pages = entries.filter((name) => {
    return name.toLowerCase().endsWith(".png");
  });
  if (pages.length === 0) {
    throw new ApiRequestError(
      `No .png page images in ${pagesDir}`,
      "NO_PAGES",
      400,
    );
  }
  pages.sort((left, right) => {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  });
  return pages.map((name) => {
    return join(pagesDir, name);
  });
}

/** Archive the package directory so binary assets never become base64 JSON. */
export async function packageArchive<T>(
  packageDir: string,
  use: (archivePath: string) => Promise<T>,
): Promise<T> {
  const workDir = await mkdtemp(join(tmpdir(), "okou-template-"));
  const archivePath = join(workDir, "package.tar.gz");
  try {
    await createTar(
      { gzip: true, file: archivePath, cwd: packageDir, portable: true },
      await readdir(packageDir),
    );
    return await use(archivePath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
