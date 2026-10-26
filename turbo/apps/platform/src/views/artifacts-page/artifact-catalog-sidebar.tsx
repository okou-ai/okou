import { useGet, useLoadable, useSet } from "ccstate-react";
import { Button } from "@okouai/ui";
import { Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  artifactCatalogSidebar,
  closeArtifactCatalogPreview$,
  reloadArtifactCatalog$,
} from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import { artifactDetailPreview } from "../../signals/artifacts-page/artifact-catalog-preview.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ArtifactSidebarContent } from "../okou-page/artifact-sidebar.tsx";
import { ArtifactDiagramLightbox } from "../components/artifact-diagram-lightbox.tsx";

export function ArtifactCatalogSidebar() {
  const { t } = useTranslation();
  const open = useGet(artifactCatalogSidebar.open$);
  const detail = useLoadable(artifactCatalogSidebar.detail$);
  const fullscreen = useGet(artifactCatalogSidebar.fullscreen$);
  const toggleFullscreen = useSet(artifactCatalogSidebar.toggleFullscreen$);
  const closePreview = useSet(closeArtifactCatalogPreview$);
  const reload = useSet(reloadArtifactCatalog$);
  const pageSignal = useGet(pageSignal$);
  const close = () => {
    closePreview(pageSignal);
  };
  if (!open) {
    return null;
  }
  if (
    detail.state !== "hasData" ||
    !detail.data ||
    detail.data.kind === "shared-thread"
  ) {
    return (
      <aside
        aria-label={t(($) => {
          return $.artifacts.sidebar.singularTitle;
        })}
        className="flex h-full w-full min-h-0 flex-col bg-background"
      >
        <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {t(($) => {
              return $.artifacts.sidebar.singularTitle;
            })}
          </span>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            onClick={close}
            aria-label={t(($) => {
              return $.artifacts.actions.closeArtifact;
            })}
          >
            <X size={16} />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {detail.state === "loading" ? (
            <Loader2 size={20} className="animate-spin" />
          ) : (
            t(($) => {
              return $.artifacts.sidebar.unavailable;
            })
          )}
        </div>
      </aside>
    );
  }
  const preview = artifactDetailPreview(detail.data);
  return (
    <>
      <ArtifactSidebarContent
        artifactRef={{
          url: preview.url,
          filename: preview.filename,
          kind: preview.kind,
          resourceUrl$: artifactCatalogSidebar.preview.resourceUrl$,
          shareUrl$: artifactCatalogSidebar.preview.shareUrl$,
        }}
        artifactKind={
          detail.data.kind === "presentation"
            ? "presentation-html"
            : detail.data.kind === "hosted-site"
              ? "hosted-site"
              : undefined
        }
        fullscreenState={{ active: fullscreen, toggle: toggleFullscreen }}
        imageCanvasSignals={artifactCatalogSidebar.imageCanvas}
        text$={artifactCatalogSidebar.preview.text$}
        markdownTree$={artifactCatalogSidebar.preview.markdownTree$}
        onClose={close}
        onSyncSuccess={reload}
      />
      <ArtifactDiagramLightbox signals={artifactCatalogSidebar.diagram} />
    </>
  );
}
