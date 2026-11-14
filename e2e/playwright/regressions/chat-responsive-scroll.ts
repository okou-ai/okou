import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Locator } from "@playwright/test";

// From e2e/: pnpm exec tsx playwright/regressions/chat-responsive-scroll.ts \
//   <app-origin> <thread-id> <private-storage-state.json> <output-dir>
// Optional: E2E_CHROMIUM_EXECUTABLE_PATH for an already installed Chromium.
// Prepare authentication/bypass beforehand and an idle thread with a long final
// assistant reply (at least three prose paragraphs, 40+ characters each). No setup writes,
// message submission, action-card interaction, traces, or storage-state export.
// Screenshots contain only the transcript; paragraph text is hashed in JSON.

const assistantSelector =
  "[data-chat-selection-source][data-chat-scroll-anchor-event-id]:not([data-chat-run-work-history] *)";
const readingTolerance = 4;
const bottomTolerance = 2;
const desktop = { width: 1440, height: 1000 };

type Viewport = typeof desktop;
type Position = "reading" | "bottom";
interface Checkpoint {
  eventId: string;
  paragraphIndex: number;
  paragraphCount: number;
  text: string;
}

async function chooseCheckpoint(scroll: Locator): Promise<Checkpoint> {
  return scroll.evaluate((element, selector) => {
    const candidates = Array.from(element.querySelectorAll(selector))
      .map((body) => {
        const paragraphs = Array.from(body.querySelectorAll("p"));
        const prose = paragraphs.filter(
          (paragraph) =>
            !paragraph.closest("[data-markdown-ui], li, blockquote, table") &&
            (paragraph.textContent?.trim().length ?? 0) >= 40,
        );
        const paragraph = prose[Math.floor(prose.length / 2)];
        return {
          eventId: body.getAttribute("data-chat-scroll-anchor-event-id") ?? "",
          paragraphIndex: paragraph ? paragraphs.indexOf(paragraph) : -1,
          paragraphCount: prose.length,
          text: paragraph?.textContent?.replace(/\s+/gu, " ").trim() ?? "",
          length: body.textContent?.length ?? 0,
        };
      })
      .filter((candidate) => candidate.paragraphCount >= 3 && candidate.eventId)
      .sort((left, right) => right.length - left.length);
    const candidate = candidates[0];
    if (!candidate) {
      throw new Error(
        "Prepare a long assistant reply with three prose paragraphs",
      );
    }
    return candidate;
  }, assistantSelector);
}

