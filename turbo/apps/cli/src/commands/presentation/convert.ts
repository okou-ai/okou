/**
 * okou presentation convert — turn an HTML deck into an editable .pptx.
 *
 * The geometry of a generated deck does not exist in its markup: shells size
 * type with a runtime autofit pass and lay out with container-query units, so
 * the only correct source of positions is a browser that has actually painted
 * the page. Conversion therefore happens inside the page itself — the same
 * browser session that settles the deck also emits the deck.
 *
 * A previous in-app exporter shipped this idea into the product bundle and was
 * retired for weight, not for approach: its renderer alone cost 2.7 MB of
 * JavaScript. Running it here removes that cost entirely, and adds the part the
 * browser build structurally could not have — the export can be checked against
 * its own source before anyone downloads it.
 */
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, extname, join } from "path";
import { crc32, deflateRawSync, inflateRawSync } from "zlib";

import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";

import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { browser, childPath, operatorPath, SETTLE, TIMEOUT_MS } from "./shared";

const RENDERER_PACKAGE = "dom-to-pptx@2.1.2";
const RENDERER_BUNDLE = "dom-to-pptx.bundle.js";
const RENDERER_CACHE_VERSION = "v1";
/**
 * The same published artifact as the cached copy, byte for byte. A borrowed
 * session may be driving a remote browser, which cannot read this machine's
 * filesystem, so the bundle has to come from somewhere that browser can reach.
 */
const RENDERER_CDN = `https://cdn.jsdelivr.net/npm/${RENDERER_PACKAGE}/dist/${RENDERER_BUNDLE}`;
const DEFAULT_VIEWPORT_WIDTH = 1600;
const DEFAULT_VIEWPORT_HEIGHT = 900;
const DEFAULT_SLIDE_WIDTH_IN = 13.333;
const DEFAULT_SLIDE_HEIGHT_IN = 7.5;
/** Retrieval chunk for the base64 deck; eval carries far more, this is headroom. */
const TRANSFER_CHUNK = 200_000;
/** Below this share of source text present in the deck, the export is broken. */
const TEXT_COVERAGE_FLOOR = 0.98;
/** A hosted deck may sit behind a redirect or bot check before it renders. */
const SLIDE_WAIT_MS = 30_000;
const SLIDE_POLL_MS = 1_000;

/**
 * Candidate slide containers, most specific first. Carried over from the
 * retired in-app exporter, which learned this order against real decks: a
 * generic `section` or `.slide` often wraps the page rather than being it.
 */
const SLIDE_SELECTORS = [
  "[data-okou-slide]",
  "[data-vm0-slide]",
  "[data-slide]",
  "[data-slide-index]",
  "[data-page]",
  ".stage",
  ".ppt-slide",
  ".presentation-slide",
  ".deck-slide",
  ".slide-page",
  ".slide",
  "section",
] as const;

/**
 * Collapses CSS the deck can draw but OOXML cannot express, so the export
 * degrades on our terms instead of the renderer's.
 *
 * A shape in OOXML carries one uniform corner radius. CSS per-corner elliptical
 * radii — the hand-drawn highlight pills these templates favour — have no
 * representation, and the renderer falls back to an ellipse sized to the
 * bounding box, which is both the wrong shape and far too large. Collapsing to
 * the nearest pill loses the wobble and keeps position, size, and editable text.
 */
const NORMALIZE = `(() => {
  const uniform = (value) => {
    const radii = value
      .split("/")[0]
      .trim()
      .split(/\\s+/u)
      .map((entry) => parseFloat(entry) || 0)
      .filter((entry) => entry > 0);
    return radii.length > 0 ? Math.min(...radii) : 0;
  };
  for (const element of document.querySelectorAll("*")) {
    const style = getComputedStyle(element);
    const radius = style.borderRadius;
    if (radius && (radius.includes("/") || new Set(radius.split(/\\s+/u)).size > 1)) {
      const collapsed = uniform(radius);
      if (collapsed > 0) {
        element.style.setProperty("border-radius", collapsed + "px", "important");
      }
    }
    // An inline highlight becomes its own shape. Letting it re-wrap inside that
    // shape is the most visible conversion defect, because the renderer's font
    // metrics never match the browser's exactly.
    if (style.display.startsWith("inline") && style.display !== "inline") {
      const background = style.backgroundColor;
      if (background && background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
        element.style.setProperty("white-space", "nowrap", "important");
      }
    }
  }
  return 1;
})()`;

