import { ExternalLink, FileText, Loader2 } from "lucide-react";
import { buttonVariants } from "@okouai/ui";
import { useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { resolveOfficeDocumentViewerBaseUrl } from "../../lib/platform-host.ts";
import { documentPreviewRef$ } from "../../signals/document-preview.ts";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";
import { officeFilePreviewKind } from "./office-file-preview.ts";

function officeDocumentViewerUrl(sourceUrl: string): string {
  const viewerUrl = new URL(resolveOfficeDocumentViewerBaseUrl());
  viewerUrl.searchParams.set("src", sourceUrl);
  return viewerUrl.toString();
}

export function OfficeDocumentPreview({
  resourceUrl,
  filename,
  focusKey,
  focusOnMount,
  testId,
}: {
  resourceUrl: string | null;
  filename: string;
  focusKey: string;
  focusOnMount: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  const documentPreviewRef = useSet(documentPreviewRef$);

  if (resourceUrl === null) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (officeFilePreviewKind(filename) === "document") {
    // Native zoom input inside Microsoft's cross-origin Word frame never
    // reaches our document listeners. Give that viewer its own browsing
    // context so its zoom cannot resize the surrounding application.
    return (
      <div
        ref={documentPreviewRef}
        className="flex h-full min-h-0 w-full touch-pan-x touch-pan-y flex-col items-center justify-center gap-4 overflow-hidden overscroll-contain p-6 text-center"
        data-testid={testId}
      >
        <FileText
          size={32}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <p className="max-w-full truncate text-sm font-medium" title={filename}>
          {filename}
        </p>
        <a
          href={officeDocumentViewerUrl(resourceUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "outline" })}
        >
          {t(($) => {
            return $.artifacts.actions.openNewTab;
          })}
          <ExternalLink size={16} aria-hidden />
        </a>
      </div>
    );
  }

  // Private documents give the viewer only the expiring resource URL.
  // Historical public documents keep their existing viewer URL.
  // Office Online gives its full-size inner frame a one-pixel hover border.
  // Its box sizing differs between Office viewers, so bleed the iframe
  // one pixel past every edge and clip the viewer-owned border without
  // blocking interaction with the cross-origin document.
  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      <AutoFocusedArtifactIframe
        focusKey={focusKey}
        focusOnMount={focusOnMount}
        src={officeDocumentViewerUrl(resourceUrl)}
        title={t(
          ($) => {
            return $.artifacts.preview.dialogLabel;
          },
          { filename },
        )}
        referrerPolicy="no-referrer"
        scrolling="yes"
        allowFullScreen
        className="absolute -left-px -top-px block h-[calc(100%+2px)] min-h-0 w-[calc(100%+2px)] border-0 bg-background"
        data-testid={testId}
      />
    </div>
  );
}
