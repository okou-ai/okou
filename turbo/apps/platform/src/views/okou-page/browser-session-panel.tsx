import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import { AppWindow, AppWindowMac, Loader2, Play } from "lucide-react";
import { Button, cn, LayoutPanel } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  browserSessionReclaimHint,
  isBrowserUnauthorized,
  type BrowserSessionSignals,
} from "../../signals/chat-page/browser-session-block.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Browser, BrowserLoadingStatus } from "../browser/browser.tsx";

interface BrowserSessionPanelProps {
  readonly signals: BrowserSessionSignals;
  /**
   * Panel actions for a host without its own header. Live and paused viewers
   * place them in the tab row; placeholders without a viewer use their own row.
   */
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

function UnauthorizedBrowserSession({
  actions,
}: {
  readonly actions: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <PanelFrame>
      <PanelActions actions={actions} />
      <PanelMessage
        icon={<AppWindowMac size={26} className="text-muted-foreground" />}
        title={t(($) => {
          return $.browserSession.authorizationRequired;
        })}
      />
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
}: {
  readonly signals: BrowserSessionSignals;
  readonly liveUrl: string | null;
  readonly instanceId?: string;
  readonly windowId?: number;
  /** The Cloud browser panel switch's floating loading status. */
  readonly refined: boolean;
  readonly actions: ReactNode;
  readonly overlay: ReactNode;
}) {
  const connection = useLastLoadable(signals.viewerConnection$);
  const recovering = useGet(signals.browser.recovering$);
  const syncLayout = useSet(signals.browser.syncLayout$);
  // Keep the DOM during same-identity revalidation. The graph revokes input
  // immediately while pending and owns endpoint changes without a React remount.
  // Conceal a known replacement while preserving the graph until its actual
  // endpoint/window identity is confirmed. A provider URL alone is not that identity.
  const connecting =
    !recovering &&
    connection.state === "hasData" &&
    connection.data !== null &&
    !isBrowserUnauthorized(connection.data) &&
    (connection.data.requestedSession.liveUrl !== liveUrl ||
      connection.data.requestedSession.window?.instanceId !== instanceId ||
      connection.data.requestedSession.window?.primaryWindowId !== windowId);
  // The mounted root owns descriptor deadlines and recovery, including initial
  // loading and failed HTTP reads. Removing it would cancel its own receipt.
  return (
    <div className="relative flex min-h-0 flex-1">
      {connecting && (
        <div className="absolute inset-0 flex flex-col">
          <PanelActions actions={actions} />
          <LoadingBody />
        </div>
      )}
      {/* Preserve geometry so concealment cannot pause its own connection wait. */}
      <LayoutPanel
        active={!connecting}
        layoutKey="browser-viewer"
        onLayoutCommit={syncLayout}
        aria-hidden={connecting}
        inert={connecting}
        data-browser-session-cdp-viewer
        className={cn(
          "relative isolate flex min-h-0 min-w-0 flex-1",
          connecting && "invisible",
        )}
      >
        <Browser
          signals={signals.browser}
          actions={actions}
          presence={overlay}
        />
        {refined && (
          <BrowserLoadingStatus
            signals={signals.browser}
            className="pointer-events-none absolute bottom-2 right-3 rounded border border-divider bg-popover px-2 py-1 text-[11px] leading-4 text-muted-foreground shadow-sm"
          />
        )}
      </LayoutPanel>
    </div>
  );
}

function PausedBrowserSession({
  signals,
  starting,
  onStart,
  refined,
  actions,
}: {
  readonly signals: BrowserSessionSignals;
  readonly starting: boolean;
  readonly onStart: () => void;
  readonly refined: boolean;
  readonly actions: ReactNode;
}) {
  const { t } = useTranslation();
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
      className={cn("absolute inset-0 z-10", !refined && "bg-muted/20")}
    />
  );
  return (
    <PanelFrame>
      <Browser
        signals={signals.browser}
        actions={actions}
        presence={null}
        placeholder={pausedMessage}
      />
    </PanelFrame>
  );
}

function BrowserSessionFooter({
  signals,
}: Pick<BrowserSessionPanelProps, "signals">) {
  const refined = useGet(featureSwitch$)[FeatureSwitchKey.CloudBrowserPanel];
  const status = useLastLoadable(signals.panelStatus$);
  if (refined) {
    return null;
  }
  return (
    <div className="flex shrink-0 items-center gap-3 whitespace-nowrap border-t border-border/60 px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
      <p className="min-w-0 flex-1 truncate">
        {status.state === "hasData" && status.data === "active"
          ? browserSessionReclaimHint({ status: status.data })
          : null}
      </p>
      <BrowserLoadingStatus signals={signals.browser} />
    </div>
  );
}

function BrowserSessionPanelContent({
  signals,
  actions,
  overlay,
}: BrowserSessionPanelProps) {
  // Recovery stays mounted while presentation resolves; native admission uses
  // the authoritative connection rather than partial presentation.
  const status = useLastLoadable(signals.panelStatus$);
  const liveUrl = useLastLoadable(signals.panelLiveUrl$);
  const instanceId = useLastLoadable(signals.panelInstanceId$);
  const windowId = useLastLoadable(signals.panelWindowId$);
  const connection = useLoadable(signals.viewerConnection$);
  const refined = useGet(featureSwitch$)[FeatureSwitchKey.CloudBrowserPanel];
  const keepAliveRef = useSet(signals.keepAliveRef$);
  const [startOperation, start] = useLoadableSet(signals.start$);
  const starting = startOperation.state === "loading";
  const pageSignal = useGet(pageSignal$);

  if (
    connection.state === "hasData" &&
    isBrowserUnauthorized(connection.data)
  ) {
    return <UnauthorizedBrowserSession actions={actions} />;
  }
  if (status.state === "hasData" && status.data === "unauthorized") {
    return <UnauthorizedBrowserSession actions={actions} />;
  }
  if (status.state === "hasData" && status.data !== "active") {
    return (
      <PausedBrowserSession
        signals={signals}
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
    <PanelFrame
      panelRef={
        status.state === "hasData" && status.data === "active"
          ? keepAliveRef
          : undefined
      }
    >
      <BrowserCdpViewer
        signals={signals}
        liveUrl={liveUrl.state === "hasData" ? liveUrl.data : null}
        instanceId={
          instanceId.state === "hasData" ? instanceId.data : undefined
        }
        windowId={windowId.state === "hasData" ? windowId.data : undefined}
        refined={refined}
        actions={actions}
        overlay={overlay}
      />
      <BrowserSessionFooter signals={signals} />
    </PanelFrame>
  );
}

export function BrowserSessionPanel(props: BrowserSessionPanelProps) {
  // A grant owns operation state as well as mounted native/heartbeat resources.
  // Lease timestamps and ordinary session reloads preserve this owner.
  const authorizationScope = useGet(props.signals.authorizationScope$);
  // Keep a confirmed denial visible across a grant's pending revalidation.
  // The keyed native owner must not expose input before that grant is read.
  const status = useLastLoadable(props.signals.panelStatus$);
  if (status.state === "hasData" && status.data === "unauthorized") {
    return <UnauthorizedBrowserSession actions={props.actions} />;
  }
  return <BrowserSessionPanelContent key={authorizationScope} {...props} />;
}
