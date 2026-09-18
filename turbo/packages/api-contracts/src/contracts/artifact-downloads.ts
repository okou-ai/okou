import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { hostedSiteFilesResponseSchema } from "./host";

const c = initContract();
const pathParams = z.object({
  reference: z
    .string()
    .regex(/^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};

export const artifactDownloadResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    url: z.url(),
    filename: z.string(),
    contentType: z.string(),
  }),
  z.object({ kind: z.literal("html"), site: hostedSiteFilesResponseSchema }),
]);
export type ArtifactDownloadResponse = z.infer<
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
