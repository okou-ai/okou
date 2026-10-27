import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import {
  Button,
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import {
  currentChatAgentDisplayName$,
  currentChatAgentId$,
} from "../../signals/agent-chat.ts";
import { assistantName$ } from "../../signals/branding.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/chat-thread-indicators-from-worker.ts";
import {
  pwaAgentOptions$,
  pwaOtherAgentsHaveUnreadChats$,
  pwaAgentQuery$,
  pwaAgentSwitcherOpen$,
  selectPwaAgent$,
  setPwaAgentQuery$,
  setPwaAgentSwitcherOpen$,
} from "../../signals/okou-page/pwa-chat-list.ts";
import { equalSets } from "../../lib/equality.ts";
import { AgentUnreadIndicator } from "./sidebar-agent-row-actions.tsx";
import { AgentAvatarImg } from "./sidebar-shared.tsx";

function AgentOptions() {
  const { t } = useTranslation();
  const { t: ta } = useTranslation("agents");
  const options = useLoadable(pwaAgentOptions$);
  const currentAgentId = useLastResolved(currentChatAgentId$);
  const selectAgent = useSet(selectPwaAgent$);
  const unreadAgentIds = useLastResolved(unreadAgentIds$, {
    equalityFn: equalSets,
  });

  if (options.state === "loading") {
    return <Skeleton className="m-2 h-11" />;
  }
  if (options.state === "hasError") {
    return (
      <div className="px-3 py-4 text-sm text-muted-foreground">
        <p role="alert">
          {t(($) => {
            return $.appShell.pwaNavigation.agentsUnavailable;
          })}
        </p>
      </div>
    );
  }
  if (options.data.length === 0) {
    return (
      <p className="px-3 py-4 text-sm text-muted-foreground">
        {ta(($) => {
          return $.sidebar.noResults;
        })}
      </p>
    );
  }

  return options.data.map((agent) => {
    const label = agent.displayName ?? agent.agentId;
    const selected = agent.agentId === currentAgentId;
    return (
      <CommandItem
        key={agent.agentId}
        value={agent.agentId}
        aria-label={label}
        onClick={() => {
          selectAgent(agent.agentId);
        }}
        className="min-h-11 gap-3 px-3 py-2 hover:bg-state-hover"
      >
        <span className="relative flex shrink-0">
          <AgentAvatarImg
            name={agent.agentId}
            alt=""
            className="size-8 rounded-lg object-cover object-top"
          />
          {unreadAgentIds?.has(agent.agentId) && (
            <span className="absolute -right-0.5 -top-0.5 flex">
              <AgentUnreadIndicator />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {selected ? <Check size={16} aria-hidden="true" /> : null}
      </CommandItem>
    );
  });
}

export function PwaAgentSwitcher() {
  const { t } = useTranslation();
  const open = useGet(pwaAgentSwitcherOpen$);
  const setOpen = useSet(setPwaAgentSwitcherOpen$);
  const query = useGet(pwaAgentQuery$);
  const setQuery = useSet(setPwaAgentQuery$);
  const agentId = useLastResolved(currentChatAgentId$);
  const agentDisplayName = useLastResolved(currentChatAgentDisplayName$);
  const assistantName = useGet(assistantName$);
  const otherAgentsUnread = useLastResolved(pwaOtherAgentsHaveUnreadChats$);
  const switchLabel = t(($) => {
    return $.appShell.pwaNavigation.switchAgent;
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="quiet" />}
        aria-label={switchLabel}
        className="min-h-11 min-w-0 max-w-full justify-start gap-2 px-2 text-foreground"
      >
        <AgentAvatarImg
          name={agentId ?? ""}
          alt=""
          className="size-8 shrink-0 rounded-lg object-cover object-top"
        />
        <span className="min-w-0 truncate text-base font-semibold">
          {agentDisplayName ?? assistantName}
        </span>
        <ChevronDown size={16} aria-hidden="true" />

        {otherAgentsUnread && (
          <span className="-ml-1 flex shrink-0">
            <AgentUnreadIndicator />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={switchLabel}
        className="w-80 max-w-[calc(100vw-24px)] p-1"
      >
        <Command
          mode="none"
          autoHighlight
          loopFocus
          value={query}
          onValueChange={(value, details) => {
            if (details.reason === "item-press") {
              details.cancel();
              return;
            }
            setQuery(value);
          }}
        >
          <div className="p-2">
            <CommandInput
              aria-label={t(($) => {
                return $.appShell.pwaNavigation.searchAgents;
              })}
              placeholder={t(($) => {
                return $.appShell.pwaNavigation.searchAgents;
              })}
            />
          </div>
          <CommandList>
            <AgentOptions />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
