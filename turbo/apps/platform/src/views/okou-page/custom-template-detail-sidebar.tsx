import { Check, Lock, User, Users } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
} from "@okouai/ui";
import type {
  UserTemplateDetail,
  UserTemplateVisibility,
} from "@okouai/api-contracts/contracts/user-templates";

import {
  requestDeleteCustomTemplate$,
  updateCustomTemplate$,
} from "../../signals/okou-page/custom-template-library.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  TEMPLATE_DETAIL_TITLE_FIELD,
  TEMPLATE_DETAIL_TITLE_TEXTAREA,
  TemplateDetailAccess,
  TemplateDetailDeleteButton,
  normalizeTemplateTitle,
} from "./template-detail-layout.tsx";

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

/**
 * Whose template this is, for a reader who cannot manage it.
 *
 * The name comes resolved from the catalog because the browser holds no
 * directory: `ownerUserId` is an identity-provider handle, and rendering it is
 * what put a raw `user_…` string on a tile. When the provider has no name for
 * the owner the row still belongs to someone reachable, so the line says that
 * much rather than falling back to the handle.
 */
export function SharedByLabel({
  ownerDisplayName,
}: {
  readonly ownerDisplayName: string | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      {ownerDisplayName === null
        ? t(($) => {
            return $.templates.sharedByMember;
          })
        : t(
            ($) => {
              return $.templates.sharedBy;
            },
            { owner: ownerDisplayName },
          )}
    </>
  );
}

function VisibilityOptionList({
  templateId,
  visibility,
  onChange,
}: {
  readonly visibility: UserTemplateVisibility;
  readonly templateId: string;
  readonly onChange: (next: UserTemplateVisibility) => void;
}) {
  const { t } = useTranslation();
  const descriptionId = `custom-template-${templateId}-visibility`;
  return (
    <DropdownMenuRadioGroup
      value={visibility}
      onValueChange={(next: UserTemplateVisibility) => {
        if (next !== visibility) {
          onChange(next);
        }
      }}
      aria-label={t(($) => {
        return $.templates.visibility.change;
      })}
    >
      {VISIBILITY_OPTIONS.map((value) => {
        const Icon = value === "private" ? Lock : Users;
        const label =
          value === "private"
            ? t(($) => {
                return $.templates.visibility.private;
              })
            : t(($) => {
                return $.templates.visibility.organization;
              });
        return (
          <DropdownMenuRadioItem
            key={value}
            value={value}
            label={label}
            aria-label={label}
            aria-describedby={`${descriptionId}-${value}`}
            closeOnClick
            className="w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left data-checked:bg-state-selected"
          >
            <Icon
              size={16}
              className="mt-0.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-foreground">{label}</span>
              <span
                id={`${descriptionId}-${value}`}
                className="block text-xs text-muted-foreground"
              >
                {value === "private"
                  ? t(($) => {
                      return $.templates.visibility.privateState;
                    })
                  : t(($) => {
                      return $.templates.visibility.organizationState;
                    })}
              </span>
            </span>
            {/* Reserve the check column so descriptions do not reflow. */}
            <span className="mt-0.5 w-4 shrink-0">
              <DropdownMenuRadioItemIndicator>
                <Check size={16} className="text-foreground" aria-hidden />
              </DropdownMenuRadioItemIndicator>
            </span>
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

/**
 * Visibility states the access level, with a sentence below explaining what
 * the level allows. The whole block opens the picker.
 */
function CustomTemplateVisibilityControl({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const updateTemplate = useSet(updateCustomTemplate$);
  return (
    <TemplateDetailAccess
      icon={detail.visibility === "private" ? Lock : Users}
      level={
        detail.visibility === "private"
          ? t(($) => {
              return $.templates.visibility.private;
            })
          : t(($) => {
              return $.templates.visibility.organization;
            })
      }
      consequence={
        detail.visibility === "private"
          ? t(($) => {
              return $.templates.visibility.privateState;
            })
          : t(($) => {
              return $.templates.visibility.organizationState;
            })
      }
      triggerLabel={t(($) => {
        return $.artifacts.templates.visibility.changeLabel;
      })}
    >
      <VisibilityOptionList
        templateId={detail.id}
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
    </TemplateDetailAccess>
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
export function CustomTemplateTitleInput({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [saveLoadable, updateTemplate] = useLoadableSet(updateCustomTemplate$);
  const saving = saveLoadable.state === "loading";
  const rename = (nextTitle: string) => {
    const normalized = normalizeTemplateTitle(nextTitle);
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
      {/* Re-keyed on the stored title so the server's own normalisation
          replaces what was typed, once it is stored. A save that failed did
          not change the title, which is what leaves the rejected text in the
          field to be corrected and sent again. */}
      <div
        key={detail.title}
        className={TEMPLATE_DETAIL_TITLE_FIELD}
        data-value={detail.title}
      >
        <textarea
          defaultValue={detail.title}
          disabled={saving}
          rows={1}
          maxLength={255}
          aria-label={t(($) => {
            return $.templates.actions.rename;
          })}
          className={TEMPLATE_DETAIL_TITLE_TEXTAREA}
          onChange={(event) => {
            // The field always renders inside the mirror that sizes it.
            const mirror = event.currentTarget.parentElement!;
            mirror.dataset.value = event.currentTarget.value;
          }}
          onBlur={(event) => {
            rename(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </div>
      {saveLoadable.state === "hasError" ? (
        <span role="alert" className="shrink-0 text-xs text-destructive">
          {t(($) => {
            return $.templates.renameFailed;
          })}
        </span>
      ) : null}
    </>
  );
}

export function CustomTemplateDetailSidebar({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  return (
    <div className="-mx-2 flex min-h-0 flex-col gap-5 px-2 lg:overflow-y-auto">
      {detail.kind === "presentation" ? (
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.artifacts.templates.importedSlides;
            },
            { count: detail.pageUrls.length },
          )}
        </p>
      ) : null}
      {detail.canManage ? (
        <CustomTemplateVisibilityControl detail={detail} />
      ) : (
        <TemplateDetailAccess
          icon={User}
          level={<SharedByLabel ownerDisplayName={detail.ownerDisplayName} />}
        />
      )}
    </div>
  );
}

/** The footer's way to be rid of a template, for the member who can manage it. */
export function CustomTemplateDeleteButton({
  detail,
}: {
  readonly detail: UserTemplateDetail;
}) {
  const { t } = useTranslation();
  const requestDelete = useSet(requestDeleteCustomTemplate$);
  return (
    <TemplateDetailDeleteButton
      label={t(($) => {
        return $.templates.actions.delete;
      })}
      onDelete={() => {
        requestDelete({ id: detail.id, title: detail.title });
      }}
    />
  );
}
