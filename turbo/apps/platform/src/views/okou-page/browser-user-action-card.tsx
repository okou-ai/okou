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
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@okouai/ui/components/ui/dialog";
import { Input } from "@okouai/ui/components/ui/input";
import { Textarea } from "@okouai/ui/components/ui/textarea";
import { useGet, useLoadable, useSet, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Loader2,
  XCircle,
} from "lucide-react";
import type { FormEvent, ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";

import {
  fileDraftIsValid,
  type BrowserCheckboxDraft,
  type BrowserFileDraft,
  type BrowserRadioDraft,
  type BrowserSelectChoiceDraft,
  type BrowserUserActionRequestState,
  type BrowserUserActionSignals,
} from "../../signals/chat-page/browser-user-action-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";

export type BrowserUserActionCardVariant = "inline" | "standalone";

function BrowserActionSurface({
  children,
  resumeRef,
  variant,
}: {
  readonly children: ReactNode;
  readonly resumeRef?: Ref<HTMLDivElement>;
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
        ref={resumeRef}
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
  callbackFailed,
  cancelled,
  continuing,
  onContinue,
  variant,
}: {
  readonly callbackDelivered: boolean;
  readonly callbackFailed: boolean;
  readonly cancelled: boolean;
  readonly continuing: boolean;
  readonly onContinue: () => void;
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  const callbackFailureDescription = t(($) => {
    return $.chat.browserInput.callbackFailed;
  });
  if (callbackDelivered) {
    return (
      <ActionState
        icon={<CheckCircle2 size={20} className="text-emerald-600" />}
        title={t(($) => {
          return $.chat.browserInput.delivered;
        })}
        variant={variant}
      />
    );
  }
  return (
    <ActionState
      icon={cancelled ? <XCircle size={20} /> : <CheckCircle2 size={20} />}
      title={t(($) => {
        return cancelled
          ? $.chat.browserInput.cancelled
          : $.chat.browserInput.completed;
      })}
      description={callbackFailed ? callbackFailureDescription : undefined}
      variant={variant}
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={continuing}
          onClick={onContinue}
        >
          {continuing && <Loader2 size={15} className="animate-spin" />}
          {continuing
            ? t(($) => {
                return $.chat.browserInput.continuing;
              })
            : callbackFailed
              ? t(($) => {
                  return $.chat.browserInput.retry;
                })
              : t(($) => {
                  return $.chat.browserInput.continue;
                })}
        </Button>
      }
    />
  );
}

function StateFromRequest({
  request,
  callbackDelivered,
  callbackFailed,
  continuing,
  onContinue,
  variant,
}: {
  readonly request: BrowserUserActionRequestState;
  readonly callbackDelivered: boolean;
  readonly callbackFailed: boolean;
  readonly continuing: boolean;
  readonly onContinue: () => void;
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
        callbackDelivered={callbackDelivered}
        callbackFailed={callbackFailed}
        cancelled={action.state === "cancelled"}
        continuing={continuing}
        onContinue={onContinue}
        variant={variant}
      />
    );
  }
  return null;
}

function fieldAutocomplete(
  fieldKind: string,
): "current-password" | "off" | "one-time-code" | "username" {
  switch (fieldKind) {
    case "username": {
      return "username";
    }
    case "password": {
      return "current-password";
    }
    case "one_time_code": {
      return "one-time-code";
    }
    default: {
      return "off";
    }
  }
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
  siteOrigin,
  compact = false,
  showTitle = true,
}: {
  readonly siteOrigin: string;
  readonly compact?: boolean;
  readonly showTitle?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full items-center",
        compact ? "gap-2.5 @[520px]:flex-1" : "gap-3",
      )}
    >
      <Globe size={16} className="mt-1 shrink-0 self-start text-brand-text" />
      <div className="min-w-0 max-w-sm">
        {showTitle && (
          <h2 className="text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.chat.browserInput.title;
            })}
          </h2>
        )}
        <div
          className={cn(
            "flex items-start gap-1.5 text-xs text-muted-foreground",
            compact ? "mt-1" : "mt-2",
          )}
        >
          <span className="shrink-0 font-medium text-foreground">
            {t(($) => {
              return $.chat.browserInput.site;
            })}
          </span>
          <span
            className={cn("min-w-0", compact ? "truncate" : "break-all")}
            title={compact ? siteOrigin : undefined}
          >
            {siteOrigin}
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
      <PendingFormHeader siteOrigin={action.siteOrigin} showTitle={showTitle} />
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

