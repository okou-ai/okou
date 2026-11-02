import type { Command, Computed } from "ccstate";
import { createBrowserRuntime } from "./runtime.ts";
import type { ClipboardRecovery } from "./input/clipboard.ts";
import type { BrowserNavigationAction } from "./navigation/action.ts";
import type { DisplayModeResult, DisplayState } from "./display/sync.ts";
import type { DisplaySize } from "./display/geometry.ts";
import type { ImageRecovery } from "./viewer/image-recovery.ts";
import type { layoutTabs } from "./viewer/tab-layout.ts";
import type {
  NavigationReceipt,
  ViewerCaptureOptions,
  ViewerError,
  ViewerHistory,
  ViewerNavigation,
  ViewerStatus,
  ViewerTransport,
  WindowSizeSync,
} from "./viewer/types.ts";

export interface BrowserConnection {
  readonly cdpUrl: string;
  readonly instanceId: string | null;
  readonly windowId: number | null;
  readonly extension: {
    readonly id: string;
    readonly runtimeId: string;
    readonly version: string;
  };
}

export interface BrowserTab {
  readonly id: string;
  readonly title: string;
  readonly faviconUrl?: string;
}

export interface BrowserPresentation {
  readonly status: ViewerStatus;
  readonly error: ViewerError | null;
  readonly loadingPreview: boolean;
}

export interface BrowserControls {
  readonly streaming: boolean;
  readonly emptyUnscoped: boolean;
  readonly emptyScoped: boolean;
  readonly recovery: boolean;
  readonly showRecovery: boolean;
  readonly showEmptyCreate: boolean;
  readonly canMutateTabs: boolean;
  readonly canCreate: boolean;
  readonly tabsDisabled: boolean;
  readonly canSyncDisplay: boolean;
  readonly showImageRetry: boolean;
  readonly canRetryImage: boolean;
  readonly retryingImage: boolean;
}

type Ref<E extends HTMLElement> = Command<(() => void) | undefined, [E | null]>;

/** Read-only observations and finite domain actions; resource plumbing is private. */
export interface BrowserSignals {
  readonly tabs$: Computed<readonly BrowserTab[]>;
  readonly selectedTabId$: Computed<string | null>;
  readonly navigation$: Computed<ViewerNavigation | null>;
  readonly history$: Computed<Promise<ViewerHistory | null>>;
  readonly navigationScope$: Computed<object | null>;
  readonly address$: Computed<string>;
  readonly presentation$: Computed<BrowserPresentation>;
  readonly imageRecovery$: Computed<ImageRecovery | null>;
  readonly controls$: Computed<BrowserControls>;
  readonly capture$: Computed<ViewerCaptureOptions>;
  readonly transport$: Computed<ViewerTransport>;
  readonly windowSizeSync$: Computed<WindowSizeSync>;
  readonly display$: Computed<DisplayState>;
  readonly displayRecovery$: Computed<ViewerError | null>;
  readonly clipboardRecovery$: Computed<ClipboardRecovery | null>;
  readonly tabLayout$: Computed<ReturnType<typeof layoutTabs>>;
  readonly rejectFavicon$: Command<void, [targetId: string, url: string]>;
  readonly selectTab$: Command<Promise<void>, [string, AbortSignal]>;
  readonly createTab$: Command<Promise<string>, [AbortSignal]>;
  readonly closeTab$: Command<Promise<void>, [string, AbortSignal]>;
  readonly navigate$: Command<
    Promise<NavigationReceipt>,
    [BrowserNavigationAction, AbortSignal]
  >;
  readonly editAddress$: Command<void, [string]>;
  readonly resetAddress$: Command<void, []>;
  readonly focusAddress$: Command<void, []>;
  readonly blurAddress$: Command<void, []>;
  readonly reconnect$: Command<Promise<void>, [AbortSignal]>;
  readonly retryImage$: Command<Promise<void>, [AbortSignal]>;
  readonly changeCapture$: Command<
    Promise<void>,
    [ViewerCaptureOptions, AbortSignal]
  >;
  readonly changeTransport$: Command<
    Promise<void>,
    [ViewerTransport, AbortSignal]
  >;
  readonly changeWindowSizeSync$: Command<
    Promise<DisplayModeResult>,
    [WindowSizeSync, AbortSignal]
  >;
  readonly syncDisplay$: Command<Promise<void>, [AbortSignal]>;
  readonly copyClipboard$: Command<Promise<void>, [AbortSignal]>;
  readonly dismissClipboardRecovery$: Command<void, []>;
  /** Notify after the owner invalidates/publishes connection$; not for lease-only updates. */
  readonly connectionChanged$: Command<void, []>;
  /** Re-measure after an application layout commit changes the viewer's box. */
  readonly syncLayout$: Command<void, []>;
  /** Sample the mounted surface even before a remote connection exists. */
  readonly measureInitialDisplay$: Command<DisplaySize | null, []>;
  readonly refs: {
    readonly root$: Ref<HTMLDivElement>;
    readonly canvas$: Ref<HTMLCanvasElement>;
    readonly input$: Ref<HTMLTextAreaElement>;
    readonly toolbar$: Ref<HTMLDivElement>;
    readonly tabs$: Ref<HTMLDivElement>;
    readonly address$: Ref<HTMLInputElement>;
    readonly surface$: Ref<HTMLDivElement>;
  };
}

/** Each surface uses the existing App Store, with its own private native owners. */
export function createBrowserSignals(
  connection$: Computed<Promise<BrowserConnection | null>>,
): BrowserSignals {
  return createBrowserRuntime(connection$);
}
