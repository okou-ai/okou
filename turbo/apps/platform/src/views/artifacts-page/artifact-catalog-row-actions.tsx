import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { artifactLibraryEnabled$ } from "../../signals/artifacts-page/artifact-catalog-instance.ts";
import { ArtifactFavoriteMenuItem } from "./artifact-favorite.tsx";
import { artifactCatalogRowDeletionScope } from "../../signals/artifacts-page/artifact-catalog-row-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ArtifactDeleteDialog,
  ArtifactDeleteMoreMenu,
} from "../okou-page/artifact-deletion.tsx";

/** Row favorites are independent of the owner-only Delete read. */
export function ArtifactCatalogRowActions({
  artifactId,
}: {
  readonly artifactId: string;
}) {
  const scope = artifactCatalogRowDeletionScope;
  const libraryEnabled = useLastResolved(artifactLibraryEnabled$);
  const pageSignal = useGet(pageSignal$);
  const session = useGet(scope.session$);
  const detail = useLoadable(scope.detail$);
  const triggerRef = useSet(scope.menuTriggerRef$);
  const menuOpenChanged = useSet(scope.menuOpenChanged$);
  const requestDeletion = useSet(scope.requestFromMenu$);
  const active = session?.artifactId === artifactId;

  return (
    <ArtifactDeleteMoreMenu
      triggerRef={triggerRef}
      disabled={!active || detail.state !== "hasData" || !detail.data}
      loading={active && detail.state === "loading"}
      onOpenChange={(open, details) => {
        menuOpenChanged(
          artifactId,
          {
            open,
            trigger: details.trigger,
            selectingDelete:
              details.reason === "item-press" &&
              details.event.target instanceof Element &&
              details.event.target.closest("[data-artifact-delete]") !== null,
          },
          pageSignal,
        );
      }}
      onDelete={() => {
        detach(
          requestDeletion(artifactId, pageSignal),
          Reason.DomCallback,
          "confirm catalog row deletion",
        );
      }}
    >
      {libraryEnabled && (
        <ArtifactFavoriteMenuItem artifactId={artifactId} catalogRow />
      )}
    </ArtifactDeleteMoreMenu>
  );
}

/** A confirmation stays mounted while the catalog refreshes or changes pages. */
export function ArtifactCatalogRowDeleteDialog() {
  const session = useGet(artifactCatalogRowDeletionScope.session$);
  return session ? (
    <ArtifactDeleteDialog session={session} origin={{ kind: "catalog-row" }} />
  ) : null;
}
