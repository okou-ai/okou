/**
 * okou presentation screenshot — render a presentation to page PNGs.
 *
 * A PPT, PPTX, or PDF deck is rasterised through LibreOffice and Poppler.
 * HTML — one page, a directory of layouts, or an assembled deck — is captured
 * through a browser. Both land on the same fixed page surface and write the
 * same ordered page-NNN.png.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, hostname } from "os";
import { delimiter, extname, join } from "path";
import { setTimeout as delay } from "timers/promises";
import { pathToFileURL } from "url";

import { Command, InvalidArgumentError } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  browser,
  childPath,
  descendantPath,
  htmlSources,
  NEXT_FRAME,
  operatorPath,
  run,
  runStreaming,
  SETTLE,
  TIMEOUT_MS,
} from "./shared";

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;
const RETRIES = 2;
const RENDER_DPI = "150";
const DECK_EXTENSIONS = [".ppt", ".pptx", ".pdf"];
const DEPENDENCY_CACHE_VERSION = "v1";
const INSTALL_LOCK_POLL_MS = 250;
const INSTALL_LOCK_TIMEOUT_MS = TIMEOUT_MS * 3;
const INSTALL_LOCK_STALE_MS = TIMEOUT_MS * 4;

interface DeckTool {
  readonly command: string;
  readonly environment?: NodeJS.ProcessEnv;
}

interface DeckTools {
  readonly soffice?: DeckTool;
  readonly pdftocairo: DeckTool;
}

interface DeckDependency {
  readonly binary: string;
  readonly localPath: readonly string[];
  readonly packageName: string;
}

const LIBREOFFICE: DeckDependency = {
  binary: "soffice",
  localPath: ["usr", "bin", "soffice"],
  packageName: "libreoffice-impress",
};
const POPPLER: DeckDependency = {
  binary: "pdftocairo",
  localPath: ["usr", "bin", "pdftocairo"],
  packageName: "poppler-utils",
};

interface Options {
  readonly input: string;
  readonly out: string;
  readonly width: number;
  readonly height: number;
  readonly slides: string;
  readonly json?: boolean;
}

/** PNG stores width and height in the IHDR chunk, always the first one. */
function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

function clearPages(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (/^page-\d+\.png$/u.test(name)) {
      rmSync(childPath(outDir, name), { force: true });
    }
  }
}

// --- deck sources -----------------------------------------------------------

function toolOnPath(binary: string): boolean {
  try {
    run("which", [binary]);
    return true;
  } catch {
    return false;
  }
}

