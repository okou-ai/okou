import {
  GOOGLE_WORKSPACE_MIME_TYPES,
  googleWorkspaceTarget,
  type GoogleDriveUploadMode,
  type GoogleWorkspaceTarget,
} from "@okouai/core/google-workspace-conversion";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import { isShareableArtifactReference } from "../../signals/artifact-sharing.ts";
import type { AttachmentPreviewSignals } from "../../signals/attachment-resource-url.ts";
import { ArtifactShareMenu } from "./artifact-share-menu.tsx";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import { HostedSiteShareMenu } from "./hosted-site-share-menu.tsx";
import {
  currentHostedSiteUrl,
  hostedSiteUrlChanges$,
} from "../../signals/hosted-site-url-changes.ts";
import { isHostedSiteUrl } from "../../signals/chat-page/parse-body-blocks.ts";
import type { ReactElement, ReactNode } from "react";
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
  BrandGoogleDocs,
  BrandGoogleDrive,
  BrandGoogleSheets,
  BrandGoogleSlides,
} from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactGoogleDriveRecovery,
} from "@okouai/api-contracts/contracts/chat-threads";
import { useGet, useLastResolved, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { captureArtifactAction } from "../../lib/posthog.ts";
import { artifactDownloadType } from "../../lib/artifact-download-type.ts";
import type { PlatformConnectorAccountMutationIntent } from "../../signals/connector-domain.ts";
import { downloadAttachment$ } from "../../signals/attachment-download.ts";
import { downloadMarkdownArtifact$ } from "../../signals/chat-page/markdown-artifact-export.ts";
import { artifactPaywallLocked$ } from "../../signals/okou-page/artifact-paywall.ts";
import { ProBadge } from "./components/model-provider-picker.tsx";
import {
  artifactGoogleDriveCatalogItem$,
  inactiveArtifactGoogleDriveCatalogItem$,
  needsArtifactGoogleDriveCatalog,
} from "../../signals/artifact-preview-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { lightboxUrl$ } from "../../signals/okou-page/attachment-chips.ts";
import { detach, isAbortError, Reason } from "../../signals/utils.ts";
import {
  syncArtifactAndRefresh$,
  googleDriveSyncAccount$,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import { getOnlyAvailableCatalogBrowserAuthMethodDetail } from "../../signals/okou-page/settings/connectors.ts";
import { connectBuiltinConnectorOAuthAuthCodeAndContinue$ } from "../../signals/okou-page/settings/connector-connect-continuation.ts";
import { copyAttachmentLinkToClipboard } from "./attachment-url.ts";
import type { ZoomableImageControls } from "./zoomable-image-canvas.tsx";
import type { ArtifactKind } from "../../signals/chat-page/artifact-card-signals.ts";

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
  readonly artifactId: string;
  readonly connectionId: string | undefined;
  readonly filename: string;
  readonly recovery: ChatThreadArtifactGoogleDriveRecovery | undefined;
  readonly synced: boolean;
  readonly mimeType?: string | undefined;
  readonly originalUploaded?: boolean | undefined;
  readonly webViewLink?: string | null | undefined;
};

async function shareArtifactUrl(url: string): Promise<void> {
  await copyAttachmentLinkToClipboard(url);
}

export function ArtifactActionSeparator() {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      className="mx-0.5 h-5 w-px shrink-0 bg-divider/70"
    />
  );
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
    <TooltipProvider delay={200}>
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
  artifactShareIdentity$,
  shareUrl,
  surface,
  ariaLabel,
  className,
  iconSize = 16,
  url,
}: {
  artifactShareIdentity$?: AttachmentPreviewSignals["artifactShareIdentity$"];
  shareUrl: string | null | undefined;
  surface: "dialog" | "sidebar";
  ariaLabel?: string;
  className?: string;
  iconSize?: number;
  url: string;
}) {
  const { t } = useTranslation();
  const label =
    ariaLabel ??
    t(($) => {
      return $.artifacts.actions.share;
    });
  if (isShareableArtifactReference(url)) {
    return (
      <ArtifactShareMenu
        url={url}
        surface={surface}
        ariaLabel={label}
        className={className}
        iconSize={iconSize}
        {...(artifactShareIdentity$ ? { artifactShareIdentity$ } : {})}
      />
    );
  }
  if (!shareUrl) {
    // Private artifacts have no public address. Keep the action hidden while
    // resolving, and until explicit publication provides a share URL.
    return null;
  }
  if (isHostedSiteUrl(shareUrl)) {
    return (
      <HostedSiteShareMenu
        url={url}
        surface={surface}
        ariaLabel={label}
        className={className}
        iconSize={iconSize}
      />
    );
  }
  return (
    <Button
      showTooltip
      tooltipSide="bottom"
      variant="quiet"
      size="icon-sm"
      iconSize={iconSize === 18 ? "md" : iconSize === 20 ? "lg" : "sm"}
      type="button"
      onClick={() => {
        detach(
          shareArtifactUrl(shareUrl),
          Reason.DomCallback,
          "artifact share",
        );
      }}
      aria-label={label}
      className={cn("shrink-0", className)}
    >
      <Share2 size={iconSize} />
    </Button>
  );
}

