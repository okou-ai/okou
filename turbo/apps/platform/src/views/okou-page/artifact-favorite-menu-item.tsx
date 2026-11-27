import { DropdownMenuItem, IconButton, cn } from "@okouai/ui";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2, Star, StarOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  artifactFavoritesEnabled$,
  changeArtifactFavorite$,
  type ArtifactFavoriteSession,
} from "../../signals/artifact-favorites.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function ArtifactFavoriteButton({
  artifactId,
  favorited,
}: {
  readonly artifactId: string;
  readonly favorited: boolean;
}) {
  const { t } = useTranslation();
  const enabled = useLoadable(artifactFavoritesEnabled$);
  const [operation, change] = useLoadableSet(changeArtifactFavorite$);
  const signal = useGet(pageSignal$);
  if (enabled.state !== "hasData" || !enabled.data) {
    return null;
  }
  const loading = operation.state === "loading";
  const Icon = loading ? Loader2 : Star;
  return (
    <IconButton
      showTooltip
      type="button"
      aria-label={t(($) => {
        return favorited
          ? $.artifacts.favorites.remove
          : $.artifacts.favorites.add;
      })}
      aria-pressed={favorited}
      disabled={loading}
      className={cn(
        "shrink-0 text-muted-foreground hover:text-foreground",
        !favorited &&
          "[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/artifact:opacity-100 group-focus-within/artifact:opacity-100",
      )}
      onClick={() => {
        detach(
          change(artifactId, !favorited, signal),
          Reason.DomCallback,
          "change artifact favorite",
        );
      }}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4",
          loading ? "animate-spin" : favorited && "fill-current",
        )}
      />
    </IconButton>
  );
}

export function ArtifactFavoriteMenuItem({
  artifactId,
  favorited,
  onSelected,
}: {
  readonly artifactId: string;
  readonly favorited: boolean;
  readonly onSelected?: () => void;
}) {
  const { t } = useTranslation();
  const enabled = useLoadable(artifactFavoritesEnabled$);
  const [operation, change] = useLoadableSet(changeArtifactFavorite$);
  const signal = useGet(pageSignal$);
  if (enabled.state !== "hasData" || !enabled.data) {
    return null;
  }
  const Icon =
    operation.state === "loading" ? Loader2 : favorited ? StarOff : Star;
  return (
    <DropdownMenuItem
      disabled={operation.state === "loading"}
      onClick={() => {
        onSelected?.();
        detach(
          change(artifactId, !favorited, signal),
          Reason.DomCallback,
          "change artifact favorite",
        );
      }}
    >
      <Icon
        className={operation.state === "loading" ? "animate-spin" : undefined}
      />
      {t(($) => {
        return favorited
          ? $.artifacts.favorites.remove
          : $.artifacts.favorites.add;
      })}
    </DropdownMenuItem>
  );
}

export function ArtifactPreviewFavoriteMenuItem({
  session,
}: {
  readonly session: ArtifactFavoriteSession;
}) {
  const { t } = useTranslation();
  const resolved = useLoadable(session.target$);
  const target = resolved.state === "hasData" ? resolved.data : null;
  const [operation, toggle] = useLoadableSet(session.toggle$);
  const signal = useGet(pageSignal$);
  if (!target) {
    return null;
  }
  const Icon =
    operation.state === "loading" ? Loader2 : target.favorited ? StarOff : Star;
  return (
    <DropdownMenuItem
      disabled={operation.state === "loading"}
      onClick={() => {
        detach(toggle(signal), Reason.DomCallback, "change preview favorite");
      }}
    >
      <Icon
        className={operation.state === "loading" ? "animate-spin" : undefined}
      />
      {t(($) => {
        return target.favorited
          ? $.artifacts.favorites.remove
          : $.artifacts.favorites.add;
      })}
    </DropdownMenuItem>
  );
}
