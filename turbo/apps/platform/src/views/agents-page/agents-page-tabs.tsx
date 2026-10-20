import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import {
  surfaceVariants,
  Card,
  CardContent,
  Button,
  SegmentControl,
  SegmentControlItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import {
  orgMemberProfiles$,
  type OrgMember,
} from "../../signals/external/org-members.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/chat-thread-indicators-from-worker.ts";
import { Link } from "../router/link.tsx";
import { AgentAvatarImg } from "../okou-page/sidebar-shared.tsx";
import {
  jobsActiveTab$,
  setJobsActiveTab$,
  openCreateAgentDialog$,
} from "../../signals/okou-page/jobs-page.ts";
import { platformEmptyPrivateAgentsImg } from "../../lib/static-assets.ts";

type Visibility = "public" | "private";

export function AgentsPageTabs() {
  const { t } = useTranslation("agents");
  const activeTab = useGet(jobsActiveTab$);
  const setActiveTab = useSet(setJobsActiveTab$);
  const openCreateDialog = useSet(openCreateAgentDialog$);
  const defaultAgentName = useLastResolved(defaultAgentName$);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto max-w-[900px] flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 hidden md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              {t(($) => {
                return $.list.title;
              })}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t(
                ($) => {
                  return $.list.description;
                },
                {
                  agentName:
                    defaultAgentName ??
                    t(($) => {
                      return $.fallbackName;
                    }),
                },
              )}
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-safe-or-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <AgentTabsView
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onCreate={() => {
              openCreateDialog();
            }}
          />
        </div>
      </main>
    </div>
  );
}

function AgentTabsView({
  activeTab,
  onTabChange,
  onCreate,
}: {
  activeTab: Visibility;
  onTabChange: (tab: Visibility) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation("agents");
  const agentsLoadable = useLoadable(sortedAgents$);
  const membersLoadable = useLoadable(orgMemberProfiles$);
  const unreadAgentIds = useLastResolved(unreadAgentIds$);
  const loading = agentsLoadable.state === "loading";
  const agents =
    agentsLoadable.state === "hasData" ? agentsLoadable.data : null;
  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];
  const membersById = new Map(
    members.map((member) => {
      return [member.userId, member];
    }),
  );
  const skeleton = loading && !agents;

  const visibleAgents =
    agents?.filter((a) => {
      return activeTab === "public"
        ? a.visibility !== "private"
        : a.visibility === "private";
    }) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <SegmentControl
          aria-label={t(($) => {
            return $.list.create.visibilityLabel;
          })}
          value={activeTab}
          onValueChange={onTabChange}
        >
          <SegmentControlItem value="public">
            {t(($) => {
              return $.list.tabs.public;
            })}
          </SegmentControlItem>
          <SegmentControlItem value="private">
            {t(($) => {
              return $.list.tabs.private;
            })}
          </SegmentControlItem>
        </SegmentControl>
        <Button
          variant="neutral"
          size="sm"
          className="h-9 gap-2 shrink-0 rounded-lg"
          onClick={onCreate}
        >
          <Plus size={14} />
          {t(($) => {
            return $.list.actions.new;
          })}
        </Button>
      </div>

      {skeleton ? (
        <AgentGridSkeleton />
      ) : visibleAgents.length > 0 ? (
        <AgentGrid
          agents={visibleAgents}
          membersById={membersById}
          unreadAgentIds={unreadAgentIds}
          showCreator={activeTab !== "private"}
        />
      ) : activeTab === "private" ? (
        <PrivateEmptyState />
      ) : null}
    </div>
  );
}

function PrivateEmptyState() {
  const { t } = useTranslation("agents");
  return (
    <div
      className={surfaceVariants({
        className:
          "flex min-h-[20rem] flex-col items-center justify-center px-6 text-center",
      })}
    >
      <img
        src={platformEmptyPrivateAgentsImg}
        alt=""
        aria-hidden="true"
        className="h-24 w-24 object-contain opacity-80"
      />
      <p className="mt-3 text-sm font-medium text-foreground">
        {t(($) => {
          return $.list.privateEmpty.title;
        })}
      </p>
      <p className="mt-1 max-w-[340px] text-sm text-muted-foreground">
        {t(($) => {
          return $.list.privateEmpty.description;
        })}
      </p>
    </div>
  );
}

