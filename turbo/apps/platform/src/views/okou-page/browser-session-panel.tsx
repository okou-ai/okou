import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import { BrowserViewer } from "../browser-viewer/browser-viewer.tsx";
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
import type { ImageLoadSignals } from "../../signals/image-load.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactThumbnailImage } from "./artifact-thumbnail.tsx";

interface BrowserSessionPanelProps {
  readonly signals: BrowserSessionSignals;
  readonly showPausedScreenshot?: boolean;
  /**
   * Panel actions for a host without its own header. The live viewer places
   * them at the end of its tab row; other states give them a row of their own.
   */
  readonly actions?: ReactNode;
  /** Status layered over the live viewer, such as who is in control. */
  readonly overlay?: ReactNode;
  /** The member's input on the live page, for the host's presence. */
  readonly onPageInput?: () => void;
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

function PanelActions({ actions }: { readonly actions: ReactNode }) {
  if (!actions) {
    return null;
  }
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
  windowId,
  refined,
  actions,
  overlay,
  onPageInput,
}: {
  readonly signals: BrowserSessionSignals;
  readonly liveUrl: string | null;
  readonly instanceId?: string;
  readonly windowId?: number;
  /** The Cloud browser panel switch: app tokens and presence. */
  readonly refined: boolean;
  readonly actions: ReactNode;
  readonly overlay: ReactNode;
  readonly onPageInput?: () => void;
}) {
  const connection = useLastLoadable(signals.viewerConnection$);
  // Keep the stream during lease refreshes, but never reuse an endpoint from a
  // previous provider instance while its replacement connection is loading.
  const connecting =
    connection.state === "loading" ||
    (connection.state === "hasData" &&
      connection.data !== null &&
      (connection.data.liveUrl !== liveUrl ||
        connection.data.instanceId !== (instanceId ?? null) ||
        connection.data.windowId !== (windowId ?? null)));
  if (connecting) {
    return (
      <>
        <PanelActions actions={actions} />
        <LoadingBody />
      </>
    );
  }
  if (connection.state === "hasError" || !connection.data) {
    return (
      <>
        <PanelActions actions={actions} />
        <UnavailableBody quiet={refined} />
      </>
    );
  }
  const connectionKey = JSON.stringify([
    signals.threadId,
    connection.data.instanceId,
    connection.data.windowId,
    connection.data.liveUrl,
    connection.data.cdpUrl,
    connection.data.extension.id,
    connection.data.extension.runtimeId,
    connection.data.extension.version,
  ]);
  return (
    <>
      {refined ? null : <PanelActions actions={actions} />}
      <div
        key={connectionKey}
        data-browser-session-cdp-viewer
        className="relative isolate flex min-h-0 flex-1"
      >
        <BrowserViewer
          signals={signals.viewer}
          connectionKey={connectionKey}
          actions={refined ? actions : null}
          presence={overlay}
          onPageInput={onPageInput}
        />
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
          ? "absolute inset-0 z-10 bg-background/60 backdrop-blur-xs"
          : refined
            ? ""
            : undefined
      }
    />
  );
  if (!showScreenshot) {
    return (
      <PanelFrame>
        <PanelActions actions={actions} />
        {pausedMessage}
      </PanelFrame>
    );
  }
  return (
    <PanelFrame>
      <PanelActions actions={actions} />
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
  onPageInput,
}: BrowserSessionPanelProps) {
  const sessionLoadable = useLastLoadable(signals.panelSession$);
  const refined = useGet(featureSwitch$)[FeatureSwitchKey.CloudBrowserPanel];
  const keepAliveRef = useSet(signals.keepAliveRef$);
  const [startOperation, start] = useLoadableSet(signals.start$);
  const starting = startOperation.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const actionsRow = <PanelActions actions={actions} />;
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
  if (session?.status !== "active") {
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

  return (
    <PanelFrame panelRef={keepAliveRef}>
      <BrowserCdpViewer
        signals={signals}
        liveUrl={session.liveUrl}
        instanceId={session.window?.instanceId}
        windowId={session.window?.primaryWindowId}
        refined={refined}
        actions={actions}
        overlay={overlay}
        onPageInput={onPageInput}
      />
      {refined ? null : (
        <p className="border-t border-border/60 px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
          {browserSessionReclaimHint(session)}
        </p>
      )}
    </PanelFrame>
  );
}
