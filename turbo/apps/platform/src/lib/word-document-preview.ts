import { renderAsync } from "docx-preview";
import { array, object, string } from "zod";
import { fetchResource } from "./resource-fetch.ts";

const renderedWordSchema = object({
  documentPart: object({
    rels: array(object({ type: string() })).nullable(),
  }),
});

/** Render untrusted Word content into an isolated, script-free document. */
export async function loadWordDocumentPreview(url: string): Promise<string> {
  const response = await fetchResource(url, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`Failed to load Word document (${response.status})`);
  }
  const data = await response.arrayBuffer();
  const preview = document.implementation.createHTMLDocument();
  const result: unknown = await renderAsync(data, preview.body, preview.head, {
    useBase64URL: true,
    renderAltChunks: false,
    ignoreLastRenderedPageBreak: false,
  });
  const word = renderedWordSchema.parse(result);
  if (
    word.documentPart.rels?.some((relationship) => {
      return relationship.type.endsWith("/aFChunk");
    })
  ) {
    // HTML-import documents require Word's original viewer. Do not silently
    // show a partial document after excluding those active HTML parts.
    throw new Error("Word preview requires the original HTML-import viewer");
  }

  // The renderer owns document styles. Keep them and embedded assets inside
  // the sandbox, without executing macros/HTML chunks or fetching remote CSS.
  const policy = preview.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; form-action 'none'";
  preview.head.prepend(policy);
  for (const link of preview.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      continue;
    }
    if (
      !URL.canParse(href) ||
      !["https:", "http:", "mailto:", "tel:"].includes(new URL(href).protocol)
    ) {
      link.removeAttribute("href");
      continue;
    }
    // A navigation in this iframe would replace the document whose gestures
    // we own. External links retain normal browser behavior in another tab.
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return `<!doctype html>${preview.documentElement.outerHTML}`;
}
