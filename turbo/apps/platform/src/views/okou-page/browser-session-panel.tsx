import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import { CdpViewer, type CdpViewerStyle } from "cdp-viewer";
import { browserUse } from "cdp-viewer/extensions/browser-use";
import {
  RectangleHorizontal,
  AppWindow,
  AppWindowMac,
  Globe,
  Loader2,
  Play,
} from "lucide-react";
import {
  BROWSER_INITIAL_SCREEN_HEIGHT,
  BROWSER_SCREEN_WIDTH,
} from "@okouai/api-contracts/contracts/browser";
import { Button, cn } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { theme$ } from "../../signals/theme.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactThumbnailImage } from "./artifact-thumbnail.tsx";

interface BrowserSessionPanelProps {
  readonly signals: BrowserSessionSignals;
  readonly containLiveFrame?: boolean;
  /**
   * Panel actions for a host without its own header. The live viewer places
   * them at the end of its tab row; other states give them a row of their own.
   */
  readonly actions?: ReactNode;
  /** Status layered over the live page, such as who is in control. */
  readonly overlay?: ReactNode;
}

function PanelFrame({
  children,
  panelRef,
}: {
  readonly children: ReactNode;
  readonly panelRef?: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={panelRef}
      data-browser-session-panel
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
    >
      {children}
    </div>
  );
}

function PanelMessage({
  icon,
  title,
  description,
  action,
  className,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center",
        className,
      )}
    >
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-md text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export function BrowserSessionNotFound() {
  const { t } = useTranslation();
  return (
    <PanelFrame>
      <PanelMessage
        icon={<AppWindowMac size={26} className="text-muted-foreground" />}
        title={t(($) => {
          return $.browserSession.notFound;
        })}
      />
    </PanelFrame>
  );
}

function LoadingBody() {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex flex-1 items-center justify-center">
      <Loader2 className="animate-spin text-muted-foreground" size={20} />
      <span className="sr-only">
        {t(($) => {
          return $.browserSession.status.starting;
        })}
      </span>
    </div>
  );
}

function UnavailableBody() {
  const { t } = useTranslation();
  return (
    <PanelMessage
      icon={<AppWindowMac size={26} className="text-muted-foreground" />}
      title={t(($) => {
        return $.browserSession.unavailable.title;
      })}
      description={t(($) => {
        return $.browserSession.unavailable.description;
      })}
    />
  );
}

export function BrowserSessionLoading() {
  return (
    <PanelFrame>
      <LoadingBody />
    </PanelFrame>
  );
}

export function BrowserSessionUnavailable() {
  return (
    <PanelFrame>
      <UnavailableBody />
    </PanelFrame>
  );
}

/**
 * The viewer's own palette is Chrome's. Map every surface, state and focus
 * ring onto the app tokens so the browser reads as part of the panel.
 */
function okouViewerStyle(): CdpViewerStyle {
  const stateLayer = (alpha: string) => {
    return `hsl(var(--state-layer) / var(${alpha}))`;
  };
  return {
    height: "100%",
    minHeight: 0,
    fontFamily: "inherit",
    border: 0,
    "--cdpv-radius": 0,
    "--cdpv-background": "hsl(var(--background))",
    "--cdpv-tab-background": "hsl(var(--background))",
    "--cdpv-tab-selected-background": stateLayer("--state-selected-alpha"),
    "--cdpv-address-background": stateLayer("--state-selected-alpha"),
    "--cdpv-stage-background": "hsl(var(--background))",
    "--cdpv-foreground": "hsl(var(--foreground))",
    "--cdpv-muted": "hsl(var(--muted-foreground))",
    "--cdpv-border": "hsl(var(--divider))",
    "--cdpv-accent": "hsl(var(--primary))",
    "--cdpv-on-accent": "hsl(var(--primary-foreground))",
    "--cdpv-focus": "hsl(var(--ring))",
    "--cdpv-hover": stateLayer("--state-hover-alpha"),
    "--cdpv-control-radius": "var(--radius)",
  };
}

function BrowserBlankPage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-10 text-center">
      <Globe size={20} aria-hidden className="text-muted-foreground" />
      <p className="mt-3 text-sm font-medium text-foreground">
        {t(($) => {
          return $.browserSession.blankPage.title;
        })}
      </p>
      <p className="mt-1 max-w-72 text-xs leading-5 text-muted-foreground">
        {t(($) => {
          return $.browserSession.blankPage.description;
        })}
      </p>
    </div>
  );
}

function PanelActions({ actions }: { readonly actions: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-end gap-0.5 px-1.5">
      {actions}
    </div>
  );
}

