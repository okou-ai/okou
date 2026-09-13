// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  type Loadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { AgentSshAccess } from "../okou-page/agent-ssh-access.tsx";
import { SshLoadError } from "../okou-page/ssh-load-error.tsx";
import type { ReactNode } from "react";
import { currentAgentSshAccess$, sshIdentity$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  FileText,
  UserCircle,
  Shield,
  Users,
  Search,
  X,
  MessageCircle,
  Wand,
} from "lucide-react";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  surfaceVariants,
  Button,
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
} from "@okouai/ui";
import { InstructionsTab } from "../okou-page/instructions-tab.tsx";
import { SettingsTab } from "../okou-page/settings-tab.tsx";
import { TONE_OPTIONS, type Tone } from "../okou-page/tone-constants.ts";
import { agentDetail$ } from "../../signals/okou-page/job-detail/detail";
import {
  agentInstructions$,
  agentEditedContent$,
  agentInstructionsDirty$,
  agentInstructionsEditorRevision$,
  setAgentEditedContent$,
  discardAgentEdit$,
  buildAgentInstructions$,
} from "../../signals/okou-page/job-detail/instructions";
import { updateAgentSettings$ } from "../../signals/okou-page/job-detail/settings";
import { deleteAgent$ } from "../../signals/okou-page/job-detail/delete";
import {
  agentAuthorizedConnectors$,
  authorizeAgentConnector$,
  deauthorizeAgentConnector$,
  saveAgentConnectors$,
} from "../../signals/okou-page/job-detail/connectors";
import {
  agentActiveTab$,
  setAgentActiveTab$,
} from "../../signals/okou-page/job-detail/agent-name";
import { Link } from "../router/link.tsx";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
} from "../../signals/utils.ts";
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
import { ConnectorCard } from "../okou-page/components/settings/connector-card.tsx";
import { PermissionsDrawer } from "../okou-page/components/settings/permissions-dialog.tsx";
import type { PermissionDraftIntent } from "../../signals/okou-page/settings/permission-draft-intent.ts";
import { savePermissionDraftPolicies } from "../../signals/okou-page/settings/permission-grant-save.ts";
import { noConnectorImg } from "../okou-page/platform-assets.ts";
import { JobCustomConnectorsSection } from "./job-custom-connectors-section.tsx";
import {
  applyUserPermissionGrants$,
  currentAgentUserPermissionGrants$,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import { matchesConnectorSearch } from "../../signals/okou-page/settings/connectors.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import {
  copyWorkflow$,
  currentAgentVisibleWorkflows$,
} from "../../signals/workflows-page/workflows-signals.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  permConnectorSlug$,
  agentPermissionMetadata$,
  setPermConnectorSlug$,
  permSearch$,
  setPermSearch$,
  focusPermSearchRef$,
  permSearchActive$,
  setPermSearchActive$,
  permSavingConnectorSlug$,
  setPermSavingConnectorSlug$,
} from "../../signals/okou-page/job-detail-page.ts";
import type { FirewallPolicies } from "@okouai/connectors/firewall-contracts";
import type {
  PlatformConnectorCatalogStatusItem,
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../signals/connector-domain.ts";
import { activeUserPermissionGrantSnapshot } from "../../signals/user-permission-grants.ts";
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
        <main className="flex-1 flex items-center justify-center px-4 sm:px-6 pb-[max(4rem,var(--sab))]">
          <div className="flex flex-col items-center text-center gap-4 max-w-sm">
            <NoPermissionIllustration className="h-32 w-auto max-w-[220px] object-contain opacity-90" />
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
            <Button
              asChild
              variant="neutral"
              className="h-auto rounded-md px-3 py-1.5 no-underline text-inherit hover:bg-control-surface active:bg-control-surface"
            >
              <Link pathname="/agents">
                {t(($) => {
                  return $.detail.notFound.back;
                })}
              </Link>
            </Button>
          </div>
        </main>
      </DetailPageShell>
    );
  }

  return (
    <DetailPageShell scroll={false}>
      <Breadcrumb />
      <main className="flex-1 px-4 sm:px-6 pt-4 pb-[max(2rem,var(--sab))]">
        <div className="mx-auto max-w-[900px]">
          <Card className={surfaceVariants()}>
            <CardContent className="px-6 py-6 text-center space-y-3">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                asChild
                variant="neutral"
                className="h-auto rounded-md px-3 py-1.5 no-underline text-inherit hover:bg-control-surface active:bg-control-surface"
              >
                <Link
                  pathname="/agents/:agentId"
                  options={{ pathParams: { agentId: agentId } }}
                >
                  {t(($) => {
                    return $.actions.retry;
                  })}
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </DetailPageShell>
  );
}

