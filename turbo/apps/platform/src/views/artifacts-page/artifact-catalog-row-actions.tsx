import { useGet, useLoadable, useSet } from "ccstate-react";
import { artifactCatalogRowDeletionScope } from "../../signals/artifacts-page/artifact-catalog-row-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ArtifactDeleteDialog,
  ArtifactDeleteMoreMenu,
} from "../okou-page/artifact-deletion.tsx";

/** More/Delete for a catalog row; owner detail loads only when its menu opens. */
export function ArtifactCatalogRowActions({
  artifactId,
}: {
  readonly artifactId: string;
}) {
  const scope = artifactCatalogRowDeletionScope;
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
            selectingDelete: details.reason === "item-press",
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
    />
  );
}

/** A confirmation stays mounted while the catalog refreshes or changes pages. */
export function ArtifactCatalogRowDeleteDialog() {
  const session = useGet(artifactCatalogRowDeletionScope.session$);
  return session ? (
    <ArtifactDeleteDialog session={session} origin={{ kind: "catalog-row" }} />
  ) : null;
}
