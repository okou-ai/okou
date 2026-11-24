import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
  DropdownMenuTrigger,
} from "@okouai/ui";
import { Ellipsis, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  artifactPreviewDeletionScope,
  type ArtifactDeletionSession,
  type ArtifactDeletionSourceKind,
} from "../../signals/artifact-deletion.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  artifactDeletionSurface,
  closeArtifactDeletion$,
  confirmArtifactDeletion$,
  type ArtifactDeletionOrigin,
  type ArtifactDeletionConfirmationOrigin,
} from "../../signals/artifact-deletion-origin.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactActionTooltip } from "./artifact-actions.tsx";
import { artifactSidebarCreationSource } from "../../signals/artifact-creation-source.ts";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import { ArtifactCreationSourceItem } from "./artifact-creation-source.tsx";

export function ArtifactDeleteMoreMenu({
  triggerRef,
  onDelete,
  onOpenChange,
  disabled = false,
  loading = false,
  iconSize = 16,
  creationSource,
}: {
  readonly creationSource?: ReactNode;
  readonly triggerRef?: Ref<HTMLButtonElement>;
  readonly onDelete: () => void;
  readonly onOpenChange?: ComponentProps<typeof DropdownMenu>["onOpenChange"];
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly iconSize?: number;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.actions.more;
  });
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <ArtifactActionTooltip label={label}>
        <DropdownMenuTrigger
          ref={triggerRef}
          aria-label={label}
          render={
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              highlightWhenOpen
            />
          }
        >
          <Ellipsis size={iconSize} />
        </DropdownMenuTrigger>
      </ArtifactActionTooltip>
      <DropdownMenuContent align="end" sideOffset={6}>
        {creationSource}
        <DropdownMenuItem
          data-artifact-delete-action=""
          className="text-destructive"
          disabled={disabled}
          aria-busy={loading}
          onClick={onDelete}
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Trash2 size={14} />
          )}
          {t(($) => {
            return $.artifacts.deletion.delete;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PreviewArtifactDeleteMoreMenu({
  origin,
  iconSize,
  creationSourceId,
  disabled = false,
  loading = false,
}: {
  readonly origin: ArtifactDeletionOrigin;
  readonly iconSize: number;
  readonly creationSourceId?: string;
  readonly disabled?: boolean;
  readonly loading?: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const scope = artifactPreviewDeletionScope(artifactDeletionSurface(origin));
  const triggerRef = useSet(scope.menuTriggerRef$);
  const requestDeletion = useSet(scope.requestFromMenu$);
  const openSource = useSet(artifactSidebarCreationSource.open$);
  const closeSource = useSet(artifactSidebarCreationSource.close$);
  const sourceMenuRef = useSet(artifactSidebarCreationSource.menuRef$);
  const moreMenu = (
    <ArtifactDeleteMoreMenu
      triggerRef={triggerRef}
      iconSize={iconSize}
      disabled={disabled}
      loading={loading}
      creationSource={
        creationSourceId ? (
          <ArtifactCreationSourceItem
            artifactId={creationSourceId}
            scope={artifactSidebarCreationSource}
          />
        ) : undefined
      }
      onOpenChange={
        creationSourceId
          ? (open) => {
              if (open) {
                detach(
                  openSource(creationSourceId, pageSignal),
                  Reason.DomCallback,
                  "open catalog sidebar creation source",
                );
              } else {
                closeSource();
              }
            }
          : undefined
      }
      onDelete={() => {
        detach(
          requestDeletion(pageSignal),
          Reason.DomCallback,
          "confirm artifact deletion",
        );
      }}
    />
  );
  return creationSourceId ? (
    <span ref={sourceMenuRef} className="inline-flex">
      {moreMenu}
    </span>
  ) : (
    moreMenu
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

/** Owner-only Delete; catalog menus also resolve source independently. */
export function ArtifactDeleteButton({
  artifactId,
  sourceKind,
  origin,
  iconSize = 16,
  menu = false,
}: {
  readonly artifactId?: string;
  readonly sourceKind?: ArtifactDeletionSourceKind;
  /** The surface deleting the artifact; it decides what follows. */
  readonly origin: ArtifactDeletionOrigin;
  readonly iconSize?: number;
  readonly menu?: boolean;
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
            menu={menu}
          />
        )}
    </span>
  );
}

function PreviewArtifactDeleteButton({
  session,
  origin,
  iconSize,
  menu,
}: {
  readonly session: ArtifactDeletionSession;
  readonly origin: ArtifactDeletionOrigin;
  readonly iconSize: number;
  readonly menu: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const detail = useLastLoadable(session.detail$);
  const requestDeletion = useSet(session.request$);
  const switches = useLastResolved(featureSwitches$);
  const catalogSource =
    origin.kind === "catalog-sidebar" &&
    switches?.[FeatureSwitchKey.ArtifactLibrary] === true;
  const owned = detail.state === "hasData" && Boolean(detail.data);
  return (
    <>
      {(owned || (menu && catalogSource)) &&
        (menu ? (
          <PreviewArtifactDeleteMoreMenu
            origin={origin}
            iconSize={iconSize}
            creationSourceId={catalogSource ? session.artifactId : undefined}
            disabled={!owned}
            loading={detail.state === "loading"}
          />
        ) : (
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
        ))}
      <ArtifactDeleteDialog session={session} origin={origin} />
    </>
  );
}

export function ArtifactDeleteDialog({
  session,
  origin,
}: {
  readonly session: ArtifactDeletionSession;
  readonly origin: ArtifactDeletionConfirmationOrigin;
}) {
  const pageSignal = useGet(pageSignal$);
  const target = useGet(session.target$);
  const close = useSet(closeArtifactDeletion$);
  const finalFocus = useSet(session.finalFocus$);
  const [deletion, confirm] = useLoadableSet(confirmArtifactDeletion$);
  return (
    <ArtifactDeleteConfirmation
      target={target}
      busy={deletion.state === "loading"}
      finalFocus={finalFocus}
      onCancel={() => {
        close(origin, session);
      }}
      onConfirm={() => {
        detach(
          confirm(origin, session, pageSignal),
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
