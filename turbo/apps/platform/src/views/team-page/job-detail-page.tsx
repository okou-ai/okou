// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { FileText, UserCircle, Users, MessageCircle, Wand } from "lucide-react";
import {
  surfaceVariants,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Card,
  CardContent,
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  buttonVariants,
} from "@okouai/ui";
import { InstructionsTab } from "../okou-page/instructions-tab.tsx";
import { SettingsTab } from "../okou-page/settings-tab.tsx";
import { TONE_OPTIONS, type Tone } from "../okou-page/tone-constants.ts";
import { agentDetail$ } from "../../signals/okou-page/job-detail/detail";
import {
  agentInstructions$,
  agentInstructionsDraft$,
  agentInstructionsConflict$,
  agentInstructionsEditorRevision$,
  setAgentEditedContent$,
  discardAgentEdit$,
  buildAgentInstructions$,
  reloadLatestAgentInstructions$,
} from "../../signals/okou-page/job-detail/instructions";
import { updateAgentSettings$ } from "../../signals/okou-page/job-detail/settings";

import {
  agentActiveTab$,
  setAgentActiveTab$,
} from "../../signals/okou-page/job-detail/agent-name";
import { Link } from "../router/link.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentAvatarImg } from "../okou-page/sidebar-shared.tsx";
import { openAvatarMaker$ } from "../../signals/okou-page/settings/avatar-maker.ts";
import {
  agents$,
  currentAgent$,
  currentAgentId$,
} from "../../signals/agent.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { user$ } from "../../signals/auth.ts";
import { NoPermissionIllustration } from "../okou-page/components/no-permission-illustration.tsx";

import { currentAgentVisibleWorkflows$ } from "../../signals/workflows-page/workflows-signals.ts";
import { toast } from "@okouai/ui/components/ui/sonner";

import {
  DetailPageBreadcrumbBar,
  DetailPageHeader,
  DetailPageMain,
  DetailPageShell,
} from "../components/detail-page-layout.tsx";
// ---------------------------------------------------------------------------
// Page shell: skeleton, error, header
// ---------------------------------------------------------------------------

function loadableErrorMessage(
  loadable: {
    state: string;
    error?: unknown;
  },
  unknownErrorMessage: string,
): string | null {
  if (loadable.state !== "hasError") {
    return null;
  }
  return loadable.error instanceof Error
    ? loadable.error.message
    : unknownErrorMessage;
}

function Breadcrumb({
  currentName,
  className,
}: {
  currentName?: string;
  className?: string;
}) {
  const { t } = useTranslation("agents");
  return (
    <DetailPageBreadcrumbBar className={className}>
      <Link
        pathname="/agents"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-state-hover hover:text-foreground transition-colors no-underline text-inherit"
      >
        <Users size={14} className="shrink-0" />
        {t(($) => {
          return $.list.title;
        })}
      </Link>
      <span className="text-muted-foreground/40 select-none">/</span>
      <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
        {currentName ??
          t(($) => {
            return $.fallbackName;
          })}
      </span>
    </DetailPageBreadcrumbBar>
  );
}

function DetailSkeleton() {
  return (
    <DetailPageShell scroll={false}>
      <Breadcrumb />
      <DetailPageHeader className="pb-3">
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-48 rounded bg-muted" />
          <div className="h-4 w-72 rounded bg-muted" />
          <div className="h-9 w-80 rounded bg-muted mt-4" />
        </div>
      </DetailPageHeader>
    </DetailPageShell>
  );
}

function isNotFoundError(error: string): boolean {
  return /not found|404|no(t| )exist/i.test(error);
}

function DetailError({ error, agentId }: { error: string; agentId: string }) {
  const { t } = useTranslation("agents");
  if (isNotFoundError(error)) {
    return (
      <DetailPageShell scroll={false}>
        <Breadcrumb />
        <main className="flex-1 flex items-center justify-center px-4 sm:px-6 pb-safe-or-16">
          <div className="flex flex-col items-center text-center gap-4 max-w-sm">
            <NoPermissionIllustration className="h-32 w-auto max-w-[220px] object-contain" />
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-foreground">
                {t(($) => {
                  return $.detail.notFound.title;
                })}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t(
                  ($) => {
                    return $.detail.notFound.description;
                  },
                  { agentId },
                )}
              </p>
            </div>
            <Link
              pathname="/agents"
              className={cn(
                buttonVariants({ variant: "neutral" }),
                "h-auto rounded-md px-3 py-1.5 no-underline text-inherit hover:bg-control-surface active:bg-control-surface",
              )}
            >
              {t(($) => {
                return $.detail.notFound.back;
              })}
            </Link>
          </div>
        </main>
      </DetailPageShell>
    );
  }

  return (
    <DetailPageShell scroll={false}>
      <Breadcrumb />
      <main className="flex-1 px-4 sm:px-6 pt-4 pb-safe-or-8">
        <div className="mx-auto max-w-[900px]">
          <Card className={surfaceVariants()}>
            <CardContent className="px-6 py-6 text-center space-y-3">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        </div>
      </main>
    </DetailPageShell>
  );
}

