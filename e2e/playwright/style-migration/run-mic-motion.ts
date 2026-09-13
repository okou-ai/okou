import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  chromium,
  expect as playwrightExpect,
  type Locator,
  type Page,
} from "@playwright/test";

import { seedPreviewBypassCookie } from "../lib/preview-bypass";
import { browserArgs, stableScreenshot } from "./capture";
import { compareImages, roundingTolerance, sha256 } from "./images";
import {
  installMicBrowserFixture,
  installMicMotionFixture,
  micBrowserFixtureState,
  micMotionThreadId,
  releaseMicrophone,
  setMicrophoneRms,
} from "./mic-motion-fixture";

const expect = playwrightExpect.configure({ timeout: 30_000 });
const phases = [0, 175, 350, 525] as const;
const levels = [
  { label: "000", rms: 0, fill: "0%" },
  { label: "033", rms: 0.03, fill: "33%" },
  { label: "067", rms: 0.07, fill: "67%" },
  { label: "100", rms: 0.12, fill: "100%" },
] as const;

interface VisualCase {
  id: string;
  path: string;
  theme: "light" | "dark";
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

interface Capture {
  id: string;
  image: string;
  sha256: string;
  observation: unknown;
  status: "BASELINE" | "PASS" | "FAIL";
  changedPixels?: number;
  contentChangedPixels?: number;
  roundingPixels?: number;
  rawObservationsEqual?: boolean;
  semanticObservationsEqual?: boolean;
}

function semanticObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticObservation);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === "border-radius" && typeof entry === "string") {
        const pixels = /^([0-9.e+]+)px$/.exec(entry)?.[1];
        if (pixels && Number(pixels) > 1_000) return [key, "full"];
      }
      return [key, semanticObservation(entry)];
    }),
  );
}

interface MotionObservation {
  state: "starting" | "transcribing";
  animationName: string;
  duration: number | null;
  iterations: number | "Infinity" | null;
  progressed: boolean;
}

interface Manifest {
  version: 1;
  protocol: "mic-motion-v1";
  pixelProtocol: "channel-rounding-v1";
  sourceSha: string;
  appBuildSha: string;
  appArtifactOrigin: string;
  apiBuildSha: string;
  apiArtifactOrigin: string;
  appOrigin: string;
  apiOrigin: string;
  browser: string;
  userAgent: string;
  runnerSha256: string;
  caseSha256: string;
  fixtureSha256: string;
  roundingTolerance: typeof roundingTolerance;
  cases: VisualCase[];
  captures: Capture[];
  normalMotion: Record<string, MotionObservation[]>;
  workerRequests: Record<string, string[]>;
  featureSwitches: { voiceInputV2: false; _realAgentInPreview: false };
  prerequisites: string;
  failures: string[];
}

const { values } = parseArgs({
  options: {
    "app-url": { type: "string" },
    "app-artifact-url": { type: "string" },
    "api-url": { type: "string" },
    "api-artifact-url": { type: "string" },
    "expected-build": { type: "string" },
    "api-build": { type: "string" },
    "source-sha": { type: "string" },
    "storage-state": { type: "string" },
    "executable-path": { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
  },
});

function required(key: keyof typeof values): string {
  const value = values[key];
  assert(value, `--${key} is required`);
  return value;
}

function origin(value: string): string {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "Use a deployed HTTPS origin");
  assert(!url.username && !url.password && !url.search && !url.hash);
  assert.equal(url.pathname, "/", "Pass an origin, not a route");
  return url.origin;
}

async function paintedFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function phaseScreenshot(
  page: Page,
  spinner: Locator,
  phase: number,
): Promise<Buffer> {
  await spinner.evaluate(async (element, currentTime) => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images)
        .filter((image) => image.currentSrc)
        .map((image) => image.decode()),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().iterations === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
    const [animation] = element.getAnimations();
    if (!animation) throw new Error("Mic spinner animation is missing");
    animation.pause();
    animation.currentTime = currentTime;
  }, phase);

  let previous: Buffer | undefined;
  let consecutive = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await paintedFrames(page);
    const image = await page.screenshot({ fullPage: true, caret: "initial" });
    consecutive = previous?.equals(image) ? consecutive + 1 : 1;
    if (consecutive === 3) return image;
    previous = image;
  }
  throw new Error(
    `Three identical spinner frames were not observed at ${phase}ms`,
  );
}