function resolveVisibleTab(
  rawTab: string,
  hideProfileAndInstructions: boolean,
): string {
  if (hideProfileAndInstructions && rawTab !== "authorization") {
    return "authorization";
  }
  return rawTab;
}

function AgentTabNav({
  activeTab,
  onTabChange,
  showProfileAndInstructions,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  showProfileAndInstructions: boolean;
}) {
  const { t } = useTranslation("agents");
  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="flex-1 min-w-0"
    >
      {/* Mobile: Select dropdown */}
      <div className="sm:hidden">
        <Select value={activeTab} onValueChange={onTabChange}>
          <SelectTrigger className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="authorization">
              {t(($) => {
                return $.detail.tabs.authorization;
              })}
            </SelectItem>
            {showProfileAndInstructions && (
              <SelectItem value="profile">
                {t(($) => {
                  return $.detail.tabs.profile;
                })}
              </SelectItem>
            )}
            {showProfileAndInstructions && (
              <SelectItem value="instructions">
                {t(($) => {
                  return $.detail.tabs.instructions;
                })}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
      {/* Desktop: tab list */}
      <TabsList className="hidden sm:inline-flex">
        <TabsTrigger value="authorization">
          <Shield size={14} />
          {t(($) => {
            return $.detail.tabs.authorization;
          })}
        </TabsTrigger>
        {showProfileAndInstructions && (
          <TabsTrigger value="profile">
            <UserCircle size={14} />
            {t(($) => {
              return $.detail.tabs.profile;
            })}
          </TabsTrigger>
        )}
        {showProfileAndInstructions && (
          <TabsTrigger value="instructions">
            <FileText size={14} />
            {t(($) => {
              return $.detail.tabs.instructions;
            })}
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  );
}

function resolveSound(sound: string): Tone {
  return (TONE_OPTIONS as readonly string[]).includes(sound)
    ? (sound as Tone)
    : "professional";
}

function PermissionListSkeleton() {
  return (
    <div className="mx-auto max-w-[900px]">
      <div className={surfaceVariants({ className: "animate-pulse" })}>
        {Array.from({ length: 4 }, (_, i) => {
          return (
            <div
              key={i}
              className={cn(
                "flex items-center gap-3 px-5 py-4",
                i < 3 && "border-b border-border/50",
              )}
            >
              <span className="h-5 w-5 shrink-0 rounded bg-muted/50" />
              <div className="flex-1 space-y-1.5">
                <span className="block h-4 w-24 rounded bg-muted/50" />
                <span className="block h-3 w-48 rounded bg-muted/30" />
              </div>
              <span className="h-4 w-7 rounded-full bg-muted/50" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PermissionGrantsError() {
  const { t } = useTranslation("agents");
  return (
    <div className="mx-auto max-w-[900px]">
      <div
        className={surfaceVariants({
          className: "px-5 py-4 text-sm text-destructive",
        })}
      >
        {t(($) => {
          return $.authorization.permissionLoadError;
        })}
      </div>
    </div>
  );
}

function NoConnectedConnectors() {
  const { t } = useTranslation("agents");
  return (
    <>
      <div
        className={surfaceVariants({
          className: "py-8 flex flex-col items-center gap-3",
        })}
      >
        <img
          src={noConnectorImg}
          alt={t(($) => {
            return $.authorization.noConnectorsAlt;
          })}
          className="h-20 w-20 object-contain opacity-80"
        />
        <p className="text-sm text-muted-foreground text-center">
          {t(($) => {
            return $.authorization.noConnectorsBeforeLink;
          })}{" "}
          <Link
            pathname="/connectors"
            className="font-medium text-foreground hover:underline"
          >
            {t(($) => {
              return $.authorization.connectorsLink;
            })}
          </Link>{" "}
          {t(($) => {
            return $.authorization.noConnectorsAfterLink;
          })}
        </p>
      </div>
      <JobCustomConnectorsSection />
    </>
  );
}

function ConnectedConnectorPermissions({
  sshAccess,
  status,
  filteredConnectors,
  authorizedSet,
  search,
  setSearch,
  searchActive,
  setSearchActive,
  savingConnectorSlug,
  canManagePermissions,
  onToggle,
  onManage,
}: {
  sshAccess: { readonly agentId: string; readonly enabled: boolean } | null;
  status: ReactNode;
  filteredConnectors: readonly PlatformConnectorCatalogStatusItem[];
  authorizedSet: ReadonlySet<string>;
  search: string;
  setSearch: (value: string) => void;
  searchActive: boolean;
  setSearchActive: (active: boolean) => void;
  savingConnectorSlug: ConnectorSlug | null;
  canManagePermissions: boolean;
  onToggle: (connectorSlug: ConnectorSlug, checked: boolean) => Promise<void>;
  onManage: (connectorSlug: ConnectorSlug) => void;
}) {
  const { t } = useTranslation("agents");
  const { t: commonT } = useTranslation();
  const focusSearch = useSet(focusPermSearchRef$);
  const showSsh =
    sshAccess !== null &&
    `ssh ${commonT(($) => {
      return $.ssh.accessHelp;
    })}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  return (
    <>
      <div className={surfaceVariants()}>
        <div className="relative border-b border-border/50">
          <div
            className={cn(
              "px-5 pt-4 pb-3 pr-12 text-sm text-muted-foreground transition-opacity duration-150",
              searchActive && "opacity-0 select-none",
            )}
            aria-hidden={searchActive}
          >
            {t(($) => {
              return $.authorization.description;
            })}
          </div>
          {searchActive && (
            <div className="absolute inset-0 flex items-center gap-2 px-5">
              <Search size={14} className="shrink-0 text-muted-foreground" />
              <input
                ref={focusSearch}
                type="text"
                placeholder={t(($) => {
                  return $.authorization.searchPlaceholder;
                })}
                value={search}
                onChange={(e) => {
                  return setSearch(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("");
                    setSearchActive(false);
                  }
                }}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
              <Button
                showTooltip
                type="button"
                onClick={() => {
                  setSearch("");
                  setSearchActive(false);
                }}
                variant="quiet"
                size="icon-xs"
                className="shrink-0"
                aria-label={t(($) => {
                  return $.authorization.closeSearch;
                })}
              >
                <X size={14} />
              </Button>
            </div>
          )}
          {!searchActive && (
            <Button
              showTooltip
              type="button"
              onClick={() => {
                return setSearchActive(true);
              }}
              variant="quiet"
              size="icon-xs"
              className="absolute right-3 top-1/2 -translate-y-1/2"
              aria-label={t(($) => {
                return $.authorization.findConnectors;
              })}
            >
              <Search size={14} />
            </Button>
          )}
        </div>
        {status ??
          (filteredConnectors.length > 0 ? (
            filteredConnectors.map((c, i) => {
              return (
                <ConnectorCard
                  key={c.slug}
                  variant="permission"
                  connector={c}
                  enabled={authorizedSet.has(c.slug)}
                  onToggle={onDomEventFn(async (checked) => {
                    await onToggle(c.slug, checked);
                  })}
                  loading={savingConnectorSlug === c.slug}
                  showManage={
                    canManagePermissions && c.permissionSummary.hasPermissions
                  }
                  onManage={() => {
                    return onManage(c.slug);
                  }}
                  isLast={i === filteredConnectors.length - 1 && !showSsh}
                />
              );
            })
          ) : !showSsh ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">
              {t(
                ($) => {
                  return $.authorization.noResults;
                },
                { search },
              )}
            </p>
          ) : null)}
        {showSsh && sshAccess ? (
          <AgentSshAccess
            agentId={sshAccess.agentId}
            enabled={sshAccess.enabled}
          />
        ) : null}
      </div>

      <JobCustomConnectorsSection />
    </>
  );
}

function AgentPermissionsDrawer({
  targetId,
  connectorSlug,
  connectorLabel,
  displayName,
  initialPolicies,
  initialGrants,
  readOnly,
  onApply,
  onClose,
}: {
  targetId: string;
  connectorSlug: ConnectorSlug | null;
  connectorLabel: string;
  displayName: string;
  initialPolicies: FirewallPolicies;
  initialGrants: readonly PlatformUserPermissionGrant[];
  readOnly: boolean;
  onApply: (
    intent: PermissionDraftIntent,
    options: {
      readonly metadata: PlatformConnectorPermissionMetadata;
    },
  ) => Promise<void>;
  onClose: () => void;
}) {
  if (!connectorSlug) {
    return null;
  }
  return (
    <PermissionsDrawer
      agentId={targetId}
      connectorSlug={connectorSlug}
      connectorLabel={connectorLabel}
      metadata$={agentPermissionMetadata$}
      displayName={displayName}
      initialPolicies={initialPolicies}
      initialGrants={initialGrants}
      readOnly={readOnly}
      onApply={onApply}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Tab wrappers — resolve signals into shared component props
// ---------------------------------------------------------------------------

function sshAccessForAgent(
  access: Loadable<{
    readonly identity: string;
    readonly agentId: string;
    readonly enabled: boolean;
  } | null>,
  agentId: string,
  identity: Loadable<string | null>,
) {
  return identity.state === "hasData" &&
    identity.data !== null &&
    access.state === "hasData" &&
    access.data?.identity === identity.data &&
    access.data.agentId === agentId
    ? access.data
    : null;
}

function JobPermissionsTab({
  agentId,
  displayName,
}: {
  agentId: string;
  displayName: string;
}) {
  const { t } = useTranslation("agents");
  const sshAccessLoadable = useLastLoadable(currentAgentSshAccess$);
  const sshIdentity = useLoadable(sshIdentity$);
  const sshAccess = sshAccessForAgent(sshAccessLoadable, agentId, sshIdentity);
  // Use useLastLoadable so the list keeps showing the previous data while the
  // signal refetches after a toggle/save or a permission-policy reload. This
  // prevents the entire list from flickering to the skeleton on each change
  // (issue #9141).
  const connectorsLoadable = useLastLoadable(agentAuthorizedConnectors$);
  const authorizedConnectors =
    connectorsLoadable.state === "hasData" ? connectorsLoadable.data : [];
  const authorizeFn = useSet(authorizeAgentConnector$);
  const deauthorizeFn = useSet(deauthorizeAgentConnector$);
  const saveConnectors = useSet(saveAgentConnectors$);
  const pageSignal = useGet(pageSignal$);
  const userGrantsLoadable = useLoadable(currentAgentUserPermissionGrants$);
  const userGrants =
    userGrantsLoadable.state === "hasData" ? userGrantsLoadable.data : [];
  const activeUserGrantSnapshot = activeUserPermissionGrantSnapshot(userGrants);
  const userGrantPolicies =
    userGrantsLoadable.state === "hasData"
      ? activeUserGrantSnapshot.policies
      : null;
  const drawerInitialPolicies = userGrantPolicies ?? {};
  const [, applyGrantPolicies] = useLoadableSet(applyUserPermissionGrants$);
  const connectorSlug = useGet(permConnectorSlug$);
  const setConnectorSlug = useSet(setPermConnectorSlug$);
  const search = useGet(permSearch$);
  const setSearch = useSet(setPermSearch$);
  const searchActive = useGet(permSearchActive$);
  const setSearchActive = useSet(setPermSearchActive$);
  const savingConnectorSlug = useGet(permSavingConnectorSlug$);
  const setSavingConnectorSlug = useSet(setPermSavingConnectorSlug$);

  const connectorsLoading = connectorsLoadable.state === "loading";

  const catalogItemsLoadable = useLastLoadable(connectorCatalogStatus$);
  const allConnectors =
    catalogItemsLoadable.state === "hasData"
      ? catalogItemsLoadable.data.connectors
      : [];
  const canManagePermissions = true;

  const connectedConnectors = allConnectors.filter((c) => {
    return c.connected;
  });
  const connectorLabel = connectorSlug
    ? (allConnectors.find((connector) => {
        return connector.slug === connectorSlug;
      })?.label ?? connectorSlug)
    : "";
  const filteredConnectors = connectedConnectors.filter((c) => {
    return matchesConnectorSearch(search, c);
  });
  const authorizedSet = new Set(authorizedConnectors);

  const handleToggle = async (
    targetConnectorSlug: ConnectorSlug,
    checked: boolean,
  ) => {
    if (savingConnectorSlug !== null) {
      return;
    }
    const modify = checked
      ? authorizeFn(targetConnectorSlug, pageSignal)
      : deauthorizeFn(targetConnectorSlug, pageSignal);
    setSavingConnectorSlug(targetConnectorSlug);
    await bestEffort(
      (async () => {
        await modify;
        await saveConnectors(
          targetConnectorSlug,
          checked ? "add" : "remove",
          pageSignal,
        );
        toast.success(
          t(($) => {
            return $.authorization.connectorsSaved;
          }),
        );
      })(),
    );
    setSavingConnectorSlug(null);
  };

  const status =
    catalogItemsLoadable.state !== "hasData" ||
    connectorsLoading ||
    userGrantsLoadable.state === "loading" ? (
      <PermissionListSkeleton />
    ) : userGrantsLoadable.state === "hasError" ? (
      <PermissionGrantsError />
    ) : null;
  if (status && !sshAccess && sshAccessLoadable.state !== "hasError") {
    return status;
  }

  return (
    <div className="mx-auto w-full max-w-[900px] flex flex-col gap-4">
      {connectedConnectors.length === 0 && !sshAccess ? (
        sshAccessLoadable.state === "hasError" ? (
          <SshLoadError />
        ) : (
          <NoConnectedConnectors />
        )
      ) : (
        <>
          {sshAccessLoadable.state === "hasError" && <SshLoadError />}
          <ConnectedConnectorPermissions
            sshAccess={sshAccess}
            status={status}
            filteredConnectors={filteredConnectors}
            authorizedSet={authorizedSet}
            search={search}
            setSearch={setSearch}
            searchActive={searchActive}
            setSearchActive={setSearchActive}
            savingConnectorSlug={savingConnectorSlug}
            canManagePermissions={canManagePermissions}
            onToggle={handleToggle}
            onManage={setConnectorSlug}
          />
          <AgentPermissionsDrawer
            targetId={agentId}
            connectorSlug={connectorSlug}
            connectorLabel={connectorLabel}
            displayName={displayName}
            initialPolicies={drawerInitialPolicies}
            initialGrants={activeUserGrantSnapshot.grants}
            readOnly={!canManagePermissions}
            onApply={async (intent, { metadata }) => {
              if (connectorSlug === null) {
                throw new Error("Cannot save permissions without a connector");
              }
              await savePermissionDraftPolicies(
                {
                  scope: { agentId },
                  connectorSlug,
                  metadata,
                  initialPolicies: drawerInitialPolicies,
                  initialGrants: activeUserGrantSnapshot.grants,
                  intent,
                  applyGrantPolicies,
                },
                pageSignal,
              );
              toast.success(
                t(($) => {
                  return $.authorization.permissionsUpdated;
                }),
              );
            }}
            onClose={() => {
              return setConnectorSlug(null);
            }}
          />
        </>
      )}
    </div>
  );
}

function JobInstructionsTab() {
  const { t } = useTranslation("agents");
  const pageSignal = useGet(pageSignal$);
  const instructionsLoadable = useLoadable(agentInstructions$);
  const editedLoadable = useLoadable(agentEditedContent$);
  const dirtyLoadable = useLoadable(agentInstructionsDirty$);
  const editorRevision = useGet(agentInstructionsEditorRevision$);
  const [buildLoadable, build] = useLoadableSet(buildAgentInstructions$);

  const instructions =
    instructionsLoadable.state === "hasData" ? instructionsLoadable.data : null;
  const loading = instructionsLoadable.state === "loading";
  const fetchError = loadableErrorMessage(
    instructionsLoadable,
    t(($) => {
      return $.errors.unknown;
    }),
  );
  const edited =
    editedLoadable.state === "hasData" ? editedLoadable.data : null;
  const isDirty =
    dirtyLoadable.state === "hasData" && dirtyLoadable.data === true;
  const isBuilding = buildLoadable.state === "loading";
  const buildError =
    buildLoadable.state === "hasError" ? String(buildLoadable.error) : null;

  const setEdited = useSet(setAgentEditedContent$);
  const discard = useSet(discardAgentEdit$);

  return (
    <InstructionsTab
      instructions={instructions}
      loading={loading}
      fetchError={fetchError}
      editedContent={edited}
      editorRevision={editorRevision}
      isDirty={isDirty}
      isBuilding={isBuilding}
      buildError={buildError}
      onEdit={setEdited}
      onDiscard={discard}
      onBuild={() => {
        detach(
          (async () => {
            await build(pageSignal);
            toast.success(
              t(($) => {
                return $.instructions.saved;
              }),
            );
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
  showProfileAndInstructions,
  isDefaultAgent,
}: {
  displayName: string;
  description: string;
  agentId: string;
  avatarUrl: string | null;
  activeTab: string;
  onTabChange: (tab: string) => void;
  showProfileAndInstructions: boolean;
  isDefaultAgent: boolean | undefined;
}) {
  const { t } = useTranslation("agents");
  const nav = useSet(detachedNavigateTo$);
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
            {showProfileAndInstructions && isDefaultAgent === false && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        onTabChange("profile");
                        openMaker(avatarUrl, pageSignal);
                      }}
                      className="absolute -right-0.5 -bottom-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm border border-border opacity-0 group-hover:opacity-100 hover:text-foreground transition-all"
                      aria-label={t(($) => {
                        return $.avatar.actions.customize;
                      })}
                    >
                      <Wand size={12} />
                    </button>
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
        <Button
          variant="neutral"
          size="sm"
          className="max-w-[220px] shrink-0 gap-1.5"
          onClick={() => {
            nav("/agents/:agentId/chat", {
              pathParams: { agentId: agentId },
            });
          }}
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
        </Button>
      </div>

      <div className="mt-4 sm:mt-6 flex items-center gap-2">
        <AgentTabNav
          activeTab={activeTab}
          onTabChange={onTabChange}
          showProfileAndInstructions={showProfileAndInstructions}
        />
      </div>
    </DetailPageHeader>
  );
}

// Wraps the shared settings tab with agent-scoped data so the delete dialog can
// offer to copy bound workflows onto another agent before the agent is removed.
function AgentProfileSettings({
  agentId,
  displayName,
  description,
  avatarUrl,
  resolvedSound,
  isDefaultAgent,
  visibility,
  canEditVisibility,
  onDelete,
}: {
  agentId: string;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  resolvedSound: Tone;
  isDefaultAgent: boolean | undefined;
  visibility: "public" | "private";
  canEditVisibility: boolean;
  onDelete: () => Promise<void>;
}) {
  const pageSignal = useGet(pageSignal$);
  const workflowsLoadable = useLastLoadable(currentAgentVisibleWorkflows$);
  const workflowsStatus = useLoadable(currentAgentVisibleWorkflows$);
  const agentsLoadable = useLastLoadable(agents$);
  const user = useLastResolved(user$);
  const [, copyWorkflow] = useLoadableSet(copyWorkflow$);

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
            return agent.agentId !== agentId && agent.ownerId === user?.id;
          })
          .map((agent) => {
            return { id: agent.agentId, displayName: agent.displayName };
          })
      : [];

  const copyWorkflowBeforeDelete = async (
    workflowId: string,
    toAgentId: string,
  ) => {
    await copyWorkflow({ workflowId, toAgentId }, pageSignal);
  };

  return (
    <SettingsTab
      key={agentId}
      agentId={agentId}
      displayName={displayName}
      description={description}
      sound={resolvedSound}
      avatarUrl={avatarUrl}
      visibility={visibility}
      canEditVisibility={canEditVisibility}
      updateSettings$={updateAgentSettings$}
      inputId="job-agent-name"
      isDefaultAgent={isDefaultAgent}
      onDelete={onDelete}
      deleteWorkflows={deleteWorkflows}
      deleteWorkflowsState={
        workflowsStatus.state === "hasData"
          ? "ready"
          : workflowsStatus.state === "hasError"
            ? "error"
            : "loading"
      }
      deleteCopyTargets={deleteCopyTargets}
      onCopyWorkflowBeforeDelete={copyWorkflowBeforeDelete}
    />
  );
}

function AgentTabContent({
  activeTab,
  agentId,
  displayName,
  description,
  avatarUrl,
  resolvedSound,
  isDefaultAgent,
  visibility,
  canEditVisibility,
}: {
  activeTab: string;
  agentId: string;
  displayName: string;
  description: string;
  avatarUrl: string | null;
  resolvedSound: Tone;
  isDefaultAgent: boolean | undefined;
  visibility: "public" | "private";
  canEditVisibility: boolean;
}) {
  const deleteAgent = useSet(deleteAgent$);
  const nav = useSet(detachedNavigateTo$);
  const pageSignal = useGet(pageSignal$);

  const handleDelete = async () => {
    await deleteAgent(pageSignal);
    nav("/agents");
  };

  switch (activeTab) {
    case "authorization": {
      return <JobPermissionsTab agentId={agentId} displayName={displayName} />;
    }
    case "profile": {
      return (
        <AgentProfileSettings
          agentId={agentId}
          displayName={displayName}
          description={description}
          avatarUrl={avatarUrl}
          resolvedSound={resolvedSound}
          isDefaultAgent={isDefaultAgent}
          visibility={visibility}
          canEditVisibility={canEditVisibility}
          onDelete={handleDelete}
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
  const hideProfileAndInstructions = !canEditProfile;
  const activeTab = resolveVisibleTab(rawTab, hideProfileAndInstructions);

  return {
    hideProfileAndInstructions,
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
  const { hideProfileAndInstructions, isOwner, activeTab, setActiveTab } =
    useTabVisibility(fields.ownerId, fields.visibility);
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
        showProfileAndInstructions={!hideProfileAndInstructions}
        isDefaultAgent={isDefaultAgent}
      />
      <DetailPageMain>
        <AgentTabContent
          activeTab={activeTab}
          agentId={fields.agentId}
          displayName={fields.displayName}
          description={fields.description}
          avatarUrl={fields.avatarUrl}
          resolvedSound={fields.resolvedSound}
          isDefaultAgent={isDefaultAgent}
          visibility={fields.visibility}
          canEditVisibility={isOwner}
        />
      </DetailPageMain>
    </DetailPageShell>
  );
}
