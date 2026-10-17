import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, type Locator } from "@playwright/test";

// Run against a deployed PR with Debug enabled and an active Run containing
// at least 100 home-directory entries. Keep the authenticated state private:
// pnpm exec tsx playwright/regressions/activity-files-scroll.ts \
//   <preview-app-origin> <run-id> <storage-state.json> <output-dir>

function measure(viewport: Locator) {
  return viewport.evaluate((element) => {
    const files = element.querySelector('section[aria-label="Files"]');
    const navigation = files?.querySelector('nav[aria-label="Current folder"]');
    const toolbar = navigation?.parentElement;
    const list = files?.querySelector(
      '[data-testid="sandbox-files-virtual-list"]',
    );
    if (!files || !toolbar || !list) {
      throw new Error("Expected the ready Activity Files browser");
    }
    const viewportRect = element.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const scrollers = [files, ...files.querySelectorAll("*")].filter((node) => {
      const style = getComputedStyle(node);
      return (
        /^(auto|scroll)$/.test(style.overflowY) &&
        node.scrollHeight > node.clientHeight + 1
      );
    });
    let ancestor: HTMLElement | null = element.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      if (
        /^(auto|scroll)$/.test(style.overflowY) &&
        ancestor.scrollHeight > ancestor.clientHeight + 1
      ) {
        scrollers.push(ancestor);
      }
      ancestor = ancestor.parentElement;
    }
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      otherScrollers: scrollers.length,
      toolbarTop: toolbarRect.top,
      viewportTop: viewportRect.top + element.clientTop,
      toolbarBottom: toolbarRect.bottom,
      visibleRows: [...list.querySelectorAll("li")].filter((row) => {
        const rect = row.getBoundingClientRect();
        return (
          rect.bottom > toolbarRect.bottom && rect.top < viewportRect.bottom
        );
      }).length,
      horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
    };
  });
}

async function main() {
  const [appOrigin, runId, storageState, outputDir] = process.argv.slice(2);
  assert(appOrigin && runId && storageState && outputDir);
  const app = new URL(appOrigin);
  assert.equal(app.origin, appOrigin);
  assert.notEqual(
    app.hostname,
    "app.okou.ai",
    "Use a PR preview, not production",
  );
  assert.match(runId, /^[\da-f-]{36}$/i);
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const context = await browser.newContext({
        storageState,
        viewport: size,
      });
      try {
        const page = await context.newPage();
        await page.goto(
          new URL(`/activities/${runId}?tab=files`, appOrigin).href,
        );
        const files = page.getByRole("region", { name: "Files", exact: true });
        await expect(
          files.getByRole("button", { name: "Refresh", exact: true }),
        ).toBeEnabled();
        const list = files.getByTestId("sandbox-files-virtual-list");
        await expect
          .poll(() => list.evaluate((node) => node.clientHeight))
          .toBeGreaterThanOrEqual(4400);
        const viewport = page.getByTestId("activity-detail-viewport");
        await viewport.evaluate((element) => {
          element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
        });
        await expect
          .poll(async () => {
            const geometry = await measure(viewport);
            return Math.abs(geometry.toolbarTop - geometry.viewportTop);
          })
          .toBeLessThanOrEqual(1);
        await expect
          .poll(async () => (await measure(viewport)).visibleRows)
          .toBeGreaterThan(0);
        await files
          .getByRole("button", { name: "Go to home folder", exact: true })
          .click({ trial: true });
        await files
          .getByRole("button", { name: "Refresh", exact: true })
          .click({ trial: true });
        const middle = await measure(viewport);
        assert.equal(middle.otherScrollers, 0);
        assert.equal(middle.horizontalOverflow, false);
        await viewport.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect
          .poll(async () => (await measure(viewport)).visibleRows)
          .toBeGreaterThan(0);
        const bottom = await measure(viewport);
        assert.equal(bottom.otherScrollers, 0);
        assert(Math.abs(bottom.toolbarTop - bottom.viewportTop) <= 1);
        await page.screenshot({
          path: path.join(outputDir, `${size.width}-${size.height}.png`),
        });
        await writeFile(
          path.join(outputDir, `${size.width}-${size.height}.json`),
          JSON.stringify({ viewport: size, middle, bottom }, null, 2),
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

await main();
