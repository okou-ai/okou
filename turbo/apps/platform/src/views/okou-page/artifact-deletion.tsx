import { useGet, useLoadable, useSet } from "ccstate-react";
import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@okouai/ui";
import { Loader2, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  artifactDeleteTarget$,
  artifactDeletionFinalFocus$,
  artifactPreviewDeletionScope,
  deleteCatalogArtifact$,
  setArtifactDeleteTarget$,
  type PreviewArtifactDeletion,
  type ArtifactDeletionSourceKind,
} from "../../signals/artifact-deletion.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { getArtifactShareScope } from "../../signals/artifact-sharing.ts";
import { getHostedSiteShareScope } from "../../signals/hosted-site-sharing.ts";
import {
  artifactDeletionSurface,
  confirmArtifactDeletion$,
  type ArtifactDeletionOrigin,
} from "../../signals/artifact-deletion-origin.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { CatalogArtifact } from "../../signals/artifacts-page/create-artifact-catalog-signals.ts";
import {
  ArtifactDownloadMenu,
  useGoogleDriveAvailability,
  type ArtifactDownloadMenuProps,
} from "./artifact-actions.tsx";

function usePreviewShareFailures(
  surface: "dialog" | "sidebar" | "page",
  url: string,
  syncTarget: ArtifactDownloadMenuProps["syncTarget"],
  driveEnabled = true,
) {
  const shareSurface = surface === "dialog" ? "dialog" : "sidebar";
  const shareScope = getArtifactShareScope(shareSurface);
  const siteScope = getHostedSiteShareScope(shareSurface);
  const shareSession = useGet(shareScope.session$);
  const siteSession = useGet(siteScope.session$);
  const sharing = useLoadable(shareScope.details$);
  const hostedSite = useLoadable(siteScope.settings$);
  const drive = useGoogleDriveAvailability(syncTarget, driveEnabled);
  return {
    sharing: shareSession?.source.url === url && sharing.state === "hasError",
    hostedSite:
      siteSession?.sourceUrl === url && hostedSite.state === "hasError",
    drive: drive.googleDriveCatalogFailed,
  };
}

export function ArtifactPreviewMoreMenu({
  artifactId,
  origin,
  ...downloadProps
}: Omit<ArtifactDownloadMenuProps, "children" | "trigger" | "triggerRef"> & {
  readonly artifactId?: string;
  readonly origin: ArtifactDeletionOrigin;
}) {
  const { t } = useTranslation();
  const surface = artifactDeletionSurface(origin);
  const scope = artifactPreviewDeletionScope(surface);
  const mountRef = useSet(scope.mountRef$);
  const triggerRef = useSet(scope.menuTriggerRef$);
  const session = useGet(scope.session$);
  // Subscribe outside the popup so ownership is ready before the first click.
  const detail = useLoadable(scope.detail$);
  const snapshot = useGet(scope.menuSnapshot$);
  const captureMenu = useSet(scope.captureMenu$);
  const retryActions = useSet(scope.retryActions$);
  const shareFailures = usePreviewShareFailures(
    surface,
    downloadProps.url,
    downloadProps.syncTarget,
    downloadProps.showGoogleDriveAction,
  );
  const currentSession =
    session?.artifactId === artifactId && session?.sourceKind === undefined
      ? session
      : null;
  const deleteReady =
    currentSession !== null && detail.state === "hasData" && !!detail.data;
  const failed = {
    deletion: currentSession !== null && detail.state === "hasError",
    ...shareFailures,
  };
  const unavailable = Object.values(failed).some(Boolean);

  return (
    <>
      <ArtifactDownloadMenu
        {...downloadProps}
        trigger="more"
        triggerRef={triggerRef}
        previewMenu={{
          snapshot,
          deleteArtifactId: deleteReady ? (artifactId ?? null) : null,
          recovery: unavailable,
          onOpen: captureMenu,
        }}
      >
        {deleteReady &&
          snapshot?.url === downloadProps.url &&
          snapshot.delete === artifactId && (
            <PreviewArtifactDeleteMenuItem origin={origin} />
          )}
        {unavailable &&
          snapshot?.url === downloadProps.url &&
          snapshot.recovery && (
            <>
              <DropdownMenuSeparator />
              <div
                role="status"
                className="px-2 py-1.5 text-xs text-muted-foreground"
              >
                {t(($) => {
                  return $.artifacts.actions.partiallyUnavailable;
                })}
              </div>
              <DropdownMenuItem
                onClick={() => {
                  retryActions(failed);
                }}
              >
                <RotateCcw size={14} />
                {t(($) => {
                  return $.artifacts.actions.retry;
                })}
              </DropdownMenuItem>
            </>
          )}
      </ArtifactDownloadMenu>
      {artifactId && (
        <span
          key={artifactId}
          ref={mountRef}
          data-artifact-id={artifactId}
          className="hidden"
        />
      )}
      {currentSession && (
        <PreviewArtifactDeleteDialog session={currentSession} origin={origin} />
      )}
    </>
  );
}

function PreviewArtifactDeleteMenuItem({
  origin,
}: {
  readonly origin: ArtifactDeletionOrigin;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const scope = artifactPreviewDeletionScope(artifactDeletionSurface(origin));
  const requestDeletion = useSet(scope.requestFromMenu$);
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-destructive"
        onClick={() => {
          detach(
            requestDeletion(pageSignal),
            Reason.DomCallback,
            "confirm artifact deletion",
          );
        }}
      >
        <Trash2 size={14} />
        {t(($) => {
          return $.artifacts.deletion.delete;
        })}
      </DropdownMenuItem>
    </>
  );
}

