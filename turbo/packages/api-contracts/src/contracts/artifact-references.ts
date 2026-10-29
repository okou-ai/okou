import {
  literal,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
  url as zUrl,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const REFERENCE_PATH =
  /^\/artifacts\/([a-f0-9]{32}|[a-z0-9]{10})(\.[a-z0-9]{1,12})?(#[^\s]*)?$/u;

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

export function artifactReferencePath(id: string, filename?: string): string {
  const hash = uuid().parse(id).replaceAll("-", "").toLowerCase();
  const extension =
    filename?.toLowerCase().match(/\.[a-z0-9]{1,12}$/u)?.[0] ?? "";
  return `/artifacts/${hash}${extension}`;
}

/** A reference is an identity, never a byte-access credential. */
export function parseArtifactReference(value: string, appOrigin?: string) {
  let path = value;
  if (!value.startsWith("/artifacts/")) {
    if (!appOrigin || !zUrl().safeParse(value).success) return null;
    const url = new URL(value);
    if (
      url.origin !== new URL(appOrigin).origin ||
      url.username ||
      url.password ||
      url.search
    )
      return null;
    path = `${url.pathname}${url.hash}`;
  }
  const match = REFERENCE_PATH.exec(path);
  if (!match?.[1]) return null;
  const hash = match[1];
  if (hash.length === 10) {
    return {
      id: null,
      hash,
      extension: match[2] ?? "",
      fragment: match[3] ?? "",
    };
  }
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
  if (!uuid().safeParse(id).success) return null;
  return { id, hash, extension: match[2] ?? "", fragment: match[3] ?? "" };
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
