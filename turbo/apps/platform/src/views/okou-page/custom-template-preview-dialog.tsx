import { Loader2 } from "lucide-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { LoadErrorRow } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import { Button } from "@okouai/ui/components/ui/button";
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

import {
  CustomTemplateDeleteButton,
  CustomTemplateDetailSidebar,
  CustomTemplateTitleInput,
} from "./custom-template-detail-sidebar.tsx";
import {
  TEMPLATE_DETAIL_BODY,
  TEMPLATE_DETAIL_FOOTER,
  TEMPLATE_DETAIL_GRID,
  TEMPLATE_DETAIL_STAGE,
  TemplateDetailFilmstrip,
  TemplateDetailSideColumn,
  TemplateDetailStageControls,
} from "./template-detail-layout.tsx";
import { OfficeDocumentPreview } from "./office-document-preview.tsx";
import { isOfficeFilePreview } from "./office-file-preview.ts";
import {
  closeCustomTemplate$,
  openCustomTemplateDetail$,
  openCustomTemplateKind$,
  openCustomTemplatePageIndex$,
  projectCustomTemplate$,
  reloadCustomTemplates$,
  selectCustomTemplatePage$,
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
    <LoadErrorRow
      message={t(($) => {
        return $.templates.loadFailed;
      })}
      retryLabel={t(($) => {
        return $.templates.retry;
      })}
      onRetry={() => {
        reload();
      }}
    />
  );
}

/**
 * A deck's pages, read the way every other deck detail reads: one page on the
 * stage, the rest in a filmstrip.
 *
 * Its own rendered pages rather than its source file through a viewer: they
 * are already ours to serve, and are the same slides a viewer would draw.
 * Contained rather than cropped, so a page that is not 16:9 is shown whole.
 */
function CustomTemplateGallery({
  title,
  pictures,
  pictureLabel,
}: {
  readonly title: string;
  readonly pictures: readonly string[];
  readonly pictureLabel: (index: number) => string;
}) {
  const { t } = useTranslation();
  const requestedIndex = useGet(openCustomTemplatePageIndex$);
  const selectPage = useSet(selectCustomTemplatePage$);
  const pageCount = pictures.length;
  const activeIndex = Math.max(0, Math.min(requestedIndex, pageCount - 1));
  const changePage = (index: number) => {
    selectPage(Math.max(0, Math.min(pageCount - 1, index)));
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "ArrowLeft" && activeIndex > 0) {
      event.preventDefault();
      changePage(activeIndex - 1);
    }
    if (event.key === "ArrowRight" && activeIndex < pageCount - 1) {
      event.preventDefault();
      changePage(activeIndex + 1);
    }
  };
  return (
    <>
      <div
        role="group"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.slidePreview;
          },
          { title },
        )}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={TEMPLATE_DETAIL_STAGE}
      >
        <img
          src={pictures[activeIndex]}
          alt={pictureLabel(activeIndex)}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />
        <TemplateDetailStageControls
          activeSlideIndex={activeIndex}
          slideCount={pageCount}
          onChange={changePage}
        />
      </div>
      <TemplateDetailFilmstrip
        slideCount={pageCount}
        activeSlideIndex={activeIndex}
        onChange={changePage}
        onKeyDown={handleKeyDown}
        renderThumbnail={(index) => {
          return (
            <img
              src={pictures[index]}
              alt=""
              loading="lazy"
              className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            />
          );
        }}
      />
    </>
  );
}

