import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  Loader2,
  X,
  CircleCheck,
  CircleMinus,
  BellOff,
  EyeOff,
  SquarePen,
  Send,
  Quote,
  Paperclip,
} from "lucide-react";
import { Button, Textarea, buttonVariants, cn } from "@okouai/ui";
import type { SuggestionOption } from "@okouai/api-contracts/contracts/feed";
import {
  agentSuggestionEntries$,
  type AgentSuggestionEntry,
  closeSettledSuggestion$,
  retryAgentSuggestion$,
  submitSuggestionFeedbackWithUndo$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  startAgentSuggestion$,
  submitCustomAgentSuggestion$,
} from "../../signals/okou-page/agent-suggestions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ForYouCardHeading } from "./for-you-card-heading.tsx";

function SuggestionOptionContent({
  option,
}: {
  readonly option: SuggestionOption;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-break-word">
      <span className="leading-5">{option.label}</span>
      {option.description && (
        <span className="text-xs leading-5 text-muted-foreground">
          {option.description}
        </span>
      )}
    </span>
  );
}

function CloseSettledSuggestion({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const close = useSet(closeSettledSuggestion$);
  return (
    <Button
      type="button"
      variant="quiet"
      size="icon-xs"
      showTooltip
      aria-label={t(($) => {
        return $.chat.agentSuggestions.closeFeedback;
      })}
      onClick={() => {
        close(entry);
      }}
    >
      <X />
    </Button>
  );
}

/** Rows below the waiting cards keep their card's title to stay identifiable. */
function SettledSuggestionTitle({ title }: { readonly title: string }) {
  return (
    <p className="mt-1 truncate pl-6 text-xs leading-5 text-muted-foreground">
      {title}
    </p>
  );
}

export function SuggestionSentNotice({
  entry,
  threadId,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly threadId: string | null;
}) {
  const { t } = useTranslation();
  const sending = useLoadable(entry.sending$);
  const failed = threadId === null && sending.state === "hasError";
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        {threadId === null && !failed ? (
          <Loader2
            aria-hidden
            className="size-4 shrink-0 animate-spin text-muted-foreground"
          />
        ) : failed ? (
          <X aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Check
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        <p
          role={failed ? "alert" : "status"}
          className="min-w-0 flex-1 text-sm leading-5 text-muted-foreground"
        >
          {failed
            ? sending.error instanceof Error
              ? sending.error.message
              : t(($) => {
                  return $.global.errors.requestFailed;
                })
            : threadId === null
              ? t(($) => {
                  return $.chat.agentSuggestions.sending;
                })
              : t(($) => {
                  return $.chat.agentSuggestions.messageSent;
                })}
        </p>
        {threadId !== null && (
          <Link
            pathname={ROUTES.chat}
            options={{ pathParams: { threadId } }}
            className={buttonVariants({ variant: "quiet", size: "sm" })}
          >
            {t(($) => {
              return $.chat.agentSuggestions.openChat;
            })}
            <ArrowRight aria-hidden />
          </Link>
        )}
        <CloseSettledSuggestion entry={entry} />
      </div>
      <SettledSuggestionTitle title={entry.item.content.title} />
    </div>
  );
}

function SuggestionSaveError({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const result = useLoadable(entry.result$);
  const retry = useSet(retryAgentSuggestion$);
  const signal = useGet(pageSignal$);
  if (result.state !== "hasError") {
    return null;
  }
  return (
    <div
      role="alert"
      className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-card p-3"
    >
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {entry.item.content.title}:{" "}
        {result.error instanceof Error
          ? result.error.message
          : t(($) => {
              return $.global.errors.requestFailed;
            })}
      </p>
      <Button
        type="button"
        variant="quiet"
        size="sm"
        onClick={() => {
          detach(retry(entry, signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.chat.errors.recovery.tryAgain;
        })}
      </Button>
    </div>
  );
}

export function SuggestionSaveErrors() {
  const entries = useLastLoadable(agentSuggestionEntries$);
  return entries.state === "hasData"
    ? entries.data.map((entry) => {
        return <SuggestionSaveError key={entry.item.id} entry={entry} />;
      })
    : null;
}

function SuggestionComposer({
  entry,
}: {
  readonly entry: AgentSuggestionEntry;
}) {
  const { t } = useTranslation();
  const text = useGet(entry.customText$);
  const expanded = useGet(entry.customExpanded$) || text.length > 0;
  const sending = useLoadable(entry.customSending$);
  const pending = sending.state === "loading";
  const setText = useSet(entry.setCustomText$);
  const setExpanded = useSet(entry.setCustomExpanded$);
  const submit = useSet(submitCustomAgentSuggestion$);
  const signal = useGet(pageSignal$);
  const files = entry.item.content.customOption.draft.draftAttachments ?? [];
  return (
    <form
      aria-label={t(($) => {
        return $.chat.agentSuggestions.customDirectionDescription;
      })}
      onSubmit={(event) => {
        // The inline form owns submission; Enter in the textarea remains a newline.
        event.preventDefault();
        detach(Promise.resolve(submit(entry, signal)), Reason.DomCallback);
      }}
      className={cn(
        "relative rounded-3xl border border-transparent bg-nested-fill",
        expanded && "border-border bg-card",
      )}
    >
      <Textarea
        aria-label={t(($) => {
          return $.chat.agentSuggestions.customPlaceholder;
        })}
        placeholder={t(($) => {
          return $.chat.agentSuggestions.customPlaceholder;
        })}
        rows={expanded ? 3 : 1}
        value={text}
        disabled={pending}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onFocus={() => {
          setExpanded(true);
        }}
        onBlur={() => {
          if (!text.trim() && !pending) {
            setExpanded(false);
          }
        }}
        className={cn(
          "min-h-14 resize-none rounded-3xl border-0 bg-transparent px-4 py-4 pr-12 text-sm leading-6 focus:ring-0",
          expanded && "max-h-48 pr-4",
        )}
      />
      {!expanded && (
        <SquarePen
          aria-hidden
          className="pointer-events-none absolute right-4 top-5 size-4 text-muted-foreground"
        />
      )}
      {expanded && (
        <div className="space-y-2 px-4 pb-3">
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {files.map((file) => {
                return (
                  <span
                    key={file.id}
                    className="inline-flex min-w-0 items-center gap-1"
                  >
                    <Paperclip aria-hidden className="size-3" />
                    <span className="truncate">{file.filename}</span>
                  </span>
                );
              })}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Quote aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{entry.item.content.title}</span>
            </span>
            <Button
              type="submit"
              size="sm"
              pending={pending}
              disabled={pending || !text.trim()}
            >
              {t(($) => {
                return $.chat.actions.send;
              })}
            </Button>
          </div>
          {sending.state === "hasError" && (
            <p role="alert" className="text-xs text-destructive">
              {sending.error instanceof Error
                ? sending.error.message
                : t(($) => {
                    return $.global.errors.requestFailed;
                  })}
            </p>
          )}
        </div>
      )}
    </form>
  );
}

export function AgentSuggestionCard({
  entry,
  active,
  navigation,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly active: boolean;
  readonly navigation: ReactNode;
}) {
  const { t } = useTranslation();
  const { item } = entry;
  const start = useSet(startAgentSuggestion$);
  const submitFeedback = useSet(submitSuggestionFeedbackWithUndo$);
  const signal = useGet(pageSignal$);
  const customSending = useLoadable(entry.customSending$);
  const pending = customSending.state === "loading";
  const sourceOption = item.content.options.find((option) => {
    return option.threadId !== null;
  });
  const sourceParts = item.content.options
    .flatMap((option) => {
      return option.draft.draftUserMessage?.parts ?? [];
    })
    .filter((part) => {
      return part.type === "chat_thread";
    });
  const sourcePart =
    sourceParts.find((part) => {
      return part.threadId === sourceOption?.threadId;
    }) ?? sourceParts[0];
  const sourceThreadId =
    sourceOption?.threadId ??
    (sourcePart?.type === "chat_thread" ? sourcePart.threadId : null);
  return (
    <article
      aria-labelledby={`suggestion-title-${item.id}`}
      className="flex flex-1 flex-col"
    >
      <ForYouCardHeading
        id={item.id}
        title={item.content.title}
        description={item.content.rationale}
        active={active}
        source={
          sourceThreadId ? (
            <Link
              pathname={ROUTES.chat}
              options={{ pathParams: { threadId: sourceThreadId } }}
              className="inline-block max-w-full truncate rounded-md text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:bg-state-hover hover:text-foreground"
              aria-label={t(($) => {
                return $.chat.agentSuggestions.viewSource;
              })}
            >
              {sourcePart?.threadId === sourceThreadId
                ? sourcePart.titleSnapshot
                : t(($) => {
                    return $.chat.agentSuggestions.viewSource;
                  })}
            </Link>
          ) : null
        }
      />
      <div className="mt-6 flex flex-col gap-2">
        {item.content.options.map((option) => {
          return (
            <Button
              key={option.id}
              type="button"
              variant="quiet"
              disabled={pending}
              className="h-auto min-h-14 w-full justify-between gap-3 whitespace-normal rounded-3xl bg-nested-fill px-4 py-3 text-left text-sm font-normal text-foreground"
              aria-label={option.label}
              aria-description={[
                option.description,
                option.threadId
                  ? t(($) => {
                      return $.chat.agentSuggestions.editDraft;
                    })
                  : t(($) => {
                      return $.chat.agentSuggestions.sendNew;
                    }),
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                detach(start(item.id, option.id, signal), Reason.DomCallback);
              }}
            >
              <SuggestionOptionContent option={option} />
              {option.threadId ? (
                <SquarePen
                  aria-hidden
                  className="shrink-0 text-muted-foreground"
                />
              ) : (
                <Send aria-hidden className="shrink-0 text-muted-foreground" />
              )}
            </Button>
          );
        })}
        <SuggestionComposer entry={entry} />
      </div>
      <SuggestionFeedback entry={entry} pending={pending} />
      <footer className="mt-3 flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={pending}
          className="px-2 text-xs font-normal"
          onClick={() => {
            detach(
              submitFeedback(item.id, "dismissed", signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.chat.agentSuggestions.dismiss;
          })}
        </Button>
        {navigation}
      </footer>
    </article>
  );
}

function SuggestionFeedback({
  entry,
  pending,
}: {
  readonly entry: AgentSuggestionEntry;
  readonly pending: boolean;
}) {
  const { t } = useTranslation();
  const { item } = entry;
  const signal = useGet(pageSignal$);
  const submitFeedback = useSet(submitSuggestionFeedbackWithUndo$);
  const feedbackActions = [
    {
      kind: "already_done" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.alreadyDone;
      }),
      Icon: CircleCheck,
    },
    {
      kind: "not_planned" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.notPlanned;
      }),
      Icon: CircleMinus,
    },
    {
      kind: "dont_nudge" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.dontNudge;
      }),
      Icon: BellOff,
    },
    {
      kind: "less_like_this" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.lessLikeThis;
      }),
      Icon: EyeOff,
    },
  ];
  return (
    <div className="mt-6 border-t border-border pt-4">
      <p
        id={`feedback-label-${item.id}`}
        className="mb-2 text-xs text-muted-foreground"
      >
        {t(($) => {
          return $.chat.agentSuggestions.feedbackPrompt;
        })}
      </p>
      <div
        role="group"
        aria-labelledby={`feedback-label-${item.id}`}
        className="flex flex-wrap gap-1.5 sm:gap-2"
      >
        {feedbackActions.map(({ kind, label, Icon }) => {
          return (
            <Button
              key={kind}
              type="button"
              variant="outline"
              disabled={pending}
              className="min-h-11 gap-1 rounded-full bg-card px-2 text-[11px] font-normal text-muted-foreground sm:min-h-9 sm:gap-1.5 sm:px-3 sm:text-xs"
              onClick={() => {
                detach(
                  submitFeedback(item.id, kind, signal),
                  Reason.DomCallback,
                );
              }}
            >
              <Icon aria-hidden className="size-3.5" />
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
