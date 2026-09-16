import { Button, Card } from "@okouai/ui";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  ArrowLeft,
  ArrowRightLeft,
  ArrowUpRight,
  LockKeyhole,
  Share2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentUserInfo$ } from "../../signals/auth.ts";
import { openClerkAddAccount$ } from "../../signals/clerk-add-account.ts";
import { BRAND_NAME } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { shellDocumentAttributesRef$ } from "../../signals/theme.ts";
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

function ArtifactViewerActions({
  artifact,
}: {
  artifact: SharedArtifactPreview;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const copyLink = useSet(copySharedArtifactLink$);
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
      <Button
        size="sm"
        asChild
        showTooltip
        aria-label={continueLabel}
        className="ml-1 h-8 w-8 p-0 sm:ml-2 sm:w-auto sm:px-3"
      >
        <a href={continueUrl.href}>
          <span className="hidden sm:inline">{continueLabel}</span>
          <ArrowUpRight size={18} className="sm:hidden" aria-hidden />
        </a>
      </Button>
    </div>
  );
}

function ArtifactAccessPage() {
  const { t } = useTranslation();
  const user = useLastResolved(currentUserInfo$);
  const email = user?.primaryEmailAddress?.emailAddress;
  const pageSignal = useGet(pageSignal$);
  const [switchLoadable, switchAccount] = useLoadableSet(openClerkAddAccount$);
  return (
    <div className="flex min-h-full items-center justify-center bg-gray-50 px-5 py-10 sm:px-8">
      <Card className="w-full max-w-[480px] rounded-3xl">
        <div className="px-6 pb-8 pt-9 text-center sm:px-9 sm:pt-10">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-gray-50 text-muted-foreground">
            <LockKeyhole size={24} strokeWidth={1.5} aria-hidden />
          </div>
          <h2 className="mt-6 text-2xl font-semibold leading-8 tracking-tight text-foreground">
            {t(($) => {
              return $.artifacts.access.title;
            })}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {t(($) => {
              return $.artifacts.access.description;
            })}
            <br />
            {t(($) => {
              return $.artifacts.access.help;
            })}
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              className="bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
              disabled={switchLoadable.state === "loading"}
              aria-busy={switchLoadable.state === "loading"}
              onClick={() => {
                detach(
                  switchAccount(window.location.href, pageSignal),
                  Reason.DomCallback,
                );
              }}
            >
              <ArrowRightLeft aria-hidden />
              {t(($) => {
                return $.artifacts.access.switchAccount;
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
          {switchLoadable.state === "hasError" && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {t(($) => {
                return $.artifacts.access.switchAccountFailed;
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
        {artifact !== null ? (
          <ArtifactViewerActions artifact={artifact} />
        ) : (
          <Button asChild variant="quiet" size="sm">
            <a href="/">
              <ArrowLeft aria-hidden />
              {t(
                ($) => {
                  return $.artifacts.access.backToBrand;
                },
                { brandName: BRAND_NAME },
              )}
            </a>
          </Button>
        )}
      </header>
      <main
        className={`relative min-h-0 flex-1 bg-muted/30 ${artifact === null ? "overflow-y-auto" : "overflow-hidden"}`}
      >
        {artifact !== null ? (
          <ArtifactPreviewBody
            artifact={undefined}
            fullscreen={false}
            imageCanvasSignals={viewer.imageCanvas}
            preview={artifact.preview}
          />
        ) : (
          <ArtifactAccessPage />
        )}
      </main>
    </div>
  );
}
