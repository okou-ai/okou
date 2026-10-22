import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@okouai/ui";
import { ChevronDown, Plus, Mail } from "lucide-react";
import { clerk$, currentOrgInfo$ } from "../../signals/auth.ts";
import { createdOrganizationsCount$ } from "../../signals/org.ts";
import { detach, onDomEventFn, Reason } from "../../signals/utils.ts";
import { userInvitations$ } from "../../signals/user-invitations.ts";
import {
  createWorkspace$,
  workspaceCreation$,
  workspaceInvitations$,
  workspaceAcceptance$,
  type WorkspaceInvitationActions,
} from "../../signals/select-org/workspace-actions.ts";
import { ThumbnailPlaceholder, WorkspaceLogo } from "../components/avatar.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";

function InvitationRow({ actions }: { actions: WorkspaceInvitationActions }) {
  const { invitation } = actions;
  const acceptance = useLoadable(actions.request$);
  const sharedAcceptance = useLoadable(workspaceAcceptance$);
  const joinWorkspace = useSet(actions.join$);
  const signal = useGet(pageSignal$);
  const isAccepting = acceptance.state === "loading";
  const { t } = useTranslation();

  const handleAccept = onDomEventFn(async () => {
    await joinWorkspace(signal);
  });

  return (
    <div className="flex min-w-0 items-center gap-3 overflow-hidden px-3 py-2.5">
      <WorkspaceLogo
        name={invitation.publicOrganizationData.name}
        imageUrl={invitation.publicOrganizationData.imageUrl}
      />
      <span className="min-w-0 flex-1 text-sm truncate">
        {invitation.publicOrganizationData.name}
      </span>
      <Button
        type="button"
        disabled={sharedAcceptance.state === "loading"}
        onClick={handleAccept}
        variant="quiet"
        size="xs"
        className="shrink-0 gap-1 px-2 text-xs border border-border disabled:opacity-50"
      >
        <Mail size={13} />
        {isAccepting
          ? t(($) => {
              return $.appShell.sidebar.workspaceSwitcher.joining;
            })
          : t(($) => {
              return $.appShell.sidebar.workspaceSwitcher.join;
            })}
      </Button>
    </div>
  );
}

function CreateWorkspaceMenuItem() {
  const creation = useLoadable(workspaceCreation$);
  const creatingOrg = creation.state === "loading";
  const createWorkspace = useSet(createWorkspace$);
  const signal = useGet(pageSignal$);
  const { t } = useTranslation();

  const handleCreateOrg = onDomEventFn(async () => {
    await createWorkspace(signal);
  });

  return (
    <div className="shrink-0">
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={handleCreateOrg}
        disabled={creatingOrg}
        className="min-w-0 gap-3 px-3"
      >
        <Plus size={18} className="shrink-0" />
        <span>
          {creatingOrg
            ? t(($) => {
                return $.appShell.sidebar.workspaceSwitcher.creating;
              })
            : t(($) => {
                return $.appShell.sidebar.workspaceSwitcher.create;
              })}
        </span>
      </DropdownMenuItem>
    </div>
  );
}

function LimitedCreateWorkspaceItem({ limit }: { limit: number }) {
  const createdCountLoadable = useLastLoadable(createdOrganizationsCount$);
  if (
    createdCountLoadable.state !== "hasData" ||
    createdCountLoadable.data >= limit
  ) {
    return null;
  }

  return <CreateWorkspaceMenuItem />;
}

function CreateWorkspaceItem() {
  const clerkLoadable = useLastLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const user = clerk?.user;
  if (!clerk || user?.createOrganizationEnabled !== true) {
    return null;
  }

  const limit = user.createOrganizationsLimit;
  if (limit === null) {
    return <CreateWorkspaceMenuItem />;
  }

  return <LimitedCreateWorkspaceItem limit={limit} />;
}

