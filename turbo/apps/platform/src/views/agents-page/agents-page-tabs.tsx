import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { Loader2, Plus, Wand } from "lucide-react";
import {
  surfaceVariants,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
  SegmentControl,
  SegmentControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { createSubagent$ } from "../../signals/okou-page/agents.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import {
  orgMembers$,
  type OrgMember,
} from "../../signals/external/org-members.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/chat-thread-indicators-from-worker.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { onDomEventFn } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { AgentAvatarImg, AvatarFromUrl } from "../okou-page/sidebar-shared.tsx";
import {
  jobsDialogOpen$,
  setJobsDialogOpen$,
  jobsNewName$,
  setJobsNewName$,
  jobsAvatarUrl$,
  setJobsAvatarUrl$,
  jobsVisibility$,
  setJobsVisibility$,
  jobsActiveTab$,
  setJobsActiveTab$,
  resetJobsDialog$,
} from "../../signals/okou-page/jobs-page.ts";
import { serializeAvatarSvgConfig } from "../okou-page/avatar-svg-utils.ts";
import { AvatarMaker } from "../okou-page/avatar-maker.tsx";
import { platformEmptyPrivateAgentsImg } from "../../lib/static-assets.ts";

const MAX_PUBLIC_AGENTS = 7;

type Visibility = "public" | "private";

export function AgentsPageTabs() {
  const { t } = useTranslation("agents");
  const dialogOpen = useGet(jobsDialogOpen$);
  const setDialogOpen = useSet(setJobsDialogOpen$);
  const newName = useGet(jobsNewName$);
  const setNewName = useSet(setJobsNewName$);
  const visibility = useGet(jobsVisibility$);
  const setVisibility = useSet(setJobsVisibility$);
  const activeTab = useGet(jobsActiveTab$);
  const setActiveTab = useSet(setJobsActiveTab$);
  const [createLoadable, createSubagentFn] = useLoadableSet(createSubagent$);
  const creating = createLoadable.state === "loading";
  const resetDialog = useSet(resetJobsDialog$);
  const pageSignal = useGet(pageSignal$);
  const defaultAgentName = useLastResolved(defaultAgentName$);

  const agentsLoadable = useLoadable(sortedAgents$);
  const publicAgentCount =
    agentsLoadable.state === "hasData"
      ? agentsLoadable.data.filter((agent) => {
          return agent.visibility !== "private";
        }).length
      : 0;
  const atPublicLimit = publicAgentCount >= MAX_PUBLIC_AGENTS;

  const openCreateDialog = (target: Visibility) => {
    resetDialog();
    setVisibility(target);
    setDialogOpen(true);
  };

  const handleCreateTeammate = onDomEventFn(async (avatarUrl: string) => {
    const trimmed = newName.trim();
    if (!trimmed || creating) {
      return;
    }
    await createSubagentFn(trimmed, avatarUrl, visibility, pageSignal);
    setDialogOpen(false);
    toast.success(
      t(
        ($) => {
          return $.list.create.success;
        },
        { agentName: trimmed },
      ),
    );
  });

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

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-[max(2rem,var(--sab))]">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <AgentTabsView
            activeTab={activeTab}
            onTabChange={setActiveTab}
            atPublicLimit={atPublicLimit}
            onCreate={openCreateDialog}
          />
        </div>
      </main>

      <CreateTeammateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        newName={newName}
        onNameChange={setNewName}
        onConfirm={handleCreateTeammate}
        creating={creating}
        visibility={visibility}
        onVisibilityChange={setVisibility}
      />
    </div>
  );
}

