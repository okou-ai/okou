import type { ConnectorCatalogArtifactConnector } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { providerUnavailable } from "../../lib/error";
import { iconForCatalog } from "./connector-catalog-external-reader.service";

// The slug can acquire a different immutable icon when a catalog is promoted or rolled back.
const CACHE_CONTROL = "public, max-age=300";

export async function connectorIconResponse(
  metadata: ConnectorCatalogArtifactConnector["icon"],
  signal: AbortSignal,
): Promise<Response | ReturnType<typeof providerUnavailable>> {
  const icon = iconForCatalog({ icon: metadata });
  if (!icon.invertInDarkMode && (icon.scale ?? 1) === 1) {
    return new Response(null, {
      status: 302,
      headers: { Location: icon.url, "Cache-Control": CACHE_CONTROL },
    });
  }

  // A standalone image has no access to the caller's catalog CSS. Keep its
  // centering and dark-mode treatment in the image, including for PNG marks.
  const source = await fetch(icon.url, { redirect: "error", signal });
  if (!source.ok) {
    return providerUnavailable("Connector icon is temporarily unavailable");
  }
  const contentType = icon.url.endsWith(".svg") ? "image/svg+xml" : "image/png";
  const bytes = Buffer.from(await source.arrayBuffer());
  signal.throwIfAborted();
  const size = 100 * (icon.scale ?? 1);
  const offset = (100 - size) / 2;
  const style = icon.invertInDarkMode
    ? "<style>@media(prefers-color-scheme:dark){image{filter:invert(1)}}</style>"
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${style}<image x="${offset}" y="${offset}" width="${size}" height="${size}" href="data:${contentType};base64,${bytes.toString("base64")}"/></svg>`;
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": CACHE_CONTROL,
      "Content-Security-Policy":
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
