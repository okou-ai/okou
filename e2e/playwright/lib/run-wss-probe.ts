import { build } from "esbuild";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

export async function bundleRunWssProbe(): Promise<string> {
  const result = await build({
    entryPoints: [resolve(__dirname, "run-wss-browser.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "RunWssProbeModule",
    footer: { js: "globalThis.RunWssProbeModule = RunWssProbeModule;" },
    nodePaths: [resolve(__dirname, "../../node_modules")],
    logLevel: "silent",
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error("Browser transport bundle unavailable");
  return output;
}

export async function installRunWssProbe(
  page: Page,
  bundle: string,
  apiUrl: string,
  bypassSecret?: string,
): Promise<void> {
  await page.evaluate(bundle);
  await page.evaluate(
    ({ apiUrl, bypassSecret }) => {
      window.__runWssProbe = window.RunWssProbeModule.createRunWssProbe(
        apiUrl,
        bypassSecret,
      );
    },
    { apiUrl, bypassSecret },
  );
}

export async function verifyRunWssEcho(
  page: Page,
  runId: string,
  expectedUrl: string,
  replay: boolean,
): Promise<void> {
  await page.evaluate(
    async ({ runId, expectedUrl }) => {
      if (!window.__runWssProbe) throw new Error("Browser probe missing");
      await window.__runWssProbe.connect(runId, expectedUrl);
    },
    { runId, expectedUrl },
  );
  const sizes = await page.evaluate(async () => {
    if (!window.__runWssProbe) throw new Error("Browser probe missing");
    return await window.__runWssProbe.echo();
  });
  expect(sizes).toEqual([0, 1, 17, 1024, 65536, 37]);
  if (replay) {
    const proof = await page.evaluate(async () => {
      if (!window.__runWssProbe) throw new Error("Browser probe missing");
      return await window.__runWssProbe.replay();
    });
    expect(proof.opened).toBe(true);
    expect(proof.admissionSent).toBe(true);
    expect(proof.authOk).toBe(false);
    expect(proof.closeCode).toBe(1000);
    expect(proof.remainingMs).toBeGreaterThan(5_000);
    expect(proof.endedBeforeExpiry).toBe(true);
  }
}

export async function verifyRunWssRevocation(
  page: Page,
  runId: string,
): Promise<void> {
  await page.waitForFunction(
    () => window.__runWssProbe?.state === "failed",
    undefined,
    { timeout: 30_000 },
  );
  const statuses = await page.evaluate(
    () => window.__runWssProbe?.bootstrapStatuses,
  );
  expect(statuses?.at(-1)).toBe(404);
  const freshStatus = await page.evaluate(async (id) => {
    if (!window.__runWssProbe) throw new Error("Browser probe missing");
    return await window.__runWssProbe.bootstrapStatus(id);
  }, runId);
  expect(freshStatus).toBe(404);
}

export async function closeRunWssProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__runWssProbe?.close();
    window.__runWssProbe = undefined;
  });
}
