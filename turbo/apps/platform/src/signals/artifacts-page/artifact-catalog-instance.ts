import { createArtifactCatalogSidebarSignals } from "./artifact-catalog-sidebar.ts";
import { createArtifactCatalogSignals } from "./create-artifact-catalog-signals.ts";

/** The organization catalog and its preview share one page-owned instance. */
export const pageCatalog = createArtifactCatalogSignals();
export const artifactCatalogSidebar =
  createArtifactCatalogSidebarSignals(pageCatalog);
