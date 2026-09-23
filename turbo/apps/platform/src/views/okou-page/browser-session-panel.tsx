import type { ReactNode } from "react";
import {
  RectangleHorizontal,
  AppWindow,
  AppWindowMac,
  Loader2,
  Play,
} from "lucide-react";
import {
  BROWSER_INITIAL_SCREEN_HEIGHT,
  BROWSER_SCREEN_WIDTH,
} from "@okouai/api-contracts/contracts/browser";
import { Button, cn } from "@okouai/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  browserSessionReclaimHint,
  type BrowserSessionSignals,
} from "../../signals/chat-page/browser-session-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactThumbnailImage } from "./artifact-thumbnail.tsx";

interface BrowserSessionPanelProps {
  readonly signals: BrowserSessionSignals;
  readonly containLiveFrame?: boolean;
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
  const fitViewport = useSet(signals.fitViewport$);
  const fitViewportRef = useSet(signals.fitViewportRef$);
  const fittingWindow = useGet(signals.fittingWindow$);
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
}: {
  readonly screenshotUrl?: string | null;
  readonly screenshotLoad: ImageLoadSignals;
  readonly containLiveFrame: boolean;
  readonly starting: boolean;
  readonly onStart: () => void;
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
  containLiveFrame = false,
}: BrowserSessionPanelProps) {
  const { t } = useTranslation();
  const sessionLoadable = useLastLoadable(signals.panelSession$);
  const keepAliveRef = useSet(signals.keepAliveRef$);
  const start = useSet(signals.start$);
  const starting = useGet(signals.starting$);
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
        containLiveFrame={containLiveFrame}
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
      {containLiveFrame ? (
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
      <p className="border-t border-border/60 px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
        {browserSessionReclaimHint(session)}
      </p>
    </PanelFrame>
  );
}
