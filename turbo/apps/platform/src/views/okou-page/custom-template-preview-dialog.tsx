import { Loader2 } from "lucide-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
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
  reloadCustomTemplates$,
} from "../../signals/okou-page/custom-template-library.ts";

/**
 * What a catalog that would not load says, and how to ask again.
 *
 * Both the catalog and one open template can fail to load, and retrying either
 * is the same request. It lives here rather than beside the panel because the
 * panel already imports this module, and importing it back would close a
 * cycle.
 */
export function CustomTemplatesLoadError() {
  const { t } = useTranslation();
  const reload = useSet(reloadCustomTemplates$);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span role="alert">
        {t(($) => {
          return $.templates.loadFailed;
        })}
      </span>
      <Button
        type="button"
        variant="quiet"
        size="sm"
        onClick={() => {
          reload();
        }}
      >
        {t(($) => {
          return $.templates.retry;
        })}
      </Button>
    </div>
  );
}

/**
 * A deck, as the pages the reverse run rendered from it.
 *
 * Its own images rather than its source file through a viewer: the pages are
 * already rendered, already ours to serve, and are the same slides a viewer
 * would draw — without sending the file anywhere or waiting for someone else
 * to convert it.
 */
function CustomTemplatePages({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 lg:overflow-y-auto">
      {detail.pageUrls.map((pageUrl, index) => {
        return (
          <img
            key={pageUrl}
            src={pageUrl}
            alt={t(
              ($) => {
                return $.templates.detail.page;
              },
              { number: index + 1 },
            )}
            loading={index === 0 ? "eager" : "lazy"}
            className="w-full rounded-xl border border-border bg-muted object-cover"
          />
        );
      })}
    </div>
  );
}

/**
 * A document, as the file it was compiled from.
 *
 * A document template renders no pages, so the source file is the only thing
 * there is to look at — and the browser cannot draw a Word document at all.
 * Both branches therefore hand the file to a renderer that can: the Office web
 * viewer for the formats it covers, and the browser's own PDF viewer for the
 * rest.
 */
function CustomTemplateSourcePreview({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  const title = t(
    ($) => {
      return $.artifacts.preview.dialogLabel;
    },
    { filename: detail.sourceFilename },
  );
  return (
    <div className="relative min-h-80 flex-1 overflow-hidden rounded-lg border border-border bg-background">
      {isOfficeFilePreview(detail.sourceFilename) ? (
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
          // PDF Open Parameters: #navpanes=0 hides Chromium's built-in left
          // rail, so the embedded preview opens on the page rather than on a
          // thumbnail list of it.
          src={`${detail.sourceUrl}#navpanes=0`}
          scrolling="yes"
          className="block h-full w-full border-0 bg-background"
          data-testid="custom-template-source-preview"
        />
      )}
    </div>
  );
}

/**
 * An illustration, as the picture it was reversed from.
 *
 * Its source is already something a browser can draw, so nothing renders it
 * but an `img`. The branch is chosen by the row's kind rather than by the
 * filename: the kind is what decided at publish that this source had to be an
 * image, so reading it back is reading the same decision, while sniffing the
 * extension here would be a second rule that can disagree with it.
 */
function CustomTemplateIllustration({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  const title = t(
    ($) => {
      return $.artifacts.preview.dialogLabel;
    },
    { filename: detail.sourceFilename },
  );
  return (
    // `contain` rather than `cover`: a reference is judged by its whole frame —
    // how much of the sheet the art covers, where it sits, how wide the margin
    // is — and cropping to fill the dialog would take exactly those away. The
    // muted ground behind it is what gives a picture on white paper, or one
    // with a transparent corner, an edge to be seen against.
    <div className="flex min-h-80 flex-1 items-center justify-center overflow-auto rounded-lg border border-border bg-muted p-6">
      <img
        src={detail.sourceUrl}
        alt={title}
        className="max-h-full max-w-full object-contain"
        data-testid="custom-template-source-preview"
      />
    </div>
  );
}

/**
 * What an open template shows, which follows what it has.
 *
 * A deck ships rendered pages and the other kinds ship none, so each is drawn
 * from what it actually carries. Every kind answers for itself rather than one
 * being what the others fall through to, so a kind added to the catalog fails
 * this switch until someone says what looking at it means.
 */
function CustomTemplatePreviewBody({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  switch (detail.kind) {
    case "presentation": {
      return <CustomTemplatePages detail={detail} />;
    }
    case "document": {
      return <CustomTemplateSourcePreview detail={detail} />;
    }
    case "illustration": {
      return <CustomTemplateIllustration detail={detail} />;
    }
  }
}

/**
 * The one surface an open custom template gets, whatever kind it is.
 *
 * A dialog rather than a panel takeover, because a document is read inside
 * someone else's viewer and needs a viewport of its own. A deck follows it
 * there so that opening a template means the same thing either way: the same
 * frame, the same management column, and the same way back to the catalog
 * still listed behind it.
 */
export function CustomTemplatePreviewDialog({
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
      open={openKind !== null}
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
        {/* A fixed band rather than padding around the line: the close button
            is the shared one, pinned 16px down the popup and 36px tall, so its
            center sits at 34px whatever the header does. 68px is twice that,
            which puts the breadcrumb on the same axis — the height the
            imported-deck preview header already carries for the same reason.
            Padding alone left the title 10px above the button and the button
            itself hanging past the border below it. */}
        <DialogHeader className="h-[68px] shrink-0 justify-center border-b border-border px-5 pr-14 text-left sm:pr-16">
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
          {detailLoadable.state === "hasError" ? (
            <CustomTemplatesLoadError />
          ) : detail === null ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : (
            <>
              <CustomTemplatePreviewBody detail={detail} />
              {/* Keyed by the template, not by anything that changes while one
                  is open: a save re-renders this subtree, and only arriving at
                  a different template may hand the editor a fresh field. */}
              <CustomTemplateDetailSidebar
                key={detail.id}
                detail={detail}
                onSelect={onSelect}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
