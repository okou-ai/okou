import { uuid, url as zUrl } from "zod";

const REFERENCE_PATH =
  /^\/artifacts\/([a-f0-9]{32}|[a-z0-9]{10})(\.[a-z0-9]{1,12})?(#[^\s]*)?$/u;

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