async function observeNormalMotion(
  spinner: Locator,
  state: MotionObservation["state"],
): Promise<MotionObservation> {
  const observation = await spinner.evaluate(async (element) => {
    const [animation] = element.getAnimations();
    if (!animation) throw new Error("Mic spinner animation is missing");
    const before = getComputedStyle(element).transform;
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    const after = getComputedStyle(element).transform;
    const timing = animation.effect?.getComputedTiming();
    return {
      animationName: getComputedStyle(element).animationName,
      duration: typeof timing?.duration === "number" ? timing.duration : null,
      iterations:
        timing?.iterations === Infinity
          ? ("Infinity" as const)
          : typeof timing?.iterations === "number"
            ? timing.iterations
            : null,
      progressed: before !== after,
    };
  });
  assert.equal(observation.animationName, "mic-starting-spin");
  assert.equal(observation.duration, 700);
  assert.equal(observation.iterations, "Infinity");
  assert(observation.progressed, `${state} spinner did not progress`);
  return { state, ...observation };
}

async function observeSpinner(spinner: Locator) {
  return spinner.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      hidden: element.getAttribute("aria-hidden"),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      styles: Object.fromEntries(
        [
          "display",
          "width",
          "height",
          "border-top-width",
          "border-right-width",
          "border-bottom-width",
          "border-left-width",
          "border-top-color",
          "border-right-color",
          "border-radius",
          "pointer-events",
          "transform",
          "transform-origin",
          "animation-name",
          "animation-duration",
          "animation-timing-function",
          "animation-iteration-count",
          "backface-visibility",
          "will-change",
        ].map((property) => [property, style.getPropertyValue(property)]),
      ),
    };
  });
}

async function observeMeter(meter: Locator) {
  return meter.evaluate((element) => {
    const style = getComputedStyle(element);
    const after = getComputedStyle(element, "::after");
    const box = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      hidden: element.getAttribute("aria-hidden"),
      fill: (element as HTMLElement).style.getPropertyValue(
        "--mic-volume-fill",
      ),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      styles: Object.fromEntries(
        [
          "position",
          "bottom",
          "left",
          "width",
          "height",
          "border-radius",
          "background-color",
          "overflow",
          "pointer-events",
          "transform",
        ].map((property) => [property, style.getPropertyValue(property)]),
      ),
      after: Object.fromEntries(
        [
          "position",
          "right",
          "bottom",
          "left",
          "height",
          "border-radius",
          "background-color",
          "background-image",
          "content",
          "transition-property",
          "transition-duration",
          "transition-timing-function",
        ].map((property) => [property, after.getPropertyValue(property)]),
      ),
    };
  });
}