function AgentGrid({
  agents,
  membersById,
  unreadAgentIds,
  showCreator,
}: {
  agents: AgentProps["agent"][];
  membersById: ReadonlyMap<string, OrgMember>;
  unreadAgentIds: ReadonlySet<string> | undefined;
  showCreator: boolean;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {agents.map((agent) => {
        return (
          <Link
            key={agent.agentId}
            pathname="/agents/:agentId"
            options={{ pathParams: { agentId: agent.agentId } }}
            className="block no-underline text-inherit"
          >
            <AgentCard
              agent={agent}
              creator={agentCreator(
                agent,
                membersById,
                t(($) => {
                  return $.list.cards.unknownCreator;
                }),
              )}
              hasUnread={unreadAgentIds?.has(agent.agentId) ?? false}
              showCreator={showCreator}
            />
          </Link>
        );
      })}
    </div>
  );
}

function AgentGridSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {[1, 2, 3].map((i) => {
        return (
          <Card key={i} className={surfaceVariants()}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3 animate-pulse">
                <div className="h-10 w-10 rounded-full bg-muted" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-4 w-24 rounded bg-muted" />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

type AgentProps = {
  agent: {
    agentId: string;
    ownerId?: string;
    displayName?: string | null;
    description?: string | null;
    visibility?: "public" | "private" | null;
  };
  creator: AgentCreator;
  hasUnread: boolean;
  showCreator: boolean;
};

interface AgentCreator {
  readonly name: string;
  readonly imageUrl: string | null;
}

function orgMemberDisplayName(member: OrgMember): string {
  const fullName = [member.firstName, member.lastName]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join(" ");
  return fullName || member.email || member.userId;
}

function agentCreator(
  agent: AgentProps["agent"],
  membersById: ReadonlyMap<string, OrgMember>,
  unknownName: string,
): AgentCreator {
  if (!agent.ownerId) {
    return { name: unknownName, imageUrl: null };
  }

  const member = membersById.get(agent.ownerId);
  return member
    ? { name: orgMemberDisplayName(member), imageUrl: member.imageUrl }
    : { name: agent.ownerId, imageUrl: null };
}

function CreatorAvatar({ creator }: { creator: AgentCreator }) {
  if (creator.imageUrl) {
    return (
      <img
        src={creator.imageUrl}
        alt=""
        aria-hidden="true"
        className="h-full w-full rounded-full object-cover"
      />
    );
  }

  return (
    <span className="flex h-full w-full items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
      {creator.name.charAt(0).toUpperCase()}
    </span>
  );
}

function AgentUnreadIndicator() {
  const { t } = useTranslation("agents");
  return (
    <span
      aria-label={t(($) => {
        return $.status.unread;
      })}
      className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-card bg-sky-600"
    />
  );
}

function AgentCard({ agent, creator, hasUnread, showCreator }: AgentProps) {
  const { t } = useTranslation("agents");
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const lead = agent.agentId === defaultAgentId;
  const displayName = agent.displayName ?? agent.agentId;
  const description = defaultAgentId
    ? agent.description ||
      (lead
        ? t(($) => {
            return $.list.cards.coreDescription;
          })
        : t(($) => {
            return $.list.cards.subagentDescription;
          }))
    : "";
  return (
    <Card
      className={surfaceVariants({
        interactive: true,
        className: "flex flex-col h-full",
      })}
    >
      <CardContent className="flex flex-1 flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="relative h-10 w-10 shrink-0">
            <AgentAvatarImg
              name={agent.agentId}
              alt={displayName}
              className="h-10 w-10 rounded-full object-cover object-top"
            />
            {hasUnread && <AgentUnreadIndicator />}
          </span>
          <div className="flex-1 min-w-0">
            {showCreator ? (
              <TooltipProvider delay={200}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="block w-fit max-w-full truncate text-sm font-medium text-foreground underline decoration-dotted decoration-foreground/40 decoration-[1px] underline-offset-2">
                        {displayName}
                      </span>
                    }
                  />
                  <TooltipContent
                    side="bottom"
                    align="start"
                    // Preserve the literal shadow; the card token changes under palettes.
                    className="w-64 rounded-lg border border-[hsl(var(--gray-400))] p-3 text-left font-normal bg-popover! text-popover-foreground! shadow-[0_2px_12px_hsl(30_6%_45%/0.05),0_0_0_0.5px_hsl(30_6%_45%/0.025)] whitespace-normal"
                  >
                    <span className="flex items-center gap-2">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
                        <CreatorAvatar creator={creator} />
                      </span>
                      <span className="text-xs font-medium text-foreground">
                        {t(
                          ($) => {
                            return $.list.cards.createdBy;
                          },
                          { creator: creator.name },
                        )}
                      </span>
                    </span>
                    {description && (
                      <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">
                        {description}
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <span className="block truncate text-sm font-medium text-foreground">
                {displayName}
              </span>
            )}
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
              {description}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
