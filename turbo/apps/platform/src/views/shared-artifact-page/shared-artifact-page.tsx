import { ArtifactBanner } from "@okouai/ui/components/ui/artifact-banner";
import { parseArtifactReference } from "@okouai/api-contracts/validators/artifact-references";
import {
  PreserveScrollAnchor,
  Button,
  IconButton,
  cn,
  buttonVariants,
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
} from "@okouai/ui";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  ArrowLeft,
  ArrowUpRight,
  Maximize2,
  Minimize2,
  Share2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { BRAND_NAME } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { shellDocumentAttributesRef$ } from "../../signals/theme.ts";
import type {
  SharedArtifactPreview,
  SharedArtifactViewerSignals,
} from "../../signals/shared-artifact-page.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactAccessCard } from "../components/artifact-access-card.tsx";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { ArtifactDiagramLightbox } from "../components/artifact-diagram-lightbox.tsx";
import { ArtifactPreviewBody } from "../okou-page/attachment-chips.tsx";
import {
  ArtifactActionSeparator,
  ArtifactDownloadMenu,
} from "../okou-page/artifact-actions.tsx";
import { ArtifactShareMenu } from "../okou-page/artifact-share-menu.tsx";
import { ArtifactPageDeleteButton } from "../okou-page/artifact-deletion.tsx";
import {
  getArtifactShareScope,
  type ArtifactShareSession,
} from "../../signals/artifact-sharing.ts";
import {
  artifactFallbackSubtitle,
  artifactSupportsFullscreen,
} from "../okou-page/artifact-display.ts";
import { copyAttachmentLinkToClipboard } from "../okou-page/attachment-url.ts";