/**
 * A document, as the file it was compiled from.
 *
 * A document template renders no pages, so the source file is the only thing
 * there is to look at — and the browser cannot draw a Word document at all.
 * Word documents open in a separate viewer to isolate their zoom gestures;
 * PDF sources use the browser's own embedded viewer.
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
    <div className="relative min-h-80 min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-background">
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
          // thumbnail list of it; #toolbar=0 drops the viewer's own dark
          // toolbar, which otherwise sits inside our frame as a second header;
          // #view=FitH fits a page to the frame's width.
          src={`${detail.sourceUrl}#toolbar=0&navpanes=0&view=FitH`}
          scrolling="yes"
          className="block h-full w-full border-0 bg-background"
          data-testid="custom-template-source-preview"
        />
      )}
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
  const { t } = useTranslation();
  switch (detail.kind) {
    case "presentation": {
      return (
        <CustomTemplateGallery
          title={detail.title}
          pictures={detail.pageUrls}
          pictureLabel={(index) => {
            return t(
              ($) => {
                return $.templates.detail.page;
              },
              { number: index + 1 },
            );
          }}
        />
      );
    }
    case "document": {
      return <CustomTemplateSourcePreview detail={detail} />;
    }
    case "illustration": {
      // An image template is judged and used from its card, which already
      // carries its pictures and its menu; nothing opens one here.
      throw new Error("Image templates have no detail page");
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
  returnFocus,
}: {
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
  readonly returnFocus: (interactionType: string) => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const openKind = useGet(openCustomTemplateKind$);
  // Realtime refreshes also revalidate the detail. Retain its loaded preview
  // while the request runs, and apply confirmed metadata separately so saving
  // a name or visibility never has to wait for the viewer's readback.
  const detailLoadable = useLastLoadable(openCustomTemplateDetail$);
  const projectTemplate = useGet(projectCustomTemplate$);
  const close = useSet(closeCustomTemplate$);
  const detail =
    detailLoadable.state === "hasData" && detailLoadable.data !== null
      ? projectTemplate(detailLoadable.data)
      : null;
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
        finalFocus={returnFocus}
        aria-describedby={undefined}
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        maxWidth="6xl"
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
        <DialogHeader className="h-[68px] shrink-0 justify-center px-6 pr-14 text-left">
          <div className="flex min-w-0 max-w-full items-center gap-1.5">
            <DialogTitle
              className={cn(
                "flex items-center justify-start gap-1.5 text-left text-base leading-none",
                // Beside an editor the title holds only the way back, which
                // must never be squeezed; alone, it is what truncates.
                detail?.canManage ? "shrink-0" : "min-w-0",
              )}
            >
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
              {/* The heading that names the dialog stays text: where the name
                is editable, the editor sits beside the title, not inside it. */}
              <span
                className={
                  detail?.canManage
                    ? "sr-only"
                    : "block min-w-0 truncate leading-none"
                }
              >
                {detail?.title ?? ""}
              </span>
            </DialogTitle>
            {detail?.canManage ? (
              // Keyed by the template, not by anything that changes while one
              // is open: a save re-renders this subtree, and only arriving at a
              // different template may hand the editor a fresh field.
              <CustomTemplateTitleInput key={detail.id} detail={detail} />
            ) : null}
          </div>
        </DialogHeader>
        <div className={TEMPLATE_DETAIL_BODY}>
          {detailLoadable.state === "hasError" ? (
            <CustomTemplatesLoadError />
          ) : detail === null ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : detail.kind === "presentation" ? (
            <div className={TEMPLATE_DETAIL_GRID}>
              <CustomTemplatePreviewBody detail={detail} />
              <TemplateDetailSideColumn>
                <CustomTemplateDetailSidebar detail={detail} />
              </TemplateDetailSideColumn>
            </div>
          ) : (
            <div className="flex flex-col gap-6 lg:h-full lg:flex-row">
              <CustomTemplatePreviewBody detail={detail} />
              <div className="lg:w-[220px] lg:shrink-0">
                <CustomTemplateDetailSidebar detail={detail} />
              </div>
            </div>
          )}
        </div>
        {detail === null ? null : (
          <div className={TEMPLATE_DETAIL_FOOTER}>
            {detail.canManage ? (
              <CustomTemplateDeleteButton detail={detail} />
            ) : null}
            <Button
              type="button"
              size="lg"
              onClick={() => {
                onSelect(detail);
              }}
            >
              {t(($) => {
                return $.artifacts.templates.useThisTemplate;
              })}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
