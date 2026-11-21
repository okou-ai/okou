import { createHash } from "node:crypto";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { HttpResponse } from "msw";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
export const publication = "https://launch-site.okou.app/";
export const entryHtml =
  '<!DOCTYPE html><link rel="stylesheet" href="/assets/site.css"><h1>Field notebook</h1><img src="/assets/cat.png">';
export const stylesheet = "h1 { color: maroon; }";
export const catPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8i8AAAAASUVORK5CYII=",
    "base64",
  ),
);
export function servePublication(
  context: TestContext,
  mode:
    | "directory"
    | "single"
    | "missing"
    | "server-error"
    | "broken-css"
    | "image-route" = "directory",
) {
  const files = [
    {
      path: "/index.html",
      bytes: new TextEncoder().encode(entryHtml),
      contentType: "text/html",
    },
    {
      path: "/assets/site.css",
      bytes: new TextEncoder().encode(stylesheet),
      contentType: "text/css",
    },
    {
      path: mode === "image-route" ? "/image" : "/assets/cat.png",
      bytes: catPng,
      contentType: "image/png",
    },
  ].slice(0, mode === "single" ? 1 : 3);
  context.mocks.api(hostContract.sitePreview, ({ params, query, respond }) => {
    if (
      params.publicSlug !== "launch-site" ||
      query.hostname !== new URL(publication).hostname
    ) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown preview alias" },
      });
    }
    return respond(200, { url: publication, expiresAt: null });
  });
  context.mocks.api(hostContract.files, ({ params, query, respond }) => {
    if (
      params.publicSlug !== "launch-site" ||
      query.hostname !== new URL(publication).hostname
    ) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown site alias" },
      });
    }
    if (mode === "missing" || mode === "server-error") {
      return respond(mode === "missing" ? 404 : 500, {
        error: { code: "LIST_UNAVAILABLE", message: "Publication unavailable" },
      });
    }
    return respond(200, {
      siteId: crypto.randomUUID(),
      deploymentId: crypto.randomUUID(),
      publicSlug: "launch-site",
      url: publication,
      fileCount: files.length,
      size: files.reduce((n, f) => {
        return n + f.bytes.length;
      }, 0),
      files: files.map((f) => {
        return {
          path: f.path,
          contentType: f.contentType,
          size: f.bytes.length,
          sha256: createHash("sha256").update(f.bytes).digest("hex"),
          downloadUrl: new URL(f.path, publication).href,
        };
      }),
    });
  });
  for (const f of files) {
    context.mocks.http.get(new URL(f.path, publication).href, () => {
      return mode === "broken-css" && f.path.endsWith(".css")
        ? new HttpResponse(null, { status: 404 })
        : new HttpResponse(f.bytes, {
            headers: { "content-type": f.contentType },
          });
    });
  }
  context.mocks.http.get(publication, () => {
    return HttpResponse.html(entryHtml);
  });
  context.mocks.http.get(publication + "image/", () => {
    return new HttpResponse(catPng, {
      headers: { "content-type": "image/png" },
    });
  });
}