// This observer only reads geometry. Eight unchanged painted frames establish
// settling; 120 frames bound the observation. It never restores scrollTop.
async function observe(scroll: Locator, checkpoint: Checkpoint) {
  return scroll.evaluate(
    async (element, { checkpoint, assistantSelector }) => {
      const read = {
        read() {
          const bounds = element.getBoundingClientRect();
          const viewportTop = bounds.top + element.clientTop;
          const body = Array.from(
            element.querySelectorAll(assistantSelector),
          ).find(
            (candidate) =>
              candidate.getAttribute("data-chat-scroll-anchor-event-id") ===
              checkpoint.eventId,
          );
          const paragraph =
            body?.querySelectorAll("p")[checkpoint.paragraphIndex];
          const range = document.createRange();
          if (paragraph) {
            const walker = document.createTreeWalker(
              paragraph,
              NodeFilter.SHOW_TEXT,
            );
            let node: Node | null;
            while ((node = walker.nextNode())) {
              const index = node.textContent?.search(/\S/u) ?? -1;
              if (index >= 0) {
                range.setStart(node, index);
                range.setEnd(node, index + 1);
                break;
              }
            }
          }
          const glyph = range.getBoundingClientRect();
          const paragraphBounds = paragraph?.getBoundingClientRect();
          const hit = document.elementFromPoint(
            glyph.left + glyph.width / 2,
            glyph.top + glyph.height / 2,
          );
          // @[900px] queries the nearest size container's content box, not the
          // browser viewport (nor the capped message-list width).
          let container =
            paragraph?.parentElement ?? element.querySelector("main");
          while (
            container &&
            getComputedStyle(container).containerType === "normal"
          ) {
            container = container.parentElement;
          }
          const style = container ? getComputedStyle(container) : null;
          return {
            viewport: { width: innerWidth, height: innerHeight },
            scrollBox: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            },
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            bottomGap:
              element.scrollHeight - element.clientHeight - element.scrollTop,
            queryContainerWidth:
              container && style
                ? container.clientWidth -
                  parseFloat(style.paddingLeft) -
                  parseFloat(style.paddingRight)
                : null,
            checkpoint:
              paragraph && paragraphBounds
                ? {
                    sameText:
                      paragraph.textContent?.replace(/\s+/gu, " ").trim() ===
                      checkpoint.text,
                    paragraphTop: paragraphBounds.top - viewportTop,
                    paragraphHeight: paragraphBounds.height,
                    firstTextOffset: glyph.top - viewportTop,
                    firstTextHeight: glyph.height,
                    visible:
                      glyph.width > 0 &&
                      glyph.height > 0 &&
                      glyph.top >= Math.max(0, viewportTop) - 1 &&
                      glyph.bottom <=
                        Math.min(
                          innerHeight,
                          viewportTop + element.clientHeight,
                        ) +
                          1 &&
                      glyph.left >= Math.max(0, bounds.left) &&
                      glyph.right <= Math.min(innerWidth, bounds.right) &&
                      hit !== null &&
                      paragraph.contains(hit),
                  }
                : null,
          };
        },
      }.read;
      let sample = read();
      let previous = "";
      let unchanged = 0;
      for (let frames = 1; frames <= 120; frames += 1) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        sample = read();
        const current = JSON.stringify(sample);
        const ready =
          document.fonts.status === "loaded" &&
          !element.querySelector('[data-testid="rich-content-loading"]') &&
          Array.from(element.querySelectorAll("img")).every(
            (image) => image.complete,
          );
        unchanged = ready && current === previous ? unchanged + 1 : 0;
        previous = current;
        if (unchanged >= 8) {
          return { settled: true, frames, sample };
        }
      }
      return { settled: false, frames: 120, sample };
    },
    { checkpoint, assistantSelector },
  );
}

