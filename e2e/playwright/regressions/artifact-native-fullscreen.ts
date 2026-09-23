import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, type Locator, type Page } from "@playwright/test";

// Run against deployed builds, without a local server or authenticated state:
// pnpm exec tsx playwright/regressions/artifact-native-fullscreen.ts \
//   <app-origin> <api-origin> <output-dir> [expected-build-sha]
// BROWSER_CDP_URL connects to an existing Chromium; otherwise optionally set
// CHROMIUM_EXECUTABLE_PATH and HEADED=1. The bypass secret is sent only to the
// supplied origins as a header, and never included in evidence URLs.
const reference = "layeraudit.md";
const markdown =
  "# Layer audit\n\n```mermaid\nflowchart LR\n  Fullscreen --> Diagram\n```\n" +
  Array.from(
    { length: 40 },
    (_, index) =>
      `\n## Reading position ${index + 1}\n\nThis paragraph makes the preview scrollable.\n`,
  ).join("");
const lightbox = '[data-testid="public-artifact-lightbox"]';
const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const isNative = (page: Page) =>
  page.evaluate(() => Boolean(document.fullscreenElement));

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.waitForFunction(() =>
    Array.from(
      document.querySelectorAll('[data-slot="dialog-content"][data-open]'),
    ).every((popup) => Number(getComputedStyle(popup).opacity) === 1),
  );
}

function measure(page: Page) {
  return page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    const native = document.fullscreenElement;
    const trigger = document.querySelector(
      'main button[aria-label="Expand diagram"]',
    );
    let scroll = trigger?.parentElement ?? null;
    while (
      scroll &&
      !(
        scroll.scrollHeight > scroll.clientHeight &&
        /auto|scroll/u.test(getComputedStyle(scroll).overflowY)
      )
    ) {
      scroll = scroll.parentElement;
    }
    const hit = (element: Element | null | undefined) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const target = document.elementFromPoint(x, y);
      return {
        x,
        y,
        width: rect.width,
        height: rect.height,
        tag: target?.tagName ?? null,
        label:
          target?.closest("[aria-label]")?.getAttribute("aria-label") ?? null,
        insideDialog: Boolean(dialog?.contains(target)),
        insideElement: Boolean(element.contains(target)),
      };
    };
    const header = document.querySelector("header");
    return {
      path: location.pathname,
      viewport: { width: innerWidth, height: innerHeight },
      nativeTarget: native?.tagName ?? null,
      nativeContainsDialog: Boolean(dialog && native?.contains(dialog)),
      headerVisible: Boolean(header?.getClientRects().length),
      scrollTop: scroll?.scrollTop ?? null,
      triggerTop: trigger?.getBoundingClientRect().top ?? null,
      dialogMode: dialog?.getAttribute("data-mode") ?? null,
      dialogCenter: hit(dialog),
      dialogClose: hit(dialog?.querySelector('button[aria-label="Close"]')),
      pageExit: hit(
        document.querySelector('main button[aria-label="Exit fullscreen"]'),
      ),
      dialogContainsFocus: Boolean(dialog?.contains(document.activeElement)),
      focusLabel: document.activeElement?.getAttribute("aria-label") ?? null,
      zoom:
        dialog?.querySelector(
          '[data-testid="artifact-dialog-image-zoom-level"]',
        )?.textContent ?? null,
      tooltips: Array.from(document.querySelectorAll('[role="tooltip"]')).map(
        (tooltip) => ({
          text: tooltip.textContent,
          nativeContains: Boolean(native?.contains(tooltip)),
        }),
      ),
    };
  }, lightbox);
}

function assertDialogHit(
  result: Awaited<ReturnType<typeof measure>>,
  native: boolean,
) {
  assert(result.dialogCenter?.insideDialog, "Dialog center hit");
  assert(result.dialogClose?.insideElement, "Close button hit");
  if (native) assert(result.nativeContainsDialog, "Portal inside native host");
}

