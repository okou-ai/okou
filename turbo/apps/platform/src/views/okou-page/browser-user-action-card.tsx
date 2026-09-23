import {
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { cn } from "@okouai/ui";
import { Button, buttonVariants } from "@okouai/ui/components/ui/button";
import { Input } from "@okouai/ui/components/ui/input";
import { useGet, useLoadable, useSet, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertCircle,
  CheckCircle2,
  Globe,
  Loader2,
  MousePointerClick,
  XCircle,
} from "lucide-react";
import type { FormEvent, ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";

import type {
  BrowserUserActionRequestState,
  BrowserUserActionSignals,
} from "../../signals/chat-page/browser-user-action-block.ts";
import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import { openThreadBrowserSession$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { ChatCardDetails } from "./components/chat-card-details.tsx";
import { BrowserSessionCard } from "./browser-session-card.tsx";

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

function fieldInputType(fieldKind: string): "password" | "text" {
  return fieldKind === "password" ? "password" : "text";
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

type BrowserDirectInteractionAction = Extract<
  BrowserUserActionResponse,
  { readonly kind: "direct_interaction" }
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

function BrowserInputFields({
  action,
  draft,
  busy,
  onUpdate,
}: {
  readonly action: PendingBrowserInputAction;
  readonly draft: ReadonlyMap<string, string>;
  readonly busy: boolean;
  readonly onUpdate: (key: string, value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      {action.fields.map((field, index) => {
        const inputId = `browser-input-field-${index}`;
        const requirementId = `${inputId}-requirement`;
        const descriptionId = field.description
          ? `${inputId}-description`
          : undefined;
        return (
          <div key={field.key} className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-1 text-sm text-foreground">
              <label htmlFor={inputId} className="font-medium">
                {field.label}
              </label>
              <span
                id={requirementId}
                className="text-xs font-normal text-muted-foreground"
              >
                {field.required
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
                className="text-xs font-normal leading-4 text-muted-foreground"
              >
                {field.description}
              </span>
            )}
            <Input
              id={inputId}
              name={field.key}
              type={fieldInputType(field.fieldKind)}
              autoComplete={fieldAutocomplete(field.fieldKind)}
              aria-describedby={
                descriptionId
                  ? `${requirementId} ${descriptionId}`
                  : requirementId
              }
              required={field.required}
              maxLength={BROWSER_USER_ACTION_MAX_VALUE_LENGTH}
              value={draft.get(field.key) ?? ""}
              disabled={busy}
              onChange={(event) => {
                onUpdate(field.key, event.currentTarget.value);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

function PendingFormActions({
  submitting,
  cancelling,
  onCancel,
}: {
  readonly submitting: boolean;
  readonly cancelling: boolean;
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
      <Button type="submit" disabled={busy}>
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
  const sharedBusy = useGet(signals.busy$);
  const updateDraft = useSet(signals.updateDraft$);
  const formRef = useSet(signals.formRef$);
  const [submitLoadable, submit] = useLoadableSet(signals.submit$);
  const [cancelLoadable, cancel] = useLoadableSet(signals.cancel$);
  const submitting = submitLoadable.state === "loading";
  const cancelling = cancelLoadable.state === "loading";
  const busy = sharedBusy || submitting || cancelling;
  const failed =
    submitLoadable.state === "hasError" || cancelLoadable.state === "hasError";
  const cancelFailed = cancelLoadable.state === "hasError";
  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) {
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
      <PendingFormHeader
        siteOrigin={request.action.siteOrigin}
        showTitle={showTitle}
      />
      <BrowserInputFields
        action={request.action}
        draft={draft}
        busy={busy}
        onUpdate={updateDraft}
      />

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
        submitting={submitting}
        cancelling={cancelling}
        onCancel={() => {
          detach(cancel(pageSignal), Reason.DomCallback);
        }}
      />
    </form>
  );
}

function PendingFormGate({
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
  const entryState = useGet(signals.entryState$);
  const beginEntry = useSet(signals.beginEntry$);
  if (entryState === "ready") {
    return (
      <PendingForm signals={signals} request={request} showTitle={showTitle} />
    );
  }
  return (
    <div className="flex flex-col gap-4" role="status">
      <PendingFormHeader
        siteOrigin={request.action.siteOrigin}
        showTitle={showTitle}
      />
      {entryState === "checking" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          {t(($) => {
            return $.chat.browserInput.loadingDescription;
          })}
        </p>
      ) : (
        <>
          {entryState === "unavailable" && (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.chat.browserInput.unavailable;
              })}
            </p>
          )}
          <Button
            type="button"
            onClick={() => {
              detach(beginEntry(pageSignal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return entryState === "unavailable"
                ? $.chat.browserInput.retry
                : $.chat.browserInput.open;
            })}
          </Button>
        </>
      )}
    </div>
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
  return (
    <div className="flex h-full w-full flex-col justify-center gap-2 @[520px]:flex-row @[520px]:items-center @[520px]:justify-between @[520px]:gap-3">
      <PendingFormHeader siteOrigin={request.action.siteOrigin} compact />
      <div className="shrink-0 self-start pl-[26px] @[520px]:ml-auto @[520px]:self-auto @[520px]:pl-0">
        <a
          href={signals.originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({ variant: "outline", size: "sm" }),
            "shrink-0",
          )}
        >
          {t(($) => {
            return $.chat.browserInput.open;
          })}
        </a>
      </div>
    </div>
  );
}

function DirectTerminalActionState({
  action,
  callbackDelivered,
  callbackFailed,
  continuing,
  onContinue,
  variant,
}: {
  readonly action: BrowserDirectInteractionAction;
  readonly callbackDelivered: boolean;
  readonly callbackFailed: boolean;
  readonly continuing: boolean;
  readonly onContinue: () => void;
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  const cancelled = action.state === "cancelled";
  if (callbackDelivered) {
    return (
      <ActionState
        icon={<CheckCircle2 size={20} className="text-emerald-600" />}
        title={t(($) => {
          return $.chat.browserInteraction.delivered;
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
          ? $.chat.browserInteraction.cancelled
          : $.chat.browserInteraction.completed;
      })}
      description={
        callbackFailed
          ? t(($) => {
              return $.chat.browserInteraction.callbackFailed;
            })
          : undefined
      }
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
                return $.chat.browserInteraction.continuing;
              })
            : callbackFailed
              ? t(($) => {
                  return $.chat.browserInput.retry;
                })
              : t(($) => {
                  return $.chat.browserInteraction.continue;
                })}
        </Button>
      }
    />
  );
}

function DirectStateFromAction({
  action,
  callbackDelivered,
  callbackFailed,
  continuing,
  onContinue,
  variant,
}: {
  readonly action: BrowserDirectInteractionAction;
  readonly callbackDelivered: boolean;
  readonly callbackFailed: boolean;
  readonly continuing: boolean;
  readonly onContinue: () => void;
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  if (action.state === "applying") {
    return (
      <ActionState
        icon={<Loader2 size={20} className="animate-spin" />}
        title={t(($) => {
          return $.chat.browserInteraction.applying;
        })}
        description={t(($) => {
          return $.chat.browserInteraction.applyingDescription;
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
          return $.chat.browserInteraction.stale;
        })}
        description={t(($) => {
          return $.chat.browserInteraction.staleDescription;
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
          return $.chat.browserInteraction.uncertain;
        })}
        description={t(($) => {
          return $.chat.browserInteraction.uncertainDescription;
        })}
        variant={variant}
      />
    );
  }
  if (action.state === "succeeded" || action.state === "cancelled") {
    return (
      <DirectTerminalActionState
        action={action}
        callbackDelivered={callbackDelivered}
        callbackFailed={callbackFailed}
        continuing={continuing}
        onContinue={onContinue}
        variant={variant}
      />
    );
  }
  return null;
}

function PendingDirectInteraction({
  action,
  browserSessionSignals,
  signals,
  variant,
}: {
  readonly action: BrowserDirectInteractionAction;
  readonly browserSessionSignals: BrowserSessionSignals;
  readonly signals: BrowserUserActionSignals;
  readonly variant: BrowserUserActionCardVariant;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const sharedBusy = useGet(signals.busy$);
  const [completeLoadable, complete] = useLoadableSet(signals.complete$);
  const [cancelLoadable, cancel] = useLoadableSet(signals.cancel$);
  const completing = completeLoadable.state === "loading";
  const cancelling = cancelLoadable.state === "loading";
  const busy = sharedBusy || completing || cancelling;
  const completeFailed = completeLoadable.state === "hasError";
  const cancelFailed = cancelLoadable.state === "hasError";

  return (
    <section
      aria-label={t(($) => {
        return $.chat.browserInteraction.title;
      })}
      className="flex w-full flex-col gap-4"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
          <MousePointerClick size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.chat.browserInteraction.title;
            })}
          </h2>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {action.reason}
          </p>
          <p className="mt-1 text-xs leading-4 text-muted-foreground">
            {t(($) => {
              return $.chat.browserInteraction.description;
            })}
          </p>
        </div>
      </div>

      {variant === "standalone" && (
        <BrowserSessionCard
          signals={browserSessionSignals}
          openMode="new-page"
        />
      )}

      {(completeFailed || cancelFailed) && (
        <p role="alert" className="text-sm text-destructive">
          {cancelFailed
            ? t(($) => {
                return $.chat.browserInteraction.cancelFailed;
              })
            : t(($) => {
                return $.chat.browserInteraction.completeFailed;
              })}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            detach(cancel(pageSignal), Reason.DomCallback);
          }}
        >
          {cancelling && <Loader2 size={16} className="animate-spin" />}
          {cancelling
            ? t(($) => {
                return $.chat.browserInteraction.cancelling;
              })
            : t(($) => {
                return $.chat.browserInteraction.cancel;
              })}
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            detach(complete(pageSignal), Reason.DomCallback);
          }}
        >
          {completing && <Loader2 size={16} className="animate-spin" />}
          {completing
            ? t(($) => {
                return $.chat.browserInteraction.completing;
              })
            : t(($) => {
                return $.chat.browserInteraction.done;
              })}
        </Button>
      </div>
    </section>
  );
}

function PendingInlineDirectInteraction({
  action,
  browserSessionSignals,
  signals,
}: {
  readonly action: BrowserDirectInteractionAction;
  readonly browserSessionSignals: BrowserSessionSignals;
  readonly signals: BrowserUserActionSignals;
}) {
  const { t } = useTranslation();
  const openBrowserSidebar = useSet(openThreadBrowserSession$);
  return (
    <div className="flex h-full w-full flex-col justify-center gap-1 @[380px]:gap-2 @[520px]:flex-row @[520px]:items-center @[520px]:justify-between @[520px]:gap-3">
      <div className="flex min-w-0 max-w-full items-center gap-2.5 @[520px]:flex-1">
        <MousePointerClick
          size={16}
          className="mt-1 shrink-0 self-start text-brand-text"
        />
        <div className="min-w-0 max-w-sm">
          <div className="text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.chat.browserInteraction.title;
            })}
          </div>
          <p
            className="mt-1 line-clamp-1 text-sm leading-5 text-muted-foreground"
            title={action.reason}
          >
            {action.reason}
          </p>
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center gap-1 self-start pl-[26px] @[380px]:gap-2 @[520px]:ml-auto @[520px]:w-auto @[520px]:self-auto @[520px]:pl-0">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            openBrowserSidebar(browserSessionSignals.threadId);
          }}
        >
          {t(($) => {
            return $.chat.thread.openBrowser;
          })}
        </Button>
        <ChatCardDetails
          title={t(($) => {
            return $.chat.browserInteraction.title;
          })}
          triggerLabel={t(($) => {
            return $.chat.browserInteraction.finish;
          })}
        >
          <PendingDirectInteraction
            action={action}
            browserSessionSignals={browserSessionSignals}
            signals={signals}
            variant="inline"
          />
        </ChatCardDetails>
      </div>
    </div>
  );
}

