import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  MessageCircle,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  MessageSquarePlus,
  LoaderCircle,
  X,
} from "lucide-react";
import type { SuggestionOption } from "@okouai/api-contracts/contracts/suggestions";
import { Button } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import {
  agentSuggestionIndex$,
  prepareAgentSuggestion$,
  preparedAgentSuggestionId$,
  dismissAgentSuggestion$,
  showAgentSuggestion$,
  startAgentSuggestion$,
  visibleAgentSuggestions$,
} from "../../signals/okou-page/agent-suggestions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

const PAGER = "data-disabled:pointer-events-none data-disabled:opacity-50";
const DECK_EDGE =
  "pointer-events-none absolute h-10 rounded-xl border border-border bg-card";

function AgentSuggestionHeader({
  index,
  total,
}: {
  readonly index: number;
  readonly total: number;
}) {
  const { t } = useTranslation();
  const show = useSet(showAgentSuggestion$);
  return (
    <div className="flex h-7 items-center justify-between gap-3">
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {t(
          ($) => {
            return $.chat.agentSuggestions.position;
          },
          { current: index + 1, total },
        )}
      </p>
      <div className="flex items-center gap-0.5">
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          focusableWhenDisabled
          disabled={total <= 1}
          className={PAGER}
          aria-label={t(($) => {
            return $.chat.agentSuggestions.previous;
          })}
          onClick={() => {
            show((index + total - 1) % total);
          }}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          showTooltip
          focusableWhenDisabled
          disabled={total <= 1}
          className={PAGER}
          aria-label={t(($) => {
            return $.chat.agentSuggestions.next;
          })}
          onClick={() => {
            show((index + 1) % total);
          }}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function AgentSuggestionOption({
  option,
  starting,
  disabled,
  onClick,
  custom = false,
  selected = false,
}: {
  readonly option: Pick<SuggestionOption, "label" | "description" | "threadId">;
  readonly custom?: boolean;
  readonly selected?: boolean;
  readonly starting: boolean;
  readonly disabled: boolean;
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
      aria-busy={starting}
      aria-pressed={custom ? selected : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {starting ? (
        <LoaderCircle aria-hidden className="animate-spin" />
      ) : custom ? (
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
      {selected ? (
        <Check aria-hidden className="text-muted-foreground" />
      ) : (
        <ArrowRight aria-hidden className="text-muted-foreground" />
      )}
    </Button>
  );
}

function CustomDirectionOption({
  selected,
  preparing,
  disabled,
  onClick,
}: {
  readonly selected: boolean;
  readonly preparing: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AgentSuggestionOption
      custom
      selected={selected}
      option={{
        threadId: null,
        label: selected
          ? t(($) => {
              return $.chat.agentSuggestions.customPrepared;
            })
          : t(($) => {
              return $.chat.agentSuggestions.customDirection;
            }),
        description: selected
          ? t(($) => {
              return $.chat.agentSuggestions.customPreparedDescription;
            })
          : t(($) => {
              return $.chat.agentSuggestions.customDirectionDescription;
            }),
      }}
      starting={preparing}
      disabled={disabled}
      onClick={onClick}
    />
  );
}

export function AgentSuggestions() {
  const { t } = useTranslation();
  const result = useLastLoadable(visibleAgentSuggestions$);
  const [operation, start] = useLoadableSet(startAgentSuggestion$);
  const [dismissal, dismiss] = useLoadableSet(dismissAgentSuggestion$);
  const [preparation, prepare] = useLoadableSet(prepareAgentSuggestion$);
  const preparedId = useGet(preparedAgentSuggestionId$);
  const preparing = preparation.state === "loading";
  const starting = operation.state === "loading";
  const dismissing = dismissal.state === "loading";
  const signal = useGet(pageSignal$);
  const requested = useGet(agentSuggestionIndex$);
  if (result.state !== "hasData" || result.data.length === 0) {
    return null;
  }
  const items = result.data;
  const index = Math.min(requested, items.length - 1);
  const item = items[index];
  const behind = Math.min(items.length - 1, 2);
  return (
    <section
      aria-label={t(($) => {
        return $.chat.agentSuggestions.label;
      })}
      className={cn("relative", behind > 0 && "pb-3")}
    >
      {behind >= 2 && (
        <div aria-hidden className={cn(DECK_EDGE, "inset-x-6 bottom-0")} />
      )}
      {behind >= 1 && (
        <div aria-hidden className={cn(DECK_EDGE, "inset-x-3 bottom-1.5")} />
      )}
      <fieldset
        disabled={starting || dismissing || preparing}
        className="relative min-w-0"
      >
        <article className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4">
          <AgentSuggestionHeader index={index} total={items.length} />
          <div
            key={item.id}
            className="flex flex-col gap-3 motion-safe:animate-composer-panel-in"
          >
            <div className="flex flex-col gap-2">
              <h3 className="text-base font-medium leading-6 text-foreground">
                {item.title}
              </h3>
              <p className="line-clamp-4 text-sm leading-5 text-muted-foreground">
                {item.rationale}
              </p>
            </div>
            <div className="flex flex-col gap-2 pt-1">
              <p className="text-xs text-muted-foreground">
                {t(($) => {
                  return $.chat.agentSuggestions.useSuggestion;
                })}
              </p>
              {item.options.map((option) => {
                return (
                  <AgentSuggestionOption
                    key={option.id}
                    option={option}
                    starting={starting}
                    disabled={starting || dismissing || preparing}
                    onClick={() => {
                      detach(
                        start(item, option.id, signal),
                        Reason.DomCallback,
                      );
                    }}
                  />
                );
              })}
              <CustomDirectionOption
                selected={preparedId === item.id}
                preparing={preparing}
                disabled={starting || dismissing || preparing}
                onClick={() => {
                  detach(prepare(item, signal), Reason.DomCallback);
                }}
              />
              <div className="border-t border-border pt-1">
                <Button
                  type="button"
                  variant="quiet"
                  className="w-full justify-start gap-2 px-3 text-xs font-normal"
                  disabled={dismissing}
                  onClick={() => {
                    detach(dismiss(item, signal), Reason.DomCallback);
                  }}
                >
                  {dismissing ? (
                    <LoaderCircle aria-hidden className="animate-spin" />
                  ) : (
                    <X aria-hidden />
                  )}
                  {t(($) => {
                    return $.chat.agentSuggestions.dismiss;
                  })}
                </Button>
              </div>
            </div>
          </div>
        </article>
      </fieldset>
    </section>
  );
}