/**
 * Prepares the live deck for export, carrying over the fixes the retired in-app
 * exporter accumulated against real decks. Each step exists because a deck
 * shipped without it lost something visible.
 *
 * Runs after NORMALIZE, because pinning line breaks must observe the wrapping
 * that the normalised styles actually produce.
 */
const PREPARE = `((selector) => {
  const slides = Array.from(document.querySelectorAll(selector));
  const ancestorsUntilBody = (node) => {
    const chain = [];
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== document.body) {
      chain.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    return chain;
  };

  // A scroll-snap deck keeps every slide but the active one hidden, and a
  // hidden slide exports as a blank page.
  const reveal = (element) => {
    if (getComputedStyle(element).display === "none") {
      element.style.setProperty("display", "block", "important");
    }
    element.style.setProperty("visibility", "visible", "important");
    element.style.setProperty("opacity", "1", "important");
    element.style.setProperty("clip-path", "none", "important");
    element.removeAttribute("hidden");
    element.removeAttribute("inert");
  };
  for (const slide of slides) {
    reveal(slide);
    for (const ancestor of ancestorsUntilBody(slide)) reveal(ancestor);
  }

  // A slide that paints no background of its own inherits one from an ancestor
  // on screen, but exports onto white.
  const transparent = (color) => {
    const value = (color || "").trim().toLowerCase();
    return value === "" || value === "transparent" || value.replace(/\\s/gu, "") === "rgba(0,0,0,0)";
  };
  const painted = (style) =>
    !transparent(style.backgroundColor) ||
    (style.backgroundImage && style.backgroundImage !== "none");
  for (const slide of slides) {
    if (painted(getComputedStyle(slide))) continue;
    const source = [...ancestorsUntilBody(slide), document.body, document.documentElement]
      .filter(Boolean)
      .map((element) => getComputedStyle(element))
      .find(painted);
    if (!source) continue;
    if (!transparent(source.backgroundColor)) {
      slide.style.setProperty("background-color", source.backgroundColor, "important");
    }
    if (source.backgroundImage && source.backgroundImage !== "none") {
      for (const property of ["image", "position", "repeat", "size"]) {
        const key = "background" + property.charAt(0).toUpperCase() + property.slice(1);
        slide.style.setProperty("background-" + property, source[key], "important");
      }
    }
  }

  // Corner rounding and margins on the page element survive into the export as
  // a shape inset from the slide edge.
  for (const slide of slides) {
    slide.style.setProperty("margin", "0", "important");
    slide.style.setProperty("border-radius", "0", "important");
    slide.style.setProperty("overflow", "hidden", "important");
  }

  // Pin the browser's line breaks. A pptx text frame re-wraps with the viewer's
  // font metrics, which never match the browser's exactly, so a line that just
  // fits here spills or clips there.
  const CJK = /[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af]/u;
  const breakCandidates = (text) => {
    const offsets = [];
    // Latin wraps at word starts; CJK has no spaces and wraps between glyphs.
    const words = /\\S+/gu;
    let match = words.exec(text);
    while (match) {
      offsets.push(match.index);
      match = words.exec(text);
    }
    if (CJK.test(text)) {
      for (let index = 0; index < text.length; index += 1) {
        if (CJK.test(text[index])) offsets.push(index);
      }
    }
    return [...new Set(offsets)].sort((left, right) => left - right);
  };
  const topAt = (node, offset) => {
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, Math.min(offset + 1, node.nodeValue.length));
    const rect = Array.from(range.getClientRects()).find((box) => box.width > 0 && box.height > 0);
    return rect ? rect.top : null;
  };

  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "SVG"]);
  const targets = [];
  for (const slide of slides) {
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      const text = node.nodeValue || "";
      if (parent && text.trim().length > 1 && !skip.has(parent.tagName)) {
        const style = getComputedStyle(parent);
        if (
          style.display !== "none" && style.visibility !== "hidden" &&
          style.whiteSpace !== "nowrap" && style.whiteSpace !== "pre"
        ) {
          // Only text that actually wrapped can gain a break, and checking the
          // rect count first avoids a per-character layout flush on the
          // single-line labels that make up most of a deck.
          const range = document.createRange();
          range.selectNodeContents(node);
          if (range.getClientRects().length > 1) targets.push(node);
        }
      }
      node = walker.nextNode();
    }
  }

  let inserted = 0;
  for (const node of targets) {
    const text = node.nodeValue || "";
    let previousTop = null;
    const breaks = [];
    for (const offset of breakCandidates(text)) {
      const top = topAt(node, offset);
      if (top === null) continue;
      if (previousTop !== null && Math.abs(top - previousTop) > 1 && offset > 0) {
        breaks.push(offset);
      }
      previousTop = top;
    }
    if (breaks.length === 0) continue;
    const parent = node.parentNode;
    if (!parent) continue;
    const fragment = document.createDocumentFragment();
    let start = 0;
    for (const offset of breaks) {
      fragment.append(document.createTextNode(text.slice(start, offset)));
      fragment.append(document.createElement("br"));
      start = offset;
    }
    fragment.append(document.createTextNode(text.slice(start)));
    parent.replaceChild(fragment, node);
    inserted += breaks.length;
  }
  return inserted;
})`;