async function main() {
  const [appOrigin, threadId, storageState, outputDir, ...extra] =
    process.argv.slice(2);
  assert(
    appOrigin && threadId && storageState && outputDir && extra.length === 0,
    "Usage: chat-responsive-scroll.ts <app-origin> <thread-id> <private-storage-state.json> <output-dir>",
  );
  const origin = new URL(appOrigin);
  assert(
    ["https:", "http:"].includes(origin.protocol) &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === "/",
    "App origin must be a bare HTTP(S) origin; prepare preview bypass privately beforehand",
  );
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      threadId,
    ),
    "A prepared thread UUID is required",
  );
  const relativeState = path.relative(
    path.resolve(outputDir),
    path.resolve(storageState),
  );
  assert(
    relativeState.startsWith(`..${path.sep}`) || path.isAbsolute(relativeState),
    "Keep private storage state outside the output directory",
  );
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const results: {
    label: string;
    position: Position;
    observation: Awaited<ReturnType<typeof observe>>;
    offsetDelta: number | null;
    screenshot?: string;
    failures: string[];
  }[] = [];
  const report: {
    startedAt: string;
    appOrigin: string;
    threadId: string;
    metadata?: {
      deployedGitSha: string;
      userAgent: string;
      browserVersion: string;
      devicePixelRatio: number;
    };
    checkpoint?: Omit<Checkpoint, "text"> & { textSha256: string };
    matrix?: Viewport[];
    threshold?: { status: string; observedWidths: number[] };
    tolerances: { readingOffsetPx: number; bottomGapPx: number };
    results: typeof results;
    errorPhase?: string;
    errorName?: string;
    finalDeployedGitSha?: string;
    passed: boolean;
  } = {
    startedAt: new Date().toISOString(),
    appOrigin: origin.origin,
    threadId,
    tolerances: {
      readingOffsetPx: readingTolerance,
      bottomGapPx: bottomTolerance,
    },
    results,
    passed: false,
  };
  let phase = "launch Chromium with prepared private storage state";
  const browser = await chromium.launch({
    executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
  });
  try {
    const context = await browser.newContext({
      storageState,
      viewport: desktop,
      deviceScaleFactor: 1,
    });
    context.setDefaultTimeout(30_000);
    const page = await context.newPage();
    const threadPath = `/chats/${threadId}`;
    const selector = `[data-chat-thread-container-id="${threadId}"] [data-scroll-container]`;
    const scroll = page.locator(selector);
    phase = "load the prepared thread (no login or setup is performed)";
    await page.goto(new URL(threadPath, origin).href);
    await scroll.waitFor({ state: "visible" });
    await page.waitForFunction(
      ({ selector, assistantSelector }) =>
        document.fonts.status === "loaded" &&
        Array.from(
          document.querySelectorAll(`${selector} ${assistantSelector}`),
        ).some((body) => body.querySelectorAll("p").length >= 3),
      { selector, assistantSelector },
    );
    const metadata = await page.evaluate(() => ({
      deployedGitSha:
        document
          .querySelector('meta[name="okou-app-git-commit-sha"]')
          ?.getAttribute("content") ?? "",
      userAgent: navigator.userAgent,
      devicePixelRatio,
    }));
    assert(
      /^[0-9a-f]{40}$/iu.test(metadata.deployedGitSha),
      "Deployed git SHA meta must contain a full commit",
    );
    report.metadata = { ...metadata, browserVersion: browser.version() };
    const checkpoint = await chooseCheckpoint(scroll);
    report.checkpoint = {
      eventId: checkpoint.eventId,
      paragraphIndex: checkpoint.paragraphIndex,
      paragraphCount: checkpoint.paragraphCount,
      textSha256: createHash("sha256").update(checkpoint.text).digest("hex"),
    };
    phase = "wait for the prepared transcript geometry to settle";
    const initial = await observe(scroll, checkpoint);
    assert(initial.settled, "Prepared transcript geometry did not settle");
    assert(
      initial.sample.scrollHeight - initial.sample.clientHeight > 240,
      "Prepared transcript must overflow the desktop viewport by more than 240px",
    );

    // At most two calibration resizes per side. Width deltas are derived from
    // real container measurements; sidebar layout can make a side unreachable.
    phase = "calibrate the actual 900px query-container boundary";
    const nearThreshold: Viewport[] = [];
    const observedWidths: number[] = [];
    for (const target of [902, 898]) {
      let current = initial.sample;
      let viewport = desktop;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (current.queryContainerWidth === null) break;
        viewport = {
          width: Math.round(
            viewport.width + target - current.queryContainerWidth,
          ),
          height: 1000,
        };
        if (viewport.width < 960 || viewport.width > 1920) break;
        await page.setViewportSize(viewport);
        const observation = await observe(scroll, checkpoint);
        assert(
          observation.settled,
          "Threshold calibration geometry did not settle",
        );
        current = observation.sample;
        if (
          current.queryContainerWidth !== null &&
          Math.abs(current.queryContainerWidth - target) <= 1
        ) {
          nearThreshold.push(viewport);
          observedWidths.push(current.queryContainerWidth);
          break;
        }
      }
      await page.setViewportSize(desktop);
      assert(
        (await observe(scroll, checkpoint)).settled,
        "Desktop geometry did not settle after calibration",
      );
    }
    report.threshold = {
      status:
        observedWidths.length === 2
          ? "bracketed"
          : "not fully reachable within bounded calibration",
      observedWidths,
    };
    assert(
      observedWidths.length === 2,
      "The prepared layout must exercise both sides of the 900px container query",
    );
    const outward = [
      desktop,
      ...nearThreshold,
      { width: 1100, height: 1000 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ];
    const matrix = [...outward, ...outward.slice(0, -1).reverse()];
    report.matrix = matrix;

    for (const position of ["reading", "bottom"] as const) {
      await page.setViewportSize(desktop);
      assert(
        (await observe(scroll, checkpoint)).settled,
        "Case-start layout did not settle",
      );
      phase = `position ${position} once at case start`;
      // The only scroll write in a case. No corrections occur during resize,
      // observation, screenshots, or the reverse traversal of the matrix.
      await scroll.evaluate(
        (element, { position, checkpoint, assistantSelector }) => {
          const body = Array.from(
            element.querySelectorAll(assistantSelector),
          ).find(
            (candidate) =>
              candidate.getAttribute("data-chat-scroll-anchor-event-id") ===
              checkpoint.eventId,
          );
          const paragraph =
            body?.querySelectorAll("p")[checkpoint.paragraphIndex];
          if (!paragraph)
            throw new Error("Prepared checkpoint paragraph is missing");
          element.scrollTo({
            top:
              position === "bottom"
                ? element.scrollHeight
                : element.scrollTop +
                  paragraph.getBoundingClientRect().top -
                  element.getBoundingClientRect().top -
                  element.clientTop -
                  32,
            behavior: "instant",
          });
        },
        { position, checkpoint, assistantSelector },
      );
      let baselineOffset: number | undefined;
      for (const [index, viewport] of matrix.entries()) {
        const label = `${position}-${String(index).padStart(2, "0")}-${viewport.width}x${viewport.height}`;
        phase = label;
        if (index > 0) await page.setViewportSize(viewport);
        const observation = await observe(scroll, checkpoint);
        const { sample } = observation;
        const point = sample.checkpoint;
        if (position === "reading" && index === 0) {
          assert(
            point?.sameText && point.visible && sample.bottomGap > 240,
            "Fixture must allow the midpoint paragraph to be visible well above the bottom",
          );
          baselineOffset = point.firstTextOffset;
        }
        const offsetDelta =
          point && baselineOffset !== undefined
            ? point.firstTextOffset - baselineOffset
            : null;
        const failures: string[] = [];
        if (!observation.settled)
          failures.push("layout did not settle within 120 observed frames");
        if (
          sample.viewport.width !== viewport.width ||
          sample.viewport.height !== viewport.height
        ) {
          failures.push("unexpected viewport");
        }
        if (position === "reading") {
          if (!point?.sameText || !point.visible)
            failures.push("checkpoint paragraph's first text is not visible");
          if (offsetDelta === null || Math.abs(offsetDelta) > readingTolerance)
            failures.push("checkpoint reading offset moved");
          if (sample.bottomGap <= 10)
            failures.push("history snapped to the bottom");
        } else if (Math.abs(sample.bottomGap) > bottomTolerance) {
          failures.push("bottom following was lost");
        }
        const result: (typeof results)[number] = {
          label,
          position,
          observation,
          offsetDelta,
          failures,
        };
        results.push(result);
        // Never photograph an auth page/modal or browser chrome/account sidebar.
        const currentUrl = new URL(page.url());
        assert(
          currentUrl.origin === origin.origin &&
            currentUrl.pathname === threadPath,
          "Prepared thread navigation changed; no screenshot captured",
        );
        assert(
          (await page
            .locator(
              '[role="dialog"]:visible, input[type="password"]:visible, input[autocomplete="one-time-code"]:visible',
            )
            .count()) === 0,
          "Unexpected dialog/auth control; no screenshot captured",
        );
        const box = sample.scrollBox;
        const x = Math.max(0, box.x);
        const y = Math.max(0, box.y);
        const width = Math.min(viewport.width, box.x + box.width) - x;
        const height = Math.min(viewport.height, box.y + box.height) - y;
        assert(
          width > 0 && height > 0,
          "Transcript screenshot bounds are empty",
        );
        const screenshot = `${label}.png`;
        await page.screenshot({
          path: path.join(outputDir, screenshot),
          clip: { x, y, width, height },
          caret: "initial",
        });
        result.screenshot = screenshot;
      }
    }
    report.finalDeployedGitSha =
      (await page
        .locator('meta[name="okou-app-git-commit-sha"]')
        .getAttribute("content")) ?? "";
    assert(
      report.finalDeployedGitSha === report.metadata.deployedGitSha,
      "The deployed application changed during observation",
    );
    report.passed = results.every((result) => result.failures.length === 0);
    await context.close();
  } catch (error) {
    // Browser errors can contain credential paths/redirect URLs. Persist only a
    // safe phase/name and the whitelisted geometry already collected.
    report.passed = false;
    report.errorPhase = phase;
    report.errorName = error instanceof Error ? error.name : "UnknownError";
  } finally {
    try {
      await browser.close();
    } finally {
      await writeFile(
        path.join(outputDir, "chat-responsive-scroll.json"),
        JSON.stringify(report, null, 2),
      );
    }
  }
  console.log(
    `Responsive scroll: ${report.passed ? "passed" : "failed"}; ${results.length} viewport observations`,
  );
  if (!report.passed) process.exitCode = 1;
}

main().catch(() => {
  console.error(
    "Responsive scroll setup failed. Check the four arguments, private prepared auth state, and installed Chromium; no auth details were logged.",
  );
  process.exitCode = 1;
});