function BrowserInputControl({
  field,
  draft,
  busy,
  onUpdate,
  onRemove,
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
      autoComplete={fieldAutocomplete(field.fieldKind)}
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
        if (["number", "date_time"].includes(field.fieldKind) && value === "") {
          onRemove(field.key);
        } else {
          onUpdate(field.key, value);
        }
      }}
    />
  );
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
  fingerprint,
  busy,
  onUpdate,
  onRemove,
}: {
  readonly field: PendingBrowserInputField;
  readonly existing: readonly {
    readonly name: string;
    readonly size: number;
  }[];
  readonly draft: BrowserFileDraft | undefined;
  readonly fingerprint: string | undefined;
  readonly busy: boolean;
  readonly onUpdate: (key: string, draft: BrowserFileDraft) => void;
  readonly onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      {existing.length > 0 && fingerprint && (
        <Button
          type="button"
          size="xs"
          variant="link"
          disabled={busy}
          onClick={() => {
            return onUpdate(field.key, {
              operation: "keep",
              files: [],
              observedFingerprint: fingerprint,
            });
          }}
        >
          {t(($) => {
            return $.chat.browserInput.keepValue;
          })}
        </Button>
      )}
      {!field.required && !field.control.siteRequired && fingerprint && (
        <Button
          type="button"
          size="xs"
          variant="link"
          disabled={busy}
          onClick={() => {
            return onUpdate(field.key, {
              operation: "clear",
              files: [],
              observedFingerprint: fingerprint,
            });
          }}
        >
          {t(($) => {
            return $.chat.browserInput.clearValue;
          })}
        </Button>
      )}
      {draft && !field.required && (
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
      )}
    </div>
  );
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
        fingerprint={fingerprint}
        busy={busy}
        onUpdate={onUpdate}
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
    const choice = choiceDraft.get(field.key);
    if (
      choice &&
      choice.optionSetFingerprint !== field.control.optionSetFingerprint
    ) {
      return false;
    }
    if (field.required && !choice) {
      return false;
    }
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
      (choice === undefined ||
        selected.every((index) => {
          const option = options[index];
          return option && !option.disabled;
        })) &&
      selected.some((index) => {
        const option = options[index];
        return option && !option.disabled && !option.empty;
      })
    );
  });
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
    const choice = radioDraft.get(field.key);
    if (
      choice &&
      (choice.groupFingerprint !== fingerprint ||
        choice.observedSelectedIndex !== selectedIndex ||
        choice.memberIndex >= options.length ||
        options[choice.memberIndex]?.disabled ||
        (choice.memberIndex === -1 &&
          selectedIndex !== -1 &&
          options[selectedIndex]?.disabled))
    ) {
      return false;
    }
    if (field.required && !choice) {
      return false;
    }
    return (
      !(field.required || field.control.siteRequired) ||
      (choice?.memberIndex ?? selectedIndex) >= 0
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
    const choice = checkboxDraft.get(field.key);
    if (
      observed === undefined ||
      (choice && choice.observedChecked !== observed) ||
      (field.required && !choice)
    ) {
      return false;
    }
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

function canKeepSiteSelectChoice(
  field: PendingBrowserInputField,
  choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>,
): boolean {
  if (!field.required) {
    return choiceDraft.has(field.key);
  }
  const selected = selectedSelectIndices(field, undefined);
  return (
    selected.every((index) => {
      const option = field.control.options?.[index];
      return option && !option.disabled;
    }) &&
    selected.some((index) => {
      const option = field.control.options?.[index];
      return option && !option.empty;
    })
  );
}

function selectedEnabledOptionIndices(control: HTMLSelectElement): number[] {
  return [...control.selectedOptions]
    .filter((option) => {
      return !option.disabled;
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
  const { t } = useTranslation();
  const options = field.control.options;
  const ready =
    options !== undefined && field.control.optionSetFingerprint !== undefined;
  const selected = selectedSelectIndices(field, choiceDraft.get(field.key));
  const siteSelected = selectedSelectIndices(field, undefined);
  const canKeep = canKeepSiteSelectChoice(field, choiceDraft);
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
          onUpdate(
            field.key,
            selectedEnabledOptionIndices(event.currentTarget),
            field.control.optionSetFingerprint,
          );
        }}
      >
        {!multiple && (
          <option value="" disabled>
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
      {ready && (!required || canKeep) && (
        <div className="flex max-w-full flex-wrap gap-2">
          {!required && (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
              disabled={busy}
              onClick={() => {
                const fingerprint = field.control.optionSetFingerprint;
                if (fingerprint) {
                  onUpdate(field.key, [], fingerprint);
                }
              }}
            >
              {t(($) => {
                return $.chat.browserInput.clearValue;
              })}
            </Button>
          )}
          {canKeep && (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
              disabled={busy}
              onClick={() => {
                if (field.required) {
                  const fingerprint = field.control.optionSetFingerprint;
                  if (fingerprint) {
                    onUpdate(field.key, siteSelected, fingerprint);
                  }
                } else {
                  onRemove(field.key);
                }
              }}
            >
              {t(($) => {
                return $.chat.browserInput.keepValue;
              })}
            </Button>
          )}
        </div>
      )}
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
  const { t } = useTranslation();
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
                return onUpdate(field.key, {
                  memberIndex: option.index,
                  observedSelectedIndex: observed,
                  groupFingerprint: fingerprint,
                });
              }}
            />
            <span className="min-w-0 break-words">
              {option.index + 1}. {option.label}
            </span>
          </label>
        );
      })}
      <div className="flex max-w-full flex-wrap items-center gap-2">
        {!required && observed !== -1 && !options[observed]?.disabled && (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
            disabled={busy}
            onClick={() => {
              return onUpdate(field.key, {
                memberIndex: -1,
                observedSelectedIndex: observed,
                groupFingerprint: fingerprint,
              });
            }}
          >
            {t(($) => {
              return $.chat.browserInput.clearValue;
            })}
          </Button>
        )}
        {(field.required
          ? observed !== -1 && !options[observed]?.disabled
          : draft !== undefined) && (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
            disabled={busy}
            onClick={() => {
              if (field.required) {
                onUpdate(field.key, {
                  memberIndex: observed,
                  observedSelectedIndex: observed,
                  groupFingerprint: fingerprint,
                });
              } else {
                onRemove(field.key);
              }
            }}
          >
            {t(($) => {
              return $.chat.browserInput.keepValue;
            })}
          </Button>
        )}
      </div>
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
  const { t } = useTranslation();
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
            onUpdate(field.key, event.currentTarget.checked, observed);
          }
        }}
      />
      {observed !== undefined && !required && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
          disabled={busy}
          onClick={() => {
            onUpdate(field.key, false, observed);
          }}
        >
          {t(($) => {
            return $.chat.browserInput.clearValue;
          })}
        </Button>
      )}
      {observed !== undefined &&
        (field.required ? observed : choice !== undefined) && (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left"
            disabled={busy}
            onClick={() => {
              if (field.required) {
                onUpdate(field.key, true, observed);
              } else {
                onRemove(field.key);
              }
            }}
          >
            {t(($) => {
              return $.chat.browserInput.keepValue;
            })}
          </Button>
        )}
    </div>
  );
}

