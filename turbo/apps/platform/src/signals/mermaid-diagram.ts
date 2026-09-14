import { command, computed, state, type Command, type Computed } from "ccstate";
import type { Element, Root } from "hast";
import mermaid from "@okouai/mermaid-lite";

import { createObjectUrlResource } from "./object-url-resource.ts";
import { theme$ } from "./theme.ts";
import { NEVER_RESOLVED_PROMISE, settle } from "./utils.ts";

/**
 * Mermaid diagrams render through a pull model. Each diagram source owns one
 * `MermaidDiagramSignals` in the registry of the surface showing it; its
 * `diagram$` computed lays the diagram out and resolves to an image the view
 * shows in an `<img>` — or to `null` when the parser rejects the source, in
 * which case the fence simply stays a code block. Reading the theme inside the
 * computed makes a theme switch re-render every diagram without any
 * remounting.
 *
 * The command that parses a tree registers each diagram and embeds the
 * returned signals on the marker node, so rendering receives the signals
 * object directly and never resolves diagrams by key.
 *
 * Each resolved theme has one blob URL owned by the surface lifetime the
 * registry (or a preview tree) supplies. The light/dark cache is a hard
 * two-entry bound, so switching themes reuses the prior rendering instead of
 * stranding another blob.
 */
export interface MermaidDiagramImage {
  readonly url: string;
  readonly file: File;
}

export interface MermaidDiagramSignals {
  readonly code: string;
  /** Resolves `null` when the source is not a supported Mermaid diagram. */
  readonly diagram$: Computed<Promise<MermaidDiagramImage | null>>;
}

// Declared here rather than in the parse pipeline: the pipeline emits only
// `data.mermaid` ({code}), and this field is written by the signals layer
// afterwards, by `embedMermaidSignals`.
declare module "hast" {
  interface Data {
    mermaidSignals?: MermaidDiagramSignals;
  }
}

/**
 * Resolve every mermaid marker in a freshly parsed tree to its diagram
 * signals and embed them on the node. Rendering then receives the signals
 * object from the tree, the same way cards do.
 */
export function embedMermaidSignals(
  tree: Root,
  resolve: (code: string) => MermaidDiagramSignals,
): void {
  const visitNode = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== "element") {
        continue;
      }
      const mermaid = child.data?.mermaid;
      if (mermaid !== undefined) {
        child.data = { ...child.data, mermaidSignals: resolve(mermaid.code) };
        continue;
      }
      visitNode(child);
    }
  };
  visitNode(tree);
}

/**
 * mermaid needs a DOM id per `render` call. Concurrent renders only happen for
 * distinct code+theme pairs — the same pair is one deduplicated computed — so
 * a deterministic hash of both is collision-free where it matters.
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

/** Returns the diagram SVG, or undefined when the diagram type is unsupported. */
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

// `mermaid.initialize` mutates module-global configuration, so an
// initialize+render pair must not interleave with another pair: a theme flip
// mid-render would otherwise re-initialize mermaid and the in-flight render
// would produce — and permanently cache — the other theme's SVG under its own
// theme key. The queue holds the tail of one render chain; each render settles
// the pair before it (a failed render must not break the chain) and becomes
// the new tail.
const mermaidRenderQueue$ = computed((): { tail: Promise<unknown> } => {
  return { tail: Promise.resolve() };
});

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
 * Lay out one diagram and return it as an SVG file. Pure: the caller decides
 * which lifetime owns the blob URL made from it.
 */
async function renderDiagramFile(
  renderQueue: { tail: Promise<unknown> },
  theme: "light" | "dark",
  code: string,
): Promise<File | null> {
  // Read the tail and replace it in the same synchronous block, so two
  // resuming renders cannot both chain onto the same predecessor.
  const previousRender = renderQueue.tail;
  const render = (async (): Promise<string | undefined> => {
    await settle(previousRender);
    mermaid.initialize({
      startOnLoad: false,
      // "strict" makes mermaid sanitize the generated SVG with DOMPurify
      // and disables click handlers declared inside diagram sources.
      securityLevel: "strict",
      // Without this mermaid injects its own error diagram into the
      // document.
      suppressErrorRendering: true,
      theme: theme === "dark" ? "redux-dark" : "redux",
      // Resolved to a concrete stack rather than passed as `var(...)`: the
      // same SVG is also shown inside an <img> in the lightbox, where
      // page-level CSS custom properties do not resolve.
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-family-sans")
        .trim(),
      // mermaid's defaults are sized for a standalone page: 16px labels
      // and 50px rank spacing make a five-node flowchart taller than the
      // message around it. These match the chat body text and cut roughly
      // a third of the height.
      themeVariables: { fontSize: "14px" },
      flowchart: { nodeSpacing: 30, rankSpacing: 32, padding: 8 },
    });
    return renderDiagramSvg(diagramRenderId(`${theme}:${code}`), code);
  })();
  renderQueue.tail = render;
  const markup = await render;
  if (markup === undefined) {
    return null;
  }

  // Parsed in a detached element. The markup never reaches the document,
  // so the only thing that ever shows it is an <img>, where a blob URL SVG
  // cannot run scripts or resolve page-level CSS custom properties.
  const host = document.createElement("div");
  host.innerHTML = markup;
  const svg = host.querySelector("svg");
  if (!svg) {
    throw new Error("mermaid renderer produced no svg");
  }

  const serialized = sizeDiagramAndSerialize(svg);
  return svgFile(serialized);
}

