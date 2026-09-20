import { command, computed, state } from "ccstate";
import { animationFrame } from "signal-timers";
import { onRef } from "../../utils.ts";
import {
  orgContract,
  orgDeleteContract,
  orgLeaveContract,
} from "@okouai/api-contracts/contracts/org-routes";
import { orgLogoContract } from "@okouai/api-contracts/contracts/org-logo";
import {
  orgInviteContract,
  orgMembersContract,
  orgMembershipRequestsContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import type {
  OrgInvitationPurchasePreviewResponse,
  OrgRole,
} from "@okouai/api-contracts/contracts/org-members";
import type { MemberUsageSelection } from "./usage-pack-pricing-state.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { isOrgAdmin$, org$, refreshOrg$ } from "../../org.ts";
import { orgPlanCapabilities$ } from "../org-plan-capabilities.ts";
import { apiClient$ } from "../../api-client.ts";
import { clerk$, resolveAppAuthUrl } from "../../auth.ts";
import { refreshOrgMembers$ } from "../../external/org-members.ts";
import { accept } from "../../../lib/accept.ts";
import { i18n } from "../../../i18n/index.ts";
import {
  reloadBillingStatus$,
  reloadUsagePackManagement$,
  memberUsagePackOptionsAsync$,
  usagePackManagementAsync$,
} from "../billing.ts";

const internalBillingScrollTarget$ = state<"buy-credits" | null>(null);

export const requestBuyCreditsScroll$ = command(({ set }) => {
  set(internalBillingScrollTarget$, "buy-credits");
});

export const clearBillingScrollTarget$ = command(({ set }) => {
  set(internalBillingScrollTarget$, null);
});

const scrollToBuyCreditsIfRequested$ = command(
  ({ get, set }, element: HTMLDivElement) => {
    if (get(internalBillingScrollTarget$) !== "buy-credits") {
      return;
    }
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    set(clearBillingScrollTarget$);
  },
);

export const buyCreditsScrollRef$ = onRef(
  command(({ get, set }, element: HTMLDivElement, signal: AbortSignal) => {
    if (get(internalBillingScrollTarget$) !== "buy-credits") {
      return;
    }
    animationFrame(
      () => {
        set(scrollToBuyCreditsIfRequested$, element);
      },
      { signal },
    );
  }),
);

// ---------------------------------------------------------------------------
// Workspace profile
// ---------------------------------------------------------------------------

const internalProfileName$ = state("");

export const profileName$ = computed((get) => {
  return get(internalProfileName$);
});

export const setProfileName$ = command(({ set }, value: string) => {
  set(internalProfileName$, value);
});

const internalProfileLogoUrl$ = state<string | null>(null);

export const profileLogoUrl$ = computed((get) => {
  return get(internalProfileLogoUrl$);
});

const internalPendingLogoFile$ = state<File | null>(null);

export const pendingLogoFile$ = computed((get) => {
  return get(internalPendingLogoFile$);
});

const internalPendingLogoPreview$ = state<string | null>(null);

export const pendingLogoPreview$ = computed((get) => {
  return get(internalPendingLogoPreview$);
});

export const setPendingLogo$ = command(
  ({ set }, file: File, signal: AbortSignal) => {
    signal.throwIfAborted();
    const preview = URL.createObjectURL(file);
    signal.addEventListener(
      "abort",
      () => {
        URL.revokeObjectURL(preview);
      },
      { once: true },
    );
    set(internalPendingLogoFile$, file);
    set(internalPendingLogoPreview$, preview);
  },
);

export const clearPendingLogo$ = command(({ set }) => {
  set(internalPendingLogoFile$, null);
  set(internalPendingLogoPreview$, null);
});

const internalFileInputEl$ = state<HTMLInputElement | null>(null);

export const fileInputEl$ = computed((get) => {
  return get(internalFileInputEl$);
});

export const setFileInputEl$ = onRef(
  command(({ set }, el: HTMLInputElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalFileInputEl$, null);
    });
    set(internalFileInputEl$, el);
  }),
);

