import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  open,
  writeFile,
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium, firefox, webkit, expect } from "@playwright/test";

// Isolated browser acceptance for the production worker's public message/fetch
// boundary. This fixture producer is not Guest/WSS or full Activity acceptance.
// pnpm exec tsx playwright/regressions/sandbox-file-download.ts <output-dir> [engine] [mode]
// The explicit "long" mode sends one chunk every six seconds for over five
// minutes, exercising browser worker lifetime while making regular progress.
// Firefox source failures and Linux WebKit native cancellation require a native
// UI/API check. The helper-app error and source-page polling after MiniBrowser
// cancellation are unreliable. NATIVE_UI_REQUIRED leaves exit code 2, never PASS.
async function main() {
  const output = process.argv[2];
  assert(output, "An explicit output directory is required");
  await mkdir(output, { recursive: true });
  const assets = path.resolve(
    __dirname,
    "../../../turbo/apps/platform/dist/assets",
  );
  const workers = (await readdir(assets)).filter((name) =>
    /^sandbox-file-download-v1-[a-f0-9]{64}\.js$/u.test(name),
  );
  assert.equal(
    workers.length,
    1,
    "Build the production App before browser acceptance",
  );
  const workerFile = workers[0];
  assert(workerFile);
  const worker = await readFile(path.join(assets, workerFile));
  const notificationWorker = await readFile(
    path.resolve(__dirname, "../../../turbo/apps/platform/public/sw.js"),
  );
  const prefix = "/sandbox-file-downloads/v1/";
  assert.equal(
    workerFile,
    `sandbox-file-download-v1-${createHash("sha256").update(worker).digest("hex")}.js`,
  );
  const scriptPath = `/okou-app/assets/${workerFile}`;
  const html = `<!doctype html><meta charset="utf-8"><title>Streaming download fixture</title><script>
window.probe = {
  produced: 0, held: false, terminal: '', waiting: null,
  async prepare(size, mode) {
    const registration = await navigator.serviceWorker.register('${scriptPath}', {scope: '${prefix}', updateViaCache: 'none'});
    const worker = registration.active || registration.installing || registration.waiting;
    if (worker.state !== 'activated') await new Promise((resolve, reject) => worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve();
      if (worker.state === 'redundant') reject(new Error('worker redundant'));
    }));
    this.produced = 0; this.held = false; this.terminal = ''; this.waiting = null;
    const id = crypto.randomUUID();
    const channel = new MessageChannel();
    const ready = Promise.withResolvers();
    const send = (message) => {
      const bytes = new Uint8Array(message.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (Number(message.offset) + i) % 251;
      this.produced += bytes.length;
      // Match the page's progress-triggered worker event, not a periodic ping.
      worker.postMessage({type: 'progress', version: 1, id});
      channel.port1.postMessage({type: 'chunk', offset: message.offset, data: bytes.buffer, final: this.produced === size}, [bytes.buffer]);
    };
    channel.port1.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'ready') ready.resolve();
      else if (message.type === 'pull') {
        if (mode === 'long') {
          setTimeout(() => send(message), 6000);
        } else if (mode === 'failure' && Number(message.offset) >= size - 32768) {
          channel.port1.postMessage({type: 'abort'});
        } else if ((mode === 'held' || mode === 'cancel') && this.produced >= 4 * 1024 * 1024 && !this.resumed) {
          this.held = true;
          // Cancel the consumer while its producer still answers demand.
          // Blocking the producer here delays Firefox's cancel until idle.
          if (mode === 'cancel') send(message); else this.waiting = () => send(message);
        } else send(message);
      } else {
        this.terminal = message.type;
        if (message.type === 'error') ready.reject(new Error(message.code));
        channel.port1.close();
      }
    };
    channel.port1.start();
    worker.postMessage({type: 'prepare', version: 1, id, size: String(size), name: 'report-汉字.bin'}, [channel.port2]);
    await ready.promise;
    const frame = document.createElement('iframe');
    frame.referrerPolicy = 'no-referrer';
    frame.hidden = true;
    frame.src = '${prefix}' + id;
    document.body.append(frame);
  },
  resume() { this.resumed = true; this.waiting(); this.waiting = null; },
};
</script><body>Production worker streaming fixture</body>`;

  const controls = new Map<string, ServerResponse>();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/control-failure.bin") {
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", "70003");
      response.setHeader(
        "Content-Disposition",
        "attachment; filename*=UTF-8''report-%E6%B1%89%E5%AD%97.bin",
      );
      response.write(Buffer.alloc(32768));
      controls.set("failure", response);
    } else if (request.url === "/sw.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.setHeader("Service-Worker-Allowed", "/");
      response.end(notificationWorker);
    } else if (request.url === scriptPath) {
      response.setHeader("Content-Type", "text/javascript");
      response.setHeader("Service-Worker-Allowed", prefix);
      response.end(worker);
    } else {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  function expectedHash(size: number) {
    const hash = createHash("sha256");
    for (let offset = 0; offset < size; offset += 32768) {
      const bytes = Buffer.alloc(Math.min(32768, size - offset));
      for (let index = 0; index < bytes.length; index++)
        bytes[index] = (offset + index) % 251;
      hash.update(bytes);
    }
    return hash.digest("hex");
  }
  async function hashFile(file: string) {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest("hex");
  }
  async function partialFile(
    directory: string,
  ): Promise<{ size: number; allocated: number; prefixHash: string } | null> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await partialFile(file);
        if (found) return found;
      } else if (entry.isFile()) {
        const info = await stat(file);
        if (info.size < 32768) continue;
        const handle = await open(file, "r");
        try {
          const bytes = Buffer.alloc(32768);
          await handle.read(bytes, 0, bytes.length, 0);
          const prefixHash = createHash("sha256").update(bytes).digest("hex");
          if (prefixHash === expectedHash(32768))
            return {
              size: info.size,
              allocated: info.blocks * 512,
              prefixHash,
            };
        } finally {
          await handle.close();
        }
      }
    }
    return null;
  }

  const results: unknown[] = [];
  // Descriptive Linux snapshots of this fixture and its browser descendants.
  // These are not memory peaks or production/fleet measurements.
  function residentKiB(): number | null {
    if (process.platform !== "linux") return null;
    const processes = execFileSync("ps", ["-e", "-o", "pid=,ppid=,rss="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u).map(Number));
    const owned = new Set([process.pid]);
    for (;;) {
      const previous = owned.size;
      for (const [pid, parent] of processes)
        if (pid !== undefined && parent !== undefined && owned.has(parent))
          owned.add(pid);
      if (previous === owned.size) break;
    }
    return processes.reduce(
      (total, [pid, , rss]) =>
        total + (pid !== undefined && owned.has(pid) ? (rss ?? 0) : 0),
      0,
    );
  }
  try {
    for (const [name, engine] of Object.entries({
      chromium,
      firefox,
      webkit,
    })) {
      if (process.argv[3] && process.argv[3] !== name) continue;
      const downloads = path.join(output, `${name}-temporary`);
      await mkdir(downloads, { recursive: true });
      const browser = await engine.launch({
        downloadsPath: downloads,
        ...(name === "chromium"
          ? {
              executablePath:
                process.env.E2E_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
            }
          : {}),
      });
      try {
        for (const [size, mode] of [
          [0, "normal"],
          [70003, "normal"],
          [128 * 1024 * 1024, "held"],
          [70003, "failure"],
          [128 * 1024 * 1024, "cancel"],
          ...(process.argv[4] === "http-failure"
            ? ([[70003, "http-failure"]] as const)
            : []),
          ...(process.argv[4] === "long"
            ? ([[55 * 32768, "long"]] as const)
            : []),
        ] as const) {
          if (process.argv[4] && process.argv[4] !== mode) continue;
          if (
            name === "webkit" &&
            process.platform === "linux" &&
            mode === "cancel"
          ) {
            // An independent streaming worker reproduces page replacement
            // during cancellation. Verify the native incomplete-file outcome
            // AND source connection closure through independent native UI/API
            // evidence; an Inspector RPC or old-page query proves neither.
            const result = {
              engine: name,
              version: browser.version(),
              mode,
              size,
              result: "NATIVE_UI_REQUIRED",
              reason:
                "Verify native WebKit cancellation leaves an incomplete file and closes its source connection; Linux MiniBrowser may replace the source page during cancellation.",
            };
            results.push(result);
            process.stdout.write(JSON.stringify(result) + "\n");
            process.exitCode = 2;
            continue;
          }
          const context = await browser.newContext({ acceptDownloads: true });
          const startedAt = performance.now();
          let readState: (() => Promise<unknown>) | undefined;
          try {
            const page = await context.newPage();
            await page.goto(origin);
            await page.evaluate(async () => {
              await navigator.serviceWorker.register("/sw.js", { scope: "/" });
              await navigator.serviceWorker.ready;
            });
            await page.reload();
            readState = () =>
              page.evaluate(() => ({
                produced: window.probe.produced,
                held: window.probe.held,
                terminal: window.probe.terminal,
              }));
            assert.equal(
              await page.evaluate(
                () =>
                  new URL(navigator.serviceWorker.controller!.scriptURL)
                    .pathname,
              ),
              "/sw.js",
            );
            const residentBeforeKiB = residentKiB();
            const started = page.waitForEvent("download");
            await page.evaluate(
              async ({ size, mode }) => {
                if (mode === "http-failure") {
                  const frame = document.createElement("iframe");
                  frame.src = "/control-failure.bin";
                  document.body.append(frame);
                } else await window.probe.prepare(size, mode);
              },
              { size, mode },
            );
            const download = await started;
            if (mode === "http-failure") controls.get("failure")?.destroy();
            assert.equal(download.suggestedFilename(), "report-汉字.bin");
            let partial = null;
            if (mode === "held" || mode === "cancel") {
              await page.waitForFunction(() => window.probe.held);
              if (mode === "held") {
                await expect
                  .poll(async () => (await partialFile(downloads))?.prefixHash)
                  .toBe(expectedHash(32768));
                partial = await partialFile(downloads);
                assert(partial && partial.allocated > 0);
                process.stdout.write(
                  JSON.stringify({
                    engine: name,
                    mode,
                    residentBeforeKiB,
                    residentHeldKiB: residentKiB(),
                    partial,
                  }) + "\n",
                );
                await page.evaluate(() => window.probe.resume());
              } else await download.cancel();
            }
            if (
              mode === "failure" ||
              mode === "cancel" ||
              mode === "http-failure"
            ) {
              if (
                name === "firefox" &&
                (mode === "failure" || mode === "http-failure")
              ) {
                if (mode === "failure") {
                  await page.waitForFunction(
                    () => window.probe.terminal === "cancelled",
                  );
                }
                // Firefox's helper-app error prompt lives in browser chrome.
                // It blocks failure(), which returns null after dismissal even
                // though the native UI says the source could not be read.
                // Require native UI evidence instead of a false automatic pass.
                const result = {
                  engine: name,
                  version: browser.version(),
                  mode,
                  size,
                  result: "NATIVE_UI_REQUIRED",
                  reason:
                    "Verify the headed browser reports an incomplete download; Playwright failure() cannot observe this native error reliably.",
                };
                results.push(result);
                process.stdout.write(JSON.stringify(result) + "\n");
                process.exitCode = 2;
                continue;
              }
              let timer: ReturnType<typeof setTimeout> | undefined;
              const failed = await Promise.race([
                download.failure(),
                new Promise<"deadline">((resolve) => {
                  timer = setTimeout(() => resolve("deadline"), 5000);
                }),
              ]);
              clearTimeout(timer);
              if (failed === "deadline") {
                throw new Error(
                  `${name} ${mode}: download failure did not settle`,
                );
              }
              assert.notEqual(failed, null);
              if (mode !== "http-failure")
                await page.waitForFunction(
                  () =>
                    window.probe.terminal === "cancelled" ||
                    window.probe.terminal === "error",
                );
            } else {
              assert.equal(await download.failure(), null);
              const target = path.join(output, `${name}-${size}.bin`);
              await download.saveAs(target);
              assert.equal((await stat(target)).size, size);
              assert.equal(await hashFile(target), expectedHash(size));
            }
            const observed = await page.evaluate(() => ({
              produced: window.probe.produced,
              terminal: window.probe.terminal,
              pageController: new URL(
                navigator.serviceWorker.controller!.scriptURL,
              ).pathname,
            }));
            assert.equal(observed.pageController, "/sw.js");
            const result = {
              engine: name,
              version: browser.version(),
              durationMs: Math.round(performance.now() - startedAt),
              size,
              mode,
              partial,
              residentBeforeKiB,
              residentAfterKiB: residentKiB(),
              ...observed,
              result: "PASS",
            };
            results.push(result);
            process.stdout.write(JSON.stringify(result) + "\n");
          } catch (error) {
            const state = await readState?.().catch(() => ({
              stateUnavailable: true,
            }));
            const result = {
              engine: name,
              version: browser.version(),
              mode,
              size,
              durationMs: Math.round(performance.now() - startedAt),
              result: "FAIL",
              state,
              reason: error instanceof Error ? error.message : String(error),
            };
            results.push(result);
            process.stdout.write(JSON.stringify(result) + "\n");
            throw error;
          } finally {
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await writeFile(
      path.join(output, "results.json"),
      JSON.stringify(
        {
          workerSha256: createHash("sha256").update(worker).digest("hex"),
          results,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

declare global {
  interface Window {
    probe: {
      produced: number;
      held: boolean;
      terminal: string;
      prepare(size: number, mode: string): Promise<void>;
      resume(): void;
    };
  }
}