function OptionalConstrainedInputClearAction({
  field,
  draft,
  busy,
  onUpdate,
  onRemove,
}: BrowserInputEditProps) {
  const { t } = useTranslation();
  if (
    !["number", "date_time"].includes(field.fieldKind) ||
    field.required ||
    field.control.siteRequired
  ) {
    return null;
  }
  const clearing = draft.has(field.key) && draft.get(field.key) === "";
  return (
    <Button
      type="button"
      variant="link"
      size="xs"
      className="h-auto self-start p-0 text-xs"
      disabled={busy}
      onClick={() => {
        if (clearing) {
          onRemove(field.key);
        } else {
          onUpdate(field.key, "");
        }
      }}
    >
      {clearing
        ? t(($) => {
            return $.chat.browserInput.keepValue;
          })
        : t(($) => {
            return $.chat.browserInput.clearValue;
          })}
    </Button>
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

function BrowserInputField({
  field,
  index,
  draft,
  choiceDraft,
  checkboxDraft,
  radioDraft,
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
}: BrowserInputEditProps & {
  readonly radioDraft: ReadonlyMap<string, BrowserRadioDraft>;
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
}) {
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
      {field.fieldKind === "file" ? (
        <BrowserFileControl
          field={field}
          fileDraft={fileDraft}
          busy={busy}
          inputId={inputId}
          describedBy={
            descriptionId ? `${requirementId} ${descriptionId}` : requirementId
          }
          onUpdate={onUpdateFile}
          onRemove={onRemoveFile}
        />
      ) : field.fieldKind === "radio" ? (
        <BrowserRadioControl
          field={field}
          radioDraft={radioDraft}
          busy={busy}
          inputId={inputId}
          describedBy={
            descriptionId ? `${requirementId} ${descriptionId}` : requirementId
          }
          onUpdate={onUpdateRadio}
          onRemove={onRemoveRadio}
        />
      ) : field.fieldKind === "checkbox" ? (
        <BrowserCheckboxControl
          field={field}
          inputId={inputId}
          describedBy={
            descriptionId ? `${requirementId} ${descriptionId}` : requirementId
          }
          checkboxDraft={checkboxDraft}
          busy={busy}
          onUpdate={onUpdateCheckbox}
          onRemove={onRemoveCheckbox}
        />
      ) : field.fieldKind === "select" ? (
        <BrowserSelectControl
          field={field}
          inputId={inputId}
          describedBy={
            descriptionId ? `${requirementId} ${descriptionId}` : requirementId
          }
          choiceDraft={choiceDraft}
          busy={busy}
          onUpdate={onUpdateChoice}
          onRemove={onRemoveChoice}
        />
      ) : (
        <BrowserInputControl
          field={field}
          inputId={inputId}
          describedBy={
            descriptionId ? `${requirementId} ${descriptionId}` : requirementId
          }
          draft={draft}
          busy={busy}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      )}
      <OptionalConstrainedInputClearAction
        field={field}
        draft={draft}
        busy={busy}
        onUpdate={onUpdate}
        onRemove={onRemove}
      />
    </div>
  );
}

function BrowserInputFields({
  action,
  draft,
  choiceDraft,
  checkboxDraft,
  radioDraft,
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
}: Omit<BrowserInputEditProps, "field"> & {
  readonly action: PendingBrowserInputAction;
  readonly choiceDraft: ReadonlyMap<string, BrowserSelectChoiceDraft>;
  readonly checkboxDraft: ReadonlyMap<string, BrowserCheckboxDraft>;
  readonly radioDraft: ReadonlyMap<string, BrowserRadioDraft>;
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
          />
        );
      })}
    </div>
  );
}

