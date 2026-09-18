import { Lock, User, Users } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Button,
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

import {
  deleteCustomTemplate$,
  updateCustomTemplate$,
} from "../../signals/okou-page/custom-template-library.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/**
 * Everything an open custom template can be managed by, in one column.
 *
 * It lives here rather than beside the panel that first rendered it because
 * the two kinds are opened by different surfaces — a deck takes over the
 * panel, a document opens a dialog — and both have to offer the same
 * controls. Importing it back from the panel would close a cycle.
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

/** The sidebar's primary action, kept out of it so it stays one screenful. */
function UseCustomTemplateButton({
  detail,
  onSelect,
}: {
  readonly detail: UserTemplateDetail;
  readonly onSelect: (template: UserTemplateCatalogEntry) => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      className="mb-3 w-full"
      onClick={() => {
        onSelect(detail);
      }}
    >
      {t(($) => {
        return $.artifacts.templates.useThisTemplate;
      })}
    </Button>
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
  const updateTemplate = useSet(updateCustomTemplate$);
  const deleteTemplate = useSet(deleteCustomTemplate$);
  return (
    <aside className="w-full shrink-0 lg:w-[300px]">
      <div className="rounded-xl border border-border bg-background p-4">
        <UseCustomTemplateButton detail={detail} onSelect={onSelect} />
        {detail.canManage ? (
          <CustomTemplateTitleInput detail={detail} />
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