interface Options {
  readonly input: string;
  readonly out?: string;
  readonly selector?: string;
  readonly session?: string;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly normalize: boolean;
  readonly wrap: boolean;
  readonly verify: boolean;
  readonly json?: boolean;
}

interface VerifyReport {
  readonly slides: number;
  readonly sourceStrings: number;
  readonly matchedStrings: number;
  readonly coverage: number;
  readonly missing: readonly string[];
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Expected a positive number, got ${value}`);
  }
  return parsed;
}

function rendererRoot(): string {
  const configured = process.env.XDG_CACHE_HOME?.trim();
  const cacheHome =
    configured === undefined || configured === ""
      ? join(homedir(), ".cache")
      : configured;
  return join(
    cacheHome,
    "okou",
    "presentation-convert",
    RENDERER_CACHE_VERSION,
  );
}

/**
 * Fetches the renderer's browser bundle and nothing else.
 *
 * Installing the package would also pull a second headless browser we already
 * have, so the tarball is unpacked for the single file that runs in the page.
 */
function ensureRenderer(): string {
  const root = rendererRoot();
  const bundle = childPath(root, RENDERER_BUNDLE);
  if (existsSync(bundle)) {
    return bundle;
  }
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "okou-renderer-"));
  try {
    process.stderr.write(`Fetching ${RENDERER_PACKAGE} (first run only)...\n`);
    execFileSync("npm", ["pack", RENDERER_PACKAGE, "--silent"], {
      cwd: staging,
      stdio: ["ignore", "ignore", process.stderr],
      timeout: TIMEOUT_MS,
    });
    const tarball = readdirSync(staging).find((name) => {
      return name.endsWith(".tgz");
    });
    if (tarball === undefined) {
      throw new Error(`npm pack produced no tarball in ${staging}`);
    }
    execFileSync(
      "tar",
      [
        "-xzf",
        childPath(staging, tarball),
        "-C",
        staging,
        "--strip-components=2",
        `package/dist/${RENDERER_BUNDLE}`,
      ],
      { stdio: ["ignore", "ignore", process.stderr], timeout: TIMEOUT_MS },
    );
    writeFileSync(bundle, readFileSync(childPath(staging, RENDERER_BUNDLE)));
    return bundle;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

/**
 * Waits for slide elements to exist.
 *
 * Settling covers fonts and paint, which a bot check or an error page satisfies
 * just as well as a deck does. Without this the command reports that it could
 * not identify slides, which sends the reader looking for a selector problem
 * when the browser simply never reached the deck.
 */
function awaitSlides(page: ReturnType<typeof browser>): void {
  const deadline = Date.now() + SLIDE_WAIT_MS;
  const probe = `document.querySelectorAll(${JSON.stringify(SLIDE_SELECTORS.join(","))}).length`;
  for (;;) {
    const count = page.evaluate(probe);
    if (typeof count === "number" && count > 0) {
      return;
    }
    if (Date.now() >= deadline) {
      const title = page.evaluate("JSON.stringify(document.title)");
      throw new Error(
        `The page never rendered slide elements; it is showing "${typeof title === "string" ? title : "an unknown page"}"`,
      );
    }
    page.call(["wait", SLIDE_POLL_MS.toString()]);
  }
}

/**
 * Picks the selector whose elements are shaped like the page being written.
 *
 * Deck shells nest a scroll container around the printable page, and the
 * container matches the window rather than the slide. Measuring against the
 * requested slide aspect rather than the viewport keeps the choice correct in a
 * borrowed session, whose window is whatever size its owner left it.
 */
function detectSelector(
  page: ReturnType<typeof browser>,
  aspect: number,
): string {
  const value = page.evaluate(`(() => {
    const candidates = ${JSON.stringify(SLIDE_SELECTORS)};
    const scored = [];
    for (const selector of candidates) {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length === 0) continue;
      let pageLike = 0;
      for (const node of nodes) {
        const box = node.getBoundingClientRect();
        if (box.width < 320 || box.height < 180) continue;
        if (Math.abs(box.width / box.height - ${aspect}) < 0.12) pageLike += 1;
      }
      if (pageLike > 0) scored.push({ selector, pageLike });
    }
    scored.sort((left, right) => right.pageLike - left.pageLike);
    return JSON.stringify(scored.length > 0 ? scored[0].selector : "");
  })()`);
  if (typeof value !== "string" || value === "") {
    throw new Error(
      "Could not identify slide elements; pass --selector explicitly",
    );
  }
  return value;
}

function sourceUrl(input: string): string {
  if (/^https?:\/\//u.test(input)) {
    return input;
  }
  const path = operatorPath(input);
  if (extname(path).toLowerCase() !== ".html") {
    throw new Error(`Unsupported input extension: ${extname(path) || "none"}`);
  }
  return `file://${path}`;
}

