import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  USER_TEMPLATE_PACKAGE_CONTENT_TYPE,
  USER_TEMPLATE_PAGE_CONTENT_TYPE,
  userTemplatesContract,
  type UserTemplateSummary,
} from "@okouai/api-contracts/contracts/user-templates";

import { getClientConfig, handleError } from "../core/client-factory";
import { orderedPagePaths, packageArchive } from "./template-package";
import { uploadWebFile } from "./web";

/**
 * Publish the run's output into the caller's own catalog rather than the
 * official one. The upload sequence is the official catalog's, because the
 * pieces are the same ordinary private files; only the destination and the
 * `kind` the row carries differ.
 */
export async function publishUserTemplate(args: {
  readonly title: string;
  readonly sourcePath: string;
  readonly pagesDir: string;
  readonly packageDir: string;
}): Promise<UserTemplateSummary> {
  const pagePaths = await orderedPagePaths(args.pagesDir);

  const source = await uploadWebFile(args.sourcePath);
  const pageIds: string[] = [];
  for (const pagePath of pagePaths) {
    const page = await uploadWebFile(pagePath, {
      contentType: USER_TEMPLATE_PAGE_CONTENT_TYPE,
    });
    pageIds.push(page.id);
  }

  const packageId = await packageArchive(args.packageDir, async (archive) => {
    const uploaded = await uploadWebFile(archive, {
      contentType: USER_TEMPLATE_PACKAGE_CONTENT_TYPE,
    });
    return uploaded.id;
  });

  const config = await getClientConfig();
  const client = initClient(userTemplatesContract, config);
  const result = await client.publish({
    body: {
      title: args.title,
      kind: "presentation",
      sourceFileId: source.id,
      pageFileIds: pageIds,
      packageFileId: packageId,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to publish the custom template");
}
