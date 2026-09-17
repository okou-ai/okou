import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  presentationTemplatesContract,
  type PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { create as createTar } from "tar";

import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { uploadWebFile } from "./web";

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
async function orderedPagePaths(pagesDir: string): Promise<readonly string[]> {
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
async function packageArchive<T>(
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

export async function publishPresentationTemplate(args: {
  readonly title: string;
  readonly sourcePath: string;
  readonly pagesDir: string;
  readonly packageDir: string;
}): Promise<PresentationTemplateSummary> {
  const pagePaths = await orderedPagePaths(args.pagesDir);

  const source = await uploadWebFile(args.sourcePath);
  const pageIds: string[] = [];
  for (const pagePath of pagePaths) {
    const page = await uploadWebFile(pagePath, {
      contentType: PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
    });
    pageIds.push(page.id);
  }

  const packageId = await packageArchive(args.packageDir, async (archive) => {
    const uploaded = await uploadWebFile(archive, {
      contentType: PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
    });
    return uploaded.id;
  });

  const config = await getClientConfig();
  const client = initClient(presentationTemplatesContract, config);
  const result = await client.publish({
    body: {
      title: args.title,
      sourceFileId: source.id,
      pageFileIds: pageIds,
      packageFileId: packageId,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to publish the presentation template");
}