function BrowserCdpViewer({
  signals,
  liveUrl,
  actions,
  overlay,
}: {
  readonly signals: BrowserSessionSignals;
  readonly liveUrl: string;
  readonly actions: ReactNode;
  readonly overlay: ReactNode;
}) {
  const { t } = useTranslation();
  const connection = useLastLoadable(signals.viewerConnection$);
  const windowSizeSync = useGet(signals.viewerWindowSizeSync$);
  const setWindowSizeSync = useSet(signals.setViewerWindowSizeSync$);
  const theme = useGet(theme$);
  // Keep the stream during lease refreshes, but never reuse an endpoint from a
  // previous provider instance while its replacement connection is loading.
  const connecting =
    connection.state === "loading" ||
    (connection.state === "hasData" &&
      connection.data !== null &&
      connection.data.liveUrl !== liveUrl);
  if (connecting) {
    return (
      <>
        {actions ? <PanelActions actions={actions} /> : null}
        <LoadingBody />
      </>
    );
  }
  if (connection.state === "hasError" || !connection.data) {
    return (
      <>
        {actions ? <PanelActions actions={actions} /> : null}
        <UnavailableBody />
      </>
    );
  }
  return (
    <div data-browser-session-cdp-viewer className="flex min-h-0 flex-1">
      <CdpViewer
        cdpUrl={connection.data.cdpUrl}
        interactive
        showSettingsMenu
        windowSizeSync={windowSizeSync}
        onWindowSizeSyncChange={setWindowSizeSync}
        extensions={[browserUse()]}
        colorScheme={theme}
        tabStyle="floating"
        toolbarEnd={actions ?? undefined}
        stageOverlay={overlay ?? undefined}
        blankPage={<BrowserBlankPage />}
        labels={{
          addressPlaceholder: t(($) => {
            return $.browserSession.addressPlaceholder;
          }),
          blankTabTitle: t(($) => {
            return $.browserSession.blankTabTitle;
          }),
        }}
        className="w-full flex-1"
        style={okouViewerStyle()}
      />
    </div>
  );
}

function LiveBrowserFrame({
  liveUrl,
  title,
  contain,
  aspectRatio,
}: {
  readonly liveUrl: string;
  readonly title: string;
  readonly contain: boolean;
  readonly aspectRatio: number;
}) {
  return (
    <iframe
      src={liveUrl}
      title={title}
      referrerPolicy="no-referrer"
      allow="autoplay; clipboard-read; clipboard-write; fullscreen"
      style={
        contain
          ? {
              aspectRatio: String(aspectRatio),
              width: `min(100cqw, calc(100cqh * ${String(aspectRatio)}))`,
            }
          : undefined
      }
      className={cn(
        "border-0 bg-background",
        contain
          ? "block h-auto max-h-full max-w-full shrink-0"
          : "w-full min-h-0 flex-1",
      )}
    />
  );
}

