import { command } from "ccstate";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { onRejection, settle } from "../utils.ts";
import {
  sourcesFirstDraft$,
  updateSourcesFirstDraft$,
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

const dropInvite$ = command(({ get, set }, email: string) => {
  set(updateSourcesFirstDraft$, {
    invites: get(sourcesFirstDraft$).invites.filter((current) => {
      return current.email !== email;
    }),
  });
});

/** An address already in flight or already accepted is not sent again. */
export function sourcesFirstInviteSendable(
  invites: readonly SourcesFirstInvite[],
  email: string,
): boolean {
  if (email === "") {
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
    set(recordInvite$, { email: address, status: "pending", failure: null });
    const client = get(apiClient$)(orgInviteContract);
    // The route refuses an address it cannot invite — already a member,
    // already invited, no permission, inactive plan — and names the reason,
    // so those answers belong to the address. A session, server, or network
    // failure says nothing about it and keeps `accept`'s own handling.
    const invitation = accept(
      client.invite({
        body: { email: address, role: "member" },
        fetchOptions: { signal },
      }),
      [200, 400, 403, 409, 503],
      signal,
    );
    const answer = await onRejection(settle(invitation, signal), () => {
      // Only cancellation reaches here: leaving the step aborted the request
      // before its answer was read. Drop the entry rather than report an
      // outcome this browser never saw; typing the address again asks the API
      // for a fresh one.
      set(dropInvite$, address);
    });
    signal.throwIfAborted();
    if (!answer.ok) {
      // `accept` already reported the failure, and it belongs to the request
      // rather than to the address.
      set(dropInvite$, address);
      return;
    }
    const response = answer.value;
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