const internalLogoLoaded$ = state(false);

export const logoLoaded$ = computed((get) => {
  return get(internalLogoLoaded$);
});

export const setLogoLoaded$ = command(({ set }, value: boolean) => {
  set(internalLogoLoaded$, value);
});

export const initProfileName$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const org = await get(org$);
    signal.throwIfAborted();
    set(internalProfileName$, org?.name ?? "");
    set(internalProfileLogoUrl$, null);
    set(clearPendingLogo$);
    set(internalLogoLoaded$, false);
  },
);

// ---------------------------------------------------------------------------
// Workspace danger zone
// ---------------------------------------------------------------------------

/**
 * Literal the user must type to confirm workspace deletion. It is deliberately
 * untranslated so the same token works in every locale.
 */
export const WORKSPACE_DELETE_CONFIRMATION = "confirm";

const internalDeleteConfirm$ = state("");

export const deleteConfirm$ = computed((get) => {
  return get(internalDeleteConfirm$);
});

export const setDeleteConfirm$ = command(({ set }, value: string) => {
  set(internalDeleteConfirm$, value);
});

export const resetDeleteConfirm$ = command(({ set }) => {
  set(internalDeleteConfirm$, "");
});

// ---------------------------------------------------------------------------
// Billing sub-page
// ---------------------------------------------------------------------------

type BillingSubPage = "plans" | "migration-pro" | "migration-team" | null;

const internalBillingSubPage$ = state<BillingSubPage>(null);

export const billingSubPage$ = computed((get) => {
  return get(internalBillingSubPage$) !== null;
});

export const billingMigrationSubPage$ = computed((get) => {
  return get(internalBillingSubPage$)?.startsWith("migration-") ?? false;
});

export const billingMigrationTargetTier$ = computed((get) => {
  const subPage = get(internalBillingSubPage$);
  return subPage === "migration-pro"
    ? "pro"
    : subPage === "migration-team"
      ? "team"
      : null;
});

/**
 * True while the plans sub-page is a standalone upgrade flow launched from
 * outside Settings: the sidebar upgrade card, a chat upgrade action, or a
 * `?billingView=plans` deep link. Such a flow owns the whole Settings surface,
 * so dismissing it returns to the screen that launched it instead of leaving
 * the billing tab open underneath.
 */
const internalBillingPlansStandalone$ = state(false);

export const billingPlansStandalone$ = computed((get) => {
  return get(internalBillingPlansStandalone$);
});

export const setBillingPlansStandalone$ = command(({ set }, value: boolean) => {
  set(internalBillingPlansStandalone$, value);
});

export const setBillingSubPage$ = command(({ set }, value: boolean) => {
  set(internalBillingSubPage$, value ? "plans" : null);
  if (!value) {
    // Leaving the plans sub-page ends the standalone upgrade flow it belonged to.
    set(internalBillingPlansStandalone$, false);
  }
});

export const openBillingMigrationSubPage$ = command(
  ({ set }, targetTier: "pro" | "team") => {
    set(internalBillingSubPage$, `migration-${targetTier}`);
  },
);

// ---------------------------------------------------------------------------
// Workspace members
// ---------------------------------------------------------------------------

const internalMemberSearch$ = state("");

export const memberSearch$ = computed((get) => {
  return get(internalMemberSearch$);
});

export const setMemberSearch$ = command(({ set }, value: string) => {
  set(internalMemberSearch$, value);
});

const internalInviteEmail$ = state("");

export const inviteEmail$ = computed((get) => {
  return get(internalInviteEmail$);
});

export const setInviteEmail$ = command(({ set }, value: string) => {
  set(internalInviteEmail$, value);
});

const internalInviteTouched$ = state(false);

export const inviteTouched$ = computed((get) => {
  return get(internalInviteTouched$);
});

export const setInviteTouched$ = command(({ set }, value: boolean) => {
  set(internalInviteTouched$, value);
});