function dependencyCacheRoot(): string {
  const configured = process.env.XDG_CACHE_HOME?.trim();
  const cacheHome =
    configured === undefined || configured === ""
      ? join(homedir(), ".cache")
      : configured;
  return join(
    cacheHome,
    "okou",
    "presentation-screenshot",
    DEPENDENCY_CACHE_VERSION,
  );
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function installLockIsStale(lockDirectory: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(lockDirectory).mtimeMs;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  if (age > INSTALL_LOCK_STALE_MS) {
    return true;
  }

  try {
    const owner = JSON.parse(
      readFileSync(childPath(lockDirectory, "owner.json"), "utf8"),
    ) as { hostname?: unknown; pid?: unknown };
    return (
      owner.hostname === hostname() &&
      typeof owner.pid === "number" &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      !processExists(owner.pid)
    );
  } catch {
    // The owner file is written immediately after the atomic directory create.
    return false;
  }
}

async function acquireInstallLock(): Promise<() => void> {
  const cacheRoot = dependencyCacheRoot();
  const lockDirectory = childPath(cacheRoot, ".install.lock");
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;
  let announcedWait = false;
  mkdirSync(cacheRoot, { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockDirectory);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      if (installLockIsStale(lockDirectory)) {
        rmSync(lockDirectory, { force: true, recursive: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for another presentation dependency installation",
        );
      }
      if (!announcedWait) {
        console.error(
          "Waiting for another presentation dependency installation...",
        );
        announcedWait = true;
      }
      await delay(INSTALL_LOCK_POLL_MS);
      continue;
    }

    try {
      writeFileSync(
        childPath(lockDirectory, "owner.json"),
        JSON.stringify({ hostname: hostname(), pid: process.pid }),
      );
    } catch (error) {
      rmSync(lockDirectory, { force: true, recursive: true });
      throw error;
    }
    return () => {
      rmSync(lockDirectory, { force: true, recursive: true });
    };
  }
}

function localToolEnvironment(installRoot: string): NodeJS.ProcessEnv {
  const program = descendantPath(
    installRoot,
    "usr",
    "lib",
    "libreoffice",
    "program",
  );
  const environment = { ...process.env };
  const libraryDirectories = [
    program,
    descendantPath(installRoot, "usr", "lib"),
  ];
  for (const parent of [
    childPath(installRoot, "lib"),
    descendantPath(installRoot, "usr", "lib"),
  ]) {
    if (!existsSync(parent)) {
      continue;
    }
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.endsWith("-linux-gnu")) {
        libraryDirectories.push(childPath(parent, entry.name));
      }
    }
  }
  if (
    environment.LD_LIBRARY_PATH !== undefined &&
    environment.LD_LIBRARY_PATH !== ""
  ) {
    libraryDirectories.push(environment.LD_LIBRARY_PATH);
  }

  const pathDirectories = [descendantPath(installRoot, "usr", "bin")];
  if (environment.PATH !== undefined && environment.PATH !== "") {
    pathDirectories.push(environment.PATH);
  }

  return {
    ...environment,
    LD_LIBRARY_PATH: libraryDirectories.join(delimiter),
    PATH: pathDirectories.join(delimiter),
    URE_BOOTSTRAP: `vnd.sun.star.pathname:${childPath(program, "fundamentalrc")}`,
  };
}

function dependencyMarker(
  dependency: DeckDependency,
  installRoot: string,
): string {
  return childPath(installRoot, `.${dependency.packageName}.ready`);
}

function resolveDeckTool(
  dependency: DeckDependency,
  installRoot: string,
): DeckTool | undefined {
  if (toolOnPath(dependency.binary)) {
    return { command: dependency.binary };
  }
  const command = descendantPath(installRoot, ...dependency.localPath);
  return existsSync(dependencyMarker(dependency, installRoot)) &&
    existsSync(command)
    ? { command, environment: localToolEnvironment(installRoot) }
    : undefined;
}

function replaceConfigPaths(
  file: string,
  replacements: readonly (readonly [string, string])[],
): void {
  let content = readFileSync(file, "utf8");
  for (const [from, to] of replacements) {
    content = content.replaceAll(from, to);
  }
  writeFileSync(file, content);
}

function configureLocalLibreOffice(installRoot: string): void {
  const program = descendantPath(
    installRoot,
    "usr",
    "lib",
    "libreoffice",
    "program",
  );
  const brandBase = pathToFileURL(
    descendantPath(installRoot, "usr", "lib", "libreoffice"),
  ).href;
  const registryTarget = descendantPath(
    installRoot,
    "etc",
    "libreoffice",
    "registry",
  );
  const registryUrl = pathToFileURL(registryTarget).href;
  replaceConfigPaths(childPath(program, "fundamentalrc"), [
    ["file:///usr/lib/libreoffice", brandBase],
    ["file:///etc/libreoffice/registry", registryUrl],
  ]);
  replaceConfigPaths(childPath(program, "sofficerc"), [
    [
      "file:///etc/libreoffice/sofficerc",
      pathToFileURL(
        descendantPath(installRoot, "etc", "libreoffice", "sofficerc"),
      ).href,
    ],
  ]);

  const registrySource = descendantPath(
    installRoot,
    "usr",
    "lib",
    "libreoffice",
    "share",
    ".registry",
  );
  mkdirSync(registryTarget, { recursive: true });
  for (const name of readdirSync(registrySource)) {
    cpSync(childPath(registrySource, name), childPath(registryTarget, name), {
      force: true,
      recursive: true,
    });
  }
}

