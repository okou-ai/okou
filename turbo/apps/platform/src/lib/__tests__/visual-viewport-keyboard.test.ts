import { expect, test, vi, type Mock } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../signals/utils.ts";
import { setupVisualViewportKeyboardState } from "../visual-viewport-keyboard.ts";

const context = testContext();

class ControlledViewportClock {
  private readonly animationFrames = new Map<number, FrameRequestCallback>();
  private readonly pendingSettles = new Set<{
    signal: AbortSignal;
    resolve: () => void;
    onAbort: () => void;
  }>();
  private nextFrameId = 1;

  constructor() {
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
  }

  waitForSettle = (signal: AbortSignal): Promise<void> => {
    const deferred = context.mocks.deferred<void>();
    if (signal.aborted) {
      deferred.reject(signal.reason);
      return deferred.promise;
    }
    const pending = {
      signal,
      resolve: () => {
        deferred.resolve();
      },
      onAbort: () => {
        this.pendingSettles.delete(pending);
        deferred.reject(signal.reason);
      },
    };
    this.pendingSettles.add(pending);
    signal.addEventListener("abort", pending.onAbort, { once: true });
    return deferred.promise;
  };

  async flushUpdate(): Promise<void> {
    this.flushAnimationFrames();
    for (const pending of this.pendingSettles) {
      this.pendingSettles.delete(pending);
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.resolve();
    }
    await Promise.resolve();
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
  const resetSettled$ = resetSignal();
  const { store, signal } = context;
  const clock = new ControlledViewportClock();
  setupVisualViewportKeyboardState(
    signal,
    () => {
      return store.set(resetSettled$, signal);
    },
    clock.waitForSettle,
  );
  return clock;
}

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
