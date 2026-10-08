import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  assertPreviewOutsideSite,
  bundleFingerprint,
} from "../../lib/host/preview";
import { readStaticSiteFile, scanStaticSite } from "../../lib/host/static-site";

const execute = promisify(execFile);
const WIDTH = 1200;
const HEIGHT = 630;
const CAPTURE_TIMEOUT_MS = 60_000;

// Generated charts may hold this promise/boolean until their first frame is ready.
// Infinite animation is sampled, not required to produce identical PNG bytes.
const READY = `(async () => {
  const ready = async () => {
    if (window.__OKOU_PREVIEW_READY__ !== undefined) {
      while (window.__OKOU_PREVIEW_READY__ === false) await new Promise(resolve => setTimeout(resolve, 50));
      await window.__OKOU_PREVIEW_READY__;
    }
    await document.fonts.ready;
    const visible = node => { const r = node.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
    await Promise.all(Array.from(document.images).filter(visible).map(async image => { await image.decode(); if (!image.naturalWidth) throw new Error("Preview image failed to load"); }));
    const urls = [...new Set(Array.from(document.querySelectorAll("*")).filter(visible).flatMap(node => Array.from(getComputedStyle(node).backgroundImage.matchAll(/url\\(["']?([^"')]+)["']?\\)/gu), match => match[1])))];
    await Promise.all(urls.map(async src => { const image = new Image(); image.src = src; await image.decode(); }));
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().iterations !== Infinity) animation.finish();
      else animation.pause();
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  };
  return Promise.race([ready(), new Promise((_, reject) => setTimeout(() => reject(new Error("Preview resources did not become ready")), 15000))]);
})()`;

interface ScreenshotOptions {
  readonly out: string;
  readonly spa?: boolean;
  readonly json?: boolean;
}

async function capture(dir: string, options: ScreenshotOptions) {
  const out = resolve(options.out);
  if (extname(out).toLowerCase() !== ".png")
    throw new Error("--out must name a PNG file");
  assertPreviewOutsideSite(dir, out);
  const scan = await scanStaticSite(dir);
  const fingerprint = bundleFingerprint(scan.files);
  const files = new Map(
    await Promise.all(
      scan.files.map(async (file) => {
        return [
          file.path,
          {
            contentType: file.contentType,
            bytes: await readStaticSiteFile(file),
          },
        ] as const;
      }),
    ),
  );
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file =
      files.get(path.endsWith("/") ? `${path}index.html` : path) ??
      (options.spa && request.headers.accept?.includes("text/html")
        ? files.get("/index.html")
        : undefined);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": file.contentType,
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : file.bytes);
  });
  // Browser defaults can contain an owner's profile, CDP connection or headers.
  // Keep installation/network settings and explicit policy constraints only.
  const inheritedBrowserSettings = new Set([
    "AGENT_BROWSER_EXECUTABLE_PATH",
    "AGENT_BROWSER_CA_CERT",
    "AGENT_BROWSER_PROXY",
    "AGENT_BROWSER_PROXY_BYPASS",
    "AGENT_BROWSER_ALLOWED_DOMAINS",
    "AGENT_BROWSER_ACTION_POLICY",
    "AGENT_BROWSER_CONFIRM_ACTIONS",
    "AGENT_BROWSER_CONFIRM_INTERACTIVE",
  ]);
  const browserEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      return (
        !key.startsWith("AGENT_BROWSER_") || inheritedBrowserSettings.has(key)
      );
    }),
  );
  const browserDir = await mkdtemp(join(tmpdir(), "okou-host-preview-"));
  const config = join(browserDir, "agent-browser.json");
  const session = `okou-host-preview-${randomUUID()}`;
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  const browser = async (args: readonly string[], cleanup = false) => {
    const timeout = cleanup ? 5000 : deadline - Date.now();
    if (timeout <= 0)
      throw new Error("Hosted preview capture exceeded 60 seconds");
    await execute("agent-browser", ["--session", session, ...args], {
      env: { ...browserEnv, AGENT_BROWSER_CONFIG: config },
      timeout,
      maxBuffer: 1024 * 1024,
    });
  };
  let captured = false;
  try {
    await writeFile(config, "{}");
    await new Promise<void>((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListening();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Could not start the local bundle preview");
    await mkdir(dirname(out), { recursive: true });
    await rm(`${out}.okou-preview.json`, { force: true });
    await browser(["set", "viewport", String(WIDTH), String(HEIGHT)]);
    await browser(["set", "media", "reduced-motion"]);
    await browser(["open", `http://127.0.0.1:${address.port}/`]);
    await browser(["eval", READY]);
    await browser(["screenshot", out]);
    if (bundleFingerprint((await scanStaticSite(dir)).files) !== fingerprint) {
      throw new Error(
        "The site changed during capture. Finish editing and capture again",
      );
    }
    const bytes = await readFile(out);
    if (
      bytes.length < 24 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== WIDTH ||
      bytes.readUInt32BE(20) !== HEIGHT
    ) {
      throw new Error("Preview capture returned an invalid image size");
    }
    await writeFile(
      `${out}.okou-preview.json`,
      JSON.stringify({
        version: 1,
        bundleSha256: fingerprint,
        imageSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    captured = true;
    return { path: out, width: WIDTH, height: HEIGHT };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClosed) => {
      server.close(() => {
        return resolveClosed();
      });
    });
    try {
      await browser(["close"], true);
    } catch {
      /* Best-effort cleanup of this isolated, short-lived browser session. */
    }
    await rm(browserDir, { recursive: true, force: true });
    if (!captured) {
      await rm(out, { force: true });
      await rm(`${out}.okou-preview.json`, { force: true });
    }
  }
}

export const screenshotHostedSiteCommand = new Command("screenshot")
  .description("Capture the final static bundle locally for its artifact cover")
  .argument("<dir>", "Final static directory containing index.html")
  .requiredOption("--out <png>", "Output PNG outside the hosted directory")
  .option("--spa", "Serve unknown HTML navigation paths from index.html")
  .option("--json", "Output the local image path and dimensions as JSON")
  .addHelpText(
    "after",
    "\nUses a clean local agent-browser session and a read-only bundle server. Writes a 1200x630 PNG plus a bundle receipt, uploads nothing. Inspect the PNG, then publish with --preview <png>. Re-capture after editing. Requires agent-browser and its browser/fonts in the sandbox.",
  )
  .action(
    withErrorHandler(
      async (dir: string, _options: ScreenshotOptions, command: Command) => {
        const options = command.optsWithGlobals<ScreenshotOptions>();
        const result = await capture(dir, options);
        console.log(
          options.json
            ? JSON.stringify(result)
            : `Captured ${result.path}. Inspect the image, then publish with --preview ${result.path}`,
        );
      },
    ),
  );
