import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { isShareableArtifactReference } from "../../signals/artifact-sharing.ts";
import { ArtifactShareMenu } from "./artifact-share-menu.tsx";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RotateCcw,
  Share2,
} from "lucide-react";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  BrandGoogleDrive,
} from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactGoogleDriveRecovery,
} from "@okouai/api-contracts/contracts/chat-threads";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import type { PlatformConnectorAccountMutationIntent } from "../../signals/connector-domain.ts";
import { downloadAttachment$ } from "../../signals/attachment-download.ts";
import { apiClient$ } from "../../signals/api-client.ts";
import {
  connectorCatalogStatusBySlug$,
  connectors$,
} from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { connectorConnectionPending$ } from "../../signals/connector-connection-progress.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  authorizeGoogleDriveForAgent,
  syncArtifactFileToGoogleDrive,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import {
  connectConnectorOAuthAuthCodeWithDialogAndSettle$,
  getOnlyAvailableCatalogBrowserAuthMethodDetail,
} from "../../signals/okou-page/settings/connectors.ts";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { copyAttachmentLinkToClipboard } from "./attachment-url.ts";
import { shouldIgnoreImageArtifactNavigationKey } from "./artifact-image-navigation.ts";
import type { ZoomableImageControls } from "./zoomable-image-canvas.tsx";

const GOOGLE_DRIVE_CONNECTOR_SLUG = "google-drive";

function siteSlugFromUrl(value: string): string | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const slug = new URL(value).hostname.split(".")[0];
  return slug && slug.length > 0 ? slug : null;
}

function htmlDownloadFilename(filename: string, url: string): string {
  const trimmed = filename.trim();
  const candidate =
    siteSlugFromUrl(trimmed) ??
    (trimmed === url ? siteSlugFromUrl(url) : null) ??
    trimmed;
  const pathSafe = candidate.replace(/[\\/]/g, "-").trim();
  const withoutHtml = pathSafe.replace(/\.(?:html?|xhtml)$/iu, "");
  const base =
    withoutHtml === pathSafe ? pathSafe.replace(/\.[^/.]+$/u, "") : withoutHtml;
  return `${base || siteSlugFromUrl(url) || "site"}.html`;
}

function artifactDownloadFilename(
  artifactKind: ChatThreadArtifactFile["artifactKind"] | undefined,
  filename: string,
  url: string,
): string {
  return artifactKind === "hosted-site" || artifactKind === "presentation-html"
    ? htmlDownloadFilename(filename, url)
    : filename;
}

export type ArtifactDownloadSyncTarget = {
  readonly accountReady: boolean;
  readonly agentId: string | null | undefined;
  readonly disconnected: boolean;
  readonly fileId: string;
  readonly filename: string;
  readonly onSyncSuccess: () => void;
  readonly recovery: ChatThreadArtifactGoogleDriveRecovery | undefined;
  readonly runId: string;
  readonly synced: boolean;
  readonly threadId: string;
};

async function shareArtifactUrl(url: string): Promise<void> {
  await copyAttachmentLinkToClipboard(url);
}

function isPlainPrimaryLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function iconButtonClassName(className?: string): string {
  return cn(
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
    className,
  );
}

export function ArtifactActionSeparator() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-divider/70" />;
}