async function run(): Promise<void> {
  const appOrigin = origin(required("app-url"));
  const appArtifactOrigin = values["app-artifact-url"]
    ? origin(values["app-artifact-url"])
    : appOrigin;
  const apiOrigin = origin(required("api-url"));
  const apiArtifactOrigin = values["api-artifact-url"]
    ? origin(values["api-artifact-url"])
    : apiOrigin;
  assert.notEqual(appOrigin, apiOrigin);
  const appBuildSha = required("expected-build");
  const apiBuildSha = required("api-build");
  const sourceSha = required("source-sha");
  for (const sha of [appBuildSha, apiBuildSha, sourceSha]) {
    assert(/^[a-f0-9]{40}$/.test(sha), `Expected a full SHA: ${sha}`);
  }
  const out = path.resolve(required("out"));
  const caseBytes = await readFile(
    path.join(__dirname, "mic-motion-cases.json"),
  );
  const fixtureBytes = await readFile(
    path.join(__dirname, "mic-motion-fixture.ts"),
  );
  const runnerSha256 = sha256(
    Buffer.concat(
      await Promise.all([
        readFile(__filename),
        readFile(path.join(__dirname, "mic-motion-fixture.ts")),
        readFile(path.join(__dirname, "chat-emoji-worker.ts")),
        readFile(path.join(__dirname, "images.ts")),
        readFile(path.join(__dirname, "capture.ts")),
        readFile(path.join(__dirname, "bootstrap.ts")),
        readFile(path.join(__dirname, "../lib/preview-bypass.ts")),
        readFile(path.join(__dirname, "../../pnpm-lock.yaml")),
      ]),
    ),
  );
  const caseFile: { version: number; cases: VisualCase[] } = JSON.parse(
    caseBytes.toString(),
  );
  assert.equal(caseFile.version, 1);
  if (values.case) {
    caseFile.cases = caseFile.cases.filter((item) => item.id === values.case);
  }
  assert(caseFile.cases.length > 0, "No mic-motion cases selected");
  const baseline: Manifest | undefined = values.baseline
    ? JSON.parse(
        await readFile(path.join(values.baseline, "manifest.json"), "utf8"),
      )
    : undefined;
  if (baseline) {
    assert.equal(baseline.protocol, "mic-motion-v1");
    assert.equal(baseline.pixelProtocol, "channel-rounding-v1");
    assert.deepEqual(baseline.cases, caseFile.cases);
    assert.equal(baseline.runnerSha256, runnerSha256, "Frozen runner changed");
    assert.equal(
      baseline.caseSha256,
      sha256(caseBytes),
      "Frozen cases changed",
    );
    assert.equal(
      baseline.fixtureSha256,
      sha256(fixtureBytes),
      "Frozen fixture changed",
    );
    assert.deepEqual(baseline.failures, [], "Cannot replay a failed baseline");
  }

  await mkdir(out);
  const server = await chromium.launchServer({
    executablePath: values["executable-path"],
    args: [
      ...browserArgs,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
    ],
  });
  const browser = await chromium.connect(server.wsEndpoint());
  const chromiumProfile = server
    .process()
    .spawnargs.find((argument) => argument.startsWith("--user-data-dir="))
    ?.slice("--user-data-dir=".length);
  assert(chromiumProfile, "Use the launched browser's own profile");
  const manifest: Manifest = {
    version: 1,
    protocol: "mic-motion-v1",
    pixelProtocol: "channel-rounding-v1",
    sourceSha,
    appBuildSha,
    appArtifactOrigin,
    apiBuildSha,
    apiArtifactOrigin,
    appOrigin,
    apiOrigin,
    browser: browser.version(),
    userAgent: "",
    runnerSha256,
    caseSha256: sha256(caseBytes),
    fixtureSha256: sha256(fixtureBytes),
    roundingTolerance,
    cases: caseFile.cases,
    captures: [],
    normalMotion: {},
    workerRequests: {},
    featureSwitches: { voiceInputV2: false, _realAgentInPreview: false },
    prerequisites:
      "Isolated Clerk TEST session; onboarding, agent, thread, quota, feature switches and metadata are controlled at API/bootstrap boundaries. Browser media is deterministic. No Agent run, connector, purchase or real transcription.",
    failures: [],
  };

  try {
    if (baseline) assert.equal(baseline.browser, manifest.browser);
    for (const item of caseFile.cases) {
      assert(/^[a-z0-9-]+$/.test(item.id));
      const context = await browser.newContext({
        storageState: required("storage-state"),
        viewport: item.viewport,
        deviceScaleFactor: item.deviceScaleFactor,
        colorScheme: item.theme,
        locale: "en-US",
        timezoneId: "UTC",
        reducedMotion: "no-preference",
      });
      let fixture:
        | Awaited<ReturnType<typeof installMicMotionFixture>>
        | undefined;
      try {
        await installMicBrowserFixture(context);
        await context.clearCookies({ name: "__Secure-okou-theme" });
        await context.addCookies([
          {
            name: "__Secure-okou-theme",
            value: `v1.${item.theme}`,
            url: appOrigin,
            secure: true,
            sameSite: "Lax",
          },
        ]);
        await seedPreviewBypassCookie(context, appOrigin);
        await seedPreviewBypassCookie(context, apiOrigin);
        if (appArtifactOrigin !== appOrigin) {
          await context.route(
            (url) => url.origin === appOrigin,
            async (route) => {
              const requested = new URL(route.request().url());
              const artifactUrl = new URL(
                `${requested.pathname}${requested.search}`,
                appArtifactOrigin,
              );
              const response = await route.fetch({ url: artifactUrl.href });
              await route.fulfill({ response });
            },
          );
        }
        const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
        if (bypassSecret || apiArtifactOrigin !== apiOrigin) {
          await context.route(
            (url) => url.origin === apiOrigin,
            async (route) => {
              const requested = new URL(route.request().url());
              const artifactUrl = new URL(
                `${requested.pathname}${requested.search}`,
                apiArtifactOrigin,
              );
              await route.continue({
                url: artifactUrl.href,
                headers: {
                  ...route.request().headers(),
                  ...(bypassSecret
                    ? { "x-vercel-protection-bypass": bypassSecret }
                    : {}),
                },
              });
            },
          );
        }
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        manifest.userAgent = await page.evaluate(() => navigator.userAgent);
        if (baseline) assert.equal(manifest.userAgent, baseline.userAgent);
        fixture = await installMicMotionFixture(
          page,
          appOrigin,
          apiOrigin,
          item.theme,
          manifest.failures,
          chromiumProfile,
          appArtifactOrigin,
        );
        await page.goto(
          new URL(item.path.replace(":threadId", micMotionThreadId), appOrigin)
            .href,
          {
            waitUntil: "domcontentloaded",
          },
        );
        await expect(
          page.locator('meta[name="okou-app-git-commit-sha"]'),
        ).toHaveAttribute("content", appBuildSha);
        await expect(page.locator("#app-bootstrap-skeleton")).toBeHidden();
        await expect(page.locator("html")).toHaveClass(
          item.theme === "dark"
            ? /(?:^| )dark(?: |$)/
            : /^(?!.*(?:^| )dark(?: |$)).*$/,
        );
        const voice = page.getByRole("button", {
          name: "Voice input",
          exact: true,
        });
        await expect(voice).toBeEnabled();
        await expect(voice).not.toHaveAttribute("aria-keyshortcuts", /./);
        await expect(
          page
            .getByRole("button", { name: "Connectors", exact: true })
            .locator("svg"),
        ).toBeVisible();
        const chatRegion = page.getByRole("region", {
          name: "Chat thread",
          exact: true,
        });
        await chatRegion.focus();
        await expect(chatRegion).toBeFocused();

        async function capture(
          state: string,
          surface: Locator,
          phase?: number,
        ): Promise<void> {
          await expect(
            page.locator('meta[name="okou-app-git-commit-sha"]'),
          ).toHaveAttribute("content", appBuildSha);
          const id = `${item.id}-${state}`;
          const image = `${id}.png`;
          const bytes =
            phase === undefined
              ? await stableScreenshot(page)
              : await phaseScreenshot(page, surface, phase);
          const observation = state.includes("fill")
            ? await observeMeter(surface)
            : await observeSpinner(surface);
          await writeFile(path.join(out, image), bytes, { flag: "wx" });
          const record: Capture = {
            id,
            image,
            sha256: sha256(bytes),
            observation,
            status: "BASELINE",
          };
          if (baseline && values.baseline) {
            const reference = baseline.captures.find(
              (entry) => entry.id === id,
            );
            assert(reference, `Missing baseline capture ${id}`);
            assert.equal(reference.image, image);
            const before = await readFile(
              path.join(values.baseline, reference.image),
            );
            assert.equal(sha256(before), reference.sha256);
            const result = compareImages(before, bytes);
            record.changedPixels = result.changedPixels;
            record.contentChangedPixels = result.contentChangedPixels;
            record.roundingPixels = result.roundingPixels;
            record.rawObservationsEqual =
              JSON.stringify(reference.observation) ===
              JSON.stringify(observation);
            record.semanticObservationsEqual =
              JSON.stringify(semanticObservation(reference.observation)) ===
              JSON.stringify(semanticObservation(observation));
            record.status =
              result.contentChangedPixels === 0 &&
              record.semanticObservationsEqual
                ? "PASS"
                : "FAIL";
            await writeFile(path.join(out, `${id}-before.png`), before, {
              flag: "wx",
            });
            await writeFile(path.join(out, `${id}-diff.png`), result.diff, {
              flag: "wx",
            });
            if (record.status === "FAIL") {
              manifest.failures.push(
                `${id}: ${result.contentChangedPixels} content pixels, ${result.roundingPixels} rounding pixels; semanticObservationsEqual=${record.semanticObservationsEqual}`,
              );
            }
          }
          manifest.captures.push(record);
          console.log(
            `${id}: ${record.status}${record.changedPixels === undefined ? "" : ` (${record.contentChangedPixels} content pixels, ${record.roundingPixels} rounding pixels)`}`,
          );
        }

        await voice.click();
        const startingButton = page.getByRole("button", {
          name: "Starting voice input",
          exact: true,
        });
        await expect(startingButton).toBeDisabled();
        const startingSpinner = startingButton
          .locator('span[aria-hidden="true"]')
          .first();
        await expect(startingSpinner).toBeVisible();
        await expect
          .poll(() => micBrowserFixtureState(page))
          .toEqual({ getUserMediaCalls: 1, released: false });
        const motion: MotionObservation[] = [
          await observeNormalMotion(startingSpinner, "starting"),
        ];
        for (const phase of phases) {
          await capture(
            `starting-phase-${String(phase).padStart(3, "0")}`,
            startingSpinner,
            phase,
          );
        }

        await releaseMicrophone(page);
        const stop = page.getByRole("button", {
          name: "Stop recording",
          exact: true,
        });
        await expect(stop).toBeEnabled();
        const meter = stop.locator('span[style*="--mic-volume-fill"]');
        await expect(meter).toBeVisible();
        for (const level of levels) {
          await setMicrophoneRms(page, level.rms);
          await expect
            .poll(() =>
              meter.evaluate((element) =>
                (element as HTMLElement).style.getPropertyValue(
                  "--mic-volume-fill",
                ),
              ),
            )
            .toBe(level.fill);
          await capture(`recording-fill-${level.label}`, meter);
        }

        await stop.click();
        const transcribingButton = page.getByRole("button", {
          name: "Transcribing",
          exact: true,
        });
        await expect(transcribingButton).toBeDisabled();
        const transcribingSpinner = transcribingButton
          .locator('span[aria-hidden="true"]')
          .first();
        await expect(transcribingSpinner).toBeVisible();
        motion.push(
          await observeNormalMotion(transcribingSpinner, "transcribing"),
        );
        for (const phase of phases) {
          await capture(
            `transcribing-phase-${String(phase).padStart(3, "0")}`,
            transcribingSpinner,
            phase,
          );
        }
        manifest.normalMotion[item.id] = motion;
        if (baseline) {
          assert.deepEqual(
            motion,
            baseline.normalMotion[item.id],
            `${item.id}: normal-motion contract changed`,
          );
        }
        fixture.releaseTranscription();
        await expect(voice).toBeEnabled();
      } catch (error) {
        const failure = `${item.id}: ${error instanceof Error ? error.message : String(error)}`;
        manifest.failures.push(failure);
        console.error(failure);
        const failedPage = context.pages()[0];
        if (failedPage) {
          await failedPage.screenshot({
            path: path.join(out, `${item.id}-failure.png`),
            fullPage: true,
          });
          await writeFile(
            path.join(out, `${item.id}-failure.txt`),
            await failedPage.locator("body").innerText(),
            { flag: "wx" },
          );
        }
      } finally {
        fixture?.releaseTranscription();
        manifest.workerRequests[item.id] = [...(fixture?.paths ?? [])].sort();
        if (!fixture?.paths.has("GET /api/chat-threads/snapshot")) {
          manifest.failures.push(
            `${item.id}: SharedWorker snapshot fixture was not exercised`,
          );
        }
        await fixture?.close();
        await context.close();
      }
    }
    assert.equal(
      manifest.captures.length,
      caseFile.cases.length * 12,
      "Every mic state must be captured",
    );
    assert.equal(
      Object.keys(manifest.normalMotion).length,
      caseFile.cases.length,
      "Normal motion must be verified for every case",
    );
    if (baseline) {
      assert.equal(manifest.captures.length, baseline.captures.length);
    }
  } finally {
    await writeFile(
      path.join(out, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await browser.close();
    await server.close();
  }
  assert.equal(manifest.failures.length, 0, manifest.failures.join("\n"));
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
