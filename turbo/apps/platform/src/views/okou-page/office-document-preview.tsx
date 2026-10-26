import { ExternalLink, Loader2 } from "lucide-react";
import { useLoadable, useSet } from "ccstate-react";
import type { Computed } from "ccstate";
import { useTranslation } from "react-i18next";
import { resolveOfficeDocumentViewerBaseUrl } from "../../lib/platform-host.ts";
import {
  documentPreviewRef$,
  wordDocumentFrameRef$,
} from "../../signals/document-preview.ts";
import { AutoFocusedArtifactIframe } from "./auto-focused-artifact-iframe.tsx";
import {
  isOpenXmlWordPreview,
  officeFilePreviewKind,
} from "./office-file-preview.ts";

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
  wordDocumentHtml$,
}: {
  resourceUrl: string | null;
  filename: string;
  focusKey: string;
  focusOnMount: boolean;
  testId: string;
  wordDocumentHtml$: Computed<Promise<string>>;
}) {
  const { t } = useTranslation();

  if (resourceUrl === null) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (officeFilePreviewKind(filename) === "document") {
    return (
      <WordDocumentPreview
        key={resourceUrl}
        resourceUrl={resourceUrl}
        filename={filename}
        testId={testId}
        html$={wordDocumentHtml$}
        focusKey={focusKey}
        focusOnMount={focusOnMount}
      />
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

function WordDocumentPreview({
  resourceUrl,
  filename,
  testId,
  html$,
  focusKey,
  focusOnMount,
}: {
  resourceUrl: string;
  filename: string;
  testId: string;
  html$: Computed<Promise<string>>;
  focusKey: string;
  focusOnMount: boolean;
}) {
  const { t } = useTranslation();
  const documentPreviewRef = useSet(documentPreviewRef$);
  const inline = isOpenXmlWordPreview(filename);
  return (
    <div
      ref={documentPreviewRef}
      className="flex h-full min-h-0 w-full touch-pan-x touch-pan-y flex-col overflow-hidden overscroll-contain"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <span>
          {t(($) => {
            return inline
              ? $.artifacts.preview.wordLayoutNotice
              : $.artifacts.preview.noInline;
          })}
        </span>
        <a
          href={officeDocumentViewerUrl(resourceUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-foreground underline underline-offset-2"
        >
          {t(($) => {
            return $.artifacts.actions.openNewTab;
          })}
          <ExternalLink size={12} aria-hidden />
        </a>
      </div>
      {inline && (
        <OwnedWordDocument
          filename={filename}
          testId={testId}
          html$={html$}
          focusKey={focusKey}
          focusOnMount={focusOnMount}
        />
      )}
    </div>
  );
}

function OwnedWordDocument({
  filename,
  testId,
  html$,
  focusKey,
  focusOnMount,
}: {
  filename: string;
  testId: string;
  html$: Computed<Promise<string>>;
  focusKey: string;
  focusOnMount: boolean;
}) {
  const { t } = useTranslation();
  const html = useLoadable(html$);
  const frameRef = useSet(wordDocumentFrameRef$);
  if (html.state === "hasError") {
    return (
      <p role="alert" className="p-6 text-center text-sm text-muted-foreground">
        {t(($) => {
          return $.artifacts.preview.genericUnavailable;
        })}
      </p>
    );
  }
  if (html.state === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }
  return (
    <AutoFocusedArtifactIframe
      onFrameRef={frameRef}
      focusKey={focusKey}
      focusOnMount={focusOnMount}
      srcDoc={html.data}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title={t(
        ($) => {
          return $.artifacts.preview.dialogLabel;
        },
        { filename },
      )}
      className="pointer-events-none block min-h-0 w-full flex-1 border-0 bg-background data-[preview-ready=true]:pointer-events-auto"
      data-testid={testId}
    />
  );
}
