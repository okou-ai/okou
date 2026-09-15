import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { webkit, type Page } from "@playwright/test";

// Run against a prepared preview thread with an authenticated storage state:
// pnpm exec tsx playwright/regressions/connector-card-scroll.ts \
//   <app-origin> <api-origin> <thread-id> <storage-state.json> <output-dir> <card-count>
// The thread must overflow the viewport and contain resolved account cards.
// Keep the storage-state file private; only screenshots and geometry are saved.

function measure(page: Page) {
  return page.evaluate(() => {
    const container = document.querySelector("[data-scroll-container]");
    if (!container) {
      throw new Error("Expected a chat scroll container");
    }
    return {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      cards: Array.from(
        document.querySelectorAll(
          '[data-testid^="connector-account-action-card"]',
        ),
      ).map((card) => {
        const frame = card.closest('[data-slot="markdown-card"]');
        if (!frame) {
          throw new Error("Expected a rendered account card");
        }
        const rect = frame.getBoundingClientRect();
        return { top: rect.top, height: rect.height };
      }),
    };
  });
}

async function main() {
  const [appOrigin, apiOrigin, threadId, storageState, outputDir, count] =
    process.argv.slice(2);
  assert(
    appOrigin && apiOrigin && threadId && storageState && outputDir && count,
  );
  const expectedCards = Number(count);
  assert(Number.isInteger(expectedCards) && expectedCards > 0);
  await mkdir(outputDir, { recursive: true });

  const browser = await webkit.launch();
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ storageState, viewport });
      context.setDefaultTimeout(30_000);
      const page = await context.newPage();
      for (const cache of ["cold", "warm"]) {
        let release: () => void;
        const pendingAccount = new Promise<void>((resolve) => {
          release = resolve;
        });
        const releaseAccount = () => release();
        await page.route(
          (url) =>
            url.origin === apiOrigin &&
            /^\/api\/connector-accounts\/[0-9a-f-]{36}$/u.test(url.pathname),
          async (route) => {
            const response = await route.fetch();
            await pendingAccount;
            await route.fulfill({ response });
          },
        );
        const label = `webkit-${viewport.width}-${cache}`;
        try {
          await page.goto(new URL(`/chats/${threadId}`, appOrigin).href);
          await page.waitForFunction((cardCount) => {
            const scroll = document.querySelector("[data-scroll-container]");
            return (
              document.querySelectorAll(
                '[data-testid="connector-account-action-card-loading"]',
              ).length === cardCount &&
              scroll &&
              scroll.scrollHeight > scroll.clientHeight &&
              Math.abs(
                scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
              ) <= 1
            );
          }, expectedCards);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const before = await measure(page);
          await page.screenshot({
            path: path.join(outputDir, `${label}-loading.png`),
          });
          releaseAccount();
          await page.waitForFunction(
            (cardCount) =>
              document.querySelectorAll(
                '[data-testid="connector-account-action-card"]',
              ).length === cardCount,
            expectedCards,
          );
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                );
              }),
          );
          const after = await measure(page);
          await page.screenshot({
            path: path.join(outputDir, `${label}-ready.png`),
          });
          const result = { label, before, after };
          await writeFile(
            path.join(outputDir, `${label}.json`),
            JSON.stringify(result, null, 2),
          );
          console.log(JSON.stringify(result));
          assert.equal(
            after.scrollHeight,
            before.scrollHeight,
            `${label}: transcript height changed`,
          );
          assert(
            Math.abs(after.scrollTop - before.scrollTop) <= 1,
            `${label}: loading moved the reading position`,
          );
          assert.deepEqual(
            after.cards,
            before.cards,
            `${label}: account cards moved or resized`,
          );
          assert(
            Math.abs(
              after.scrollHeight - after.clientHeight - after.scrollTop,
            ) <= 1,
            `${label}: lost the bottom position`,
          );
        } finally {
          releaseAccount();
          await page.unrouteAll({ behavior: "wait" });
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
