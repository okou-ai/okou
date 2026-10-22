import { command, computed, state } from "ccstate";
import { clerk$, prepareCreatedOrgOnboarding$ } from "../auth.ts";
import { refreshCreatedOrganizationsCount$ } from "../org.ts";
import {
  refreshUserInvitations$,
  userInvitations$,
} from "../user-invitations.ts";
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

const joinWorkspace$ = command(
  async (
    { get, set },
    invitation: WorkspaceInvitation,
    signal: AbortSignal,
  ) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
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

const performCreateWorkspace$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const slug = `workspace-${crypto.randomUUID().slice(0, 8)}`;
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
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

const internalWorkspaceCreation$ = state<Promise<void> | undefined>(undefined);
// Retain the outcome separately from the operation that excludes re-entry.
const workspaceCreationInFlight$ = state<Promise<void> | undefined>(undefined);
const workspaceAcceptances$ = state<ReadonlyMap<string, Promise<void>>>(
  new Map(),
);

export const workspaceAcceptance$ = computed((get) => {
  return get(workspaceAcceptances$).values().next().value;
});

export const workspaceCreation$ = computed((get) => {
  return get(internalWorkspaceCreation$);
});

export const createWorkspace$ = command(({ get, set }, signal: AbortSignal) => {
  const existing = get(workspaceCreationInFlight$);
  if (existing) {
    return existing;
  }
  // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
  const request = withCleanup(set(performCreateWorkspace$, signal), () => {
    set(workspaceCreationInFlight$, undefined);
  });
  set(workspaceCreationInFlight$, request);
  set(internalWorkspaceCreation$, request);
  return request;
});

function createWorkspaceInvitationActions(invitation: WorkspaceInvitation) {
  const internalRequest$ = state<Promise<void> | undefined>(undefined);
  return {
    invitation,
    request$: computed((get) => {
      // Refreshed actions for the same invitation observe the accepted work.
      return (
        get(workspaceAcceptances$).get(invitation.id) ?? get(internalRequest$)
      );
    }),
    join$: command(({ get, set }, signal: AbortSignal) => {
      const current = get(workspaceAcceptances$);
      const existing = current.get(invitation.id);
      if (existing) {
        set(internalRequest$, existing);
        return existing;
      }
      if (current.size > 0) {
        return;
      }
      // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
      const request = withCleanup(
        set(joinWorkspace$, invitation, signal),
        () => {
          set(workspaceAcceptances$, new Map());
        },
      );
      // Claim synchronously, before the SDK operation can resume after await.
      set(workspaceAcceptances$, new Map([[invitation.id, request]]));
      set(internalRequest$, request);
      return request;
    }),
  };
}

export type WorkspaceInvitationActions = ReturnType<
  typeof createWorkspaceInvitationActions
>;

export const workspaceInvitations$ = computed(async (get) => {
  const invitations = await get(userInvitations$);
  return invitations.map(createWorkspaceInvitationActions);
});
