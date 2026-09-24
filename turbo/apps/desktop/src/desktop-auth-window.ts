import {
  BrowserWindow,
  session,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
} from "electron";
import {
  DesktopAuthTeardownError,
  isDesktopAuthCompletionNavigation,
  isDesktopAuthSelectOrgNavigation,
  isDesktopAuthStartNavigation,
  isElectronNavigationAborted,
} from "./desktop-auth";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";
import { showAndFocusWindow } from "./desktop-window-lifecycle";

export interface DesktopAuthWindowRequest {
  readonly url: string;
  readonly visible: boolean;
  readonly allowInteractiveFallbacks: boolean;
  readonly signal: AbortSignal;
}

interface AuthWindowOptions {
  readonly authOrigin: string;
  readonly partition: string;
  readonly windowOptions: () => BrowserWindowConstructorOptions;
  readonly openExternal: (url: string) => void;
  readonly timeoutMs?: number;
}

interface ActiveAuthWindow {
  readonly window: BrowserWindow;
  readonly signal: AbortSignal;
  readonly deliver: (token: string) => void;
  readonly cancel: () => void;
}

/**
 * An elapsed deadline aborts the attempt without anyone abandoning it, so it is
 * genuine unavailability rather than teardown for fail-closed recovery.
 * `AbortSignal.timeout` marks it with the standard `TimeoutError` name.
 */
function isDeadlineAbort(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { readonly name?: unknown }).name === "TimeoutError"
  );
}

/** Owns the IPC capability and the staged token until document completion. */
export class DesktopAuthWindow {
  private active: ActiveAuthWindow | null = null;
  private readonly origins: ReadonlySet<string>;

  constructor(private readonly options: AuthWindowOptions) {
    this.origins = new Set([options.authOrigin]);
  }

  completeSignIn(event: IpcMainInvokeEvent, token: string): void {
    const active = this.active;
    if (!active || active.signal.aborted || active.window.isDestroyed()) {
      throw new Error("Desktop auth operation is no longer active");
    }
    const contents = active.window.webContents;
    if (
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame
    ) {
      throw new Error("Desktop auth completion is unavailable on this page");
    }
    const url = new URL(contents.mainFrame.url);
    if (
      url.origin !== this.options.authOrigin ||
      !["/desktop-auth/token", "/desktop-auth/select-org"].includes(
        url.pathname,
      )
    ) {
      throw new Error("Desktop auth completion is unavailable on this page");
    }
    active.deliver(token);
  }

  run(request: DesktopAuthWindowRequest): Promise<string | null> {
    request.signal.throwIfAborted();
    if (!isAllowedAppNavigation(request.url, this.origins)) {
      throw new Error("Invalid Desktop auth origin");
    }
    this.active?.cancel();
    const options = this.options.windowOptions();
    const window = new BrowserWindow({
      ...options,
      webPreferences: {
        ...options.webPreferences,
        partition: this.options.partition,
      },
      show: request.visible,
      width: request.visible ? 520 : 480,
      height: 640,
      skipTaskbar: !request.visible,
    });
    this.installPolicy(window);
    return this.waitForCompletion(window, request);
  }

  async clearStorage(): Promise<void> {
    this.active?.cancel();
    await session.fromPartition(this.options.partition).clearStorageData({
      storages: [
        "cookies",
        "localstorage",
        "indexdb",
        "serviceworkers",
        "cachestorage",
      ],
    });
  }

