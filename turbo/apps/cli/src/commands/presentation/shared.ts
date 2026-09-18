/**
 * Helpers shared by the presentation commands. Both screenshot and convert open
 * the same decks in the same browser and settle them the same way; the settle
 * contract in particular must not drift between them, because a deck captured
 * before its fonts load and a deck converted before its fonts load fail in
 * different, hard-to-attribute ways.
 */
import { execFileSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { basename, extname, isAbsolute, normalize, sep } from "path";
import { pathToFileURL } from "url";

export const TIMEOUT_MS = 300_000;

/**
 * Waits for fonts, images, and CSS background images, then two paint frames.
 *
 * Presentation shells routinely size type with a runtime autofit pass, so the
 * geometry a deck reports before this resolves is not the geometry it renders.
 */
export const SETTLE = `(async()=>{
  const wait=(promise,label)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Timed out waiting for "+label)),12000);
    promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)});
  });
  const loadImage=src=>new Promise(resolve=>{
    const image=new Image();
    image.onload=image.onerror=resolve;
    image.src=src;
    if(image.complete) resolve();
  });
  await wait(document.fonts.ready,"fonts");
  await wait(
    Promise.all(Array.from(document.images).filter(image=>!image.complete).map(image=>new Promise(resolve=>{image.onload=image.onerror=resolve}))),
    "images"
  );
  const backgroundUrls=[...new Set(
    Array.from(document.querySelectorAll("*")).flatMap(node=>
      Array.from(
        getComputedStyle(node).backgroundImage.matchAll(/url\\((?:"([^"]*)"|'([^']*)'|([^)]*))\\)/gu),
        match=>(match[1]??match[2]??match[3]??"").trim()
      ).filter(Boolean)
    )
  )];
  await wait(Promise.all(backgroundUrls.map(loadImage)),"CSS background images");
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  return 1;
})()`;

export const NEXT_FRAME =
  "(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return 1})()";

/**
 * Input and output paths are an explicit local-CLI trust boundary: the operator
 * chooses them and may intentionally address any location they can access.
 */
export function operatorPath(input: string): string {
  return normalize(
    isAbsolute(input) ? input : `${process.cwd()}${sep}${input}`,
  );
}

/** Resolve a single directory entry without allowing the entry to escape. */
export function childPath(directory: string, name: string): string {
  if (name === "." || name === ".." || basename(name) !== name) {
    throw new Error(`Invalid directory entry: ${name}`);
  }
  return normalize(`${directory}${sep}${name}`);
}

/** Resolve validated directory entries beneath a trusted directory. */
export function descendantPath(
  directory: string,
  ...names: readonly string[]
): string {
  return names.reduce((parent, name) => {
    return childPath(parent, name);
  }, directory);
}

export function run(
  command: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT_MS,
  }).trim();
}

export function runStreaming(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  execFileSync(command, args, {
    env: environment,
    stdio: ["ignore", "ignore", process.stderr],
    timeout: TIMEOUT_MS,
  });
}

export function browser(session: string) {
  const call = (args: readonly string[]): string => {
    return run("agent-browser", [
      "--session",
      session,
      "--allow-file-access",
      ...args,
    ]);
  };
  const quiet = (args: readonly string[]): void => {
    try {
      call(args);
    } catch {
      // Shaping calls only; the capture itself is what matters.
    }
  };
  return {
    call,
    /** agent-browser prints the evaluated value JSON-encoded on the last line. */
    evaluate: (expression: string): unknown => {
      const last = call(["eval", expression]).split("\n").filter(Boolean).pop();
      try {
        const value: unknown = JSON.parse(last ?? "");
        return typeof value === "string" ? JSON.parse(value) : value;
      } catch {
        return last;
      }
    },
    quiet,
  };
}

export function htmlSources(input: string): { url: string; label: string }[] {
  if (/^https?:\/\//u.test(input)) {
    return [{ url: input, label: input }];
  }
  const path = operatorPath(input);
  if (statSync(path).isDirectory()) {
    const names = readdirSync(path)
      .filter((name) => {
        // `_shell.html` and friends are shared partials, not pages.
        return extname(name).toLowerCase() === ".html" && !name.startsWith("_");
      })
      .sort((left, right) => {
        return left.localeCompare(right, "en", { numeric: true });
      });
    if (names.length === 0) {
      throw new Error(`No page-level .html files in ${path}`);
    }
    return names.map((name) => {
      return { url: pathToFileURL(childPath(path, name)).href, label: name };
    });
  }
  if (extname(path).toLowerCase() !== ".html") {
    throw new Error(`Unsupported input extension: ${extname(path) || "none"}`);
  }
  return [{ url: pathToFileURL(path).href, label: basename(path) }];
}
