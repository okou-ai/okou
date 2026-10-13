import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  MessageSquarePlus,
} from "lucide-react";
import { Button, Skeleton } from "@okouai/ui";
import {
  visibleAgentSuggestions$,
  startAgentSuggestion$,
  agentSuggestionsExpanded$,
  toggleAgentSuggestionsExpanded$,
} from "../../signals/okou-page/agent-suggestions.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function AgentSuggestions() {
  const { t } = useTranslation();
  const result = useLoadable(visibleAgentSuggestions$);
  const start = useSet(startAgentSuggestion$);
  const signal = useGet(pageSignal$);
  const expanded = useGet(agentSuggestionsExpanded$);
  const toggleExpanded = useSet(toggleAgentSuggestionsExpanded$);
  if (result.state === "loading") {
    return <Skeleton className="h-20 w-full" />;
  }
  if (result.state === "hasError") {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.agentSuggestions.loadFailed;
        })}
      </p>
    );
  }
  const items = result.data;
  if (items.length === 0) {
    return null;
  }
  return (
    <section
      aria-label={t(($) => {
        return $.chat.agentSuggestions.label;
      })}
      className="flex flex-col gap-2"
    >
      <p className="text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.agentSuggestions.origin;
        })}
      </p>
      {(expanded ? items : items.slice(0, 5)).map((item) => {
        return (
          <Button
            key={item.id}
            type="button"
            variant="quiet"
            className="h-auto w-full justify-start gap-3 whitespace-normal rounded-none border-b border-border px-0 py-3 text-left"
            onClick={() => {
              detach(start(item, signal), Reason.DomCallback);
            }}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium">{item.title}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {item.rationale}
                </span>
              </span>
              <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground sm:shrink-0">
                {item.threadId ? (
                  <MessageSquare aria-hidden className="size-3" />
                ) : (
                  <MessageSquarePlus aria-hidden className="size-3" />
                )}
                {item.threadId
                  ? t(($) => {
                      return $.chat.agentSuggestions.existingThread;
                    })
                  : t(($) => {
                      return $.chat.agentSuggestions.newThread;
                    })}
              </span>
            </span>
            <ArrowUpRight
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </Button>
        );
      })}
      {items.length > 5 && (
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="self-center"
          onClick={() => {
            return toggleExpanded();
          }}
        >
          {expanded
            ? t(($) => {
                return $.chat.agentSuggestions.showLess;
              })
            : t(
                ($) => {
                  return $.chat.agentSuggestions.showAll;
                },
                {
                  count: items.length,
                },
              )}
          {expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </Button>
      )}
    </section>
  );
}