function installLocalDependencies(
  packageNames: readonly string[],
  installRoot: string,
): void {
  const manualCommand = `sudo apt-get install -y --no-install-recommends ${packageNames.join(" ")}`;
  if (!toolOnPath("apt-get") || !toolOnPath("dpkg-deb")) {
    throw new Error(
      `Automatic presentation dependency installation requires apt-get and dpkg-deb. Install manually with: ${manualCommand}`,
    );
  }

  const aptRoot = childPath(dependencyCacheRoot(), "apt");
  const lists = childPath(aptRoot, "lists");
  const archives = childPath(aptRoot, "archives");
  mkdirSync(childPath(lists, "partial"), { recursive: true });
  mkdirSync(childPath(archives, "partial"), { recursive: true });

  const aptOptions = [
    "-o",
    "Debug::NoLocking=1",
    "-o",
    `Dir::State::lists=${lists}`,
    "-o",
    `Dir::Cache::archives=${archives}`,
    "-o",
    "Dir::State::status=/var/lib/dpkg/status",
  ];
  const environment = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
  console.error(
    `Installing presentation dependencies (${packageNames.join(", ")}) into the Okou cache (one-time download)...`,
  );

  try {
    runStreaming("apt-get", [...aptOptions, "update"], environment);
    runStreaming(
      "apt-get",
      [
        "-y",
        "--download-only",
        "--no-install-recommends",
        ...aptOptions,
        "install",
        ...packageNames,
      ],
      environment,
    );

    const packages = readdirSync(archives)
      .filter((name) => {
        return name.endsWith(".deb");
      })
      .sort();
    if (packages.length === 0) {
      throw new Error("apt-get downloaded no Debian packages");
    }
    mkdirSync(installRoot, { recursive: true });
    for (const name of packages) {
      run(
        "dpkg-deb",
        ["-x", childPath(archives, name), installRoot],
        environment,
      );
    }
    if (packageNames.includes(LIBREOFFICE.packageName)) {
      configureLocalLibreOffice(installRoot);
    }
    for (const dependency of [LIBREOFFICE, POPPLER]) {
      if (!packageNames.includes(dependency.packageName)) {
        continue;
      }
      const command = descendantPath(installRoot, ...dependency.localPath);
      if (!existsSync(command)) {
        throw new Error(`${dependency.packageName} did not provide ${command}`);
      }
      writeFileSync(dependencyMarker(dependency, installRoot), "ready\n");
    }
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `Could not automatically install presentation dependencies.${detail} Install manually with: ${manualCommand}`,
      { cause: error },
    );
  }

  rmSync(aptRoot, { force: true, recursive: true });
  console.error("Presentation dependencies installed.");
}

function missingDeckPackages(
  converts: boolean,
  soffice: DeckTool | undefined,
  pdftocairo: DeckTool | undefined,
): string[] {
  return [
    ...(converts && soffice === undefined ? [LIBREOFFICE.packageName] : []),
    ...(pdftocairo === undefined ? [POPPLER.packageName] : []),
  ];
}

async function ensureDeckTools(converts: boolean): Promise<DeckTools> {
  const installRoot = childPath(dependencyCacheRoot(), "root");
  let soffice = converts
    ? resolveDeckTool(LIBREOFFICE, installRoot)
    : undefined;
  let pdftocairo = resolveDeckTool(POPPLER, installRoot);
  let missingPackages = missingDeckPackages(converts, soffice, pdftocairo);

  if (missingPackages.length > 0) {
    const release = await acquireInstallLock();
    try {
      soffice = converts
        ? resolveDeckTool(LIBREOFFICE, installRoot)
        : undefined;
      pdftocairo = resolveDeckTool(POPPLER, installRoot);
      missingPackages = missingDeckPackages(converts, soffice, pdftocairo);
      if (missingPackages.length > 0) {
        installLocalDependencies(missingPackages, installRoot);
      }
    } finally {
      release();
    }
    soffice = converts ? resolveDeckTool(LIBREOFFICE, installRoot) : undefined;
    pdftocairo = resolveDeckTool(POPPLER, installRoot);
  }

  if (pdftocairo === undefined || (converts && soffice === undefined)) {
    throw new Error(
      `Presentation dependencies are still unavailable after installation: ${missingPackages.join(", ")}`,
    );
  }
  return { soffice, pdftocairo };
}