function PendingFormActions({
  submitting,
  cancelling,
  canSubmit,
  onCancel,
}: {
  readonly submitting: boolean;
  readonly cancelling: boolean;
  readonly canSubmit: boolean;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  const busy = submitting || cancelling;
  return (
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
  );
}

function PendingFormPreflight({
  signals,
  entryState,
}: {
  readonly signals: BrowserUserActionSignals;
  readonly entryState:
    | "idle"
    | "checking"
    | "ready"
    | "unavailable"
    | "invalid";
}) {
  const { t } = useTranslation();
  const beginEntry = useSet(signals.beginEntry$);
  const pageSignal = useGet(pageSignal$);
  if (entryState === "idle" || entryState === "checking") {
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
  if (entryState === "unavailable" || entryState === "invalid") {
    return (
      <div className="flex flex-wrap items-center gap-2" role="alert">
        <p className="text-sm text-destructive">
          {t(($) => {
            return entryState === "invalid"
              ? $.chat.browserInput.applyFailed
              : $.chat.browserInput.checkFailed;
          })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            detach(beginEntry(pageSignal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.browserInput.retry;
          })}
        </Button>
      </div>
    );
  }
  return null;
}

function PendingForm({
  signals,
  request,
  showTitle = true,
}: {
  readonly signals: BrowserUserActionSignals;
  readonly request: PendingBrowserInputRequest;
  readonly showTitle?: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const draft = useGet(signals.draft$);
  const choiceDraft = useGet(signals.choiceDraft$);
  const checkboxDraft = useGet(signals.checkboxDraft$);
  const radioDraft = useGet(signals.radioDraft$);
  const fileDraft = useGet(signals.fileDraft$);
  const sharedBusy = useGet(signals.busy$);
  const entryState = useGet(signals.entryState$);
  const entryAction = useGet(signals.entryAction$);
  const updateDraft = useSet(signals.updateDraft$);
  const removeDraft = useSet(signals.removeDraft$);
  const updateChoiceDraft = useSet(signals.updateChoiceDraft$);
  const removeChoiceDraft = useSet(signals.removeChoiceDraft$);
  const updateCheckboxDraft = useSet(signals.updateCheckboxDraft$);
  const removeCheckboxDraft = useSet(signals.removeCheckboxDraft$);
  const updateRadioDraft = useSet(signals.updateRadioDraft$);
  const removeRadioDraft = useSet(signals.removeRadioDraft$);
  const updateFileDraft = useSet(signals.updateFileDraft$);
  const removeFileDraft = useSet(signals.removeFileDraft$);
  const formRef = useSet(signals.formRef$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [cancelLoadable, cancel] = useLoadableSet(signals.cancel$);
  const submitting = submitLoadable.state === "loading";
  const cancelling = cancelLoadable.state === "loading";
  const busy = sharedBusy || submitting || cancelling;
  const failed =
    submitLoadable.state === "hasError" || cancelLoadable.state === "hasError";
  const cancelFailed = cancelLoadable.state === "hasError";
  const activeAction =
    entryState === "ready" && entryAction ? entryAction : request.action;
  const selectValuesValid = requiredSelectsSatisfied(activeAction, choiceDraft);
  const checkboxValuesValid = requiredCheckboxesSatisfied(
    activeAction,
    checkboxDraft,
  );
  const radioValuesValid = requiredRadiosSatisfied(activeAction, radioDraft);
  const fileValuesValid = requiredFilesSatisfied(activeAction, fileDraft);
  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !selectValuesValid ||
      !checkboxValuesValid ||
      !radioValuesValid ||
      !fileValuesValid ||
      !event.currentTarget.reportValidity()
    ) {
      return;
    }
    detach(submit(pageSignal), Reason.DomCallback);
  };

  return (
    <form
      ref={formRef}
      className="flex flex-col gap-5"
      aria-label={t(($) => {
        return $.chat.browserInput.title;
      })}
      onSubmit={submitForm}
    >
      <PendingFormDestination action={activeAction} showTitle={showTitle} />
      <BrowserInputFields
        action={activeAction}
        draft={draft}
        choiceDraft={choiceDraft}
        checkboxDraft={checkboxDraft}
        radioDraft={radioDraft}
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
      />

      <PendingFormPreflight signals={signals} entryState={entryState} />

      {failed && entryState !== "invalid" && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return cancelFailed
              ? $.chat.browserInput.cancelFailed
              : $.chat.browserInput.applyFailed;
          })}
        </p>
      )}

      <PendingFormActions
        submitting={submitting}
        cancelling={cancelling}
        canSubmit={
          entryState !== "unavailable" &&
          entryState !== "invalid" &&
          selectValuesValid &&
          checkboxValuesValid &&
          radioValuesValid &&
          fileValuesValid &&
          (!request.action.fields.some((field) => {
            return (
              field.fieldKind === "select" ||
              field.fieldKind === "checkbox" ||
              field.fieldKind === "radio" ||
              field.fieldKind === "file"
            );
          }) ||
            entryState === "ready")
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
}: {
  readonly signals: BrowserUserActionSignals;
  readonly request: PendingBrowserInputRequest;
  readonly showTitle?: boolean;
}) {
  const entryState = useGet(signals.entryState$);
  const entryAction = useGet(signals.entryAction$);
  return (
    <PendingForm
      signals={signals}
      request={{
        ...request,
        action:
          entryState === "ready" && entryAction ? entryAction : request.action,
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
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const beginEntry = useSet(signals.beginEntry$);
  const dialogRef = useSet(signals.dialogRef$);
  const title = t(($) => {
    return $.chat.browserInput.title;
  });
  return (
    <div className="flex h-full w-full flex-col justify-center gap-2 @[520px]:flex-row @[520px]:items-center @[520px]:justify-between @[520px]:gap-3">
      <PendingFormHeader siteOrigin={request.action.siteOrigin} compact />
      <div className="shrink-0 self-start pl-[26px] @[520px]:ml-auto @[520px]:self-auto @[520px]:pl-0">
        <Dialog
          onOpenChange={(nextOpen) => {
            if (nextOpen) {
              detach(beginEntry(pageSignal), Reason.DomCallback);
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
          <DialogContent ref={dialogRef}>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
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

function BrowserUserActionCardContent({
  callbackDelivered,
  callbackFailed,
  continuing,
  onContinue,
  refresh,
  requestLoadable,
  signals,
  variant,
}: {
  readonly callbackDelivered: boolean;
  readonly callbackFailed: boolean;
  readonly continuing: boolean;
  readonly onContinue: () => void;
  readonly refresh: () => void;
  readonly requestLoadable: Loadable<BrowserUserActionRequestState>;
  readonly signals: BrowserUserActionSignals;
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  let content: ReactNode;
  if (requestLoadable.state === "loading") {
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
        action={
          <Button type="button" size="sm" variant="outline" onClick={refresh}>
            {t(($) => {
              return $.chat.browserInput.retry;
            })}
          </Button>
        }
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
        <StateFromRequest
          request={requestLoadable.data}
          callbackDelivered={callbackDelivered}
          callbackFailed={callbackFailed}
          continuing={continuing}
          onContinue={onContinue}
          variant={variant}
        />
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
  const pageSignal = useGet(pageSignal$);
  const requestLoadable = useLoadable(signals.request$);
  const refresh = useSet(signals.refresh$);
  const retryStandaloneRequest = useSet(signals.retryStandaloneRequest$);
  const resumeRef = useSet(signals.resumeRef$);
  const locallyDelivered = useGet(signals.callbackDelivered$);
  const callbackFailed = useGet(signals.callbackFailed$);
  const busy = useGet(signals.busy$);
  const [continueLoadable, continueAction] = useLoadableSet(signals.continue$);
  const action =
    requestLoadable.state === "hasData" &&
    requestLoadable.data.kind === "action"
      ? requestLoadable.data.action
      : undefined;
  const callbackDelivered =
    locallyDelivered || action?.callbackDelivered === true;
  const needsReturnRefresh =
    action !== undefined &&
    ((variant === "inline" &&
      action.kind === "input" &&
      action.state === "pending") ||
      ((action.state === "succeeded" || action.state === "cancelled") &&
        !callbackDelivered));
  const continuing = busy || continueLoadable.state === "loading";
  const onContinue = () => {
    detach(continueAction(pageSignal), Reason.DomCallback);
  };
  const onRefresh = () => {
    if (variant === "standalone") {
      detach(retryStandaloneRequest(pageSignal), Reason.DomCallback);
    } else {
      refresh();
    }
  };

  return (
    <BrowserActionSurface
      variant={variant}
      resumeRef={needsReturnRefresh ? resumeRef : undefined}
    >
      <BrowserUserActionCardContent
        callbackDelivered={callbackDelivered}
        callbackFailed={callbackFailed}
        continuing={continuing}
        onContinue={onContinue}
        refresh={onRefresh}
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