function ArtifactViewerActions({
  artifact,
  viewer,
}: {
  artifact: SharedArtifactPreview;
  viewer: SharedArtifactViewerSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const reference = parseArtifactReference(
    artifact.preview.url,
    location.origin,
  );
  const [enterLoadable, enterFullscreen] = useLoadableSet(
    viewer.fullscreen.enter$,
  );
  const enterButtonRef = useSet(viewer.fullscreen.enterButtonRef$);
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
      {artifact.publicUrl === null && !artifact.sharedThreadSnapshot ? (
        <ArtifactShareMenu
          surface="viewer"
          url={artifact.preview.url}
          copyUrl={window.location.href}
          iconSize={18}
        />
      ) : (
        <Button
          variant="quiet"
          size="icon-sm"
          showTooltip
          aria-label={t(($) => {
            return $.artifacts.actions.share;
          })}
          onClick={() => {
            detach(
              copyAttachmentLinkToClipboard(
                window.location.href,
                undefined,
                pageSignal,
              ),
              Reason.DomCallback,
            );
          }}
        >
          <Share2 size={18} />
        </Button>
      )}
      <ArtifactDownloadMenu
        filename={artifact.filename}
        url={artifact.preview.url}
        iconSize={18}
        showGoogleDriveAction={false}
      />
      {reference && !artifact.sharedThreadSnapshot && (
        <ArtifactPageDeleteButton
          artifactId={`${reference.hash}${reference.extension}`}
          sourceKind="reference"
        />
      )}
      {artifactSupportsFullscreen(artifact.preview.kind) && (
        <Button
          ref={enterButtonRef}
          variant="quiet"
          size="icon-sm"
          iconSize="md"
          showTooltip
          disabled={enterLoadable.state === "loading"}
          aria-label={t(($) => {
            return $.artifacts.actions.enterFullscreen;
          })}
          onClick={() => {
            detach(enterFullscreen(pageSignal), Reason.DomCallback);
          }}
        >
          <Maximize2 aria-hidden />
        </Button>
      )}
      <ArtifactActionSeparator />
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={continueUrl.href}
                aria-label={continueLabel}
                className={cn(
                  buttonVariants({ size: "sm" }),
                  "ml-1 h-8 w-8 p-0 sm:ml-2 sm:w-auto sm:px-3",
                )}
              >
                <span className="hidden sm:inline">{continueLabel}</span>
                <ArrowUpRight size={18} className="sm:hidden" aria-hidden />
              </a>
            }
          />
          <TooltipContent role="tooltip">
            <p className="text-xs">{continueLabel}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function ArtifactShareAudienceLabel({
  session,
}: {
  session: ArtifactShareSession;
}) {
  const { t } = useTranslation();
  const details = useLastResolved(session.details$);
  if (!details?.status) {
    return null;
  }
  return (
    <>
      {" · "}
      {details.audience === "public"
        ? t(($) => {
            return $.artifacts.sharing.publicAccess;
          })
        : details.audience === "organization"
          ? t(($) => {
              return $.artifacts.sharing.organization;
            })
          : t(($) => {
              return $.artifacts.sharing.onlyMe;
            })}
    </>
  );
}

/**
 * Who can reach this artifact is a standing fact about it, not something the
 * owner should have to open a menu to recall. A public reference says so by
 * itself; anything else is only known once the share read resolves, and an
 * unresolved read prints nothing rather than guessing an audience.
 */
function ArtifactVisibilityLabel({
  artifact,
}: {
  artifact: SharedArtifactPreview;
}) {
  const { t } = useTranslation();
  const session = useGet(getArtifactShareScope("viewer").session$);
  if (artifact.sharedThreadSnapshot) {
    return null;
  }
  if (artifact.publicUrl !== null) {
    return (
      <>
        {" · "}
        {t(($) => {
          return $.artifacts.sharing.publicAccess;
        })}
      </>
    );
  }
  return session ? <ArtifactShareAudienceLabel session={session} /> : null;
}

export function SharedArtifactPage({
  artifact,
  viewer,
}: {
  artifact: SharedArtifactPreview | null;
  viewer: SharedArtifactViewerSignals;
}) {
  const { t } = useTranslation();
  const mountRef = useSet(shellDocumentAttributesRef$);
  const mode = useGet(viewer.fullscreen.mode$);
  const fullscreen = mode !== "windowed";
  const containerRef = useSet(viewer.fullscreen.containerRef$);
  const container = useGet(viewer.fullscreen.container$);
  const exitButtonRef = useSet(viewer.fullscreen.exitButtonRef$);
  const exitFullscreen = useSet(viewer.fullscreen.exit$);
  const pageSignal = useGet(pageSignal$);
  const exitLabel = t(($) => {
    return $.artifacts.actions.exitFullscreen;
  });
  const title =
    artifact?.filename ??
    t(($) => {
      return $.artifacts.title;
    });
  return (
    <PreserveScrollAnchor
      layoutKey={fullscreen}
      anchor={
        artifact?.preview.kind === "markdown"
          ? {
              viewportSelector: '[data-testid="artifact-dialog-stage"]',
              anchorSelector: "h1, h2, h3, h4, h5, h6, p, pre, li, tr",
            }
          : undefined
      }
    >
      <div
        ref={mountRef}
        className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground"
      >
        <ArtifactBanner
          hidden={fullscreen}
          title={title}
          homeUrl="/"
          brandName={BRAND_NAME}
          brandMark={<ProductBrandMark size="small" />}
          subtitle={
            artifact !== null ? (
              <>
                {artifactFallbackSubtitle(
                  artifact.preview.kind,
                  artifact.filename,
                )}
                <ArtifactVisibilityLabel artifact={artifact} />
              </>
            ) : undefined
          }
        >
          {artifact !== null ? (
            <ArtifactViewerActions artifact={artifact} viewer={viewer} />
          ) : (
            <a
              href="/"
              className={buttonVariants({ variant: "quiet", size: "sm" })}
            >
              <ArrowLeft aria-hidden />
              {t(
                ($) => {
                  return $.artifacts.access.backToBrand;
                },
                { brandName: BRAND_NAME },
              )}
            </a>
          )}
        </ArtifactBanner>
        <main
          ref={containerRef}
          // This element is the one handed to requestFullscreen, so it paints
          // over the browser's black backdrop with nothing behind it. A
          // translucent surface would let that backdrop through as an
          // undefined grey, so fullscreen takes the opaque surface instead.
          className={cn(
            "relative min-h-0 flex-1",
            fullscreen ? "bg-muted" : "bg-muted/30",
            artifact === null ? "overflow-y-auto" : "overflow-hidden",
          )}
        >
          {artifact !== null ? (
            <ArtifactPreviewBody
              artifact={undefined}
              // Escape leaves fullscreen through a document listener, which a
              // cross-origin frame would swallow, so the frame keeps the focus
              // it took on mount instead of claiming it again on the switch.
              focusHtmlOnMount={!fullscreen}
              fullscreen={fullscreen}
              imageCanvasSignals={viewer.imageCanvas}
              preview={artifact.preview}
            />
          ) : (
            <ArtifactAccessCard />
          )}
          {artifact !== null && fullscreen && (
            <IconButton
              ref={exitButtonRef}
              aria-label={exitLabel}
              aria-keyshortcuts="Escape"
              className="absolute right-6 top-6 z-20 size-11 border border-border/70 bg-background/90 text-foreground opacity-40 backdrop-blur-sm transition-none hover:opacity-100 focus-visible:opacity-100 active:opacity-100 motion-safe:transition-opacity motion-safe:duration-200 motion-safe:ease-out sm:size-9"
              onClick={() => {
                detach(exitFullscreen(pageSignal), Reason.DomCallback);
              }}
            >
              <Minimize2 size={18} aria-hidden />
            </IconButton>
          )}
        </main>
        <ArtifactDiagramLightbox
          signals={viewer.diagram}
          portalContainer={container}
        />
      </div>
    </PreserveScrollAnchor>
  );
}
