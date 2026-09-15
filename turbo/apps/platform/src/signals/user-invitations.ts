import { command, computed, state } from "ccstate";
import { clerkUser$ } from "./auth.ts";

const reloadInvitations$ = state(0);

/**
 * Pending organization invitations for the current user.
 * Re-fetches when `refreshUserInvitations$` is called or the poll loop ticks.
 */
export const userInvitations$ = computed(async (get) => {
  get(reloadInvitations$);
  const user = await get(clerkUser$);
  if (!user) {
    return [];
  }

  const result = await user.getOrganizationInvitations({ status: "pending" });
  return result.data;
});

/**
 * Trigger an immediate re-fetch of the user invitations signal.
 */
export const refreshUserInvitations$ = command(({ set }) => {
  set(reloadInvitations$, (x) => {
    return x + 1;
  });
});