async function main() {
  const [appArg, apiArg, outputDir, expectedBuildSha] = process.argv.slice(2);
  assert(
    appArg && apiArg && outputDir,
    "Expected app-origin api-origin output-dir [expected-build-sha]",
  );
  const appOrigin = new URL(appArg).origin;
  const apiOrigin = new URL(apiArg).origin;
  assert(
    appOrigin.startsWith("https://") && apiOrigin.startsWith("https://"),
    "Use deployed HTTPS origins",
  );
  if (expectedBuildSha) assert.match(expectedBuildSha, /^[a-f0-9]{40}$/u);
  const artifactUrl = new URL(`/artifacts/${reference}`, appOrigin).href;
  const metadataUrl = new URL(
    `/api/artifact-references/${reference}/public`,
    apiOrigin,
  ).href;
  const contentUrl = new URL("/__regression__/layer-audit.md", appOrigin).href;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  await mkdir(outputDir, { recursive: true });
  const browser = process.env.BROWSER_CDP_URL
    ? await chromium.connectOverCDP(process.env.BROWSER_CDP_URL)
    : await chromium.launch({
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
        headless: process.env.HEADED !== "1",
      });
  try {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport, locale: "en-US" });
      context.setDefaultTimeout(30_000);
      if (bypass)
        await context.route(
          (url) => [appOrigin, apiOrigin].includes(url.origin),
          (route) =>
            route.continue({
              headers: {
                ...route.request().headers(),
                "x-vercel-protection-bypass": bypass,
              },
            }),
        );
      const page = await context.newPage();
      const label = `chromium-${viewport.width}`;
      const fixtures = { metadata: 0, markdown: 0 };
      const snapshots: Array<{
        step: string;
        state: Awaited<ReturnType<typeof measure>>;
      }> = [];
      const report = {
        appOrigin,
        apiOrigin,
        artifactUrl,
        expectedBuildSha,
        viewport,
        fixtureLimits:
          "Only two exact GET URLs are fulfilled: artifactReferences.publicUrl metadata and Markdown bytes. No authentication, sharing, or artifact storage is validated. No Fullscreen API, DOM, CSS, Dialog, or Portal is replaced. The original diagram is followed by text for scroll checks.",
        lifecycleLimits:
          "SPA navigation uses history.pushState and popstate. Escape records Chromium's actual result; browser-reserved keys are not overridden. Deterministically delayed requests and unsupported/rejected API fallback belong to the page integration tests.",
        buildSha: "",
        userAgent: "",
        status: "running",
        failure: "",
        fixtures,
        snapshots,
      };
      const save = () =>
        writeFile(
          path.join(outputDir, `${label}.json`),
          JSON.stringify(report, null, 2),
        );
      const capture = async (step: string) => {
        await settle(page);
        const state = await measure(page);
        snapshots.push({ step, state });
        await page.screenshot({
          path: path.join(outputDir, `${label}-${step}.png`),
        });
        await save();
        return state;
      };
      try {
        await page.route(
          (url) => url.href === metadataUrl || url.href === contentUrl,
          async (route) => {
            if (route.request().method() !== "GET") return route.fallback();
            const metadata = route.request().url() === metadataUrl;
            fixtures[metadata ? "metadata" : "markdown"]++;
            await route.fulfill({
              status: 200,
              headers: {
                "access-control-allow-origin": appOrigin,
                "content-type": metadata
                  ? "application/json"
                  : "text/markdown; charset=utf-8",
              },
              body: metadata
                ? JSON.stringify({
                    url: contentUrl,
                    preview: {
                      filename: "layer-audit.md",
                      contentType: "text/markdown",
                    },
                  })
                : markdown,
            });
          },
        );
        await page.goto(artifactUrl);
        const trigger = button(page, "Expand diagram");
        const dialog = page.locator(lightbox);
        const enter = button(page.locator("header"), "Enter fullscreen");
        const exit = button(page.locator("main"), "Exit fullscreen");
        await expect(trigger).toBeEnabled();
        report.buildSha =
          (await page
            .locator('meta[name="okou-app-git-commit-sha"]')
            .getAttribute("content")) ?? "";
        assert.match(
          report.buildSha,
          /^[a-f0-9]{40}$/u,
          "Preview must expose its actual build identity",
        );
        if (expectedBuildSha)
          assert.equal(
            report.buildSha,
            expectedBuildSha,
            "Unexpected deployed build",
          );
        report.userAgent = await page.evaluate(() => navigator.userAgent);
        assert(
          await page.evaluate(() => document.fullscreenEnabled),
          "Browser must support real native fullscreen",
        );
        assert(
          fixtures.metadata > 0 && fixtures.markdown > 0,
          "Both data fixtures must have been consumed",
        );
        const open = async () => {
          await trigger.click();
          await expect(dialog).toBeVisible();
          await expect
            .poll(() =>
              dialog
                .locator("img")
                .evaluate(
                  (image: HTMLImageElement) =>
                    image.complete && image.naturalWidth > 0,
                ),
            )
            .toBe(true);
        };
        const close = async () => {
          await button(dialog, "Close").click();
          await expect(dialog).toBeHidden();
          await expect(trigger).toBeFocused();
        };
        const enterNative = async () => {
          await enter.click();
          await expect.poll(() => isNative(page)).toBe(true);
          await expect(page.locator("header")).toBeHidden();
          await expect(exit).toBeVisible();
        };
        const exited = async () => {
          await expect.poll(() => isNative(page)).toBe(false);
          await expect(page.locator("header")).toBeVisible();
          await expect(exit).toBeHidden();
        };

        await open();
        assertDialogHit(await capture("normal-dialog"), false);
        await close();
        await capture("normal-close-focus");
        await enterNative();
        await trigger.hover();
        await page.mouse.wheel(0, 80);
        await expect
          .poll(async () => (await measure(page)).scrollTop)
          .toBeGreaterThan(0);
        const reading = await capture("native-reading");
        await open();
        assertDialogHit(await capture("native-dialog-windowed"), true);
        const zoom = dialog.getByTestId("artifact-dialog-image-zoom-level");
        await expect(zoom).toHaveText("100%");
        await button(dialog, "Zoom in").click();
        await expect(zoom).not.toHaveText("100%");
        assertDialogHit(await capture("native-dialog-zoom"), true);
        await button(dialog, "Zoom out").click();
        await button(dialog, "Reset zoom").click();
        await expect(zoom).toHaveText("100%");
        await button(dialog, "Enter fullscreen").hover();
        await expect(
          page.getByRole("tooltip", { name: "Enter fullscreen", exact: true }),
        ).toBeVisible();
        const tooltip = await capture("native-dialog-tooltip");
        assert(
          tooltip.tooltips.some(
            (item) => item.text === "Enter fullscreen" && item.nativeContains,
          ),
        );
        await button(dialog, "Enter fullscreen").click();
        await expect(dialog).toHaveAttribute("data-mode", "fullscreen");
        assertDialogHit(await capture("native-dialog-own-fullscreen"), true);
        await button(dialog, "Exit fullscreen").click();
        await expect(dialog).toHaveAttribute("data-mode", "windowed");
        await close();
        const afterClose = await capture("native-close-reading");
        assert(afterClose.nativeTarget, "Close must retain native fullscreen");
        assert.equal(
          afterClose.scrollTop,
          reading.scrollTop,
          "Dialog must preserve the reading position",
        );
        assert.equal(
          afterClose.triggerTop,
          reading.triggerTop,
          "Visible reading anchor must not move",
        );
        await exit.click();
        await exited();
        await expect(enter).toBeFocused();
        await capture("ui-exit");

        await enterNative();
        await page.evaluate(() => document.exitFullscreen());
        await exited();
        await expect(enter).toBeFocused();
        await capture("browser-exit-closed");
        await enterNative();
        await open();
        await page.evaluate(() => document.exitFullscreen());
        await exited();
        const browserExit = await capture("browser-exit-open");
        assertDialogHit(browserExit, false);
        assert(browserExit.dialogContainsFocus, "Retain modal focus");
        await close();

        await enterNative();
        await open();
        await page.keyboard.press("Escape");
        const escape = await capture("escape-observed");
        assert.equal(
          escape.headerVisible,
          escape.nativeTarget === null,
          "Escape must leave UI and native state synchronized",
        );
        if (await dialog.isVisible()) {
          assertDialogHit(escape, escape.nativeTarget !== null);
          await close();
        }
        if (await exit.isVisible()) await exit.click();
        await exited();
        for (let attempt = 0; attempt < 2; attempt++) {
          await enterNative();
          await exit.click();
          await exited();
        }
        await capture("repeated-quick-exit");

        await enterNative();
        await open();
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        await page.evaluate(() => {
          history.pushState({}, "", "/artifacts/leaveaudit.md");
          window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
        });
        await expect.poll(() => isNative(page)).toBe(false);
        await expect(dialog).toBeHidden();
        assert.equal(
          await page.evaluate(() => performance.timeOrigin),
          timeOrigin,
          "Cleanup must occur without a document reload",
        );
        await capture("route-cleanup");
        report.status = "passed";
      } catch (error) {
        report.status = "failed";
        const message = error instanceof Error ? error.message : String(error);
        report.failure = bypass
          ? message.replaceAll(bypass, "[redacted]")
          : message;
        await capture("failure").catch(() => undefined);
        throw error;
      } finally {
        await save();
        await context.close();
      }
      console.log(`${label}: passed; deployed build ${report.buildSha}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  console.error(bypass ? message.replaceAll(bypass, "[redacted]") : message);
  process.exitCode = 1;
});