function OtherMembershipsList() {
  const clerkLoadable = useLastLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const memberships = clerk?.user?.organizationMemberships ?? [];
  const currentOrgId = clerk?.organization?.id;

  const otherMemberships = memberships.filter((m) => {
    return m.organization && m.organization.id !== currentOrgId;
  });

  if (otherMemberships.length === 0) {
    return null;
  }

  const handleSwitchOrg = (orgId: string) => {
    detach(clerk?.setActive({ organization: orgId }), Reason.DomCallback);
  };

  return (
    <>
      <DropdownMenuSeparator />
      {otherMemberships.map((membership) => {
        return (
          <DropdownMenuItem
            key={membership.organization.id}
            onClick={() => {
              handleSwitchOrg(membership.organization.id);
            }}
            className="min-w-0 gap-3 px-3"
          >
            <WorkspaceLogo
              name={membership.organization.name}
              imageUrl={membership.organization.imageUrl}
            />
            <span className="min-w-0 flex-1 truncate">
              {membership.organization.name}
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function OrgDropdownContent() {
  return (
    <DropdownMenuContent
      align="start"
      className="flex max-h-[min(420px,var(--available-height))] w-72 flex-col overflow-hidden"
    >
      <OrgDropdownBody />
    </DropdownMenuContent>
  );
}

function OrgDropdownBody() {
  const clerkLoadable = useLastLoadable(clerk$);
  const pendingInvitations = useLastResolved(workspaceInvitations$);
  const currentOrg = useLastResolved(currentOrgInfo$);
  const { t } = useTranslation();

  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const orgName =
    currentOrg?.name ??
    t(($) => {
      return $.appShell.sidebar.workspaceSwitcher.organizationFallback;
    });
  const memberships = clerk?.user?.organizationMemberships ?? [];
  const currentOrgId = clerk?.organization?.id;

  const hasPendingInvitations =
    pendingInvitations !== undefined && pendingInvitations.length > 0;
  const hasOtherMemberships = memberships.some((membership) => {
    return (
      membership.organization && membership.organization.id !== currentOrgId
    );
  });
  const hasOrgOptions = hasOtherMemberships || hasPendingInvitations;

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center gap-3 px-2 py-1.5">
        <WorkspaceLogo
          name={orgName}
          imageUrl={currentOrg?.imageUrl}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight truncate text-foreground">
            {orgName}
          </p>
        </div>
      </div>

      {hasOrgOptions && (
        <div
          data-testid="org-switcher-options-scroll"
          className="min-h-0 max-h-72 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
        >
          <OtherMembershipsList />

          {/* Pending invitations */}
          {hasPendingInvitations && (
            <>
              <DropdownMenuSeparator />
              {pendingInvitations.map((actions) => {
                return (
                  <InvitationRow
                    key={actions.invitation.id}
                    actions={actions}
                  />
                );
              })}
            </>
          )}
        </div>
      )}

      <CreateWorkspaceItem />
    </>
  );
}

function PendingInvitationsBadge() {
  const pendingInvitations = useLastResolved(userInvitations$);
  const hasPendingInvitations =
    pendingInvitations !== undefined && pendingInvitations.length > 0;
  if (!hasPendingInvitations) {
    return null;
  }
  return (
    <span
      data-testid="pending-invitations-badge"
      className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-sidebar"
    />
  );
}

export function OrgSwitcherCompact() {
  const currentOrg = useLastResolved(currentOrgInfo$);
  const { t } = useTranslation();
  const orgName =
    currentOrg?.name ??
    t(($) => {
      return $.appShell.sidebar.workspaceSwitcher.organizationFallback;
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            showTooltip
            type="button"
            aria-label={t(($) => {
              return $.appShell.sidebar.workspaceSwitcher.switch;
            })}
            variant="quiet"
            size="icon"
            className="relative"
          />
        }
      >
        {currentOrg === undefined ? (
          <ThumbnailPlaceholder size="md+" />
        ) : (
          <WorkspaceLogo
            name={orgName}
            imageUrl={currentOrg?.imageUrl}
            size="md+"
          />
        )}
        <PendingInvitationsBadge />
      </DropdownMenuTrigger>
      <OrgDropdownContent />
    </DropdownMenu>
  );
}

export function OrgSwitcher() {
  const currentOrg = useLastResolved(currentOrgInfo$);
  const { t } = useTranslation();
  const orgName =
    currentOrg?.name ??
    t(($) => {
      return $.appShell.sidebar.workspaceSwitcher.organizationFallback;
    });

  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t(($) => {
                return $.appShell.sidebar.workspaceSwitcher.switch;
              })}
              className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-state-hover text-sidebar-foreground transition-colors"
            />
          }
        >
          {/* Until the workspace loads its mark and name stay empty rather
              than showing the generic "Organization" and its initial. */}
          <span className="relative shrink-0">
            {currentOrg === undefined ? (
              <ThumbnailPlaceholder />
            ) : (
              <WorkspaceLogo name={orgName} imageUrl={currentOrg?.imageUrl} />
            )}
            <PendingInvitationsBadge />
          </span>
          <span className="min-w-0 flex-1 text-left text-sm font-semibold leading-tight truncate">
            {currentOrg === undefined ? null : orgName}
          </span>
          <ChevronDown size={16} className="ml-auto shrink-0" />
        </DropdownMenuTrigger>
        <OrgDropdownContent />
      </DropdownMenu>
    </div>
  );
}
