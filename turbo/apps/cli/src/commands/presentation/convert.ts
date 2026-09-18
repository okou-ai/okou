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
import { inflateRawSync } from "zlib";

import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  browser,
  childPath,
  operatorPath,
  SETTLE,
  TIMEOUT_MS,
} from "./shared";

const RENDERER_PACKAGE = "dom-to-pptx@2.1.2";
const RENDERER_BUNDLE = "dom-to-pptx.bundle.js";
const RENDERER_CACHE_VERSION = "v1";
const DEFAULT_VIEWPORT_WIDTH = 1600;
const DEFAULT_VIEWPORT_HEIGHT = 900;
const DEFAULT_SLIDE_WIDTH_IN = 13.333;
const DEFAULT_SLIDE_HEIGHT_IN = 7.5;
/** Retrieval chunk for the base64 deck; eval carries far more, this is headroom. */
const TRANSFER_CHUNK = 200_000;
/** Below this share of source text present in the deck, the export is broken. */
const TEXT_COVERAGE_FLOOR = 0.98;

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

interface Options {
  readonly input: string;
  readonly out?: string;
  readonly selector?: string;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly normalize: boolean;
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
  return join(cacheHome, "okou", "presentation-convert", RENDERER_CACHE_VERSION);
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
    const tarball = readdirSync(staging).find((name) => name.endsWith(".tgz"));
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
 * Picks the selector that yields the most page-shaped elements. Deck shells
 * nest a scroll container around the printable page, so the element that looks
 * like a slide to a human is rarely the outermost match.
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
    const slice = page.evaluate(
      `window.__okouPptx.slice(${offset.toString()},${(offset + TRANSFER_CHUNK).toString()})`,
    );
    if (typeof slice !== "string") {
      throw new Error(`Transfer failed at offset ${offset.toString()}`);
    }
    parts.push(slice);
  }
  return Buffer.from(parts.join(""), "base64");
}

interface Rendered {
  readonly deck: Buffer;
  readonly selector: string;
  readonly slides: number;
  readonly texts: readonly string[];
}

/**
 * Settles the deck, normalises it, and renders it to a .pptx without ever
 * leaving the page — the geometry that exports is the geometry that painted.
 */
function render(options: Options, bundle: string): Rendered {
  const page = browser(`okou-convert-${process.pid.toString()}`);
  try {
    page.call([
      "set",
      "viewport",
      options.viewportWidth.toString(),
      options.viewportHeight.toString(),
    ]);
    page.quiet(["set", "media", "reduced-motion"]);
    page.call(["open", sourceUrl(options.input)]);
    page.call(["eval", SETTLE]);

    const selector =
      options.selector ??
      detectSelector(page, options.viewportWidth / options.viewportHeight);

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
    }

    page.call([
      "eval",
      `(async()=>{
        await new Promise((resolve, reject) => {
          const tag = document.createElement("script");
          tag.src = ${JSON.stringify(`file://${bundle}`)};
          tag.addEventListener("load", () => resolve(), { once: true });
          tag.addEventListener("error", () => reject(new Error("renderer bundle failed to load")), { once: true });
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
      deck: transfer(page, length),
      selector,
      slides,
      texts: Array.isArray(texts) ? (texts as string[]) : [],
    };
  } finally {
    page.quiet(["close"]);
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

function normalizeForCompare(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function deckText(deck: Buffer): { slides: number; text: string } {
  const entries = zipEntries(deck);
  const slideNames = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const parts: string[] = [];
  for (const name of slideNames) {
    const xml = entries.get(name)?.toString("utf8") ?? "";
    for (const match of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)) {
      parts.push(decodeXmlText(match[1] ?? ""));
    }
  }
  return {
    slides: slideNames.length,
    text: normalizeForCompare(parts.join(" ")),
  };
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

function convert(options: Options): void {
  const bundle = ensureRenderer();
  const rendered = render(options, bundle);

  const target =
    options.out ??
    `${basename(options.input, extname(options.input))}.pptx`;
  const out = operatorPath(target);
  writeFileSync(out, rendered.deck);

  const report = options.verify ? verifyDeck(rendered) : undefined;
  const failed =
    report !== undefined && report.coverage < TEXT_COVERAGE_FLOOR;

  if (options.json === true) {
    console.log(
      JSON.stringify({
        output: out,
        selector: rendered.selector,
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

Output:
  Writes an editable .pptx with real text frames and shapes. Text stays editable
  in PowerPoint and Keynote; SVG, filters, and masks fall back to pictures.

Notes:
  - The deck is opened and settled in the same browser session that renders it,
    because shells size type with a runtime autofit pass
  - --verify reads the words back out of the .pptx and fails below ${(TEXT_COVERAGE_FLOOR * 100).toFixed(0)}% coverage
  - The renderer bundle is fetched on first use into ~/.cache/okou/presentation-convert
  - Use okou presentation screenshot for page images rather than an editable deck`,
  )
  .action(withErrorHandler(convert));