/** Reads the deck back out of the page a slice at a time. */
function transfer(page: ReturnType<typeof browser>, length: number): Buffer {
  const parts: string[] = [];
  for (let offset = 0; offset < length; offset += TRANSFER_CHUNK) {
    // evaluate() unwraps two layers of JSON, so the slice is encoded twice.
    // A bare string would come back still quoted, and only Node's tolerance of
    // stray characters in base64 would keep the deck readable.
    const slice = page.evaluate(
      `JSON.stringify(window.__okouPptx.slice(${offset.toString()},${(offset + TRANSFER_CHUNK).toString()}))`,
    );
    if (typeof slice !== "string") {
      throw new Error(`Transfer failed at offset ${offset.toString()}`);
    }
    parts.push(slice);
  }
  const deck = Buffer.from(parts.join(""), "base64");
  if (deck.length === 0) {
    throw new Error("Transferred deck is empty");
  }
  return deck;
}

interface Rendered {
  readonly deck: Buffer;
  readonly eastAsianFont: string;
  readonly selector: string;
  readonly slides: number;
  readonly texts: readonly string[];
}

/**
 * Settles the deck, normalises it, and renders it to a .pptx without ever
 * leaving the page — the geometry that exports is the geometry that painted.
 */
function render(options: Options, bundle: string): Rendered {
  // A hosted deck can sit behind a login or a bot check that only the thread's
  // managed browser clears, so the session is addressable rather than private.
  const borrowed = options.session !== undefined;
  const page = browser(
    options.session ?? `okou-convert-${process.pid.toString()}`,
  );
  try {
    if (!borrowed) {
      // A borrowed session is configured by whoever opened it; resizing it
      // changes what the page sees and is not ours to do.
      page.call([
        "set",
        "viewport",
        options.viewportWidth.toString(),
        options.viewportHeight.toString(),
      ]);
      page.quiet(["set", "media", "reduced-motion"]);
    }
    page.call(["open", sourceUrl(options.input)]);
    page.call(["eval", SETTLE]);
    awaitSlides(page);

    const selector =
      options.selector ?? detectSelector(page, options.width / options.height);
    const eastAsian = page.evaluate(RESOLVE_EAST_ASIAN);
    const eastAsianFont = typeof eastAsian === "string" ? eastAsian : "";

    // Read the source text before normalising, so verification compares against
    // what the deck says rather than against our own rewrite of it.
    const texts = page.evaluate(`(() => {
      const seen = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = (node.nodeValue || "").trim();
        const parent = node.parentElement;
        if (text.length > 1 && parent) {
          const style = getComputedStyle(parent);
          if (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            parent.tagName !== "SCRIPT" &&
            parent.tagName !== "STYLE"
          ) {
            seen.push(text);
          }
        }
        node = walker.nextNode();
      }
      return JSON.stringify(seen);
    })()`);

    if (options.normalize) {
      page.call(["eval", NORMALIZE]);
      page.call(["eval", `${PREPARE}(${JSON.stringify(selector)})`]);
    }

    // An owned session is a browser this process started here, so its failure
    // to read the cached bundle is a broken cache and must surface. A borrowed
    // session may be driving a remote browser with no view of this filesystem,
    // which is why it is served the same published artifact over the network.
    const source = borrowed ? RENDERER_CDN : `file://${bundle}`;
    page.call([
      "eval",
      `(async()=>{
        await new Promise((resolve, reject) => {
          const tag = document.createElement("script");
          tag.src = ${JSON.stringify(source)};
          tag.addEventListener("load", () => resolve(), { once: true });
          tag.addEventListener("error", () => reject(new Error("cannot load " + ${JSON.stringify(source)})), { once: true });
          document.head.append(tag);
        });
        if (!window.domToPptx || !window.domToPptx.exportToPptx) {
          throw new Error("renderer bundle exposed no exportToPptx");
        }
        return 1;
      })()`,
    ]);

    const meta = page.evaluate(`(async()=>{
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      if (nodes.length === 0) throw new Error("No slides matched " + ${JSON.stringify(selector)});
      const blob = await window.domToPptx.exportToPptx(nodes, {
        width: ${options.width.toString()},
        height: ${options.height.toString()},
        includePseudoElements: true,
        skipDownload: true,
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const step = 0x8000;
      for (let index = 0; index < bytes.length; index += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step));
      }
      window.__okouPptx = btoa(binary);
      return JSON.stringify({ slides: nodes.length, length: window.__okouPptx.length });
    })()`);
    if (
      typeof meta !== "object" ||
      meta === null ||
      typeof (meta as { length?: unknown }).length !== "number"
    ) {
      throw new Error("Renderer returned no deck");
    }
    const { slides, length } = meta as { slides: number; length: number };

    return {
      deck: postProcess(transfer(page, length), eastAsianFont, options.wrap),
      eastAsianFont,
      selector,
      slides,
      texts: Array.isArray(texts) ? (texts as string[]) : [],
    };
  } finally {
    if (!borrowed) {
      page.quiet(["close"]);
    }
  }
}

