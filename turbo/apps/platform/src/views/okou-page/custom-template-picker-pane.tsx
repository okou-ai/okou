import type { ReactNode } from "react";
import { DocumentTemplateCover } from "./document-template-cover.tsx";
import {
  Check,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Trash2,
  User,
} from "lucide-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { TemplateSourceSection } from "./template-source-section.tsx";
import { FilePreviewIcon } from "./file-preview-icon.tsx";
import { normalizeTemplateTitle } from "./template-detail-layout.tsx";
import { TEMPLATE_CARD_SHADOW, TEMPLATE_TILE_SCRIM } from "./template-tile.ts";
import {
  cancelDeleteCustomTemplate$,
  cancelRenameCustomTemplate$,
  customTemplateActiveExample$,
  customTemplateCatalog$,
  deleteCustomTemplate$,
  openCustomTemplate$,
  openCustomTemplateKind$,
  pendingCustomTemplateDeletion$,
  pendingCustomTemplateRename$,
  renameCustomTemplate$,
  requestDeleteCustomTemplate$,
  requestRenameCustomTemplate$,
  projectCustomTemplatePicker$,
  showCustomTemplateExample$,
  updateCustomTemplate$,
} from "../../signals/okou-page/custom-template-library.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/** The tile metrics the rest of the picker's grids already use. */
// `isolate` keeps the shared scrim's z-index inside the cover, so the Use and
// actions controls beside it still paint over it in tree order.
const CARD_MEDIA =
  "relative isolate block w-full overflow-hidden rounded-xl border border-border bg-muted";

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
  return <div className="min-w-0 text-xs text-muted-foreground">{label}</div>;
}

