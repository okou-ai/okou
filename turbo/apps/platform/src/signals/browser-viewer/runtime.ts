import { CanvasRenderer } from "./render/canvas.ts";
import { NativeInput } from "./input/native.ts";
import type { ClipboardRecovery } from "./input/clipboard.ts";
import type { TabSpace } from "./viewer/tab-layout.ts";
import { ViewerController } from "./viewer/controller.ts";
import type { ViewerActions, ViewerModel } from "./viewer/model.ts";
import type {
  BrowserConnection,
  ViewerCaptureOptions,
  ViewerTransport,
  WindowSizeSync,
} from "./viewer/types.ts";
import { ToolbarFocus } from "./focus.ts";
import { observeDisplay } from "./display.ts";
import { observeTabStrip } from "./tab-strip.ts";

/** Mounted DOM and protocol resources for one Platform browser surface. */
export class BrowserRuntime {
  private readonly controller: ViewerController;
  private readonly native: NativeInput;
  private readonly focus: ToolbarFocus;
  private readonly cleanups: (() => void)[] = [];
  readonly actions: ViewerActions;
  private closed = false;

  constructor(
    root: HTMLElement,
    model: ViewerModel,
    connection: BrowserConnection,
    options: {
      readonly transport: ViewerTransport;
      readonly capture: ViewerCaptureOptions;
      readonly mode: WindowSizeSync;
      readonly clipboardChanged: (value: ClipboardRecovery | null) => void;
      readonly resized: (space: TabSpace) => void;
    },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const { transport, capture, mode, clipboardChanged, resized } = options;
    let acquired = false;
    using _acquisition = {
      [Symbol.dispose]: () => {
        if (!acquired) {
          this.releaseResources();
        }
      },
    };
    const canvas = root.querySelector<HTMLCanvasElement>(
      "[data-browser-canvas]",
    );
    const proxy = root.querySelector<HTMLTextAreaElement>(
      "[data-browser-input]",
    );
    const surface = root.querySelector<HTMLDivElement>(
      "[data-browser-surface]",
    );
    const toolbar = root.querySelector<HTMLDivElement>(
      "[data-browser-toolbar]",
    );
    const tabs = root.querySelector<HTMLDivElement>('[role="tablist"]');
    const address = root.querySelector<HTMLInputElement>(
      "[data-browser-address]",
    );
    if (!canvas || !proxy || !surface || !toolbar || !tabs || !address) {
      throw new Error("Browser surface is incomplete");
    }
    const renderer = new CanvasRenderer(canvas);
    this.cleanups.push(() => {
      return renderer.dispose();
    });
    this.focus = new ToolbarFocus(toolbar, tabs, address);
    this.controller = new ViewerController(
      model,
      renderer,
      {
        url: connection.cdpUrl,
        ...(connection.windowId === undefined
          ? {}
          : { windowId: connection.windowId }),
        interactive: true,
        transport,
        capture,
        paused: document.hidden,
        onInputReset: (reason) => {
          return this.native.reset(reason);
        },
        onClipboardReset: () => {
          return this.native.clearClipboard();
        },
        onCaret: (point) => {
          return this.native.place(point);
        },
        onTabCreated: () => {
          return this.focus.created();
        },
        onTabClosed: (id) => {
          return this.focus.closed(id);
        },
      },
      signal,
    );
    this.cleanups.push(() => {
      return this.controller.close();
    });
    this.native = new NativeInput(
      surface,
      canvas,
      proxy,
      {
        input: () => {
          return this.controller.input;
        },
        releaseFocus: () => {
          return this.focus.release();
        },
        clipboardChanged,
      },
      signal,
    );
    this.cleanups.push(() => {
      return this.native.dispose();
    }, this.focus.listen());
    this.actions = runtimeActions(this.controller, this.native, this.focus);
    this.observe(canvas, toolbar, tabs, resized, signal);
    this.controller.setWindowSizeSync(mode);
    signal.throwIfAborted();
    acquired = true;
    signal.addEventListener(
      "abort",
      () => {
        return this.close();
      },
      { once: true },
    );
  }

  private observe(
    canvas: HTMLCanvasElement,
    toolbar: HTMLDivElement,
    tabs: HTMLDivElement,
    resized: (space: TabSpace) => void,
    signal: AbortSignal,
  ): void {
    const controller = this.controller;
    const cleanups = this.cleanups;
    let inViewport = true;
    const visibility = () => {
      return controller.setPaused(document.hidden || !inViewport);
    };
    document.addEventListener("visibilitychange", visibility, { signal });
    cleanups.push(() => {
      document.removeEventListener("visibilitychange", visibility);
    });
    const viewport = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) {
        inViewport = entry.isIntersecting;
        visibility();
      }
    });
    viewport.observe(canvas);
    cleanups.push(
      () => {
        return viewport.disconnect();
      },
      observeDisplay(canvas, (size) => {
        return controller.measureDisplay(size);
      }),
    );
    const strip = observeTabStrip(toolbar, tabs, resized);
    cleanups.push(() => {
      return strip.close();
    });

    const focus = new MutationObserver(() => {
      this.focus.restoreAfterClose();
      this.focus.restoreLayout();
    });
    focus.observe(tabs, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
    this.cleanups.push(() => {
      return focus.disconnect();
    });
  }

  start(): void {
    this.controller.start();
  }
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    using _focus = {
      [Symbol.dispose]: () => {
        this.focus.reset();
      },
    };
    this.releaseResources();
  }

  private releaseResources(): void {
    const cleanup = this.cleanups.shift();
    if (!cleanup) {
      return;
    }
    // A failing native close must not strand the remaining DOM resources.
    using _remaining = {
      [Symbol.dispose]: () => {
        this.releaseResources();
      },
    };
    cleanup();
  }
}

function runtimeActions(
  controller: ViewerController,
  native: NativeInput,
  focus: ToolbarFocus,
): ViewerActions {
  return {
    select: (id) => {
      return controller.select(id);
    },
    createTab: () => {
      focus.beginCreate();
      controller.createTab();
    },
    closeTab: (id) => {
      focus.beginClose(id);
      controller.closeTab(id);
    },
    navigate: (action) => {
      return controller.input?.navigate(action);
    },
    copyClipboard: () => {
      return native.copyClipboard();
    },
    dismissClipboard: () => {
      return native.clearClipboard();
    },
    syncDisplay: () => {
      return controller.syncDisplay();
    },
    retryImage: () => {
      return controller.retryImage();
    },
    onWindowSizeSyncChange: (value) => {
      return controller.setWindowSizeSync(value);
    },
    onCaptureChange: (value) => {
      return controller.setCapture(value);
    },
  };
}