// --- verification -----------------------------------------------------------

/**
 * Reads the entries of a ZIP container. A .pptx is a ZIP, and Node can inflate
 * it without a dependency, which keeps verification available wherever the
 * command runs rather than only where an archive library is installed.
 */
function zipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) {
    throw new Error("Not a ZIP container");
  }
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      break;
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

/**
 * Strips whitespace entirely rather than collapsing it.
 *
 * Pinning a line break splits one string across two runs, and rejoining the
 * runs reintroduces a separator the source never had — which reads as lost
 * content in languages that do not write spaces between words. A gate that
 * reports intact decks as broken is worse than no gate.
 */
function normalizeForCompare(value: string): string {
  return value.replace(/\s+/gu, "").toLowerCase();
}

function deckText(deck: Buffer): { slides: number; text: string } {
  const entries = zipEntries(deck);
  const slideNames = [...entries.keys()]
    .filter((name) => {
      return /^ppt\/slides\/slide\d+\.xml$/u.test(name);
    })
    .sort((left, right) => {
      return left.localeCompare(right, "en", { numeric: true });
    });
  const parts: string[] = [];
  for (const name of slideNames) {
    const xml = entries.get(name)?.toString("utf8") ?? "";
    for (const match of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)) {
      parts.push(decodeXmlText(match[1] ?? ""));
    }
  }
  return {
    slides: slideNames.length,
    text: normalizeForCompare(parts.join("")),
  };
}

