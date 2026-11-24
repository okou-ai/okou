import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Button,
  DropdownMenuItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import { TEXT_TOAST_ACTION, toast } from "@okouai/ui/components/ui/sonner";
import { Loader2, RotateCcw, Star } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  artifactFavoriteIds$,
  artifactFavoriteDrafts$,
  artifactFavoritePendingIds$,
  reloadArtifactFavorites$,
  setArtifactFavorite$,
  setArtifactFavoriteFromRow$,
  undoArtifactFavorite$,
} from "../../signals/artifacts-page/artifact-favorites.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/** All favorite entry points share the model's optimistic IDs and pending set. */
function useArtifactFavorite(artifactId: string, catalogRow: boolean) {
  const { t } = useTranslation();
  const favorites = useLoadable(artifactFavoriteIds$);
  const drafts = useGet(artifactFavoriteDrafts$);
  const pendingIds = useGet(artifactFavoritePendingIds$);
  const pageSignal = useGet(pageSignal$);
  const reload = useSet(reloadArtifactFavorites$);
  const [operation, setFavorite] = useLoadableSet(setArtifactFavorite$);
  const [rowOperation, setFavoriteFromRow] = useLoadableSet(
    setArtifactFavoriteFromRow$,
  );
  const [undoOperation, undo] = useLoadableSet(undoArtifactFavorite$);
  const starred =
    drafts.get(artifactId) ??
    (favorites.state === "hasData"
      ? favorites.data.has(artifactId)
      : undefined);
  const pending = pendingIds.has(artifactId);
  const label =
    starred === undefined
      ? t(($) => {
          return $.artifacts.favorites.loading;
        })
      : starred
        ? t(($) => {
            return $.artifacts.favorites.unstar;
          })
        : t(($) => {
            return $.artifacts.favorites.star;
          });
  const toggle = (control: HTMLElement) => {
    if (starred === undefined || pending) {
      return;
    }
    detach(
      (async () => {
        const change = catalogRow
          ? await setFavoriteFromRow(artifactId, !starred, control, pageSignal)
          : await setFavorite(artifactId, !starred, pageSignal);
        pageSignal.throwIfAborted();
        if (change.status === "changed" && !change.starred) {
          toast.success(
            t(($) => {
              return $.artifacts.favorites.unstarred;
            }),
            {
              ...TEXT_TOAST_ACTION,
              action: {
                label: t(($) => {
                  return $.artifacts.favorites.undo;
                }),
                onClick: () => {
                  detach(
                    undo(artifactId, change.revision, pageSignal),
                    Reason.DomCallback,
                    "undo artifact favorite change",
                  );
                },
              },
            },
          );
        }
      })(),
      Reason.DomCallback,
      "change artifact favorite",
    );
  };
  return {
    favorites,
    starred,
    pending,
    label,
    toggle,
    reload,
    failed:
      operation.state === "hasError" ||
      rowOperation.state === "hasError" ||
      undoOperation.state === "hasError",
  };
}

function FavoriteIcon({
  starred,
  loading,
}: {
  readonly starred: boolean | undefined;
  readonly loading: boolean;
}) {
  return loading ? (
    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
  ) : (
    <Star
      size={16}
      aria-hidden="true"
      className={cn(
        starred
          ? "fill-[#FFA500] stroke-[#885600]"
          : "fill-none stroke-muted-foreground",
      )}
    />
  );
}

export function ArtifactFavoriteButton({
  artifactId,
  catalogRow = false,
}: {
  readonly artifactId: string;
  readonly catalogRow?: boolean;
}) {
  const { t } = useTranslation();
  const favorite = useArtifactFavorite(artifactId, catalogRow);
  if (
    favorite.favorites.state === "hasError" &&
    favorite.starred === undefined
  ) {
    return (
      <Button
        showTooltip
        type="button"
        variant="quiet"
        size="icon-sm"
        aria-label={t(($) => {
          return $.artifacts.favorites.retry;
        })}
        onClick={favorite.reload}
      >
        <RotateCcw size={16} aria-hidden="true" />
      </Button>
    );
  }
  return (
    <>
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="quiet"
                size="icon-sm"
                aria-label={favorite.label}
                aria-pressed={favorite.starred}
                aria-busy={favorite.starred === undefined || favorite.pending}
                disabled={favorite.starred === undefined}
                pending={favorite.pending}
                onClick={(event) => {
                  favorite.toggle(event.currentTarget);
                }}
              />
            }
          >
            <FavoriteIcon
              starred={favorite.starred}
              loading={favorite.starred === undefined}
            />
          </TooltipTrigger>
          <TooltipContent>{favorite.label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {favorite.failed && (
        <span role="status" className="sr-only">
          {t(($) => {
            return $.artifacts.favorites.changeError;
          })}
        </span>
      )}
    </>
  );
}

export function ArtifactFavoriteMenuItem({
  artifactId,
  catalogRow = false,
}: {
  readonly artifactId: string;
  readonly catalogRow?: boolean;
}) {
  const { t } = useTranslation();
  const favorite = useArtifactFavorite(artifactId, catalogRow);
  if (
    favorite.favorites.state === "hasError" &&
    favorite.starred === undefined
  ) {
    return (
      <DropdownMenuItem onClick={favorite.reload}>
        <RotateCcw size={16} aria-hidden="true" />
        {t(($) => {
          return $.artifacts.favorites.retry;
        })}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      disabled={favorite.starred === undefined || favorite.pending}
      aria-busy={favorite.starred === undefined || favorite.pending}
      onClick={(event) => {
        favorite.toggle(event.currentTarget);
      }}
    >
      <FavoriteIcon
        starred={favorite.starred}
        loading={favorite.starred === undefined || favorite.pending}
      />
      {favorite.label}
    </DropdownMenuItem>
  );
}

export function ArtifactFavoritesReadStatus() {
  const { t } = useTranslation();
  const favorites = useLoadable(artifactFavoriteIds$);
  const reload = useSet(reloadArtifactFavorites$);
  if (favorites.state !== "hasError") {
    return null;
  }
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
    >
      <p>
        {t(($) => {
          return $.artifacts.favorites.loadError;
        })}
      </p>
      <Button type="button" variant="neutral" size="sm" onClick={reload}>
        {t(($) => {
          return $.artifacts.favorites.retry;
        })}
      </Button>
    </div>
  );
}
