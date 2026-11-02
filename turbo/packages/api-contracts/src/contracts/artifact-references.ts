import {
  literal,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
  url as zUrl,
} from "zod";
import { parseArtifactReference } from "../validators/artifact-references";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export {
  artifactReferencePath,
  parseArtifactReference,
} from "../validators/artifact-references";

export function artifactShareReferencePath(
  reference: string,
  filename: string,
): string {
  const hash = string()
    .regex(/^[a-z0-9]{10}$/u)
    .parse(reference);
  const extension =
    filename.toLowerCase().match(/\.[a-z0-9]{1,12}$/u)?.[0] ?? "";
  return `/artifacts/${hash}${extension}`;
}

export const artifactReferenceSchema = string().refine((value) => {
  return parseArtifactReference(value) !== null;
}, "Expected a hostless artifact reference");
export const artifactUrlSchema = union([zUrl(), artifactReferenceSchema]);

const c = initContract();
export const artifactReferencesContract = c.router({
  ownerArtifact: {
    method: "GET",
    path: "/api/artifact-references/:reference/owner-artifact",
    headers: authHeadersSchema,
    pathParams: object({
      reference: string().regex(
        /^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u,
      ),
    }),
    responses: {
      200: object({ artifactId: uuid() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Resolve an artifact reference to its owner's catalog entry",
  },
  read: {
    method: "GET",
    path: "/api/artifact-references/:reference/read",
    headers: authHeadersSchema,
    pathParams: object({
      reference: string().regex(
        /^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u,
      ),
    }),
    responses: {
      200: object({
        url: zUrl(),
        filename: string(),
        contentType: string(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Authorize artifact content using owner, organization, or public access",
  },
  publicUrl: {
    method: "GET",
    path: "/api/artifact-references/:reference/public",
    pathParams: object({
      reference: string().regex(
        /^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u,
      ),
    }),
    responses: {
      200: object({
        url: zUrl(),
        expiresAt: string().optional(),
        downloadUrl: zUrl(),
        sharedThreadSnapshot: literal(true).optional(),
        preview: object({
          filename: string(),
          contentType: string(),
          previewImageUrl: zUrl().optional(),
        }),
      }),
      400: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Resolve a public artifact or active conversation snapshot to its content URL and preview metadata",
  },
  resolve: {
    method: "GET",
    path: "/api/artifact-references/:reference",
    headers: authHeadersSchema,
    // Typed resolution is owner-only for management, cloning, and generation.
    // Agent downloads use read to authorize shared content as well.
    query: object({ kind: zEnum(["file", "html", "artifact"]).optional() }),
    pathParams: object({
      reference: string().regex(
        /^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u,
      ),
    }),
    responses: {
      200: object({
        url: zUrl(),
        expiresAt: string(),
        downloadUrl: zUrl(),
        sharedThreadSnapshot: literal(true).optional(),
        filename: string(),
        contentType: string(),
        previewImageUrl: artifactUrlSchema.optional(),
        target: object({ kind: zEnum(["file", "html"]), id: uuid() }),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Authorize an owner, organization, or active conversation snapshot reference and resolve temporary content",
  },
});
