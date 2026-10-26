import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { escapeUTF8 } from "entities/escape";
import type { z } from "zod";
import type { hostedSitePresentationSchema } from "@okouai/api-contracts/contracts/hosted-site-access";
import {
  hostedSiteBannerCsp,
  injectHostedSiteBanner,
} from "@okouai/core/hosted-site-banner";
import {
  ArtifactBanner,
  HostedSiteBannerActions,
} from "@okouai/ui/components/ui/artifact-banner";
import assets from "./site-banner-assets.json";

type Presentation = z.infer<typeof hostedSitePresentationSchema>;

/** Fetch destination is a presentation hint only; it never establishes access. */
export function standaloneSiteDocument(request: Request) {
  const destination = request.headers.get("Sec-Fetch-Dest");
  return (
    request.method === "GET" &&
    (destination === "document" ||
      (!destination &&
        request.headers.get("Accept")?.includes("text/html") === true))
  );
}

export async function withSiteBanner(
  request: Request,
  response: Response,
  presentation: Presentation | undefined,
  authUrl: string | undefined,
): Promise<Response> {
  if (
    !presentation?.showBanner ||
    !standaloneSiteDocument(request) ||
    response.status !== 200 ||
    !response.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("text/html") ||
    response.headers
      .get("Content-Disposition")
      ?.toLowerCase()
      .startsWith("attachment")
  )
    return response;
  const encoding = response.headers.get("Content-Encoding")?.toLowerCase();
  // A presentation feature must leave other document encodings intact.
  if (encoding && !["identity", "gzip", "deflate"].includes(encoding))
    return response;
  if (!authUrl) throw new Error("Site banner App origin is not configured");
  const home = new URL("/", authUrl);
  if (home.protocol !== "https:" || home.origin === new URL(request.url).origin)
    throw new Error("Invalid Site banner App origin");
  const continueUrl = new URL(home);
  continueUrl.searchParams.set(
    "prompt",
    `Help me work with this artifact: ${presentation.siteUrl}`,
  );
  continueUrl.searchParams.set("utm_source", "hosted_site");
  continueUrl.searchParams.set("utm_medium", "artifact_banner");
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  );
  const markup = await renderToReadableStream(
    createElement(ArtifactBanner, {
      title: presentation.title,
      titleAs: "p",
      subtitle: "Website",
      homeUrl: home.href,
      brandName: "Okou",
      brandMark: createElement("img", {
        src: "https://static.okou.io/public/okou-logo-wordmark-dark-8ac16c9eb76d.svg",
        width: 60,
        height: 16,
        alt: "Okou",
        referrerPolicy: "no-referrer",
        className: "block h-auto",
      }),
      children: createElement(HostedSiteBannerActions, {
        continueUrl: continueUrl.href,
      }),
    }),
    { signal: request.signal },
  );
  const chrome = await new Response(markup).text();
  const siteUrl = escapeUTF8(presentation.siteUrl);
  const banner = `<style nonce="${nonce}">#okou-site-banner{all:initial;position:fixed;inset:0 0 auto;z-index:2147483646;display:block;height:56px;font:14px/1.5 system-ui,sans-serif}#okou-site-banner-space{all:initial;display:block;height:56px}:fullscreen #okou-site-banner,:fullscreen #okou-site-banner-space{display:none}</style><div id="okou-site-banner-space" aria-hidden="true"></div><div id="okou-site-banner" data-site-url="${siteUrl}" data-theme="light"><template shadowrootmode="open"><style nonce="${nonce}">${assets.css}</style>${chrome}</template></div><script nonce="${nonce}">${assets.script}</script>`;
  let body = response.body;
  if (body && (encoding === "gzip" || encoding === "deflate")) {
    body = body.pipeThrough(new DecompressionStream(encoding));
  }
  const original = await new Response(body).text();
  const siteOrigin = new URL(request.url).origin;
  const html = injectHostedSiteBanner(original, banner, nonce, siteOrigin);
  const headers = new Headers(response.headers);
  for (const key of ["Content-Length", "ETag", "Content-Encoding"])
    headers.delete(key);
  const csp = headers.get("Content-Security-Policy");
  if (csp)
    headers.set(
      "Content-Security-Policy",
      hostedSiteBannerCsp(csp, nonce, siteOrigin),
    );
  headers.set("Cache-Control", "private, no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  return new Response(html, { status: response.status, headers });
}
