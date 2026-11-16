import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  Loader2,
  MessageCircle,
  MessageSquare,
  MessageSquarePlus,
  X,
  CircleCheck,
  CircleMinus,
  SlidersHorizontal,
} from "lucide-react";
import type {
  Suggestion,
  SuggestionOption,
} from "@okouai/api-contracts/contracts/feed";
import {
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import { defaultAgentId$, defaultAgentName$ } from "../../signals/agent.ts";
import { assistantName$ } from "../../signals/branding.ts";
import {
  agentSuggestionEntries$,
  type AgentSuggestionEntry,
  closeSettledSuggestion$,
  retryAgentSuggestion$,
  submitSuggestionFeedbackWithUndo$,
  focusSuggestionTitleOnRef$,
} from "../../signals/okou-page/agent-suggestion-session.ts";
import {
  agentSuggestionComposerItem$,
  closeAgentSuggestionComposer$,
  startAgentSuggestion$,
} from "../../signals/okou-page/agent-suggestions.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ChatComposer } from "./composer.tsx";
import { AgentAvatarImg } from "./sidebar-shared.tsx";

const SUGGESTION_ACTION =
  "min-h-11 shrink-0 gap-1 whitespace-nowrap px-0.5 text-xs font-normal @min-[521px]/suggestion:min-h-9 @min-[521px]/suggestion:gap-2 @min-[521px]/suggestion:px-2";

function AgentSuggestionOption({
  option,
  onClick,
  custom = false,
}: {
  readonly option: Pick<SuggestionOption, "label" | "description" | "threadId">;
  readonly custom?: boolean;
  readonly onClick: () => void;
}) {
  const label = option.label;
  return (
    <Button
      type="button"
      variant="neutral"
      className="h-auto min-h-12 w-full justify-start gap-3 whitespace-normal rounded-lg border-border bg-card px-3 py-2.5 text-left font-normal"
      aria-label={label}
      aria-description={option.description}
      onClick={onClick}
    >
      {custom ? (
        <MessageCircle aria-hidden className="text-muted-foreground" />
      ) : option.threadId ? (
        <MessageSquare aria-hidden className="text-muted-foreground" />
      ) : (
        <MessageSquarePlus aria-hidden className="text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-5">{label}</span>
        {option.description && (
          <span className="text-xs leading-5 text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
      <ArrowRight aria-hidden className="text-muted-foreground" />
    </Button>
  );
}

function CustomDirectionOption({ onClick }: { readonly onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <AgentSuggestionOption
      custom
      option={{
        threadId: null,
        label: t(($) => {
          return $.chat.agentSuggestions.customDirection;
        }),
        description: t(($) => {
          return $.chat.agentSuggestions.customDirectionDescription;
        }),
      }}
      onClick={onClick}
    />
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

type FeedbackKind = "already_done" | "not_planned" | "less_like_this";
function AgentSuggestionActions({
  onDismiss,
  onSelect,
}: {
  readonly onDismiss: () => void;
  readonly onSelect: (kind: FeedbackKind) => void;
}) {
  const { t } = useTranslation();
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
      kind: "less_like_this" as const,
      label: t(($) => {
        return $.chat.agentSuggestions.lessLikeThis;
      }),
      Icon: SlidersHorizontal,
    },
  ];
  return (
    <div className="flex flex-nowrap items-center justify-start gap-1 overflow-x-auto border-t border-border pt-2">
      <Button
        type="button"
        variant="quiet"
        className={SUGGESTION_ACTION}
        onClick={onDismiss}
      >
        <X aria-hidden className="hidden @min-[521px]/suggestion:block" />
        {t(($) => {
          return $.chat.agentSuggestions.dismiss;
        })}
      </Button>
      {feedbackActions.map(({ kind, label, Icon }) => {
        return (
          <Button
            key={kind}
            type="button"
            variant="quiet"
            className={SUGGESTION_ACTION}
            onClick={() => {
              onSelect(kind);
            }}
          >
            <Icon
              aria-hidden
              className="hidden @min-[521px]/suggestion:block"
            />
            {label}
          </Button>
        );
      })}
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

type ComposerPreparation =
  | { readonly state: "idle" | "loading" }
  | { readonly state: "hasData"; readonly data: ComposerSignals }
  | { readonly state: "hasError"; readonly error: unknown };

/**
 * The custom direction is written over home, like a forward: the default
 * Agent receives it in a new thread and the member stays on the next card.
 */
export function AgentSuggestionComposerDialog({
  composer,
}: {
  readonly composer: ComposerPreparation;
}) {
  const { t } = useTranslation();
  const item = useGet(agentSuggestionComposerItem$);
  const close = useSet(closeAgentSuggestionComposer$);
  const agentId = useLastResolved(defaultAgentId$);
  const assistantName = useGet(assistantName$);
  const agentName = useLastResolved(defaultAgentName$) ?? assistantName;
  if (!item) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <DialogContent
        smMaxWidth="xl"
        contentClassName="grid-cols-[minmax(0,1fr)] gap-4 overflow-hidden p-5"
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="min-w-0 overflow-hidden pr-8 text-base font-semibold">
            <span className="flex min-w-0 items-center gap-2">
              {agentId ? (
                <AgentAvatarImg
                  name={agentId}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
                />
              ) : null}
              <span className="truncate text-foreground">{agentName}</span>
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(($) => {
              return $.chat.agentSuggestions.customDirectionDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {composer.state === "hasData" ? (
          <div className="w-full min-w-0" data-chat-composer>
            <ChatComposer signals={composer.data} showPendingItems={false} />
          </div>
        ) : composer.state === "hasError" ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {composer.error instanceof Error
              ? composer.error.message
              : t(($) => {
                  return $.global.errors.requestFailed;
                })}
          </p>
        ) : (
          <div className="flex min-h-40 items-center justify-center text-muted-foreground">
            <Loader2 size={16} className="animate-spin" aria-hidden />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AgentSuggestionCard({
  item,
  onCustomDirection,
  active,
}: {
  readonly item: Suggestion;
  readonly onCustomDirection: (item: Suggestion) => void;
  readonly active: boolean;
}) {
  const start = useSet(startAgentSuggestion$);
  const focusTitle = useSet(focusSuggestionTitleOnRef$);
  const submitFeedback = useSet(submitSuggestionFeedbackWithUndo$);
  const signal = useGet(pageSignal$);
  return (
    <article
      aria-labelledby={`suggestion-title-${item.id}`}
      className="flex flex-1 flex-col gap-3"
    >
      <div className="flex flex-1 flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h3
            id={`suggestion-title-${item.id}`}
            ref={active ? focusTitle : undefined}
            tabIndex={-1}
            className="text-lg font-medium leading-7 text-foreground focus:outline-none"
          >
            {item.content.title}
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {item.content.rationale}
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-2 pt-1">
          {item.content.options.map((option) => {
            return (
              <AgentSuggestionOption
                key={option.id}
                option={option}
                onClick={() => {
                  detach(start(item.id, option.id, signal), Reason.DomCallback);
                }}
              />
            );
          })}
          <CustomDirectionOption
            onClick={() => {
              onCustomDirection(item);
            }}
          />
          <div className="mt-auto pt-5">
            <AgentSuggestionActions
              onDismiss={() => {
                detach(
                  submitFeedback(item.id, "dismissed", signal),
                  Reason.DomCallback,
                );
              }}
              onSelect={(kind) => {
                detach(
                  submitFeedback(item.id, kind, signal),
                  Reason.DomCallback,
                );
              }}
            />
          </div>
        </div>
      </div>
    </article>
  );
}
