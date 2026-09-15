import { expect, test, vi, type Mock } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../signals/utils.ts";
import { setupVisualViewportKeyboardState } from "../visual-viewport-keyboard.ts";

const context = testContext();

class ControlledViewportClock {
  private readonly animationFrames = new Map<number, FrameRequestCallback>();
  private nextFrameId = 1;

  constructor(signal: AbortSignal) {
    vi.useFakeTimers();
    vi.stubGlobal("cancelAnimationFrame", (frameId: number): void => {
      this.animationFrames.delete(frameId);
    });
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback): number => {
        const frameId = this.nextFrameId;
        this.nextFrameId += 1;
        this.animationFrames.set(frameId, callback);
        return frameId;
      },
    );
    signal.addEventListener(
      "abort",
      () => {
        vi.useRealTimers();
      },
      { once: true },
    );
  }

  async flushUpdate(): Promise<void> {
    this.flushAnimationFrames();
    await vi.runOnlyPendingTimersAsync();
    this.flushAnimationFrames();
  }

  private flushAnimationFrames(): void {
    const frames = Array.from(this.animationFrames.entries());
    for (const [frameId, callback] of frames) {
      this.animationFrames.delete(frameId);
      callback(0);
    }
  }
}

class MockVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  scale = 1;

  constructor(height: number) {
    super();
    this.height = height;
  }

  resizeTo(height: number, offsetTop = this.offsetTop): void {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event("resize"));
  }
}

function installVisualViewport(viewport: MockVisualViewport): void {
  vi.stubGlobal("visualViewport", viewport);
}

function setInnerHeight(height: number): void {
  vi.stubGlobal("innerHeight", height);
}

function setStandalone(matches: boolean): void {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches }));
}

function appendTextEntry(): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  context.signal.addEventListener(
    "abort",
    () => {
      textarea.remove();
    },
    { once: true },
  );
  return textarea;
}

function focusTextEntry(): HTMLTextAreaElement {
  const textarea = appendTextEntry();
  textarea.focus();
  return textarea;
}

function focusComposer(inExistingThread: boolean): {
  editor: HTMLDivElement;
  scrollIntoView: Mock<HTMLElement["scrollIntoView"]>;
} {
  const container = document.createElement(
    inExistingThread ? "footer" : "section",
  );
  if (inExistingThread) {
    container.dataset.chatComposer = "";
  }

  const composer = document.createElement("div");
  composer.dataset.slot = "chat-composer-card";
  const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
  Object.defineProperty(composer, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });

  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.tabIndex = 0;
  composer.append(editor);
  container.append(composer);
  document.body.append(container);
  context.signal.addEventListener(
    "abort",
    () => {
      container.remove();
    },
    { once: true },
  );
  editor.focus();

  return { editor, scrollIntoView };
}

async function resizeAndSettle(
  viewport: MockVisualViewport,
  clock: ControlledViewportClock,
  height: number,
  offsetTop = viewport.offsetTop,
): Promise<void> {
  viewport.resizeTo(height, offsetTop);
  await clock.flushUpdate();
}

function startViewportKeyboardState(): ControlledViewportClock {
  const clock = new ControlledViewportClock(context.signal);
  let settledController: AbortController | null = null;
  setupVisualViewportKeyboardState(context.signal, () => {
    settledController?.abort();
    // eslint-disable-next-line ccstate/no-create-child-abort-controller -- migrate this lifetime to the ccstate signal hierarchy
    settledController = createChildAbortController(context.signal);
    return settledController.signal;
  });
  return clock;
}

test("Focusing a mobile text field without a viewport shrink does not activate keyboard layout", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  installVisualViewport(viewport);

  const clock = startViewportKeyboardState();
  focusTextEntry();
  await resizeAndSettle(viewport, clock, 844);

  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
});

test("Late mobile keyboard metrics still reveal the composer", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  installVisualViewport(viewport);

  const clock = startViewportKeyboardState();
  focusTextEntry();
  viewport.dispatchEvent(new Event("resize"));

  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

  // Standalone WebKit can update the final height without another event.
  viewport.height = 520;
  viewport.offsetTop = 100;
  await clock.flushUpdate();
  expect(document.documentElement.dataset.keyboardOpen).toBe("true");
});

