import {
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  BROWSER_USER_ACTION_MAX_FILE_BYTES,
  BROWSER_USER_ACTION_MAX_FILES,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { cn } from "@okouai/ui";
import { Button } from "@okouai/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@okouai/ui/components/ui/dialog";
import { Input } from "@okouai/ui/components/ui/input";
import { Textarea } from "@okouai/ui/components/ui/textarea";
import { useGet, useLastLoadable, useSet, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Loader2,
  XCircle,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  fileDraftIsValid,
  type BrowserCheckboxDraft,
  type BrowserColorDraft,
  type BrowserFileDraft,
  type BrowserRadioDraft,
  type BrowserRangeDraft,
  type BrowserSelectChoiceDraft,
  type BrowserInputEntry,
  type BrowserUserActionRequestState,
  type BrowserUserActionSignals,
} from "../../signals/chat-page/browser-user-action-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, isAbortError, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

export type BrowserUserActionCardVariant = "inline" | "standalone";

function BrowserActionSurface({
  children,
  variant,
}: {
  readonly children: ReactNode;
  readonly variant: BrowserUserActionCardVariant;
}) {
  return (
    <div
      className={
        variant === "standalone"
          ? "@container w-full"
          : "@container w-full max-w-xl"
      }
    >
      <ChatCard
        data-testid="browser-user-action-card"
        className={
          variant === "standalone"
            ? "w-full p-5 sm:p-6"
            : "h-[160px] w-full p-2 @[320px]:h-[136px] @[380px]:h-[112px] @[380px]:p-2.5 @[520px]:h-[80px]"
        }
      >
        {children}
      </ChatCard>
    </div>
  );
}

function ActionState({
  description,
  icon,
  title,
  action,
  variant,
}: {
  readonly description?: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly action?: ReactNode;
  readonly variant: BrowserUserActionCardVariant;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col justify-center gap-2",
        variant === "inline"
          ? "h-full @[520px]:flex-row @[520px]:items-center @[520px]:justify-between @[520px]:gap-3"
          : "min-h-20 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
      )}
      role="status"
    >
      <div className="flex min-w-0 max-w-full items-start gap-2.5 @[520px]:flex-1">
        <span className="mt-1 shrink-0 text-brand-text [&>svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0 max-w-sm">
          <div
            className={cn(
              "text-[0.9375rem] font-medium text-foreground",
              variant === "inline" &&
                (action ? "line-clamp-2 @[380px]:truncate" : "line-clamp-2"),
            )}
          >
            {title}
          </div>
          {description && (
            <p
              className={cn(
                "mt-0.5 text-sm leading-5 text-muted-foreground",
                variant === "inline" &&
                  (action ? "line-clamp-1" : "line-clamp-2"),
              )}
            >
              {description}
            </p>
          )}
        </div>
      </div>
      {action && (
        <div
          className={cn(
            "shrink-0 self-start",
            variant === "inline"
              ? "pl-[26px] @[520px]:ml-auto @[520px]:self-auto @[520px]:pl-0"
              : "pl-[26px] sm:ml-auto sm:self-auto sm:pl-0",
          )}
        >
          {action}
        </div>
      )}
    </div>
  );
}

function TerminalActionState({
  callbackDelivered,
  cancelled,
  variant,
}: {
  readonly callbackDelivered: boolean;
  readonly cancelled: boolean;
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  return (
    <ActionState
      icon={
        cancelled ? (
          <XCircle size={20} />
        ) : (
          <CheckCircle2 size={20} className="text-emerald-600" />
        )
      }
      title={t(($) => {
        return callbackDelivered
          ? $.chat.browserInput.delivered
          : cancelled
            ? $.chat.browserInput.cancelled
            : $.chat.browserInput.completed;
      })}
      variant={variant}
    />
  );
}

function StateFromRequest({
  request,
  variant,
}: {
  readonly request: BrowserUserActionRequestState;
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  if (request.kind === "expired") {
    return (
      <ActionState
        icon={<AlertCircle size={20} />}
        title={t(($) => {
          return $.chat.browserInput.expired;
        })}
        description={t(($) => {
          return $.chat.browserInput.expiredDescription;
        })}
        variant={variant}
      />
    );
  }
  if (request.kind === "unavailable") {
    return (
      <ActionState
        icon={<AlertCircle size={20} />}
        title={t(($) => {
          return $.chat.browserInput.unavailable;
        })}
        description={t(($) => {
          return $.chat.browserAction.unavailableDescription;
        })}
        variant={variant}
      />
    );
  }

  const { action } = request;
  if (action.state === "applying") {
    return (
      <ActionState
        icon={<Loader2 size={20} className="animate-spin" />}
        title={t(($) => {
          return $.chat.browserInput.applying;
        })}
        description={t(($) => {
          return $.chat.browserInput.applyingDescription;
        })}
        variant={variant}
      />
    );
  }
  if (action.state === "stale") {
    return (
      <ActionState
        icon={<AlertCircle size={20} />}
        title={t(($) => {
          return $.chat.browserInput.stale;
        })}
        description={t(($) => {
          return $.chat.browserInput.staleDescription;
        })}
        variant={variant}
      />
    );
  }
  if (action.state === "uncertain") {
    return (
      <ActionState
        icon={<AlertCircle size={20} />}
        title={t(($) => {
          return $.chat.browserInput.uncertain;
        })}
        description={t(($) => {
          return $.chat.browserInput.uncertainDescription;
        })}
        variant={variant}
      />
    );
  }
  if (action.state === "succeeded" || action.state === "cancelled") {
    return (
      <TerminalActionState
        callbackDelivered={action.callbackDelivered === true}
        cancelled={action.state === "cancelled"}
        variant={variant}
      />
    );
  }
  return null;
}

type PendingBrowserInputAction = Extract<
  BrowserUserActionResponse,
  { readonly kind: "input" }
>;

interface PendingBrowserInputRequest {
  readonly kind: "action";
  readonly action: PendingBrowserInputAction;
}

function PendingFormHeader({
  action,
  compact = false,
  showTitle = true,
}: {
  readonly action: PendingBrowserInputAction;
  readonly compact?: boolean;
  readonly showTitle?: boolean;
}) {
  const { t } = useTranslation();
  const title =
    action.title ??
    t(($) => {
      return $.chat.browserInput.title;
    });
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full items-center",
        compact ? "gap-2.5 @[520px]:flex-1" : "gap-3",
      )}
    >
      <Globe
        size={16}
        className={cn(
          "shrink-0 self-start text-brand-text",
          showTitle && "mt-1",
        )}
      />
      <div className="min-w-0 max-w-sm">
        {showTitle && (
          <h2
            className={cn(
              "break-words text-[0.9375rem] font-medium text-foreground",
              compact && "line-clamp-2 @[380px]:truncate",
            )}
          >
            {title}
          </h2>
        )}
        {showTitle && !compact && action.reason !== undefined && (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {action.reason}
          </p>
        )}
        <div
          className={cn(
            "flex items-start gap-1.5 text-xs text-muted-foreground",
            showTitle && (compact ? "mt-1" : "mt-2"),
          )}
        >
          <span className="shrink-0 font-medium text-foreground">
            {t(($) => {
              return $.chat.browserInput.site;
            })}
          </span>
          <span className={cn("min-w-0", compact ? "truncate" : "break-all")}>
            {action.siteOrigin}
          </span>
        </div>
      </div>
    </div>
  );
}

