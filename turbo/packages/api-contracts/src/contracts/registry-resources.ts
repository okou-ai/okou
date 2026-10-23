import * as z from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const registryResourceDownloadContract = c.router({
  downloadPresentationTemplate: {
    method: "GET",
    path: "/api/registry/presentation-templates/download",
    headers: authHeadersSchema,
    query: z.object({
      id: z.string().min(1, "Resource id is required"),
    }),
    responses: {
      200: z.object({
        url: z.url(),
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
    query: z.object({
      id: z.string().min(1, "Resource id is required"),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    responses: {
      200: z.object({
        url: z.url(),
        id: z.string(),
        type: z.literal("tar.gz"),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        expiresInSeconds: z.number().int().positive(),
        versionId: z.string(),
        fileCount: z.number().int().nonnegative(),
        size: z.number().nonnegative(),
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