test("Repeated mobile keyboard sessions keep an existing-chat composer visible", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  setStandalone(true);
  installVisualViewport(viewport);
  const { editor, scrollIntoView } = focusComposer(true);

  const clock = startViewportKeyboardState();

  for (let cycle = 0; cycle < 5; cycle += 1) {
    await resizeAndSettle(viewport, clock, 520, 100 + cycle * 20);

    expect(scrollIntoView).toHaveBeenCalledTimes(cycle + 1);
    expect(
      document.documentElement.style.getPropertyValue(
        "--okou-keyboard-scroll-reserve",
      ),
    ).toBe("340px");
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      behavior: "auto",
      block: "end",
      inline: "nearest",
    });

    viewport.offsetTop = 280;
    viewport.dispatchEvent(new Event("scroll"));
    await clock.flushUpdate();
    expect(scrollIntoView).toHaveBeenCalledTimes(cycle + 1);

    if (cycle % 2 === 0) {
      // Hiding the software keyboard can leave its accessory bar visible
      // while the editor stays focused.
      await resizeAndSettle(viewport, clock, 740, 100 + cycle * 20);
    } else {
      editor.blur();
      // WebKit can restore height fractionally before offsetTop clears.
      await resizeAndSettle(viewport, clock, 843.4, 100 + cycle * 20);
    }
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
    expect(
      document.documentElement.style.getPropertyValue(
        "--okou-keyboard-scroll-reserve",
      ),
    ).toBe("");
    if (document.activeElement !== editor) {
      editor.focus();
    }
  }
});

test("The Home composer does not receive a redundant keyboard scroll", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  setStandalone(true);
  installVisualViewport(viewport);
  const { scrollIntoView } = focusComposer(false);

  const clock = startViewportKeyboardState();
  await resizeAndSettle(viewport, clock, 520, 100);

  expect(document.documentElement.dataset.keyboardOpen).toBe("true");
  expect(scrollIntoView).not.toHaveBeenCalled();
});

test("An ordinary mobile browser does not force-scroll the page for the keyboard", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  setStandalone(false);
  installVisualViewport(viewport);
  const { scrollIntoView } = focusComposer(true);

  const clock = startViewportKeyboardState();
  await resizeAndSettle(viewport, clock, 520, 100);

  expect(document.documentElement.dataset.keyboardOpen).toBe("true");
  expect(scrollIntoView).not.toHaveBeenCalled();
});

test("Mobile keyboard layout stays stable across mixed open and close cycles", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  installVisualViewport(viewport);
  focusTextEntry();
  const clock = startViewportKeyboardState();

  for (let cycle = 0; cycle < 5; cycle += 1) {
    await resizeAndSettle(viewport, clock, 520, 100 + cycle * 20);
    expect(document.documentElement.dataset.keyboardOpen).toBe("true");

    // Standalone WebKit can restore height before clearing offsetTop. This
    // mixed sample must not become the next cycle's layout baseline.
    await resizeAndSettle(viewport, clock, 844, 100 + cycle * 20);
    expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  }
});

test("The keyboard remains open while moving between text fields", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  installVisualViewport(viewport);
  const firstEntry = focusTextEntry();
  const secondEntry = appendTextEntry();

  const clock = startViewportKeyboardState();
  await resizeAndSettle(viewport, clock, 520, 100);

  secondEntry.focus();
  await clock.flushUpdate();
  expect(document.documentElement.dataset.keyboardOpen).toBe("true");

  secondEntry.blur();
  await clock.flushUpdate();
  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
  expect(document.activeElement).not.toBe(firstEntry);
});

test("Pinch zoom does not activate mobile keyboard layout", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  installVisualViewport(viewport);

  const clock = startViewportKeyboardState();
  focusTextEntry();
  viewport.scale = 2;
  await resizeAndSettle(viewport, clock, 422);

  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
});

test("An orientation change recalibrates mobile keyboard layout", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  installVisualViewport(viewport);
  const entry = focusTextEntry();
  const clock = startViewportKeyboardState();

  window.dispatchEvent(new Event("orientationchange"));
  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

  // The new orientation metrics arrive after orientationchange.
  setInnerHeight(390);
  viewport.height = 390;
  viewport.offsetTop = 0;
  viewport.dispatchEvent(new Event("resize"));
  await clock.flushUpdate();

  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();

  await resizeAndSettle(viewport, clock, 250, 40);
  expect(document.documentElement.dataset.keyboardOpen).toBe("true");

  entry.blur();
  await resizeAndSettle(viewport, clock, 389.5, 40);
  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
});

test("An unfocused resize becomes the new mobile layout baseline", async () => {
  const viewport = new MockVisualViewport(844);
  setInnerHeight(844);
  installVisualViewport(viewport);
  const clock = startViewportKeyboardState();

  setInnerHeight(700);
  await resizeAndSettle(viewport, clock, 700, 0);

  focusTextEntry();
  await resizeAndSettle(viewport, clock, 700, 0);
  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
});

test("Browsers without visual-viewport support keep the normal layout", () => {
  setInnerHeight(844);

  startViewportKeyboardState();
  focusTextEntry();

  expect(document.documentElement.dataset.keyboardOpen).toBeUndefined();
});