/**
 * Names the East Asian family the deck itself asks for.
 *
 * A browser resolves `Lexend, "PingFang SC", "Noto Sans CJK SC", sans-serif`
 * per character, so the display face covers Latin and a later family covers
 * CJK. A pptx run carries one typeface per script slot instead, and the
 * renderer copies the first family into all of them, leaving CJK glyphs
 * without a face.
 *
 * The family is taken from the stack's own order rather than from what happens
 * to be installed where conversion runs. Picking a locally available face
 * writes the conversion machine's environment into the file: a Linux sandbox
 * names the Noto entry, and a reader without it substitutes metrics wide
 * enough to overflow every box measured against the original.
 */
const RESOLVE_EAST_ASIAN = `(() => {
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;
  const generic = new Set(["sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif"]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (CJK.test(node.nodeValue || "") && node.parentElement) {
      const families = getComputedStyle(node.parentElement)
        .fontFamily.split(",")
        .map((entry) => entry.trim().replace(/^["']|["']$/gu, ""))
        .filter((entry) => entry && !generic.has(entry.toLowerCase()));
      // The first entry is the display face chosen for Latin; the next one is
      // what the deck nominates for the characters the display face lacks.
      if (families.length > 1) return JSON.stringify(families[1]);
    }
    node = walker.nextNode();
  }
  return JSON.stringify("");
})()`;

const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

/**
 * Rebuilds a ZIP from its entries.
 *
 * Directory entries are dropped. An OPC part name cannot end in a slash, and
 * repacking one as an ordinary deflated member produces a zero-byte part with
 * an illegal name, which a strict reader is entitled to reject.
 */
