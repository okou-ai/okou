import {
  Check,
  ChevronLeft,
  ChevronRight,
  Lock,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { useGet, useLoadable, useSet } from "ccstate-react";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@okouai/ui";
import type {
  UserTemplateCatalogEntry,
  UserTemplateDetail,
  UserTemplateVisibility,
} from "@okouai/api-contracts/contracts/user-templates";

import { TemplateEmptyPanel } from "./template-empty-panel.tsx";
import {
  closeCustomTemplate$,
  customTemplateSearchQuery$,
  deleteCustomTemplate$,
  openCustomTemplate$,
  openCustomTemplateDetail$,
  openCustomTemplateId$,
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

/** Two levels only, ordered least to most reachable. */
const VISIBILITY_OPTIONS: readonly UserTemplateVisibility[] = [
  "private",
  "organization",
];

function VisibilityLabel({
  visibility,
}: {
  readonly visibility: UserTemplateVisibility;
}) {
  const { t } = useTranslation();
  const Icon = visibility === "private" ? Lock : Users;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon size={13} className="shrink-0" aria-hidden />
      {visibility === "private"
        ? t(($) => {
            return $.templates.visibility.private;
          })
        : t(($) => {
            return $.templates.visibility.organization;
          })}
    </span>
  );
}

/**
 * One meta line: who can see it — or, for a colleague's template, whose it is,
 * because a visibility the reader cannot change is not worth the row.
 *
 * The page count is dropped when there is none. A document template is its
 * styles, so the API reports `null` rather than a zero; printing "0 pages"
 * would describe it as an empty deck instead of a kind that never had pages.
 * The row still names the file it was compiled from.
 */
function CustomTemplateMeta({
  template,
}: {
  readonly template: UserTemplateCatalogEntry;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
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
      {template.pageCount === null ? null : (
        <span>
          {t(
            ($) => {
              return $.templates.pageCount;
            },
            { count: template.pageCount },
          )}
        </span>
      )}
      <span className="truncate">{template.sourceFilename}</span>
    </div>
  );
}

function VisibilityOptionList({
  visibility,
  onChange,
}: {
  readonly visibility: UserTemplateVisibility;
  readonly onChange: (next: UserTemplateVisibility) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t(($) => {
        return $.templates.visibility.change;
      })}
    >
      {VISIBILITY_OPTIONS.map((value) => {
        const selected = value === visibility;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={cn(
              "flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-state-hover",
              selected && "bg-state-selected",
            )}
            onClick={() => {
              if (!selected) {
                onChange(value);
              }
            }}
          >
            <span className="text-sm text-foreground">
              {value === "private"
                ? t(($) => {
                    return $.templates.visibility.private;
                  })
                : t(($) => {
                    return $.templates.visibility.organization;
                  })}
            </span>
            <span className="text-xs text-muted-foreground">
              {value === "private"
                ? t(($) => {
                    return $.templates.visibility.privateState;
                  })
                : t(($) => {
                    return $.templates.visibility.organizationState;
                  })}
            </span>
          </button>
        );
      })}
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
}: {
  readonly template: UserTemplateCatalogEntry;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const openTemplate = useSet(openCustomTemplate$);
  const updateTemplate = useSet(updateCustomTemplate$);
  const deleteTemplate = useSet(deleteCustomTemplate$);
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
          onClick={() => {
            openTemplate(template.id);
          }}
        >
          {template.coverUrl ? (
            <img
              src={template.coverUrl}
              alt=""
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          <span className="pointer-events-none absolute inset-x-0 bottom-0 z-[15] h-14 bg-gradient-to-t from-black/45 to-transparent opacity-0 transition-opacity group-hover/tile:opacity-100" />
        </button>
        {template.canManage ? (
          <CustomTemplateActions
            template={template}
            onRename={() => {
              openTemplate(template.id);
            }}
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
 * The upload entry for this catalog.
 *
 * One entry for every kind of template, not one per kind: the file the user
 * picked decides what it becomes, so the prompt that is sent — and with it the
 * command that publishes the result — follows the file rather than a choice
 * made before the analysis has read it.
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
  const rootSignal = useGet(rootSignal$);
  const importDeck = useSet(importPresentationTemplateDeck$);
  const label = t(($) => {
    return $.artifacts.templates.importFile;
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
            detach(
              importDeck({ signals, file }, rootSignal),
              Reason.DomCallback,
            );
          }}
        />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.artifacts.templates.importFileHint;
            },
            { formats: CUSTOM_TEMPLATE_IMPORT_ACCEPT.split(",").join(", ") },
          )}
        </span>
      </span>
    </label>
  );
}

