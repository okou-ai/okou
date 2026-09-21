import {
  USER_TEMPLATE_PACKAGE_CONTENT_TYPE,
  USER_TEMPLATE_PAGE_CONTENT_TYPE,
  userTemplatesContract,
  type PublishUserTemplateBody,
  type UserTemplateSummary,
} from "@okouai/api-contracts/contracts/user-templates";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";
import { orderedPagePaths, packageArchive } from "./template-uploads";
import { uploadWebFile } from "./web";

interface PublishUserTemplateCommon {
  readonly title: string;
  readonly sourcePath: string;
  readonly packageDir: string;
}

/**
 * The common fields plus whatever the chosen kind needs, as one union.
 *
 * A union rather than one shape with an optional pages directory: page images
 * are a presentation's requirement, not a template's, so a document has nowhere
 * to put pages it never renders and a presentation cannot arrive without them.
 * That is what lets the switches below name every kind instead of one of them
 * being what the others fall through to.
 */
export type PublishUserTemplateArgs =
  | (PublishUserTemplateCommon & {
      readonly kind: "presentation";
      readonly pagesDir: string;
    })
  | (PublishUserTemplateCommon & {
      readonly kind: "document";
      readonly coverPath?: string;
      readonly pageCount?: number;
    })
  | (PublishUserTemplateCommon & { readonly kind: "illustration" });

interface UploadedFileIds {
  readonly sourceFileId: string;
  readonly pageFileIds: string[];
  readonly coverFileId: string | undefined;
  readonly packageFileId: string;
}

/** What to upload as pages before publishing. Every kind answers for itself. */
async function pagePaths(
  args: PublishUserTemplateArgs,
): Promise<readonly string[]> {
  switch (args.kind) {
    case "presentation": {
      return await orderedPagePaths(args.pagesDir);
    }
    case "document":
    case "illustration": {
      return [];
    }
  }
}

/**
 * The one picture that is a cover without also being a page.
 *
 * A deck's cover is the first of the pages it already sends and an
 * illustration's is its source, so neither has a file to name here.
 */
function coverPath(args: PublishUserTemplateArgs): string | undefined {
  switch (args.kind) {
    case "document": {
      return args.coverPath;
    }
    case "presentation":
    case "illustration": {
      return undefined;
    }
  }
}

/**
 * The request each kind sends.
 *
 * The document arm omits `pageFileIds` rather than sending an empty array, so
 * the endpoint never has to read emptiness as a claim about a template that has
 * no pages to begin with.
 */
function publishRequestBody(
  args: PublishUserTemplateArgs,
  uploaded: UploadedFileIds,
): PublishUserTemplateBody {
  switch (args.kind) {
    case "presentation": {
      return {
        title: args.title,
        kind: "presentation",
        sourceFileId: uploaded.sourceFileId,
        pageFileIds: uploaded.pageFileIds,
        packageFileId: uploaded.packageFileId,
      };
    }
    case "document": {
      return {
        title: args.title,
        kind: "document",
        sourceFileId: uploaded.sourceFileId,
        ...(uploaded.coverFileId === undefined
          ? {}
          : { coverFileId: uploaded.coverFileId }),
        ...(args.pageCount === undefined ? {} : { pageCount: args.pageCount }),
        packageFileId: uploaded.packageFileId,
      };
    }
    case "illustration": {
      return {
        title: args.title,
        kind: "illustration",
        sourceFileId: uploaded.sourceFileId,
        packageFileId: uploaded.packageFileId,
      };
    }
  }
}

/**
 * Publish one compiled reverse run as a custom template.
 *
 * The source, the ordered page images and the guidance archive are ordinary
 * private uploads made first; the endpoint receives their ids and commits them
 * together. Nothing exists until that commit succeeds, so an abandoned run
 * leaves no half-built template behind.
 */
export async function publishUserTemplate(
  args: PublishUserTemplateArgs,
): Promise<UserTemplateSummary> {
  const pages = await pagePaths(args);
  const cover = coverPath(args);

  const source = await uploadWebFile(args.sourcePath);
  const pageFileIds: string[] = [];
  for (const pagePath of pages) {
    const page = await uploadWebFile(pagePath, {
      contentType: USER_TEMPLATE_PAGE_CONTENT_TYPE,
    });
    pageFileIds.push(page.id);
  }
  // Sent as a page's content type because it is held to a page's limits at
  // publish and served through the same preview-asset path afterwards.
  const coverFileId =
    cover === undefined
      ? undefined
      : (
          await uploadWebFile(cover, {
            contentType: USER_TEMPLATE_PAGE_CONTENT_TYPE,
          })
        ).id;

  const packageFileId = await packageArchive(
    args.packageDir,
    async (archive) => {
      const uploaded = await uploadWebFile(archive, {
        contentType: USER_TEMPLATE_PACKAGE_CONTENT_TYPE,
      });
      return uploaded.id;
    },
  );

  const config = await getClientConfig();
  const client = initClient(userTemplatesContract, config);
  const result = await client.publish({
    body: publishRequestBody(args, {
      sourceFileId: source.id,
      pageFileIds,
      coverFileId,
      packageFileId,
    }),
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to publish the custom template");
}

/**
 * Replace a published template's package.
 *
 * Only the guidance moves. The source this template was compiled from has not
 * changed, so its rendered pages and everything the catalog shows still
 * describe it, and every message already carrying this template keeps working.
 */
export async function replaceUserTemplatePackage(args: {
  readonly templateId: string;
  readonly packageDir: string;
}): Promise<UserTemplateSummary> {
  const packageFileId = await packageArchive(
    args.packageDir,
    async (archive) => {
      const uploaded = await uploadWebFile(archive, {
        contentType: USER_TEMPLATE_PACKAGE_CONTENT_TYPE,
      });
      return uploaded.id;
    },
  );

  const config = await getClientConfig();
  const client = initClient(userTemplatesContract, config);
  const result = await client.replacePackage({
    params: { templateId: args.templateId },
    body: { packageFileId },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to replace the custom template package");
}