function useGoogleDriveCompletedOperation(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
) {
  const operation = useGet(googleDriveSyncAccount$);
  return operation &&
    operation.artifactId === syncTarget?.artifactId &&
    operation.agentId === syncTarget.agentId
    ? operation
    : undefined;
}

function useGoogleDriveAvailability(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
  enabled: boolean,
) {
  const completedOperation = useGoogleDriveCompletedOperation(syncTarget);
  const recovery = completedOperation?.recovery ?? syncTarget?.recovery;
  const accountReady = completedOperation?.recovery
    ? false
    : completedOperation?.ready === true || syncTarget?.accountReady === true;
  const catalogItem$ =
    enabled && needsArtifactGoogleDriveCatalog({ accountReady, recovery })
      ? artifactGoogleDriveCatalogItem$
      : inactiveArtifactGoogleDriveCatalogItem$;
  const catalogItemLoadable = useLoadable(catalogItem$);
  const lastCatalogItem = useLastResolved(catalogItem$);
  const catalogItem =
    catalogItemLoadable.state === "hasData"
      ? catalogItemLoadable.data
      : catalogItemLoadable.state === "loading"
        ? lastCatalogItem
        : undefined;
  const googleDriveConnector = catalogItem ?? null;
  const googleDriveAuthMethod =
    googleDriveConnector === null
      ? null
      : getOnlyAvailableCatalogBrowserAuthMethodDetail(googleDriveConnector);
  return {
    googleDriveAuthMethod,
    googleDriveConnector,
    googleDriveReady: accountReady,
    pendingAction: resolveGoogleDrivePendingAction(recovery),
    scopeRequired: completedOperation?.recovery !== undefined,
    googleImport: completedOperation?.googleImport,
    googleDriveConnectionId: completedOperation
      ? completedOperation.connectionId
      : syncTarget?.connectionId,
  };
}

function useGoogleWorkspaceTarget(
  filename: string,
): GoogleWorkspaceTarget | undefined {
  const features = useLastResolved(featureSwitches$);
  const target = googleWorkspaceTarget(filename);
  if (
    target === "presentation" &&
    !features?.[FeatureSwitchKey.GoogleSlidesConversion]
  ) {
    return undefined;
  }
  return target;
}

function useGoogleDriveMenuLabels(target?: GoogleWorkspaceTarget) {
  const { t } = useTranslation();
  return {
    synced: t(($) => {
      return $.artifacts.googleDrive.synced;
    }),
    upload:
      target === "document"
        ? t(($) => {
            return $.artifacts.googleDrive.uploadDocs;
          })
        : target === "spreadsheet"
          ? t(($) => {
              return $.artifacts.googleDrive.uploadSheets;
            })
          : target === "presentation"
            ? t(($) => {
                return $.artifacts.googleDrive.uploadSlides;
              })
            : t(($) => {
                return $.artifacts.googleDrive.upload;
              }),
  };
}

const GOOGLE_WORKSPACE_ICONS = {
  document: BrandGoogleDocs,
  spreadsheet: BrandGoogleSheets,
  presentation: BrandGoogleSlides,
} satisfies Record<GoogleWorkspaceTarget, typeof BrandGoogleSlides>;

