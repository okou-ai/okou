import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import { CdpViewer, type CdpViewerStyle } from "cdp-viewer";
import { browserUse } from "cdp-viewer/extensions/browser-use";
import { AppWindow, AppWindowMac, Loader2, Play } from "lucide-react";
import { Button, cn } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  browserSessionReclaimHint,
  type BrowserSessionSignals,
} from "../../signals/chat-page/browser-session-block.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { theme$ } from "../../signals/theme.ts";
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactThumbnailImage } from "./artifact-thumbnail.tsx";

interface BrowserSessionPanelProps {
  readonly signals: BrowserSessionSignals;
  readonly showPausedScreenshot?: boolean;
  /** Panel actions for a host without its own header. */
  readonly actions?: ReactNode;
  /** Status layered over the live viewer, such as who is in control. */
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

function LoadingBody() {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex flex-1 items-center justify-center">
      <Loader2 className="animate-spin" size={20} />
      <span className="sr-only">
        {t(($) => {
          return $.browserSession.status.starting;
        })}
      </span>
    </div>
  );
}

function UnavailableBody({ quiet = false }: { readonly quiet?: boolean }) {
  const { t } = useTranslation();
  return (
    <PanelMessage
      className={quiet ? "" : undefined}
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
 * Map the viewer's supported palette variables onto the app tokens so the
 * browser reads as part of the panel.
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
    "--cdpv-address-background": stateLayer("--state-selected-alpha"),
    "--cdpv-stage-background": "hsl(var(--background))",
    "--cdpv-foreground": "hsl(var(--foreground))",
    "--cdpv-muted": "hsl(var(--muted-foreground))",
    "--cdpv-border": "hsl(var(--divider))",
    "--cdpv-accent": "hsl(var(--primary))",
    "--cdpv-on-accent": "hsl(var(--primary-foreground))",
  };
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
  instanceId,
  refined,
  actions,
  overlay,
}: {
  readonly signals: BrowserSessionSignals;
  readonly liveUrl: string;
  readonly instanceId?: string;
  /** The Cloud browser panel switch: app tokens and presence. */
  readonly refined: boolean;
  readonly actions: ReactNode;
  readonly overlay: ReactNode;
}) {
  const connection = useLastLoadable(signals.viewerConnection$);
  const windowSizeSync = useGet(signals.viewerWindowSizeSync$);
  const setWindowSizeSync = useSet(signals.setViewerWindowSizeSync$);
  const capture = useGet(signals.viewerCapture$);
  const setCapture = useSet(signals.setViewerCapture$);
  const theme = useGet(theme$);
  const viewerActivityRef = useSet(signals.viewerActivityRef$);
  const setViewerStatus = useSet(signals.setViewerStatus$);
  // Keep the stream during lease refreshes, but never reuse an endpoint from a
  // previous provider instance while its replacement connection is loading.
  const connecting =
    connection.state === "loading" ||
    (connection.state === "hasData" &&
      connection.data !== null &&
      (connection.data.liveUrl !== liveUrl ||
        connection.data.instanceId !== (instanceId ?? null)));
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
        <UnavailableBody quiet={refined} />
      </>
    );
  }
  return (
    <>
      {actions ? <PanelActions actions={actions} /> : null}
      <div
        key={instanceId ?? liveUrl}
        ref={viewerActivityRef}
        data-browser-session-cdp-viewer
        className="relative isolate flex min-h-0 flex-1"
      >
        <CdpViewer
          cdpUrl={connection.data.cdpUrl}
          interactive
          showSettingsMenu
          windowSizeSync={windowSizeSync}
          onWindowSizeSyncChange={setWindowSizeSync}
          capture={capture}
          onCaptureChange={setCapture}
          onStatusChange={(snapshot) => {
            setViewerStatus(snapshot, liveUrl, instanceId);
          }}
          extensions={[browserUse()]}
          colorScheme={theme}
          className="w-full flex-1"
          style={refined ? okouViewerStyle() : { height: "100%", minHeight: 0 }}
        />
        {overlay ? (
          <div className="pointer-events-none absolute inset-0 z-10">
            {overlay}
          </div>
        ) : null}
      </div>
    </>
  );
}

function PausedBrowserSession({
  screenshotUrl,
  screenshotLoad,
  showPausedScreenshot,
  starting,
  onStart,
  refined,
  actions,
}: {
  readonly screenshotUrl?: string | null;
  readonly screenshotLoad: ImageLoadSignals;
  readonly showPausedScreenshot: boolean;
  readonly starting: boolean;
  readonly onStart: () => void;
  readonly refined: boolean;
  readonly actions: ReactNode;
}) {
  const { t } = useTranslation();
  const showScreenshot = showPausedScreenshot && screenshotUrl;
  const startContent = (
    <>
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
    </>
  );
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
        refined ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={starting}
            data-browser-session-start
            onClick={onStart}
            className="mt-2 disabled:cursor-wait"
          >
            {startContent}
          </Button>
        ) : (
          <button
            type="button"
            disabled={starting}
            data-browser-session-start
            onClick={onStart}
            className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70"
          >
            {startContent}
          </button>
        )
      }
      className={
        showScreenshot
          ? "absolute inset-0 z-10 bg-background/50 backdrop-blur-md"
          : refined
            ? ""
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
  showPausedScreenshot = false,
  actions,
  overlay,
}: BrowserSessionPanelProps) {
  const sessionLoadable = useLastLoadable(signals.panelSession$);
  const refined = useGet(featureSwitch$)[FeatureSwitchKey.CloudBrowserPanel];
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
        <UnavailableBody quiet={refined} />
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
        showPausedScreenshot={showPausedScreenshot}
        starting={starting}
        onStart={() => {
          detach(start(pageSignal), Reason.DomCallback);
        }}
        refined={refined}
        actions={actions}
      />
    );
  }

  if (!session) {
    throw new Error("Live managed browser session is unavailable");
  }
  return (
    <PanelFrame panelRef={keepAliveRef}>
      <BrowserCdpViewer
        key={signals.viewerKey}
        signals={signals}
        liveUrl={liveUrl}
        instanceId={session.window?.instanceId}
        refined={refined}
        actions={actions}
        overlay={overlay}
      />
      {refined || session.window ? null : (
        <p className="border-t border-border/60 px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
          {browserSessionReclaimHint(session)}
        </p>
      )}
    </PanelFrame>
  );
}
