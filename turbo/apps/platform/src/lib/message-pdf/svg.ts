const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);/iu;
const ACTIVE_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "audio",
  "video",
  "animate",
  "animatetransform",
  "animatemotion",
  "set",
  "discard",
]);

function selfContainedReference(value: string): boolean {
  return value.startsWith("#") || RASTER_DATA_URL.test(value);
}

function validateCss(value: string): void {
  const css = value.replace(/\/\*[\s\S]*?\*\//gu, "");
  // Escaped CSS identifiers can conceal url/import. Reject those instead of
  // trying to implement another CSS parser at this trust boundary.
  if (css.includes("\\") || css.includes("@")) {
    throw new Error("PDF SVG image contains unsupported CSS dependencies");
  }
  for (const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)) {
    if (!selfContainedReference(match[2]?.trim() ?? "")) {
      throw new Error("PDF SVG image must not load external resources");
    }
  }
}

function validateSvgElement(element: Element): void {
  if (ACTIVE_ELEMENTS.has(element.localName.toLowerCase())) {
    throw new Error("PDF SVG image contains active content");
  }
  if (element.localName === "style") {
    validateCss(element.textContent);
  }
  for (const attribute of element.attributes) {
    const name = attribute.localName.toLowerCase();
    const value = attribute.value.trim();
    if (name.startsWith("on") || name === "srcset" || name === "base") {
      throw new Error("PDF SVG image contains active attributes");
    }
    if (["href", "src"].includes(name) && !selfContainedReference(value)) {
      throw new Error("PDF SVG image must be self-contained");
    }
    if (name === "style" || /url\(/iu.test(value)) {
      validateCss(value);
    }
  }
}

function sizeSvg(root: Element): void {
  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/u)
    .map(Number);
  const width = box[2];
  const height = box[3];
  if (width && height && width > 0 && height > 0) {
    if (
      !root.getAttribute("width") ||
      root.getAttribute("width")?.endsWith("%")
    ) {
      root.setAttribute("width", String(width));
    }
    if (
      !root.getAttribute("height") ||
      root.getAttribute("height")?.endsWith("%")
    ) {
      root.setAttribute("height", String(height));
    }
  }
}

/**
 * Decode authored SVG only as an inert browser image. Reject active content
 * and external dependencies rather than silently dropping visible content.
 */
export async function prepareSvgImage(
  blob: Blob,
  signal: AbortSignal,
): Promise<Blob> {
  const source = await blob.text();
  signal.throwIfAborted();
  const xml = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = xml.documentElement;
  const instruction = xml
    .createTreeWalker(xml, NodeFilter.SHOW_PROCESSING_INSTRUCTION)
    .nextNode();
  if (
    root.localName !== "svg" ||
    xml.querySelector("parsererror") ||
    xml.doctype ||
    instruction
  ) {
    throw new Error(
      "PDF SVG image is invalid or contains external declarations",
    );
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    validateSvgElement(element);
  }
  sizeSvg(root);
  return new Blob([new XMLSerializer().serializeToString(root)], {
    type: "image/svg+xml",
  });
}
