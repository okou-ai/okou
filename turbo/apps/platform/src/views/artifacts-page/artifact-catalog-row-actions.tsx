import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { DropdownMenuItem } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { MessagesSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { artifactCatalogRowDeletionScope } from "../../signals/artifacts-page/artifact-catalog-row-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  ArtifactFavoriteButton,
  ArtifactFavoriteMenuItem,
} from "../okou-page/artifact-favorite-menu-item.tsx";
import {
  ArtifactDeleteDialog,
  ArtifactDeleteMoreMenu,
} from "../okou-page/artifact-deletion.tsx";

/** More/Delete uses the summary already returned by the owner-scoped catalog. */
export function ArtifactCatalogRowActions({
  artifact,
  favoriteOnly = false,
}: {
  readonly artifact: ArtifactSummary & { readonly favorited?: boolean };
  readonly favoriteOnly?: boolean;
}) {
  const { t } = useTranslation();
  const scope = artifactCatalogRowDeletionScope;
  const pageSignal = useGet(pageSignal$);
  const triggerRef = useSet(scope.menuTriggerRef$);
  const menuOpenChanged = useSet(scope.menuOpenChanged$);
  const requestDeletion = useSet(scope.requestFromMenu$);
  const dismiss = useSet(scope.dismiss$);
  const source = favoriteOnly ? undefined : artifact.sourceChatThread;

  return (
    <div className="inline-flex items-center gap-1">
      {artifact.favorited !== undefined && (
        <ArtifactFavoriteButton
          artifactId={artifact.id}
          favorited={artifact.favorited}
        />
      )}
      <ArtifactDeleteMoreMenu
        triggerRef={triggerRef}
        onOpenChange={
          favoriteOnly
            ? undefined
            : (open, details) => {
                menuOpenChanged(
                  artifact.id,
                  {
                    open,
                    trigger: details.trigger,
                    selectingDelete: details.reason === "item-press",
                  },
                  pageSignal,
                );
              }
        }
        onDelete={
          favoriteOnly
            ? undefined
            : () => {
                requestDeletion(artifact, pageSignal);
              }
        }
      >
        {artifact.favorited !== undefined && (
          <ArtifactFavoriteMenuItem
            artifactId={artifact.id}
            favorited={artifact.favorited}
            onSelected={favoriteOnly ? undefined : dismiss}
          />
        )}
        {source && (
          <DropdownMenuItem
            nativeButton={false}
            render={<a href={`/chats/${encodeURIComponent(source.id)}`} />}
            className="max-w-72 sm:max-w-80"
            onClick={() => {
              dismiss();
            }}
          >
            <MessagesSquare aria-hidden="true" />
            <span className="truncate">
              {t(
                ($) => {
                  return $.artifacts.library.openSourceChat;
                },
                { title: source.title },
              )}
            </span>
          </DropdownMenuItem>
        )}
      </ArtifactDeleteMoreMenu>
    </div>
  );
}

/** A confirmation stays mounted while the catalog refreshes or changes pages. */
export function ArtifactCatalogRowDeleteDialog() {
  const session = useGet(artifactCatalogRowDeletionScope.session$);
  return session ? (
    <ArtifactDeleteDialog session={session} origin={{ kind: "catalog-row" }} />
  ) : null;
}
