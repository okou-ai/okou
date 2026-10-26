import {
  discriminatedUnion,
  literal,
  object,
  string,
  url,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { hostedSiteFilesResponseSchema } from "./host";

const c = initContract();
const pathParams = object({
  reference: string().regex(
    /^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u,
  ),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};

export const artifactDownloadResponseSchema = discriminatedUnion("kind", [
  object({
    kind: literal("file"),
    url: url(),
    filename: string(),
    contentType: string(),
  }),
  object({ kind: literal("html"), site: hostedSiteFilesResponseSchema }),
]);
export type ArtifactDownloadResponse = zInfer<
  typeof artifactDownloadResponseSchema
>;

export const artifactDownloadsContract = c.router({
  download: {
    method: "GET",
    path: "/api/artifact-references/:reference/download",
    headers: authHeadersSchema,
    pathParams,
    responses: {
      200: artifactDownloadResponseSchema,
      ...errors,
    },
    summary:
      "Download every file of an artifact visible to the authenticated user",
  },
  files: {
    method: "GET",
    path: "/api/artifact-references/:reference/files",
    headers: authHeadersSchema,
    pathParams,
    responses: {
      200: hostedSiteFilesResponseSchema,
      ...errors,
    },
    summary:
      "Clone every file of a hosted artifact visible to the authenticated user",
  },
});
