import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import { CdpViewer } from "cdp-viewer";
import { browserUse } from "cdp-viewer/extensions/browser-use";
import { AppWindow, AppWindowMac, Loader2, Play } from "lucide-react";
import { cn } from "@okouai/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  browserSessionReclaimHint,
  type BrowserSessionSignals,
} from "../../signals/chat-page/browser-session-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { theme$ } from "../../signals/theme.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactThumbnailImage } from "./artifact-thumbnail.tsx";

interface BrowserSessionPanelProps {
  readonly signals: BrowserSessionSignals;
  readonly showPausedScreenshot?: boolean;
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
        className ?? "bg-muted/20",
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

export function BrowserSessionLoading() {
  const { t } = useTranslation();
  return (
    <PanelFrame>
      <div role="status" className="flex flex-1 items-center justify-center">
        <Loader2 className="animate-spin" size={20} />
        <span className="sr-only">
          {t(($) => {
            return $.browserSession.status.starting;
          })}
        </span>
      </div>
    </PanelFrame>
  );
}

export function BrowserSessionUnavailable() {
  const { t } = useTranslation();
  return (
    <PanelFrame>
      <PanelMessage
        icon={<AppWindowMac size={26} className="text-muted-foreground" />}
        title={t(($) => {
          return $.browserSession.unavailable.title;
        })}
        description={t(($) => {
          return $.browserSession.unavailable.description;
        })}
      />
    </PanelFrame>
  );
}

function BrowserCdpViewer({
  signals,
  liveUrl,
}: {
  readonly signals: BrowserSessionSignals;
  readonly liveUrl: string;
}) {
  const connection = useLastLoadable(signals.viewerConnection$);
  const windowSizeSync = useGet(signals.viewerWindowSizeSync$);
  const setWindowSizeSync = useSet(signals.setViewerWindowSizeSync$);
  const theme = useGet(theme$);
  if (connection.state === "loading") {
    return <BrowserSessionLoading />;
  }
  if (connection.state === "hasError" || !connection.data) {
    return <BrowserSessionUnavailable />;
  }
  // Keep the stream during lease refreshes, but never reuse an endpoint from a
  // previous provider instance while its replacement connection is loading.
  if (connection.data.liveUrl !== liveUrl) {
    return <BrowserSessionLoading />;
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
        className="w-full flex-1"
        style={{ height: "100%", minHeight: 0 }}
      />
    </div>
  );
}

function PausedBrowserSession({
  screenshotUrl,
  screenshotLoad,
  showPausedScreenshot,
  starting,
  onStart,
}: {
  readonly screenshotUrl?: string | null;
  readonly screenshotLoad: ImageLoadSignals;
  readonly showPausedScreenshot: boolean;
  readonly starting: boolean;
  readonly onStart: () => void;
}) {
  const { t } = useTranslation();
  const showScreenshot = showPausedScreenshot && screenshotUrl;
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
        <button
          type="button"
          disabled={starting}
          data-browser-session-start
          onClick={onStart}
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70"
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
        </button>
      }
      className={
        showScreenshot
          ? "absolute inset-0 z-10 bg-background/50 backdrop-blur-md"
          : undefined
      }
    />
  );
  if (!showScreenshot) {
    return <PanelFrame>{pausedMessage}</PanelFrame>;
  }
  return (
    <PanelFrame>
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
  showPausedScreenshot = false,
}: BrowserSessionPanelProps) {
  const sessionLoadable = useLastLoadable(signals.panelSession$);
  const keepAliveRef = useSet(signals.keepAliveRef$);
  const [startOperation, start] = useLoadableSet(signals.start$);
  const starting = startOperation.state === "loading";
  const pageSignal = useGet(pageSignal$);

  if (sessionLoadable.state === "loading") {
    return <BrowserSessionLoading />;
  }
  if (sessionLoadable.state === "hasError") {
    return <BrowserSessionUnavailable />;
  }

  const session = sessionLoadable.data;
  const liveUrl = session?.status === "active" ? session.liveUrl : null;
  if (liveUrl === null) {
    return (
      <PausedBrowserSession
        screenshotUrl={session?.screenshotUrl}
        screenshotLoad={signals.screenshotImageLoad}
        showPausedScreenshot={showPausedScreenshot}
        starting={starting}
        onStart={() => {
          detach(start(pageSignal), Reason.DomCallback);
        }}
      />
    );
  }

  if (!session) {
    throw new Error("Live managed browser session is unavailable");
  }
  return (
    <PanelFrame panelRef={keepAliveRef}>
      <BrowserCdpViewer signals={signals} liveUrl={liveUrl} />
      <p className="border-t border-border/60 px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
        {browserSessionReclaimHint(session)}
      </p>
    </PanelFrame>
  );
}
