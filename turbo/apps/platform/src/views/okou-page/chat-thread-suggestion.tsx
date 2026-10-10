import type { ComponentProps, Ref } from "react";
import { cn, PopoverContent } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { ComposerAgentSuggestion } from "../../signals/okou-page/composer-agent-suggestion-domain.ts";
import type { ComposerChatThreadSuggestion } from "../../signals/okou-page/chat-thread-suggestion-domain.ts";
import { AvatarFromUrl } from "./sidebar-shared.tsx";

function scrollSelectedSuggestionIntoView(
  option: HTMLButtonElement | null,
): void {
  if (!option) {
    return;
  }
  window.requestAnimationFrame(() => {
    if (typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

function ComposerMentionSuggestionItem({
  name,
  avatarUrl,
  selected,
  onSelect,
}: {
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      ref={selected ? scrollSelectedSuggestionIntoView : undefined}
      type="button"
      data-active={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-state-hover",
      )}
      onClick={onSelect}
    >
      <AvatarFromUrl
        avatarUrl={avatarUrl}
        alt=""
        className="h-5 w-5 shrink-0 rounded-full"
        size={20}
      />
      <span className="truncate text-sm text-popover-foreground">{name}</span>
    </button>
  );
}

export function ComposerMentionSuggestionMenu({
  menuRef,
  anchor,
  composerAnchored,
  agents,
  chatThreads,
  selectedIndex,
  onSelectAgent,
  onSelectChatThread,
}: {
  readonly menuRef: Ref<HTMLDivElement>;
  readonly anchor?: ComponentProps<typeof PopoverContent>["anchor"];
  readonly composerAnchored: boolean;
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
  readonly selectedIndex: number;
  readonly onSelectAgent: (agent: ComposerAgentSuggestion) => void;
  readonly onSelectChatThread: (
    chatThread: ComposerChatThreadSuggestion,
  ) => void;
}) {
  const { t } = useTranslation();
  // Preserve relevance indices for keyboard selection and insertion while
  // rendering both groups and their candidates in bottom-first priority order.
  const agentSection = agents.length > 0 && (
    <div key="agents">
      <div className="px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.chat.composer.agentSuggestions;
        })}
      </div>
      {(composerAnchored ? [...agents].reverse() : agents).map(
        (agent, visualIndex) => {
          const index = composerAnchored
            ? agents.length - 1 - visualIndex
            : visualIndex;
          const selected = index === selectedIndex;
          return (
            <ComposerMentionSuggestionItem
              key={agent.id}
              name={agent.name}
              avatarUrl={agent.avatarUrl}
              selected={selected}
              onSelect={() => {
                onSelectAgent(agent);
              }}
            />
          );
        },
      )}
    </div>
  );
  const threadSection = chatThreads.length > 0 && (
    <div key="threads">
      <div className="px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.chat.composer.threadSuggestions;
        })}
      </div>
      {(composerAnchored ? [...chatThreads].reverse() : chatThreads).map(
        (chatThread, visualIndex) => {
          const index = composerAnchored
            ? chatThreads.length - 1 - visualIndex
            : visualIndex;
          const selected = agents.length + index === selectedIndex;
          return (
            <ComposerMentionSuggestionItem
              key={chatThread.id}
              name={chatThread.title}
              avatarUrl={chatThread.avatarUrl}
              selected={selected}
              onSelect={() => {
                onSelectChatThread(chatThread);
              }}
            />
          );
        },
      )}
    </div>
  );
  return (
    <PopoverContent
      ref={menuRef}
      anchor={anchor}
      side="top"
      align="start"
      sideOffset={8}
      collisionAvoidance={composerAnchored ? { side: "none" } : undefined}
      initialFocus={false}
      finalFocus={false}
      className={cn(
        "flex flex-col overflow-hidden p-0",
        composerAnchored
          ? "max-h-[min(16rem,var(--available-height))] w-(--anchor-width) md:max-h-[min(20rem,var(--available-height))]"
          : "h-[min(16rem,var(--available-height))] w-[260px] max-w-[calc(100vw-1.5rem)] md:h-[min(20rem,var(--available-height))]",
      )}
      data-testid="chat-thread-suggestion-menu"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {composerAnchored
          ? [threadSection, agentSection]
          : [agentSection, threadSection]}
      </div>
    </PopoverContent>
  );
}
