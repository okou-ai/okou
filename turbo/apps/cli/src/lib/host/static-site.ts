import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep, dirname, posix } from "node:path";
import { hostedSiteAssetNameError } from "@okouai/api-contracts/contracts/host";

interface StaticSiteFile {
  readonly absolutePath?: string;
  readonly content?: Uint8Array;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly immutable?: boolean;
}

interface StaticSiteScanOptions {
  readonly defaultRobots?: "disallow-all";
}

interface StaticSiteScanResult {
  readonly root: string;
  readonly files: readonly StaticSiteFile[];
}

export const DEFAULT_HOSTED_SITE_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const HTML_REFERENCE_RE =
  /<(?:script|link|img|source|video|audio|embed|object)\b[^>]*\s(?:src|href|poster|data)=["']([^"']+)["'][^>]*>/giu;
const SRCSET_RE = /\s(?:srcset)=["']([^"']+)["']/giu;
const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/giu;
const CSS_IMPORT_RE = /@import\s+(?:url\()?["']([^"']+)["']\)?/giu;

function inferContentType(path: string): string {
  return (
    MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

function looksImmutable(path: string): boolean {
  if (path.startsWith("/assets/")) {
    return true;
  }
  return /(?:[-.])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(path);
}

function toSitePath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath).split(sep).join("/");
  return `/${rel}`;
}

function isSafeSitePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }
  if (path.includes("\\") || path.includes("\0")) {
    return false;
  }
  const segments = path.split("/").filter(Boolean);
  return !segments.some((segment) => {
    return segment === "." || segment === "..";
  });
}

function isExternalReference(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(value);
}

// References containing template interpolation are resolved at runtime, not on
// disk. Covers JS template literals (`${...}`), mustache/Vue/Angular/Handlebars
// (`{{...}}`), and EJS/ERB (`<%...%>`). These cannot be validated statically.
function isDynamicReference(value: string): boolean {
  return /\$\{|\{\{|<%/u.test(value);
}

function stripQueryAndHash(value: string): string {
  const hashIndex = value.indexOf("#");
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutHash.indexOf("?");
  return queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
}

function normalizeReference(fromPath: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || isExternalReference(trimmed) || isDynamicReference(trimmed)) {
    return null;
  }
  const stripped = stripQueryAndHash(trimmed);
  if (!stripped || stripped.endsWith("/")) {
    return null;
  }
  const resolved = stripped.startsWith("/")
    ? posix.normalize(stripped)
    : posix.normalize(posix.join(dirname(fromPath), stripped));
  const path = resolved.startsWith("/") ? resolved : `/${resolved}`;
  if (!isSafeSitePath(path)) {
    throw new Error(`Invalid asset reference in ${fromPath}: ${raw}`);
  }
  return path;
}

function shouldRequireHtmlReference(path: string): boolean {
  return extname(path).length > 0 || path.startsWith("/assets/");
}

function isHtmlExtension(ext: string): boolean {
  return ext === ".html" || ext === ".htm";
}

function shouldValidateReferences(ext: string): boolean {
  return isHtmlExtension(ext) || ext === ".css";
}

function collectSrcsetReferences(value: string): string[] {
  return value
    .split(",")
    .map((entry) => {
      return entry.trim().split(/\s+/u)[0] ?? "";
    })
    .filter(Boolean);
}

function collectHtmlReferences(text: string): string[] {
  const references: string[] = [];
  for (const match of text.matchAll(HTML_REFERENCE_RE)) {
    if (match[1]) references.push(match[1]);
  }
  for (const match of text.matchAll(SRCSET_RE)) {
    if (!match[1]) continue;
    references.push(...collectSrcsetReferences(match[1]));
  }
  return references;
}

function collectCssReferences(text: string): string[] {
  const references: string[] = [];
  for (const match of text.matchAll(CSS_URL_RE)) {
    if (match[1]) references.push(match[1]);
  }
  for (const match of text.matchAll(CSS_IMPORT_RE)) {
    if (match[1]) references.push(match[1]);
  }
  return references;
}

function collectReferences(ext: string, text: string): string[] {
  return isHtmlExtension(ext)
    ? collectHtmlReferences(text)
    : collectCssReferences(text);
}

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function textFile(path: string, content: string): StaticSiteFile {
  const bytes = new TextEncoder().encode(content);
  return {
    content: bytes,
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: inferContentType(path),
  };
}

function ensureDefaultRobots(
  files: readonly StaticSiteFile[],
  options: StaticSiteScanOptions,
): readonly StaticSiteFile[] {
  if (
    options.defaultRobots !== "disallow-all" ||
    files.some((file) => {
      return file.path === "/robots.txt";
    })
  ) {
    return files;
  }

  return [...files, textFile("/robots.txt", DEFAULT_HOSTED_SITE_ROBOTS_TXT)];
}

async function walk(
  root: string,
  dir: string,
  files: StaticSiteFile[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported file type in hosted site: ${fullPath}`);
    }

    const fileStat = await stat(fullPath);
    const path = toSitePath(root, fullPath);
    if (!isSafeSitePath(path)) {
      throw new Error(`Invalid hosted-site path: ${path}`);
    }
    files.push({
      absolutePath: fullPath,
      path,
      size: fileStat.size,
      sha256: await hashFile(fullPath),
      contentType: inferContentType(path),
      immutable: looksImmutable(path) || undefined,
    });
  }
}

async function assertReferencesExist(
  files: readonly StaticSiteFile[],
): Promise<void> {
  const byPath = new Map(
    files.map((file) => {
      return [file.path, file];
    }),
  );

  for (const file of files) {
    const ext = extname(file.path).toLowerCase();
    if (!shouldValidateReferences(ext)) {
      continue;
    }
    if (!file.absolutePath) {
      throw new Error(`Hosted-site file has no source: ${file.path}`);
    }
    const text = await readFile(file.absolutePath, "utf8");
    const references = collectReferences(ext, text);

    for (const reference of references) {
      const normalized = normalizeReference(file.path, reference);
      if (!normalized) {
        continue;
      }
      if (isHtmlExtension(ext) && !shouldRequireHtmlReference(normalized)) {
        continue;
      }
      if (!byPath.has(normalized)) {
        throw new Error(
          `Missing asset referenced by ${file.path}: ${reference}`,
        );
      }
    }
  }
}

export async function scanStaticSite(
  rootPath: string,
  options: StaticSiteScanOptions = {},
): Promise<StaticSiteScanResult> {
  const root = resolve(rootPath);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Hosted site path must be a directory: ${rootPath}`);
  }

  const files: StaticSiteFile[] = [];
  await walk(root, root, files);

  if (
    !files.some((file) => {
      return file.path === "/index.html";
    })
  ) {
    throw new Error("Hosted site directory must include index.html");
  }

  await assertReferencesExist(files);
  const publishFiles = [...ensureDefaultRobots(files, options)];
  for (const file of publishFiles) {
    const nameError = hostedSiteAssetNameError(file);
    if (nameError) {
      throw new Error(nameError);
    }
  }

  return {
    root,
    files: publishFiles.sort((a, b) => {
      return a.path.localeCompare(b.path);
    }),
  };
}

export async function readStaticSiteFile(
  file: StaticSiteFile,
): Promise<Uint8Array> {
  if (file.content) {
    return file.content;
  }
  if (!file.absolutePath) {
    throw new Error(`Hosted-site file has no source: ${file.path}`);
  }
  const bytes = await readFile(file.absolutePath);
  return new Uint8Array(bytes);
}
