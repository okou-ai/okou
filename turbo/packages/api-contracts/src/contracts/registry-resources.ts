import { literal, number, object, string, url } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const registryResourceDownloadContract = c.router({
  downloadPresentationTemplate: {
    method: "GET",
    path: "/api/registry/presentation-templates/download",
    headers: authHeadersSchema,
    query: object({
      id: string().min(1, "Resource id is required"),
    }),
    responses: {
      200: object({
        url: url(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get the current presentation template archive",
  },
  download: {
    method: "GET",
    path: "/api/registry/resources/download",
    headers: authHeadersSchema,
    query: object({
      id: string().min(1, "Resource id is required"),
      expectedSha256: string().regex(/^[a-f0-9]{64}$/),
    }),
    responses: {
      200: object({
        url: url(),
        id: string(),
        type: literal("tar.gz"),
        sha256: string().regex(/^[a-f0-9]{64}$/),
        expiresInSeconds: number().int().positive(),
        versionId: string(),
        fileCount: number().int().nonnegative(),
        size: number().nonnegative(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get a presigned URL for a private registry resource archive",
  },
});

export type RegistryResourceDownloadContract =
  typeof registryResourceDownloadContract;
