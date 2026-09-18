import {
  Check,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  cn,
} from "@okouai/ui";
import type {
  UserTemplateCatalogEntry,
  UserTemplateVisibility,
} from "@okouai/api-contracts/contracts/user-templates";

import {
  CustomTemplateDetailSidebar,
  VISIBILITY_OPTIONS,
  VisibilityLabel,
} from "./custom-template-detail-sidebar.tsx";
import { CustomTemplateSourcePreviewDialog } from "./custom-template-source-preview-dialog.tsx";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import { TemplateEmptyPanel } from "./template-empty-panel.tsx";
import {
  closeCustomTemplate$,
  customTemplateSearchQuery$,
  customTemplateSurface,
  deleteCustomTemplate$,
  openCustomTemplate$,
  openCustomTemplateDetail$,
  openCustomTemplateId$,
  openCustomTemplateKind$,
  reloadCustomTemplates$,
  setCustomTemplateSearchQuery$,
  updateCustomTemplate$,
  visibleCustomTemplates$,
} from "../../signals/okou-page/custom-template-library.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  CUSTOM_TEMPLATE_IMPORT_ACCEPT,
  importPresentationTemplateDeck$,
} from "../../signals/okou-page/presentation-template-import.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/** The tile metrics the rest of the picker's grids already use. */
const CARD_MEDIA =
  "relative block aspect-video w-full overflow-hidden rounded-xl border border-border bg-muted";

/**
 * One meta line: who can see it — or, for a colleague's template, whose it is,
 * because a visibility the reader cannot change is not worth the row.
 *
 * It carries nothing else. Which file the template was compiled from and how
 * many pages it has describe the template rather than distinguish it, and a
 * grid is read by what tells its tiles apart; both are still answered by the
 * detail column, which is where they are asked for.
 */
function CustomTemplateMeta({
  template,
}: {
  readonly template: UserTemplateCatalogEntry;
}) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 text-xs text-muted-foreground">
      {template.canManage ? (
        <VisibilityLabel visibility={template.visibility} />
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <User size={13} className="shrink-0" aria-hidden />
          {t(
            ($) => {
              return $.templates.sharedBy;
            },
            { owner: template.ownerUserId },
          )}
        </span>
      )}
    </div>
  );
}

