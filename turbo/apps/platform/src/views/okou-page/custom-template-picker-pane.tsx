import {
  Check,
  ChevronRight,
  MoreHorizontal,
  FileText,
  Image as ImageIcon,
  Layers,
  Lock,
  Presentation,
  Upload,
  Users,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import type {
  UserTemplateCatalogEntry,
  UserTemplateVisibility,
  UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";

import {
  SharedByLabel,
  VISIBILITY_OPTIONS,
  VisibilityLabel,
} from "./custom-template-detail-sidebar.tsx";
import {
  CustomTemplatePreviewDialog,
  CustomTemplatesLoadError,
} from "./custom-template-preview-dialog.tsx";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import {
  customTemplateSearchQuery$,
  customTemplateCatalog$,
  deleteCustomTemplate$,
  openCustomTemplate$,
  setCustomTemplateSearchQuery$,
  projectCustomTemplatePicker$,
  setCustomTemplateKindFilter$,
  updateCustomTemplate$,
} from "../../signals/okou-page/custom-template-library.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  CUSTOM_TEMPLATE_IMPORT_ACCEPT,
  importPresentationTemplateDeck$,
  openCustomTemplateImport$,
  setCustomTemplateImportInput$,
} from "../../signals/okou-page/presentation-template-import.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/** The tile metrics the rest of the picker's grids already use. */
const CARD_MEDIA =
  "relative block aspect-video w-full overflow-hidden rounded-xl border border-border bg-muted";

/**
 * One sheet of paper lying in a tile.
 *
 * The two percentages are what set how much of the page shows. The tile is
 * `aspect-video`, so its height is its own width times 9/16 and both values
 * resolve against that same width: a page 61% of the tile wide is 86.3% of it
 * tall, 8% of the tile's height above it leaves 51.8% of the tile below, and
 * 51.8/86.3 is 60% of the page. Any tile size, the same 60%.
 *
 * Centred with a negative margin rather than `-translate-x-1/2` because the
 * sheets behind are offset with `translate`, and one transform utility cannot
 * hold both. A margin percentage resolves against the tile and a translate
 * percentage against the sheet, which is why the two are written against
 * different denominators.
 *
 * The literal `#ffffff` rather than `bg-white` or a surface token: this is
 * paper, and it stays paper-coloured in Dark. `--color-white` is theme-flipped
 * and resolves to Ink there, so `bg-white` would paint these sheets near-black
 * behind a white page image — a hole rather than the next sheet down. A
 * `bg-card` sheet does the same thing.
 */
const DOCUMENT_SHEET =
  "absolute left-1/2 top-[8%] ml-[-30.5%] aspect-[210/297] w-[61%] " +
  "overflow-hidden rounded-[2px] bg-[#ffffff] " +
  "shadow-[0_1px_2px_hsl(220_12%_50%/0.16),0_7px_18px_hsl(220_12%_50%/0.07)]";

/**
 * A document template's cover: the source's first page, over the sheets that
 * say it had more.
 *
 * Drawn larger than the tile and cropped by its bottom edge rather than fitted
 * inside it. A whole page scaled into this tile puts its title at about five
 * pixels — below what any script reads at — so fitting it buys a smaller
 * smudge, not a legible one. What the crop keeps is the head of the page,
 * where the format lives: how many columns, how much white space, whether it
 * opens with a masthead or a row of form fields. The title is the line
 * underneath the tile, and stays there.
 *
 * The sheets behind carry no image because there is none to carry: a document
 * template uploads its first page and no others. They are the claim that the
 * file continued, not a preview of what it continued into, which is why two of
 * them stand for three pages and for three hundred alike.
 */
function DocumentTemplateCover({
  template,
  coverUrl,
}: {
  readonly template: UserTemplateCatalogEntry;
  readonly coverUrl: string;
}) {
  return (
    <>
      {template.coverHasMorePages ? (
        <>
          <span
            data-testid="document-cover-sheet"
            className={cn(
              DOCUMENT_SHEET,
              "translate-x-[6.4%] translate-y-[3.8%]",
            )}
          />
          <span
            data-testid="document-cover-sheet"
            className={cn(
              DOCUMENT_SHEET,
              "translate-x-[3.2%] translate-y-[1.9%]",
            )}
          />
        </>
      ) : null}
      {/* No z-index: the sheets are positioned siblings at `z-index: auto`, so
          tree order already paints this one over them. */}
      <span className={DOCUMENT_SHEET}>
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          data-testid="document-cover-page"
          className="h-full w-full object-cover object-top"
        />
      </span>
    </>
  );
}

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
  const label = template.canManage ? (
    <VisibilityLabel visibility={template.visibility} />
  ) : (
    <span className="inline-flex items-center gap-1.5">
      <User size={13} className="shrink-0" aria-hidden />
      <SharedByLabel ownerDisplayName={template.ownerDisplayName} />
    </span>
  );
  if (template.kind === "illustration") {
    const Icon = !template.canManage
      ? User
      : template.visibility === "private"
        ? Lock
        : Users;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="shrink-0 rounded-sm text-muted-foreground"
          >
            <Icon size={13} aria-hidden />
            <span className="sr-only">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  }
  return <div className="min-w-0 text-xs text-muted-foreground">{label}</div>;
}