function CustomTemplateActions({
  template,
  onVisibilityChange,
  onRename,
  onDelete,
}: {
  readonly template: UserTemplateCatalogEntry;
  readonly onVisibilityChange: (visibility: UserTemplateVisibility) => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    // Revealed on hover like the picker's own tile controls, but kept visible
    // where hover does not exist and whenever it takes focus.
    <div className="absolute right-2 top-2 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100 [@media(hover:hover)]:group-focus-within/tile:opacity-100">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
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
              // Over cover art, which looks the same in both themes, so the
              // chip does too: literal white and Ink rather than tokens that
              // flip, which sank a dark chip into dark covers. The ring and
              // shadow keep its edge on a white cover.
              className="bg-[#ffffff]/90 text-[#363534] shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-1 ring-[rgb(0_0_0/0.06)] hover:bg-[#ffffff] hover:text-[#242321] active:bg-[#f0ecea]"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={onRename}>
            <Pencil />
            {t(($) => {
              return $.templates.rename.action;
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
                    onClick={() => {
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
            onClick={onDelete}
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

/**
 * The same strip as the built-in Illustration card: a thumbnail per picture,
 * the shown one marked, chosen with a pressed button.
 */
function CustomTemplateExampleStrip({
  templateId,
  pictures,
  shown,
}: {
  readonly templateId: string;
  readonly pictures: readonly string[];
  readonly shown: number;
}) {
  const { t } = useTranslation();
  const showExample = useSet(showCustomTemplateExample$);
  return (
    <div
      data-custom-illustration-examples=""
      className="flex items-center gap-2 overflow-x-auto px-3 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {pictures.map((picture, index) => {
        const active = index === shown;
        return (
          <button
            key={picture}
            type="button"
            aria-label={t(
              ($) => {
                return $.artifacts.templates.showVariant;
              },
              { variantNumber: index + 1 },
            )}
            aria-pressed={active}
            className={cn(
              "relative h-12 w-12 shrink-0 overflow-hidden rounded-md border-(length:--border-width-emphasis) bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "border-primary" : "border-border",
            )}
            onClick={() => {
              showExample({ templateId, index });
            }}
          >
            <img
              src={picture}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * An image template's picture. There is no detail page, like the built-in
 * Illustration card: the card already shows the pictures, the strip and the
 * action. Where there is more than one picture, clicking a half of it steps
 * that way, the same affordance the built-in card uses.
 */
function CustomTemplateIllustrationHero({
  template,
  pictures,
  shown,
}: {
  readonly template: UserTemplateCatalogEntry;
  readonly pictures: readonly string[];
  readonly shown: number;
}) {
  const { t } = useTranslation();
  const showExample = useSet(showCustomTemplateExample$);
  const hero = pictures[shown];
  const navigable = pictures.length > 1;
  return (
    <div className="block w-full bg-muted">
      {hero ? (
        <img
          src={hero}
          alt={t(
            ($) => {
              return $.artifacts.templates.illustrationPreview;
            },
            { title: template.title },
          )}
          loading="lazy"
          className={cn(
            "block h-auto w-full",
            navigable &&
              "data-[half=left]:cursor-w-resize data-[half=right]:cursor-e-resize",
          )}
          onMouseMove={
            navigable
              ? (event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  event.currentTarget.dataset.half =
                    event.clientX - rect.left < rect.width / 2
                      ? "left"
                      : "right";
                }
              : undefined
          }
          onMouseLeave={
            navigable
              ? (event) => {
                  delete event.currentTarget.dataset.half;
                }
              : undefined
          }
          onClick={
            navigable
              ? (event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const direction =
                    event.clientX - rect.left < rect.width / 2 ? -1 : 1;
                  showExample({
                    templateId: template.id,
                    index:
                      (shown + direction + pictures.length) % pictures.length,
                  });
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

/**
 * An image template, shown the way the built-in Illustration tab shows a
 * style: the picture it draws, the other pictures beneath it, then the name.
 *
 * The pictures are the template's preview assets: the examples its style
 * produced and the member approved. A style is judged by what it makes, so
 * the source a member uploaded never represents it. One picture needs no
 * strip to choose from, so it gets none.
 */
function CustomTemplateIllustrationCard({
  template,
  onSelect,
}: {
  readonly template: UserTemplateCatalogEntry;
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const updateTemplate = useSet(updateCustomTemplate$);
  const requestDelete = useSet(requestDeleteCustomTemplate$);
  const requestRename = useSet(requestRenameCustomTemplate$);
  const activeExample = useGet(customTemplateActiveExample$);
  const pictures = template.previewAssets.map((asset) => {
    return asset.url;
  });
  const shown = Math.min(
    activeExample(template.id),
    Math.max(0, pictures.length - 1),
  );
  return (
    <div className="mb-6 break-inside-avoid">
      <div
        data-custom-illustration-card=""
        className={cn(
          "group/tile overflow-hidden rounded-xl border border-border bg-card",
          TEMPLATE_CARD_SHADOW,
        )}
      >
        <div className="relative isolate">
          <CustomTemplateIllustrationHero
            template={template}
            pictures={pictures}
            shown={shown}
          />
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
              onRename={() => {
                requestRename({ id: template.id, title: template.title });
              }}
              onDelete={() => {
                requestDelete({ id: template.id, title: template.title });
              }}
            />
          ) : null}
        </div>
        {pictures.length > 1 ? (
          <CustomTemplateExampleStrip
            templateId={template.id}
            pictures={pictures}
            shown={shown}
          />
        ) : null}
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p
              className="min-w-0 truncate text-sm font-semibold text-foreground"
              title={template.title}
            >
              {template.title}
            </p>
            <CustomTemplateMeta template={template} />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              onSelect(template);
            }}
          >
            {t(($) => {
              return $.artifacts.templates.use;
            })}
          </Button>
        </div>
      </div>
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
  const requestDelete = useSet(requestDeleteCustomTemplate$);
  const requestRename = useSet(requestRenameCustomTemplate$);
  const open = () => {
    openTemplate({ templateId: template.id, kind: template.kind });
  };
  return (
    <div className="group/tile flex min-w-0 flex-col">
      {/* Positioned tree order paints the cover, then the scrim, then the
          sibling Use and More actions, including during opacity transitions. */}
      <div className="relative">
        <button
          type="button"
          className={cn(
            CARD_MEDIA,
            "cursor-pointer",
            template.kind === "document" ? "aspect-[4/3]" : "aspect-video",
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
              hasMorePages={template.coverHasMorePages}
              coverUrl={template.coverUrl}
            />
          ) : template.coverUrl ? (
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
          <span className={TEMPLATE_TILE_SCRIM} />
        </button>
        {/* Beside the preview rather than inside it: the tile opens the
            template, and using it is a different decision from looking at
            it. Revealed on hover like the actions menu above, and kept
            reachable where hover does not exist. */}
        <div className="absolute bottom-2 right-2 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100 [@media(hover:hover)]:group-focus-within/tile:opacity-100">
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
            onRename={() => {
              requestRename({ id: template.id, title: template.title });
            }}
            onDelete={() => {
              requestDelete({ id: template.id, title: template.title });
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
 * Asks once before a template is removed, because removal cannot be undone.
 *
 * Both the tile menu and the open template's column request a deletion, so the
 * confirmation lives beside the picker rather than inside either of them. It
 * mounts per request, keyed by the template, so one request's failure is never
 * shown on the next. It stays open while the delete is in flight and closes
 * only on success.
 */
function CustomTemplateDeleteConfirmSlot({
  returnFocus,
}: {
  readonly returnFocus: (interactionType: string) => HTMLElement | null;
}) {
  const pending = useGet(pendingCustomTemplateDeletion$);
  return pending ? (
    <CustomTemplateDeleteConfirm
      key={pending.id}
      templateId={pending.id}
      title={pending.title}
      returnFocus={returnFocus}
    />
  ) : null;
}

function CustomTemplateDeleteConfirm({
  templateId,
  title,
  returnFocus,
}: {
  readonly templateId: string;
  readonly title: string;
  readonly returnFocus: (interactionType: string) => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const cancel = useSet(cancelDeleteCustomTemplate$);
  const [deleteLoadable, deleteTemplate] = useLoadableSet(
    deleteCustomTemplate$,
  );
  const deleting = deleteLoadable.state === "loading";
  const previewKind = useGet(openCustomTemplateKind$);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !deleting) {
          cancel();
        }
      }}
    >
      <DialogContent
        smMaxWidth={420}
        finalFocus={previewKind === null ? returnFocus : undefined}
      >
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="break-words leading-tight">
            {t(($) => {
              return $.templates.delete.title;
            })}
          </DialogTitle>
          <DialogDescription className="break-words">
            {t(
              ($) => {
                return $.templates.delete.description;
              },
              { title },
            )}
          </DialogDescription>
        </DialogHeader>
        {deleteLoadable.state === "hasError" ? (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.templates.delete.failed;
            })}
          </p>
        ) : null}
        <DialogFooter className="min-w-0">
          <Button variant="outline" disabled={deleting} onClick={cancel}>
            {t(($) => {
              return $.templates.delete.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              detach(
                deleteTemplate(templateId, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {deleting
              ? t(($) => {
                  return $.templates.delete.deleting;
                })
              : t(($) => {
                  return $.templates.delete.confirm;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The rename a card's menu asked for. Image templates have no detail page, so
 * this is where every template can be renamed from the catalog. It mounts per
 * request, keyed by the template, so one request's failure is never shown on
 * the next, and it closes only once the new name is saved.
 */
function CustomTemplateRenameSlot({
  returnFocus,
}: {
  readonly returnFocus: (interactionType: string) => HTMLElement | null;
}) {
  const pending = useGet(pendingCustomTemplateRename$);
  return pending ? (
    <CustomTemplateRenameDialog
      key={pending.id}
      templateId={pending.id}
      title={pending.title}
      returnFocus={returnFocus}
    />
  ) : null;
}

function CustomTemplateRenameDialog({
  templateId,
  title,
  returnFocus,
}: {
  readonly templateId: string;
  readonly title: string;
  readonly returnFocus: (interactionType: string) => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const cancel = useSet(cancelRenameCustomTemplate$);
  const [renameLoadable, renameTemplate] = useLoadableSet(
    renameCustomTemplate$,
  );
  const saving = renameLoadable.state === "loading";
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) {
          cancel();
        }
      }}
    >
      <DialogContent smMaxWidth={420} finalFocus={returnFocus}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (saving) {
              return;
            }
            const field = new FormData(event.currentTarget).get("title");
            const normalized =
              typeof field === "string" ? normalizeTemplateTitle(field) : "";
            if (normalized.length === 0) {
              return;
            }
            if (normalized === title) {
              cancel();
              return;
            }
            detach(
              renameTemplate({ templateId, title: normalized }, pageSignal),
              Reason.DomCallback,
            );
          }}
        >
          <DialogHeader className="min-w-0 pr-8">
            <DialogTitle className="break-words leading-tight">
              {t(($) => {
                return $.templates.actions.rename;
              })}
            </DialogTitle>
          </DialogHeader>
          <Input
            name="title"
            defaultValue={title}
            maxLength={255}
            required
            autoFocus
            disabled={saving}
            aria-label={t(($) => {
              return $.templates.actions.rename;
            })}
            onKeyDown={(event) => {
              // Confirming an input method's candidate must not submit the
              // half-composed name. Safari ends composition before that Enter
              // and reports it with keyCode 229, so both are checked.
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
          {renameLoadable.state === "hasError" ? (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.templates.renameFailed;
              })}
            </p>
          ) : null}
          <DialogFooter className="min-w-0">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={cancel}
            >
              {t(($) => {
                return $.templates.rename.cancel;
              })}
            </Button>
            <Button type="submit" pending={saving}>
              {t(($) => {
                return $.templates.rename.save;
              })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Custom templates retain their loaded cards while a catalog refresh runs. */
export function CustomTemplatePickerSection({
  signals,
  kind,
  query,
  importCard,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly kind: UserTemplateKind;
  readonly query: string;
  readonly importCard: ReactNode;
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const catalog = useLastLoadable(customTemplateCatalog$);
  const projectPicker = useGet(projectCustomTemplatePicker$);
  // A menu item disappears when it opens a dialog. Restore the current type
  // instead of letting the focus fallback activate the first category.
  const returnFocus = useSet(signals.template.templatePickerInitialFocus$);
  const templates =
    catalog.state === "hasData"
      ? projectPicker(catalog.data, kind, query)
      : null;
  return (
    <>
      <TemplateSourceSection source="custom" count={templates?.length}>
        {catalog.state === "hasError" ? <CustomTemplatesLoadError /> : null}
        <div
          className={
            kind === "illustration"
              ? "columns-[244px] gap-4"
              : "grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3"
          }
        >
          <div
            className={
              kind === "illustration" ? "mb-6 break-inside-avoid" : undefined
            }
          >
            {importCard}
          </div>
          {templates?.map((template) => {
            return template.kind === "illustration" ? (
              <CustomTemplateIllustrationCard
                key={template.id}
                template={template}
                onSelect={onSelect}
              />
            ) : (
              <CustomTemplateCard
                key={template.id}
                template={template}
                onSelect={onSelect}
              />
            );
          })}
        </div>
        {templates?.length === 0 && query.trim().length > 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {t(($) => {
              return $.artifacts.templates.noMatches;
            })}
          </p>
        ) : null}
      </TemplateSourceSection>
      <CustomTemplatePreviewDialog
        onSelect={onSelect}
        returnFocus={returnFocus}
      />
      <CustomTemplateDeleteConfirmSlot returnFocus={returnFocus} />
      <CustomTemplateRenameSlot returnFocus={returnFocus} />
    </>
  );
}
