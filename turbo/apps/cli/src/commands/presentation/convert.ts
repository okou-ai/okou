/**
 * Convert the browser's current slide DOM with the pinned renderer.
 *
 * The browser owns layout. Export measured text lines and paint independently,
 * and hold those boxes fixed in PPTX rather than asking the viewer to lay them
 * out a second time. Verify content separately from rendered-page acceptance.
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
import { pathToFileURL } from "url";

import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";

import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { applyGeometry, pptxEntries } from "./geometry";
import { layoutSchema, PREPARE_LAYOUT, type Layout } from "./layout";
import { browser, childPath, operatorPath, SETTLE, TIMEOUT_MS } from "./shared";

const RENDERER_PACKAGE = "dom-to-pptx@2.1.2";
const RENDERER_BUNDLE = "dom-to-pptx.bundle.js";
const RENDERER_CACHE_VERSION = "v1";
const RENDERER_CDN = `https://cdn.jsdelivr.net/npm/${RENDERER_PACKAGE}/dist/${RENDERER_BUNDLE}`;
const DEFAULT_VIEWPORT_WIDTH = 1600;
const DEFAULT_VIEWPORT_HEIGHT = 900;
const DEFAULT_SLIDE_WIDTH_IN = 13.333;
const DEFAULT_SLIDE_HEIGHT_IN = 7.5;
const TRANSFER_CHUNK = 200_000;
const TEXT_COVERAGE_FLOOR = 0.98;
const SLIDE_WAIT_MS = 30_000;
const SLIDE_POLL_MS = 1_000;

/** Candidates ordered from explicit slide markers to generic containers. */
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

interface Options {
  readonly input: string;
  readonly out?: string;
  readonly selector?: string;
  readonly session?: string;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly verify: boolean;
  readonly json?: boolean;
}

interface VerifyReport {
  readonly slides: number;
  readonly sourceStrings: number;
  readonly matchedStrings: number;
  readonly coverage: number;
  readonly missing: readonly string[];
  readonly scope: "native-text";
  readonly visualComparison: "not-performed";
}

interface Rendered {
  readonly deck: Buffer;
  readonly selector: string;
  readonly slides: number;
  readonly texts: readonly string[];
  readonly pageTexts: readonly (readonly string[])[];
  readonly layout: Layout;
}