function AgentTabsView({
  activeTab,
  onTabChange,
  atPublicLimit,
  onCreate,
}: {
  activeTab: Visibility;
  onTabChange: (tab: Visibility) => void;
  atPublicLimit: boolean;
  onCreate: (visibility: Visibility) => void;
}) {
  const { t } = useTranslation("agents");
  const agentsLoadable = useLoadable(sortedAgents$);
  const membersLoadable = useLoadable(orgMembers$);
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

  const createDisabled = activeTab === "public" && atPublicLimit;

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
          disabled={createDisabled}
          onClick={() => {
            return onCreate(activeTab);
          }}
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

function CreateTeammateDialog({
  open,
  onOpenChange,
  newName,
  onNameChange,
  onConfirm,
  creating,
  visibility,
  onVisibilityChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  creating: boolean;
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={creating ? undefined : onOpenChange}>
      <CreateTeammateDialogContent
        newName={newName}
        onNameChange={onNameChange}
        onConfirm={onConfirm}
        onCancel={() => {
          return onOpenChange(false);
        }}
        creating={creating}
        visibility={visibility}
        onVisibilityChange={onVisibilityChange}
      />
    </Dialog>
  );
}

function CreateAgentAvatarPreview() {
  const { t } = useTranslation("agents");
  const avatarUrl = useGet(jobsAvatarUrl$);
  const setAvatarUrl = useSet(setJobsAvatarUrl$);

  return (
    <div className="flex flex-col items-center pt-10 pb-6 bg-muted/30">
      <AvatarMaker
        onConfirm={(cfg) => {
          setAvatarUrl(serializeAvatarSvgConfig(cfg));
          return Promise.resolve();
        }}
        trigger={(openMaker) => {
          return (
            <button
              type="button"
              onClick={openMaker}
              className="relative rounded-full transition-transform duration-200 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={t(($) => {
                return $.avatar.actions.customize;
              })}
            >
              <AvatarFromUrl
                avatarUrl={avatarUrl}
                alt={t(($) => {
                  return $.list.create.newAgentAlt;
                })}
                className="h-16 w-16 rounded-full object-cover object-top"
              />
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="absolute -right-0.5 -bottom-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border">
                      <Wand size={10} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">
                      {t(($) => {
                        return $.avatar.actions.customize;
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </button>
          );
        }}
      />
    </div>
  );
}

function CreateAgentFields({
  newName,
  onNameChange,
  onConfirm,
  creating,
  visibility,
  onVisibilityChange,
  avatarUrl,
}: {
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  creating: boolean;
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
  avatarUrl: string;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex flex-col gap-4 px-6 py-6">
      <div className="text-center">
        <p className="text-base font-semibold">
          {t(($) => {
            return $.list.create.title;
          })}
        </p>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t(($) => {
            return $.list.create.description;
          })}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="new-agent-name"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.profile.fields.name.label;
          })}
        </label>
        <Input
          id="new-agent-name"
          value={newName}
          onChange={(e) => {
            return onNameChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim() && !creating) {
              onConfirm(avatarUrl);
            }
          }}
          placeholder={t(($) => {
            return $.list.create.namePlaceholder;
          })}
          autoFocus
          disabled={creating}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">
          {t(($) => {
            return $.list.create.visibilityLabel;
          })}
        </span>
        <Select
          value={visibility}
          onValueChange={(value) => {
            if (value === "public" || value === "private") {
              onVisibilityChange(value);
            }
          }}
          disabled={creating}
        >
          <SelectTrigger
            className="h-9 w-full"
            aria-label={t(($) => {
              return $.list.create.visibilityLabel;
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">
              {t(($) => {
                return $.list.create.visibility.private.label;
              })}{" "}
              <span className="text-muted-foreground">
                {t(($) => {
                  return $.list.create.visibility.private.description;
                })}
              </span>
            </SelectItem>
            <SelectItem value="public">
              {t(($) => {
                return $.list.create.visibility.public.label;
              })}{" "}
              <span className="text-muted-foreground">
                {t(($) => {
                  return $.list.create.visibility.public.description;
                })}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function CreateTeammateDialogContent({
  newName,
  onNameChange,
  onConfirm,
  onCancel,
  creating,
  visibility,
  onVisibilityChange,
}: {
  newName: string;
  onNameChange: (name: string) => void;
  onConfirm: (avatarUrl: string) => void;
  onCancel: () => void;
  creating: boolean;
  visibility: Visibility;
  onVisibilityChange: (visibility: Visibility) => void;
}) {
  const { t } = useTranslation("agents");
  const avatarUrl = useGet(jobsAvatarUrl$);

  return (
    <DialogContent
      closeLabel={t(($) => {
        return $.actions.close;
      })}
      smMaxWidth={480}
      contentClassName="p-0 gap-0 overflow-hidden"
    >
      <DialogHeader className="sr-only">
        <DialogTitle>
          {t(($) => {
            return $.list.create.title;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.list.create.accessibilityDescription;
          })}
        </DialogDescription>
      </DialogHeader>

      <CreateAgentAvatarPreview />

      <CreateAgentFields
        newName={newName}
        onNameChange={onNameChange}
        onConfirm={onConfirm}
        creating={creating}
        visibility={visibility}
        onVisibilityChange={onVisibilityChange}
        avatarUrl={avatarUrl}
      />

      {/* Footer */}
      <div className="flex justify-center gap-3 px-6 pt-4 pb-8">
        <Button variant="outline" onClick={onCancel} disabled={creating}>
          {t(($) => {
            return $.actions.cancel;
          })}
        </Button>
        <Button
          onClick={() => {
            return onConfirm(avatarUrl);
          }}
          disabled={!newName.trim() || creating}
        >
          {creating ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 size={14} className="animate-spin" />
              {t(($) => {
                return $.list.create.creating;
              })}
            </span>
          ) : (
            t(($) => {
              return $.actions.create;
            })
          )}
        </Button>
      </div>
    </DialogContent>
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
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="block w-fit max-w-full truncate text-sm font-medium text-foreground underline decoration-dotted decoration-foreground/40 decoration-[1px] underline-offset-2">
                      {displayName}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    align="start"
                    className="w-64 rounded-lg border border-[hsl(var(--gray-400))] p-3 text-left font-normal"
                    style={{
                      backgroundColor: "hsl(var(--popover))",
                      color: "hsl(var(--popover-foreground))",
                      // Matches --okou-card-shadow; inlined because the tooltip
                      // portal renders outside .okou-app where the var is scoped.
                      boxShadow:
                        "0 2px 12px hsl(30 6% 45% / 0.05), 0 0 0 0.5px hsl(30 6% 45% / 0.025)",
                      whiteSpace: "normal",
                    }}
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
              <span
                className="block truncate text-sm font-medium text-foreground"
                title={displayName}
              >
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
