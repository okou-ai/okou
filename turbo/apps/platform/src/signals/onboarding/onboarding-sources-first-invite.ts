import { command } from "ccstate";
import { orgInviteContract } from "@okouai/api-contracts/client/org-member-routes";
import { inviteOrgMemberRequestSchema } from "@okouai/api-contracts/contracts/org-members";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  sourcesFirstDraft$,
  updateSourcesFirstDraft$,
  updateSourcesFirstUi$,
  type SourcesFirstInvite,
} from "./onboarding-sources-first-state.ts";

/** Replaces the entry for this address, or appends it the first time. */
const recordInvite$ = command(({ get, set }, invite: SourcesFirstInvite) => {
  const { invites } = get(sourcesFirstDraft$);
  const known = invites.some((current) => {
    return current.email === invite.email;
  });
  set(updateSourcesFirstDraft$, {
    invites: known
      ? invites.map((current) => {
          return current.email === invite.email ? invite : current;
        })
      : [...invites, invite],
  });
});

/**
 * Whether the address is one the invite route would accept, judged by the
 * route's own body schema so the step never forwards a refusal the browser
 * could have caught.
 */
export function sourcesFirstInviteEmailValid(email: string): boolean {
  return inviteOrgMemberRequestSchema.shape.email.safeParse(email).success;
}

/**
 * A well-formed address already accepted by the server is not sent again.
 */
export function sourcesFirstInviteSendable(
  invites: readonly SourcesFirstInvite[],
  email: string,
): boolean {
  if (!sourcesFirstInviteEmailValid(email)) {
    return false;
  }
  return invites.every((invite) => {
    return invite.email !== email || invite.status === "failed";
  });
}

/**
 * Sends one workspace invitation and keeps beside the address whatever the API
 * answered. A member without a usage pack is the whole request, which keeps
 * onboarding clear of the seat-purchase preview and confirm branch.
 *
 * The step is optional, so a refused address is shown where it was typed
 * rather than raised at the flow: nothing here can hold someone back.
 */
export const sendSourcesFirstInvite$ = command(
  async ({ get, set }, email: string, signal: AbortSignal): Promise<void> => {
    const address = email.trim();
    if (!sourcesFirstInviteSendable(get(sourcesFirstDraft$).invites, address)) {
      return;
    }
    const client = get(apiClient$)(orgInviteContract);
    // The route refuses an address it cannot invite — already a member,
    // already invited, no permission, inactive plan — and names the reason,
    // so those answers belong to the address. A session, server, or network
    // failure says nothing about it and keeps `accept`'s own handling.
    const response = await accept(
      client.invite({
        body: { email: address, role: "member" },
        fetchOptions: { signal },
      }),
      [200, 400, 403, 409, 503],
      signal,
    );
    signal.throwIfAborted();
    set(updateSourcesFirstUi$, { inviteEmail: "", inviteEmailLeft: false });
    set(
      recordInvite$,
      response.status === 200
        ? { email: address, status: "invited", failure: null }
        : {
            email: address,
            status: "failed",
            failure: response.body.error.message,
          },
    );
  },
);
