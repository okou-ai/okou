import { Button, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { ArrowUpRight, Info, Maximize2, Minimize2, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { BRAND_NAME } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  copySharedArtifactLink$,
  type SharedArtifactPreview,
  type SharedArtifactViewerSignals,
} from "../../signals/shared-artifact-page.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { ArtifactPreviewBody } from "../okou-page/attachment-chips.tsx";
import {
  ArtifactActionSeparator,
  ArtifactDownloadMenu,
} from "../okou-page/artifact-actions.tsx";
import { artifactFallbackSubtitle } from "../okou-page/artifact-display.ts";

function ArtifactDetails({ artifact }: { artifact: SharedArtifactPreview }) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.viewer.fileDetails;
  });
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            showTooltip
            aria-label={label}
          />
        }
      >
        <Info size={18} />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} aria-label={label}>
        <h2 className="mb-4 text-sm font-medium">{label}</h2>
        <dl className="space-y-4 text-xs">
          <div className="space-y-1">
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.artifacts.viewer.filename;
              })}
            </dt>
            <dd className="break-words">{artifact.filename}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.artifacts.viewer.fileType;
              })}
            </dt>
            <dd className="break-words">{artifact.contentType}</dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function ArtifactViewerActions({
  artifact,
  viewer,
}: {
  artifact: SharedArtifactPreview;
  viewer: SharedArtifactViewerSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const copyLink = useSet(copySharedArtifactLink$);
  const fullscreen = useGet(viewer.fullscreen$);
  const fullscreenAvailable = useGet(viewer.fullscreenAvailable$);
  const toggleFullscreen = useSet(viewer.toggleFullscreen$);
  const continueUrl = new URL("/", window.location.origin);
  continueUrl.searchParams.set(
    "prompt",
    t(
      ($) => {
        return $.artifacts.viewer.continuePrompt;
      },
      { url: artifact.preview.url },
    ),
  );
  const continueLabel = t(
    ($) => {
      return $.artifacts.viewer.continueWithBrand;
    },
    { brandName: BRAND_NAME },
  );
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        showTooltip
        aria-label={t(($) => {
          return $.artifacts.actions.share;
        })}
        onClick={() => {
          detach(
            copyLink(pageSignal),
            Reason.DomCallback,
            "copy artifact link",
          );
        }}
      >
        <Share2 size={18} />
      </Button>
      <ArtifactDownloadMenu
        filename={artifact.filename}
        url={artifact.preview.url}
        iconSize={18}
        showGoogleDriveAction={false}
      />
      <ArtifactActionSeparator />
      <ArtifactDetails artifact={artifact} />
      {fullscreenAvailable && (
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          className="hidden sm:inline-flex"
          showTooltip
          aria-label={t(($) => {
            return fullscreen
              ? $.artifacts.actions.exitFullscreen
              : $.artifacts.actions.enterFullscreen;
          })}
          onClick={() => {
            detach(
              toggleFullscreen(pageSignal),
              Reason.DomCallback,
              "toggle artifact fullscreen",
            );
          }}
        >
          {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </Button>
      )}
      <span className="hidden sm:contents">
        <ArtifactActionSeparator />
      </span>
      <Button
        size="sm"
        asChild
        showTooltip
        aria-label={continueLabel}
        className="ml-1 h-8 w-8 bg-foreground p-0 text-background hover:bg-foreground-hover sm:ml-2 sm:w-auto sm:px-3"
      >
        <a href={continueUrl.href}>
          <span className="hidden sm:inline">{continueLabel}</span>
          <ArrowUpRight size={18} className="sm:hidden" aria-hidden />
        </a>
      </Button>
    </div>
  );
}

export function SharedArtifactPage({
  artifact,
  viewer,
}: {
  artifact: SharedArtifactPreview | null;
  viewer: SharedArtifactViewerSignals;
}) {
  const { t } = useTranslation();
  const mountRef = useSet(viewer.mountRef$);
  const fullscreen = useGet(viewer.fullscreen$);
  const title =
    artifact?.filename ??
    t(($) => {
      return $.artifacts.title;
    });
  return (
    <div
      ref={mountRef}
      className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="relative z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background px-3 sm:gap-4 sm:px-6">
        <a
          href="/"
          aria-label={BRAND_NAME}
          className="shrink-0 text-foreground hover:opacity-70"
        >
          <ProductBrandMark size="small" />
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium" title={title}>
            {title}
          </h1>
          {artifact !== null && (
            <p className="truncate text-xs text-muted-foreground">
              {artifactFallbackSubtitle(
                artifact.preview.kind,
                artifact.filename,
              )}
            </p>
          )}
        </div>
        {artifact !== null && (
          <ArtifactViewerActions artifact={artifact} viewer={viewer} />
        )}
      </header>
      <main className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
        {artifact !== null ? (
          <ArtifactPreviewBody
            artifact={undefined}
            fullscreen={fullscreen}
            imageCanvasSignals={viewer.imageCanvas}
            preview={artifact.preview}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            <p>
              {t(($) => {
                return $.artifacts.sharing.unavailable;
              })}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