function GoogleDriveMenuIcon({
  target,
}: {
  target?: GoogleWorkspaceTarget | undefined;
}) {
  const Icon = target ? GOOGLE_WORKSPACE_ICONS[target] : BrandGoogleDrive;
  return <Icon size={14} />;
}

function GoogleDriveDisabledMenuItem({
  kind,
  muted = false,
  target,
  original = false,
}: {
  kind: "connect" | "synced" | "upload";
  muted?: boolean;
  target?: GoogleWorkspaceTarget | undefined;
  original?: boolean;
}) {
  const { t } = useTranslation();
  const labels = useGoogleDriveMenuLabels(target);
  const text =
    kind === "connect" && !target && !original
      ? t(($) => {
          return $.artifacts.googleDrive.connect;
        })
      : kind === "synced"
        ? labels.synced
        : labels.upload;
  return (
    <DropdownMenuItem className={muted ? "text-muted-foreground" : ""} disabled>
      <GoogleDriveMenuIcon target={target} />
      {text}
    </DropdownMenuItem>
  );
}

type GoogleDrivePendingAction =
  | { readonly kind: "authorize" }
  | {
      readonly kind: "connect";
      readonly account: PlatformConnectorAccountMutationIntent;
    }
  | { readonly kind: "unavailable" };

function resolveGoogleDrivePendingAction(
  recovery: ChatThreadArtifactGoogleDriveRecovery | undefined,
): GoogleDrivePendingAction {
  if (recovery) {
    switch (recovery.action) {
      case "authorize": {
        return { kind: "authorize" };
      }
      case "connect": {
        return {
          kind: "connect",
          account: { intent: "add" },
        };
      }
      case "reconnect": {
        return {
          kind: "connect",
          account: {
            intent: "reconnect",
            connectionId: recovery.connectionId,
          },
        };
      }
      case "unavailable": {
        return { kind: "unavailable" };
      }
    }
  }
  return { kind: "unavailable" };
}

function useGoogleDriveMenuAction(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
  surface: "dialog" | "page",
) {
  const [syncOperation, syncArtifact] = useLoadableSet(syncArtifactAndRefresh$);
  const pageSignal = useGet(pageSignal$);
  const lightbox = useGet(lightboxUrl$);
  const actionSignal =
    surface === "dialog" ? lightbox?.ownerSignal : pageSignal;
  const [connectionOperation, connectGoogleDrive] = useLoadableSet(
    connectBuiltinConnectorOAuthAuthCodeAndContinue$,
  );

  const syncOrConnect = (
    availability: ReturnType<typeof useGoogleDriveAvailability>,
    mode: GoogleDriveUploadMode,
  ) => {
    if (!syncTarget || !actionSignal) {
      return;
    }
    const run = (
      connectedAccountId: string | undefined,
      authorize: boolean,
      signal: AbortSignal,
    ) => {
      if (!syncTarget.agentId) {
        return Promise.resolve();
      }
      return syncArtifact(
        {
          agentId: syncTarget.agentId,
          artifactId: syncTarget.artifactId,
          ...(connectedAccountId ? { connectionId: connectedAccountId } : {}),
          filename: syncTarget.filename,
          mode,
          authorize,
        },
        signal,
      );
    };
    if (availability.googleDriveReady) {
      detach(
        run(availability.googleDriveConnectionId, false, actionSignal),
        Reason.DomCallback,
        "artifact google drive sync",
      );
      return;
    }
    const action = availability.pendingAction;
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
        run(syncTarget.connectionId, true, actionSignal),
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
          origin: availability.scopeRequired
            ? {
                kind: "artifact-drive-reconnect",
                agentId,
                artifactId: syncTarget.artifactId,
              }
            : {
                kind: "artifact-drive-sync",
                agentId,
                artifactId: syncTarget.artifactId,
                filename: syncTarget.filename,
                mode,
              },
          options: {
            account: action.account,
            agentId,
            connectorIcon: availability.googleDriveConnector.icon,
            connectorLabel: availability.googleDriveConnector.label,
          },
        },
        actionSignal,
      ),
      Reason.DomCallback,
      "artifact google drive connect sync",
    );
  };
  return {
    syncOrConnect,
    syncing: syncOperation.state === "loading",
    connecting: connectionOperation.state === "loading",
  };
}

