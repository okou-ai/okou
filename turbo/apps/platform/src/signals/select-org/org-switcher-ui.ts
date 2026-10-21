import { command, computed, state } from "ccstate";
import { userInvitations$ } from "../user-invitations.ts";
import { withCleanup } from "../utils.ts";
import {
  createWorkspace$,
  joinWorkspace$,
  type WorkspaceInvitation,
} from "./workspace-actions.ts";

// The menu can unmount while Clerk is still writing. Keep the actual operations
// in the Store so reopening either switcher observes the same work.
const creation$ = state<Promise<void> | null>(null);
export const workspaceCreation$ = computed((get) => {
  return get(creation$);
});
export const createSwitcherWorkspace$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const existing = get(creation$);
    if (existing) {
      return await existing;
    }
    const operation = set(createWorkspace$, signal);
    set(creation$, operation);
    await withCleanup(operation, () => {
      set(creation$, null);
    });
  },
);

const acceptances$ = state<ReadonlyMap<string, Promise<void>>>(new Map());

function invitationActions(invitation: WorkspaceInvitation) {
  return {
    invitation,
    acceptance$: computed((get) => {
      return get(acceptances$).get(invitation.id) ?? null;
    }),
    accept$: command(async ({ get, set }, signal: AbortSignal) => {
      // All invitation rows and both switcher surfaces share this operation
      // owner: an in-flight activation must not race another invitation.
      const current = get(acceptances$);
      const existing = current.get(invitation.id);
      if (existing) {
        return await existing;
      }
      if (current.size > 0) {
        return;
      }
      const operation = set(joinWorkspace$, invitation, signal);
      set(acceptances$, new Map([[invitation.id, operation]]));
      await withCleanup(operation, () => {
        set(acceptances$, new Map());
      });
    }),
  };
}

export type SwitcherInvitation = ReturnType<typeof invitationActions>;

export const switcherInvitations$ = computed(async (get) => {
  return (await get(userInvitations$)).map(invitationActions);
});

export const workspaceAcceptance$ = computed((get) => {
  return get(acceptances$).values().next().value ?? null;
});
