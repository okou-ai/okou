import type { ReactNode } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  revealSelectedZipEntry$,
  type ZipArtifactPreviewScope,
  type ZipArtifactPreviewSignals,
} from "../../signals/zip-artifact-preview.ts";
import type { AttachmentLightboxState } from "../../signals/okou-page/attachment-chips.ts";
import type { Computed } from "ccstate";
import type { ZoomableImageCanvasSignals } from "../../signals/zoomable-image-canvas.ts";
import { ArtifactDiagramLightbox } from "../components/artifact-diagram-lightbox.tsx";
import { onDomEventFn } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

type EntryRenderer = (
  preview: AttachmentLightboxState,
  imageCanvas: ZoomableImageCanvasSignals,
) => ReactNode;

export function ZipArtifactPreview({
  scope,
  fallback,
  renderEntry,
}: {
  scope: ZipArtifactPreviewScope;
  fallback: ReactNode;
  renderEntry: EntryRenderer;
}) {
  const signals = useGet(scope.current$);
  const ref = useSet(scope.mountRef$);

  return (
    <div
      ref={ref}
      className="h-full min-h-0"
      data-testid="zip-artifact-preview"
    >
      {signals ? (
        <ZipContents
          signals={signals}
          fallback={fallback}
          renderEntry={renderEntry}
        />
      ) : (
        <ZipLoading />
      )}
    </div>
  );
}

function ZipContents({
  signals,
  fallback,
  renderEntry,
}: {
  signals: ZipArtifactPreviewSignals;
  fallback: ReactNode;
  renderEntry: EntryRenderer;
}) {
  const { t } = useTranslation();
  const entries = useLoadable(signals.entries$);
  const selected = useGet(signals.selection$);
  const select = useSet(signals.select$);
  const revealSelected = useSet(revealSelectedZipEntry$);
  const page = useGet(pageSignal$);
  if (entries.state === "loading") {
    return <ZipLoading />;
  }
  if (entries.state === "hasError" || entries.data.length === 0) {
    return fallback;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ul
        aria-label={t(($) => {
          return $.artifacts.catalog.filters.file;
        })}
        className={cn(
          "overflow-auto p-2",
          selected && "max-h-36 shrink-0 border-b border-border",
        )}
      >
        {entries.data.map((entry) => {
          return (
            <li key={entry.path}>
              {entry.preview ? (
                <button
                  type="button"
                  ref={
                    selected?.path === entry.path ? revealSelected : undefined
                  }
                  aria-pressed={selected?.path === entry.path}
                  className="w-full rounded-md px-2 py-1.5 text-start text-sm break-all hover:bg-state-hover aria-pressed:bg-muted"
                  onClick={onDomEventFn(() => {
                    return select(entry, page);
                  })}
                >
                  {entry.path}
                </button>
              ) : (
                <span className="block px-2 py-1.5 text-sm break-all text-muted-foreground">
                  {entry.path}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {selected && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ZipSelectedEntry
            key={selected.path}
            preview$={selected.preview$}
            signals={signals}
            renderEntry={renderEntry}
          />
        </div>
      )}
      <ArtifactDiagramLightbox signals={signals.diagram} />
    </div>
  );
}

function ZipSelectedEntry({
  preview$,
  signals,
  renderEntry,
}: {
  preview$: Computed<Promise<AttachmentLightboxState>>;
  signals: ZipArtifactPreviewSignals;
  renderEntry: EntryRenderer;
}) {
  const { t } = useTranslation();
  const loadable = useLoadable(preview$);
  if (loadable.state === "loading") {
    return <ZipLoading />;
  }
  if (loadable.state === "hasError") {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t(($) => {
          return $.artifacts.preview.genericUnavailable;
        })}
      </div>
    );
  }
  return renderEntry(loadable.data, signals.imageCanvas);
}

function ZipLoading() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.artifacts.catalog.loading;
      })}
      className="flex h-full items-center justify-center text-muted-foreground"
    >
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
}
