import mermaid from "@okouai/mermaid-lite";

// Mermaid's configuration and parse/render queue belong to its module instance.
// Configure that instance once at module evaluation, before any layout starts.
// Keep this adapter statically imported with the rest of the application.
mermaid.initialize({
  startOnLoad: false,
  // Sanitize the SVG and disable click handlers declared in diagram sources.
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: "base",
  fontFamily: "var(--font-family-sans)",
  themeVariables: {
    fontSize: "14px",
    background: "#ffffff",
    primaryColor: "#ffffff",
    primaryTextColor: "#000000",
    primaryBorderColor: "#000000",
    secondaryColor: "#ffffff",
    tertiaryColor: "#ffffff",
    lineColor: "#000000",
    noteBkgColor: "#ffffff",
    noteTextColor: "#000000",
  },
  // Match the chat body text and keep diagrams compact within a message.
  flowchart: { nodeSpacing: 30, rankSpacing: 32, padding: 8 },
});

/**
 * Mermaid needs a DOM id for its temporary render elements. Mermaid serializes
 * renders in its module-owned queue, so a deterministic source hash can be
 * reused across surfaces.
 */
function diagramRenderId(seed: string): string {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 33) ^ seed.charCodeAt(index);
  }
  return `mermaid-diagram-${(hash >>> 0).toString(36)}`;
}

// `flowchart-v2` is Mermaid's internal ID for its modern Flowchart renderer,
// not a separate user-facing diagram syntax.
const SUPPORTED_DIAGRAM_TYPES: ReadonlySet<string> = new Set([
  "flowchart",
  "flowchart-v2",
  "sequence",
]);

/**
 * The SDK queues parse/render and resets source configuration per operation.
 * Initialization cannot interleave with them, so no application queue is needed.
 * Return undefined when the source is invalid or its type is unsupported.
 */
async function renderDiagramSvg(
  id: string,
  code: string,
): Promise<string | undefined> {
  const parsed = await mermaid.parse(code, { suppressErrors: true });
  if (!parsed || !SUPPORTED_DIAGRAM_TYPES.has(parsed.diagramType)) {
    return undefined;
  }
  const { svg } = await mermaid.render(id, code);
  return svg;
}

/**
 * Intrinsic width of the serialized copy. Expanded preview surfaces fit an
 * image into their stage but never scale it above 100%, so a diagram serialized
 * at chat size would open as a thumbnail. SVG is vector, so the enlarged copy
 * stays sharp while the preview scales it down to fit like any other image.
 */
const EXPANDED_SVG_WIDTH = 1600;

function viewBoxSize(
  svg: SVGSVGElement,
): { readonly width: number; readonly height: number } | undefined {
  const viewBox = (svg.getAttribute("viewBox") ?? "").split(/\s+/);
  const width = Number(viewBox[2]);
  const height = Number(viewBox[3]);
  if (!(width > 0) || !(height > 0)) {
    return undefined;
  }
  return { width, height };
}

function setSvgSize(svg: SVGSVGElement, width: number, height: number): void {
  svg.setAttribute("width", String(Math.round(width)));
  svg.setAttribute("height", String(Math.round(height)));
}

/**
 * mermaid sizes its SVG with `width="100%"` plus an inline `max-width`, which an
 * <img> cannot resolve — an expanded preview would stretch the diagram to the
 * stage width. The markup therefore gets an explicit preview-scale pixel size.
 * SVG is vector, so the same copy serves the box in the message, which scales
 * it down, and the lightbox or sidebar, which shows it at full size.
 */
function sizeDiagramAndSerialize(svg: SVGSVGElement): string {
  svg.style.maxWidth = "";
  // Layout inherits the app font from the page. Save its concrete value in
  // the SVG too: an <img> or downloaded file cannot inherit page variables.
  svg.style.setProperty(
    "--font-family-sans",
    getComputedStyle(document.documentElement)
      .getPropertyValue("--font-family-sans")
      .trim(),
  );
  // Keep the same opaque canvas in chat, expanded previews, and downloads.
  svg.style.backgroundColor = "#ffffff";
  const size = viewBoxSize(svg);
  if (!size) {
    return new XMLSerializer().serializeToString(svg);
  }

  const scale = Math.max(1, EXPANDED_SVG_WIDTH / size.width);
  setSvgSize(svg, size.width * scale, size.height * scale);
  return new XMLSerializer().serializeToString(svg);
}

/**
 * Keep the rendered SVG as a browser-native file so preview surfaces can
 * present it as diagram.svg with download metadata.
 */
function svgFile(markup: string): File {
  return new File([markup], "diagram.svg", { type: "image/svg+xml" });
}

/**
 * Lay out one diagram through Mermaid's shared DOM renderer, then serialize a
 * self-contained SVG file. Mounted consumers allocate their own object URLs.
 */
export async function renderMermaidDiagramFile(
  code: string,
): Promise<File | null> {
  const markup = await renderDiagramSvg(diagramRenderId(code), code);
  if (markup === undefined) {
    return null;
  }

  // Parse the returned markup in a detached element for serialization. The
  // displayed copy is an <img>, where SVG scripts cannot run and page-level
  // CSS custom properties are unavailable.
  const host = document.createElement("div");
  host.innerHTML = markup;
  const svg = host.querySelector("svg");
  if (!svg) {
    throw new Error("mermaid renderer produced no svg");
  }

  const serialized = sizeDiagramAndSerialize(svg);
  return svgFile(serialized);
}
