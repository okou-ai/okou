import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveOfficeDocumentViewerBaseUrl } from "../../lib/platform-host.ts";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";

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

  if (resourceUrl === null) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  // Private documents give the viewer only the expiring resource URL.
  // Historical public documents keep their existing viewer URL.
  // Office Online gives its full-size inner frame a one-pixel hover border.
  // Its box sizing differs between Word and PowerPoint, so bleed the iframe
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
