import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import type { ComponentProps, ReactNode, Ref } from "react";
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
  emptyArtifactDeletionDetail$,
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
import {
  artifactFavoriteScope,
  artifactFavoritesEnabled$,
  emptyArtifactFavoriteTarget$,
} from "../../signals/artifact-favorites.ts";
import { ArtifactPreviewFavoriteMenuItem } from "./artifact-favorite-menu-item.tsx";

export function ArtifactDeleteMoreMenu({
  triggerRef,
  onDelete,
  onOpenChange,
  iconSize = 16,
  children,
}: {
  readonly triggerRef?: Ref<HTMLButtonElement>;
  readonly onDelete?: () => void;
  readonly onOpenChange?: ComponentProps<typeof DropdownMenu>["onOpenChange"];
  readonly iconSize?: number;
  readonly children?: ReactNode;
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
        {children}
        {onDelete && (
          <DropdownMenuItem className="text-destructive" onClick={onDelete}>
            <Trash2 size={14} />
            {t(($) => {
              return $.artifacts.deletion.delete;
            })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ArtifactPageDeleteButton({
  artifactId,
  sourceKind,
  favoriteUrl,
}: {
  readonly artifactId: string;
  readonly sourceKind: ArtifactDeletionSourceKind;
  readonly favoriteUrl?: string;
}) {
  return (
    <ArtifactDeleteButton
      artifactId={artifactId}
      sourceKind={sourceKind}
      favoriteUrl={favoriteUrl}
      origin={{ kind: "artifact-page" }}
      iconSize={18}
    />
  );
}

function usePreviewFavorite(
  surface: "dialog" | "sidebar" | "page",
  artifactId: string | undefined,
  favoriteUrl: string | undefined,
) {
  const candidate = useGet(artifactFavoriteScope(surface).session$);
  const matchesFavorite =
    candidate &&
    ("artifactId" in candidate.source
      ? candidate.source.artifactId === artifactId
      : candidate.source.url === favoriteUrl);
  const favoritesEnabled = useLoadable(artifactFavoritesEnabled$);
  const favorite =
    favoritesEnabled.state === "hasData" &&
    favoritesEnabled.data &&
    matchesFavorite
      ? candidate
      : null;
  const target = useLoadable(favorite?.target$ ?? emptyArtifactFavoriteTarget$);
  return favorite && target.state === "hasData" && target.data
    ? favorite
    : null;
}

/** Favorites share the existing more menu; deletion stays owner-authorized. */
export function ArtifactDeleteButton({
  artifactId,
  sourceKind,
  favoriteUrl,
  origin,
  iconSize = 16,
  menu = false,
}: {
  readonly artifactId?: string;
  readonly sourceKind?: ArtifactDeletionSourceKind;
  readonly favoriteUrl?: string;
  /** The surface deleting the artifact; it decides what follows. */
  readonly origin: ArtifactDeletionOrigin;
  readonly iconSize?: number;
  readonly menu?: boolean;
}) {
  const { t } = useTranslation();
  const surface = artifactDeletionSurface(origin);
  const scope = artifactPreviewDeletionScope(surface);
  const session = useGet(scope.session$);
  const identity = useLastResolved(scope.identity$);
  const selected =
    session &&
    artifactId &&
    identity?.artifactId === artifactId &&
    identity.sourceKind === sourceKind
      ? session
      : null;
  const detail = useLastLoadable(
    selected?.detail$ ?? emptyArtifactDeletionDetail$,
  );
  const favorite = usePreviewFavorite(surface, artifactId, favoriteUrl);
  const canDelete = selected && detail.state === "hasData" && detail.data;
  const pageSignal = useGet(pageSignal$);
  const triggerRef = useSet(scope.menuTriggerRef$);
  const requestFromMenu = useSet(scope.requestFromMenu$);
  const requestDeletion = () => {
    detach(
      requestFromMenu(pageSignal),
      Reason.DomCallback,
      "confirm artifact deletion",
    );
  };
  if (!canDelete && !favorite) {
    return null;
  }
  return (
    <span className="inline-flex">
      {menu || favorite ? (
        <ArtifactDeleteMoreMenu
          triggerRef={triggerRef}
          iconSize={iconSize}
          onDelete={canDelete ? requestDeletion : undefined}
        >
          {favorite && <ArtifactPreviewFavoriteMenuItem session={favorite} />}
        </ArtifactDeleteMoreMenu>
      ) : (
        <Button
          ref={triggerRef}
          showTooltip
          type="button"
          variant="quiet"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t(($) => {
            return $.artifacts.deletion.delete;
          })}
          onClick={requestDeletion}
        >
          <Trash2 size={iconSize} />
        </Button>
      )}
      {selected && <ArtifactDeleteDialog session={selected} origin={origin} />}
    </span>
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