/**
 * Pure factory for a diagram's signals on a surface that renders every
 * diagram it holds. `ownerSignal` owns the blob URL. Virtualized surfaces use
 * `MermaidDiagramRegistry`, which prepares only what is on screen.
 */
export function createMermaidDiagramSignals(
  code: string,
  ownerSignal: AbortSignal,
): MermaidDiagramSignals {
  const imagesByTheme = new Map<
    "light" | "dark",
    Promise<MermaidDiagramImage | null>
  >();
  // eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
  const diagram$ = computed((get): Promise<MermaidDiagramImage | null> => {
    const theme = get(theme$);
    const existing = imagesByTheme.get(theme);
    if (existing !== undefined) {
      return existing;
    }
    const renderQueue = get(mermaidRenderQueue$);
    const image = (async (): Promise<MermaidDiagramImage | null> => {
      const file = await renderDiagramFile(renderQueue, theme, code);
      if (file === null) {
        return null;
      }
      const resource = createObjectUrlResource(file, ownerSignal);
      // A short blob URL keeps the multi-kilobyte SVG out of the `src`
      // attribute, avoiding the measured per-mount string assignment cost.
      return { url: resource.url, file };
    })();
    imagesByTheme.set(theme, image);
    return image;
  });
  return { code, diagram$ };
}

export interface MermaidDiagramRegistry {
  /** Get-or-create by diagram source; idempotent per source. */
  readonly register$: Command<MermaidDiagramSignals, [string]>;
  /**
   * Lay out every diagram the surface currently shows and publish it. Each
   * blob URL is owned by `signal`: when it aborts the URL is revoked and its
   * entry dropped, so a later pass prepares the diagram again.
   */
  readonly ensureDiagrams$: Command<
    Promise<void>,
    [readonly string[], AbortSignal]
  >;
}

/**
 * A per-surface registry keyed by diagram source. `register$` hands the parse
 * command a signals object to embed on the marker node; it allocates nothing.
 * `ensureDiagrams$` lays the diagrams out and owns their blob URLs through the
 * signal of the run that prepared them, so a diagram outlives the parse that
 * produced it but not the surface that showed it.
 */
export function createMermaidDiagramRegistry(): MermaidDiagramRegistry {
  // Keyed by theme and source. The source itself is the key rather than a
  // digest of it: a non-cryptographic hash that collided would show one
  // diagram in place of another, and entries are bounded by what is on screen.
  const internalImages$ = state<
    ReadonlyMap<string, MermaidDiagramImage | null>
  >(new Map());
  const internalSignals$ = state<ReadonlyMap<string, MermaidDiagramSignals>>(
    new Map(),
  );

  const imageKey = (theme: "light" | "dark", code: string): string => {
    return `${theme}\n${code}`;
  };

  const register$ = command(
    ({ get, set }, code: string): MermaidDiagramSignals => {
      const existing = get(internalSignals$).get(code);
      if (existing !== undefined) {
        return existing;
      }
      const diagram$ = computed((get): Promise<MermaidDiagramImage | null> => {
        const image = get(internalImages$).get(imageKey(get(theme$), code));
        // Nothing prepared yet keeps the view on its reserved placeholder.
        return image === undefined
          ? (NEVER_RESOLVED_PROMISE as Promise<MermaidDiagramImage | null>)
          : Promise.resolve(image);
      });
      const signals: MermaidDiagramSignals = { code, diagram$ };
      const next = new Map(get(internalSignals$));
      next.set(code, signals);
      set(internalSignals$, next);
      return signals;
    },
  );

  const publishImage$ = command(
    ({ get, set }, key: string, image: MermaidDiagramImage | null): void => {
      const next = new Map(get(internalImages$));
      next.set(key, image);
      set(internalImages$, next);
    },
  );

  const dropImage$ = command(({ get, set }, key: string): void => {
    const current = get(internalImages$);
    if (!current.has(key)) {
      return;
    }
    const next = new Map(current);
    next.delete(key);
    set(internalImages$, next);
  });

  const ensureDiagrams$ = command(
    async (
      { get, set },
      codes: readonly string[],
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const theme = get(theme$);
      const pending = new Set(
        codes.filter((code) => {
          return !get(internalImages$).has(imageKey(theme, code));
        }),
      );
      for (const code of pending) {
        const key = imageKey(theme, code);
        const file = await renderDiagramFile(
          get(mermaidRenderQueue$),
          theme,
          code,
        );
        signal.throwIfAborted();
        if (file === null) {
          set(publishImage$, key, null);
          continue;
        }
        const resource = createObjectUrlResource(file, signal);
        signal.addEventListener(
          "abort",
          () => {
            set(dropImage$, key);
          },
          { once: true },
        );
        // A short blob URL keeps the multi-kilobyte SVG out of the `src`
        // attribute, avoiding the measured per-mount string assignment cost.
        set(publishImage$, key, { url: resource.url, file });
      }
    },
  );

  return { register$, ensureDiagrams$ };
}
