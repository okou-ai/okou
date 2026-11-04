import type { ComponentProps, Ref } from "react";
import { cn, PopoverContent } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
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
  project,
  selected,
  onSelect,
}: {
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly project?: true;
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
      {project ? (
        <Folder
          size={20}
          className="shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      ) : (
        <AvatarFromUrl
          avatarUrl={avatarUrl}
          alt=""
          className="h-5 w-5 shrink-0 rounded-full"
          size={20}
        />
      )}
      <span className="truncate text-sm text-popover-foreground">{name}</span>
    </button>
  );
}

export function ComposerMentionSuggestionMenu({
  menuRef,
  anchor,
  agents,
  chatThreads,
  selectedIndex,
  onSelectAgent,
  onSelectChatThread,
}: {
  readonly menuRef: Ref<HTMLDivElement>;
  readonly anchor?: ComponentProps<typeof PopoverContent>["anchor"];
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
  readonly selectedIndex: number;
  readonly onSelectAgent: (agent: ComposerAgentSuggestion) => void;
  readonly onSelectChatThread: (
    chatThread: ComposerChatThreadSuggestion,
  ) => void;
}) {
  const { t } = useTranslation();
  const agentSection = agents.length > 0 && (
    <div key="agents">
      <div className="px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.chat.composer.agentSuggestions;
        })}
      </div>
      {agents.map((agent, index) => {
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
      })}
    </div>
  );
  const threadSection = chatThreads.length > 0 && (
    <div key="threads">
      {chatThreads.map((chatThread, index) => {
        const selected = agents.length + index === selectedIndex;
        return (
          <div key={chatThread.id}>
            {(index === 0 ||
              chatThread.project !== chatThreads[index - 1]?.project) && (
              <div className="px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {chatThread.project
                  ? t(($) => {
                      return $.projects.projects;
                    })
                  : t(($) => {
                      return $.chat.composer.threadSuggestions;
                    })}
              </div>
            )}
            <ComposerMentionSuggestionItem
              name={chatThread.title}
              avatarUrl={chatThread.avatarUrl}
              project={chatThread.project}
              selected={selected}
              onSelect={() => {
                onSelectChatThread(chatThread);
              }}
            />
          </div>
        );
      })}
    </div>
  );
  return (
    <PopoverContent
      ref={menuRef}
      anchor={anchor}
      // Composer-anchored menus always open above the composer, on the home
      // page as in a chat, and never flip below it.
      side="top"
      align="start"
      sideOffset={8}
      collisionAvoidance={{ side: "none" }}
      initialFocus={false}
      finalFocus={false}
      className="flex max-h-[min(16rem,var(--available-height))] w-(--anchor-width) flex-col overflow-hidden p-0 md:max-h-[min(20rem,var(--available-height))]"
      data-testid="chat-thread-suggestion-menu"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {agentSection}
        {threadSection}
      </div>
    </PopoverContent>
  );
}
