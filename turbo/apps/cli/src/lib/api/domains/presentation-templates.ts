import {
  PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE,
  PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE,
  presentationTemplatesContract,
  type PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";
import { orderedPagePaths, packageArchive } from "./template-uploads";
import { uploadWebFile } from "./web";

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