/**
 * Poppler numbers pages by the page count's digit width, so renumber through
 * staged names to avoid colliding with what it just wrote.
 */
function renumber(outDir: string): string[] {
  const rendered = readdirSync(outDir)
    .map((name) => {
      return { name, page: Number(/^page-(\d+)\.png$/u.exec(name)?.[1]) };
    })
    .filter((item) => {
      return Number.isInteger(item.page);
    })
    .sort((left, right) => {
      return left.page - right.page;
    });
  if (rendered.length === 0) {
    throw new Error("pdftocairo produced no page PNGs");
  }

  const staged = rendered.map((item, index) => {
    const name = `.staged-${process.pid.toString()}-${index.toString()}.png`;
    renameSync(childPath(outDir, item.name), childPath(outDir, name));
    return name;
  });
  return staged.map((name, index) => {
    const final = `page-${(index + 1).toString().padStart(3, "0")}.png`;
    renameSync(childPath(outDir, name), childPath(outDir, final));
    return final;
  });
}

async function captureDeck(
  options: Options,
  outDir: string,
): Promise<string[]> {
  const input = operatorPath(options.input);
  if (!existsSync(input) || !statSync(input).isFile()) {
    throw new Error(`Deck input is not a file: ${input}`);
  }
  const converts = extname(input).toLowerCase() !== ".pdf";
  const tools = await ensureDeckTools(converts);
  clearPages(outDir);

  const scratch = mkdtempSync(childPath(outDir, ".okou-convert-"));
  try {
    let pdf = input;
    if (converts) {
      if (tools.soffice === undefined) {
        throw new Error("LibreOffice is unavailable after installation");
      }
      run(
        tools.soffice.command,
        [
          `-env:UserInstallation=${
            pathToFileURL(childPath(scratch, "libreoffice-profile")).href
          }`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          scratch,
          input,
        ],
        tools.soffice.environment,
      );
      const produced = readdirSync(scratch).find((name) => {
        return extname(name).toLowerCase() === ".pdf";
      });
      if (produced === undefined) {
        throw new Error("LibreOffice produced no PDF");
      }
      pdf = childPath(scratch, produced);
    }
    run(
      tools.pdftocairo.command,
      [
        "-png",
        "-r",
        RENDER_DPI,
        "-scale-to-x",
        options.width.toString(),
        "-scale-to-y",
        options.height.toString(),
        pdf,
        childPath(outDir, "page"),
      ],
      tools.pdftocairo.environment,
    );
    return renumber(outDir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- HTML sources -----------------------------------------------------------

interface SlideTarget {
  readonly selector: string;
  readonly index: number;
}

function slideTargets(
  page: ReturnType<typeof browser>,
  selector: string,
): SlideTarget[] {
  if (selector === "") {
    return [{ selector, index: 0 }];
  }
  const count = page.evaluate(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
  if (typeof count !== "number" || !Number.isInteger(count) || count < 2) {
    return [{ selector: "", index: 0 }];
  }
  return Array.from({ length: count }, (_, index) => {
    return { selector, index };
  });
}

function captureHtml(options: Options, outDir: string): string[] {
  clearPages(outDir);
  const page = browser(`okou-shot-${process.pid.toString()}`);
  const files: string[] = [];

  try {
    page.call([
      "set",
      "viewport",
      options.width.toString(),
      options.height.toString(),
    ]);
    page.quiet(["set", "media", "reduced-motion"]);

    for (const source of htmlSources(options.input)) {
      page.call(["open", source.url]);
      page.call(["eval", SETTLE]);

      for (const slide of slideTargets(page, options.slides)) {
        const file = `page-${(files.length + 1).toString().padStart(3, "0")}.png`;
        const target = childPath(outDir, file);
        capturePage(page, slide, target, options);
        files.push(file);
      }
    }
  } finally {
    page.quiet(["close"]);
  }
  return files;
}

function capturePage(
  page: ReturnType<typeof browser>,
  slide: SlideTarget,
  target: string,
  options: Options,
): void {
  const probe = `${target}.probe`;
  try {
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      if (attempt > 0) {
        page.call(["reload"]);
        page.call(["eval", SETTLE]);
      }
      // An element-scoped screenshot returns the page background for a slide
      // below the fold. scrollIntoView reaches a nested deck scroller as well
      // as the window, then an ordinary viewport capture includes the page.
      page.evaluate(
        slide.selector === ""
          ? "(()=>{window.scrollTo(0,0);return window.scrollY})()"
          : `(()=>{
          const index=${slide.index.toString()};
          const node=document.querySelectorAll(${JSON.stringify(slide.selector)}).item(index);
          if(!(node instanceof Element))throw new Error("Slide disappeared before capture");
          node.scrollIntoView({block:"start",inline:"start",behavior:"instant"});
          return index;
        })()`,
      );
      page.evaluate(NEXT_FRAME);

      // Capture twice: a settled static page yields byte-identical PNGs, one
      // still painting or animating does not.
      page.call(["screenshot", probe]);
      page.evaluate(NEXT_FRAME);
      page.call(["screenshot", target]);

      const size = pngSize(target);
      if (size.width !== options.width || size.height !== options.height) {
        throw new Error(
          `Captured ${size.width.toString()}x${size.height.toString()}, expected ${options.width.toString()}x${options.height.toString()}`,
        );
      }
      if (readFileSync(probe).equals(readFileSync(target))) {
        return;
      }
    }
    throw new Error(`${target} never stopped changing between captures`);
  } finally {
    rmSync(probe, { force: true });
  }
}

// --- command ----------------------------------------------------------------

function positiveInteger(label: string): (value: string) => number {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${label} must be a positive integer`);
    }
    return parsed;
  };
}

export const presentationScreenshotCommand = new Command()
  .name("screenshot")
  .description(
    "Render a presentation (.ppt, .pptx, .pdf, .html) to ordered page PNGs",
  )
  .requiredOption(
    "--input <path>",
    "A .ppt, .pptx, .pdf or .html file, a directory of .html files, or an http(s) URL",
  )
  .requiredOption("--out <dir>", "Output directory for page-001.png, ...")
  .option(
    "--width <px>",
    "Page width in CSS pixels",
    positiveInteger("width"),
    DEFAULT_WIDTH,
  )
  .option(
    "--height <px>",
    "Page height in CSS pixels",
    positiveInteger("height"),
    DEFAULT_HEIGHT,
  )
  .option(
    "--slides <selector>",
    'HTML only: slide selector, or "none" for one page per file',
    ".deck > .slide",
  )
  .option("--json", "Print the result as JSON")
  .addHelpText(
    "after",
    `
Writes only local ordered page-001.png files at one fixed size; it uploads and publishes nothing. PPT/PPTX/PDF use LibreOffice and Poppler, while HTML files, layout directories, and URLs are painted in a browser, one image per slide.
Use this command for page images needed by review, analysis, deck-to-video, or presentation-template preparation. It is independent of okou presentation-template publish. Prefer it over direct pdftoppm/soffice or hand-driven browser screenshots so pages are fully painted before capture.`,
  )
  .action(
    withErrorHandler(async (options: Options) => {
      const outDir = operatorPath(options.out);
      const resolved: Options = {
        ...options,
        slides: options.slides === "none" ? "" : options.slides,
      };
      const isDeck = DECK_EXTENSIONS.includes(
        extname(options.input).toLowerCase(),
      );
      const files = isDeck
        ? await captureDeck(resolved, outDir)
        : captureHtml(resolved, outDir);

      if (options.json === true) {
        console.log(
          JSON.stringify(
            {
              pages: files.length,
              width: options.width,
              height: options.height,
              outDir,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `Captured ${files.length.toString()} page(s) at ${options.width.toString()}x${options.height.toString()} into ${outDir}`,
      );
    }),
  );