function PendingFormDestination({
  action,
  showTitle,
}: {
  readonly action: PendingBrowserInputAction;
  readonly showTitle: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PendingFormHeader action={action} showTitle={showTitle} />
      {action.fields.some((field) => {
        return field.fieldKind === "file";
      }) && (
        <p className="text-xs text-muted-foreground" role="note">
          {t(($) => {
            return $.chat.browserInput.fileNotice;
          })}{" "}
          {action.siteOrigin}
        </p>
      )}
    </>
  );
}

function DraftClearingState({
  signals,
  children,
}: {
  readonly signals: BrowserUserActionSignals;
  readonly children: ReactNode;
}) {
  const clearDraftRef = useSet(signals.clearDraftRef$);
  return (
    <div ref={clearDraftRef} className="contents">
      {children}
    </div>
  );
}

type PendingBrowserInputField = PendingBrowserInputAction["fields"][number];

interface BrowserInputEditProps {
  readonly field: PendingBrowserInputField;
  readonly draft: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly onUpdate: (key: string, value: string) => void;
  readonly onRemove: (key: string) => void;
}

interface BrowserColorEditProps {
  readonly colorDraft: ReadonlyMap<string, BrowserColorDraft>;
  readonly onUpdateColor: (key: string, choice: BrowserColorDraft) => void;
  readonly onRemoveColor: (key: string) => void;
}

function BrowserInputControl({
  field,
  draft,
  busy,
  onUpdate,
  inputId,
  describedBy,
}: BrowserInputEditProps & {
  readonly inputId: string;
  readonly describedBy: string;
}) {
  const required = field.required || field.control.siteRequired;
  const maxLength = Math.min(
    field.control.maxLength ?? BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
    BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  );
  if (field.control.tagName === "TEXTAREA") {
    return (
      <Textarea
        id={inputId}
        name={field.key}
        aria-describedby={describedBy}
        required={required}
        minLength={field.control.minLength}
        maxLength={maxLength}
        value={draft.get(field.key) ?? ""}
        disabled={busy}
        onChange={(event) => {
          onUpdate(field.key, event.currentTarget.value);
        }}
      />
    );
  }
  return (
    <Input
      id={inputId}
      name={field.key}
      className={
        field.fieldKind === "date_time" ? "min-w-0 max-w-full" : undefined
      }
      type={
        field.fieldKind === "one_time_code" ? "text" : field.control.inputType
      }
      multiple={field.control.multiple}
      inputMode={field.fieldKind === "one_time_code" ? "numeric" : undefined}
      autoComplete={
        field.fieldKind === "one_time_code" ? "one-time-code" : "off"
      }
      aria-describedby={describedBy}
      required={required}
      minLength={field.control.minLength}
      maxLength={maxLength}
      pattern={field.control.pattern}
      min={
        ["number", "date_time"].includes(field.fieldKind)
          ? field.control.min
          : undefined
      }
      max={
        ["number", "date_time"].includes(field.fieldKind)
          ? field.control.max
          : undefined
      }
      step={
        ["number", "date_time"].includes(field.fieldKind)
          ? field.control.step
          : undefined
      }
      value={draft.get(field.key) ?? ""}
      disabled={busy}
      onChange={(event) => {
        const value = event.currentTarget.value;
        onUpdate(field.key, value);
      }}
    />
  );
}

function requiredRangesSatisfied(
  action: PendingBrowserInputAction,
  rangeDraft: ReadonlyMap<string, BrowserRangeDraft>,
): boolean {
  return action.fields.every((field) => {
    if (field.fieldKind !== "range") {
      return true;
    }
    const observed = field.control.rangeValue;
    if (!observed) {
      return false;
    }
    const choice = rangeDraft.get(field.key);
    return choice
      ? choice.observedValue === observed &&
          choice.observedMin === field.control.min &&
          choice.observedMax === field.control.max &&
          choice.observedStep === field.control.step &&
          choice.value.length > 0
      : !field.required && !field.control.siteRequired;
  });
}

function requiredColorsSatisfied(
  action: PendingBrowserInputAction,
  colorDraft: ReadonlyMap<string, BrowserColorDraft>,
): boolean {
  return action.fields.every((field) => {
    if (field.fieldKind !== "color") {
      return true;
    }
    const observed = field.control.colorValue;
    if (field.control.colorMode !== "opaque-srgb" || !observed) {
      return false;
    }
    const choice = colorDraft.get(field.key);
    return choice
      ? choice.observedColor === observed &&
          /^#[0-9a-f]{6}$/u.test(choice.value)
      : !field.required && !field.control.siteRequired;
  });
}

function requiredFilesSatisfied(
  action: PendingBrowserInputAction,
  fileDraft: ReadonlyMap<string, BrowserFileDraft>,
): boolean {
  return action.fields.every((field) => {
    return (
      field.fieldKind !== "file" ||
      fileDraftIsValid(field, fileDraft.get(field.key))
    );
  });
}