type GoogleDriveCompletedAction =
  | { readonly kind: "synced" }
  | {
      readonly kind: "open";
      readonly target: GoogleWorkspaceTarget;
      readonly url: string;
    };

function googleDriveCompletedAction(
  syncTarget: ArtifactDownloadSyncTarget,
  target: GoogleWorkspaceTarget | undefined,
  imported?: ReturnType<typeof useGoogleDriveAvailability>["googleImport"],
): GoogleDriveCompletedAction | null {
  if (target && imported?.mimeType === GOOGLE_WORKSPACE_MIME_TYPES[target]) {
    if (!imported.webViewLink) {
      throw new Error("Converted Google file is missing its editor URL");
    }
    return { kind: "open", target, url: imported.webViewLink };
  }
  if (!syncTarget.synced) {
    return null;
  }
  if (target) {
    return syncTarget.mimeType === GOOGLE_WORKSPACE_MIME_TYPES[target] &&
      syncTarget.webViewLink
      ? { kind: "open", target, url: syncTarget.webViewLink }
      : null;
  }
  return syncTarget.originalUploaded === true ? { kind: "synced" } : null;
}

function primaryOwnsDriveRecovery(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
  target: GoogleWorkspaceTarget | undefined,
  availability: ReturnType<typeof useGoogleDriveAvailability>,
): boolean {
  return (
    availability.scopeRequired &&
    (!syncTarget ||
      googleDriveCompletedAction(
        syncTarget,
        target,
        availability.googleImport,
      ) === null)
  );
}

function GoogleDriveCompletedMenuItem({
  action,
}: {
  action: GoogleDriveCompletedAction;
}) {
  const { t } = useTranslation();
  if (action.kind === "synced") {
    return <GoogleDriveDisabledMenuItem kind="synced" />;
  }
  return (
    <DropdownMenuItem
      render={<a href={action.url} target="_blank" rel="noopener noreferrer" />}
    >
      <GoogleDriveMenuIcon target={action.target} />
      {action.target === "document"
        ? t(($) => {
            return $.artifacts.googleDrive.openDocs;
          })
        : action.target === "spreadsheet"
          ? t(($) => {
              return $.artifacts.googleDrive.openSheets;
            })
          : t(($) => {
              return $.artifacts.googleDrive.openSlides;
            })}
    </DropdownMenuItem>
  );
}

