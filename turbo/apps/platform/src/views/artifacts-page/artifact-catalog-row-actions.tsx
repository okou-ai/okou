import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { useGet, useSet } from "ccstate-react";
import { artifactCatalogRowDeletionScope } from "../../signals/artifacts-page/artifact-catalog-row-actions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  ArtifactDeleteDialog,
  ArtifactDeleteMoreMenu,
} from "../okou-page/artifact-deletion.tsx";

/** More/Delete uses the summary already returned by the owner-scoped catalog. */
export function ArtifactCatalogRowActions({
  artifact,
}: {
  readonly artifact: ArtifactSummary;
}) {
  const scope = artifactCatalogRowDeletionScope;
  const pageSignal = useGet(pageSignal$);
  const triggerRef = useSet(scope.menuTriggerRef$);
  const menuOpenChanged = useSet(scope.menuOpenChanged$);
  const requestDeletion = useSet(scope.requestFromMenu$);

  return (
    <ArtifactDeleteMoreMenu
      triggerRef={triggerRef}
      onOpenChange={(open, details) => {
        menuOpenChanged(
          artifact.id,
          {
            open,
            trigger: details.trigger,
            selectingDelete: details.reason === "item-press",
          },
          pageSignal,
        );
      }}
      onDelete={() => {
        requestDeletion(artifact, pageSignal);
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