function CustomTemplateActions({
  template,
  onVisibilityChange,
  onDelete,
}: {
  readonly template: UserTemplateCatalogEntry;
  readonly onVisibilityChange: (visibility: UserTemplateVisibility) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    // Revealed on hover like the picker's own tile controls, but kept visible
    // where hover does not exist and whenever it takes focus.
    <div className="absolute right-2 top-2 z-20 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100 [@media(hover:hover)]:group-focus-within/tile:opacity-100">
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
    <div
      className={cn(
        "group/tile flex min-w-0 flex-col",
        template.kind === "illustration" && "mb-6 break-inside-avoid",
      )}
    >
      <div className="relative">
        <button
          type="button"
          className={cn(
            CARD_MEDIA,
            "cursor-pointer",
            template.kind === "illustration" &&
              template.coverUrl &&
              "aspect-auto",
          )}
          aria-label={t(
            ($) => {
              return $.templates.actions.preview;
            },
            { title: template.title },
          )}
          onClick={open}
        >
          {template.coverUrl && template.kind === "document" ? (
            <DocumentTemplateCover
              template={template}
              coverUrl={template.coverUrl}
            />
          ) : template.coverUrl ? (
            <img
              src={template.coverUrl}
              alt=""
              loading="lazy"
              className={
                template.kind === "illustration"
                  ? "block h-auto w-full"
                  : "absolute inset-0 h-full w-full object-cover object-top"
              }
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
        <div className="absolute bottom-2 right-2 z-20 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100 [@media(hover:hover)]:group-focus-within/tile:opacity-100">
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
      <div
        className={cn(
          "flex min-w-0 gap-1 px-0.5 pb-1 pt-2",
          template.kind === "illustration"
            ? "items-center justify-between gap-2"
            : "flex-col",
        )}
      >
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

/** The imported file decides its kind, independently of the active filter. */
function CustomTemplateImportButton({
  signals,
  onImported,
}: {
  readonly signals: ComposerSignals;
  readonly onImported: () => void;
}) {
  const { t } = useTranslation();
  const setInput = useSet(setCustomTemplateImportInput$);
  const openImport = useSet(openCustomTemplateImport$);
  const rootSignal = useGet(rootSignal$);
  const importDeck = useSet(importPresentationTemplateDeck$);
  const label = t(($) => {
    return $.artifacts.templates.importFile;
  });
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-[374px]:px-2 max-[374px]:text-xs"
            onClick={openImport}
          >
            <Upload aria-hidden />
            {label}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {t(($) => {
            return $.templates.importHint;
          })}
        </TooltipContent>
      </Tooltip>
      <input
        ref={setInput}
        type="file"
        className="hidden"
        accept={CUSTOM_TEMPLATE_IMPORT_ACCEPT}
        aria-label={label}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) {
            return;
          }
          onImported();
          detach(importDeck({ signals, file }, rootSignal), Reason.DomCallback);
        }}
      />
    </>
  );
}