export function ArtifactDeleteMenu({
  artifact,
}: {
  readonly artifact: CatalogArtifact;
}) {
  const { t } = useTranslation();
  const triggerRef = useSet(artifact.deletion.triggerRef$);
  const requestDeletion = useSet(artifact.deletion.request$);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label={t(
          ($) => {
            return $.artifacts.deletion.menu;
          },
          {
            title: artifact.title,
          },
        )}
        render={
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            className="bg-background/90"
          />
        }
      >
        <MoreHorizontal size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          className="text-destructive"
          onClick={requestDeletion}
        >
          <Trash2 size={14} />
          {t(($) => {
            return $.artifacts.deletion.delete;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ArtifactDeleteDialog() {
  const target = useGet(artifactDeleteTarget$);
  const finalFocus = useSet(artifactDeletionFinalFocus$);
  const setTarget = useSet(setArtifactDeleteTarget$);
  const [deletion, deleteArtifact] = useLoadableSet(deleteCatalogArtifact$);
  const pageSignal = useGet(pageSignal$);
  return (
    <ArtifactDeleteConfirmation
      target={target}
      busy={deletion.state === "loading"}
      finalFocus={finalFocus}
      onCancel={() => {
        setTarget(null);
      }}
      onConfirm={() => {
        detach(
          deleteArtifact(pageSignal),
          Reason.DomCallback,
          "delete artifact",
        );
      }}
    />
  );
}

export function ArtifactPageDeleteButton({
  artifactId,
  sourceKind,
}: {
  readonly artifactId: string;
  readonly sourceKind: ArtifactDeletionSourceKind;
}) {
  return (
    <ArtifactDeleteButton
      artifactId={artifactId}
      sourceKind={sourceKind}
      origin={{ kind: "artifact-page" }}
      iconSize={18}
    />
  );
}

/** Owner-only action shared by catalog, chat, and standalone previews. */
export function ArtifactDeleteButton({
  artifactId,
  sourceKind,
  origin,
  iconSize = 16,
}: {
  readonly artifactId?: string;
  readonly sourceKind?: ArtifactDeletionSourceKind;
  /** The surface deleting the artifact; it decides what follows. */
  readonly origin: ArtifactDeletionOrigin;
  readonly iconSize?: number;
}) {
  const scope = artifactPreviewDeletionScope(artifactDeletionSurface(origin));
  const mountRef = useSet(scope.mountRef$);
  const session = useGet(scope.session$);
  if (!artifactId) {
    return null;
  }
  return (
    <span
      key={artifactId}
      ref={mountRef}
      data-artifact-id={artifactId}
      data-source-kind={sourceKind}
      className="inline-flex"
    >
      {session?.artifactId === artifactId &&
        session.sourceKind === sourceKind && (
          <PreviewArtifactDeleteButton
            key={artifactId}
            session={session}
            origin={origin}
            iconSize={iconSize}
          />
        )}
    </span>
  );
}

function PreviewArtifactDeleteButton({
  session,
  origin,
  iconSize,
}: {
  readonly session: PreviewArtifactDeletion;
  readonly origin: ArtifactDeletionOrigin;
  readonly iconSize: number;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const detail = useLoadable(session.detail$);
  const requestDeletion = useSet(session.request$);
  return (
    <>
      {detail.state === "hasData" && detail.data && (
        <Button
          showTooltip
          type="button"
          variant="quiet"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t(($) => {
            return $.artifacts.deletion.delete;
          })}
          onClick={(event) => {
            detach(
              requestDeletion(event.currentTarget, pageSignal),
              Reason.DomCallback,
              "confirm artifact deletion",
            );
          }}
        >
          <Trash2 size={iconSize} />
        </Button>
      )}
      <PreviewArtifactDeleteDialog session={session} origin={origin} />
    </>
  );
}

function PreviewArtifactDeleteDialog({
  session,
  origin,
}: {
  readonly session: PreviewArtifactDeletion;
  readonly origin: ArtifactDeletionOrigin;
}) {
  const pageSignal = useGet(pageSignal$);
  const target = useGet(session.target$);
  const close = useSet(session.close$);
  const finalFocus = useSet(session.finalFocus$);
  const [deletion, confirm] = useLoadableSet(confirmArtifactDeletion$);
  return (
    <ArtifactDeleteConfirmation
      target={target}
      busy={deletion.state === "loading"}
      finalFocus={finalFocus}
      onCancel={close}
      onConfirm={() => {
        detach(
          confirm(origin, pageSignal),
          Reason.DomCallback,
          "delete preview artifact",
        );
      }}
    />
  );
}

function ArtifactDeleteConfirmation({
  target,
  busy,
  finalFocus,
  onCancel,
  onConfirm,
}: {
  readonly target: ArtifactSummary | null;
  readonly busy: boolean;
  readonly finalFocus: () => HTMLElement | boolean | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open, details) => {
        if (busy) {
          details.cancel();
        } else if (!open) {
          onCancel();
        }
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              ($) => {
                return $.artifacts.deletion.title;
              },
              {
                title: target?.title ?? "",
              },
            )}
          </DialogTitle>
          <DialogDescription>
            {target?.kind === "shared-thread"
              ? t(($) => {
                  return $.artifacts.deletion.sharedDescription;
                })
              : target?.kind === "hosted-site" ||
                  target?.kind === "presentation"
                ? t(($) => {
                    return $.artifacts.deletion.hostedDescription;
                  })
                : t(($) => {
                    return $.artifacts.deletion.description;
                  })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            {t(($) => {
              return $.artifacts.deletion.cancel;
            })}
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy
              ? t(($) => {
                  return $.artifacts.deletion.deleting;
                })
              : t(($) => {
                  return $.artifacts.deletion.delete;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