function AgentTabNav({
  activeTab,
  onTabChange,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
}) {
  const { t } = useTranslation("agents");
  const tabItems = [
    {
      value: "profile",
      label: t(($) => {
        return $.detail.tabs.profile;
      }),
    },
    {
      value: "instructions",
      label: t(($) => {
        return $.detail.tabs.instructions;
      }),
    },
  ];
  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="flex-1 min-w-0"
    >
      <div className="sm:hidden">
        <Select
          items={tabItems}
          value={activeTab}
          onValueChange={(value, details) => {
            if (
              value === null ||
              !tabItems.some((item) => {
                return item.value === value;
              })
            ) {
              details.cancel();
              return;
            }
            if (value !== activeTab) {
              onTabChange(value);
            }
          }}
        >
          <SelectTrigger
            className="h-9 w-full"
            aria-label={t(($) => {
              return $.detail.sectionNavigation;
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tabItems.map((item) => {
              return (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      <TabsList className="hidden sm:inline-flex">
        <TabsTrigger value="profile">
          <UserCircle size={14} />
          {t(($) => {
            return $.detail.tabs.profile;
          })}
        </TabsTrigger>
        <TabsTrigger value="instructions">
          <FileText size={14} />
          {t(($) => {
            return $.detail.tabs.instructions;
          })}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function resolveSound(sound: string): Tone {
  return (TONE_OPTIONS as readonly string[]).includes(sound)
    ? (sound as Tone)
    : "professional";
}

function JobInstructionsTab() {
  const { t } = useTranslation("agents");
  const pageSignal = useGet(pageSignal$);
  const instructionsLoadable = useLastLoadable(agentInstructions$);
  const draft = useGet(agentInstructionsDraft$);
  const conflict = useLastLoadable(agentInstructionsConflict$);
  const isConflict = conflict.state === "hasData" && conflict.data;
  const editorRevision = useGet(agentInstructionsEditorRevision$);
  const [buildLoadable, build] = useLoadableSet(buildAgentInstructions$);
  const [reloadLoadable, reload] = useLoadableSet(
    reloadLatestAgentInstructions$,
  );

  const instructions =
    instructionsLoadable.state === "hasData" ? instructionsLoadable.data : null;
  const loading = instructionsLoadable.state === "loading";
  const fetchError = loadableErrorMessage(
    instructionsLoadable,
    t(($) => {
      return $.errors.unknown;
    }),
  );
  const isBuilding =
    buildLoadable.state === "loading" || reloadLoadable.state === "loading";
  const unknownError = t(($) => {
    return $.errors.unknown;
  });
  const buildError =
    loadableErrorMessage(buildLoadable, unknownError) ??
    loadableErrorMessage(reloadLoadable, unknownError);

  const setEdited = useSet(setAgentEditedContent$);
  const discard = useSet(discardAgentEdit$);

  return (
    <InstructionsTab
      instructions={instructions}
      loading={loading}
      fetchError={fetchError}
      editedContent={draft?.content ?? null}
      editorBaseline={draft?.savedContent ?? null}
      editorRevision={editorRevision}
      isDirty={draft !== null}
      isBuilding={isBuilding}
      isConflict={isConflict}
      buildError={buildError}
      onEdit={(value) => {
        setEdited(value, instructions?.content ?? "");
      }}
      onDiscard={() => {
        if (isConflict) {
          detach(reload(pageSignal), Reason.DomCallback);
        } else {
          discard();
        }
      }}
      onReload={() => {
        detach(reload(pageSignal), Reason.DomCallback);
      }}
      onBuild={() => {
        detach(
          (async () => {
            if (await build(pageSignal)) {
              toast.success(
                t(($) => {
                  return $.instructions.saved;
                }),
              );
            }
          })(),
          Reason.DomCallback,
        );
      }}
    />
  );
}

function AgentHeader({
  displayName,
  description,
  agentId,
  avatarUrl,
  activeTab,
  onTabChange,
  isDefaultAgent,
}: {
  displayName: string;
  description: string;
  agentId: string;
  avatarUrl: string | null;
  activeTab: string | null;
  onTabChange: (tab: string) => void;
  isDefaultAgent: boolean | undefined;
}) {
  const { t } = useTranslation("agents");
  const openMaker = useSet(openAvatarMaker$);
  const pageSignal = useGet(pageSignal$);

  return (
    <DetailPageHeader>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-4">
          <div className="group relative shrink-0">
            <AgentAvatarImg
              name={agentId}
              alt={displayName}
              className="h-14 w-14 shrink-0 rounded-full object-cover object-top sm:h-16 sm:w-16"
            />
            {activeTab !== null && isDefaultAgent === false && (
              <TooltipProvider delay={200}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => {
                          onTabChange("profile");
                          openMaker(avatarUrl, pageSignal);
                        }}
                        className="absolute -right-0.5 -bottom-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background transition-colors"
                        aria-label={t(($) => {
                          return $.avatar.actions.customize;
                        })}
                      >
                        <Wand size={12} />
                      </button>
                    }
                  />
                  <TooltipContent side="bottom">
                    <p className="text-xs">
                      {t(($) => {
                        return $.avatar.actions.customize;
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl truncate">
              {displayName}
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5 leading-tight line-clamp-2">
              {description ||
                t(($) => {
                  return $.detail.defaultDescription;
                })}
            </p>
          </div>
        </div>
        <Link
          pathname="/agents/:agentId/chat"
          options={{ pathParams: { agentId } }}
          className={cn(
            buttonVariants({ variant: "neutral", size: "sm" }),
            "max-w-[220px] shrink-0 gap-1.5",
          )}
          aria-label={t(
            ($) => {
              return $.detail.chatWith;
            },
            { agentName: displayName },
          )}
        >
          <MessageCircle size={14} className="shrink-0" />
          <span className="truncate">
            {t(
              ($) => {
                return $.detail.chatWith;
              },
              { agentName: displayName },
            )}
          </span>
        </Link>
      </div>

      {activeTab !== null && (
        <div className="mt-4 sm:mt-6 flex items-center gap-2">
          <AgentTabNav activeTab={activeTab} onTabChange={onTabChange} />
        </div>
      )}
    </DetailPageHeader>
  );
}

// Wraps the shared settings tab with agent-scoped data so the delete dialog can
// offer to keep bound workflows under the workspace default before deletion.
function AgentProfileSettings({
  agentId,
  isDefaultAgent,
  displayName,
  description,
  avatarUrl,
  resolvedSound,
  visibility,
  canEditVisibility,
}: {
  agentId: string;
  isDefaultAgent: boolean;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  resolvedSound: Tone;
  visibility: "public" | "private";
  canEditVisibility: boolean;
}) {
  const workflowsLoadable = useLastLoadable(currentAgentVisibleWorkflows$);
  const workflowsStatus = useLoadable(currentAgentVisibleWorkflows$);
  const agentsLoadable = useLastLoadable(agents$);

  const deleteWorkflows =
    workflowsLoadable.state === "hasData"
      ? workflowsLoadable.data.map((workflow) => {
          return {
            id: workflow.id,
            title: workflow.displayName ?? workflow.name,
          };
        })
      : undefined;
  const deleteCopyTargets =
    agentsLoadable.state === "hasData"
      ? agentsLoadable.data
          .filter((agent) => {
            return agent.agentId !== agentId && agent.isDefaultAgent;
          })
          .map((agent) => {
            return { id: agent.agentId, displayName: agent.displayName };
          })
      : [];

  return (
    <SettingsTab
      key={agentId}
      agentId={agentId}
      isDefaultAgent={isDefaultAgent}
      displayName={displayName}
      description={description}
      sound={resolvedSound}
      avatarUrl={avatarUrl}
      visibility={visibility}
      canEditVisibility={canEditVisibility && !isDefaultAgent}
      updateSettings$={updateAgentSettings$}
      inputId="job-agent-name"
      canDelete={!isDefaultAgent}
      deleteWorkflows={deleteWorkflows}
      deleteWorkflowsState={
        workflowsStatus.state === "hasData"
          ? "ready"
          : workflowsStatus.state === "hasError"
            ? "error"
            : "loading"
      }
      deleteCopyTargets={deleteCopyTargets}
    />
  );
}

function AgentTabContent({
  activeTab,
  agentId,
  isDefaultAgent,
  displayName,
  description,
  avatarUrl,
  resolvedSound,
  visibility,
  canEditVisibility,
}: {
  activeTab: string | null;
  agentId: string;
  isDefaultAgent: boolean;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  resolvedSound: Tone;
  visibility: "public" | "private";
  canEditVisibility: boolean;
}) {
  switch (activeTab) {
    case "profile": {
      return (
        <AgentProfileSettings
          agentId={agentId}
          isDefaultAgent={isDefaultAgent}
          displayName={displayName}
          description={description}
          avatarUrl={avatarUrl}
          resolvedSound={resolvedSound}
          visibility={visibility}
          canEditVisibility={canEditVisibility}
        />
      );
    }
    case "instructions": {
      return <JobInstructionsTab />;
    }
    default: {
      return null;
    }
  }
}

function useAgentFields() {
  const { t } = useTranslation("agents");
  const agent = useLastResolved(currentAgent$);
  const detail = useLastResolved(agentDetail$);
  // Both signals fetch from agentsByIdContract; pick whichever resolved first
  const source = agent ?? detail;
  if (!source) {
    return {
      detail: detail ?? null,
      agentId: "",
      isDefaultAgent: undefined,
      displayName: t(($) => {
        return $.fallbackName;
      }),
      description: "",
      avatarUrl: null,
      resolvedSound: resolveSound("professional"),
      ownerId: "",
      visibility: "public" as const,
    };
  }
  return {
    detail: detail ?? null,
    agentId: source.agentId,
    isDefaultAgent: source.isDefaultAgent,
    displayName:
      source.displayName ??
      (source.agentId ||
        t(($) => {
          return $.fallbackName;
        })),
    description: source.description ?? "",
    avatarUrl: source.avatarUrl,
    resolvedSound: resolveSound(source.sound ?? "professional"),
    ownerId: source.ownerId,
    visibility: source.visibility ?? "public",
  };
}

function useTabVisibility(ownerId: string, visibility: "public" | "private") {
  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;

  const userLoadable = useLoadable(user$);
  const currentUserId =
    userLoadable.state === "hasData" ? userLoadable.data?.id : undefined;
  const isOwner = currentUserId === ownerId;
  const canEditProfile = isOwner || (isAdmin && visibility === "public");

  const rawTab = useGet(agentActiveTab$);
  const setActiveTab = useSet(setAgentActiveTab$);
  const activeTab = canEditProfile
    ? rawTab === "authorization"
      ? "profile"
      : rawTab
    : null;

  return {
    isOwner,
    activeTab,
    setActiveTab,
  };
}

export function JobDetailPage() {
  const { t } = useTranslation("agents");
  const detailLoadable = useLoadable(agentDetail$);
  const error = loadableErrorMessage(
    detailLoadable,
    t(($) => {
      return $.errors.unknown;
    }),
  );
  const currentAgentId = useGet(currentAgentId$);
  const fields = useAgentFields();
  const errorAgentId = fields.agentId || currentAgentId || "";
  const { isOwner, activeTab, setActiveTab } = useTabVisibility(
    fields.ownerId,
    fields.visibility,
  );
  const isDefaultAgent = fields.isDefaultAgent;

  if (!fields.detail && !error) {
    return <DetailSkeleton />;
  }

  if (error) {
    return <DetailError error={error} agentId={errorAgentId} />;
  }

  return (
    <DetailPageShell>
      <Breadcrumb currentName={fields.displayName} />
      <AgentHeader
        displayName={fields.displayName}
        description={fields.description}
        agentId={fields.agentId}
        avatarUrl={fields.avatarUrl}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isDefaultAgent={isDefaultAgent}
      />
      <DetailPageMain>
        <AgentTabContent
          activeTab={activeTab}
          agentId={fields.agentId}
          isDefaultAgent={isDefaultAgent !== false}
          displayName={fields.displayName}
          description={fields.description}
          avatarUrl={fields.avatarUrl}
          resolvedSound={fields.resolvedSound}
          visibility={fields.visibility}
          canEditVisibility={isOwner}
        />
      </DetailPageMain>
    </DetailPageShell>
  );
}
