import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const REFERENCE_PATH =
  /^\/artifacts\/([a-f0-9]{32}|[a-z0-9]{10})(\.[a-z0-9]{1,12})?(#[^\s]*)?$/u;

export function artifactShareReferencePath(
  reference: string,
  filename: string,
): string {
  const hash = z
    .string()
    .regex(/^[a-z0-9]{10}$/u)
    .parse(reference);
  const extension =
    filename.toLowerCase().match(/\.[a-z0-9]{1,12}$/u)?.[0] ?? "";
  return `/artifacts/${hash}${extension}`;
}

export function artifactReferencePath(id: string, filename?: string): string {
  const hash = z.uuid().parse(id).replaceAll("-", "").toLowerCase();
  const extension =
    filename?.toLowerCase().match(/\.[a-z0-9]{1,12}$/u)?.[0] ?? "";
  return `/artifacts/${hash}${extension}`;
}

/** A reference is an identity, never a byte-access credential. */
export function parseArtifactReference(value: string, appOrigin?: string) {
  let path = value;
  if (!value.startsWith("/artifacts/")) {
    if (!appOrigin || !z.url().safeParse(value).success) return null;
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
  if (!z.uuid().safeParse(id).success) return null;
  return { id, hash, extension: match[2] ?? "", fragment: match[3] ?? "" };
}

export const artifactReferenceSchema = z.string().refine((value) => {
  return parseArtifactReference(value) !== null;
}, "Expected a hostless artifact reference");
export const artifactUrlSchema = z.union([z.url(), artifactReferenceSchema]);

const c = initContract();
export const artifactReferencesContract = c.router({
  resolve: {
    method: "GET",
    path: "/api/artifact-references/:reference",
    headers: authHeadersSchema,
    // Agent consumers resolve only their own resource under its existing capability.
    query: z.object({ kind: z.enum(["file", "html"]).optional() }),
    pathParams: z.object({
      reference: z
        .string()
        .regex(/^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u),
    }),
    responses: {
      200: z.object({
        url: z.url(),
        expiresAt: z.string(),
        filename: z.string(),
        contentType: z.string(),
        target: z.object({ kind: z.enum(["file", "html"]), id: z.uuid() }),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Authorize an owner or organization artifact reference and resolve temporary content",
  },
});