function CustomTemplateActions({
  template,
  onRename,
  onVisibilityChange,
  onDelete,
}: {
  readonly template: UserTemplateCatalogEntry;
  readonly onRename: () => void;
  readonly onVisibilityChange: (visibility: UserTemplateVisibility) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    // Revealed on hover like the picker's own tile controls, but kept visible
    // where hover does not exist and whenever it takes focus.
    <div className="absolute right-2 top-2 z-20 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100 [@media(hover:hover)]:has-[:focus-visible]:opacity-100">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            aria-label={t(
              ($) => {
                return $.templates.actions.menu;
              },
              { title: template.title },
            )}
            className="bg-background/90 hover:bg-background"
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={onRename}>
            {t(($) => {
              return $.templates.actions.rename;
            })}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex-1">
                {t(($) => {
                  return $.templates.visibility.change;
                })}
              </span>
              <ChevronRight size={14} />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              {VISIBILITY_OPTIONS.map((value) => {
                const selected = value === template.visibility;
                return (
                  <DropdownMenuItem
                    key={value}
                    onSelect={() => {
                      if (!selected) {
                        onVisibilityChange(value);
                      }
                    }}
                  >
                    <span className="flex-1">
                      <VisibilityLabel visibility={value} />
                    </span>
                    {selected ? <Check size={14} /> : null}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 />
            {t(($) => {
              return $.templates.actions.delete;
            })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function CustomTemplateCard({
  template,
  onSelect,
}: {
  readonly template: UserTemplateCatalogEntry;
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const openTemplate = useSet(openCustomTemplate$);
  const updateTemplate = useSet(updateCustomTemplate$);
  const deleteTemplate = useSet(deleteCustomTemplate$);
  const open = () => {
    openTemplate({ templateId: template.id, kind: template.kind });
  };
  return (
    <div className="group/tile flex min-w-0 flex-col">
      <div className="relative">
        <button
          type="button"
          className={cn(CARD_MEDIA, "cursor-pointer")}
          aria-label={t(
            ($) => {
              return $.templates.actions.preview;
            },
            { title: template.title },
          )}
          onClick={open}
        >
          {template.coverUrl ? (
            // Cropped from the top rather than the middle: a cover taller than
            // this tile is a page, and a page is recognised by its head.
            <img
              src={template.coverUrl}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover object-top"
            />
          ) : (
            // A template with no rendered cover is named by its file instead.
            // The icon says which format it was compiled from, which is the
            // one thing about it that a rendering would also have shown.
            //
            // Centred by a wrapper rather than by positioning the icon: the
            // icon carries `relative` of its own, which wins over an
            // `absolute` passed in from here and drops it half a tile low.
            <span className="absolute inset-0 flex items-center justify-center">
              <FilePreviewIcon filename={template.sourceFilename} size="lg" />
            </span>
          )}
          <span className="pointer-events-none absolute inset-x-0 bottom-0 z-[15] h-14 bg-gradient-to-t from-black/45 to-transparent opacity-0 transition-opacity group-hover/tile:opacity-100" />
        </button>
        {/* Beside the preview rather than inside it: the tile opens the
            template, and using it is a different decision from looking at
            it. Revealed on hover like the actions menu above, and kept
            reachable where hover does not exist. */}
        <div className="absolute bottom-2 right-2 z-20 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100 [@media(hover:hover)]:has-[:focus-visible]:opacity-100">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onSelect(template);
            }}
          >
            {t(($) => {
              return $.artifacts.templates.use;
            })}
          </Button>
        </div>
        {template.canManage ? (
          <CustomTemplateActions
            template={template}
            onRename={open}
            onVisibilityChange={(visibility) => {
              detach(
                updateTemplate(
                  { templateId: template.id, body: { visibility } },
                  pageSignal,
                ),
                Reason.DomCallback,
              );
            }}
            onDelete={() => {
              detach(
                deleteTemplate(template.id, pageSignal),
                Reason.DomCallback,
              );
            }}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1 px-0.5 pb-1 pt-2">
        <p
          className="min-w-0 truncate text-sm font-medium leading-5 text-foreground"
          title={template.title}
        >
          {template.title}
        </p>
        <CustomTemplateMeta template={template} />
      </div>
    </div>
  );
}

/**
 * The choice itself, shared by the two surfaces that offer it.
 *
 * One entry for every kind of template, not one per kind: the file the user
 * picked decides what it becomes, so the prompt that is sent — and with it the
 * command that publishes the result — follows the file rather than a choice
 * made before the analysis has read it. Keeping the input in one place is what
 * holds the tile and the empty catalog's drop zone to the same set of files.
 */
function CustomTemplateFileInput({
  signals,
  label,
}: {
  readonly signals: ComposerSignals;
  readonly label: string;
}) {
  const rootSignal = useGet(rootSignal$);
  const importDeck = useSet(importPresentationTemplateDeck$);
  return (
    <input
      type="file"
      className="sr-only"
      accept={CUSTOM_TEMPLATE_IMPORT_ACCEPT}
      aria-label={label}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        // Clear the input so choosing the same file again still fires.
        event.currentTarget.value = "";
        if (!file) {
          return;
        }
        detach(importDeck({ signals, file }, rootSignal), Reason.DomCallback);
      }}
    />
  );
}

/**
 * The upload entry a populated catalog leads its grid with.
 *
 * Rendering its own tile rather than reusing the composer's is deliberate: the
 * composer already imports this pane, so importing the tile back would close a
 * cycle.
 */
function CustomTemplateUploadCard({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.templates.importFile;
  });
  // What the entry produces, not which extensions it takes. This line sits
  // where every other tile carries its meta, so it is read down a column of
  // "who can see this"; the accept list read as prose was both a different
  // kind of line and longer than the tile, and it grew by one extension every
  // time the import learned a format. Which files are allowed stays enforced
  // by the input's `accept` and spelled out by `importUnsupported` when a
  // member reaches for one that is not.
  const hint = t(($) => {
    return $.artifacts.templates.importFileHint;
  });
  return (
    <label className="group/tile flex cursor-pointer flex-col gap-2">
      <span
        className={cn(
          CARD_MEDIA,
          "bg-muted/40 transition-colors duration-150 group-hover/tile:bg-muted/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring",
        )}
      >
        <Plus
          className="absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 text-muted-foreground transition-colors duration-150 group-hover/tile:text-foreground"
          strokeWidth={1.5}
          aria-hidden
        />
        <CustomTemplateFileInput signals={signals} label={label} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

/**
 * The upload entry an empty catalog leads with.
 *
 * A pane with nothing in it should hold one object, not two. The tile-sized
 * entry sitting under a card that only reported the catalog was empty gave the
 * eye two blocks and no obvious target, so the entry becomes the surface and
 * carries the line that card was carrying.
 */
function CustomTemplatesEmpty({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.templates.importFile;
  });
  return (
    // `border-2` is the weight a dashed drop target takes: at the shared
    // hairline a dashed edge reads as speckling rather than as a boundary.
    <label className="group/zone flex min-h-80 cursor-pointer flex-col items-center justify-center gap-3 rounded-[22px] border-2 border-dashed border-border bg-muted/40 px-6 py-10 text-center transition-colors duration-150 hover:bg-muted/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring">
      <Plus
        className="size-10 text-muted-foreground transition-colors duration-150 group-hover/zone:text-foreground"
        strokeWidth={1.5}
        aria-hidden
      />
      <span className="text-sm font-medium text-foreground">{label}</span>
      {/* The tile's caption is absent here on purpose: it says the entry
          reuses the file's design, which is the sentence below said short,
          and a zone with room for the whole sentence should not say it
          twice. */}
      <span className="max-w-md text-xs text-muted-foreground">
        {t(($) => {
          return $.templates.empty.description;
        })}
      </span>
      <CustomTemplateFileInput signals={signals} label={label} />
    </label>
  );
}

function CustomTemplatesLoadError() {
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
 * An open deck, which replaces the catalog until it is closed. Its pages are
 * images this panel can stack and scroll, so nothing is gained by lifting them
 * into a dialog of their own.
 */
function CustomTemplateDetail({
  onSelect,
}: {
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  // The detail shares the catalog's version, so every save invalidates it. Read
  // through the last settled answer: dropping to the skeleton on a refresh
  // would take the editor away mid-save, and with it the field the member is
  // waiting to get back. The first load still has no previous answer to show,
  // and a failed refresh still settles as an error.
  const detailLoadable = useLastLoadable(openCustomTemplateDetail$);
  const close = useSet(closeCustomTemplate$);
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="-ml-2 self-start"
        onClick={() => {
          close();
        }}
      >
        <ChevronLeft />
        {t(($) => {
          return $.templates.detail.back;
        })}
      </Button>
      {detailLoadable.state === "hasError" ? (
        <CustomTemplatesLoadError />
      ) : detail === null ? null : (
        <div className="flex flex-col gap-5 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
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
          {/* Keyed by the template, not by anything that changes while one is
              open: a save re-renders this subtree, and only arriving at a
              different template may hand the editor a fresh field. */}
          <CustomTemplateDetailSidebar
            key={detail.id}
            detail={detail}
            onSelect={onSelect}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The Custom panel of the template picker. It sits above the rule in the
 * category rail because it answers "who made it", while the seven below it
 * answer "what am I making".
 */
export function CustomTemplatePickerPane({
  signals,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const query = useGet(customTemplateSearchQuery$);
  const setQuery = useSet(setCustomTemplateSearchQuery$);
  const openTemplateId = useGet(openCustomTemplateId$);
  const openTemplateKind = useGet(openCustomTemplateKind$);
  const templatesLoadable = useLoadable(visibleCustomTemplates$);

  // A deck takes the panel over, because its pages are a column this panel can
  // scroll. Every other kind stays on the catalog and opens a dialog instead:
  // it is one file, read at a size of its own.
  if (
    openTemplateId !== null &&
    openTemplateKind !== null &&
    customTemplateSurface(openTemplateKind) === "panel"
  ) {
    return <CustomTemplateDetail onSelect={onSelect} />;
  }

  const hasQuery = query.trim().length > 0;
  const templates =
    templatesLoadable.state === "hasData" ? templatesLoadable.data : null;
  // A box for narrowing a catalog belongs to a catalog there is something to
  // narrow. It also waits for the catalog to resolve rather than assuming one:
  // showing it while the answer is still in flight would take it away again the
  // moment that answer turns out to be an empty catalog.
  const showSearch = templates !== null && (templates.length > 0 || hasQuery);

  const body =
    templatesLoadable.state === "hasError" ? (
      <CustomTemplatesLoadError />
    ) : templates === null ? null : templates.length === 0 ? (
      // A query that matches nothing is a different event from having no
      // templates at all, and the picker already ships the panel that says so.
      // Uploading cannot answer a failed search, so the drop zone only leads
      // the empty catalog.
      hasQuery ? (
        <TemplateEmptyPanel />
      ) : (
        <CustomTemplatesEmpty signals={signals} />
      )
    ) : (
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        <CustomTemplateUploadCard signals={signals} />
        {templates.map((template) => {
          return (
            <CustomTemplateCard
              key={template.id}
              template={template}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      {showSearch ? (
        <div className="relative w-56 shrink-0">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t(($) => {
              return $.artifacts.templates.searchConnectors;
            })}
            className="h-9 pl-9 text-sm"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder={t(($) => {
              return $.artifacts.templates.searchConnector;
            })}
          />
        </div>
      ) : null}
      {body}
      <CustomTemplateSourcePreviewDialog onSelect={onSelect} />
    </div>
  );
}