// ---------------------------------------------------------------------------
// Workspace member invitation
// ---------------------------------------------------------------------------

const internalInviteDialogOpen$ = state(false);

export const inviteDialogOpen$ = computed((get) => {
  return get(internalInviteDialogOpen$);
});

const internalInviteRole$ = state<OrgRole>("member");

export const inviteRole$ = computed((get) => {
  return get(internalInviteRole$);
});

export const setInviteRole$ = command(({ set }, value: OrgRole) => {
  set(internalInviteRole$, value);
});

const internalInviteUsagePackUsd$ = state<MemberUsageSelection | null>(null);

export const inviteUsagePackUsd$ = computed((get) => {
  return get(internalInviteUsagePackUsd$);
});

export const setInviteUsagePackUsd$ = command(
  ({ set }, value: MemberUsageSelection) => {
    set(internalInviteUsagePackUsd$, value);
  },
);

export const setInviteDialogOpen$ = command(({ set }, open: boolean) => {
  if (open) {
    set(internalInviteEmail$, "");
    set(internalInviteTouched$, false);
    set(internalInviteRole$, "member");
    set(internalInviteUsagePackUsd$, null);
  }
  set(internalInviteDialogOpen$, open);
});

interface InvitePurchasePreview {
  readonly email: string;
  readonly role: OrgRole;
  readonly payment: OrgInvitationPurchasePreviewResponse;
}

const internalInvitePurchasePreview$ = state<InvitePurchasePreview | null>(
  null,
);

export const invitePurchasePreview$ = computed((get) => {
  return get(internalInvitePurchasePreview$);
});

export const closeInvitePurchasePreview$ = command(({ set }) => {
  set(internalInvitePurchasePreview$, null);
});

export const showMemberUsagePack$ = computed(async (get) => {
  const [isAdmin, capabilities] = await Promise.all([
    get(isOrgAdmin$),
    get(orgPlanCapabilities$),
  ]);
  return isAdmin && capabilities.showUsagePack;
});

export const memberUsagePackManagement$ = computed((get) => {
  return (async () => {
    if (!(await get(showMemberUsagePack$))) {
      return null;
    }
    return await get(usagePackManagementAsync$);
  })();
});

export const invitationUsagePackConfiguration$ = computed((get) => {
  if (!get(internalInviteDialogOpen$)) {
    return null;
  }
  return (async () => {
    if (!(await get(showMemberUsagePack$))) {
      return null;
    }
    const [options, management] = await Promise.all([
      get(memberUsagePackOptionsAsync$),
      get(usagePackManagementAsync$),
    ]);
    return { options, hasSubscription: management !== null };
  })();
});

// ---------------------------------------------------------------------------
// org-members-tab: SelfDemoteAction dialog
// ---------------------------------------------------------------------------

const internalSelfDemoteDialogOpen$ = state(false);

export const selfDemoteDialogOpen$ = computed((get) => {
  return get(internalSelfDemoteDialogOpen$);
});

export const setSelfDemoteDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalSelfDemoteDialogOpen$, open);
});

// ---------------------------------------------------------------------------
// org-members-tab: MemberActions remove dialog (keyed by email)
// ---------------------------------------------------------------------------

const internalRemoveMemberDialogTarget$ = state<string | null>(null);

export const removeMemberDialogTarget$ = computed((get) => {
  return get(internalRemoveMemberDialogTarget$);
});

export const setRemoveMemberDialogTarget$ = command(
  ({ set }, target: string | null) => {
    set(internalRemoveMemberDialogTarget$, target);
  },
);

// ---------------------------------------------------------------------------
// org-members-tab: PendingInvitationRow revoke dialog (keyed by id)
// ---------------------------------------------------------------------------

const internalRevokeInvitationDialogTarget$ = state<string | null>(null);

export const revokeInvitationDialogTarget$ = computed((get) => {
  return get(internalRevokeInvitationDialogTarget$);
});

