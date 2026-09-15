import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit, type Page } from "@playwright/test";

// Use a prepared preview chat and private authenticated storage state. This
// script only holds GET responses; it does not create messages or grant access.
// pnpm exec tsx playwright/regressions/chat-card-scroll.ts \
//   <app-origin> <api-origin> <thread-id> <storage-state.json> <output-dir> \
//   <recovery|connector|mail|browser|banking|permission> <card-count>
// The chat must overflow by at least 240px and contain the selected card family.

const scenarios = {
  recovery: {
    frame: '[data-testid="assistant-error-card-shell"]',
    pending:
      '[data-testid="assistant-error-card-shell"]:not(:has([data-testid="assistant-error-recovery"]))',
    ready: '[data-testid="assistant-error-recovery"]',
    request: /^\/api\/runs\/[0-9a-f-]{36}$/u,
  },
  connector: {
    frame: '[data-testid="connector-action-card-shell"]',
    pending: '[data-testid="connector-action-card-loading"]',
    ready:
      '[data-testid="connector-action-card"], [data-testid="connector-action-card-shell"] [data-testid="unavailable-action-card"]',
    request:
      /^\/api\/connector-catalog\/(?!status$|discovery$|diagnostics$)[^/]+$/u,
  },
  mail: {
    frame: '[data-testid="mail-draft-card-shell"]',
    pending: '[data-testid="mail-draft-card-loading"]',
    ready: "[data-mail-draft-status]",
    request: /^\/api\/mail\/drafts\/[0-9a-f-]{36}$/u,
  },
  browser: {
    frame: '[data-testid="browser-session-card-shell"]',
    pending: '[data-testid="browser-session-card-loading"]',
    ready: "[data-browser-session-card]",
    request: /^\/api\/chat-threads\/[0-9a-f-]{36}\/browser$/u,
  },
  banking: {
    frame: '[data-testid="banking-action-card-shell"]',
    pending: '[data-testid="banking-action-card-loading"]',
    ready:
      '[data-testid="banking-action-card"], [data-testid="banking-action-card-error"]',
    request: /^\/api\/banking\/access-requests\/[0-9a-f-]{36}$/u,
  },
  permission: {
    frame: '[data-testid="permission-action-card-shell"]',
    pending: '[data-testid="permission-action-card"][aria-busy="true"]',
    ready: '[data-testid="permission-action-card"][aria-busy="false"]',
    request: /^\/api\/connector-catalog\/[^/]+\/permissions$/u,
  },
};

function measure(page: Page, selector: string) {
  return page.evaluate((frameSelector) => {
    const scroll = document.querySelector("[data-scroll-container]");
    if (!scroll) {
      throw new Error("Chat scroll container is missing");
    }
    return {
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      frames: Array.from(document.querySelectorAll(frameSelector), (frame) => {
        const rect = frame.getBoundingClientRect();
        return { top: rect.top, width: rect.width, height: rect.height };
      }),
    };
  }, selector);
}

async function painted(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function main() {
  const [appOrigin, apiOrigin, threadId, storageState, outputDir, kind, count] =
    process.argv.slice(2);
  assert(
    appOrigin &&
      apiOrigin &&
      threadId &&
      storageState &&
      outputDir &&
      kind &&
      count,
  );
  assert(Object.hasOwn(scenarios, kind), `Unknown card family: ${kind}`);
  const scenario = scenarios[kind as keyof typeof scenarios];
  const expected = Number(count);
  assert(Number.isInteger(expected) && expected > 0);
  await mkdir(outputDir, { recursive: true });

  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]) {
        for (const position of ["bottom", "history"]) {
          const context = await browser.newContext({ storageState, viewport });
          context.setDefaultTimeout(30_000);
          try {
            const page = await context.newPage();
            for (const cache of ["cold", "warm"]) {
              let release!: () => void;
              const gate = new Promise<void>((resolve) => {
                release = resolve;
              });
              let held = 0;
              await page.route(
                (url) =>
                  url.origin === apiOrigin &&
                  scenario.request.test(url.pathname),
                async (route) => {
                  if (route.request().method() !== "GET") {
                    await route.continue();
                    return;
                  }
                  const response = await route.fetch();
                  held += 1;
                  await gate;
                  await route.fulfill({ response });
                },
              );
              const label = `${engine.name()}-${kind}-${viewport.width}-${position}-${cache}`;
              try {
                await page.goto(new URL(`/chats/${threadId}`, appOrigin).href);
                await page.waitForFunction(
                  ({ pending, expected }) => {
                    const scroll = document.querySelector(
                      "[data-scroll-container]",
                    );
                    return (
                      document.querySelectorAll(pending).length === expected &&
                      scroll &&
                      scroll.scrollHeight - scroll.clientHeight > 240 &&
                      Math.abs(
                        scroll.scrollHeight -
                          scroll.clientHeight -
                          scroll.scrollTop,
                      ) <= 1
                    );
                  },
                  { pending: scenario.pending, expected },
                );
                await page.evaluate(() =>
                  document.fonts.ready.then(() => undefined),
                );
                if (position === "history") {
                  await page
                    .locator("[data-scroll-container]")
                    .evaluate((scroll) => {
                      scroll.scrollTop =
                        scroll.scrollHeight - scroll.clientHeight - 240;
                    });
                }
                await painted(page);
                const frames = await page
                  .locator(scenario.frame)
                  .elementHandles();
                assert.equal(frames.length, expected);
                const before = await measure(page, scenario.frame);
                release();
                await page.waitForFunction(
                  ({ ready, expected }) =>
                    document.querySelectorAll(ready).length === expected,
                  { ready: scenario.ready, expected },
                );
                await painted(page);
                const after = await measure(page, scenario.frame);
                await writeFile(
                  path.join(outputDir, `${label}.json`),
                  JSON.stringify({ label, held, before, after }, null, 2),
                );
                assert(held > 0, `${label}: no matching response was held`);
                for (const frame of frames) {
                  assert(
                    await frame.evaluate((node) => node.isConnected),
                    `${label}: the sized frame was replaced`,
                  );
                  await frame.dispose();
                }
                assert.equal(
                  after.scrollHeight,
                  before.scrollHeight,
                  `${label}: transcript height changed`,
                );
                assert.equal(
                  after.clientHeight,
                  before.clientHeight,
                  `${label}: viewport changed`,
                );
                assert(
                  Math.abs(after.scrollTop - before.scrollTop) <= 1,
                  `${label}: reading position moved`,
                );
                assert.deepEqual(
                  after.frames,
                  before.frames,
                  `${label}: cards moved or resized`,
                );
                const gap =
                  after.scrollHeight - after.clientHeight - after.scrollTop;
                assert(
                  Math.abs(gap - (position === "bottom" ? 0 : 240)) <= 1,
                  `${label}: lost the requested reading position`,
                );
                console.log(`${label}: passed`);
              } finally {
                release();
                await page.unrouteAll({ behavior: "wait" });
              }
            }
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
