import { command } from "ccstate";
import { clerk$, prepareCreatedOrgOnboarding$ } from "../auth.ts";
import { refreshCreatedOrganizationsCount$ } from "../org.ts";
import { refreshUserInvitations$ } from "../user-invitations.ts";
import { withCleanup } from "../utils.ts";

export interface WorkspaceInvitation {
  readonly id: string;
  readonly publicOrganizationData: {
    readonly id?: string;
    readonly name: string;
    readonly imageUrl: string;
  };
  readonly accept: () => Promise<unknown>;
}

export const joinWorkspace$ = command(
  async (
    { get, set },
    invitation: WorkspaceInvitation,
    signal: AbortSignal,
  ) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await withCleanup(
      (async () => {
        await invitation.accept();
        signal.throwIfAborted();
        const orgId = invitation.publicOrganizationData.id;
        if (orgId) {
          await clerk.setActive({ organization: orgId });
        }
      })(),
      () => {
        // Reconcile possible SDK writes even if cancellation or activation
        // prevents completion. This never activates a cancelled invitation.
        set(refreshUserInvitations$);
      },
    );
  },
);

export const createWorkspace$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const slug = `workspace-${crypto.randomUUID().slice(0, 8)}`;
    await withCleanup(
      (async () => {
        const org = await clerk.createOrganization({ name: slug, slug });
        signal.throwIfAborted();
        set(prepareCreatedOrgOnboarding$, org.id);
        await clerk.setActive({ organization: org.id });
      })(),
      () => {
        // SDK writes may already be committed when cancellation or activation
        // fails. Intentional navigation must also reconcile the count.
        set(refreshCreatedOrganizationsCount$);
      },
    );
  },
);