function BrowserUserActionCardContent({
  browserSessionSignals,
  callbackDelivered,
  callbackFailed,
  continuing,
  onContinue,
  refresh,
  requestLoadable,
  signals,
  variant,
}: {
  readonly browserSessionSignals: BrowserSessionSignals;
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
    requestLoadable.data.action.kind === "direct_interaction"
  ) {
    const { action } = requestLoadable.data;
    if (action.state === "pending") {
      content =
        variant === "inline" ? (
          <PendingInlineDirectInteraction
            action={action}
            browserSessionSignals={browserSessionSignals}
            signals={signals}
          />
        ) : (
          <PendingDirectInteraction
            action={action}
            browserSessionSignals={browserSessionSignals}
            signals={signals}
            variant={variant}
          />
        );
    } else {
      content = (
        <DirectStateFromAction
          action={action}
          callbackDelivered={callbackDelivered}
          callbackFailed={callbackFailed}
          continuing={continuing}
          onContinue={onContinue}
          variant={variant}
        />
      );
    }
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
        <PendingFormGate signals={signals} request={pendingRequest} />
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
  browserSessionSignals,
  signals,
  variant = "inline",
}: {
  readonly browserSessionSignals: BrowserSessionSignals;
  readonly signals: BrowserUserActionSignals;
  readonly variant?: BrowserUserActionCardVariant;
}) {
  const pageSignal = useGet(pageSignal$);
  const requestLoadable = useLoadable(signals.request$);
  const refresh = useSet(signals.refresh$);
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
    ((action.kind === "input" && action.state === "pending") ||
      ((action.state === "succeeded" || action.state === "cancelled") &&
        !callbackDelivered));
  const continuing = busy || continueLoadable.state === "loading";
  const onContinue = () => {
    detach(continueAction(pageSignal), Reason.DomCallback);
  };

  return (
    <BrowserActionSurface
      variant={variant}
      resumeRef={needsReturnRefresh ? resumeRef : undefined}
    >
      <BrowserUserActionCardContent
        browserSessionSignals={browserSessionSignals}
        callbackDelivered={callbackDelivered}
        callbackFailed={callbackFailed}
        continuing={continuing}
        onContinue={onContinue}
        refresh={refresh}
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