function BrowserFileActions({
  field,
  existing,
  draft,
  busy,
  onRemove,
}: {
  readonly field: PendingBrowserInputField;
  readonly existing: readonly {
    readonly name: string;
    readonly size: number;
  }[];
  readonly draft: BrowserFileDraft | undefined;
  readonly busy: boolean;
  readonly onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  return draft && (existing.length > 0 || !field.required) ? (
    <Button
      type="button"
      size="xs"
      variant="link"
      disabled={busy}
      onClick={() => {
        return onRemove(field.key);
      }}
    >
      {t(($) => {
        return $.chat.browserInput.fileLeave;
      })}
    </Button>
  ) : null;
}

function BrowserFileControl({
  field,
  fileDraft,
  busy,
  inputId,
  describedBy,
  onUpdate,
  onRemove,
}: {
  readonly field: PendingBrowserInputField;
  readonly fileDraft: ReadonlyMap<string, BrowserFileDraft>;
  readonly busy: boolean;
  readonly inputId: string;
  readonly describedBy: string;
  readonly onUpdate: (key: string, draft: BrowserFileDraft) => void;
  readonly onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  const fingerprint = field.control.fileSetFingerprint;
  const existing = field.control.files ?? [];
  const draft = fileDraft.get(field.key);
  const selected =
    draft?.operation === "clear"
      ? []
      : draft?.operation === "replace"
        ? draft.files
        : existing;
  const limit =
    draft?.operation === "replace" &&
    (draft.files.length >
      (field.control.multiple ? BROWSER_USER_ACTION_MAX_FILES : 1) ||
      draft.files.reduce((sum, file) => {
        return sum + file.size;
      }, 0) > BROWSER_USER_ACTION_MAX_FILE_BYTES);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Input
        key={draft?.operation ?? "untouched"}
        type="file"
        id={inputId}
        name={field.key}
        aria-describedby={describedBy}
        accept={field.control.accept}
        multiple={field.control.multiple}
        disabled={busy || !fingerprint}
        onChange={(event) => {
          if (!fingerprint) {
            return;
          }
          const files = [...(event.currentTarget.files ?? [])];
          if (files.length) {
            onUpdate(field.key, {
              operation: "replace",
              files,
              observedFingerprint: fingerprint,
            });
          }
        }}
      />
      {selected.length > 0 && (
        <p className="max-w-full break-all text-xs text-muted-foreground">
          ({selected.length}){" "}
          {selected
            .map((file) => {
              return `${file.name} (${file.size} B)`;
            })
            .join(", ")}
        </p>
      )}
      {limit && (
        <p role="alert" className="text-xs text-destructive">
          {t(($) => {
            return $.chat.browserInput.fileLimit;
          })}
        </p>
      )}
      <BrowserFileActions
        field={field}
        existing={existing}
        draft={draft}
        busy={busy}
        onRemove={onRemove}
      />
    </div>
  );
}

function requiredSelectsSatisfied(
  action: PendingBrowserInputAction,
  choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>,
): boolean {
  return action.fields.every((field) => {
    if (field.fieldKind !== "select") {
      return true;
    }
    const saved = choiceDraft.get(field.key);
    const choice =
      saved?.optionSetFingerprint === field.control.optionSetFingerprint
        ? saved
        : undefined;
    if (!field.required && !field.control.siteRequired) {
      return true;
    }
    const options = field.control.options;
    if (!options) {
      return false;
    }
    const selected =
      choice?.optionIndexes ??
      options
        .filter((option) => {
          return option.selected;
        })
        .map((option) => {
          return option.index;
        });
    return (
      selected.every((index) => {
        const option = options[index];
        return option && !option.disabled;
      }) &&
      selected.some((index) => {
        const option = options[index];
        return option && !option.disabled && !option.empty;
      })
    );
  });
}

function radioChoiceIsValid(
  options: NonNullable<PendingBrowserInputField["control"]["radioOptions"]>,
  selectedIndex: number,
  choice: BrowserRadioDraft | undefined,
): boolean {
  if (!choice) {
    return true;
  }
  if (
    choice.memberIndex >= options.length ||
    options[choice.memberIndex]?.disabled
  ) {
    return false;
  }
  return (
    choice.memberIndex !== -1 ||
    selectedIndex === -1 ||
    !options[selectedIndex]?.disabled
  );
}

function requiredRadiosSatisfied(
  action: PendingBrowserInputAction,
  radioDraft: ReadonlyMap<string, BrowserRadioDraft>,
): boolean {
  return action.fields.every((field) => {
    if (field.fieldKind !== "radio") {
      return true;
    }
    const options = field.control.radioOptions;
    const fingerprint = field.control.radioGroupFingerprint;
    if (!options || !fingerprint) {
      return false;
    }
    const selectedIndex = options.findIndex((option) => {
      return option.selected;
    });
    const saved = radioDraft.get(field.key);
    const choice =
      saved?.groupFingerprint === fingerprint &&
      saved.observedSelectedIndex === selectedIndex
        ? saved
        : undefined;
    if (!radioChoiceIsValid(options, selectedIndex, choice)) {
      return false;
    }
    return (
      !(field.required || field.control.siteRequired) ||
      ((choice?.memberIndex ?? selectedIndex) >= 0 &&
        !options[choice?.memberIndex ?? selectedIndex]?.disabled)
    );
  });
}

function requiredCheckboxesSatisfied(
  action: PendingBrowserInputAction,
  checkboxDraft: ReadonlyMap<string, BrowserCheckboxDraft>,
): boolean {
  return action.fields.every((field) => {
    if (field.fieldKind !== "checkbox") {
      return true;
    }
    const observed = field.control.checked;
    if (observed === undefined) {
      return false;
    }
    const saved = checkboxDraft.get(field.key);
    const choice = saved?.observedChecked === observed ? saved : undefined;
    return (
      !(field.required || field.control.siteRequired) ||
      (choice?.checked ?? observed)
    );
  });
}

function selectedSelectIndices(
  field: PendingBrowserInputField,
  choice: BrowserSelectChoiceDraft | undefined,
): readonly number[] {
  if (
    choice &&
    choice.optionSetFingerprint === field.control.optionSetFingerprint
  ) {
    return choice.optionIndexes;
  }
  return (
    field.control.options
      ?.filter((option) => {
        return option.selected;
      })
      .map((option) => {
        return option.index;
      }) ?? []
  );
}

function selectedEnabledOptionIndices(control: HTMLSelectElement): number[] {
  return [...control.selectedOptions]
    .filter((option) => {
      return !option.disabled && option.value !== "";
    })
    .map((option) => {
      return Number(option.value);
    });
}

function BrowserSelectControl({
  field,
  choiceDraft,
  busy,
  inputId,
  describedBy,
  onUpdate,
  onRemove,
}: {
  readonly field: PendingBrowserInputField;
  readonly choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>;
  readonly busy: boolean;
  readonly inputId: string;
  readonly describedBy: string;
  readonly onUpdate: (
    key: string,
    indices: readonly number[],
    optionSetFingerprint: string,
  ) => void;
  readonly onRemove: (key: string) => void;
}) {
  const options = field.control.options;
  const ready =
    options !== undefined && field.control.optionSetFingerprint !== undefined;
  const selected = selectedSelectIndices(field, choiceDraft.get(field.key));
  const siteSelected = selectedSelectIndices(field, undefined);
  const multiple = field.control.inputType === "select-multiple";
  const required = field.required || field.control.siteRequired;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <select
        id={inputId}
        name={field.key}
        aria-describedby={describedBy}
        className={cn(
          "w-full rounded-lg border border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50",
          multiple ? "min-h-24" : "h-9",
        )}
        multiple={multiple}
        size={multiple ? Math.min(options?.length ?? 2, 5) : undefined}
        required={required}
        disabled={busy || !ready}
        value={
          multiple ? selected.map(String) : (selected[0]?.toString() ?? "")
        }
        onChange={(event) => {
          if (!field.control.optionSetFingerprint) {
            return;
          }
          const selection = selectedEnabledOptionIndices(event.currentTarget);
          if (
            selection.length === siteSelected.length &&
            selection.every((index, position) => {
              return index === siteSelected[position];
            })
          ) {
            onRemove(field.key);
          } else {
            onUpdate(field.key, selection, field.control.optionSetFingerprint);
          }
        }}
      >
        {!multiple && (
          <option value="" disabled={required}>
            —
          </option>
        )}
        {options?.map((option) => {
          return (
            <option
              key={option.index}
              value={String(option.index)}
              disabled={option.disabled}
            >
              {option.label || "—"}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function BrowserRadioControl({
  field,
  radioDraft,
  busy,
  inputId,
  describedBy,
  onUpdate,
  onRemove,
}: {
  readonly field: PendingBrowserInputField;
  readonly radioDraft: ReadonlyMap<string, BrowserRadioDraft>;
  readonly busy: boolean;
  readonly inputId: string;
  readonly describedBy: string;
  readonly onUpdate: (key: string, choice: BrowserRadioDraft) => void;
  readonly onRemove: (key: string) => void;
}) {
  const options = field.control.radioOptions;
  const fingerprint = field.control.radioGroupFingerprint;
  if (!options || !fingerprint) {
    return null;
  }
  const observed = options.findIndex((option) => {
    return option.selected;
  });
  const draft = radioDraft.get(field.key);
  const choice =
    draft?.groupFingerprint === fingerprint &&
    draft.observedSelectedIndex === observed
      ? draft.memberIndex
      : observed;
  const required = field.required || field.control.siteRequired;
  const firstEnabled = options.findIndex((option) => {
    return !option.disabled;
  });
  return (
    <div
      role="radiogroup"
      aria-labelledby={`${inputId}-label`}
      aria-describedby={describedBy}
      className="flex max-w-full flex-col gap-2"
    >
      {options.map((option) => {
        return (
          <label
            key={option.index}
            className="flex min-w-0 max-w-full items-start gap-2 text-sm"
          >
            <input
              id={option.index === 0 ? inputId : undefined}
              name={`browser-radio-${inputId}`}
              type="radio"
              value={String(option.index)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={choice === option.index}
              required={required && option.index === firstEnabled}
              disabled={busy || option.disabled}
              onChange={() => {
                if (option.index === observed) {
                  onRemove(field.key);
                } else {
                  onUpdate(field.key, {
                    memberIndex: option.index,
                    observedSelectedIndex: observed,
                    groupFingerprint: fingerprint,
                  });
                }
              }}
            />
            <span className="min-w-0 break-words">
              {option.index + 1}. {option.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}

function BrowserCheckboxControl({
  field,
  checkboxDraft,
  busy,
  inputId,
  describedBy,
  onUpdate,
  onRemove,
}: {
  readonly field: PendingBrowserInputField;
  readonly checkboxDraft: ReadonlyMap<string, BrowserCheckboxDraft>;
  readonly busy: boolean;
  readonly inputId: string;
  readonly describedBy: string;
  readonly onUpdate: (
    key: string,
    checked: boolean,
    observedChecked: boolean,
  ) => void;
  readonly onRemove: (key: string) => void;
}) {
  const observed = field.control.checked;
  const choice = checkboxDraft.get(field.key);
  const checked =
    choice && choice.observedChecked === observed
      ? choice.checked
      : observed === true;
  const required = field.required || field.control.siteRequired;
  return (
    <div className="flex max-w-full flex-wrap items-center gap-2">
      <input
        id={inputId}
        name={field.key}
        type="checkbox"
        aria-describedby={describedBy}
        className="size-4 shrink-0 accent-primary"
        checked={checked}
        required={required}
        disabled={busy || observed === undefined}
        onChange={(event) => {
          if (observed !== undefined) {
            if (event.currentTarget.checked === observed) {
              onRemove(field.key);
            } else {
              onUpdate(field.key, event.currentTarget.checked, observed);
            }
          }
        }}
      />
    </div>
  );
}

function BrowserInputFieldHeader({
  field,
  inputId,
  requirementId,
  descriptionId,
}: {
  readonly field: PendingBrowserInputField;
  readonly inputId: string;
  readonly requirementId: string;
  readonly descriptionId: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-baseline gap-1 text-sm text-foreground">
        <label
          id={`${inputId}-label`}
          htmlFor={inputId}
          className="min-w-0 break-words font-medium"
        >
          {field.label}
        </label>
        <span
          id={requirementId}
          className="text-xs font-normal text-muted-foreground"
        >
          {field.required || field.control.siteRequired
            ? t(($) => {
                return $.chat.browserInput.required;
              })
            : t(($) => {
                return $.chat.browserInput.optional;
              })}
        </span>
      </div>
      {field.description && (
        <span
          id={descriptionId}
          className="min-w-0 break-words text-xs font-normal leading-4 text-muted-foreground"
        >
          {field.description}
        </span>
      )}
    </>
  );
}

function BrowserRangeControl({
  field,
  rangeDraft,
  busy,
  inputId,
  describedBy,
  onUpdate,
  onRemove,
}: {
  readonly field: PendingBrowserInputField;
  readonly rangeDraft: ReadonlyMap<string, BrowserRangeDraft>;
  readonly busy: boolean;
  readonly inputId: string;
  readonly describedBy: string;
  readonly onUpdate: (key: string, choice: BrowserRangeDraft) => void;
  readonly onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  const observed = field.control.rangeValue;
  if (!observed) {
    return null;
  }
  const saved = rangeDraft.get(field.key);
  const choice =
    saved?.observedValue === observed &&
    saved.observedMin === field.control.min &&
    saved.observedMax === field.control.max &&
    saved.observedStep === field.control.step
      ? saved
      : undefined;
  const required = field.required || field.control.siteRequired;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-3">
        <input
          id={inputId}
          type="range"
          className="min-w-0 flex-1 accent-primary"
          aria-describedby={describedBy}
          min={field.control.min ?? "0"}
          max={field.control.max ?? "100"}
          step={field.control.step ?? "1"}
          value={choice?.value ?? observed}
          disabled={busy}
          onChange={(event) => {
            if (event.currentTarget.value === observed && !required) {
              onRemove(field.key);
            } else {
              onUpdate(field.key, {
                observedValue: observed,
                observedMin: field.control.min,
                observedMax: field.control.max,
                observedStep: field.control.step,
                value: event.currentTarget.value,
              });
            }
          }}
        />
        <output htmlFor={inputId} className="min-w-12 text-right tabular-nums">
          {choice?.value ?? observed}
        </output>
      </div>
      {required && !choice ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto self-start p-0 text-xs"
          disabled={busy}
          onClick={() => {
            onUpdate(field.key, {
              observedValue: observed,
              observedMin: field.control.min,
              observedMax: field.control.max,
              observedStep: field.control.step,
              value: observed,
            });
          }}
        >
          {t(($) => {
            return $.chat.browserInput.confirmRangeValue;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function BrowserColorControl({
  field,
  colorDraft,
  busy,
  inputId,
  describedBy,
  onUpdate,
  onRemove,
}: {
  readonly field: PendingBrowserInputField;
  readonly colorDraft: ReadonlyMap<string, BrowserColorDraft>;
  readonly busy: boolean;
  readonly inputId: string;
  readonly describedBy: string;
  readonly onUpdate: (key: string, choice: BrowserColorDraft) => void;
  readonly onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  const observed = field.control.colorValue;
  if (field.control.colorMode !== "opaque-srgb" || !observed) {
    return null;
  }
  const saved = colorDraft.get(field.key);
  const choice = saved?.observedColor === observed ? saved : undefined;
  const required = field.required || field.control.siteRequired;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <input
          id={inputId}
          type="color"
          className="h-10 w-16 min-w-0 cursor-pointer rounded border border-border bg-input p-1 disabled:cursor-not-allowed"
          aria-describedby={describedBy}
          value={choice?.value ?? observed}
          disabled={busy}
          onChange={(event) => {
            if (event.currentTarget.value === observed && !required) {
              onRemove(field.key);
            } else {
              onUpdate(field.key, {
                observedColor: observed,
                value: event.currentTarget.value,
              });
            }
          }}
        />
        <output
          htmlFor={inputId}
          className="min-w-0 break-all font-mono text-sm tabular-nums"
        >
          {choice?.value ?? observed}
        </output>
      </div>
      {required && !choice ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto self-start p-0 text-xs"
          disabled={busy}
          onClick={() => {
            return onUpdate(field.key, {
              observedColor: observed,
              value: observed,
            });
          }}
        >
          {t(($) => {
            return $.chat.browserInput.confirmRangeValue;
          })}
        </Button>
      ) : null}
    </div>
  );
}

type BrowserInputFieldControlProps = BrowserInputEditProps &
  BrowserColorEditProps & {
    readonly radioDraft: ReadonlyMap<string, BrowserRadioDraft>;
    readonly rangeDraft: ReadonlyMap<string, BrowserRangeDraft>;
    readonly onUpdateRange: (key: string, choice: BrowserRangeDraft) => void;
    readonly onRemoveRange: (key: string) => void;
    readonly fileDraft: ReadonlyMap<string, BrowserFileDraft>;
    readonly onUpdateFile: (key: string, draft: BrowserFileDraft) => void;
    readonly onRemoveFile: (key: string) => void;
    readonly onUpdateRadio: (key: string, choice: BrowserRadioDraft) => void;
    readonly onRemoveRadio: (key: string) => void;
    readonly index: number;
    readonly choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>;
    readonly checkboxDraft: ReadonlyMap<string, BrowserCheckboxDraft>;
    readonly onUpdateCheckbox: (
      key: string,
      checked: boolean,
      observedChecked: boolean,
    ) => void;
    readonly onRemoveCheckbox: (key: string) => void;
    readonly onUpdateChoice: (
      key: string,
      indices: readonly number[],
      optionSetFingerprint: string,
    ) => void;
    readonly onRemoveChoice: (key: string) => void;
  };

function BrowserInputFieldControl({
  field,
  index,
  draft,
  choiceDraft,
  checkboxDraft,
  radioDraft,
  rangeDraft,
  colorDraft,
  fileDraft,
  busy,
  onUpdate,
  onRemove,
  onUpdateFile,
  onRemoveFile,
  onUpdateChoice,
  onRemoveChoice,
  onUpdateCheckbox,
  onRemoveCheckbox,
  onUpdateRadio,
  onRemoveRadio,
  onUpdateRange,
  onRemoveRange,
  onUpdateColor,
  onRemoveColor,
}: BrowserInputFieldControlProps) {
  const inputId = `browser-input-field-${index}`;
  const requirementId = `${inputId}-requirement`;
  const descriptionId = field.description
    ? `${inputId}-description`
    : undefined;
  const describedBy = descriptionId
    ? `${requirementId} ${descriptionId}`
    : requirementId;
  return (
    <>
      {field.fieldKind === "color" ? (
        <BrowserColorControl
          field={field}
          colorDraft={colorDraft}
          busy={busy}
          inputId={inputId}
          describedBy={describedBy}
          onUpdate={onUpdateColor}
          onRemove={onRemoveColor}
        />
      ) : field.fieldKind === "range" ? (
        <BrowserRangeControl
          field={field}
          rangeDraft={rangeDraft}
          busy={busy}
          inputId={inputId}
          describedBy={describedBy}
          onUpdate={onUpdateRange}
          onRemove={onRemoveRange}
        />
      ) : field.fieldKind === "file" ? (
        <BrowserFileControl
          field={field}
          fileDraft={fileDraft}
          busy={busy}
          inputId={inputId}
          describedBy={describedBy}
          onUpdate={onUpdateFile}
          onRemove={onRemoveFile}
        />
      ) : field.fieldKind === "radio" ? (
        <BrowserRadioControl
          field={field}
          radioDraft={radioDraft}
          busy={busy}
          inputId={inputId}
          describedBy={describedBy}
          onUpdate={onUpdateRadio}
          onRemove={onRemoveRadio}
        />
      ) : field.fieldKind === "checkbox" ? (
        <BrowserCheckboxControl
          field={field}
          inputId={inputId}
          describedBy={describedBy}
          checkboxDraft={checkboxDraft}
          busy={busy}
          onUpdate={onUpdateCheckbox}
          onRemove={onRemoveCheckbox}
        />
      ) : field.fieldKind === "select" ? (
        <BrowserSelectControl
          field={field}
          inputId={inputId}
          describedBy={describedBy}
          choiceDraft={choiceDraft}
          busy={busy}
          onUpdate={onUpdateChoice}
          onRemove={onRemoveChoice}
        />
      ) : (
        <BrowserInputControl
          field={field}
          inputId={inputId}
          describedBy={describedBy}
          draft={draft}
          busy={busy}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      )}
    </>
  );
}

function BrowserInputField(
  props: Parameters<typeof BrowserInputFieldControl>[0],
) {
  const { field, index } = props;
  const inputId = `browser-input-field-${index}`;
  const requirementId = `${inputId}-requirement`;
  const descriptionId = field.description
    ? `${inputId}-description`
    : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <BrowserInputFieldHeader
        field={field}
        inputId={inputId}
        requirementId={requirementId}
        descriptionId={descriptionId}
      />
      <BrowserInputFieldControl {...props} />
    </div>
  );
}

function BrowserInputFields({
  action,
  draft,
  choiceDraft,
  checkboxDraft,
  radioDraft,
  rangeDraft,
  colorDraft,
  fileDraft,
  busy,
  onUpdate,
  onRemove,
  onUpdateFile,
  onRemoveFile,
  onUpdateChoice,
  onRemoveChoice,
  onUpdateCheckbox,
  onRemoveCheckbox,
  onUpdateRadio,
  onRemoveRadio,
  onUpdateRange,
  onRemoveRange,
  onUpdateColor,
  onRemoveColor,
}: Omit<BrowserInputEditProps, "field"> &
  BrowserColorEditProps & {
    readonly action: PendingBrowserInputAction;
    readonly choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>;
    readonly checkboxDraft: ReadonlyMap<string, BrowserCheckboxDraft>;
    readonly radioDraft: ReadonlyMap<string, BrowserRadioDraft>;
    readonly rangeDraft: ReadonlyMap<string, BrowserRangeDraft>;
    readonly onUpdateRange: (key: string, choice: BrowserRangeDraft) => void;
    readonly onRemoveRange: (key: string) => void;
    readonly fileDraft: ReadonlyMap<string, BrowserFileDraft>;
    readonly onUpdateFile: (key: string, draft: BrowserFileDraft) => void;
    readonly onRemoveFile: (key: string) => void;
    readonly onUpdateRadio: (key: string, choice: BrowserRadioDraft) => void;
    readonly onRemoveRadio: (key: string) => void;
    readonly onUpdateCheckbox: (
      key: string,
      checked: boolean,
      observedChecked: boolean,
    ) => void;
    readonly onRemoveCheckbox: (key: string) => void;
    readonly onUpdateChoice: (
      key: string,
      indices: readonly number[],
      optionSetFingerprint: string,
    ) => void;
    readonly onRemoveChoice: (key: string) => void;
  }) {
  return (
    <div className="flex flex-col gap-4">
      {action.fields.map((field, index) => {
        return (
          <BrowserInputField
            key={field.key}
            field={field}
            index={index}
            draft={draft}
            choiceDraft={choiceDraft}
            checkboxDraft={checkboxDraft}
            radioDraft={radioDraft}
            rangeDraft={rangeDraft}
            colorDraft={colorDraft}
            fileDraft={fileDraft}
            busy={busy}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onUpdateFile={onUpdateFile}
            onRemoveFile={onRemoveFile}
            onUpdateChoice={onUpdateChoice}
            onRemoveChoice={onRemoveChoice}
            onUpdateCheckbox={onUpdateCheckbox}
            onRemoveCheckbox={onRemoveCheckbox}
            onUpdateRadio={onUpdateRadio}
            onRemoveRadio={onRemoveRadio}
            onUpdateRange={onUpdateRange}
            onRemoveRange={onRemoveRange}
            onUpdateColor={onUpdateColor}
            onRemoveColor={onRemoveColor}
          />
        );
      })}
    </div>
  );
}

function PendingFormActions({
  busy,
  submitting,
  cancelling,
  canSubmit,
  onCancel,
}: {
  readonly busy: boolean;
  readonly submitting: boolean;
  readonly cancelling: boolean;
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-xs leading-5 text-muted-foreground">
        {t(($) => {
          return $.chat.browserInput.submitDescription;
        })}
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelling && <Loader2 size={16} className="animate-spin" />}
          {cancelling
            ? t(($) => {
                return $.chat.browserInput.cancelling;
              })
            : t(($) => {
                return $.chat.browserInput.cancel;
              })}
        </Button>
        <Button type="submit" disabled={busy || !canSubmit}>
          {submitting && <Loader2 size={16} className="animate-spin" />}
          {submitting
            ? t(($) => {
                return $.chat.browserInput.submitting;
              })
            : t(($) => {
                return $.chat.browserInput.submit;
              })}
        </Button>
      </div>
    </>
  );
}

type BrowserInputEntryLoadable = Loadable<BrowserInputEntry>;

function PendingFormPreflight({
  entry,
}: {
  readonly entry: BrowserInputEntryLoadable;
}) {
  const { t } = useTranslation();
  if (entry.state === "loading") {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 size={16} className="animate-spin" />
        {t(($) => {
          return $.chat.browserInput.loadingDescription;
        })}
      </p>
    );
  }
  if (entry.state === "hasError" || entry.data.kind !== "ready") {
    return (
      <div className="flex flex-wrap items-center gap-2" role="alert">
        <p className="text-sm text-destructive">
          {t(($) => {
            return entry.state === "hasData" && entry.data.kind === "rejected"
              ? $.chat.browserInput.applyFailed
              : $.chat.browserInput.checkFailed;
          })}
        </p>
      </div>
    );
  }
  return null;
}

function readyEntryAction(entry: BrowserInputEntryLoadable) {
  return entry.state === "hasData" && entry.data.kind === "ready"
    ? entry.data.action
    : null;
}

function entryCannotSubmit(entry: BrowserInputEntryLoadable): boolean {
  return (
    entry.state === "hasError" ||
    (entry.state === "hasData" && entry.data.kind !== "ready")
  );
}

/** A cancelled owner is not a failed write. */
function mutationFailed(mutation: {
  readonly state: string;
  readonly error?: unknown;
}): boolean {
  return mutation.state === "hasError" && !isAbortError(mutation.error);
}

function hasNativeBrowserInputs(action: PendingBrowserInputAction): boolean {
  return action.fields.some((field) => {
    return ["select", "checkbox", "radio", "range", "color", "file"].includes(
      field.fieldKind,
    );
  });
}

interface PendingFormProps {
  readonly signals: BrowserUserActionSignals;
  readonly request: PendingBrowserInputRequest;
  readonly showTitle?: boolean;
}

function PendingForm({ signals, request, showTitle = true }: PendingFormProps) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const draft = useGet(signals.draft$);
  const choiceDraft = useGet(signals.choiceDraft$);
  const checkboxDraft = useGet(signals.checkboxDraft$);
  const radioDraft = useGet(signals.radioDraft$);
  const rangeDraft = useGet(signals.rangeDraft$);
  const colorDraft = useGet(signals.colorDraft$);
  const fileDraft = useGet(signals.fileDraft$);
  // Keep the settled check while a notification re-reads the request.
  const entry = useLastLoadable(signals.entry$);
  const updateDraft = useSet(signals.updateDraft$);
  const removeDraft = useSet(signals.removeDraft$);
  const updateChoiceDraft = useSet(signals.updateChoiceDraft$);
  const removeChoiceDraft = useSet(signals.removeChoiceDraft$);
  const updateCheckboxDraft = useSet(signals.updateCheckboxDraft$);
  const removeCheckboxDraft = useSet(signals.removeCheckboxDraft$);
  const updateRadioDraft = useSet(signals.updateRadioDraft$);
  const removeRadioDraft = useSet(signals.removeRadioDraft$);
  const updateRangeDraft = useSet(signals.updateRangeDraft$);
  const removeRangeDraft = useSet(signals.removeRangeDraft$);
  const updateColorDraft = useSet(signals.updateColorDraft$);
  const removeColorDraft = useSet(signals.removeColorDraft$);
  const updateFileDraft = useSet(signals.updateFileDraft$);
  const removeFileDraft = useSet(signals.removeFileDraft$);
  const formRef = useSet(signals.formRef$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [cancelLoadable, cancel] = useLoadableSet(signals.cancel$);
  const submitting = submitLoadable.state === "loading";
  const cancelling = cancelLoadable.state === "loading";
  const busy = submitting || cancelling;
  const cancelFailed = mutationFailed(cancelLoadable);
  const failed = mutationFailed(submitLoadable) || cancelFailed;
  const entryAction = readyEntryAction(entry);
  const entryUnavailable = entryCannotSubmit(entry);
  const activeAction = entryAction ?? request.action;
  const selectValuesValid = requiredSelectsSatisfied(activeAction, choiceDraft);
  const checkboxValuesValid = requiredCheckboxesSatisfied(
    activeAction,
    checkboxDraft,
  );
  const radioValuesValid = requiredRadiosSatisfied(activeAction, radioDraft);
  const rangeValuesValid = requiredRangesSatisfied(activeAction, rangeDraft);
  const colorValuesValid = requiredColorsSatisfied(activeAction, colorDraft);
  const fileValuesValid = requiredFilesSatisfied(activeAction, fileDraft);
  const fieldsValid =
    selectValuesValid &&
    checkboxValuesValid &&
    radioValuesValid &&
    rangeValuesValid &&
    colorValuesValid &&
    fileValuesValid;
  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fieldsValid || !event.currentTarget.reportValidity()) {
      return;
    }
    detach(submit(activeAction, pageSignal), Reason.DomCallback);
  };

  return (
    <form
      ref={formRef}
      autoComplete="off"
      className="flex flex-col gap-5"
      aria-label={
        activeAction.title ??
        t(($) => {
          return $.chat.browserInput.title;
        })
      }
      onSubmit={submitForm}
    >
      <PendingFormDestination action={activeAction} showTitle={showTitle} />
      <BrowserInputFields
        action={activeAction}
        draft={draft}
        choiceDraft={choiceDraft}
        checkboxDraft={checkboxDraft}
        radioDraft={radioDraft}
        rangeDraft={rangeDraft}
        colorDraft={colorDraft}
        fileDraft={fileDraft}
        busy={busy}
        onUpdate={updateDraft}
        onRemove={removeDraft}
        onUpdateFile={updateFileDraft}
        onRemoveFile={removeFileDraft}
        onUpdateChoice={updateChoiceDraft}
        onRemoveChoice={removeChoiceDraft}
        onUpdateCheckbox={updateCheckboxDraft}
        onRemoveCheckbox={removeCheckboxDraft}
        onUpdateRadio={updateRadioDraft}
        onRemoveRadio={removeRadioDraft}
        onUpdateRange={updateRangeDraft}
        onRemoveRange={removeRangeDraft}
        onUpdateColor={updateColorDraft}
        onRemoveColor={removeColorDraft}
      />

      <PendingFormPreflight entry={entry} />

      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return cancelFailed
              ? $.chat.browserInput.cancelFailed
              : $.chat.browserInput.applyFailed;
          })}
        </p>
      )}

      <PendingFormActions
        busy={busy}
        submitting={submitting}
        cancelling={cancelling}
        canSubmit={
          !entryUnavailable &&
          fieldsValid &&
          (!hasNativeBrowserInputs(request.action) || entryAction !== null)
        }
        onCancel={() => {
          detach(cancel(pageSignal), Reason.DomCallback);
        }}
      />
    </form>
  );
}

function PendingFormWithCheck({
  signals,
  request,
  showTitle = true,
}: PendingFormProps) {
  const entry = useLastLoadable(signals.entry$);
  return (
    <PendingForm
      signals={signals}
      request={{
        ...request,
        action: readyEntryAction(entry) ?? request.action,
      }}
      showTitle={showTitle}
    />
  );
}

function PendingInlineAction({
  signals,
  request,
}: {
  readonly signals: BrowserUserActionSignals;
  readonly request: PendingBrowserInputRequest;
}) {
  const refreshEntry = useSet(signals.refreshEntry$);
  const { t } = useTranslation();
  const title =
    request.action.title ??
    t(($) => {
      return $.chat.browserInput.title;
    });
  return (
    <div className="flex h-full w-full flex-col justify-center gap-2 @[520px]:flex-row @[520px]:items-center @[520px]:justify-between @[520px]:gap-3">
      <PendingFormHeader action={request.action} compact />
      <div className="shrink-0 self-start pl-[26px] @[520px]:ml-auto @[520px]:self-auto @[520px]:pl-0">
        <Dialog
          onOpenChange={(nextOpen) => {
            // Opening the form checks the website again.
            if (nextOpen) {
              refreshEntry();
            }
          }}
        >
          <DialogTrigger
            render={
              <Button type="button" variant="outline" size="sm">
                {t(($) => {
                  return $.chat.browserInput.open;
                })}
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="break-words">{title}</DialogTitle>
              {request.action.reason !== undefined && (
                <DialogDescription className="whitespace-pre-wrap break-words">
                  {request.action.reason}
                </DialogDescription>
              )}
            </DialogHeader>
            <PendingFormWithCheck
              signals={signals}
              request={request}
              showTitle={false}
            />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function ApplyingState({
  variant,
}: {
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  return (
    <ActionState
      icon={<Loader2 size={20} className="animate-spin" />}
      title={t(($) => {
        return $.chat.browserInput.checkingOutcome;
      })}
      description={t(($) => {
        return $.chat.browserInput.checkingOutcomeDescription;
      })}
      variant={variant}
    />
  );
}

function BrowserUserActionCardContent({
  requestLoadable,
  signals,
  variant,
}: {
  readonly requestLoadable: Loadable<BrowserUserActionRequestState>;
  readonly signals: BrowserUserActionSignals;
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  let content: ReactNode;
  if (
    requestLoadable.state === "hasData" &&
    requestLoadable.data.kind === "action" &&
    requestLoadable.data.action.state === "applying"
  ) {
    content = <ApplyingState variant={variant} />;
  } else if (requestLoadable.state === "loading") {
    content = (
      <ActionState
        icon={<Loader2 size={20} className="animate-spin" />}
        title={t(($) => {
          return $.chat.browserAction.loading;
        })}
        variant={variant}
      />
    );
  } else if (requestLoadable.state === "hasError") {
    content = (
      <ActionState
        icon={<AlertCircle size={20} />}
        title={t(($) => {
          return $.chat.browserInput.loadFailed;
        })}
        description={t(($) => {
          return $.chat.browserInput.loadFailedDescription;
        })}
        variant={variant}
      />
    );
  } else if (
    requestLoadable.data.kind === "action" &&
    requestLoadable.data.action.kind === "input" &&
    requestLoadable.data.action.state === "pending"
  ) {
    const pendingRequest: PendingBrowserInputRequest = {
      kind: "action",
      action: requestLoadable.data.action,
    };
    content =
      variant === "inline" ? (
        <PendingInlineAction signals={signals} request={pendingRequest} />
      ) : (
        <PendingFormWithCheck signals={signals} request={pendingRequest} />
      );
  } else {
    content = (
      <DraftClearingState signals={signals}>
        <StateFromRequest request={requestLoadable.data} variant={variant} />
      </DraftClearingState>
    );
  }
  return content;
}

export function BrowserUserActionCard({
  signals,
  variant = "inline",
}: {
  readonly signals: BrowserUserActionSignals;
  readonly variant?: BrowserUserActionCardVariant;
}) {
  // Keep the settled state while a notification re-reads it, so an open
  // dialog is not remounted by an unrelated change in the same thread.
  const requestLoadable = useLastLoadable(signals.request$);
  return (
    <BrowserActionSurface variant={variant}>
      <BrowserUserActionCardContent
        requestLoadable={requestLoadable}
        signals={signals}
        variant={variant}
      />
    </BrowserActionSurface>
  );
}

export function BrowserUserActionUnavailableCard({
  variant = "inline",
}: {
  readonly variant?: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  return (
    <BrowserActionSurface variant={variant}>
      <ActionState
        icon={<AlertCircle size={20} />}
        title={t(($) => {
          return $.chat.browserInput.unavailable;
        })}
        description={t(($) => {
          return $.chat.browserAction.unavailableDescription;
        })}
        variant={variant}
      />
    </BrowserActionSurface>
  );
}