function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Expected a positive number, got ${value}`);
  }
  return parsed;
}

/** Fetch only the browser bundle, not another renderer/browser installation. */
function ensureRenderer(): string {
  const configured = process.env.XDG_CACHE_HOME?.trim();
  const cacheHome =
    configured === undefined || configured === ""
      ? join(homedir(), ".cache")
      : configured;
  const root = join(
    cacheHome,
    "okou",
    "presentation-convert",
    RENDERER_CACHE_VERSION,
  );
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

function sourceUrl(input: string): string {
  if (/^https?:\/\//u.test(input)) {
    return input;
  }
  const path = operatorPath(input);
  if (extname(path).toLowerCase() !== ".html") {
    throw new Error(`Unsupported input extension: ${extname(path) || "none"}`);
  }
  return pathToFileURL(path).href;
}

/** Wait for the caller's selector, or the candidates used for detection. */
function awaitSlides(page: ReturnType<typeof browser>, selector: string): void {
  const deadline = Date.now() + SLIDE_WAIT_MS;
  const probe = `document.querySelectorAll(${JSON.stringify(selector)}).length`;
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

/** Select page-shaped containers rather than their viewport-sized wrappers. */
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

/** Read the original renderer artifact without a ZIP/XML write round-trip. */
function transfer(page: ReturnType<typeof browser>, length: number): Buffer {
  const parts: string[] = [];
  for (let offset = 0; offset < length; offset += TRANSFER_CHUNK) {
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

function render(options: Options): Rendered {
  const borrowed = options.session !== undefined;
  const deckUrl = sourceUrl(options.input);
  const page = browser(
    options.session ?? `okou-convert-${process.pid.toString()}`,
  );
  try {
    if (!borrowed) {
      page.call([
        "set",
        "viewport",
        options.viewportWidth.toString(),
        options.viewportHeight.toString(),
      ]);
      page.quiet(["set", "media", "reduced-motion"]);
    }
    page.call(["open", deckUrl]);
    page.call(["eval", SETTLE]);
    awaitSlides(page, options.selector ?? SLIDE_SELECTORS.join(","));
    const selector =
      options.selector ?? detectSelector(page, options.width / options.height);

    const layout = layoutSchema.parse(
      page.evaluate(`${PREPARE_LAYOUT}(${JSON.stringify(selector)})`),
    );

    // Network pages and remote borrowed browsers cannot load local scripts.
    const local = !borrowed && deckUrl.startsWith("file://");
    const source = local ? pathToFileURL(ensureRenderer()).href : RENDERER_CDN;
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
      deck: applyGeometry(
        transfer(page, length),
        layout,
        options.width,
        options.height,
      ),
      selector,
      slides,
      texts: layout.pages.flatMap((page) => {
        return page.texts;
      }),
      pageTexts: layout.pages.map((page) => {
        return page.texts;
      }),
      layout,
    };
  } finally {
    page.quiet(["eval", "window.__okouRestoreLayout?.()"]);
    if (!borrowed) {
      page.quiet(["close"]);
    }
  }
}

function normalizeForCompare(value: string): string {
  return value.replace(/\s+/gu, "").toLowerCase();
}

function deckText(deck: Buffer): { slides: number; pages: readonly string[] } {
  const entries = pptxEntries(deck);
  const slideNames = [...entries.keys()]
    .filter((name) => {
      return /^ppt\/slides\/slide\d+\.xml$/u.test(name);
    })
    .sort((left, right) => {
      return Number(/\d+/u.exec(left)?.[0]) - Number(/\d+/u.exec(right)?.[0]);
    });
  const pages: string[] = [];
  for (const name of slideNames) {
    const parts: string[] = [];
    const xml = entries.get(name)?.toString("utf8") ?? "";
    for (const run of xml.matchAll(/<a:r>[\s\S]*?<\/a:r>/gu)) {
      const properties = /<a:rPr\b[\s\S]*?<\/a:rPr>/u.exec(run[0])?.[0] ?? "";
      const fill =
        /<a:solidFill\b[\s\S]*?<\/a:solidFill>/u.exec(properties)?.[0] ?? "";
      if (
        /<a:alpha\b[^>]*\bval="0"/u.test(fill) &&
        !/<a:ln\b/u.test(properties)
      )
        continue;
      const text = /<a:t>([\s\S]*?)<\/a:t>/u.exec(run[0])?.[1] ?? "";
      parts.push(
        text
          .replace(/&lt;/gu, "<")
          .replace(/&gt;/gu, ">")
          .replace(/&quot;/gu, '"')
          .replace(/&apos;/gu, "'")
          .replace(/&amp;/gu, "&"),
      );
    }
    pages.push(normalizeForCompare(parts.join("")));
  }
  return { slides: slideNames.length, pages };
}

/** This existing editable-text check does not establish visual fidelity. */
function verifyDeck(rendered: Rendered): VerifyReport {
  const { slides, pages } = deckText(rendered.deck);
  const missing: string[] = [];
  let matched = 0;
  for (let index = 0; index < rendered.pageTexts.length; index += 1) {
    const text = pages[index] ?? "";
    const cursors = new Map<string, number>();
    for (const entry of rendered.pageTexts[index] ?? []) {
      const normalized = normalizeForCompare(entry);
      const position = text.indexOf(normalized, cursors.get(normalized) ?? 0);
      if (position >= 0) {
        matched += 1;
        cursors.set(normalized, position + normalized.length);
      } else {
        missing.push(`Page ${(index + 1).toString()}: ${entry}`);
      }
    }
  }
  return {
    slides,
    sourceStrings: rendered.texts.length,
    matchedStrings: matched,
    coverage: rendered.texts.length === 0 ? 1 : matched / rendered.texts.length,
    missing: missing.slice(0, 20),
    scope: "native-text",
    visualComparison: "not-performed",
  };
}

function requirePresentationConvertCapability(): void {
  const payload = decodeSandboxTokenPayload();
  if (payload && !payload.capabilities.includes("presentation-convert:write")) {
    throw new Error(
      "Presentation conversion is not enabled for this agent run",
    );
  }
}

function coverageFailure(report: VerifyReport): string {
  const percent = (report.coverage * 100).toFixed(1);
  const floor = (TEXT_COVERAGE_FLOOR * 100).toFixed(0);
  return `Text coverage ${percent}% is below the ${floor}% floor; the deck lost content the source shows`;
}

async function convert(options: Options): Promise<void> {
  requirePresentationConvertCapability();
  const rendered = render(options);
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
        slides: rendered.slides,
        bytes: rendered.deck.length,
        verify: report,
        layout: {
          activatedSlides: rendered.layout.activated,
          fragmentedOwners: rendered.layout.fragmented,
        },
      }),
    );
    if (failed) {
      throw new Error(coverageFailure(report));
    }
    return;
  }
  if (failed) {
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
        `  Native text coverage: ${percent}% (${report.matchedStrings.toString()}/${report.sourceStrings.toString()} strings)`,
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

export const presentationConvertCommand = new Command()
  .name("convert")
  .description(
    "Convert an HTML presentation into a .pptx with the DOM renderer",
  )
  .requiredOption("--input <path>", "HTML deck file or URL")
  .option("--out <path>", "Output .pptx path (default: <input>.pptx)")
  .option(
    "--selector <css>",
    "Slide selector (default: detected from the page)",
  )
  .option("--session <name>", "Reuse an existing agent-browser session")
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
    "--verify",
    "Check editable-text coverage, not visual fidelity",
    false,
  )
  .option("--json", "Print machine-readable JSON")
  .addHelpText(
    "after",
    `
Examples:
  Convert a deck:      okou presentation convert --input deck.html
  Verify text:         okou presentation convert --input deck.html --verify
  Select slides:       okou presentation convert --input deck.html --selector ".stage"
  Hosted deck:         okou presentation convert --input https://example.com/deck
  Machine-readable:    okou presentation convert --input deck.html --json
  Deck behind a login: okou browser use && okou presentation convert \\
                         --session okou-browser --input https://example.com/deck

Notes:
  - Activates selected inactive slides using the visible page's layout
  - Wrapped inline text is exported as measured native line fragments
  - Fixed geometry preserves font size; the viewer does not resize measured boxes
  - Table row heights and solid cell backgrounds come from browser measurements
  - Complex effects still require rendered-page comparison
  - --verify checks editable strings only; image fallback is not text coverage
  - Use okou presentation screenshot and compare each page before delivery`,
  )
  .action(withErrorHandler(convert));
