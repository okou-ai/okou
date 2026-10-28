import { createRequire } from "node:module";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeHeaders, sanitizeNetlog } from "./netlog.mjs";

const require = createRequire(
  new URL("../../e2e/package.json", import.meta.url),
);

export async function probeBrowser({
  origin,
  assets,
  protocol,
  rawDirectory,
  outputDirectory,
}) {
  const { chromium } = require("@playwright/test");
  const rawLog = join(rawDirectory, `${protocol}.netlog.json`);
  const fixtureUrl = `${origin}/__resource_transport_probe__`;
  const urls = assets.map((asset) => `${origin}/okou-app/assets/${asset.name}`);
  const allowedUrls = new Set([fixtureUrl, ...urls]);
  const records = new Map();
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const browser = await chromium.launch({
    ...(process.env.E2E_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: [
      "--disable-quic",
      ...(protocol === "h1" ? ["--disable-http2"] : []),
      `--log-net-log=${rawLog}`,
      "--net-log-capture-mode=Default",
    ],
  });
  let result;
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      if (route.request().url() === fixtureUrl) {
        await route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Resource transport probe</title>",
        });
      } else if (
        allowedUrls.has(route.request().url()) &&
        route.request().method() === "GET"
      ) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    session.on("Network.requestWillBeSent", (event) => {
      if (urls.includes(event.request.url)) {
        records.set(event.requestId, {
          url: event.request.url,
          startedMs: elapsed(),
          bytes: 0,
          dataEvents: 0,
        });
      }
    });
    session.on("Network.responseReceivedExtraInfo", (event) => {
      const record = records.get(event.requestId);
      if (record)
        record.early = {
          ms: elapsed(),
          status: event.statusCode,
          headers: safeHeaders(event.headers),
        };
    });
    session.on("Network.responseReceived", (event) => {
      const record = records.get(event.requestId);
      if (record)
        Object.assign(record, {
          responseMs: elapsed(),
          status: event.response.status,
          protocol: event.response.protocol,
          connectionId: event.response.connectionId,
          headers: safeHeaders(event.response.headers),
        });
    });
    session.on("Network.dataReceived", (event) => {
      const record = records.get(event.requestId);
      if (record) {
        record.bytes += event.dataLength;
        record.dataEvents++;
        record.firstDataMs ??= elapsed();
        record.lastDataMs = elapsed();
      }
    });
    session.on("Network.loadingFinished", (event) => {
      const record = records.get(event.requestId);
      if (record)
        Object.assign(record, {
          outcome: "finished",
          endedMs: elapsed(),
          encodedBytes: event.encodedDataLength,
        });
    });
    session.on("Network.loadingFailed", (event) => {
      const record = records.get(event.requestId);
      if (record)
        Object.assign(record, {
          outcome: "failed",
          endedMs: elapsed(),
          error: /^net::ERR_[A-Z_]+$/u.test(event.errorText)
            ? event.errorText
            : "unclassified",
        });
    });
    await session.send("Network.enable");
    await page.goto(fixtureUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const transfers = await page.evaluate(async (targets) => {
      return Promise.all(
        targets.map(async (url) => {
          const start = performance.now();
          let bytes = 0;
          let chunks = 0;
          let firstDataMs;
          let lastDataMs;
          let status;
          try {
            const response = await fetch(url, {
              method: "GET",
              credentials: "omit",
              redirect: "error",
              mode: "same-origin",
              signal: AbortSignal.timeout(30_000),
            });
            status = response.status;
            const reader = response.body.getReader();
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              chunks++;
              firstDataMs ??= Math.round(performance.now() - start);
              lastDataMs = Math.round(performance.now() - start);
            }
            return {
              url,
              status,
              bytes,
              chunks,
              firstDataMs,
              lastDataMs,
              completed: true,
              elapsedMs: Math.round(performance.now() - start),
            };
          } catch (error) {
            return {
              url,
              status,
              bytes,
              chunks,
              firstDataMs,
              lastDataMs,
              completed: false,
              elapsedMs: Math.round(performance.now() - start),
              errorName: error.name,
            };
          }
        }),
      );
    }, urls);
    const expectedProtocol = protocol === "h2" ? "h2" : "http/1.1";
    result = {
      requestedProtocol: protocol,
      browserVersion: browser.version(),
      transfers,
      requests: [...records.values()],
      ok:
        transfers.every(
          (transfer, index) =>
            transfer.completed &&
            transfer.status === 200 &&
            transfer.bytes === assets[index].bytes,
        ) &&
        records.size === assets.length &&
        [...records.values()].every(
          (record) => record.protocol === expectedProtocol,
        ),
    };
    await session.detach();
    await context.close();
  } finally {
    await browser.close();
    const log = sanitizeNetlog(
      JSON.parse(await readFile(rawLog, "utf8")),
      allowedUrls,
    );
    await writeFile(
      join(outputDirectory, `browser-${protocol}.netlog.json`),
      JSON.stringify(log),
    );
    await rm(rawLog);
    await writeFile(
      join(outputDirectory, `browser-${protocol}.json`),
      JSON.stringify(
        result ?? {
          requestedProtocol: protocol,
          ok: false,
          reason: "browser-probe-incomplete",
          requests: [...records.values()],
        },
        null,
        2,
      ),
    );
  }
  return result;
}
