import { command } from "ccstate";
import { artifactReferencesContract } from "@okouai/api-contracts/client/artifact-references";
import { parseArtifactReference } from "@okouai/api-contracts/validators/artifact-references";
import { webFilesContract } from "@okouai/api-contracts/client/web-files";
import { accept } from "../lib/accept.ts";
import { publicAttachmentUrl } from "../views/okou-page/attachment-url.ts";
import { apiClient$ } from "./api-client.ts";
import { clerk$ } from "./auth.ts";
import { isAuthenticatedAttachmentUrl } from "./attachment-resource-url.ts";

type AttachmentDownloadSource =
  | {
      readonly kind: "managed";
      readonly resourceUrl: string;
      readonly downloadUrl: string;
      readonly hosted: boolean;
    }
  | {
      readonly kind: "unmanaged";
      readonly resourceUrl: string;
      readonly hosted: false;
    };

/** Resolve on every click, under the action's cancellation and current access. */
export const attachmentDownloadSource$ = command(
  async (
    { get },
    inputUrl: string,
    signal: AbortSignal,
  ): Promise<AttachmentDownloadSource> => {
    const url = publicAttachmentUrl(inputUrl);
    const reference = parseArtifactReference(url, location.origin);
    if (reference) {
      const params = { reference: `${reference.hash}${reference.extension}` };
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      if (clerk.user) {
        const result = await accept(
          get(apiClient$)(artifactReferencesContract).resolve({
            params,
            fetchOptions: { signal, cache: "no-store" },
          }),
          [200, 401, 403, 404],
          signal,
          { showErrorToast: false },
        );
        if (result.status === 200) {
          return {
            kind: "managed",
            resourceUrl: result.body.url,
            downloadUrl: result.body.downloadUrl,
            hosted: result.body.target.kind === "html",
          };
        }
      }
      // Published references are readable without a session or membership in
      // their originating organization, just as in the standalone viewer.
      const result = await accept(
        get(apiClient$)(artifactReferencesContract, {
          getToken: () => {
            return Promise.resolve(null);
          },
        }).publicUrl({ params, fetchOptions: { signal, cache: "no-store" } }),
        [200],
        signal,
      );
      return {
        kind: "managed",
        resourceUrl: result.body.url,
        downloadUrl: result.body.downloadUrl,
        hosted:
          result.body.preview.contentType.split(";")[0].trim() === "text/html",
      };
    }
    if (isAuthenticatedAttachmentUrl(url)) {
      const fileId = new URL(url).searchParams.get("file_id");
      if (!fileId) {
        throw new Error("Authenticated attachment URL is missing file_id");
      }
      const result = await accept(
        get(apiClient$)(webFilesContract).fileUrl({
          query: { file_id: fileId },
          fetchOptions: { signal, cache: "no-store" },
        }),
        [200],
        signal,
      );
      return {
        kind: "managed",
        resourceUrl: result.body.url,
        downloadUrl: result.body.downloadUrl,
        hosted: false,
      };
    }
    return { kind: "unmanaged", resourceUrl: url, hosted: false };
  },
);
