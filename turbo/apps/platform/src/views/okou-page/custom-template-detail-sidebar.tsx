import { ChevronDown, Lock, Trash2, User, Users } from "lucide-react";
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
      className="w-full"
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
      {/*
       * Three bands, largest decision first: what this template is called, what
       * to do with it, and the settings that outlive this visit. The file it
       * was compiled from is not repeated here — the catalog tile names it, and
       * the preview beside this column is that file.
       */}
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-background p-4">
        <div className="flex flex-col gap-3">
          {detail.canManage ? (
            <CustomTemplateTitleInput detail={detail} />
          ) : (
            <h3 className="text-base font-semibold leading-6 text-foreground">
              {detail.title}
            </h3>
          )}
          <UseCustomTemplateButton detail={detail} onSelect={onSelect} />
        </div>
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          {detail.canManage ? (
            <Popover>
              {/*
               * The whole row is the control. Reading the current level and
               * changing it were a label and an underlined word beside it, which
               * left the thing being clicked smaller than the sentence naming
               * it.
               */}
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="neutral"
                    size="sm"
                    className="h-9 w-full justify-between px-3 font-normal"
                    aria-label={t(($) => {
                      return $.templates.visibility.change;
                    })}
                  />
                }
              >
                <VisibilityLabel visibility={detail.visibility} />
                <ChevronDown className="text-muted-foreground" />
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[268px] p-1.5">
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
            // Carries a surface like the control above it, so the row that
            // destroys the template is not the one thing here that looks like
            // loose text.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 w-full gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                detach(
                  deleteTemplate(detail.id, pageSignal),
                  Reason.DomCallback,
                );
              }}
            >
              <Trash2 />
              {t(($) => {
                return $.templates.actions.delete;
              })}
            </Button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
