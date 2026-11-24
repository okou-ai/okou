import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import { artifactRowCreationSource } from "../../signals/artifact-creation-source.ts";
import { ArtifactCreationSourceItem } from "../okou-page/artifact-creation-source.tsx";
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
  const switches = useLastResolved(featureSwitches$);

  return (
    <ArtifactDeleteMoreMenu
      triggerRef={triggerRef}
      disabled={!active || detail.state !== "hasData" || !detail.data}
      loading={active && detail.state === "loading"}
      creationSource={
        switches?.[FeatureSwitchKey.ArtifactLibrary] ? (
          <ArtifactCreationSourceItem
            artifactId={artifactId}
            scope={artifactRowCreationSource}
          />
        ) : undefined
      }
      onOpenChange={(open, details) => {
        // Base UI closes before the item's onClick. Only the actual Delete
        // item hands its session to the confirmation; links and Escape do not.
        const target = details.event.target;
        detach(
          menuOpenChanged(
            artifactId,
            {
              open,
              trigger: details.trigger,
              selectingDelete:
                details.reason === "item-press" &&
                target instanceof Element &&
                target.closest("[data-artifact-delete-action]") !== null,
            },
            pageSignal,
          ),
          Reason.DomCallback,
          "change catalog row menu",
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