export const setRevokeInvitationDialogTarget$ = command(
  ({ set }, target: string | null) => {
    set(internalRevokeInvitationDialogTarget$, target);
  },
);

// ---------------------------------------------------------------------------
// org-billing-tab: DowngradeConfirmDialog selectedTarget
// ---------------------------------------------------------------------------

type BillingDowngradeTargetTier = "limited-free-1" | "pro";

const internalSelectedTarget$ =
  state<BillingDowngradeTargetTier>("limited-free-1");
const internalLockedTarget$ = state<BillingDowngradeTargetTier | null>(null);

export const selectedTarget$ = computed((get) => {
  return get(internalSelectedTarget$);
});

export const lockedTarget$ = computed((get) => {
  return get(internalLockedTarget$);
});

export const setSelectedTarget$ = command(
  ({ set }, value: BillingDowngradeTargetTier) => {
    set(internalSelectedTarget$, value);
  },
);

export const setLockedTarget$ = command(
  ({ set }, value: BillingDowngradeTargetTier | null) => {
    set(internalLockedTarget$, value);
    if (value) {
      set(internalSelectedTarget$, value);
    }
  },
);

// ---------------------------------------------------------------------------
// org-general-tab: async commands
// ---------------------------------------------------------------------------

interface SaveOrgProfileInput {
  readonly name: string;
  readonly logoFile: File | null;
}

const uploadOrgLogo$ = command(
  async (
    { get },
    file: File,
    signal: AbortSignal,
  ): Promise<{ readonly logoUrl: string | null }> => {
    const formData = new FormData();
    formData.append("file", file);
    const client = get(apiClient$)(orgLogoContract);
    const result = await accept(
      client.post({
        body: formData,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const loadOrgLogo$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(orgLogoContract);
    const result = await accept(
      client.get({
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalProfileLogoUrl$, result.body.logoUrl);
  },
);

export const saveOrgProfile$ = command(
  async (
    { get, set },
    input: SaveOrgProfileInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const org = await get(org$);
    signal.throwIfAborted();
    if (!org) {
      throw new Error("Organization is required to update its profile");
    }

    const hasNameChange = input.name !== (org.name ?? "");

    if (input.logoFile) {
      const result = await set(uploadOrgLogo$, input.logoFile, signal);
      signal.throwIfAborted();
      set(internalProfileLogoUrl$, result.logoUrl);
    }

    if (hasNameChange) {
      const client = get(apiClient$)(orgContract);
      await accept(
        client.update({
          body: { name: input.name },
          fetchOptions: { signal },
        }),
        [200],
      );
    }

    signal.throwIfAborted();
    set(clearPendingLogo$);
    set(refreshOrg$);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk?.organization?.reload();
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.updated;
      }),
    );
  },
);

export const leaveOrg$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(orgLeaveContract);
    await accept(
      client.leave({
        body: {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk?.setActive({ organization: null });
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.left;
      }),
    );
    window.location.href = resolveAppAuthUrl(
      "/sign-in/tasks/choose-organization",
    );
  },
);

export const deleteOrg$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(orgDeleteContract);
    await accept(
      client.delete({
        body: { confirm: WORKSPACE_DELETE_CONFIRMATION },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk?.setActive({ organization: null });
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.deleted;
      }),
    );
    window.location.href = resolveAppAuthUrl(
      "/sign-in/tasks/choose-organization",
    );
  },
);

// ---------------------------------------------------------------------------
// org-members-tab: async commands
// ---------------------------------------------------------------------------