function CustomTemplateKindFilters({
  kind,
}: {
  readonly kind: UserTemplateKind;
}) {
  const { t } = useTranslation();
  const setKind = useSet(setCustomTemplateKindFilter$);
  const options = [
    {
      value: "document",
      label: t(($) => {
        return $.artifacts.kinds.document;
      }),
    },
    {
      value: "presentation",
      label: t(($) => {
        return $.artifacts.kinds.presentation;
      }),
    },
    {
      value: "illustration",
      label: t(($) => {
        return $.artifacts.kinds.image;
      }),
    },
  ] as const;
  return (
    <div
      role="group"
      aria-label={t(($) => {
        return $.artifacts.templates.categories;
      })}
      className="flex w-full items-center gap-1 lg:w-auto"
    >
      {options.map(({ value, label }) => {
        return (
          <Button
            key={value}
            type="button"
            variant="quiet"
            size="sm"
            aria-pressed={value === kind}
            className={cn(
              "flex-1 max-[374px]:px-2 max-[374px]:text-xs lg:flex-none",
              value === kind && "bg-gray-50 text-foreground",
            )}
            onClick={() => {
              setKind(value);
            }}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}

function CustomTemplatesEmpty({
  kind,
  isEmptyCatalog,
  hasQuery,
  signals,
  onImported,
}: {
  readonly kind: UserTemplateKind;
  readonly isEmptyCatalog: boolean;
  readonly hasQuery: boolean;
  readonly signals: ComposerSignals;
  readonly onImported: () => void;
}) {
  const { t } = useTranslation();
  const setQuery = useSet(setCustomTemplateSearchQuery$);
  const titles = {
    document: t(($) => {
      return $.templates.empty.document;
    }),
    presentation: t(($) => {
      return $.templates.empty.presentation;
    }),
    illustration: t(($) => {
      return $.templates.empty.illustration;
    }),
  };
  const Icon = hasQuery
    ? Search
    : isEmptyCatalog
      ? Layers
      : kind === "document"
        ? FileText
        : kind === "presentation"
          ? Presentation
          : ImageIcon;
  return (
    <div className="flex min-h-64 flex-1 flex-col items-center justify-center px-5 py-7 text-center">
      <div
        className="relative mb-6 h-16 w-20 text-muted-foreground"
        aria-hidden
      >
        <span className="absolute left-2 top-1 h-14 w-11 -rotate-12 rounded-lg border border-border bg-gray-50" />
        <span className="absolute right-2 top-0 flex h-14 w-11 rotate-6 items-center justify-center rounded-lg border border-border bg-background">
          <Icon size={24} strokeWidth={1.5} />
        </span>
      </div>
      <h2 className="text-base font-medium text-foreground">
        {hasQuery
          ? t(($) => {
              return $.artifacts.templates.noMatches;
            })
          : isEmptyCatalog
            ? t(($) => {
                return $.templates.empty.title;
              })
            : titles[kind]}
      </h2>
      <p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">
        {hasQuery
          ? t(($) => {
              return $.artifacts.templates.tryDifferentSearch;
            })
          : isEmptyCatalog
            ? t(($) => {
                return $.templates.empty.description;
              })
            : t(($) => {
                return $.templates.importHint;
              })}
      </p>
      {hasQuery ? (
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="mt-6"
          onClick={() => {
            setQuery("");
          }}
        >
          {t(($) => {
            return $.templates.clearSearch;
          })}
        </Button>
      ) : !isEmptyCatalog ? (
        <div className="mt-6">
          <CustomTemplateImportButton
            signals={signals}
            onImported={onImported}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Custom templates retain their loaded cards while a catalog refresh runs. */
export function CustomTemplatePickerPane({
  signals,
  onSelect,
  onImported,
}: {
  readonly signals: ComposerSignals;
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
  readonly onImported: () => void;
}) {
  const { t } = useTranslation();
  const query = useGet(customTemplateSearchQuery$);
  const setQuery = useSet(setCustomTemplateSearchQuery$);
  const catalog = useLastLoadable(customTemplateCatalog$);
  const projectPicker = useGet(projectCustomTemplatePicker$);
  const view = catalog.state === "hasData" ? projectPicker(catalog.data) : null;
  const hasQuery = query.trim().length > 0;
  const showToolbar = view !== null && (view.templates.length > 0 || hasQuery);
  const showHeaderImport = showToolbar || view?.isEmptyCatalog === true;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {showHeaderImport ? (
        <div
          className={cn(
            "relative shrink-0 pb-5 sm:pt-[68px] lg:flex lg:items-center lg:gap-4",
            !showToolbar && "pb-0",
          )}
        >
          {showToolbar && view ? (
            <>
              <div className="mb-3.5 w-full min-w-0 lg:mb-0 lg:w-56 lg:shrink">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    aria-label={t(($) => {
                      return $.artifacts.templates.searchConnectors;
                    })}
                    placeholder={t(($) => {
                      return $.artifacts.templates.searchConnector;
                    })}
                    className="h-9 pl-9 text-sm"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                  />
                </div>
              </div>
              <CustomTemplateKindFilters kind={view.kind} />
            </>
          ) : null}
          <div className="absolute -top-[50px] right-0 shrink-0 sm:right-9 sm:top-[18px]">
            <CustomTemplateImportButton
              signals={signals}
              onImported={onImported}
            />
          </div>
        </div>
      ) : null}
      <div
        role="region"
        aria-label={t(($) => {
          return $.templates.detail.back;
        })}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {catalog.state === "hasError" ? (
          <CustomTemplatesLoadError />
        ) : view === null ? null : view.templates.length === 0 ? (
          <CustomTemplatesEmpty
            kind={view.kind}
            isEmptyCatalog={view.isEmptyCatalog}
            hasQuery={hasQuery}
            signals={signals}
            onImported={onImported}
          />
        ) : (
          <div
            className={
              view.kind === "illustration"
                ? "columns-[244px] gap-5"
                : "grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3"
            }
          >
            {view.templates.map((template) => {
              return (
                <CustomTemplateCard
                  key={template.id}
                  template={template}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        )}
      </div>
      <CustomTemplatePreviewDialog onSelect={onSelect} />
    </div>
  );
}
