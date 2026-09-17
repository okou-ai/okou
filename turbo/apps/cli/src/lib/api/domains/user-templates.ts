import {
  USER_TEMPLATE_PACKAGE_CONTENT_TYPE,
  USER_TEMPLATE_PAGE_CONTENT_TYPE,
  userTemplatesContract,
  type UserTemplateKind,
  type UserTemplateSummary,
} from "@okouai/api-contracts/contracts/user-templates";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";
import { orderedPagePaths, packageArchive } from "./template-uploads";
import { uploadWebFile } from "./web";

/**
 * Publish one compiled reverse run as a custom template.
 *
 * The source, the ordered page images and the guidance archive are ordinary
 * private uploads made first; the endpoint receives their ids and commits them
 * together. Nothing exists until that commit succeeds, so an abandoned run
 * leaves no half-built template behind.
 */
export async function publishUserTemplate(args: {
  readonly title: string;
  readonly kind: UserTemplateKind;
  readonly sourcePath: string;
  /** Presentations only: a document template renders no pages. */
  readonly pagesDir: string | undefined;
  readonly packageDir: string;
}): Promise<UserTemplateSummary> {
  const pagePaths =
    args.kind === "presentation" && args.pagesDir !== undefined
      ? await orderedPagePaths(args.pagesDir)
      : [];

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
    body:
      args.kind === "presentation"
        ? {
            title: args.title,
            kind: "presentation",
            sourceFileId: source.id,
            pageFileIds: pageIds,
            packageFileId: packageId,
          }
        : {
            title: args.title,
            kind: "document",
            sourceFileId: source.id,
            packageFileId: packageId,
          },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to publish the custom template");
}