function GoogleDriveConnectMenuItem({
  availability,
  onClick,
  target,
  uploadLabel,
}: {
  availability: ReturnType<typeof useGoogleDriveAvailability>;
  onClick: () => void;
  target?: GoogleWorkspaceTarget | undefined;
  uploadLabel: string | undefined;
}) {
  const { t } = useTranslation();
  const { googleDriveAuthMethod, googleDriveConnector, pendingAction } =
    availability;
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuItem
              disabled={
                pendingAction.kind === "unavailable" ||
                (pendingAction.kind === "connect" &&
                  (!googleDriveConnector || !googleDriveAuthMethod))
              }
              onClick={onClick}
            >
              <GoogleDriveMenuIcon target={target} />
              {availability.scopeRequired
                ? t(($) => {
                    return $.artifacts.googleDrive.reconnect;
                  })
                : (uploadLabel ??
                  t(($) => {
                    return $.artifacts.googleDrive.connect;
                  }))}
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

function GoogleDriveMenuItem({
  syncTarget,
  availability,
  surface,
  target,
  original = false,
  syncing,
  connecting,
  onSyncOrConnect,
}: {
  syncTarget?: ArtifactDownloadSyncTarget;
  availability: ReturnType<typeof useGoogleDriveAvailability>;
  surface: "dialog" | "page";
  target?: GoogleWorkspaceTarget | undefined;
  original?: boolean;
  syncing: boolean;
  connecting: boolean;
  onSyncOrConnect: ReturnType<typeof useGoogleDriveMenuAction>["syncOrConnect"];
}) {
  const { t } = useTranslation();
  const syncOrConnect = () => {
    captureArtifactAction({
      action: "google_drive_sync",
      surface,
      target: target ?? "file",
    });
    onSyncOrConnect(availability, target ? "google" : "original");
  };
  const labels = useGoogleDriveMenuLabels(target);
  const { googleDriveReady } = availability;

  if (!syncTarget) {
    return (
      <GoogleDriveDisabledMenuItem
        kind="upload"
        target={target}
        original={original}
      />
    );
  }

  const completed = googleDriveCompletedAction(
    syncTarget,
    target,
    availability.googleImport,
  );
  if (completed) {
    return <GoogleDriveCompletedMenuItem action={completed} />;
  }

  if (syncing) {
    return (
      <DropdownMenuItem disabled>
        <Loader2 size={14} className="animate-spin" />
        {t(($) => {
          return $.artifacts.googleDrive.syncingArtifact;
        })}
      </DropdownMenuItem>
    );
  }

  if (connecting) {
    return (
      <GoogleDriveDisabledMenuItem
        kind={syncTarget.disconnected ? "connect" : "upload"}
        muted={syncTarget.disconnected}
        target={target}
        original={original}
      />
    );
  }

  if (googleDriveReady) {
    return (
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuItem onClick={syncOrConnect}>
                <GoogleDriveMenuIcon target={target} />
                {labels.upload}
              </DropdownMenuItem>
            }
          />
          <TooltipContent side="left">
            {target
              ? t(($) => {
                  return $.artifacts.googleDrive.conversionNotice;
                })
              : labels.upload}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <GoogleDriveConnectMenuItem
      availability={availability}
      onClick={syncOrConnect}
      target={target}
      uploadLabel={target || original ? labels.upload : undefined}
    />
  );
}

type ArtifactDownloadMenuProps = {
  align?: "center" | "end" | "start";
  ariaLabel?: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  className?: string;
  contentType?: string | undefined;
  previewKind?: ArtifactKind | undefined;
  filename: string;
  iconSize?: number;
  showGoogleDriveAction?: boolean;
  syncTarget?: ArtifactDownloadSyncTarget;
  surface?: "dialog" | "page";
  url: string;
};

function useArtifactDriveMenu({
  filename,
  showGoogleDriveAction,
  syncTarget,
  surface,
}: Pick<ArtifactDownloadMenuProps, "filename" | "syncTarget"> &
  Required<
    Pick<ArtifactDownloadMenuProps, "showGoogleDriveAction" | "surface">
  >) {
  const workspaceTarget = useGoogleWorkspaceTarget(filename);
  const primary = useGoogleDriveMenuAction(syncTarget, surface);
  const original = useGoogleDriveMenuAction(syncTarget, surface);
  const availability = useGoogleDriveAvailability(
    syncTarget,
    showGoogleDriveAction,
  );
  return (
    <>
      {showGoogleDriveAction && (
        <GoogleDriveMenuItem
          syncTarget={syncTarget}
          availability={availability}
          surface={surface}
          target={workspaceTarget}
          syncing={primary.syncing}
          connecting={primary.connecting}
          onSyncOrConnect={primary.syncOrConnect}
        />
      )}
      {showGoogleDriveAction &&
        workspaceTarget &&
        !primaryOwnsDriveRecovery(
          syncTarget,
          workspaceTarget,
          availability,
        ) && (
          <GoogleDriveMenuItem
            syncTarget={syncTarget}
            availability={availability}
            surface={surface}
            original
            syncing={original.syncing}
            connecting={original.connecting}
            onSyncOrConnect={original.syncOrConnect}
          />
        )}
    </>
  );
}

type MarkdownArtifactExportFormat = "pdf" | "docx";

function MarkdownArtifactExportItem({
  format,
  onExport,
  pending,
}: {
  readonly format: MarkdownArtifactExportFormat;
  readonly onExport: () => void;
  readonly pending: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const label = t(
    ($) => {
      return $.artifacts.actions.downloadMarkdownAs;
    },
    { format: format.toUpperCase() },
  );
  return (
    <DropdownMenuItem
      aria-label={label}
      aria-busy={pending || undefined}
      disabled={pending}
      onClick={onExport}
    >
      {pending ? (
        <Loader2 size={20} className="animate-spin" />
      ) : (
        <FilePreviewIcon
          filename={`file.${format}`}
          size="sm"
          className="shrink-0"
        />
      )}
      {label}
    </DropdownMenuItem>
  );
}

function MarkdownArtifactExportItems({
  docxPending,
  onExport,
  pdfPending,
}: {
  readonly docxPending: boolean;
  readonly onExport: (format: MarkdownArtifactExportFormat) => void;
  readonly pdfPending: boolean;
}): ReactElement {
  return (
    <>
      <MarkdownArtifactExportItem
        format="pdf"
        pending={pdfPending}
        onExport={() => {
          onExport("pdf");
        }}
      />
      <MarkdownArtifactExportItem
        format="docx"
        pending={docxPending}
        onExport={() => {
          onExport("docx");
        }}
      />
    </>
  );
}

function ArtifactDownloadMenuItem({
  onDownload,
  pending,
  paywallLocked,
}: {
  readonly onDownload: () => void;
  readonly pending: boolean;
  readonly paywallLocked: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem disabled={pending} onClick={onDownload}>
      {pending ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Download size={14} />
      )}
      {t(($) => {
        return $.artifacts.actions.download;
      })}
      {paywallLocked && (
        <span className="ml-auto">
          <ProBadge />
        </span>
      )}
    </DropdownMenuItem>
  );
}

async function showMarkdownExportError(
  operation: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const [outcome] = await Promise.allSettled([operation]);
  if (
    outcome.status === "rejected" &&
    !signal.aborted &&
    !isAbortError(outcome.reason)
  ) {
    toast.error(
      i18n.t(($) => {
        return $.artifacts.actions.markdownExportFailed;
      }),
    );
  }
}

export function ArtifactDownloadMenu({
  align = "end",
  ariaLabel,
  artifactKind,
  className,
  contentType,
  previewKind,
  filename,
  iconSize = 16,
  showGoogleDriveAction = true,
  syncTarget,
  surface = "page",
  url: sourceUrl,
}: ArtifactDownloadMenuProps) {
  const { t } = useTranslation();
  const url = currentHostedSiteUrl(sourceUrl, useGet(hostedSiteUrlChanges$));
  const label =
    ariaLabel ??
    t(($) => {
      return $.artifacts.actions.downloadOptions;
    });
  const [downloadLoadable, downloadAttachment] =
    useLoadableSet(downloadAttachment$);
  const [pdfExportLoadable, exportMarkdownPdf] = useLoadableSet(
    downloadMarkdownArtifact$,
  );
  const [docxExportLoadable, exportMarkdownDocx] = useLoadableSet(
    downloadMarkdownArtifact$,
  );
  const pageSignal = useGet(pageSignal$);
  const lightbox = useGet(lightboxUrl$);
  const featureSwitches = useLastResolved(featureSwitches$);
  const markdownExportEnabled =
    previewKind === "markdown" &&
    featureSwitches?.[FeatureSwitchKey.MarkdownFirstOutput] === true;
  const markdownExportSignal =
    surface === "dialog" ? (lightbox?.ownerSignal ?? pageSignal) : pageSignal;
  const pdfExportPending = pdfExportLoadable.state === "loading";
  const docxExportPending = docxExportLoadable.state === "loading";
  const paywallLocked = useLastResolved(artifactPaywallLocked$) === true;
  const downloadPending = downloadLoadable.state === "loading";
  const menuBusy = downloadPending || pdfExportPending || docxExportPending;
  const downloadName = artifactDownloadFilename(artifactKind, filename, url);
  const drive = useArtifactDriveMenu({
    filename,
    showGoogleDriveAction,
    syncTarget,
    surface,
  });
  const startMarkdownExport = (format: MarkdownArtifactExportFormat) => {
    captureArtifactAction({ action: "markdown_export", surface, format });
    const exportArtifact =
      format === "pdf" ? exportMarkdownPdf : exportMarkdownDocx;
    detach(
      showMarkdownExportError(
        exportArtifact({ filename, url, format }, markdownExportSignal),
        markdownExportSignal,
      ),
      Reason.DomCallback,
      `markdown artifact ${format} export`,
    );
  };
  const startDownload = () => {
    captureArtifactAction({
      action: "download",
      surface,
      artifact_type: artifactDownloadType({
        filename: downloadName,
        contentType,
        artifactKind,
        previewKind,
      }),
    });
    detach(
      downloadAttachment({ filename: downloadName, url }, pageSignal),
      Reason.DomCallback,
      "artifact download",
    );
  };
  return (
    <DropdownMenu>
      <ArtifactActionTooltip label={label}>
        <DropdownMenuTrigger
          aria-label={label}
          aria-busy={menuBusy || undefined}
          disabled={downloadPending}
          render={
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              highlightWhenOpen
              className={cn("disabled:opacity-70", className)}
            />
          }
        >
          {menuBusy ? (
            <Loader2 size={iconSize} className="animate-spin" />
          ) : (
            <Download size={iconSize} />
          )}
        </DropdownMenuTrigger>
      </ArtifactActionTooltip>
      <DropdownMenuContent align={align} sideOffset={6} className="w-56">
        <ArtifactDownloadMenuItem
          onDownload={startDownload}
          pending={downloadPending}
          paywallLocked={paywallLocked}
        />
        {markdownExportEnabled && (
          <MarkdownArtifactExportItems
            docxPending={docxExportPending}
            onExport={startMarkdownExport}
            pdfPending={pdfExportPending}
          />
        )}
        {drive}
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
          data-image-navigation="previous"
          aria-label={t(($) => {
            return $.artifacts.actions.previousImage;
          })}
          data-testid={`${testIdPrefix}-previous-image`}
          variant="quiet"
          size="icon-lg"
          className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border/60 bg-background/90 text-foreground shadow-lg backdrop-blur-sm [&_svg]:size-[22px]"
        >
          <ChevronLeft size={22} />
        </Button>
      )}
      {navigation.onNext && (
        <Button
          showTooltip
          type="button"
          onClick={navigation.onNext}
          data-image-navigation="next"
          aria-label={t(($) => {
            return $.artifacts.actions.nextImage;
          })}
          data-testid={`${testIdPrefix}-next-image`}
          variant="quiet"
          size="icon-lg"
          className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border/60 bg-background/90 text-foreground shadow-lg backdrop-blur-sm [&_svg]:size-[22px]"
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
  showTooltip,
  onClick,
  testId,
}: {
  children: ReactNode;
  className: string;
  disabled?: boolean;
  label: string;
  showTooltip: boolean;
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
      data-testid={testId}
    >
      {children}
    </button>
  );
  return showTooltip ? (
    <ArtifactActionTooltip label={label}>{button}</ArtifactActionTooltip>
  ) : (
    button
  );
}

export function ArtifactImageZoomControls({
  controls,
  showTooltip = true,
  placement = "top",
  testIdPrefix,
}: {
  controls: ZoomableImageControls;
  /** Disable floating hints when restoring lightbox focus must not open one. */
  showTooltip?: boolean;
  /**
   * Fullscreen puts the exit control in the top-right corner, and it is the
   * only way back out, so zoom yields that corner rather than sharing it.
   */
  placement?: "top" | "bottom";
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "absolute right-4 z-10 flex items-center gap-2 rounded-lg bg-background/95 px-2.5 py-1.5 text-muted-foreground shadow-sm backdrop-blur-sm",
        placement === "bottom" ? "bottom-4" : "top-4",
      )}
      data-testid={`${testIdPrefix}-image-zoom-controls`}
    >
      <ArtifactImageZoomButton
        className={ARTIFACT_IMAGE_ZOOM_STEP_CLASS}
        disabled={!controls.canZoomOut}
        label={t(($) => {
          return $.artifacts.actions.zoomOut;
        })}
        showTooltip={showTooltip}
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
        showTooltip={showTooltip}
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
        showTooltip={showTooltip}
        onClick={controls.resetZoom}
        testId={`${testIdPrefix}-image-reset-zoom`}
      >
        <RotateCcw size={15} />
      </ArtifactImageZoomButton>
    </div>
  );
}