  private installPolicy(window: BrowserWindow): void {
    const external = (url: string) => {
      const decision = decideWindowOpen(url, new Set());
      if (decision.action === "open-external") {
        this.options.openExternal(decision.url);
      }
    };
    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedAppNavigation(url, this.origins)) {
        event.preventDefault();
        external(url);
      }
    });
    window.webContents.on("will-redirect", (event, url) => {
      if (!isAllowedAppNavigation(url, this.origins)) {
        event.preventDefault();
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: "deny" };
    });
  }

  private waitForCompletion(
    window: BrowserWindow,
    request: DesktopAuthWindowRequest,
  ): Promise<string | null> {
    // The native BrowserWindow getter is unavailable during the closed event.
    const contents = window.webContents;
    return new Promise((resolve, reject) => {
      let settled = false;
      let token: string | null = null;
      const finish = (result: string | null, error?: Error) => {
        if (settled) return;
        settled = true;
        this.active = null;
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", cancel);
        contents.off("did-navigate", navigate);
        contents.off("did-fail-load", failed);
        window.off("closed", closed);
        if (!window.isDestroyed()) window.close();
        if (error) reject(error);
        else resolve(result);
      };
      // Cancelling and closing abandon the attempt, so they are teardown rather
      // than a failed restore. A deadline is the one abort nobody asked for and
      // stays an ordinary error: nothing was cancelled, so it reports the phase
      // whose budget ran out instead of borrowing the cancellation wording.
      const cancel = () => {
        finish(
          null,
          isDeadlineAbort(request.signal)
            ? new Error(
                request.allowInteractiveFallbacks
                  ? "Desktop auth sign-in timed out"
                  : "Desktop auth session restore timed out",
              )
            : new DesktopAuthTeardownError("Desktop auth operation cancelled"),
        );
      };
      const closed = () =>
        finish(
          null,
          new DesktopAuthTeardownError("Desktop auth window closed"),
        );
      const navigate = (_event: Electron.Event, url: string) => {
        if (
          !request.allowInteractiveFallbacks &&
          (isDesktopAuthStartNavigation(url, this.origins) ||
            isDesktopAuthSelectOrgNavigation(url, this.origins))
        ) {
          finish(null);
        } else if (isDesktopAuthSelectOrgNavigation(url, this.origins)) {
          showAndFocusWindow(window);
        } else if (isDesktopAuthCompletionNavigation(url, this.origins)) {
          // App navigates only after token IPC and the handoff acknowledgement.
          // A landing page without a token is never proof of authentication.
          finish(
            token,
            token
              ? undefined
              : new Error("Desktop auth completed without a token"),
          );
        }
      };
      const failed = (
        _event: Electron.Event,
        code: number,
        _description: string,
        _url: string,
        mainFrame: boolean,
      ) => {
        if (mainFrame && code !== -3) {
          finish(null, new Error(`Desktop auth page failed: ${code}`));
        }
      };
      // A hidden restore has nobody to wait for, so a page that never reaches a
      // decision is a stall this bounds. An attempt that can hand control to a
      // person outlives any machine-scale timer, and the caller already gives
      // that phase a human-scale bound, so arming this one would only decide
      // the same failure under a different name.
      const timeout = request.allowInteractiveFallbacks
        ? undefined
        : setTimeout(() => {
            finish(null, new Error("Desktop auth window timed out"));
          }, this.options.timeoutMs ?? 30_000);
      this.active = {
        window,
        signal: request.signal,
        cancel,
        deliver: (value) => {
          if (settled || token !== null)
            throw new Error("Desktop auth token already delivered");
          token = value;
        },
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      contents.on("did-navigate", navigate);
      contents.on("did-fail-load", failed);
      window.on("closed", closed);
      void window.loadURL(request.url).catch((error: unknown) => {
        if (isElectronNavigationAborted(error)) return;
        // Tearing the attempt down rejects its pending load, and that rejection
        // can outrun the close that caused it. What separates the two is
        // whether this attempt was already being abandoned, never the wording:
        // the same message is a genuine failure while the attempt is live.
        const message = "Desktop auth page could not load";
        const tearingDown = request.signal.aborted || window.isDestroyed();
        finish(
          null,
          tearingDown
            ? new DesktopAuthTeardownError(message)
            : new Error(message),
        );
      });
    });
  }
}
