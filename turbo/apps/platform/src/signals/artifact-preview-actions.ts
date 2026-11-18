import { computed } from "ccstate";
import { connectorCatalogItemBySlug } from "./external/connectors.ts";
import type { ChatThreadArtifactGoogleDriveRecovery } from "@okouai/api-contracts/contracts/chat-threads";

export function needsArtifactGoogleDriveCatalog(
  target:
    | {
        readonly accountReady: boolean;
        readonly recovery: ChatThreadArtifactGoogleDriveRecovery | undefined;
      }
    | undefined,
): boolean {
  return (
    !!target &&
    !target.accountReady &&
    (target.recovery?.action === "connect" ||
      target.recovery?.action === "reconnect")
  );
}

// One catalog subscription shared by the download menu's recovery actions.
export const artifactGoogleDriveCatalogItem$ =
  connectorCatalogItemBySlug("google-drive");
export const inactiveArtifactGoogleDriveCatalogItem$ = computed(() => {
  return null;
});

export const unresolvedArtifactPreviewAction$ = computed(() => {
  return undefined;
});