function ContainedLiveBrowserViewport({
  signals,
  browserAspectRatio,
  canFitWindow,
  children,
}: {
  readonly signals: BrowserSessionSignals;
  readonly browserAspectRatio: number;
  readonly canFitWindow: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const [fitWindowOperation, fitViewport] = useLoadableSet(
    signals.fitViewport$,
  );
  const fitViewportRef = useSet(signals.fitViewportRef$);
  const fittingWindow = fitWindowOperation.state === "loading";
  const pageSignal = useGet(pageSignal$);

  return (
    <div
      ref={fitViewportRef}
      data-browser-session-viewport
      data-browser-aspect-ratio={browserAspectRatio}
      data-can-fit-window={canFitWindow}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20 [container-type:size]"
    >
      {children}
      <div
        data-browser-session-fit-action
        hidden
        className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-browser-session-fit
          disabled={fittingWindow}
          onClick={() => {
            detach(
              fitViewport(pageSignal),
              Reason.DomCallback,
              "fit browser to sidebar window",
            );
          }}
          aria-label={t(($) => {
            return $.browserSession.fitWindow;
          })}
          className="pointer-events-auto rounded-full border-border/70 bg-background/90 px-3 text-xs text-foreground backdrop-blur-sm hover:bg-state-hover"
        >
          {fittingWindow ? (
            <Loader2 className="animate-spin" size={14} />
          ) : (
            <RectangleHorizontal size={14} />
          )}
          {t(($) => {
            return $.browserSession.fitAction;
          })}
        </Button>
      </div>
    </div>
  );
}

function PausedBrowserSession({
  screenshotUrl,
  screenshotLoad,
  containLiveFrame,
  starting,
  onStart,
  actions,
}: {
  readonly screenshotUrl?: string | null;
  readonly screenshotLoad: ImageLoadSignals;
  readonly containLiveFrame: boolean;
  readonly starting: boolean;
  readonly onStart: () => void;
  readonly actions: ReactNode;
}) {
  const { t } = useTranslation();
  const showScreenshot = containLiveFrame && screenshotUrl;
  const pausedMessage = (
    <PanelMessage
      icon={<AppWindow size={26} className="text-muted-foreground" />}
      title={t(($) => {
        return $.browserSession.panel.notLive;
      })}
      description={t(($) => {
        return $.browserSession.panel.startDescription;
      })}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={starting}
          data-browser-session-start
          onClick={onStart}
          className="mt-2 disabled:cursor-wait"
        >
          {starting ? (
            <Loader2 className="animate-spin" size={14} />
          ) : (
            <Play size={14} />
          )}
          {starting
            ? t(($) => {
                return $.browserSession.panel.starting;
              })
            : t(($) => {
                return $.browserSession.panel.start;
              })}
        </Button>
      }
      className={
        showScreenshot
          ? "absolute inset-0 z-10 bg-background/50 backdrop-blur-md"
          : undefined
      }
    />
  );
  if (!showScreenshot) {
    return (
      <PanelFrame>
        {actions ? <PanelActions actions={actions} /> : null}
        {pausedMessage}
      </PanelFrame>
    );
  }
  return (
    <PanelFrame>
      {actions ? <PanelActions actions={actions} /> : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/20">
        <ArtifactThumbnailImage
          src={screenshotUrl}
          load={screenshotLoad}
          testId="browser-session-panel-screenshot"
          className="absolute inset-x-0 top-0 h-auto w-full object-contain object-top"
          fallback={
            <span className="absolute inset-0 bg-muted/20" aria-hidden />
          }
        />
        <div data-browser-session-screenshot-mask>{pausedMessage}</div>
      </div>
    </PanelFrame>
  );
}

export function BrowserSessionPanel({
  signals,
  containLiveFrame = false,
  actions,
  overlay,
}: BrowserSessionPanelProps) {
  const { t } = useTranslation();
  const sessionLoadable = useLastLoadable(signals.panelSession$);
  const cdpViewerEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.BrowserCdpViewer];
  const keepAliveRef = useSet(signals.keepAliveRef$);
  const [startOperation, start] = useLoadableSet(signals.start$);
  const starting = startOperation.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const actionsRow = actions ? <PanelActions actions={actions} /> : null;
  if (sessionLoadable.state === "loading") {
    return (
      <PanelFrame>
        {actionsRow}
        <LoadingBody />
      </PanelFrame>
    );
  }
  if (sessionLoadable.state === "hasError") {
    return (
      <PanelFrame>
        {actionsRow}
        <UnavailableBody />
      </PanelFrame>
    );
  }

  const session = sessionLoadable.data;
  const liveUrl = session?.status === "active" ? session.liveUrl : null;
  if (liveUrl === null) {
    return (
      <PausedBrowserSession
        screenshotUrl={session?.screenshotUrl}
        screenshotLoad={signals.screenshotImageLoad}
        containLiveFrame={containLiveFrame}
        starting={starting}
        onStart={() => {
          detach(start(pageSignal), Reason.DomCallback);
        }}
        actions={actions}
      />
    );
  }

  if (!session) {
    throw new Error("Live managed browser session is unavailable");
  }
  const browserAspectRatio = session.screen
    ? session.screen.width / session.screen.height
    : BROWSER_SCREEN_WIDTH / BROWSER_INITIAL_SCREEN_HEIGHT;
  const liveFrame = (
    <LiveBrowserFrame
      liveUrl={liveUrl}
      title={t(
        ($) => {
          return $.browserSession.iframeTitle;
        },
        { name: session.name },
      )}
      contain={containLiveFrame}
      aspectRatio={browserAspectRatio}
    />
  );

  return (
    <PanelFrame panelRef={keepAliveRef}>
      {cdpViewerEnabled ? (
        <BrowserCdpViewer
          signals={signals}
          liveUrl={liveUrl}
          actions={actions}
          overlay={overlay}
        />
      ) : containLiveFrame ? (
        <ContainedLiveBrowserViewport
          signals={signals}
          browserAspectRatio={browserAspectRatio}
          canFitWindow={session.screen?.resizable === true}
        >
          {liveFrame}
        </ContainedLiveBrowserViewport>
      ) : (
        liveFrame
      )}
    </PanelFrame>
  );
}
