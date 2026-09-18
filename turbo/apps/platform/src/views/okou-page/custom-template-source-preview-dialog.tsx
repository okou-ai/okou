import { Loader2 } from "lucide-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import type {
  UserTemplateCatalogEntry,
  UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";

import { CustomTemplateDetailSidebar } from "./custom-template-detail-sidebar.tsx";
import { OfficeDocumentPreview } from "./office-document-preview.tsx";
import { isOfficeFilePreview } from "./office-file-preview.ts";
import {
  closeCustomTemplate$,
  openCustomTemplateDetail$,
  openCustomTemplateKind$,
} from "../../signals/okou-page/custom-template-library.ts";

/**
 * What a document template is, rendered.
 *
 * A document template carries no rendered pages, so the source file is the
 * only thing there is to look at — and the browser cannot draw a Word document
 * at all. Both branches therefore hand the file to a renderer that can: the
 * Office web viewer for the formats it covers, and the browser's own PDF
 * viewer for the rest.
 */
function CustomTemplateSourcePreview({
  detail,
}: {
  readonly detail: UserTemplateDetail | null;
}) {
  const { t } = useTranslation();
  if (detail === null) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }
  const title = t(
    ($) => {
      return $.artifacts.preview.dialogLabel;
    },
    { filename: detail.sourceFilename },
  );
  return isOfficeFilePreview(detail.sourceFilename) ? (
    <OfficeDocumentPreview
      resourceUrl={detail.sourceUrl}
      filename={detail.sourceFilename}
      focusKey={detail.id}
      focusOnMount={false}
      testId="custom-template-source-preview"
    />
  ) : (
    <iframe
      title={title}
      // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left rail,
      // so the embedded preview opens on the page rather than on a thumbnail
      // list of it.
      src={`${detail.sourceUrl}#navpanes=0`}
      scrolling="yes"
      className="block h-full w-full border-0 bg-background"
      data-testid="custom-template-source-preview"
    />
  );
}

/**
 * The surface a document template opens on.
 *
 * A dialog rather than the panel takeover a deck gets: a deck is read as a
 * column of page images, which the panel can scroll, while a document is read
 * inside someone else's viewer, which needs a viewport of its own to be worth
 * opening. The management column is the same one either surface shows, so what
 * a member can do to a template does not depend on which kind it is.
 */
export function CustomTemplateSourcePreviewDialog({
  onSelect,
}: {
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const openKind = useGet(openCustomTemplateKind$);
  // The detail shares the catalog's version, so every save invalidates it. Read
  // through the last settled answer: dropping to the spinner on a refresh would
  // take the editor away mid-save, and reload the viewer beside it on a rename
  // that changed neither the file nor the URL it is drawn from.
  const detailLoadable = useLastLoadable(openCustomTemplateDetail$);
  const close = useSet(closeCustomTemplate$);
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  return (
    <Dialog
      open={openKind === "document"}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        maxWidth={1120}
        height={760}
        contentClassName="flex flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-14 text-left sm:pr-16">
          <DialogTitle className="flex min-w-0 max-w-full items-center justify-start gap-1.5 text-left text-base leading-none">
            <button
              type="button"
              className="inline-flex shrink-0 items-center p-0 leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                close();
              }}
            >
              {t(($) => {
                return $.templates.detail.back;
              })}
            </button>
            <span className="shrink-0 text-muted-foreground">/</span>
            <span className="block min-w-0 truncate leading-none">
              {detail?.title ?? ""}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-muted/20 p-3 sm:p-5 lg:flex-row lg:overflow-hidden">
          <div className="relative min-h-80 flex-1 overflow-hidden rounded-lg border border-border bg-background">
            <CustomTemplateSourcePreview detail={detail} />
          </div>
          {detail === null ? null : (
            /* Keyed by the template, not by anything that changes while one is
               open: a save re-renders this subtree, and only arriving at a
               different template may hand the editor a fresh field. */
            <CustomTemplateDetailSidebar
              key={detail.id}
              detail={detail}
              onSelect={onSelect}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
