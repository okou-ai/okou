import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, webkit, type Page } from "@playwright/test";

// Run against a prepared preview chat with a wide image artifact and private
// authenticated storage state. No API or browser geometry mocks are used.
// pnpm exec tsx playwright/regressions/image-preview-pan.ts \
//   <app-origin> <thread-id> <artifact-title> <storage-state.json> <output-dir>
// Use an image at least 760px wide, with an aspect ratio of at least 2:1.

function imageGeometry(page: Page) {
  return page.getByTestId("artifact-sidebar-body-image").evaluate((image) => {
    const canvas = image.closest("[data-zoomable-image-canvas]");
    if (!canvas) {
      throw new Error("Image canvas is missing");
    }
    const imageRect = image.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      imageLeft: imageRect.left,
      imageRight: imageRect.right,
      imageWidth: imageRect.width,
      canvasLeft: canvasRect.left,
      canvasRight: canvasRect.right,
      canvasWidth: canvasRect.width,
    };
  });
}

async function panToEdge(page: Page, edge: "left" | "right") {
  const canvas = page
    .getByTestId("artifact-sidebar")
    .getByTestId("zoomable-image-canvas");
  const box = await canvas.boundingBox();
  assert(box);
  const geometry = await imageGeometry(page);
  const distance = box.width * 0.5;
  const gestures = Math.ceil(geometry.imageWidth / distance) + 1;
  // Each gesture stays inside the canvas. Larger images need more gestures,
  // just as they do when a user drags them across a narrow sidebar.
  for (let gesture = 0; gesture < gestures; gesture += 1) {
    const startX = box.x + box.width * (edge === "right" ? 0.75 : 0.25);
    const endX = box.x + box.width * (edge === "right" ? 0.25 : 0.75);
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(endX, y, { steps: 8 });
    await page.mouse.up();
  }
  await expect
    .poll(async () => {
      const current = await imageGeometry(page);
      const edgePosition =
        edge === "right" ? current.imageRight : current.imageLeft;
      return (
        edgePosition >= current.canvasLeft - 1 &&
        edgePosition <= current.canvasRight + 1
      );
    })
    .toBe(true);
}

async function main() {
  const [appOrigin, threadId, artifactTitle, storageState, outputDir] =
    process.argv.slice(2);
  assert(appOrigin && threadId && artifactTitle && storageState && outputDir);
  await mkdir(outputDir, { recursive: true });

  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        storageState,
        viewport: { width: 1800, height: 1000 },
      });
      try {
        const page = await context.newPage();
        await page.goto(new URL(`/chats/${threadId}`, appOrigin).href);
        await page
          .getByRole("button", { name: "Open artifacts", exact: true })
          .click();
        await expect
          .poll(async () => {
            const pane = await page
              .getByTestId("chat-thread-sidebar-pane")
              .boundingBox();
            return pane?.width ?? 0;
          })
          .toBeGreaterThanOrEqual(750);
        await page
          .getByRole("button", {
            name: `Preview ${artifactTitle}`,
            exact: true,
          })
          .click();
        const sidebar = page.getByTestId("artifact-sidebar");
        await expect(
          sidebar.getByTestId("artifact-sidebar-body-image"),
        ).toBeVisible();
        const zoom = sidebar.getByTestId("artifact-sidebar-image-zoom-level");
        await expect(zoom).toHaveText("100%");

        // Shrink the real pane after decoding; the image must remain reachable
        // even when its initial fitted width exceeds the new viewport width.
        const handle = await page
          .getByRole("separator", { name: "Resize sidebar", exact: true })
          .boundingBox();
        assert(handle);
        await page.mouse.move(
          handle.x + handle.width / 2,
          handle.y + handle.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(handle.x + 500, handle.y + handle.height / 2, {
          steps: 12,
        });
        await page.mouse.up();
        await expect
          .poll(async () => {
            const geometry = await imageGeometry(page);
            return geometry.imageWidth - geometry.canvasWidth;
          })
          .toBeGreaterThan(50);
        await expect(zoom).toHaveText("100%");

        await panToEdge(page, "right");
        await panToEdge(page, "left");
        await sidebar
          .getByRole("button", { name: "Zoom in", exact: true })
          .click();
        await expect(zoom).toHaveText("115%");
        await panToEdge(page, "right");
        await panToEdge(page, "left");
        await sidebar
          .getByRole("button", { name: "Reset zoom", exact: true })
          .click();
        await expect(zoom).toHaveText("100%");
        await expect
          .poll(async () => {
            const geometry = await imageGeometry(page);
            return Math.abs(
              (geometry.imageLeft + geometry.imageRight) / 2 -
                (geometry.canvasLeft + geometry.canvasRight) / 2,
            );
          })
          .toBeLessThanOrEqual(1);
        await page.screenshot({
          path: path.join(outputDir, `${engine.name()}-image-preview-pan.png`),
        });
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
}

await main();
