import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { createArtifactCatalogSidebarSignals } from "./artifact-catalog-sidebar.ts";
import { createArtifactCatalogSignals } from "./create-artifact-catalog-signals.ts";

export const artifactLibraryEnabled$ = computed(
  async (get): Promise<boolean> => {
    const switches = await get(featureSwitches$);
    return switches[FeatureSwitchKey.ArtifactLibrary] ?? false;
  },
);

/** The organization catalog and its preview share one page-owned instance. */
export const pageCatalog = createArtifactCatalogSignals(
  artifactLibraryEnabled$,
);
export const artifactCatalogSidebar =
  createArtifactCatalogSidebarSignals(pageCatalog);