export function ArtifactActionTooltip({
  children,
  label,
  side = "bottom",
}: {
  children: ReactElement;
  label: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const trigger = (children.props as { disabled?: boolean }).disabled ? (
    <span className="inline-flex">{children}</span>
  ) : (
    children
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent side={side}>
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ArtifactShareButton({
  shareUrl,
  surface,
  ariaLabel,
  className,
  iconSize = 16,
  url,
}: {
  shareUrl: string | null | undefined;
  surface: "dialog" | "sidebar";
  ariaLabel?: string;
  className?: string;
  iconSize?: number;
  url: string;
}) {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  const label =
    ariaLabel ??
    t(($) => {
      return $.artifacts.actions.share;
    });
  if (
    features?.[FeatureSwitchKey.PrivateArtifacts] &&
    isShareableArtifactReference(url)
  ) {
    return (
      <ArtifactShareMenu
        url={url}
        surface={surface}
        ariaLabel={label}
        className={className}
        iconSize={iconSize}
      />
    );
  }
  if (!shareUrl) {
    // Private artifacts have no public address. Keep the action hidden while
    // resolving, and until explicit publication provides a share URL.
    return null;
  }
  return (
    <ArtifactActionTooltip label={label}>
      <a
        href={shareUrl}
        onClick={(event) => {
          if (!isPlainPrimaryLinkClick(event)) {
            return;
          }
          event.preventDefault();
          detach(
            shareArtifactUrl(shareUrl),
            Reason.DomCallback,
            "artifact share",
          );
        }}
        aria-label={label}
        className={iconButtonClassName(className)}
      >
        <Share2 size={iconSize} />
      </a>
    </ArtifactActionTooltip>
  );
}

function useGoogleDriveAvailability(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
) {
  const connectorListLoadable = useLoadable(connectors$);
  const lastConnectorList = useLastResolved(connectors$);
  const catalogBySlugLoadable = useLoadable(connectorCatalogStatusBySlug$);
  const lastCatalogBySlug = useLastResolved(connectorCatalogStatusBySlug$);
  const connectorList =
    connectorListLoadable.state === "hasData"
      ? connectorListLoadable.data
      : connectorListLoadable.state === "loading"
        ? lastConnectorList
        : undefined;
  const catalogBySlug =
    catalogBySlugLoadable.state === "hasData"
      ? catalogBySlugLoadable.data
      : catalogBySlugLoadable.state === "loading"
        ? lastCatalogBySlug
        : undefined;
  const googleDriveConnected =
    connectorList?.connectors.some((connector) => {
      return (
        connector.slug === GOOGLE_DRIVE_CONNECTOR_SLUG &&
        connector.connectionStatus === "connected"
      );
    }) ?? false;
  const googleDriveConnector =
    catalogBySlug?.get(GOOGLE_DRIVE_CONNECTOR_SLUG) ?? null;
  const googleDriveAuthMethod =
    googleDriveConnector === null
      ? null
      : getOnlyAvailableCatalogBrowserAuthMethodDetail(googleDriveConnector);
  const accountReady = syncTarget?.accountReady === true;

  return {
    connectorListLoaded:
      accountReady ||
      (connectorList !== undefined &&
        (googleDriveConnected || catalogBySlug !== undefined)),
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady: accountReady,
  };
}

function GoogleDriveDisabledMenuItem({
  kind,
  muted = false,
}: {
  kind: "connect" | "synced" | "upload";
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const text =
    kind === "connect"
      ? t(($) => {
          return $.artifacts.googleDrive.connect;
        })
      : kind === "synced"
        ? t(($) => {
            return $.artifacts.googleDrive.synced;
          })
        : t(($) => {
            return $.artifacts.googleDrive.upload;
          });
  return (
    <DropdownMenuItem className={muted ? "text-muted-foreground" : ""} disabled>
      <BrandGoogleDrive size={14} />
      {text}
    </DropdownMenuItem>
  );
}

type GoogleDrivePendingAction =
  | { readonly kind: "authorize" }
  | {
      readonly kind: "connect";
      readonly account: PlatformConnectorAccountMutationIntent;
      readonly useDefaultConnectorProjection: boolean;
    }
  | { readonly kind: "unavailable" };

function resolveGoogleDrivePendingAction(args: {
  readonly recovery: ChatThreadArtifactGoogleDriveRecovery | undefined;
  readonly connected: boolean;
  readonly legacyAccountOptions: ReturnType<
    typeof defaultBuiltinConnectorAccountOptions
  >;
}): GoogleDrivePendingAction {
  if (args.recovery) {
    switch (args.recovery.action) {
      case "authorize": {
        return { kind: "authorize" };
      }
      case "connect": {
        return {
          kind: "connect",
          account: { intent: "add" },
          useDefaultConnectorProjection: false,
        };
      }
      case "reconnect": {
        return {
          kind: "connect",
          account: {
            intent: "reconnect",
            connectionId: args.recovery.connectionId,
          },
          useDefaultConnectorProjection: false,
        };
      }
      case "unavailable": {
        return { kind: "unavailable" };
      }
    }
  }
  if (args.connected) {
    return { kind: "authorize" };
  }
  return args.legacyAccountOptions
    ? { kind: "connect", ...args.legacyAccountOptions }
    : { kind: "unavailable" };
}

function useGoogleDriveMenuAction(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
  availability: ReturnType<typeof useGoogleDriveAvailability>,
): () => void {
  const createClient = useGet(apiClient$);
  const pageSignal = useGet(pageSignal$);
  const connectGoogleDrive = useSet(
    connectConnectorOAuthAuthCodeWithDialogAndSettle$,
  );

  return () => {
    if (!syncTarget) {
      return;
    }
    const run = async (signal: AbortSignal) => {
      const success = await syncArtifactFileToGoogleDrive(
        {
          createClient,
          threadId: syncTarget.threadId,
          runId: syncTarget.runId,
          fileId: syncTarget.fileId,
          filename: syncTarget.filename,
        },
        signal,
      );
      signal.throwIfAborted();
      if (success) {
        syncTarget.onSyncSuccess();
      }
    };
    if (availability.googleDriveReady) {
      detach(run(pageSignal), Reason.DomCallback, "artifact google drive sync");
      return;
    }
    const action = resolveGoogleDrivePendingAction({
      recovery: syncTarget.recovery,
      connected: availability.googleDriveConnected,
      legacyAccountOptions: defaultBuiltinConnectorAccountOptions(
        availability.googleDriveConnector ?? undefined,
      ),
    });
    if (action.kind === "unavailable") {
      return;
    }
    if (!syncTarget.agentId) {
      toast.error(
        i18n.t(($) => {
          return $.artifacts.googleDrive.agentLoading;
        }),
      );
      return;
    }
    const agentId = syncTarget.agentId;
    if (action.kind === "authorize") {
      detach(
        (async () => {
          await authorizeGoogleDriveForAgent(
            { agentId, createClient },
            pageSignal,
          );
          await run(pageSignal);
        })(),
        Reason.DomCallback,
        "artifact google drive authorize sync",
      );
      return;
    }
    if (
      !availability.googleDriveConnector ||
      !availability.googleDriveAuthMethod
    ) {
      return;
    }
    detach(
      connectGoogleDrive(
        {
          connectorSlug: GOOGLE_DRIVE_CONNECTOR_SLUG,
          method: availability.googleDriveAuthMethod,
          onSuccess: (_connectionId, signal) => {
            return run(signal);
          },
          options: {
            account: action.account,
            agentId,
            connectorIcon: availability.googleDriveConnector.icon,
            connectorLabel: availability.googleDriveConnector.label,
            ...(action.useDefaultConnectorProjection
              ? { useDefaultConnectorProjection: true }
              : {}),
          },
        },
        pageSignal,
      ),
      Reason.DomCallback,
      "artifact google drive connect sync",
    );
  };
}

function GoogleDriveMenuItem({
  syncTarget,
}: {
  syncTarget?: ArtifactDownloadSyncTarget;
}) {
  const { t } = useTranslation();
  const availability = useGoogleDriveAvailability(syncTarget);
  const connectionPending = useGet(connectorConnectionPending$);
  const syncOrConnect = useGoogleDriveMenuAction(syncTarget, availability);
  const {
    connectorListLoaded,
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady,
  } = availability;

  if (!syncTarget) {
    return <GoogleDriveDisabledMenuItem kind="upload" />;
  }

  if (syncTarget.synced) {
    return <GoogleDriveDisabledMenuItem kind="synced" />;
  }

  if (!connectorListLoaded || connectionPending) {
    return (
      <GoogleDriveDisabledMenuItem
        kind={syncTarget.disconnected ? "connect" : "upload"}
        muted={syncTarget.disconnected}
      />
    );
  }

  if (googleDriveReady) {
    return (
      <DropdownMenuItem onClick={syncOrConnect}>
        <BrandGoogleDrive size={14} />
        {t(($) => {
          return $.artifacts.googleDrive.upload;
        })}
      </DropdownMenuItem>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuItem
              disabled={
                syncTarget.recovery?.action === "unavailable" ||
                ((syncTarget.recovery?.action === "connect" ||
                  syncTarget.recovery?.action === "reconnect") &&
                  (!googleDriveConnector || !googleDriveAuthMethod)) ||
                (syncTarget.recovery === undefined &&
                  !googleDriveConnected &&
                  (!googleDriveConnector || !googleDriveAuthMethod))
              }
              onClick={syncOrConnect}
            >
              <BrandGoogleDrive size={14} />
              {t(($) => {
                return $.artifacts.googleDrive.connect;
              })}
            </DropdownMenuItem>
          }
        />
        <TooltipContent side="left">
          {t(($) => {
            return $.artifacts.googleDrive.connectTooltip;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type ArtifactDownloadMenuProps = {
  align?: "center" | "end" | "start";
  ariaLabel?: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  className?: string;
  filename: string;
  iconSize?: number;
  showGoogleDriveAction?: boolean;
  syncTarget?: ArtifactDownloadSyncTarget;
  url: string;
};

export function ArtifactDownloadMenu({
  align = "end",
  ariaLabel,
  artifactKind,
  className,
  filename,
  iconSize = 16,
  showGoogleDriveAction = true,
  syncTarget,
  url,
}: ArtifactDownloadMenuProps) {
  const { t } = useTranslation();
  const label =
    ariaLabel ??
    t(($) => {
      return $.artifacts.actions.downloadOptions;
    });
  const [downloadLoadable, downloadAttachment] =
    useLoadableSet(downloadAttachment$);
  const pageSignal = useGet(pageSignal$);
  const downloadPending = downloadLoadable.state === "loading";
  const downloadName = artifactDownloadFilename(artifactKind, filename, url);
  return (
    <DropdownMenu>
      <ArtifactActionTooltip label={label}>
        <DropdownMenuTrigger
          aria-label={label}
          aria-busy={downloadPending ? "true" : undefined}
          disabled={downloadPending}
          render={
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              className={cn(
                "data-popup-open:bg-state-hover data-popup-open:text-foreground disabled:pointer-events-none disabled:opacity-70",
                className,
              )}
            />
          }
        >
          {downloadPending ? (
            <Loader2 size={iconSize} className="animate-spin" />
          ) : (
            <Download size={iconSize} />
          )}
        </DropdownMenuTrigger>
      </ArtifactActionTooltip>
      <DropdownMenuContent align={align} sideOffset={6} className="w-56">
        <DropdownMenuItem
          onClick={() => {
            detach(
              downloadAttachment({ filename: downloadName, url }, pageSignal),
              Reason.DomCallback,
              "artifact download",
            );
          }}
        >
          <Download size={14} />
          {t(($) => {
            return $.artifacts.actions.download;
          })}
        </DropdownMenuItem>
        {showGoogleDriveAction && (
          <GoogleDriveMenuItem syncTarget={syncTarget} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Image artifact controls shared by the thread sidebar and the lightbox dialog.
// ---------------------------------------------------------------------------

export type ArtifactImageNavigationActions = {
  readonly onNext?: () => void;
  readonly onPrevious?: () => void;
};

export function ArtifactImageNavigationControls({
  navigation,
  testIdPrefix,
}: {
  navigation?: ArtifactImageNavigationActions;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  if (!navigation?.onPrevious && !navigation?.onNext) {
    return null;
  }

  return (
    <>
      {navigation.onPrevious && (
        <Button
          showTooltip
          type="button"
          onClick={navigation.onPrevious}
          aria-label={t(($) => {
            return $.artifacts.actions.previousImage;
          })}
          data-testid={`${testIdPrefix}-previous-image`}
          variant="quiet"
          size="icon-lg"
          className="absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border/60 bg-background/90 text-foreground shadow-lg backdrop-blur-sm [&_svg]:size-[22px]"
        >
          <ChevronLeft size={22} />
        </Button>
      )}
      {navigation.onNext && (
        <Button
          showTooltip
          type="button"
          onClick={navigation.onNext}
          aria-label={t(($) => {
            return $.artifacts.actions.nextImage;
          })}
          data-testid={`${testIdPrefix}-next-image`}
          variant="quiet"
          size="icon-lg"
          className="absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border/60 bg-background/90 text-foreground shadow-lg backdrop-blur-sm [&_svg]:size-[22px]"
        >
          <ChevronRight size={22} />
        </Button>
      )}
    </>
  );
}

const ARTIFACT_IMAGE_ZOOM_STEP_CLASS =
  "flex h-5 w-5 items-center justify-center rounded-md text-sm leading-none transition-colors hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

function ArtifactImageZoomButton({
  children,
  className,
  disabled,
  label,
  nativeTitle,
  onClick,
  testId,
}: {
  children: ReactNode;
  className: string;
  disabled?: boolean;
  label: string;
  nativeTitle: boolean;
  onClick: () => void;
  testId: string;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
      aria-label={label}
      title={nativeTitle ? label : undefined}
      data-testid={testId}
    >
      {children}
    </button>
  );
  return nativeTitle ? (
    button
  ) : (
    <ArtifactActionTooltip label={label}>{button}</ArtifactActionTooltip>
  );
}

export function ArtifactImageZoomControls({
  controls,
  nativeTitle = false,
  testIdPrefix,
}: {
  controls: ZoomableImageControls;
  /** Use the browser title tooltip instead of the floating action tooltip. */
  nativeTitle?: boolean;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-lg bg-background/95 px-2.5 py-1.5 text-muted-foreground shadow-sm backdrop-blur-sm"
      data-testid={`${testIdPrefix}-image-zoom-controls`}
    >
      <ArtifactImageZoomButton
        className={ARTIFACT_IMAGE_ZOOM_STEP_CLASS}
        disabled={!controls.canZoomOut}
        label={t(($) => {
          return $.artifacts.actions.zoomOut;
        })}
        nativeTitle={nativeTitle}
        onClick={controls.zoomOut}
        testId={`${testIdPrefix}-image-zoom-out`}
      >
        -
      </ArtifactImageZoomButton>
      <span
        className="min-w-10 text-center text-xs font-medium tabular-nums text-foreground"
        data-testid={`${testIdPrefix}-image-zoom-level`}
      >
        {Math.round(controls.zoom * 100)}%
      </span>
      <ArtifactImageZoomButton
        className={ARTIFACT_IMAGE_ZOOM_STEP_CLASS}
        disabled={!controls.canZoomIn}
        label={t(($) => {
          return $.artifacts.actions.zoomIn;
        })}
        nativeTitle={nativeTitle}
        onClick={controls.zoomIn}
        testId={`${testIdPrefix}-image-zoom-in`}
      >
        +
      </ArtifactImageZoomButton>
      <ArtifactImageZoomButton
        className="flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-state-hover hover:text-foreground"
        label={t(($) => {
          return $.artifacts.actions.resetZoom;
        })}
        nativeTitle={nativeTitle}
        onClick={controls.resetZoom}
        testId={`${testIdPrefix}-image-reset-zoom`}
      >
        <RotateCcw size={15} />
      </ArtifactImageZoomButton>
    </div>
  );
}

/**
 * Document-level arrow-key navigation between image artifacts. Renders a
 * hidden marker so the listener follows the mounted preview.
 */
export function ArtifactImageNavigationKeydown({
  capture = false,
  considerFocus,
  enabled = true,
  navigation,
}: {
  capture?: boolean;
  considerFocus: boolean;
  enabled?: boolean;
  navigation?: ArtifactImageNavigationActions;
}) {
  let cleanup: (() => void) | null = null;

  return (
    <span
      ref={(node) => {
        cleanup?.();
        cleanup = null;
        if (!node || (!navigation?.onPrevious && !navigation?.onNext)) {
          return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
          if (
            !enabled ||
            shouldIgnoreImageArtifactNavigationKey(event, { considerFocus })
          ) {
            return;
          }
          if (event.key === "ArrowLeft" && navigation.onPrevious) {
            event.preventDefault();
            navigation.onPrevious();
          }
          if (event.key === "ArrowRight" && navigation.onNext) {
            event.preventDefault();
            navigation.onNext();
          }
        };

        document.addEventListener("keydown", onKeyDown, capture);
        cleanup = () => {
          document.removeEventListener("keydown", onKeyDown, capture);
        };
      }}
      hidden
    />
  );
}
