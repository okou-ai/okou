import {
  Button,
  Card,
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
  ArrowRightLeft,
  ArrowUpRight,
  LockKeyhole,
  LogIn,
  Maximize2,
  Minimize2,
  Share2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentUserInfo$ } from "../../signals/auth.ts";
import { openClerkAddAccount$ } from "../../signals/clerk-add-account.ts";
import { BRAND_NAME } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { shellDocumentAttributesRef$ } from "../../signals/theme.ts";
import {
  signInToSharedArtifact$,
  type SharedArtifactPreview,
  type SharedArtifactViewerSignals,
} from "../../signals/shared-artifact-page.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { PublicArtifactLightbox } from "../components/public-artifact-lightbox.tsx";
import { ArtifactPreviewBody } from "../okou-page/attachment-chips.tsx";
import {
  ArtifactActionSeparator,
  ArtifactDownloadMenu,
} from "../okou-page/artifact-actions.tsx";
import { ArtifactShareMenu } from "../okou-page/artifact-share-menu.tsx";
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
        url={artifact.publicUrl ?? artifact.preview.url}
        iconSize={18}
        showGoogleDriveAction={false}
      />
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
      <TooltipProvider delayDuration={200}>
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

function ArtifactAccessPage() {
  const { t } = useTranslation();
  const user = useLastResolved(currentUserInfo$);
  const email = user?.primaryEmailAddress?.emailAddress;
  const pageSignal = useGet(pageSignal$);
  const [accessLoadable, openAccess] = useLoadableSet(
    user ? openClerkAddAccount$ : signInToSharedArtifact$,
  );
  return (
    // `gray-50` is the dark theme's page background, so using the primitive
    // directly left the card and its surround within eight points of each
    // other. The semantic pair is the one the ramp designs a step between:
    // `card` sits above `background` in dark, and `muted` sits above `card`.
    <div className="flex min-h-full items-center justify-center bg-background px-5 py-10 sm:px-8">
      <Card className="w-full max-w-[480px] rounded-3xl">
        <div className="px-6 pb-8 pt-9 text-center sm:px-9 sm:pt-10">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <LockKeyhole size={24} strokeWidth={1.5} aria-hidden />
          </div>
          <h2 className="mt-6 text-2xl font-semibold leading-8 tracking-tight text-foreground">
            {t(($) => {
              return $.artifacts.access.title;
            })}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {user
              ? t(($) => {
                  return $.artifacts.access.signedInDescription;
                })
              : t(($) => {
                  return $.artifacts.access.description;
                })}
            <br />
            {t(($) => {
              return $.artifacts.access.help;
            })}
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            {/* The API answers every denial with one status so artifacts cannot
                be enumerated, so a signed-in visitor's next step is a guess.
                Only offer a primary action when it is known to help. */}
            <Button
              type="button"
              variant={user ? "outline" : "default"}
              disabled={accessLoadable.state === "loading"}
              aria-busy={accessLoadable.state === "loading"}
              onClick={() => {
                detach(
                  openAccess(window.location.href, pageSignal),
                  Reason.DomCallback,
                );
              }}
            >
              {user ? <ArrowRightLeft aria-hidden /> : <LogIn aria-hidden />}
              {user
                ? t(($) => {
                    return $.artifacts.access.switchAccount;
                  })
                : t(($) => {
                    return $.artifacts.access.signIn;
                  })}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                window.location.reload();
              }}
            >
              {t(($) => {
                return $.artifacts.access.tryAgain;
              })}
            </Button>
          </div>
          {accessLoadable.state === "hasError" && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {user
                ? t(($) => {
                    return $.artifacts.access.switchAccountFailed;
                  })
                : t(($) => {
                    return $.artifacts.access.signInFailed;
                  })}
            </p>
          )}
        </div>
        {email && (
          <div className="border-t border-border/70 px-6 py-4 text-center text-xs leading-5 text-muted-foreground">
            <p className="break-words">
              {t(
                ($) => {
                  return $.artifacts.access.signedInAs;
                },
                { email },
              )}
            </p>
          </div>
        )}
      </Card>
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
  const mountRef = useSet(shellDocumentAttributesRef$);
  const fullscreen = useGet(viewer.fullscreen.fullscreen$);
  const containerRef = useSet(viewer.fullscreen.containerRef$);
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
    <div
      ref={mountRef}
      className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <header
        hidden={fullscreen}
        className={cn(
          "relative z-10 h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background px-3 sm:gap-4 sm:px-6",
          fullscreen ? "hidden" : "flex",
        )}
      >
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
              <ArtifactVisibilityLabel artifact={artifact} />
            </p>
          )}
        </div>
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
      </header>
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
          <ArtifactAccessPage />
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
      <PublicArtifactLightbox signals={viewer.diagram} />
    </div>
  );
}