function packZip(entries: ReadonlyMap<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let members = 0;
  for (const [name, content] of entries) {
    if (name.endsWith("/")) {
      continue;
    }
    members += 1;
    const rawName = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(content);
    const sum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(rawName.length, 26);
    locals.push(local, rawName, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(rawName.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, rawName);
    offset += local.length + rawName.length + deflated.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members, 8);
  end.writeUInt16LE(members, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * Rewrites the parts of the deck the renderer gets to decide for itself.
 *
 * Both edits exist because a .pptx is a set of instructions, not a picture: a
 * viewer follows what the file says rather than what the browser showed.
 */
function postProcess(
  deck: Buffer,
  eastAsianFont: string,
  wrap: boolean,
): Buffer {
  const entries = zipEntries(deck);
  let touched = false;
  for (const [name, content] of entries) {
    if (
      !/^ppt\/(slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$/u.test(
        name,
      )
    ) {
      continue;
    }
    const xml = content.toString("utf8");
    let patched = xml;

    // spAutoFit tells the viewer to resize each shape around its own text,
    // which discards the geometry the browser measured and re-derives it from
    // whichever font metrics the viewer happens to have. normAutofit keeps the
    // measured box and adjusts the text instead.
    patched = patched.replace(/<a:spAutoFit\/>/gu, "<a:normAutofit/>");

    // Line structure is already settled: every break the browser made was
    // pinned before export and arrives as its own paragraph. Letting the viewer
    // wrap on top of that re-decides it against different font metrics, and a
    // line whose text is a few percent wider becomes two — which is how a
    // heading ends up overlapping whatever sits below it.
    if (!wrap) {
      patched = patched.replace(
        /(<a:bodyPr\b[^>]*?)\swrap="square"/gu,
        '$1 wrap="none"',
      );
    }

    // Only the East Asian slot moves, so Latin runs keep the deck's display
    // face and a mixed run like "TED 演讲" renders both halves as intended.
    if (eastAsianFont !== "") {
      patched = patched.replace(
        /<a:ea typeface="[^"]*"/gu,
        `<a:ea typeface="${eastAsianFont}"`,
      );
    }

    if (patched !== xml) {
      entries.set(name, Buffer.from(patched, "utf8"));
      touched = true;
    }
  }
  return touched ? packZip(entries) : deck;
}

/**
 * Grades the export on whether the deck's words survived, not on how closely
 * the pixels line up.
 *
 * Pixel distance is the wrong gate: an export that silently drops every
 * headline scores about as well as one that places every headline a few points
 * off, because both differ from the source over a similar area. Text coverage
 * separates them, and missing text is the defect users actually report.
 */
function verifyDeck(rendered: Rendered): VerifyReport {
  const { slides, text } = deckText(rendered.deck);
  const missing: string[] = [];
  let matched = 0;
  for (const entry of rendered.texts) {
    if (text.includes(normalizeForCompare(entry))) {
      matched += 1;
    } else {
      missing.push(entry);
    }
  }
  return {
    slides,
    sourceStrings: rendered.texts.length,
    matchedStrings: matched,
    coverage: rendered.texts.length === 0 ? 1 : matched / rendered.texts.length,
    missing: missing.slice(0, 20),
  };
}

// --- command ----------------------------------------------------------------

/**
 * Conversion is still being measured against real decks, so it is held to the
 * accounts the feature switch names. A run whose token predates the switch
 * carries no capabilities to inspect and is left alone.
 */
function requirePresentationConvertCapability(): void {
  const payload = decodeSandboxTokenPayload();
  if (payload && !payload.capabilities.includes("presentation-convert:write")) {
    throw new Error(
      "Presentation conversion is not enabled for this agent run",
    );
  }
}

async function convert(options: Options): Promise<void> {
  requirePresentationConvertCapability();
  const bundle = ensureRenderer();
  const rendered = render(options, bundle);

  const target =
    options.out ?? `${basename(options.input, extname(options.input))}.pptx`;
  const out = operatorPath(target);
  writeFileSync(out, rendered.deck);

  const report = options.verify ? verifyDeck(rendered) : undefined;
  const failed = report !== undefined && report.coverage < TEXT_COVERAGE_FLOOR;

  if (options.json === true) {
    console.log(
      JSON.stringify({
        output: out,
        selector: rendered.selector,
        eastAsianFont: rendered.eastAsianFont,
        slides: rendered.slides,
        bytes: rendered.deck.length,
        verify: report,
      }),
    );
    if (failed) {
      throw new Error(coverageFailure(report));
    }
    return;
  }

  if (failed) {
    // The deck is kept for inspection, but this is not a success: the missing
    // strings go to stderr so they survive a redirect of the failed run.
    process.stderr.write(`Converted deck kept at ${out}\n`);
    process.stderr.write(
      `Slides ${rendered.slides.toString()} via selector ${rendered.selector}\n`,
    );
    for (const entry of report.missing) {
      process.stderr.write(`  missing: ${entry}\n`);
    }
    throw new Error(coverageFailure(report));
  }

  console.log(chalk.green("✓ Presentation converted"));
  console.log(chalk.dim(`  Output:   ${out}`));
  console.log(chalk.dim(`  Slides:   ${rendered.slides.toString()}`));
  console.log(chalk.dim(`  Selector: ${rendered.selector}`));
  if (
    rendered.eastAsianFont !== "" &&
    rendered.texts.some((entry) => {
      return CJK.test(entry);
    })
  ) {
    console.log(chalk.dim(`  CJK font: ${rendered.eastAsianFont}`));
  }
  if (report !== undefined) {
    const percent = (report.coverage * 100).toFixed(1);
    console.log(
      chalk.dim(
        `  Coverage: ${percent}% (${report.matchedStrings.toString()}/${report.sourceStrings.toString()} strings)`,
      ),
    );
  }
  console.log();
  console.log("Check how it renders:");
  console.log(
    chalk.cyan(`  okou presentation screenshot --input ${out} --out ./pages`),
  );
  console.log("Deliver it to the user:");
  console.log(chalk.cyan(`  okou web upload-file -f ${out}`));
}

function coverageFailure(report: VerifyReport): string {
  const percent = (report.coverage * 100).toFixed(1);
  const floor = (TEXT_COVERAGE_FLOOR * 100).toFixed(0);
  return `Text coverage ${percent}% is below the ${floor}% floor; the deck lost content the source shows`;
}

export const presentationConvertCommand = new Command()
  .name("convert")
  .description("Convert an HTML presentation into an editable .pptx")
  .requiredOption("--input <path>", "HTML deck file or URL")
  .option("--out <path>", "Output .pptx path (default: <input>.pptx)")
  .option(
    "--selector <css>",
    "Slide element selector (default: detected from the page)",
  )
  .option(
    "--session <name>",
    "Reuse an existing agent-browser session instead of opening one",
  )
  .option(
    "--width <inches>",
    "Slide width in inches",
    positiveNumber,
    DEFAULT_SLIDE_WIDTH_IN,
  )
  .option(
    "--height <inches>",
    "Slide height in inches",
    positiveNumber,
    DEFAULT_SLIDE_HEIGHT_IN,
  )
  .option(
    "--viewport-width <px>",
    "Browser viewport width",
    positiveNumber,
    DEFAULT_VIEWPORT_WIDTH,
  )
  .option(
    "--viewport-height <px>",
    "Browser viewport height",
    positiveNumber,
    DEFAULT_VIEWPORT_HEIGHT,
  )
  .option(
    "--no-normalize",
    "Keep CSS that OOXML cannot express instead of collapsing it",
  )
  .option(
    "--wrap",
    "Let the viewer re-wrap text rather than holding the browser's line breaks",
    false,
  )
  .option("--verify", "Check the converted deck against the source text", false)
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Convert a deck:      okou presentation convert --input deck.html
  Verify the result:   okou presentation convert --input deck.html --verify
  Name the slides:     okou presentation convert --input deck.html --selector ".stage"
  Convert a hosted deck: okou presentation convert --input https://example.com/deck
  Machine-readable:    okou presentation convert --input deck.html --json
  Deck behind a login: okou browser use && okou presentation convert \\
                         --session okou-browser --input https://example.com/deck

Output:
  Writes an editable .pptx with real text frames and shapes. Text stays editable
  in PowerPoint and Keynote; SVG, filters, and masks fall back to pictures.

Notes:
  - The deck is opened and settled in the same browser session that renders it,
    because shells size type with a runtime autofit pass
  - Text keeps the line breaks the browser settled on; --wrap hands wrapping
    back to the viewer, which may re-flow a line that measures wider there
  - --verify reads the words back out of the .pptx and fails below ${(TEXT_COVERAGE_FLOOR * 100).toFixed(0)}% coverage
  - The renderer bundle is fetched on first use into ~/.cache/okou/presentation-convert
  - Use okou presentation screenshot for page images rather than an editable deck`,
  )
  .action(withErrorHandler(convert));
