import { Check, Lock, User, Users } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Button,
  Input,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@okouai/ui";
import type {
  UserTemplateCatalogEntry,
  UserTemplateDetail,
  UserTemplateVisibility,
} from "@okouai/api-contracts/contracts/user-templates";

import {
  deleteCustomTemplate$,
  updateCustomTemplate$,
} from "../../signals/okou-page/custom-template-library.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/**
 * Everything an open custom template can be managed by, in one column.
 *
 * It lives here rather than beside the panel that lists the catalog because the
 * dialog that opens a template is what renders it, and importing it back from
 * the panel would close a cycle.
 */

/** Two levels only, ordered least to most reachable. */
export const VISIBILITY_OPTIONS: readonly UserTemplateVisibility[] = [
  "private",
  "organization",
];

export function VisibilityLabel({
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
        const Icon = value === "private" ? Lock : Users;
        return (
          <PopoverClose asChild key={value}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-state-hover",
                selected && "bg-state-selected",
              )}
              onClick={() => {
                if (!selected) {
                  onChange(value);
                }
              }}
            >
              <Icon
                size={16}
                className="mt-0.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground">
                  {value === "private"
                    ? t(($) => {
                        return $.templates.visibility.private;
                      })
                    : t(($) => {
                        return $.templates.visibility.organization;
                      })}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {value === "private"
                    ? t(($) => {
                        return $.templates.visibility.privateState;
                      })
                    : t(($) => {
                        return $.templates.visibility.organizationState;
                      })}
                </span>
              </span>
              {/* The check column is reserved on both rows: letting it appear
                  only on the selected one narrows that row's text box, so the
                  description reflows every time the selection moves. */}
              <span className="mt-0.5 w-4 shrink-0">
                {selected ? (
                  <Check size={16} className="text-foreground" aria-hidden />
                ) : null}
              </span>
            </button>
          </PopoverClose>
        );
      })}
    </div>
  );
}

/**
 * Visibility stated as its consequence rather than as a setting, the way the
 * imported deck panel states it: the two words that name the levels carry less
 * than the sentence that says what they do, so the sentence stays on screen and
 * the picker moves behind `Change`.
 */
function CustomTemplateVisibilityControl({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const updateTemplate = useSet(updateCustomTemplate$);
  const CurrentIcon = detail.visibility === "private" ? Lock : Users;
  return (
    <Popover>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <CurrentIcon size={14} className="shrink-0" aria-hidden="true" />
        <span>
          {detail.visibility === "private"
            ? t(($) => {
                return $.templates.visibility.privateState;
              })
            : t(($) => {
                return $.templates.visibility.organizationState;
              })}
        </span>
        <span aria-hidden="true">·</span>
        <PopoverTrigger className="font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground">
          {t(($) => {
            return $.templates.visibility.change;
          })}
        </PopoverTrigger>
      </p>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-[19rem] p-1.5"
      >
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
  );
}

/**
 * The title is the one control here whose next edit depends on the previous one
 * having finished, so the field owns its own save rather than firing it and
 * forgetting it. It is closed for the duration: a second blur sends a second
 * rename, and nothing between here and the row lock promises the two arrive in
 * the order they were typed — which is how the earlier of the two could land
 * last and take the name back.
 */
function CustomTemplateTitleInput({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateTemplate] = useLoadableSet(updateCustomTemplate$);
  const saving = saveLoadable.state === "loading";
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
    <>
      <Input
        // Re-keyed on the stored title so the server's own normalisation
        // replaces what was typed, once it is stored. A save that failed did
        // not change the title, which is what leaves the rejected text in the
        // field to be corrected and sent again.
        key={detail.title}
        defaultValue={detail.title}
        disabled={saving}
        aria-label={t(($) => {
          return $.templates.actions.rename;
        })}
        className="h-auto min-h-10 rounded-lg border-transparent px-1 py-[5px] text-xl font-semibold leading-7 hover:border-[hsl(var(--gray-400))]"
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
      {saveLoadable.state === "hasError" ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {t(($) => {
            return $.templates.renameFailed;
          })}
        </p>
      ) : null}
    </>
  );
}

export function CustomTemplateDetailSidebar({
  detail,
  onSelect,
}: {
  readonly detail: UserTemplateDetail;
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const deleteTemplate = useSet(deleteCustomTemplate$);
  return (
    // The imported deck panel's column, which this now shares: the name, what
    // it was compiled from, what it means to share it, then the action, then
    // the way to be rid of it.
    <aside className="flex w-full shrink-0 flex-col lg:sticky lg:top-0 lg:w-[320px]">
      <div className="rounded-lg border border-border bg-background p-4 shadow-sm">
        {detail.canManage ? (
          <CustomTemplateTitleInput detail={detail} />
        ) : (
          <h3 className="text-xl font-semibold text-foreground">
            {detail.title}
          </h3>
        )}
        {/*
         * The source line drops the page count for a kind that has none, so a
         * document is described by the file it came from rather than by an
         * emptiness it does not have. It is asked for here because the tile
         * that used to answer it carries only visibility now.
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
        <div className="my-5 border-t border-border" />
        {detail.canManage ? (
          <CustomTemplateVisibilityControl detail={detail} />
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <User size={14} className="shrink-0" aria-hidden />
            {t(
              ($) => {
                return $.templates.sharedBy;
              },
              { owner: detail.ownerUserId },
            )}
          </p>
        )}
        <Button
          type="button"
          className="mt-5 h-12 w-full font-semibold shadow-sm"
          onClick={() => {
            onSelect(detail);
          }}
        >
          {t(($) => {
            return $.artifacts.templates.useThisTemplate;
          })}
        </Button>
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