function CustomTemplatesEmpty() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center rounded-[22px] border border-border bg-card px-6 py-12 text-center">
      <p className="text-base font-semibold text-foreground">
        {t(($) => {
          return $.templates.empty.title;
        })}
      </p>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {t(($) => {
          return $.templates.empty.description;
        })}
      </p>
    </div>
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

function CustomTemplateDetailSidebar({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const updateTemplate = useSet(updateCustomTemplate$);
  const deleteTemplate = useSet(deleteCustomTemplate$);
  const rename = (nextTitle: string) => {
    const normalized = nextTitle.replace(/\s+/gu, " ").trim();
    if (normalized.length === 0 || normalized === detail.title) {
      return;
    }
    detach(
      updateTemplate(
        { templateId: detail.id, body: { title: normalized } },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };
  return (
    <aside className="w-full shrink-0 lg:w-[300px]">
      <div className="rounded-xl border border-border bg-background p-4">
        {detail.canManage ? (
          <Input
            key={detail.title}
            defaultValue={detail.title}
            aria-label={t(($) => {
              return $.templates.actions.rename;
            })}
            className="h-9 text-base font-semibold"
            onBlur={(event) => {
              rename(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <h3 className="text-lg font-semibold text-foreground">
            {detail.title}
          </h3>
        )}
        {/*
         * The source line drops the page count for a kind that has none, so a
         * document is described by the file it came from rather than by an
         * emptiness it does not have.
         */}
        <p className="mt-2 text-xs text-muted-foreground">
          {detail.pageCount === null
            ? t(
                ($) => {
                  return $.templates.detail.sourceFile;
                },
                { filename: detail.sourceFilename },
              )
            : t(
                ($) => {
                  return $.templates.detail.source;
                },
                { count: detail.pageCount, filename: detail.sourceFilename },
              )}
        </p>
        <div className="my-4 border-t border-t-gray-400" />
        {detail.canManage ? (
          <Popover>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              <VisibilityLabel visibility={detail.visibility} />
              <span aria-hidden>·</span>
              <PopoverTrigger className="font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground">
                {t(($) => {
                  return $.templates.visibility.change;
                })}
              </PopoverTrigger>
            </p>
            <PopoverContent align="start" className="w-72 p-1.5">
              <VisibilityOptionList
                visibility={detail.visibility}
                onChange={(visibility) => {
                  detach(
                    updateTemplate(
                      { templateId: detail.id, body: { visibility } },
                      pageSignal,
                    ),
                    Reason.DomCallback,
                  );
                }}
              />
            </PopoverContent>
          </Popover>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <User size={13} aria-hidden />
            {t(
              ($) => {
                return $.templates.sharedBy;
              },
              { owner: detail.ownerUserId },
            )}
          </p>
        )}
        {detail.canManage ? (
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="mt-2 w-full text-destructive hover:text-destructive"
            onClick={() => {
              detach(deleteTemplate(detail.id, pageSignal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.templates.actions.delete;
            })}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

function CustomTemplateDetail() {
  const { t } = useTranslation();
  const detailLoadable = useLoadable(openCustomTemplateDetail$);
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
          <CustomTemplateDetailSidebar detail={detail} />
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
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const query = useGet(customTemplateSearchQuery$);
  const setQuery = useSet(setCustomTemplateSearchQuery$);
  const openTemplateId = useGet(openCustomTemplateId$);
  const templatesLoadable = useLoadable(visibleCustomTemplates$);

  if (openTemplateId !== null) {
    return <CustomTemplateDetail />;
  }

  const body =
    templatesLoadable.state === "hasError" ? (
      <CustomTemplatesLoadError />
    ) : templatesLoadable.state === "loading" ? null : templatesLoadable.data
        .length === 0 ? (
      // A query that matches nothing is a different event from having no
      // templates at all, and the picker already ships the panel that says so.
      // Uploading cannot answer a failed search, so the tile only leads the
      // empty catalog.
      query.trim().length > 0 ? (
        <TemplateEmptyPanel />
      ) : (
        <div className="flex flex-col gap-5">
          <CustomTemplatesEmpty />
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            <CustomTemplateUploadCard signals={signals} />
          </div>
        </div>
      )
    ) : (
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
        <CustomTemplateUploadCard signals={signals} />
        {templatesLoadable.data.map((template) => {
          return <CustomTemplateCard key={template.id} template={template} />;
        })}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
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
      {body}
    </div>
  );
}