export const inviteMember$ = command(
  async (
    { get, set },
    email: string,
    role: OrgRole,
    usagePackUsd: MemberUsageSelection | null,
    signal: AbortSignal,
  ) => {
    const createClient = get(apiClient$);
    const client = createClient(orgInviteContract);
    if (usagePackUsd !== null && usagePackUsd !== 0) {
      const result = await accept(
        client.previewPurchase({
          body: {
            email,
            role,
            usagePackUsd,
            supportsInAppPreview: true,
            returnUrl: window.location.href,
          },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      if (result.body.checkoutUrl) {
        window.location.href = result.body.checkoutUrl;
        return;
      }
      set(internalInvitePurchasePreview$, {
        email,
        role,
        payment: result.body,
      });
      set(internalInviteDialogOpen$, false);
      return;
    }
    await accept(
      client.invite({
        body: { email, role },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(
        ($) => {
          return $.settings.workspace.toasts.invitationSent;
        },
        { email },
      ),
    );
    set(refreshOrgMembers$);
    set(internalInviteDialogOpen$, false);
  },
);

export const confirmInvitePurchase$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const preview = get(internalInvitePurchasePreview$);
    if (!preview) {
      throw new Error("Invitation purchase preview is not open");
    }
    const createClient = get(apiClient$);
    const client = createClient(orgInviteContract);
    const result = await accept(
      client.confirmPurchase({
        params: { purchaseId: preview.payment.purchaseId },
        body: preview.payment.paymentMethodPreviewToken
          ? {
              paymentMethodPreviewToken:
                preview.payment.paymentMethodPreviewToken,
            }
          : {},
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if ("status" in result.body && result.body.status === "pending_payment") {
      window.location.href = result.body.hostedInvoiceUrl;
      return;
    }
    if ("status" in result.body && result.body.status === "checkout_required") {
      window.location.href = result.body.checkoutUrl;
      return;
    }
    toast.success(
      i18n.t(
        ($) => {
          return $.settings.workspace.toasts.invitationSent;
        },
        { email: preview.email },
      ),
    );
    set(internalInvitePurchasePreview$, null);
    set(internalInviteEmail$, "");
    set(internalInviteRole$, "member");
    set(internalInviteUsagePackUsd$, null);
    set(refreshOrgMembers$);
    set(reloadUsagePackManagement$);
    set(reloadBillingStatus$);
  },
);

export const changeRole$ = command(
  async ({ get, set }, email: string, role: OrgRole, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(orgMembersContract);
    await accept(
      client.updateRole({
        body: { email, role },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(
        ($) => {
          return $.settings.workspace.toasts.roleUpdated;
        },
        { email },
      ),
    );
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk.session?.getToken({ skipCache: true });
    signal.throwIfAborted();
    set(refreshOrgMembers$);
    set(refreshOrg$);
  },
);

export const selfDemote$ = command(
  async ({ set }, email: string, signal: AbortSignal) => {
    await set(changeRole$, email, "member", signal);
    set(internalSelfDemoteDialogOpen$, false);
  },
);

export const removeMember$ = command(
  async ({ get, set }, email: string, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(orgMembersContract);
    await accept(
      client.removeMember({
        body: { email },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(
        ($) => {
          return $.settings.workspace.toasts.memberRemoved;
        },
        { email },
      ),
    );
    set(refreshOrgMembers$);
    set(reloadBillingStatus$);
    set(reloadUsagePackManagement$);
    set(internalRemoveMemberDialogTarget$, null);
  },
);

export const revokeInvitation$ = command(
  async ({ get, set }, invitationId: string, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(orgInviteContract);
    await accept(
      client.revoke({
        body: { invitationId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.invitationRevoked;
      }),
    );
    set(refreshOrgMembers$);
    set(internalRevokeInvitationDialogTarget$, null);
  },
);

export const acceptRequest$ = command(
  async ({ get, set }, requestId: string, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(orgMembershipRequestsContract);
    await accept(
      client.accept({
        body: { requestId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.membershipRequestAccepted;
      }),
    );
    set(refreshOrgMembers$);
  },
);

export const rejectRequest$ = command(
  async ({ get, set }, requestId: string, signal: AbortSignal) => {
    const createClient = get(apiClient$);
    const client = createClient(orgMembershipRequestsContract);
    await accept(
      client.reject({
        body: { requestId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    toast.success(
      i18n.t(($) => {
        return $.settings.workspace.toasts.membershipRequestRejected;
      }),
    );
    set(refreshOrgMembers$);
  },
);
